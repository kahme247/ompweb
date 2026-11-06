// omp-web live-event multiplexer.
//
// Runs as a SharedWorker (one per browser profile) — or a dedicated Worker where SharedWorker is unavailable — and
// carries every tab's stream (lib/event-stream.ts) as a subscription on its one connection, so opening more tabs no
// longer consumes more of the browser's six HTTP/1.1 connections per host. The server's `browserTransport` setting
// (every hello and `transport` control frame carry it) picks the connection:
//   "sse": the ONLY `/api/events` EventSource; POST /api/events subscribes; tabs POST their commands. Also the fallback
//   when the proxy refuses the WebSocket upgrade.
//   "ws" (default): the browser link, one WebSocket at /api/events/link carrying every subscription and command with the host
//   link's delivery (docs/specs/2026-11-01-browser-link-design.md; lib/browser-link.ts is the server end).
//
// Bundled by server/client-env.ts (buildEventStreamWorker) into a classic script; lib/event-stream-worker.test.mjs runs
// it in node:vm with fake browser globals.
//
// It also owns the browser's message outbox (docs/specs/2026-11-04-message-outbox-design.md O2): IndexedDB
// `omp-web-outbox`, sent as `outbox_add` agent commands until the server has stored each (public/sw.js reads it too).
//
// Tab -> worker:  { op: "open", id, channel } | { op: "close", id }
//                 { op: "lock", name }  (tab holds this Web Lock while alive)
//                 { op: "bye" }         (pagehide: drop this tab's streams)
//                 { op: "wake", reason, visible, clientId }  (reason: init | visible | hidden | online | network)
//                 { op: "cmd", n, req, sessionId, advisor, body, type }  (an agent command; body: its JSON text, type: its type)
//                 { op: "metric", sample }  (a transport sample of the tab's: tagged, buffered and POSTed here)
//                 { op: "upload", id, host, name, type, blob }  (a file to upload over the link; blob: the File)
//                 { op: "up_pause", id }  (stop this tab's upload; keep the host's staged bytes for Retry)
//                 { op: "up_abort", id, host }  (the tab removed it: the host deletes what it staged; kept until delivered)
//                 { op: "diag", n }  (the connection diagnostics panel's poll)
//                 { op: "outbox_add", n, entry }  (a message for the outbox: a LocalOutboxEntry without state/error)
//                 { op: "outbox_drop", n, id }  (remove a "failed" entry; the tab waits for its committed deletion)
// Worker -> tab:  { id, type: "open" }
//                 { id, type: "message", data }   (raw JSON string)
//                 { id, type: "error", readyState: 0 | 2 }  (EventSource semantics)
//                 { transport: "sse" | "ws" }  (the mode in effect: on attach once known, and on every change)
//                 { cmd: n, http: true }  (SSE mode: the tab POSTs the command itself)
//                 { cmd: n, status, body, recvAt, repliedAt, attempts, deduped, behindBytes,
//                   socket, behindSameBytes, behindOtherBytes, replyBehindOtherBytes }
//                 { up: id, received, done, proof? } | { up: id, error: { status, code, message } }  (an upload's progress, failure)
//                 { up: id, http: true }  (SSE mode: the tab uploads it over HTTP itself)
//                 { diag: n, data }  (ConnectionDiagnostics, lib/event-stream.ts)
//                 { outboxAdded: n, error?: string }  (committed to IndexedDB, or refused with error: keep the draft)
//                 { outboxDropped: n, error?: string }  (deletion committed, or refused: keep the bubble and draft)
//                 { outbox: LocalOutboxEntry[], partial?: true }  (every entry, in submission order: on attach once loaded
//                   if any, back from the bfcache, and on every change; partial: the last shared read failed, so earlier
//                   entries of other workers may be missing and the tab must not keepalive from it)
//                 { outboxStored: OutboxEntry }  (the server stored one; the list without it follows)
import {
  BROWSER_LINK_PATH,
  BROWSER_LINK_VERSION,
  BROWSER_TRANSPORTS,
  COMMAND_DEDUPE_MS,
  EVENT_STREAM_PATH,
  MUX_CONTROL_EVENT,
  UNKNOWN_CONNECTION_CODE,
  isIdempotentCommand,
  type BrowserTransport,
  type ConnectionDiagnostics,
  type FallbackReason,
  type EventStreamChannel,
} from "./event-stream-protocol";
import type { LocalOutboxEntry } from "./event-stream";
import { LINK_LIMITS, LinkSender, Outbox, PartJoiner, queuedLine, SeqWindow, type Part } from "./hosts/link-protocol";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "./image-attachments";
import { diagnosticStats } from "./transport-stats";
import { UPLOAD_STALL_MS, UPLOAD_WINDOW_BYTES } from "./upload-limits";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
type ReadyState = typeof CONNECTING | typeof OPEN | typeof CLOSED;
// Mirrors EventSource's own reconnect delay after a server-ended stream.
const RESUBSCRIBE_DELAY_MS = 3000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const SILENCE_CHECK_MS = 1000;
const VISIBLE_PROBE_MS = 3000;
/** Redial after 5-6 s without command ack progress. Double up to offlineMs on each timeout so slow links can finish
 * a downlink piece blocking the ack; an acked command resets it, a wake or new link does not. */
const COMMAND_ACK_MS = 5000;
// Every tab forwards the same network or visibility event: a dial younger than
// this without a welcome is the one an earlier tab's wake just started.
const WAKE_REDIAL_GAP_MS = 1000;
/** The worker gives up a socket it will dial again: the server keeps the link for a resume. */
const FORCED_RECONNECT_CODE = 4000;
/** Done with the link (nothing left to carry, or a switch to SSE): the server drops it at once. */
const DONE_CODE = 1000;
const VERSION_MISMATCH_CODE = 4426;
/** The link hands lines to the socket only while it buffers less than this, as the host daemon does (spec D7). */
const SEND_BUFFER_BYTES = 2 * LINK_LIMITS.pieceBytes;
/** A command that cannot go out (no link) for this long answers transport_unavailable. */
const SEND_DEADLINE_MS = 15000;
/** After refused upgrades the worker uses SSE for this long, then tries the link again. */
const FALLBACK_MS = 300000;
/** Refused dials in a row (each GET reaching the server, no open between, the browser online) before that fallback. */
const FALLBACK_REFUSALS = 3;
/** The most up_aborts kept until delivered: past it the oldest goes (the host daemon's sweep of old staged files covers it). */
const ABORTS_MAX = 256;
/** An abort's DELETE that failed goes again after these (the last repeats), and at once on a wake. */
const ABORT_RETRY_MS = [5_000, 15_000, 60_000];
/** An abort's DELETE not answered in this long is abandoned and retried. */
const ABORT_DELETE_TIMEOUT_MS = 40_000;
/** Marks an up_abort's line in the sender (a command's `rid` is the tab's request id). */
const ABORT_RID = "abort:";
const TRANSPORT_UNAVAILABLE = { error: "Not sent: no connection to omp-web.", code: "transport_unavailable" };
const TRANSPORT_LOST = { error: "The connection to omp-web dropped before the answer arrived; the command may have run.", code: "transport_lost" };
// Transport samples (spec D6 of the experiment): POSTed in batches to the metrics route, whose GET is the SSE clock probe.
const METRICS_PATH = "/api/transport-metrics";
const METRICS_FLUSH_MS = 30000;
/** A metrics request (clock probe or sample POST) not answered in full by then is abandoned, so one hung request never
 * stops the probe chain or keeps `flushing` set. */
const METRICS_TIMEOUT_MS = 10000;
/** The slowest link a sample POST is given time for: 2 KB/s. The deadline is METRICS_TIMEOUT_MS plus the body over this. */
const METRICS_POST_BYTES_PER_MS = 2;
const METRICS_FLUSH_COUNT = 200;
const METRICS_BUFFER_MAX = 2000;
const EVENT_SAMPLE_MS = 1000;
const WAKE_WINDOW_MS = 60000;
const BATCH_WINDOW_MS = 2000;
const SSE_CLOCK_PROBES = 3;
// After those, one probe per this, the link's ping cadence order: every transport's clock is refreshed about as often.
const SSE_CLOCK_PROBE_MS = 10000;
// The clock is the lowest-RTT of the last CLOCK_WINDOW_SAMPLES samples no older than CLOCK_WINDOW_MS (the newest always
// stays), so a device clock step ages out.
const CLOCK_WINDOW_MS = 300000;
const CLOCK_WINDOW_SAMPLES = 20;
const LARGE_FRAME_BYTES = 64 * 1024;
const LARGE_FRAME_LOG_MS = 30000;
/** The diagnostics panel's stats cover this browser's samples of this long, at most DIAGNOSTICS_MAX of them. */
const DIAGNOSTICS_WINDOW_MS = 30 * 60_000;
const DIAGNOSTICS_MAX = 20_000;

