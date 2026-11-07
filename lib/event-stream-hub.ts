import { randomUUID } from "crypto";
import { filePathApiSegments } from "./file-paths";
import { hostsSnapshot, onHostsChange, onWorkspaceFile } from "./hosts/hub";
import { resolveWorkspaceHost } from "./api-utils";
import { isLinkUp } from "./hosts/host";
import { HostOpError } from "./hosts/link-protocol";
import type { WorkspaceFileEvent } from "./workspace-types";
import { attachNotificationClient } from "./notification-hub";
import { getExitedRpcSessions, getRpcSession, getRunningRpcSessions, subscribeHostToolCalls, subscribeRunningSessions, type AgentSessionWrapper } from "./rpc-manager";
import { onOutboxChange, outboxEntries, outboxSettledIds } from "./message-outbox";
import { subscribeSessionFileChanges } from "./session-watcher";
import {
  MUX_CONTROL_EVENT,
  UNKNOWN_CONNECTION_CODE,
  type BrowserTransportState,
  type EventStreamChannel,
  type MuxControlFrame,
} from "./event-stream-protocol";
import { browserTransportState } from "./web-settings";
import { isDeltaUpdate, mergeDeltaUpdates } from "./message-delta";
import { isRecord } from "./type-guards";

// Server half of the multiplexed live-event stream (see event-stream-protocol).
// One EventStreamConnection = one `/api/events` SSE response = one browser
// socket, carrying any number of channel subscriptions for every tab behind
// the browser's shared worker.

// Heartbeat keeps the socket alive through reverse proxies that drop silent connections.
const HEARTBEAT_MS = 30_000;
const encoder = new TextEncoder();

export type SubscribeResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string };

const SUBSCRIBED: SubscribeResult = { ok: true };

class Subscription {
  active = true;
  detach: (() => void) | null = null;
  // Session backpressure queue: message updates merge and consecutive outbox
  // snapshots replace each other. Other frames flush it first to preserve order.
  pendingUpdates: QueuedUpdate[] = [];

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
  var __ompServerId: string | undefined;
}

/** Random per process: a reconnecting client compares it to learn whether the server restarted. */
export function serverId(): string {
  return (globalThis.__ompServerId ??= randomUUID());
}

/** Tell every open connection the browser transport setting changed. */
export function broadcastBrowserTransport(state: BrowserTransportState): void {
  for (const connection of connections().values()) connection.control({ type: "transport", ...state });
}

/** Where a connection's frames go: an SSE response body or a WebSocket. */
export interface FrameSink {
  /** Send one frame; false means the peer is gone and the connection closes. */
  write(name: string, at: number, data: string): boolean;
  /** The peer is behind: replaceable updates coalesce until the owner calls `resume()`. */
  backpressured(): boolean;
  /** Keep-alive; false means the peer is gone. */
  heartbeat(): boolean;
  readonly heartbeatMs: number;
  close(): void;
}

