import { randomUUID } from "crypto";
import fs from "fs";
import { authorizeFileAccess } from "./file-authorization";
import { filePathApiSegments } from "./file-paths";
import { attachNotificationClient } from "./notification-hub";
import { getExitedRpcSessions, getRpcSession, getRunningRpcSessions, subscribeHostToolCalls, subscribeRunningSessions } from "./rpc-manager";
import { subscribeSessionFileChanges } from "./session-watcher";
import {
  MUX_CONTROL_EVENT,
  UNKNOWN_CONNECTION_CODE,
  type EventStreamChannel,
  type MuxControlFrame,
} from "./event-stream-protocol";

// Server half of the multiplexed live-event stream (see event-stream-protocol).
// One EventStreamConnection = one `/api/events` SSE response = one browser
// socket, carrying any number of channel subscriptions for every tab behind
// the browser's shared worker.

// Heartbeat keeps the socket alive through proxies (Next.js idles ~120-150s).
// A native client may ask for a longer one per connection (`/api/events?heartbeat=`).
const HEARTBEAT_MS = 30_000;
export const MIN_HEARTBEAT_SECONDS = 15;
export const MAX_HEARTBEAT_SECONDS = 110;

/** `?heartbeat=<seconds>` in [15, 110]; anything else keeps the 30 s default. */
export function parseHeartbeatSeconds(value: string | null | undefined): number {
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value.trim())) return HEARTBEAT_MS / 1000;
  const seconds = Number(value.trim());
  if (seconds < MIN_HEARTBEAT_SECONDS || seconds > MAX_HEARTBEAT_SECONDS) return HEARTBEAT_MS / 1000;
  return seconds;
}

const encoder = new TextEncoder();

export type SubscribeResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string };

const SUBSCRIBED: SubscribeResult = { ok: true };

class Subscription {
  active = true;
  detach: (() => void) | null = null;
  // Backpressure slot (session channels): while the socket is behind,
  // replaceable `message_update` frames collapse to the latest one — omp sends
  // the FULL accumulated message each time, so latest-wins is safe. Every
  // other frame flushes this first so per-subscription order is preserved.
  pendingUpdate: unknown | null = null;

  constructor(readonly id: string, readonly coalescesMessageUpdates: boolean) {}
}

/** What a channel opener may do with its subscription. */
interface SubscriptionHandle {
  readonly active: boolean;
  /** Announce the subscription; must precede any `send`. */
  open(): void;
  send(data: unknown): void;
  /** Server-initiated end; the client re-subscribes like an EventSource reconnect. */
  end(): void;
  /** Register teardown. Runs immediately if the subscription already ended. */
  setDetach(detach: () => void): void;
}

declare global {
  var __ompEventStreamConnections: Map<string, EventStreamConnection> | undefined;
}

function connections(): Map<string, EventStreamConnection> {
  return (globalThis.__ompEventStreamConnections ??= new Map());
}

export function getEventStreamConnection(connectionId: string): EventStreamConnection | undefined {
  return connections().get(connectionId);
}

function runDetach(detach: (() => void) | null): void {
  if (!detach) return;
  try { detach(); } catch { /* a failing unsubscribe must not block teardown */ }
}

export class EventStreamConnection {
  readonly id = randomUUID();
  readonly stream: ReadableStream<Uint8Array>;
  private heartbeat: NodeJS.Timeout | undefined;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closed = false;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly signal: AbortSignal | undefined;