/** A tab's end of the worker: a SharedWorker's MessagePort, or the dedicated worker's own scope. */
interface Port {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** The worker's global as this script uses it (tsconfig types `self` as a Window). */
interface WorkerScope extends Port {
  onconnect?: ((event: { ports: Port[] }) => void) | null;
  navigator: {
    locks?: { request(name: string, callback: () => unknown): Promise<unknown> };
    connection?: { effectiveType?: string };
    onLine?: boolean;
  };
  location: { href: string };
  /** Missing or refusing IndexedDB means an outbox add fails: the composer must keep the draft. */
  indexedDB?: IDBFactory;
}
const scope = self as unknown as WorkerScope;

type Timer = ReturnType<typeof setTimeout>;
type Sample = Record<string, unknown>;

interface Client {
  port: Port;
  streams: Map<number, Subscription>;
  visible: boolean;
}

interface Subscription {
  id: string;
  streamId: number;
  client: Client;
  channel: EventStreamChannel;
  state: ReadyState;
  retryTimer: Timer | undefined;
  /** The EventSource's: every frame's `id:` line is its emit time. */
  listener: (event: MessageEvent<string>) => void;
}

interface Command {
  n: number;
  client: Client;
  rid: string;
  body: string;
  type: string;
  session: string;
  advisor: boolean;
  /** In the link's sender (it goes out when the window has room). */
  queued: boolean;
  /** Its whole line went out (`seq` its last), at `sentAt`. */
  sent: boolean;
  seq: number;
  sentAt: number;
  attempts: number;
  deadline: Timer | undefined;
  behindBytes: number;
  behindSameBytes: number | null;
  behindOtherBytes: number | null;
}

interface LoggedFrame {
  owner: string;
  bytes: number;
  at: number;
  gotAt: number;
}

interface HeldEvent {
  channel: string;
  owner: string;
  at: number;
  gotAt: number;
  bytes: number;
  entry: LoggedFrame | null;
}

interface Reconnect {
  trigger: string;
  dropAt: number;
  startAt: number;
  effectiveTypeBefore: string | null;
  /** The connection said hello (SSE) or welcome (the link) again: the next open or stream frame ends the outage. */
  hello: boolean;
  /** The link's welcome: resumed, or a resync (null for SSE). */
  resumed: boolean | null;
}

/** Per-connection measurement state (spec D6): the EventSource's or the link's. */
interface Conn {
  key: "sse" | "link";
  lastEventSampleAt: number;
  heldEvent: HeldEvent | null;
  reconnect: Reconnect | null;
  /** First unanswered attempt or drop, until hello/welcome or the connection is no longer wanted. */
  connectingSince: number | null;
  largeFrames: LoggedFrame[];
}

interface Clock {
  offset: number;
  rtt: number;
  takenAt: number;
}

/** A line the link's sender queues (`rid` marks an agent command's), or an upload's chunk (a binary unit). */
type UpItem = { line: string; size: number; rid?: string } | { id: string; blob: Uint8Array };
type Sent = { seq: number; line: string; bytes: number; rid?: string };

/** A server line's header: everything but `data`, which `decode` hands on as the raw text it is. */
interface DownHead {
  type?: unknown;
  seq?: unknown;
  name?: unknown;
  at?: unknown;
  rid?: unknown;
  status?: unknown;
  recvAt?: unknown;
  deduped?: unknown;
  token?: unknown;
  serverId?: unknown;
  resumed?: unknown;
  ack?: unknown;
  c?: unknown;
  id?: unknown;
  received?: unknown;
  done?: unknown;
  proof?: unknown;
  start?: unknown;
  code?: unknown;
  message?: unknown;
}

interface ControlFrame {
  type?: unknown;
  sub?: unknown;
  connectionId?: unknown;
  transport?: unknown;
  status?: unknown;
  code?: unknown;
}

const encoder = new TextEncoder();

let source: EventSource | null = null;
let connectionId: string | null = null;
let reconnectTimer: Timer | undefined;
let reconnectDelayMs = RECONNECT_MIN_MS;
let nextSubscriptionId = 1;
/** Server subscription id -> subscription. */
const subscriptions = new Map<string, Subscription>();
/** The server's setting: SSE until a hello or `transport` control frame says otherwise. */
let setting: BrowserTransport = "sse";
/** The mode in effect: the setting, unless a refused upgrade put this worker on SSE for a while (fallbackTimer). */
let mode: BrowserTransport = "sse";
let fallbackTimer: Timer | undefined;
/** Why the last fallback put this worker on SSE (shown while it lasts). */
let fallbackReason: FallbackReason = "refused";
/** Every attached tab, told the mode when it changes. */
const clients = new Set<Client>();
const sseConn: Conn = { key: "sse", lastEventSampleAt: -Infinity, heldEvent: null, reconnect: null, connectingSince: null, largeFrames: [] };
const linkConn: Conn = { key: "link", lastEventSampleAt: -Infinity, heldEvent: null, reconnect: null, connectingSince: null, largeFrames: [] };
/** The browser link: its socket, the identity it resumes with, and both directions' delivery state. */
const link = {
  ws: null as WebSocket | null,
  /** The server's link id, kept across sockets; null before the first welcome or after the link was shut. */
  token: null as string | null,
  serverId: null as string | null,
  /** The current socket opened (a close before that is a refused upgrade). */
  opened: false,
  /** The current socket's welcome arrived: lines go out only after it. */
  welcomed: false,
  diagnosing: false,
  /** Dials in a row refused while plain HTTP to the same URL worked: FALLBACK_REFUSALS of them mean a proxy. */
  refusals: 0,
  sender: new LinkSender<UpItem>(true),
  outbox: new Outbox<Sent>(),
  upSeq: 0,
  /** Highest outbox seq written to the current socket. */
  sentSeq: 0,
  /** Bytes written to the current socket and not acked: the window (spec D7). */
  unacked: 0,
  /** Highest up seq the server acked. */
  ackedUp: 0,
  down: new SeqWindow(),
  parts: new PartJoiner(Infinity),
  /** Down bytes applied since the last ack sent. */
  appliedBytes: 0,
  ackTimer: undefined as Timer | undefined,
  flushTimer: undefined as Timer | undefined,
  /** Command pieces on this socket: last ack progress, highest seq, and adaptive deadline. */
  commandWaitSince: undefined as number | undefined,
  commandSeq: 0,
  commandAckMs: COMMAND_ACK_MS,
  lastFrameAt: 0,
  dialedAt: 0,
  reconnectDelayMs: RECONNECT_MIN_MS,
  reconnectTimer: undefined as Timer | undefined,
};
/** Agent commands not answered yet, by rid, in the order the tabs sent them. */
const pending = new Map<string, Command>();
/** Uploads in flight over the link, by id (docs/specs/2026-11-02-file-uploads-design.md U4). */
const uploads = new Map<string, Upload>();
let silenceTimer: ReturnType<typeof setInterval> | undefined;
/** Samples waiting for the next flush, oldest first, and how many overflow dropped since the last one. */
let samples: Sample[] = [];
let droppedSamples = 0;
let flushing = false;
let flushTimer: Timer | undefined;
/** One clock for every connection, event and action: `serverNow = clientNow + offset`, oldest first (see currentClock). */
const clockSamples: Clock[] = [];
/** From the tabs' wakes: this browser's id, and the effective connection type as of the latest one. */
let clientId: string | null = null;
let knownEffectiveType: string | null = null;
/** The latest online, network or visible wake (once per burst from every tab), and the effective type before it. */
let lastWake: { at: number; effectiveType: string | null } | null = null;
/** dropAt of the reconnects that a running one may still count in its `batch`. */
let recentDrops: number[] = [];
/** Every sample of the last DIAGNOSTICS_WINDOW_MS (stamped, as POSTed), with the worker's clock when recorded. */
let diagnosticSamples: { t: number; sample: Sample }[] = [];
let lastReconnect: ConnectionDiagnostics["lastReconnect"] = null;

function post(client: Client, message: unknown): void {
  try {
    client.port.postMessage(message);
  } catch {
    // The tab is gone; its lock/bye cleanup releases the subscriptions.
  }
}

function notifyError(subscription: Subscription, readyState: ReadyState): void {
  subscription.state = readyState;
  post(subscription.client, { id: subscription.streamId, type: "error", readyState });
}

/** A connection dropped: its live subscriptions are reconnecting. */
function markConnecting(list: Iterable<Subscription>): void {
  for (const subscription of list) {
    clearTimeout(subscription.retryTimer);
    if (subscription.state === OPEN) notifyError(subscription, CONNECTING);
  }
}

// ---- SSE ----

function closeSource(): void {
  source?.close();
  source = null;
  connectionId = null;
  // A frame held for the first clock must not be recorded later under whatever mode the worker is in by then.
  sseConn.heldEvent = null;
}

function scheduleReconnect(): void {
  closeSource();
  markConnecting(subscriptions.values());
  dropped(sseConn, "error");
  clearTimeout(reconnectTimer);
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    ensureSource();
  }, delay);
}

function ensureSource(): void {
  if (mode !== "sse" || source || reconnectTimer !== undefined || subscriptions.size === 0) return;
  const current = new EventSource(EVENT_STREAM_PATH);
  source = current;
  sseConn.connectingSince ??= Date.now();
  current.addEventListener(MUX_CONTROL_EVENT, (event: MessageEvent<string>) => {
    if (source !== current) return;
    let frame: ControlFrame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleControl(frame, sseConn);
  });
  for (const subscription of subscriptions.values()) current.addEventListener(subscription.id, subscription.listener);
  current.onerror = () => {
    if (source !== current) return;
    if (current.readyState === CLOSED) {
      // Fatal (e.g. 401 after the sign-in expired, 5xx): EventSource gives
      // up, so retry with capped backoff rather than going dark for good.
      scheduleReconnect();
      return;
    }
    // CONNECTING: EventSource reconnects on its own; the next hello
    // re-subscribes everything on the fresh connection.
    connectionId = null;
    markConnecting(subscriptions.values());
    dropped(sseConn, "error");
  };
}

function requestServer(body: Record<string, unknown>): Promise<Response> {
  return fetch(EVENT_STREAM_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, ...body }),
    keepalive: true,
  });
}

/** A control frame from the EventSource or the link (`conn`): the setting, a hello, or a subscription's open/end/refused. */
function handleControl(frame: ControlFrame, conn: Conn): void {
  if (frame.type === "transport" || frame.type === "hello") setTransport(frame.transport);
  if (frame.type === "transport") return;
  if (frame.type === "hello") {
    // The link's own hello (inside its first line) only carries the setting: its welcome did the rest.
    if (conn !== sseConn) return;
    reconnectDelayMs = RECONNECT_MIN_MS;
    // Switched to the link: the switch moved every subscription off this EventSource.
    if (mode !== "sse" || typeof frame.connectionId !== "string") return;
    connectionId = frame.connectionId;
    sseConn.connectingSince = null;
    if (sseConn.reconnect) {
      sseConn.reconnect.hello = true;
      // No stream, no frame to end its outage (and nothing was being delivered).
      if (subscriptions.size === 0) sseConn.reconnect = null;
    }
    for (const subscription of subscriptions.values()) subscribe(subscription);
    // The probe after the subscribe POSTs: on HTTP/1.1 it would otherwise hold one of the 6 connections first paint needs.
    void probeSseClock(connectionId);
    return;
  }
  // A subscription's frames count only from the connection the mode uses.
  if ((conn === sseConn) !== (mode === "sse")) return;
  if (frame.type === "open") endReconnect(conn, Date.now());
  const subscription = typeof frame.sub === "string" ? subscriptions.get(frame.sub) : undefined;
  if (!subscription) return;
  if (frame.type === "open") {
    subscription.state = OPEN;
    post(subscription.client, { id: subscription.streamId, type: "open" });
  } else if (frame.type === "end") {
    // A server-ended channel keeps EventSource's reconnect semantics.
    retrySubscription(subscription);
  } else if (frame.type === "refused") {
    if (transientFileRefusal(subscription, frame.status, frame.code)) return retrySubscription(subscription);
    // The link's answer to a failed `sub`: fatal, like a refused POST below.
    release(subscription);
    notifyError(subscription, CLOSED);
  }
}

/** The server's setting from a hello or `transport` frame; one it does not know (an older or newer server's) changes nothing. */
function setTransport(transport: unknown): void {
  const next = BROWSER_TRANSPORTS.find((value) => value === transport);
  if (next === undefined || next === setting) return;
  setting = next;
  applyMode();
}

