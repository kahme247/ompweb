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

/**
 * The floor between two `tool_execution_update` snapshots of one tool in one
 * session subscription. omp sends the accumulated tool output on every update,
 * so a bash run printing megabytes would otherwise forward the whole buffer
 * many times per second. Each frame is a self-contained snapshot of one
 * `toolCallId`, so holding the newest one per tool is lossless and concurrent
 * tools never supersede each other; a boundary frame (`tool_execution_end`,
 * `message_end`, …) always flushes them first, in emission order, so the final
 * output is never delayed. Message deltas are not throttled: they are
 * incremental since the delta protocol.
 */
export const TOOL_UPDATE_FRAME_MIN_INTERVAL_MS = 1_000;
const encoder = new TextEncoder();

export type SubscribeResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string };

const SUBSCRIBED: SubscribeResult = { ok: true };

class Subscription {
  active = true;
  detach: (() => void) | null = null;
  // Session backpressure queue, in emission order: message updates merge and
  // consecutive outbox snapshots replace each other, a tool snapshot is held
  // in place until its own window opens. One writer drains the whole queue, so
  // no frame ever overtakes an older one.
  pendingUpdates: QueuedFrame[] = [];
  /** When the last snapshot of each tool was written (absent = never written). */
  lastToolUpdateAt = new Map<string, number>();
  /** The one timer that releases held frames once their window elapsed. */
  drainTimer: NodeJS.Timeout | undefined = undefined;
  /** Deadline of `drainTimer`; a newer frame may pull it forward. */
  drainAt = 0;

  constructor(readonly id: string, readonly throttlesAgentUpdates: boolean) {}

  /** Drop held frames and their timer (unsubscribe, end, close). */
  clearUpdates(): void {
    this.pendingUpdates = [];
    this.lastToolUpdateAt.clear();
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.drainAt = 0;
  }
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
    subscription.clearUpdates();
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

  /** The peer drained: deliver queued frames now rather than waiting for the next event or heartbeat. */
  resume(): void {
    this.flushAll();
  }

  private flushAll(): boolean {
    for (const subscription of this.subscriptions.values()) {
      if (!this.drainAndReschedule(subscription, "ready")) return false;
    }
    return !this.closed;
  }

  /**
   * Write queued frames in emission order, never overtaking one emitted before.
   * `ready` stops at the first frame whose throttle window is closed and while
   * the peer is behind, leaving the rest queued; `release` ignores the window
   * (a delta must not wait for a held snapshot ahead of it) but not
   * backpressure; `force` ignores both, because the boundary frame that follows
   * must not be delayed. A tool snapshot is stamped with the time it is actually
   * written, not the time it was emitted: the deliberate hold must not read as
   * network latency.
   */
  private drain(subscription: Subscription, mode: DrainMode): boolean {
    // A stamp whose window elapsed is useless: a later snapshot is writable at once.
    for (const [toolCallId, at] of subscription.lastToolUpdateAt) {
      if (Date.now() - at >= TOOL_UPDATE_FRAME_MIN_INTERVAL_MS) subscription.lastToolUpdateAt.delete(toolCallId);
    }
    const queue = subscription.pendingUpdates;
    let written = 0;
    while (written < queue.length) {
      if (mode !== "force" && this.sink.backpressured()) break;
      const frame = queue[written];
      let at: number;
      if (frame.kind === "tool") {
        if (mode === "ready" && Date.now() < (subscription.lastToolUpdateAt.get(frame.toolCallId) ?? 0) + TOOL_UPDATE_FRAME_MIN_INTERVAL_MS) break;
        at = Date.now();
        subscription.lastToolUpdateAt.set(frame.toolCallId, at);
      } else {
        at = frame.at;
      }
      written += 1;
      if (!this.writeFrame(subscription, frame.data, at)) {
        queue.splice(0, written);
        return !this.closed;
      }
    }
    queue.splice(0, written);
    return !this.closed;
  }

  /** Drain what is ready, then arm the one timer for the next held frame. */
  private drainAndReschedule(subscription: Subscription, mode: DrainMode): boolean {
    if (!this.drain(subscription, mode)) return false;
    if (!subscription.active || this.closed) return !this.closed;
    const head = subscription.pendingUpdates[0];
    if (!head) {
      clearTimeout(subscription.drainTimer);
      subscription.drainTimer = undefined;
      subscription.drainAt = 0;
      return true;
    }
    // The sink's owner calls `resume()` once it has capacity again, and the
    // heartbeat retries: a timer here would only spin while the peer is behind.
    if (this.sink.backpressured()) return true;
    // Only a held tool snapshot can stop a drain short of an empty queue.
    if (head.kind !== "tool") return true;
    const windowEnds = (subscription.lastToolUpdateAt.get(head.toolCallId) ?? 0) + TOOL_UPDATE_FRAME_MIN_INTERVAL_MS;
    this.scheduleDrain(subscription, Math.max(windowEnds - Date.now(), 1));
    return true;
  }