  constructor(signal?: AbortSignal, heartbeatMs: number = HEARTBEAT_MS) {
    this.signal = signal;
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        connections().set(this.id, this);
        this.control({ type: "hello", connectionId: this.id });
        this.heartbeat = setInterval(() => {
          if (this.flushAll()) this.write(":\n\n");
        }, heartbeatMs);
      },
      // A slow consumer resumed reading: deliver coalesced updates now rather
      // than waiting for the next event or heartbeat.
      pull: () => { this.flushAll(); },
      // Half-open disconnects may never fire the abort signal.
      cancel: () => this.close(),
    });
    signal?.addEventListener("abort", this.close);
    if (signal?.aborted) this.close();
  }

  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const subscription of this.subscriptions.values()) this.release(subscription);
    this.subscriptions.clear();
    connections().delete(this.id);
    this.signal?.removeEventListener("abort", this.close);
    try { this.controller?.close(); } catch { /* already closed */ }
  };

  get isClosed(): boolean {
    return this.closed;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  async subscribe(id: string, channel: EventStreamChannel): Promise<SubscribeResult> {
    if (this.closed) return { ok: false, status: 404, error: "Unknown event stream connection", code: UNKNOWN_CONNECTION_CODE };
    this.unsubscribe(id);
    const subscription = new Subscription(id, channel.kind === "session");
    this.subscriptions.set(id, subscription);
    const handle: SubscriptionHandle = {
      get active() { return subscription.active; },
      open: () => { this.control({ type: "open", sub: id }); },
      send: (data) => this.deliver(subscription, data),
      end: () => this.end(subscription),
      setDetach: (detach) => {
        if (subscription.active) subscription.detach = detach;
        else runDetach(detach);
      },
    };
    let result: SubscribeResult;
    try {
      result = await openChannel(channel, handle);
    } catch (error) {
      result = { ok: false, status: 500, error: String(error), code: "subscribe_failed" };
    }
    if (!result.ok && this.subscriptions.get(id) === subscription) {
      this.subscriptions.delete(id);
      this.release(subscription);
    }
    return result;
  }

  unsubscribe(id: string): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    this.release(subscription);
  }

  private release(subscription: Subscription): void {
    subscription.active = false;
    subscription.pendingUpdate = null;
    const detach = subscription.detach;
    subscription.detach = null;
    runDetach(detach);
  }

  private end(subscription: Subscription): void {
    if (!subscription.active) return;
    if (this.subscriptions.get(subscription.id) === subscription) this.subscriptions.delete(subscription.id);
    this.release(subscription);
    this.control({ type: "end", sub: subscription.id });
  }

  private write(text: string): boolean {
    if (this.closed || !this.controller) return false;
    try {
      this.controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  private control(frame: MuxControlFrame): void {
    this.write(`event: ${MUX_CONTROL_EVENT}\ndata: ${JSON.stringify(frame)}\n\n`);
  }

  private writeFrame(subscription: Subscription, data: unknown): boolean {
    let text: string;
    try {
      text = JSON.stringify(data);
    } catch {
      // An unserializable frame (e.g. a circular UI replay) ends only its own
      // subscription, never the shared socket other tabs depend on.
      this.end(subscription);
      return false;
    }
    return this.write(`event: ${subscription.id}\ndata: ${text}\n\n`);
  }

  private flush(subscription: Subscription): boolean {
    const data = subscription.pendingUpdate;
    subscription.pendingUpdate = null;
    return data === null || this.writeFrame(subscription, data);
  }

  private flushAll(): boolean {
    for (const subscription of this.subscriptions.values()) this.flush(subscription);
    return !this.closed;
  }

  private deliver(subscription: Subscription, data: unknown): void {
    if (!subscription.active || this.closed) return;
    const desiredSize = this.controller?.desiredSize ?? null;
    if (
      subscription.coalescesMessageUpdates
      && (data as { type?: unknown } | null)?.type === "message_update"
      && desiredSize !== null
      && desiredSize < 0
    ) {
      // Coalesce while backpressured; never buffer unboundedly.
      subscription.pendingUpdate = data;
      return;
    }
    if (this.flush(subscription)) this.writeFrame(subscription, data);
  }
}

async function openChannel(channel: EventStreamChannel, handle: SubscriptionHandle): Promise<SubscribeResult> {
  switch (channel.kind) {
    case "running":
      return openRunningChannel(handle);
    case "notifications":
      return openNotificationsChannel(channel.clientId, handle);
    case "session":
      return openSessionChannel(channel.sessionId, handle);
    case "file":
      return openFileChannel(channel.path, channel.sessionId, handle);
    case "host-tools":
      return openHostToolsChannel(handle);
  }
}

// Running-session ids plus session-list refresh hints for the sidebar.
function openRunningChannel(handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  // Subscribe BEFORE taking the initial snapshot so no state change can slip
  // through the gap between snapshot and subscription.
  const unsubscribeRunning = subscribeRunningSessions(({ ids, runningSessions, exitedSessions, refreshSessionList }) => {
    handle.send({
      type: "running",
      runningSessionIds: ids,
      runningSessions,
      exitedSessions,
      ...(refreshSessionList ? { refreshSessionList: true } : {}),
    });
  });
  const unsubscribeFiles = subscribeSessionFileChanges((sessionIds) => {
    handle.send({ type: "sessions-changed", sessionIds, refreshSessionList: true });
  });
  handle.setDetach(() => {
    unsubscribeRunning();
    unsubscribeFiles();
  });
  const initialRunning = getRunningRpcSessions();
  handle.send({
    type: "running",
    runningSessionIds: initialRunning.map((session) => session.id),
    runningSessions: initialRunning,
    exitedSessions: getExitedRpcSessions(),
  });
  return SUBSCRIBED;
}

// The notifications the server routes to one tab (`clientId`). The tab counts
// as reachable for toasts and in-page system notifications while this is open.
function openNotificationsChannel(clientId: string, handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  handle.setDetach(attachNotificationClient(clientId, (message) => handle.send({ type: "notification", ...message })));
  return SUBSCRIBED;
}

// Host tool calls from sessions no tab is watching: every tab holds one, so a
// session keeps its host tools while the user views another.
function openHostToolsChannel(handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  handle.setDetach(subscribeHostToolCalls((call) => handle.send({ type: "host_tool_call", ...call })));
  return SUBSCRIBED;
}

// Agent events of one live omp wrapper.
function openSessionChannel(sessionId: string, handle: SubscriptionHandle): SubscribeResult {
  // Observer-only: opening a saved session must not create another omp
  // process for a terminal-owned session. Explicit commands use
  // POST /api/agent/[id], which starts the wrapper before this attaches.
  const existing = getRpcSession(sessionId);
  const session = existing?.isAlive() ? existing : undefined;
  if (!session) return { ok: false, status: 409, error: "Session is not managed by omp-web", code: "session_not_managed" };

  handle.open();
  // onEvent can synchronously replay pending UI requests. Subscribe before
  // sampling the cursor/announcing readiness so catch-up has no event gap.
  handle.setDetach(session.onEvent((event) => handle.send(event)));
  handle.send({ type: "connected", sessionId, web: session.getStreamSnapshot().cursor });
  return SUBSCRIBED;
}

// Change notifications for one file open in the viewer.
async function openFileChannel(rawPath: string, sessionId: string | null, handle: SubscriptionHandle): Promise<SubscribeResult> {
  const access = await authorizeFileAccess(filePathApiSegments(rawPath), sessionId, true);
  if (!access.ok) return { ok: false, status: access.status, error: access.error, code: access.code };
  const { filePath } = access;
  if (!access.stat.isFile()) return { ok: false, status: 400, error: "Not a file", code: "not_a_file" };
  if (!handle.active) return SUBSCRIBED;

  handle.open();
  handle.send({ type: "connected", filePath });
  let lastMtimeMs = access.stat.mtimeMs;
  let lastSize = access.stat.size;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(filePath, () => {
      try {
        const stat = fs.statSync(filePath);
        // Some platforms emit watch events for file reads/attribute access.
        // Ignore those or the client's refresh read loops.
        if (stat.mtimeMs === lastMtimeMs && stat.size === lastSize) return;
        lastMtimeMs = stat.mtimeMs;
        lastSize = stat.size;
        handle.send({ type: "change", mtime: stat.mtime.toISOString(), size: stat.size });
      } catch {
        handle.send({ type: "change", mtime: new Date().toISOString(), size: 0 });
      }
    });
  } catch {
    handle.send({ type: "error", message: "Failed to watch file" });
    handle.end();
    return SUBSCRIBED;
  }
  watcher.on("error", () => handle.end());
  handle.setDetach(() => watcher.close());
  return SUBSCRIBED;
}