/** Puts the mode in effect: SSE or the link, every subscription and command switching at once (spec B7). */
function applyMode(): void {
  const next: BrowserTransport = setting === "ws" && fallbackTimer === undefined ? "ws" : "sse";
  if (next === mode) return;
  mode = next;
  for (const client of clients) post(client, { transport: mode });
  markConnecting(subscriptions.values());
  if (mode === "ws") {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    closeSource();
    sseConn.reconnect = null;
    sseConn.connectingSince = null;
    for (const subscription of subscriptions.values()) subscribe(subscription);
    ensureLink();
    return;
  }
  // The link keeps only the commands it already sent, whose replies come on it: the streams leave it, and unsent
  // commands go back to their tabs, which POST them (their queued lines are dropped, so none also runs on the link).
  for (const subscription of subscriptions.values()) {
    link.sender.drop(subscription.id);
    if (link.token !== null) queueUp(subscription.id, JSON.stringify({ type: "unsub", id: subscription.id }));
  }
  // Uploads go back too: the tab resumes each over HTTP from the host's offset.
  for (const upload of [...uploads.values()]) {
    dropUpload(upload);
    post(upload.client, { up: upload.id, http: true });
  }
  // Aborts go back too: the link no longer carries them, so each is a DELETE the worker repeats until the server answers.
  for (const id of aborts.keys()) {
    link.sender.drop(`up:${id}`);
    sendAbort(id);
  }
  for (const command of [...pending.values()]) {
    if (command.sent) continue;
    link.sender.drop(`cmd:${command.session}`);
    settle(command, { cmd: command.n, http: true });
  }
  ensureSource();
  linkIdle();
}

function subscribe(subscription: Subscription): void {
  if (subscriptions.get(subscription.id) !== subscription) return;
  if (mode === "ws") {
    queueUp(subscription.id, JSON.stringify({ type: "sub", id: subscription.id, channel: subscription.channel }));
    return;
  }
  if (!connectionId) return;
  const requestedOn = connectionId;
  const stale = () => subscriptions.get(subscription.id) !== subscription || connectionId !== requestedOn;
  requestServer({ subscribe: { id: subscription.id, channel: subscription.channel } }).then(async (response) => {
    // Success is signalled by the `open` control frame, which is ordered with
    // the subscription's data on the stream; the POST response is not.
    if (response.ok || stale()) return;
    const body = await response.json().catch(() => null);
    if (stale()) return;
    if (body?.code === UNKNOWN_CONNECTION_CODE) {
      // The server restarted between hello and this POST.
      scheduleReconnect();
      return;
    }
    if (transientFileRefusal(subscription, response.status, body?.code)) return retrySubscription(subscription);
    // Other refusals are terminal; the tab decides whether to reopen them.
    release(subscription);
    notifyError(subscription, CLOSED);
  }, () => {
    if (!stale()) scheduleReconnect();
  });
}

function transientFileRefusal(subscription: Subscription, status: unknown, code: unknown): boolean {
  return subscription.channel.kind === "file"
    && ((status === 503 && code === "host_offline") || (status === 504 && code === "host_timeout"));
}

function retrySubscription(subscription: Subscription): void {
  notifyError(subscription, CONNECTING);
  clearTimeout(subscription.retryTimer);
  subscription.retryTimer = setTimeout(() => subscribe(subscription), RESUBSCRIBE_DELAY_MS);
}

function release(subscription: Subscription): void {
  clearTimeout(subscription.retryTimer);
  subscriptions.delete(subscription.id);
  subscription.client.streams.delete(subscription.streamId);
  source?.removeEventListener(subscription.id, subscription.listener);
  if (subscriptions.size === 0) {
    // Nothing left to deliver: free the browser's connection until a tab asks again.
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    closeSource();
    sseConn.reconnect = null;
    sseConn.connectingSince = null;
  }
  linkIdle();
}

function open(client: Client, streamId: number, channel: EventStreamChannel): void {
  close(client, streamId);
  const subscription: Subscription = {
    id: `s${nextSubscriptionId++}`,
    streamId,
    client,
    channel,
    state: CONNECTING,
    retryTimer: undefined,
    listener: (event) => deliver(subscription, sseConn, event.data, event.lastEventId ? Number(event.lastEventId) : NaN),
  };
  subscriptions.set(subscription.id, subscription);
  client.streams.set(streamId, subscription);
  if (mode === "ws") {
    subscribe(subscription);
    ensureLink();
    return;
  }
  // Listen before subscribing: frames may arrive before the POST resolves.
  source?.addEventListener(subscription.id, subscription.listener);
  ensureSource();
  subscribe(subscription);
}

function close(client: Client, streamId: number): void {
  const subscription = client.streams.get(streamId);
  if (!subscription) return;
  const wasConnected = connectionId;
  // Queued before the release, which may shut the link (and its queue) when this was its last use.
  if (mode === "ws") queueUp(subscription.id, JSON.stringify({ type: "unsub", id: subscription.id }));
  release(subscription);
  if (mode === "sse" && wasConnected && connectionId === wasConnected) requestServer({ unsubscribe: subscription.id }).catch(() => {});
}

function dropClient(client: Client): void {
  clients.delete(client);
  for (const streamId of [...client.streams.keys()]) close(client, streamId);
  // A closed tab's uploads cannot be sent with any prompt.
  for (const upload of [...uploads.values()]) if (upload.client === client) abortUpload(upload.id);
}

// ---- The browser link (spec B3-B5) ----

function linkWanted(): boolean {
  if (mode === "ws") return subscriptions.size > 0 || pending.size > 0 || uploads.size > 0 || aborts.size > 0 || link.sender.hasKeyWith("up:");
  // On SSE the link stays only until the commands sent on it are answered.
  for (const command of pending.values()) if (command.sent) return true;
  return false;
}

function ensureLink(): void {
  if (link.ws || link.reconnectTimer !== undefined || link.diagnosing || !linkWanted()) return;
  dial();
}

/** Nothing left for the link: it closes with DONE_CODE and the server drops it at once. */
function linkIdle(): void {
  if (!linkWanted() && (link.ws || link.reconnectTimer !== undefined || link.token !== null)) shutLink();
}

function shutLink(): void {
  const ws = link.ws;
  link.ws = null;
  ws?.close(DONE_CODE);
  clearTimeout(link.reconnectTimer);
  link.reconnectTimer = undefined;
  link.token = null;
  link.welcomed = false;
  resetLink();
  linkConn.reconnect = null;
  linkConn.connectingSince = null;
  linkConn.heldEvent = null;
  stopSilenceCheck();
}

/** A new link: both directions start over. */
function resetLink(): void {
  link.sender = new LinkSender(true);
  link.outbox = new Outbox();
  link.upSeq = 0;
  link.sentSeq = 0;
  link.unacked = 0;
  link.ackedUp = 0;
  link.down = new SeqWindow();
  link.parts = new PartJoiner(Infinity);
  link.appliedBytes = 0;
  link.commandWaitSince = undefined;
  link.commandSeq = 0;
  clearTimeout(link.ackTimer);
  link.ackTimer = undefined;
  clearTimeout(link.flushTimer);
  link.flushTimer = undefined;
  for (const command of pending.values()) command.queued = false;
}

function stopSilenceCheck(): void {
  clearInterval(silenceTimer);
  silenceTimer = undefined;
}

function dial(): void {
  const ws = new WebSocket(new URL(BROWSER_LINK_PATH, scope.location.href).href.replace(/^http/, "ws"));
  link.ws = ws;
  link.opened = false;
  link.welcomed = false;
  link.dialedAt = link.lastFrameAt = Date.now();
  linkConn.connectingSince ??= link.dialedAt;
  link.commandWaitSince = undefined;
  silenceTimer ??= setInterval(checkSilence, SILENCE_CHECK_MS);
  // Events of a socket the link gave up (late frames, its close) are ignored.
  ws.onopen = () => {
    if (link.ws !== ws) return;
    link.opened = true;
    // The upgrade works: whatever refused dials came before were the network, not a proxy.
    link.refusals = 0;
    sendControl({ type: "hello", v: BROWSER_LINK_VERSION, token: link.token, ack: link.down.acked });
    clockPing();
  };
  ws.onmessage = (event: MessageEvent<string>) => {
    if (link.ws === ws) onLine(event.data);
  };
  // `error` is always followed by `close`.
  ws.onclose = (event: CloseEvent) => {
    if (link.ws !== ws) return;
    if (event.code === VERSION_MISMATCH_CODE) return fallBack("version");
    if (!link.opened) return refused();
    redial(backoff(), "close");
  };
}

/** A failed socket's next delay: 1 s doubling to 30 s, reset by a welcome. */
function backoff(): number {
  const delay = link.reconnectDelayMs;
  link.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
  return delay;
}

/** Gives up the current socket (the server keeps the link for a resume); `trigger`: the reconnect sample's. */
function giveUp(trigger: string): boolean {
  const ws = link.ws;
  link.ws = null;
  link.welcomed = false;
  ws?.close(FORCED_RECONNECT_CODE);
  clearTimeout(link.flushTimer);
  link.flushTimer = undefined;
  // What is owed goes in the next hello.
  clearTimeout(link.ackTimer);
  link.ackTimer = undefined;
  link.appliedBytes = 0;
  // Chunks on the dropped socket may be lost: each upload goes on from the host's offset after the next welcome.
  for (const upload of uploads.values()) stopUpload(upload);
  if (!linkWanted()) {
    shutLink();
    return false;
  }
  dropped(linkConn, trigger);
  for (const command of pending.values()) if (!command.queued && command.deadline === undefined) waitToSend(command);
  return true;
}

/** Dials again after `delay` ms (0: now); the tabs see nothing unless the next welcome is a resync. */
function redial(delay: number, trigger: string): void {
  if (giveUp(trigger)) scheduleDial(delay);
}

function scheduleDial(delay: number): void {
  clearTimeout(link.reconnectTimer);
  link.reconnectTimer = undefined;
  if (delay === 0) {
    dial();
    return;
  }
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = undefined;
    dial();
  }, delay);
}

/**
 * The socket closed before it opened: ask the route with a plain GET why (the host daemon's diagnosis). Offline, signed
 * out, restarting, or a proxy whose upstream is down (502, 504): the link comes back once that passes. Any other answer
 * reached the server but not the upgrade (a proxy that drops Upgrade answers 426, a server without the route 404), but a
 * healthy server answers a plain GET 426 too, so one such answer cannot tell a proxy from a dial that failed as the
 * network came back. Only FALLBACK_REFUSALS of them in a row, with no open in between and none while the browser was
 * offline, put the worker on SSE for FALLBACK_MS.
 */
function refused(): void {
  if (!giveUp("close")) return;
  const offline = scope.navigator.onLine === false;
  link.diagnosing = true;
  // Without a deadline a GET that never answers leaves `diagnosing` set and nothing redials; an abort counts as status 0.
  withDeadline(METRICS_TIMEOUT_MS, (signal) => fetch(BROWSER_LINK_PATH, { cache: "no-store", signal })).then((response) => response.status, () => 0).then((status) => {
    link.diagnosing = false;
    if (offline || [0, 401, 502, 503, 504].includes(status) || ++link.refusals < FALLBACK_REFUSALS) scheduleDial(backoff());
    else fallBack("refused");
  });
}