class SseSink implements FrameSink {
  readonly heartbeatMs = HEARTBEAT_MS;
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(onPull: () => void, onCancel: () => void) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      // A slow consumer resumed reading: deliver coalesced updates now rather
      // than waiting for the next event or heartbeat.
      pull: onPull,
      // Half-open disconnects may never fire the abort signal.
      cancel: onCancel,
    });
  }

  write(name: string, at: number, data: string): boolean {
    return this.enqueue(`event: ${name}\nid: ${at}\ndata: ${data}\n\n`);
  }

  heartbeat(): boolean {
    return this.enqueue(":\n\n");
  }

  backpressured(): boolean {
    return (this.controller.desiredSize ?? 0) < 0;
  }

  close(): void {
    try { this.controller.close(); } catch { /* already closed */ }
  }

  private enqueue(text: string): boolean {
    try {
      this.controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      return false;
    }
  }
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
  /** The SSE response body; null when the caller supplied its own sink. */
  readonly stream: ReadableStream<Uint8Array> | null;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly sink: FrameSink;
  private closed = false;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly signal: AbortSignal | undefined;

  constructor(signal?: AbortSignal, sink?: FrameSink) {
    this.signal = signal;
    if (sink) {
      this.sink = sink;
      this.stream = null;
    } else {
      const sse = new SseSink(() => this.resume(), () => this.close());
      this.sink = sse;
      this.stream = sse.stream;
    }
    connections().set(this.id, this);
    this.control({ type: "hello", connectionId: this.id, serverId: serverId(), ...browserTransportState() });
    if (!this.closed) {
      this.heartbeat = setInterval(() => {
        if (this.flushAll() && !this.sink.heartbeat()) this.close();
      }, this.sink.heartbeatMs);
    }
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
    this.sink.close();
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
    subscription.pendingUpdates = [];
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

  private write(name: string, data: string, at = Date.now()): boolean {
    if (this.closed) return false;
    if (this.sink.write(name, at, data)) return true;
    this.close();
    return false;
  }

  control(frame: MuxControlFrame): void {
    this.write(MUX_CONTROL_EVENT, JSON.stringify(frame));
  }

  private writeFrame(subscription: Subscription, data: unknown, at?: number): boolean {
    let text: string;
    try {
      text = JSON.stringify(data);
    } catch {
      // An unserializable frame (e.g. a circular UI replay) ends only its own
      // subscription, never the shared socket other tabs depend on.
      this.end(subscription);
      return false;
    }
    return this.write(subscription.id, text, at);
  }

  private flush(subscription: Subscription, force = false): boolean {
    if (!force && this.sink.backpressured()) return true;
    const queued = subscription.pendingUpdates;
    subscription.pendingUpdates = [];
    for (let i = 0; i < queued.length; i++) {
      if (!force && this.sink.backpressured()) {
        subscription.pendingUpdates = queued.slice(i);
        return true;
      }
      const { data, at } = queued[i];
      if (!this.writeFrame(subscription, data, at)) return false;
    }
    return true;
  }

  /** The peer drained: deliver coalesced updates now rather than waiting for the next event or heartbeat. */
  resume(): void {
    this.flushAll();
  }

  private flushAll(): boolean {
    for (const subscription of this.subscriptions.values()) this.flush(subscription);
    return !this.closed;
  }

  private deliver(subscription: Subscription, data: unknown): void {
    if (!subscription.active || this.closed) return;
    if (
      subscription.coalescesMessageUpdates
      && isRecord(data)
      && (data.type === "outbox_update" || (data.type === "message_update" && this.sink.backpressured()))
    ) {
      queueUpdate(subscription.pendingUpdates, data, Date.now());
      if (data.type === "outbox_update") this.flush(subscription);
      return;
    }
    if (this.flush(subscription, true)) this.writeFrame(subscription, data);
  }
}

type QueuedUpdate = { data: Record<string, unknown>; at: number };

/**
 * Merge a `message_update` into a backpressure queue without losing anything:
 * a whole message replaces the queued updates of that message (it holds them
 * all), and a delta joins the last queued delta of the same block. Each entry
 * keeps the emit time and sequence of its latest frame (and `web.first`, its
 * first piece's), so the stamp keeps measuring server-to-peer delay and
 * sequences stay in order. Deltas interleaved across blocks do not merge:
 * joining a delta to an earlier entry would put it before frames it follows
 * and break the sequence fence the browser relies on.
 */