  /**
   * Arm the timer that releases held frames. A newer frame only pulls the
   * deadline forward, never pushes it back.
   */
  private scheduleDrain(subscription: Subscription, delayMs: number): void {
    if (!subscription.active || this.closed) return;
    const deadline = Date.now() + delayMs;
    if (subscription.drainTimer !== undefined && subscription.drainAt <= deadline) return;
    clearTimeout(subscription.drainTimer);
    subscription.drainAt = deadline;
    subscription.drainTimer = setTimeout(() => {
      subscription.drainTimer = undefined;
      subscription.drainAt = 0;
      if (!subscription.active || this.closed) return;
      this.drainAndReschedule(subscription, "ready");
    }, delayMs);
    // A throttle window must not keep the process alive.
    subscription.drainTimer.unref?.();
  }

  private deliver(subscription: Subscription, data: unknown): void {
    if (!subscription.active || this.closed) return;
    // Other channels never queue: their frames are neither throttled nor merged.
    if (!subscription.throttlesAgentUpdates) {
      this.writeFrame(subscription, data);
      return;
    }
    if (isRecord(data)) {
      if (data.type === "tool_execution_update" && typeof data.toolCallId === "string" && data.toolCallId) {
        queueToolUpdate(subscription.pendingUpdates, data.toolCallId, data);
        this.drainAndReschedule(subscription, "ready");
        return;
      }
      if (data.type === "outbox_update" || data.type === "message_update") {
        // Nothing waits: the frame goes out at once. Behind a held snapshot it
        // releases that snapshot first, in order, instead of overtaking it.
        if (subscription.pendingUpdates.length === 0 && !this.sink.backpressured()) {
          this.writeFrame(subscription, data);
          return;
        }
        queueUpdate(subscription.pendingUpdates, data, Date.now());
        this.drainAndReschedule(subscription, "release");
        return;
      }
    }
    // Every other frame is a boundary (`tool_execution_end`, `message_end`, …):
    // everything emitted before it must reach the client first, in order.
    subscription.pendingUpdates.push({ kind: "frame", data, at: Date.now() });
    this.drainAndReschedule(subscription, "force");
  }
}

/** How much of a subscription's queue a drain may write. */
type DrainMode =
  /** Respect throttle windows and backpressure. */
  | "ready"
  /** Ignore throttle windows, still respect backpressure. */
  | "release"
  /** Ignore both: a boundary frame must not be delayed or overtaken. */
  | "force";

/**
 * One queued frame. `at` is the emit time, except for a tool snapshot, which is
 * stamped when it is written: holding it deliberately must not show up as
 * network latency in Connection diagnostics.
 */
type QueuedFrame =
  | { kind: "frame"; data: unknown; at: number }
  | { kind: "tool"; toolCallId: string; data: Record<string, unknown> };

/**
 * Hold the newest snapshot of one tool in the queue. Each frame carries the
 * tool's whole accumulated output, so a newer snapshot replaces the pending one
 * in place: the queue stays bounded to one slot per tool, snapshots of
 * concurrent tools never supersede each other, and a newer snapshot never
 * overtakes the frames emitted before it.
 */
function queueToolUpdate(queue: QueuedFrame[], toolCallId: string, data: Record<string, unknown>): void {
  for (const frame of queue) {
    if (frame.kind === "tool" && frame.toolCallId === toolCallId) {
      frame.data = data;
      return;
    }
  }
  queue.push({ kind: "tool", toolCallId, data });
}

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
function queueUpdate(queue: QueuedFrame[], data: Record<string, unknown>, at: number): void {
  // Only plain frames merge; a held tool snapshot keeps its place in the order.
  const last = queue.at(-1);
  const lastData = last?.kind === "frame" && isRecord(last.data) ? last.data : null;
  if (data.type === "outbox_update") {
    if (last?.kind === "frame" && lastData?.type === "outbox_update") {
      last.data = data;
      last.at = at;
    } else {
      queue.push({ kind: "frame", data, at });
    }
    return;
  }
  if (!isDeltaUpdate(data)) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const frame = queue[i];
      if (frame.kind !== "frame" || !isRecord(frame.data)) continue;
      if (frame.data.type === "outbox_update") break;
      if (frame.data.messageId === data.messageId) queue.splice(i, 1);
    }
    queue.push({ kind: "frame", data, at });
    return;
  }
  const merged = last && last.kind === "frame" && lastData && isDeltaUpdate(lastData) ? mergeDeltaUpdates(lastData, data) : null;
  if (last && last.kind === "frame" && merged) {
    last.data = merged;
    last.at = at;
  } else {
    queue.push({ kind: "frame", data, at });
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