function fallBack(reason: FallbackReason): void {
  fallbackReason = reason;
  link.refusals = 0;
  link.ws?.close(DONE_CODE);
  link.ws = null;
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(probeLink, FALLBACK_MS);
  applyMode();
  // applyMode handed the unsent commands back to their tabs. A sent idempotent one goes back too (the tab POSTs it,
  // running it again is harmless); any other has no link to carry its reply and may have run.
  for (const command of [...pending.values()]) {
    settle(command, isIdempotentCommand(command.type) ? { cmd: command.n, http: true } : failure(command, TRANSPORT_LOST));
  }
}

/** After FALLBACK_MS: dial in the background and leave SSE only once the upgrade works, so the tabs never see a failed try. */
function probeLink(): void {
  const probe = new WebSocket(new URL(BROWSER_LINK_PATH, scope.location.href).href.replace(/^http/, "ws"));
  let opened = false;
  probe.onopen = () => {
    opened = true;
    probe.close(DONE_CODE);
    fallbackTimer = undefined;
    applyMode();
  };
  // A probe that closed without opening stays on SSE another FALLBACK_MS.
  probe.onclose = () => {
    if (!opened) fallbackTimer = setTimeout(probeLink, FALLBACK_MS);
  };
}

function sendControl(message: Record<string, unknown>): void {
  link.ws?.send(JSON.stringify(message));
}

function clockPing(): void {
  sendControl({ type: "ping", c: Date.now() });
}

/** A sequenced line for the server, under `key` (a subscription, or `cmd:<session>`): sent fair and in turn. */
function queueUp(key: string, json: string, rid?: string): void {
  const line = queuedLine(json);
  link.sender.push(key, { line, size: encoder.encode(line).byteLength, rid });
  flushLink();
}

/**
 * Resend outbox lines past `sentSeq` (after a resumed welcome), then the sender's next units, while the socket buffers
 * under SEND_BUFFER_BYTES and the window has room; poll every flushMs while the buffer is full (the server's next ack
 * opens the window). The daemon's flush, one line per frame.
 */
function flushLink(): void {
  clearTimeout(link.flushTimer);
  link.flushTimer = undefined;
  const ws = link.ws;
  if (!ws || !link.welcomed) return;
  const room = () => ws.bufferedAmount < SEND_BUFFER_BYTES && link.unacked < LINK_LIMITS.unackedBytes;
  const now = Date.now();
  const write = (item: Sent) => {
    ws.send(item.line);
    link.sentSeq = item.seq;
    link.unacked += item.bytes;
    if (item.rid !== undefined) {
      link.commandSeq = item.seq;
      link.commandWaitSince ??= now;
    }
  };
  // An up_abort still queued keeps the link wanted: closing it first would lose the abort and leave the host's copy staged.
  const hadUp = link.sender.hasKeyWith("up:");
  let full = false;
  for (const item of link.outbox.pending()) {
    if (item.seq <= link.sentSeq) continue;
    if (!room()) {
      full = true;
      break;
    }
    write(item);
  }
  while (!full && room()) {
    const unit = link.sender.next(() => ++link.upSeq);
    if (!unit) break;
    // An upload's chunk: not sequenced, so outside the window; the socket's buffer and the upload's window bound it.
    if ("frame" in unit) {
      ws.send(unit.frame);
      continue;
    }
    const rid = "rid" in unit.item ? unit.item.rid : undefined;
    const item = { seq: unit.seq, line: unit.line, bytes: encoder.encode(unit.line).byteLength, rid };
    link.outbox.push(item);
    write(item);
    if (unit.done && rid?.startsWith(ABORT_RID)) {
      const abort = aborts.get(rid.slice(ABORT_RID.length));
      if (abort) abort.seq = unit.seq;
    }
    const command = unit.done && rid !== undefined ? pending.get(rid) : undefined;
    if (command) {
      command.sent = true;
      command.seq = unit.seq;
      // The first send's time: the server's dedupe forgets a command COMMAND_DEDUPE_MS after its first run.
      if (command.attempts++ === 0) command.sentAt = now;
    }
  }
  if (ws.bufferedAmount >= SEND_BUFFER_BYTES) link.flushTimer = setTimeout(flushLink, LINK_LIMITS.flushMs);
  if (hadUp && !link.sender.hasKeyWith("up:")) linkIdle();
}

/** `data` is the last field of a server line before its `seq`: the header parses without it, `data` stays raw text. */
function decode(text: string): { head: DownHead; data: string } {
  const start = text.indexOf(',"data":');
  if (start < 0) return { head: JSON.parse(text), data: "" };
  const end = text.lastIndexOf(',"seq":');
  return { head: JSON.parse(text.slice(0, start) + text.slice(end)), data: text.slice(start + 8, end) };
}

function onLine(text: string): void {
  const now = Date.now();
  link.lastFrameAt = now;
  if (text.startsWith('{"type":"part"')) {
    const part: Part = JSON.parse(text);
    if (link.down.applied(part.seq)) {
      // Joined, a line carries seq 0: its parts were deduped, it is not.
      const line = link.parts.add(part);
      if (line !== null) apply(decode(line), now);
    }
    owe(text.length);
    return;
  }
  const message = decode(text);
  const { head } = message;
  switch (head.type) {
    case "welcome":
      return onWelcome(head);
    case "ack":
      return onAck(Number(head.ack));
    case "ping":
      // The server's heartbeat, answered with a clock ping whose pong is a clock sample.
      return clockPing();
    case "pong":
      return clockSample(Number(head.c), Number(head.at), now);
  }
  if (typeof head.seq !== "number") return;
  if (link.down.applied(head.seq)) apply(message, now);
  owe(text.length);
}

function apply({ head, data }: { head: DownHead; data: string }, now: number): void {
  if (head.type === "e") {
    const at = Number(head.at);
    if (head.name === MUX_CONTROL_EVENT) {
      let frame: ControlFrame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      handleControl(frame, linkConn);
      return;
    }
    const subscription = typeof head.name === "string" ? subscriptions.get(head.name) : undefined;
    if (subscription && mode === "ws") deliver(subscription, linkConn, data, at);
  } else if (head.type === "reply") {
    const command = typeof head.rid === "string" ? pending.get(head.rid) : undefined;
    if (!command) return;
    const at = Number(head.at);
    const entry = logFrame(linkConn, command.session, data.length, at, now);
    const clock = currentClock(now);
    const behind = clock && Number.isFinite(at) ? behindFrames(linkConn.largeFrames, command.session, at, now, clock, entry).other : null;
    settle(command, reply(command, Number(head.status), JSON.parse(data), Number(head.recvAt), at, head.deduped === true, behind));
  } else if (head.type === "up_ack" || head.type === "up_error") {
    onUploadLine(head);
  }
}

/** Acks applied lines soon: within flushMs, at once past a piece, so the server's window moves (spec D7). */
function owe(bytes: number): void {
  link.appliedBytes += bytes;
  if (link.appliedBytes >= LINK_LIMITS.pieceBytes) sendAck();
  else link.ackTimer ??= setTimeout(sendAck, LINK_LIMITS.flushMs);
}

function sendAck(): void {
  clearTimeout(link.ackTimer);
  link.ackTimer = undefined;
  link.appliedBytes = 0;
  sendControl({ type: "ack", ack: link.down.acked });
}

function onAck(ack: number): void {
  if (!Number.isSafeInteger(ack)) return;
  if (link.commandWaitSince !== undefined && ack > link.ackedUp) {
    // Progress proves the way up works: all commands acked ends the wait, a partial ack restarts it.
    if (ack >= link.commandSeq) {
      link.commandWaitSince = undefined;
      link.commandAckMs = COMMAND_ACK_MS;
    } else link.commandWaitSince = Date.now();
  }
  link.ackedUp = Math.max(link.ackedUp, ack);
  for (const item of link.outbox.ack(ack)) if (item.seq <= link.sentSeq) link.unacked -= item.bytes;
  settleAborts(ack);
  flushLink();
  linkIdle();
}

/**
 * Resumed: the server kept the link; both sides resend what the other has not applied, and the tabs see nothing. Not
 * resumed (the link expired, overflowed, or the server restarted): a resync. Both directions start over, every stream
 * subscribes again (CONNECTING, then the channel's fresh snapshot), and sent commands go again only where they cannot
 * run twice: idempotent ones, or ones the same server's (session, rid) dedupe still remembers (spec B5).
 */
function onWelcome(welcome: DownHead): void {
  const now = Date.now();
  link.reconnectDelayMs = RECONNECT_MIN_MS;
  const resumed = welcome.resumed === true && welcome.token === link.token;
  const ack = Number(welcome.ack);
  const sameServer = link.serverId === null || link.serverId === welcome.serverId;
  if (resumed) {
    link.ackedUp = Math.max(link.ackedUp, ack);
    link.outbox.ack(ack);
    settleAborts(ack);
  } else {
    resetLink();
  }
  link.sentSeq = resumed ? ack : 0;
  link.unacked = 0;
  link.token = typeof welcome.token === "string" ? welcome.token : null;
  link.serverId = typeof welcome.serverId === "string" ? welcome.serverId : null;
  link.welcomed = true;
  linkConn.connectingSince = null;
  if (!resumed && mode === "ws") {
    markConnecting(subscriptions.values());
    for (const subscription of subscriptions.values()) subscribe(subscription);
    // The resync dropped what the sender held and what the server never acked: every pending abort goes again.
    for (const id of aborts.keys()) sendAbort(id);
  }
  for (const command of [...pending.values()]) {
    clearTimeout(command.deadline);
    command.deadline = undefined;
    if (command.queued) continue;
    if (!command.sent) sendCommand(command);
    else if (isIdempotentCommand(command.type) || (sameServer && now - command.sentAt < COMMAND_DEDUPE_MS)) sendCommand(command);
    else settle(command, failure(command, TRANSPORT_LOST));
  }
  // Every upload starts again (or for the first time): its up_start's answer says where its chunks go from.
  for (const upload of uploads.values()) openUpload(upload);
  const reconnect = linkConn.reconnect;
  if (reconnect) {
    reconnect.hello = true;
    reconnect.resumed = resumed;
    // Resumed, the link itself is the stream: its outage ends here. A resync ends at the first open or frame after it.
    if (resumed) endReconnect(linkConn, now);
    else if (subscriptions.size === 0 || mode !== "ws") linkConn.reconnect = null;
  }
  flushLink();
}

function checkSilence(): void {
  if (!link.ws) return;
  const now = Date.now();
  if (now - link.lastFrameAt >= LINK_LIMITS.offlineMs) redial(backoff(), "silence");
  else if (link.commandWaitSince !== undefined && now - link.commandWaitSince >= link.commandAckMs) {
    // Frames still arriving prove only the way down: a command that is not acked means the way up is gone.
    link.commandAckMs = Math.min(link.commandAckMs * 2, LINK_LIMITS.offlineMs);
    redial(0, "command");
  }
}