function queueUpdate(queue: QueuedUpdate[], data: Record<string, unknown>, at: number): void {
  if (data.type === "outbox_update") {
    const last = queue.at(-1);
    if (last?.data.type === "outbox_update") {
      last.data = data;
      last.at = at;
    } else {
      queue.push({ data, at });
    }
    return;
  }
  if (!isDeltaUpdate(data)) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].data.type === "outbox_update") break;
      if (queue[i].data.messageId === data.messageId) queue.splice(i, 1);
    }
    queue.push({ data, at });
    return;
  }
  const last = queue.at(-1);
  const merged = last && isDeltaUpdate(last.data) ? mergeDeltaUpdates(last.data, data) : null;
  if (last && merged) {
    last.data = merged;
    last.at = at;
  } else {
    queue.push({ data, at });
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
      return openFileChannel(channel.path, channel.sessionId, channel.hostId, handle);
    case "host-tools":
      return openHostToolsChannel(handle);
    case "hosts":
      return openHostsChannel(handle);
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

// Settings → Hosts: the linked-hosts list on subscribe and after every change.
function openHostsChannel(handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  // Snapshots are built one at a time so frames never arrive out of order.
  let chain: Promise<void> = Promise.resolve();
  const push = () => {
    chain = chain
      .then(() => {
        const snapshot = hostsSnapshot();
        if (handle.active) handle.send(snapshot);
      })
      .catch(() => {});
  };
  handle.setDetach(onHostsChange(push));
  push();
  return SUBSCRIBED;
}

// Agent events of one live omp wrapper, and the session's held messages (`outbox_update`, lib/message-outbox.ts).
function openSessionChannel(sessionId: string, handle: SubscriptionHandle): SubscribeResult {
  // Observer-only: opening a saved session must not create another omp
  // process for a terminal-owned session. Explicit commands use
  // POST /api/agent/[id], which starts the wrapper before this attaches.
  const existing = getRpcSession(sessionId);
  let session = existing?.isAlive() ? existing : undefined;
  // Held messages show before omp runs (a host offline): the channel attaches to the wrapper the dispatcher starts.
  if (!session && outboxEntries(sessionId).length === 0) {
    return { ok: false, status: 409, error: "Session is not managed by omp-web", code: "session_not_managed" };
  }

  handle.open();
  let detachSession = () => {};
  const attach = (live: AgentSessionWrapper) => {
    // onEvent can synchronously replay pending UI requests. Subscribe before
    // sampling the cursor/announcing readiness so catch-up has no event gap.
    detachSession = live.onEvent((event) => handle.send(event));
    handle.send({ type: "connected", sessionId, web: live.getStreamSnapshot().cursor });
  };
  if (session) attach(session);
  const rebind = () => {
    const existing = getRpcSession(sessionId);
    const live = existing?.isAlive() ? existing : undefined;
    if (live !== session) {
      detachSession();
      detachSession = () => {};
      session = live;
      if (live) attach(live);
    }
  };
  const detachRunning = subscribeRunningSessions(rebind);
  const detachOutbox = onOutboxChange(sessionId, (entries) => {
    rebind();
    handle.send({ type: "outbox_update", entries, settledIds: outboxSettledIds(sessionId) });
  });
  rebind();
  handle.setDetach(() => {
    detachOutbox();
    detachRunning();
    detachSession();
  });
  if (handle.active) handle.send({ type: "outbox_update", entries: outboxEntries(sessionId), settledIds: outboxSettledIds(sessionId) });
  return SUBSCRIBED;
}

// Change notifications for one file open in the viewer.
async function openFileChannel(rawPath: string, sessionId: string | null, hostId: string | undefined, handle: SubscriptionHandle): Promise<SubscribeResult> {
  const resolved = await resolveWorkspaceHost(hostId, sessionId);
  if ("response" in resolved) {
    const body = await resolved.response.json();
    return { ok: false, status: resolved.response.status, error: body.error, code: body.code };
  }
  const { host } = resolved;
  const id = randomUUID(), epoch = randomUUID();
  let opened = false;
  const pending: WorkspaceFileEvent[] = [];
  const detachEvent = onWorkspaceFile(host.id, id, epoch, (event) => {
    if (!handle.active) return;
    if (!opened) { pending.push(event); return; }
    handle.send(event);
    if (event.type === "error") handle.end();
  });
  const detachStatus = host.onStatus((status) => { if (!isLinkUp(status)) handle.end(); });
  handle.setDetach(() => {
    detachEvent(); detachStatus();
    void host.workspaceOps.unwatchFile(id, epoch).catch(() => {});
  });
  try {
    const result = await host.workspaceOps.watchFile(id, epoch, { segments: filePathApiSegments(rawPath), sessionId: resolved.sessionId, sessionFile: resolved.sessionFile });
    if (!result.ok) { detachEvent(); detachStatus(); return result; }
    if (!handle.active) { void host.workspaceOps.unwatchFile(id, epoch).catch(() => {}); return SUBSCRIBED; }
    const info = result.value;
    handle.open();
    // A new watch epoch always refreshes bytes missed during the disconnected interval.
    handle.send({ type: "change", mtime: new Date(info.mtimeMs).toISOString(), size: info.size });
    handle.send({ type: "connected", filePath: info.path });
    opened = true;
    for (const event of pending) { handle.send(event); if (event.type === "error") handle.end(); }
    return SUBSCRIBED;
  } catch (error) {
    detachEvent(); detachStatus();
    if (error instanceof HostOpError) return { ok: false, status: error.status, code: error.code, error: error.message };
    throw error;
  }
}