/**
 * A tab saw the network change or the page come back (on SSE nothing to do: EventSource reconnects on its own).
 * Every wake but `hidden` and `init` may start a reconnect sample's outage (spec D6 `startAt`).
 */
function wake(reason: string): void {
  if (reason === "online" || reason === "network" || reason === "visible") {
    retryAborts();
    retryOutbox();
  }
  const now = Date.now();
  const type = effectiveType();
  // Every tab forwards the same event: the first of a burst keeps the type from before it.
  if (reason !== "hidden" && reason !== "init" && !(lastWake && now - lastWake.at < WAKE_REDIAL_GAP_MS)) {
    lastWake = { at: now, effectiveType: knownEffectiveType ?? type };
  }
  knownEffectiveType = type;
  // The network is back or changed: the outage's long delay and its refusals no longer apply, and the first dial may
  // still fail while the route settles, so the next one goes after the shortest delay.
  if (reason === "online" || reason === "network") {
    link.reconnectDelayMs = RECONNECT_MIN_MS;
    link.refusals = 0;
  }
  const justDialed = link.ws !== null && !link.welcomed && now - link.dialedAt < WAKE_REDIAL_GAP_MS;
  if (justDialed || (link.ws === null && link.reconnectTimer === undefined)) return;
  if (reason === "online" || reason === "network" || (reason === "visible" && link.reconnectTimer !== undefined)) {
    redial(0, reason);
  } else if (reason === "visible" && link.welcomed) {
    // The server answers a clock ping at once: no frame within VISIBLE_PROBE_MS means the socket died while hidden.
    const ws = link.ws;
    clockPing();
    setTimeout(() => {
      if (link.ws === ws && link.lastFrameAt < now) redial(0, "visible");
    }, VISIBLE_PROBE_MS);
  }
}

// ---- Agent commands (spec B5 "Commands"): each rides the link under its session's key, by the tab's request id. ----

function queueCommand(client: Client, message: Record<string, unknown>): void {
  const n = Number(message.n);
  if (mode !== "ws") {
    post(client, { cmd: n, http: true });
    return;
  }
  const body = String(message.body);
  const command: Command = {
    n,
    client,
    rid: String(message.req),
    body,
    // From the tab, which built the body: the worker never parses it.
    type: typeof message.type === "string" ? message.type : "",
    session: String(message.sessionId),
    advisor: message.advisor === true,
    queued: false,
    sent: false,
    seq: 0,
    sentAt: 0,
    attempts: 0,
    deadline: undefined,
    behindBytes: 0,
    behindSameBytes: null,
    behindOtherBytes: null,
  };
  // UTF-8 bytes, as the route counts them; a body under a third of the limit cannot reach it.
  if (body.length * 3 > MAX_AGENT_COMMAND_REQUEST_BYTES && encoder.encode(body).byteLength > MAX_AGENT_COMMAND_REQUEST_BYTES) {
    post(client, reply(command, 413, { error: "Agent command is too large", code: "request_too_large" }));
    return;
  }
  // Spec D6 "Uplink": what the link holds ahead of it, and how much of that is this or other sessions' commands.
  command.behindBytes = link.sender.queuedBytes + link.unacked;
  let same = 0;
  let other = 0;
  for (const earlier of pending.values()) {
    if (earlier.sent && earlier.seq <= link.ackedUp) continue;
    if (earlier.session === command.session) same += earlier.body.length;
    else other += earlier.body.length;
  }
  command.behindSameBytes = Math.min(same, command.behindBytes);
  command.behindOtherBytes = Math.min(other, command.behindBytes);
  pending.set(command.rid, command);
  if (link.welcomed) sendCommand(command);
  else waitToSend(command);
  ensureLink();
}

/** Into the sender (a resend keeps its rid): the server's (session, rid) dedupe answers a repeat. */
function sendCommand(command: Command): void {
  command.queued = true;
  queueUp(
    `cmd:${command.session}`,
    `{"type":"cmd","rid":${JSON.stringify(command.rid)},"session":${JSON.stringify(command.session)},"advisor":${command.advisor},"command":${command.body}}`,
    command.rid,
  );
}

/** No link to send on: unavailable if none comes within SEND_DEADLINE_MS (the command never left the browser). */
function waitToSend(command: Command): void {
  command.deadline = setTimeout(() => settle(command, failure(command, TRANSPORT_UNAVAILABLE)), SEND_DEADLINE_MS);
}

function reply(command: Command, status: number, body: unknown, recvAt: number | null = null, repliedAt: number | null = null, deduped = false, replyBehindOtherBytes: number | null = null) {
  return {
    cmd: command.n,
    status,
    body,
    recvAt,
    repliedAt,
    attempts: command.attempts,
    deduped,
    behindBytes: command.behindBytes,
    socket: "link",
    behindSameBytes: command.behindSameBytes,
    behindOtherBytes: command.behindOtherBytes,
    replyBehindOtherBytes,
  };
}

function failure(command: Command, body: unknown) {
  return reply(command, 503, body);
}

function settle(command: Command, message: unknown): void {
  clearTimeout(command.deadline);
  pending.delete(command.rid);
  post(command.client, message);
  linkIdle();
}

// ---- Uploads (docs/specs/2026-11-02-file-uploads-design.md U4): an upload's up_start, chunks and up_abort ride the
// link under `up:<id>`, taking turns with the other keys. The worker reads the File itself, a window at a time. ----

interface Upload {
  id: string;
  client: Client;
  blob: Blob;
  host: string;
  name: string;
  type: string;
  /** Its latest up_start on the current socket was answered: chunks go out from `sent`. */
  started: boolean;
  /** `n` of its latest up_start (unique in the worker): only the answer naming it (`start: n`) counts. */
  opens: number;
  /** Bytes the host has written (its last ack), and bytes read and handed to the sender. */
  acked: number;
  sent: number;
  /** A read is in flight; one that finds `epoch` changed belongs to an earlier start and is dropped. */
  reading: boolean;
  epoch: number;
  /** Fails it when no answer or ack moves it on for UPLOAD_STALL_MS. */
  stallTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Worker-wide, so a Retry under a reused id never repeats an `n` that a stalled attempt's late answer carries. */
let upStartSeq = 0;

function addUpload(client: Client, message: Record<string, unknown>): void {
  const id = String(message.id);
  // A Retry under this id supersedes a cancel still pending for it (in any mode: on SSE the tab uploads over HTTP): it
  // must not be resent or deleted again over the new upload. A line already on the wire is ordered before the up_start.
  aborts.delete(id);
  if (mode !== "ws") return post(client, { up: id, http: true });
  const upload: Upload = {
    id,
    client,
    blob: message.blob as Blob,
    host: String(message.host),
    name: String(message.name),
    type: typeof message.type === "string" ? message.type : "",
    started: false,
    opens: 0,
    acked: 0,
    sent: 0,
    reading: false,
    epoch: 0,
    stallTimer: undefined,
  };
  // A retry reuses the id: the earlier attempt's stall timer must not fire on this one.
  const earlier = uploads.get(id);
  if (earlier) dropUpload(earlier);
  uploads.set(id, upload);
  watchUpload(upload);
  if (link.welcomed) openUpload(upload);
  ensureLink();
}

/** Stops sending: its queued chunks are dropped, and a read in flight is discarded. */
function stopUpload(upload: Upload): void {
  upload.started = false;
  upload.epoch += 1;
  link.sender.drop(`up:${upload.id}`);
}

/** up_start: opens the upload, or resumes it at the host's offset. The file's MIME type goes as `mime` (`type` is the
 * message's). */
function openUpload(upload: Upload): void {
  stopUpload(upload);
  const { id, host, name, type } = upload;
  upload.opens = ++upStartSeq;
  queueUp(`up:${id}`, JSON.stringify({ type: "up_start", id, n: upload.opens, host, name, size: upload.blob.size, mime: type }));
}

function dropUpload(upload: Upload): void {
  stopUpload(upload);
  clearTimeout(upload.stallTimer);
  uploads.delete(upload.id);
}

/** (Re)arms its stall deadline: whatever keeps it from moving (a link that stays down, a host that stopped acking)
 * fails it there. Nothing is aborted, so the tab's automatic resume (`uploadFile`) continues it from the host's offset. */
function watchUpload(upload: Upload): void {
  clearTimeout(upload.stallTimer);
  upload.stallTimer = setTimeout(() => {
    if (uploads.get(upload.id) !== upload) return;
    dropUpload(upload);
    post(upload.client, { up: upload.id, error: { status: 504, code: "upload_stalled", message: "The upload stopped making progress" } });
    linkIdle();
  }, UPLOAD_STALL_MS);
}

/** An abort not yet delivered: its up_abort line on the link (`seq`: where the sender numbered it, until the server acks it),
 * or, off the link, its DELETE (`http`). */
interface Abort {
  host: string | undefined;
  seq?: number;
  http: boolean;
  fetching: boolean;
}

/** By upload id: kept until the server has it, so a link that drops or a request that fails never leaves the host's copy staged. */
const aborts = new Map<string, Abort>();
let abortFailures = 0;
let abortTimer: Timer | undefined;

/** The tab removed it (or went away): the server deletes what the host staged. */
function abortUpload(id: string, host?: string): void {
  const upload = uploads.get(id);
  if (upload) dropUpload(upload);
  if (!aborts.has(id)) {
    if (aborts.size >= ABORTS_MAX) aborts.delete(aborts.keys().next().value as string);
    aborts.set(id, { host: host ?? upload?.host, http: false, fetching: false });
    sendAbort(id);
  }
  linkIdle();
}

/** On the link in `ws` mode (queued once the link has a token; until then it dials and the welcome sends it), else a DELETE. */
function sendAbort(id: string): void {
  const abort = aborts.get(id);
  if (!abort) return;
  abort.seq = undefined;
  abort.http = mode !== "ws";
  if (abort.http) return deleteUpload(id, abort);
  if (link.token !== null) queueUp(`up:${id}`, JSON.stringify({ type: "up_abort", id, host: abort.host }), `${ABORT_RID}${id}`);
  else ensureLink();
}

/** The server applied the up lines through `ack`: those aborts are delivered. */
function settleAborts(ack: number): void {
  for (const [id, abort] of aborts) if (!abort.http && abort.seq !== undefined && abort.seq <= ack) aborts.delete(id);
}

/** A 2xx or 4xx answer settles it (the server owns delivery from there), except 408 and 429; a network error, a timeout or a 5xx keeps it for a retry. */
function deleteUpload(id: string, abort: Abort): void {
  if (abort.fetching) return;
  abort.fetching = true;
  const query = abort.host === undefined ? "" : `?host=${encodeURIComponent(abort.host)}`;
  // The deadline is above the server's 30 s host-op timeout: a request that hangs (half-open socket) would otherwise
  // keep `fetching` set and block every retry. A timeout counts as not settled.
  withDeadline(ABORT_DELETE_TIMEOUT_MS, (signal) => fetch(`/api/uploads/${encodeURIComponent(id)}${query}`, { method: "DELETE", signal })).then((response) => response.status < 500 && response.status !== 408 && response.status !== 429, () => false).then((settled) => {
    abort.fetching = false;
    if (aborts.get(id) !== abort) return;
    if (settled) {
      aborts.delete(id);
      abortFailures = 0;
    } else if (abort.http && abortTimer === undefined) {
      abortTimer = setTimeout(retryAborts, ABORT_RETRY_MS[Math.min(abortFailures++, ABORT_RETRY_MS.length - 1)]);
    }
  });
}

function retryAborts(): void {
  clearTimeout(abortTimer);
  abortTimer = undefined;
  for (const [id, abort] of aborts) if (abort.http) deleteUpload(id, abort);
}

/**
 * Reads the next chunk while the upload's window has room: at most UPLOAD_WINDOW_BYTES beyond the host's last ack, in
 * whole pieces but the file's last. The sender cuts it into pieces.
 */
function pump(upload: Upload): void {
  if (!upload.started || upload.reading || uploads.get(upload.id) !== upload) return;
  const { epoch, sent } = upload;
  const left = upload.blob.size - sent;
  const room = Math.min(left, UPLOAD_WINDOW_BYTES - (sent - upload.acked));
  const bytes = room === left ? room : room - (room % LINK_LIMITS.pieceBytes);
  if (bytes <= 0) return;
  upload.reading = true;
  upload.blob.slice(sent, sent + bytes).arrayBuffer().then((buffer) => {
    upload.reading = false;
    if (upload.epoch !== epoch || uploads.get(upload.id) !== upload) return pump(upload);
    upload.sent = sent + buffer.byteLength;
    link.sender.push(`up:${upload.id}`, { id: upload.id, blob: new Uint8Array(buffer) });
    flushLink();
    pump(upload);
  }, () => {
    upload.reading = false;
    if (uploads.get(upload.id) !== upload) return;
    post(upload.client, { up: upload.id, error: { status: 0, code: "upload_read_failed", message: "The file could not be read" } });
    abortUpload(upload.id);
  });
}

/** An up_ack or up_error. Before its start's answer, an ack is of chunks sent before a drop: only the answer to the
 * latest up_start (`start: n`) says where chunks go on from; the answer to an earlier one (replayed after a resume) is
 * dropped. */
function onUploadLine(head: DownHead): void {
  const upload = typeof head.id === "string" ? uploads.get(head.id) : undefined;
  if (!upload) return;
  // An answer to an earlier up_start (replayed after a resume) says nothing of the latest one. Untagged errors are the upload's own.
  if (head.start !== undefined && head.start !== upload.opens) return;
  if (head.type === "up_error") {
    dropUpload(upload);
    post(upload.client, { up: upload.id, error: { status: Number(head.status), code: String(head.code), message: String(head.message) } });
    linkIdle();
    return;
  }
  const received = Number(head.received);
  const done = head.done === true;
  if (!Number.isSafeInteger(received) || received < 0) return;
  if (!upload.started) {
    if (head.start === undefined) return;
    upload.started = true;
    upload.acked = upload.sent = received;
  } else if (received > upload.acked) {
    upload.acked = received;
  } else if (!done) {
    return;
  }
  watchUpload(upload);
  post(upload.client, { up: upload.id, received: upload.acked, done, ...(done && typeof head.proof === "string" ? { proof: head.proof } : {}) });
  if (!done) return pump(upload);
  dropUpload(upload);
  linkIdle();
}

// ---- Measurement (spec D6 of the experiment) ----

/**
 * A clock sample (NTP-style) from a ping sent at `c` and answered at the server's `at`. A negative RTT (the device clock
 * stepped back mid-ping) is none. The worker's first clock records the frames held for it.
 */
function clockSample(c: number, at: number, now: number): void {
  const rtt = now - c;
  if (!Number.isFinite(rtt) || !Number.isFinite(at) || rtt < 0) return;
  const first = clockSamples.length === 0;
  clockSamples.push({ offset: at - (c + now) / 2, rtt, takenAt: now });
  if (clockSamples.length > CLOCK_WINDOW_SAMPLES) clockSamples.shift();
  if (first) recordHeldEvents();
}

/** The lowest-RTT sample of the window, or null before the first. */
function currentClock(now: number): Clock | null {
  while (clockSamples.length > 1 && now - clockSamples[0].takenAt > CLOCK_WINDOW_MS) clockSamples.shift();
  let best: Clock | null = null;
  for (const sample of clockSamples) if (!best || sample.rtt < best.rtt) best = sample;
  return best;
}

/** After an SSE hello: SSE_CLOCK_PROBES reads of the server clock one after another, then one per SSE_CLOCK_PROBE_MS, while that connection lasts. */
async function probeSseClock(current: string): Promise<void> {
  for (let i = 0; i < SSE_CLOCK_PROBES; i++) {
    if (connectionId !== current) return;
    await probeClock();
  }
  scheduleSseProbe(current);
}

function scheduleSseProbe(current: string): void {
  setTimeout(async () => {
    if (connectionId !== current) return;
    await probeClock();
    scheduleSseProbe(current);
  }, SSE_CLOCK_PROBE_MS);
}

/** Runs `run` with a signal that aborts after `ms` (no AbortSignal.timeout: older browsers lack it). */
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function probeClock(): Promise<void> {
  const c = Date.now();
  try {
    const body = await withDeadline(METRICS_TIMEOUT_MS, async (signal) => (await fetch(METRICS_PATH, { cache: "no-store", signal })).json());
    clockSample(c, body.now, Date.now());
  } catch {
    // Offline, refused or no answer in time: the next probe tries again.
  }
}

/** Prunes the connection's log of large frames (cross-session blocking) and logs this one if it is large. */
function logFrame(conn: Conn, owner: string, bytes: number, at: number, gotAt: number): LoggedFrame | null {
  const log = conn.largeFrames;
  while (log.length > 0 && gotAt - log[0].gotAt > LARGE_FRAME_LOG_MS) log.shift();
  if (bytes < LARGE_FRAME_BYTES || !Number.isFinite(at)) return null;
  const entry = { owner, bytes, at, gotAt };
  log.push(entry);
  return entry;
}

/**
 * The bytes of logged frames that a frame written at `at` and arrived at `gotAt` came in behind, by owner: written
 * before it, arrived before it and still arriving when it was written. `self`: its own entry, if logged.
 */
function behindFrames(log: LoggedFrame[], owner: string, at: number, gotAt: number, clock: Clock, self: LoggedFrame | null) {
  const behind = { same: 0, other: 0 };
  for (const frame of log) {
    if (frame === self || frame.gotAt > gotAt || frame.at > at || frame.gotAt + clock.offset <= at) continue;
    if (frame.owner === owner) behind.same += frame.bytes;
    else behind.other += frame.bytes;
  }
  return behind;
}

/**
 * A stream's frame from its connection, then to the tab: at most one event sample per connection per EVENT_SAMPLE_MS
 * (one behind another session's large frame always). Before the worker's first clock the connection's first frame is
 * held and recorded with that clock (recordHeldEvents).
 */
function deliver(subscription: Subscription, conn: Conn, data: string, at: number): void {
  const { channel } = subscription;
  const gotAt = Date.now();
  const owner = channel.kind === "session" ? channel.sessionId : "app";
  const entry = logFrame(conn, owner, data.length, at, gotAt);
  endReconnect(conn, gotAt);
  if (Number.isFinite(at)) {
    const clock = currentClock(gotAt);
    if (clock) {
      const behind = behindFrames(conn.largeFrames, owner, at, gotAt, clock, entry);
      if (behind.other > 0 || gotAt - conn.lastEventSampleAt >= EVENT_SAMPLE_MS) eventSample(conn, channel.kind, at, gotAt, data.length, clock, behind);
    } else if (conn.lastEventSampleAt === -Infinity) {
      conn.lastEventSampleAt = gotAt;
      conn.heldEvent = { channel: channel.kind, owner, at, gotAt, bytes: data.length, entry };
    }
  }
  post(subscription.client, { id: subscription.streamId, type: "message", data });
}

function eventSample(conn: Conn, channel: string, at: number, gotAt: number, bytes: number, clock: Clock, behind: { same: number; other: number }): void {
  conn.lastEventSampleAt = gotAt;
  record({ metric: "event", socket: conn.key, channel, at, gotAt, offset: clock.offset, offsetRtt: clock.rtt, bytes, behindSameBytes: behind.same, behindOtherBytes: behind.other });
}

/** The worker's first clock: the frames held for it are recorded with it. */
function recordHeldEvents(): void {
  const clock = currentClock(Date.now());
  if (!clock) return;
  for (const conn of [linkConn, sseConn]) {
    const held = conn.heldEvent;
    if (!held) continue;
    conn.heldEvent = null;
    eventSample(conn, held.channel, held.at, held.gotAt, held.bytes, clock, behindFrames(conn.largeFrames, held.owner, held.at, held.gotAt, clock, held.entry));
  }
}

/** A tab's sample. An HTTP action's reply shared the SSE stream's HTTP/2 connection: measured against its frame log. */
function recordTabSample(sample: Sample): void {
  if (sample.metric === "action" && sample.via === "http" && sample.replyBehindOtherBytes === null && Number.isFinite(sample.repliedAt) && Number.isFinite(sample.gotAt)) {
    const clock = currentClock(Date.now());
    const behind = clock && behindFrames(sseConn.largeFrames, String(sample.session), Number(sample.repliedAt), Number(sample.gotAt), clock, null);
    if (behind) sample = { ...sample, replyBehindOtherBytes: behind.other };
  }
  record(sample);
}

/** A connection dropped (`reconnect`): its outage runs from the first drop until a stream gets a frame after the next hello or welcome. */
function dropped(conn: Conn, trigger: string): void {
  conn.connectingSince ??= Date.now();
  if (conn.reconnect) return;
  const dropAt = Date.now();
  const woke = lastWake !== null && dropAt - lastWake.at <= WAKE_WINDOW_MS;
  conn.reconnect = { trigger, dropAt, startAt: woke && lastWake ? lastWake.at : dropAt, effectiveTypeBefore: woke && lastWake ? lastWake.effectiveType : effectiveType(), hello: false, resumed: null };
  // A drop is kept while an outage within BATCH_WINDOW_MS of it may still end and count it.
  let oldest = dropAt;
  for (const each of [sseConn, linkConn]) if (each.reconnect) oldest = Math.min(oldest, each.reconnect.dropAt);
  recentDrops = recentDrops.filter((at) => at >= oldest - BATCH_WINDOW_MS);
  recentDrops.push(dropAt);
}

/** The outage's end: the reconnect sample, `batch` counting the drops within BATCH_WINDOW_MS of this one. */
function endReconnect(conn: Conn, now: number): void {
  const reconnect = conn.reconnect;
  if (!reconnect?.hello) return;
  conn.reconnect = null;
  lastReconnect = { at: now, trigger: reconnect.trigger, outageMs: now - reconnect.dropAt, resumed: reconnect.resumed };
  let batch = 0;
  for (const at of recentDrops) if (Math.abs(at - reconnect.dropAt) <= BATCH_WINDOW_MS) batch += 1;
  record({
    metric: "reconnect",
    socket: conn.key,
    trigger: reconnect.trigger,
    dropAt: reconnect.dropAt,
    startAt: reconnect.startAt,
    firstFrameAt: now,
    batch,
    effectiveTypeBefore: reconnect.effectiveTypeBefore,
    ...(reconnect.resumed === null ? {} : { resumed: reconnect.resumed }),
  });
}

// Samples: tagged here, buffered (METRICS_BUFFER_MAX, the oldest dropped and counted) and POSTed over HTTP in every mode.

function effectiveType(): string | null {
  return scope.navigator.connection?.effectiveType ?? null;
}

/** The tags a sample lacks; an action sample (the tab's) also gets the worker's clock. */
function stamp(sample: Sample): Sample {
  const socket = typeof sample.socket === "string" ? sample.socket : "worker";
  let visible = false;
  for (const client of clients) visible = visible || client.visible;
  const clock = sample.metric === "action" ? currentClock(Date.now()) : null;
  return {
    transport: mode,
    socket,
    conn: socket,
    sockets: (link.ws ? 1 : 0) + (source ? 1 : 0),
    clientId,
    effectiveType: effectiveType(),
    visible,
    ...(sample.metric === "action" ? { offset: clock ? clock.offset : null, offsetRtt: clock ? clock.rtt : null } : {}),
    ...sample,
  };
}

function record(sample: Sample): void {
  const stamped = stamp(sample);
  samples.push(stamped);
  diagnosticSamples.push({ t: Date.now(), sample: stamped });
  if (diagnosticSamples.length > DIAGNOSTICS_MAX) diagnosticSamples.splice(0, diagnosticSamples.length - DIAGNOSTICS_MAX);
  trimSamples();
  // Reaching the count flushes right after this task, off the path that recorded it (a frame's delivery); a failed POST
  // leaves more than that, which then waits for the timer instead of retrying per sample.
  if (samples.length === METRICS_FLUSH_COUNT) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushSamples, 0);
  } else {
    scheduleFlush();
  }
}

function trimSamples(): void {
  const over = samples.length - METRICS_BUFFER_MAX;
  if (over <= 0) return;
  samples.splice(0, over);
  droppedSamples += over;
}

function scheduleFlush(): void {
  if (flushTimer === undefined && samples.length > 0) flushTimer = setTimeout(flushSamples, METRICS_FLUSH_MS);
}

/** POSTs the oldest METRICS_FLUSH_COUNT samples (and a `dropped` count); a failure keeps them for the next flush. */
function flushSamples(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (flushing || samples.length === 0) return;
  const batch = samples.splice(0, METRICS_FLUSH_COUNT);
  const droppedCount = droppedSamples;
  droppedSamples = 0;
  flushing = true;
  const body = JSON.stringify({ samples: droppedCount > 0 ? batch.concat(stamp({ metric: "dropped", count: droppedCount })) : batch });
  // The deadline grows with the batch so a slow link (about 2 KB/s and up) can finish it. A timeout after the server has
  // processed the batch sends it again and duplicates its samples (metrics only).
  withDeadline(METRICS_TIMEOUT_MS + body.length / METRICS_POST_BYTES_PER_MS, async (signal) => (await fetch(METRICS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  })).ok)
    .catch(() => false)
    .then((ok) => {
      flushing = false;
      if (ok && samples.length >= METRICS_FLUSH_COUNT) {
        flushSamples();
        return;
      }
      if (!ok) {
        samples = batch.concat(samples);
        droppedSamples += droppedCount;
        trimSamples();
      }
      scheduleFlush();
    });
}

/** The connection diagnostics panel's snapshot: the connection in use now and the last DIAGNOSTICS_WINDOW_MS of samples. */
function diagnostics(): ConnectionDiagnostics {
  const now = Date.now();
  const from = diagnosticSamples.findIndex((entry) => now - entry.t <= DIAGNOSTICS_WINDOW_MS);
  diagnosticSamples = from === -1 ? [] : diagnosticSamples.slice(from);
  const conn = mode === "ws" ? linkConn : sseConn;
  const wanted = mode === "ws" ? linkWanted() : subscriptions.size > 0;
  const connected = mode === "ws" ? link.ws?.readyState === OPEN && link.welcomed : source !== null && connectionId !== null;
  const since = !wanted || connected ? null : conn.connectingSince;
  let reconnects = 0;
  let resumes = 0;
  let resyncs = 0;
  for (const { sample } of diagnosticSamples) {
    if (sample.metric !== "reconnect") continue;
    reconnects++;
    if (sample.resumed === true) resumes++;
    else if (sample.resumed === false) resyncs++;
  }
  const clock = currentClock(now);
  return {
    setting,
    mode,
    fallback: setting === "ws" && mode === "sse" ? fallbackReason : null,
    // Down once commands would fail for want of a connection (SEND_DEADLINE_MS).
    status: !wanted ? "idle" : connected ? "connected" : since !== null && now - since >= SEND_DEADLINE_MS ? "down" : "connecting",
    since,
    lastReconnect,
    reconnects,
    resumes,
    resyncs,
    clockRttMs: clock ? clock.rtt : null,
    effectiveType: effectiveType(),
    windowMs: DIAGNOSTICS_WINDOW_MS,
    stats: diagnosticStats(diagnosticSamples.map((entry) => entry.sample)),
  };
}

// ---- The message outbox's first leg (docs/specs/2026-11-04-message-outbox-design.md O2): a message is committed to
// IndexedDB before the tab's composer clears, then goes as `outbox_add` over the current transport until the server
// has stored it. Each session's entries go one at a time, oldest first: the server queues them in arrival order. ----

const OUTBOX_DB = "omp-web-outbox";
const OUTBOX_STORE = "entries";
/** The server keeps delivered ids 8 days: an older entry is never sent again, or a resend could deliver it twice. */
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface OutboxItem {
  entry: LocalOutboxEntry;
  /** An attempt is out: its answer decides what comes next. */
  inFlight: boolean;
  retryTimer: Timer | undefined;
  /** The next transient failure's delay: RECONNECT_MIN_MS doubling to RECONNECT_MAX_MS, reset by a wake. */
  retryMs: number;
}

/** Every entry this browser holds, by id. */
const outboxItems = new Map<string, OutboxItem>();
/** One shared-store head read per session at a time, including while several local entries commit. */
const outboxReading = new Set<string>();
const outboxDropping = new Set<string>();
/** A session whose shared-list read failed reads again after this delay (1 s doubling to 30 s): no send goes before it. */
const outboxReadRetry = new Map<string, { timer: Timer | undefined; ms: number }>();
/** The last read of the shared list failed: this worker's list may miss other workers' earlier entries. */
let outboxPartial = false;
const outboxDb = openOutboxDb();
/** The stored entries are loaded (and sent): every tab's outbox op waits for it, so none races them. */
let outboxReady = outboxDb.then(loadOutbox);

/** Retry a failed load on the next operation; concurrent tabs share that attempt too. */
async function ensureOutboxReady(): Promise<boolean> {
  const pending = outboxReady;
  if (await pending) return true;
  if (outboxReady === pending) outboxReady = outboxDb.then(loadOutbox);
  return outboxReady;
}

/** null where IndexedDB is missing or refuses: adds must fail without a durable store. */
function openOutboxDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const factory = scope.indexedDB;
    if (!factory) return resolve(null);
    try {
      const request = factory.open(OUTBOX_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** A failed read must not let a private worker's incomplete snapshot choose which message goes first. */
function readOutbox(db: IDBDatabase | null): Promise<LocalOutboxEntry[] | null> {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const transaction = db.transaction(OUTBOX_STORE);
      const request = transaction.objectStore(OUTBOX_STORE).getAll();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** What an earlier worker (or tab) left: every unsent entry goes again. */
async function loadOutbox(db: IDBDatabase | null): Promise<boolean> {
  const stored = await readOutbox(db);
  if (!stored) return false;
  for (const entry of stored) outboxItems.set(entry.id, { entry, inFlight: false, retryTimer: undefined, retryMs: RECONNECT_MIN_MS });
  await Promise.all([...new Set(stored.map((entry) => entry.sessionId))].map((sessionId) => sendOutbox(sessionId)));
  return true;
}

/** True only once a write commits: a quota error or abort must not clear the composer's draft. */
async function writeOutbox(change: (store: IDBObjectStore) => void): Promise<boolean> {
  const db = await outboxDb;
  if (!db) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = transaction.onabort = () => resolve(false);
      change(transaction.objectStore(OUTBOX_STORE));
    } catch {
      resolve(false);
    }
  });
}

/** Unsequenced legacy rows precede new adds; their already-lost timestamp ties use a deterministic id fallback. */
function compareOutbox(a: LocalOutboxEntry, b: LocalOutboxEntry): number {
  return (a.enqueueOrder ?? 0) - (b.enqueueOrder ?? 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every entry, in submission order. */
function outboxList(): LocalOutboxEntry[] {
  return [...outboxItems.values()].map((item) => item.entry).sort(compareOutbox);
}

function broadcastOutbox(): void {
  const list = outboxList();
  for (const client of clients) post(client, outboxPartial ? { outbox: list, partial: true } : { outbox: list });
}

/** A tab's list once loaded. An empty one only when `always`: a tab back from the bfcache may still show gone entries. */
function tellOutbox(client: Client, always: boolean): void {
  void ensureOutboxReady().then((loaded) => {
    if (loaded && (always || outboxItems.size > 0)) post(client, outboxPartial ? { outbox: outboxList(), partial: true } : { outbox: outboxList() });
  });
}

function addOutbox(client: Client, n: number, entry: LocalOutboxEntry): void {
  void ensureOutboxReady().then(async (loaded) => {
    const item: OutboxItem = { entry: { ...entry, state: "sending" }, inFlight: false, retryTimer: undefined, retryMs: RECONNECT_MIN_MS };
    const committed = loaded && await writeOutbox((store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        // The store's readwrite lock serializes allocation with every other worker's acceptance.
        item.entry.enqueueOrder = (request.result as LocalOutboxEntry[]).reduce((max, row) => Math.max(max, row.enqueueOrder ?? 0), 0) + 1;
        store.add(item.entry);
      };
    });
    if (!committed) {
      post(client, { outboxAdded: n, error: "The message could not be saved to this browser. Send it again." });
      return;
    }
    // Committed: the entry is accepted whatever follows, or a resend from the composer would duplicate it under a new id.
    outboxItems.set(item.entry.id, item);
    // Include earlier entries from every worker before the tab can clear its composer or run pagehide keepalives; a failed
    // read only delays the send (sendOutbox reads again before any network attempt).
    await refreshOutbox();
    broadcastOutbox();
    post(client, { outboxAdded: n });
    sendOutbox(item.entry.sessionId);
  });
}

function dropOutbox(client: Client, n: number, id: string): void {
  void ensureOutboxReady().then(async (loaded) => {
    const item = outboxItems.get(id);
    outboxDropping.add(id);
    const removed = loaded && await writeOutbox((store) => store.delete(id));
    outboxDropping.delete(id);
    if (!removed) {
      post(client, { outboxDropped: n, error: "The message could not be removed from this browser. Try again." });
      return;
    }
    clearTimeout(item?.retryTimer);
    outboxItems.delete(id);
    post(client, { outboxDropped: n });
    broadcastOutbox();
    if (item) sendOutbox(item.entry.sessionId);
  });
}

/** Refresh the whole shared list before exposing an add or choosing a session head; null means the read failed. */
async function refreshOutbox(): Promise<boolean | null> {
  const entries = await readOutbox(await outboxDb);
  if (!entries) {
    outboxPartial = true;
    return null;
  }
  const ids = new Set(entries.map((entry) => entry.id));
  // Back to a complete view: the tabs hear it even when no entry changed.
  let changed = outboxPartial;
  outboxPartial = false;
  for (const [id, item] of outboxItems) {
    if (ids.has(id)) continue;
    clearTimeout(item.retryTimer);
    outboxItems.delete(id);
    changed = true;
  }
  for (const entry of entries) {
    const item = outboxItems.get(entry.id);
    if (!item) {
      outboxItems.set(entry.id, { entry, inFlight: false, retryTimer: undefined, retryMs: RECONNECT_MIN_MS });
      changed = true;
    } else if (item.entry.state !== entry.state || item.entry.error !== entry.error) {
      item.entry = entry;
      changed = true;
    }
  }
  return changed;
}

/** Every attempt reads the shared store: dedicated workers and old/new SharedWorkers must agree on the session head. */
async function sendOutbox(sessionId: string): Promise<void> {
  if (outboxReading.has(sessionId)) return;
  outboxReading.add(sessionId);
  const changed = await refreshOutbox();
  outboxReading.delete(sessionId);
  if (changed === null) {
    const retry = outboxReadRetry.get(sessionId) ?? { timer: undefined, ms: RECONNECT_MIN_MS };
    outboxReadRetry.set(sessionId, retry);
    if (retry.timer !== undefined) return;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      sendOutbox(sessionId);
    }, retry.ms);
    retry.ms = Math.min(retry.ms * 2, RECONNECT_MAX_MS);
    return;
  }
  clearTimeout(outboxReadRetry.get(sessionId)?.timer);
  outboxReadRetry.delete(sessionId);
  if (changed) broadcastOutbox();
  const head = outboxList().find((entry) => entry.sessionId === sessionId && entry.state === "sending");
  const item = head && outboxItems.get(head.id);
  if (!item || item.inFlight || item.retryTimer !== undefined || outboxDropping.has(item.entry.id)) return;
  if (Date.now() - item.entry.createdAt > OUTBOX_MAX_AGE_MS) return failOutbox(item, "Not sent within 7 days.");
  if (typeof item.entry.scope !== "string" || !item.entry.scope) return failOutbox(item, "This message has no saved installation or sign-in scope and cannot be sent.");
  item.inFlight = true;
  const { id, scope, advisor, mode, message, images, uploads, uploadProofs } = item.entry;
  const body = JSON.stringify({ type: "outbox_add", id, scope, mode, message, images, uploads, uploadProofs });
  // A tab of the worker's own (not in `clients`): the command takes the current transport as a tab's would.
  const port: Port = {
    onmessage: null,
    postMessage(answer) {
      const { http, status, body: reply } = answer as { http?: true; status: number; body: unknown };
      if (!http) return outboxAnswer(item, status, reply);
      // A half-open POST must not block this session forever; include the body read and allow 2 KB/s for its uplink.
      withDeadline(40_000 + Math.ceil(body.length / 2), async (signal) => {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}${advisor === true ? "?advisor=1" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal });
        const reply = await response.json().catch((error) => {
          if (signal.aborted) throw error;
          return null;
        });
        return { status: response.status, body: reply };
      }).then(
        ({ status, body }) => outboxAnswer(item, status, body),
        () => outboxAnswer(item, 0, null),
      );
    },
  };
  // A fresh request id per attempt; the server dedupes outbox_add by the entry's id.
  const req = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  queueCommand({ port, streams: new Map(), visible: false }, { n: 0, req, sessionId, advisor: advisor === true, body, type: "outbox_add" });
}

/** A transport success is not a storage receipt (a sign-in page can also answer 200). */
function acceptedOutboxEntry(body: unknown, id: string): unknown {
  const reply = body as { success?: unknown; data?: { entry?: Record<string, unknown> } } | null;
  const entry = reply?.data?.entry;
  return reply?.success === true && entry?.id === id &&
    typeof entry.sessionId === "string" && entry.sessionId.length > 0 &&
    ["prompt", "followUp", "steer"].includes(entry.mode as string) &&
    ["held", "waiting_host", "delivering", "failed", "delivered"].includes(entry.state as string) &&
    (entry.images === undefined || Array.isArray(entry.images) && entry.images.every((image) => image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string")) &&
    (entry.uploads === undefined || Array.isArray(entry.uploads) && entry.uploads.every((upload) => typeof upload === "string")) &&
    (entry.error === undefined || typeof entry.error === "string") &&
    (entry.mayHaveBeenSent === undefined || typeof entry.mayHaveBeenSent === "boolean") &&
    typeof entry.message === "string" && typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) && entry.createdAt >= 0
    ? entry : null;
}

/**
 * Valid 2xx acceptance: stored, gone from here. Unconfirmed success, no answer, 401, 408, 429 or a 5xx: again after the entry's
 * delay. Any other refusal is final (O6): "failed" until a tab drops it, and the session's next entry goes.
 */
async function outboxAnswer(item: OutboxItem, status: number, body: unknown): Promise<void> {
  const { id, sessionId } = item.entry;
  if (outboxItems.get(id) !== item) return;
  const reply = (body ?? {}) as { error?: unknown };
  const accepted = acceptedOutboxEntry(body, id);
  if (status >= 200 && status < 300 && !accepted) status = 0;
  if (status >= 200 && status < 300) {
    if (!(await writeOutbox((store) => store.delete(id)))) return outboxAnswer(item, 0, null);
    outboxItems.delete(id);
    for (const client of clients) post(client, { outboxStored: accepted });
  } else if (status === 0 || status === 401 || status === 408 || status === 429 || status >= 500) {
    item.inFlight = false;
    item.retryTimer = setTimeout(() => {
      item.retryTimer = undefined;
      sendOutbox(sessionId);
    }, item.retryMs);
    item.retryMs = Math.min(item.retryMs * 2, RECONNECT_MAX_MS);
    return;
  } else {
    return failOutbox(item, typeof reply.error === "string" ? reply.error : `HTTP ${status}`);
  }
  broadcastOutbox();
  sendOutbox(sessionId);
}

/** Final: "failed" until a tab drops it, and the session's next entry goes. Written only over a row still "sending" in
 * the same transaction: another worker (or the service worker) may have had a 200 and deleted it meanwhile. */
async function failOutbox(item: OutboxItem, error: string): Promise<void> {
  item.inFlight = true;
  const { id, sessionId } = item.entry;
  const failed: LocalOutboxEntry = { ...item.entry, state: "failed", error };
  const read: { stored?: LocalOutboxEntry } = {};
  const committed = await writeOutbox((store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      read.stored = request.result as LocalOutboxEntry | undefined;
      if (read.stored?.state === "sending") store.put(failed);
    };
  });
  if (!committed) return outboxAnswer(item, 0, null);
  item.inFlight = false;
  if (outboxItems.get(id) !== item) return;
  if (!read.stored) {
    clearTimeout(item.retryTimer);
    outboxItems.delete(id);
  } else item.entry = read.stored.state === "sending" ? failed : read.stored;
  broadcastOutbox();
  sendOutbox(sessionId);
}

/** The network or the page is back: every waiting entry goes again now, from the shortest delay. */
function retryOutbox(): void {
  for (const item of outboxItems.values()) {
    clearTimeout(item.retryTimer);
    item.retryTimer = undefined;
    item.retryMs = RECONNECT_MIN_MS;
  }
  for (const item of [...outboxItems.values()]) sendOutbox(item.entry.sessionId);
}

function attach(port: Port): void {
  const client: Client = { port, streams: new Map(), visible: false };
  clients.add(client);
  // Tabs assume SSE until told otherwise.
  if (mode !== "sse") post(client, { transport: mode });
  tellOutbox(client, false);
  port.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    const data = message as Record<string, unknown>;
    // A tab back from the bfcache sends whatever comes first (a `wake`, often, or the reopened streams) after its `bye`
    // removed it: it missed any mode change since.
    if (data.op !== "bye" && !clients.has(client)) {
      clients.add(client);
      post(client, { transport: mode });
      tellOutbox(client, true);
    }
    switch (data.op) {
      case "open":
        open(client, Number(data.id), data.channel as EventStreamChannel);
        break;
      case "close":
        close(client, Number(data.id));
        break;
      case "bye":
        dropClient(client);
        break;
      case "wake":
        client.visible = data.visible === true;
        if (typeof data.clientId === "string") clientId = data.clientId;
        wake(String(data.reason));
        break;
      case "diag":
        post(client, { diag: data.n, data: diagnostics() });
        break;
      case "metric":
        if (data.sample && typeof data.sample === "object") recordTabSample(data.sample as Sample);
        break;
      case "cmd":
        queueCommand(client, data);
        break;
      case "upload":
        addUpload(client, data);
        break;
      case "up_pause": {
        const upload = uploads.get(String(data.id));
        if (upload?.client === client) {
          dropUpload(upload);
          linkIdle();
        }
        break;
      }
      case "up_abort":
        abortUpload(String(data.id), typeof data.host === "string" ? data.host : undefined);
        break;
      case "outbox_add":
        addOutbox(client, Number(data.n), data.entry as LocalOutboxEntry);
        break;
      case "outbox_drop":
        dropOutbox(client, Number(data.n), String(data.id));
        break;
      case "lock":
        // MessagePort has no close event. The tab holds this lock for its
        // whole life; it is granted to us only once that tab is gone
        // (closed, crashed, discarded), however it died.
        void scope.navigator.locks?.request(String(data.name), () => {
          dropClient(client);
        });
        break;
    }
  };
}

if ("onconnect" in scope) scope.onconnect = (event) => attach(event.ports[0]);
else attach(scope);
