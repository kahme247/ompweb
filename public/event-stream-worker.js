// omp-web live-event multiplexer.
//
// Runs as a SharedWorker (one per browser profile) — or a dedicated Worker
// where SharedWorker is unavailable — and carries every tab's stream
// (lib/event-stream.ts) as a subscription on its own connections, so opening
// more tabs no longer consumes more of the browser's six HTTP/1.1 connections
// per host. The server's `browserTransport` setting (every hello and
// `transport` control frame carry it) picks the connections:
//   "sse" (default): the ONLY `/api/events` EventSource; POST /api/events subscribes.
//   "ws-client" | "ws-session" | "ws-pool": `/api/events/ws` sockets; any socket carries
//   any channel and any session's commands, and the mode only picks the socket
//   (socketKeyFor): one for everything, a general one plus one per session, or a pool.
//
// Plain script, not bundled: mirrors lib/event-stream-protocol.ts.
//
// Tab -> worker:  { op: "open", id, channel } | { op: "close", id }
//                 { op: "lock", name }  (tab holds this Web Lock while alive)
//                 { op: "bye" }         (pagehide: drop this tab's streams)
//                 { op: "wake", reason, visible, clientId }  (reason: init | visible | hidden | online | network)
//                 { op: "cmd", n, req, sessionId, advisor, body }  (an agent command; body: its JSON text)
//                 { op: "metric", sample }  (a transport sample of the tab's: tagged, buffered and POSTed here)
// Worker -> tab:  { id, type: "open" }
//                 { id, type: "message", data }   (raw JSON string)
//                 { id, type: "error", readyState: 0 | 2 }  (EventSource semantics)
//                 { transport: "sse" | "ws-client" | "ws-session" | "ws-pool" }  (on attach once known, and on every change)
//                 { cmd: n, http: true }  (SSE mode: the tab POSTs the command itself)
//                 { cmd: n, status, body, recvAt, repliedAt, attempts, deduped, behindBytes,
//                   socket, behindSameBytes, behindOtherBytes, replyBehindOtherBytes }
"use strict";

const EVENT_STREAM_PATH = "/api/events";
const MUX_CONTROL_EVENT = "mux";
const UNKNOWN_CONNECTION_CODE = "unknown_connection";
const BROWSER_TRANSPORTS = ["sse", "ws-client", "ws-session", "ws-pool"];
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
// Mirrors EventSource's own reconnect delay after a server-ended stream.
const RESUBSCRIBE_DELAY_MS = 3000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const EVENT_SOCKET_PATH = "/api/events/ws";
// A session socket closes this long after its last stream and command, so a tab switch back reuses it.
const SESSION_LINGER_MS = 30000;
// The server pings every 10 s: a socket with no frame for this long is dead.
const WS_SILENCE_MS = 25000;
const SILENCE_CHECK_MS = 1000;
const VISIBLE_PROBE_MS = 3000;
// Every tab forwards the same network or visibility event: a dial younger than
// this without a hello is the one an earlier tab's wake just started.
const WAKE_REDIAL_GAP_MS = 1000;
const FORCED_RECONNECT_CODE = 4000;
// Mirrors MAX_AGENT_COMMAND_REQUEST_BYTES (lib/image-attachments.ts): the route answers 413 above this many UTF-8 bytes.
const MAX_AGENT_COMMAND_REQUEST_BYTES = 8 * 1024 * 1024;
const SEND_DEADLINE_MS = 15000;
// Plus 1 ms per 32 bytes the socket must upload before the ack can come (a 32 KB/s floor).
const ACK_TIMEOUT_MS = 10000;
const TRANSPORT_UNAVAILABLE = { error: "Not sent: no connection to omp-web.", code: "transport_unavailable" };
const TRANSPORT_LOST = { error: "The connection to omp-web dropped before the answer arrived; the command may have run.", code: "transport_lost" };
// Transport samples (spec D6): POSTed in batches to the metrics route, whose GET is the SSE clock probe.
const METRICS_PATH = "/api/transport-metrics";
const METRICS_FLUSH_MS = 30000;
const METRICS_FLUSH_COUNT = 200;
const METRICS_BUFFER_MAX = 2000;
const EVENT_SAMPLE_MS = 1000;
const WAKE_WINDOW_MS = 60000;
const BATCH_WINDOW_MS = 2000;
const SSE_CLOCK_PROBES = 3;
const LARGE_FRAME_BYTES = 64 * 1024;
const LARGE_FRAME_LOG_MS = 30000;

/** @type {EventSource | null} */
let source = null;
/** @type {string | null} */
let connectionId = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer;
let reconnectDelayMs = RECONNECT_MIN_MS;
let nextSubscriptionId = 1;
/** Server subscription id -> subscription. */
const subscriptions = new Map();
/**
 * The server's setting: SSE until a hello or `transport` control frame says otherwise.
 * The pool numbers are placeholders until then (every hello carries the server's; lib/web-settings.ts owns the defaults).
 */
let state = { transport: "sse", perSocket: 4, maxSockets: 16 };
/** Every attached tab, told the mode when it changes. */
const clients = new Set();
/**
 * The WebSocket modes' sockets: socketKeyFor's key -> Conn (see connFor).
 * Empty in SSE mode, so wakes and silence checks have nothing to act on there.
 */
const conns = new Map();
/** Retired Conns whose sockets stay open until the commands sent on them are answered (see retire). */
const draining = new Set();
/** SSE subscriptions' `conn`: the EventSource's per-connection state, shaped like a Conn's. */
const sseConn = { key: "sse", clock: null, lastEventSampleAt: -Infinity, reconnect: null, largeFrames: [] };
/** @type {ReturnType<typeof setInterval> | undefined} */
let silenceTimer;
/** ws-pool's size N (spec D2 "ws-pool sizing"); 1 outside ws-pool. */
let poolSize = 1;
/** Running while the pool's target is below N (see sizePool). @type {ReturnType<typeof setTimeout> | undefined} */
let shrinkTimer;
/** Samples waiting for the next flush, oldest first, and how many overflow dropped since the last one. */
let samples = [];
let droppedSamples = 0;
let flushing = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let flushTimer;
/** The min-RTT clock sample of any connection: `serverNow = clientNow + offset`. @type {{ offset: number, rtt: number } | null} */
let bestClock = null;
/** From the tabs' wakes: this browser's id, and the effective connection type as of the latest one. */
let clientId = null;
let knownEffectiveType = null;
/** The latest online, network or visible wake (once per burst from every tab), and the effective type before it. */
let lastWake = null;
/** dropAt of the reconnects that a running one may still count in its `batch`. */
let recentDrops = [];

function post(client, message) {
  try {
    client.port.postMessage(message);
  } catch {
    // The tab is gone; its lock/bye cleanup releases the subscriptions.
  }
}

function notifyError(subscription, readyState) {
  subscription.state = readyState;
  post(subscription.client, { id: subscription.streamId, type: "error", readyState });
}

/** A connection dropped: its live subscriptions are reconnecting. */
function markConnecting(list) {
  for (const subscription of list) {
    clearTimeout(subscription.retryTimer);
    if (subscription.state === OPEN) notifyError(subscription, CONNECTING);
  }
}

function closeSource() {
  source?.close();
  source = null;
  connectionId = null;
}

function scheduleReconnect() {
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

function ensureSource() {
  if (source || reconnectTimer !== undefined || subscriptions.size === 0) return;
  const current = new EventSource(EVENT_STREAM_PATH);
  source = current;
  current.addEventListener(MUX_CONTROL_EVENT, (event) => {
    if (source !== current) return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleControl(frame);
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

/** A control frame from the EventSource (`conn` = sseConn) or from a socket's Conn. */
function handleControl(frame, conn = sseConn) {
  if (frame.type === "transport") {
    setTransport(frame);
    return;
  }
  if (frame.type === "hello") {
    // A worker that missed a switch (or just started) converges here, before this
    // connection counts as open: a stream moving onto it is subscribed once, below.
    setTransport(frame);
    if (conn === sseConn) {
      reconnectDelayMs = RECONNECT_MIN_MS;
      // Switched to sockets: the switch moved every subscription off this EventSource.
      if (isWebSocketTransport(state.transport)) return;
      connectionId = frame.connectionId;
      probeSseClock(source);
    } else {
      conn.reconnectDelayMs = RECONNECT_MIN_MS;
      // Retired by the switch (to SSE, or emptied by a move and no key of the new mode).
      if (conn.retiring) return;
      conn.connectionId = frame.connectionId;
      conn.serverId = frame.serverId;
    }
    if (conn.reconnect) {
      conn.reconnect.hello = true;
      // No stream, no frame to end its outage (and nothing was being delivered).
      if (!carriesStream(conn)) conn.reconnect = null;
    }
    for (const subscription of subscriptions.values()) {
      if (subscription.conn === conn) subscribe(subscription);
      else if (subscription.moving === conn) sendSub(conn, subscription);
    }
    if (conn !== sseConn) sendWaiting(conn);
    return;
  }
  if (frame.type === "open") endReconnect(conn, Date.now());
  const subscription = subscriptions.get(frame.sub);
  if (subscription?.moving === conn) {
    if (frame.type !== "open") {
      // refused or end: the move is off; the stream stays where it is and moves at the next policy change.
      cancelMove(subscription);
      return;
    }
    // Make-before-break: the old socket delivered until now; the tab sees the reconnect
    // it already handles (CONNECTING, then OPEN with the channel's snapshot).
    const old = subscription.conn;
    if (old.connectionId) sendFrame(old, { t: "unsub", id: subscription.id });
    markConnecting([subscription]);
    subscription.moving = null;
    subscription.conn = conn;
    conn.subs.add(subscription);
    leave(old, subscription);
  }
  if (!subscription || subscription.conn !== conn) return;
  if (frame.type === "open") {
    subscription.state = OPEN;
    post(subscription.client, { id: subscription.streamId, type: "open" });
    settleMove(subscription);
  } else if (frame.type === "end") {
    // The server ended this subscription (watcher died, unserializable
    // frame): reconnect it like EventSource would reconnect a closed stream.
    notifyError(subscription, CONNECTING);
    clearTimeout(subscription.retryTimer);
    subscription.retryTimer = setTimeout(() => subscribe(subscription), RESUBSCRIBE_DELAY_MS);
  } else if (frame.type === "refused") {
    // A socket's answer to a failed `sub`: fatal, like a refused POST below.
    release(subscription);
    notifyError(subscription, CLOSED);
  }
}

function isWebSocketTransport(transport) {
  return transport !== "sse";
}

/**
 * Applies the server's setting from a hello or `transport` frame. Idempotent: a frame
 * without a known transport (an older server's hello) or equal to the current state
 * changes nothing. True when it changed. To or from SSE every subscription switches
 * at once (spec D5 "Mode switch"); between socket modes they move (rebalance).
 */
function setTransport(next) {
  const perSocket = Number.isInteger(next.perSocket) ? next.perSocket : state.perSocket;
  const maxSockets = Number.isInteger(next.maxSockets) ? next.maxSockets : state.maxSockets;
  if (!BROWSER_TRANSPORTS.includes(next.transport)) return false;
  if (next.transport === state.transport && perSocket === state.perSocket && maxSockets === state.maxSockets) return false;
  const previous = state.transport;
  const fromPool = previous === "ws-pool" ? poolSize : null;
  state = { transport: next.transport, perSocket, maxSockets };
  if (state.transport !== previous) for (const client of clients) post(client, { transport: state.transport });
  // A setting or mode change applies its N at once, in both directions.
  clearTimeout(shrinkTimer);
  shrinkTimer = undefined;
  poolSize = state.transport === "ws-pool" ? poolTarget(activeSessions()) : 1;
  if (isWebSocketTransport(previous) === isWebSocketTransport(state.transport)) {
    if (isWebSocketTransport(state.transport)) rebalance(state.transport === previous ? "setting" : "mode", fromPool);
    return true;
  }
  markConnecting(subscriptions.values());
  if (isWebSocketTransport(state.transport)) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    closeSource();
    sseConn.reconnect = null;
    for (const subscription of subscriptions.values()) join(subscription);
  } else {
    // Before retiring: a socket a move still points at would never count as idle.
    for (const subscription of subscriptions.values()) {
      subscription.conn = sseConn;
      subscription.moving = null;
      settleMove(subscription);
    }
    for (const conn of conns.values()) retire(conn);
    ensureSource();
  }
  return true;
}

/** The socket for a session's stream and commands, or for every non-session channel (null): spec D2. */
function socketKeyFor(sessionId) {
  if (state.transport === "ws-client") return "client";
  // Sessions ranked 0 share pool:0 with every non-session channel.
  if (state.transport === "ws-pool") return sessionId === null ? "pool:0" : `pool:${poolRank(sessionId, poolSize)}`;
  return sessionId === null ? "general" : `session:${sessionId}`;
}

/** Whether the current policy can still produce `key`: an idle socket whose key it cannot closes at once. */
function keyValid(key) {
  if (state.transport === "ws-client") return key === "client";
  if (state.transport === "ws-pool") return key.startsWith("pool:") && Number(key.slice(5)) < poolSize;
  return state.transport === "ws-session" && (key === "general" || key.startsWith("session:"));
}

// Rendezvous (highest-random-weight) ranking, spec D2: the hash is fixed so every worker ranks the same.
// Growing N to N+1 moves only the sessions whose top score is the new index; shrinking only those of the removed one.

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function fmix32(hash) {
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** The index in [0, n) with the highest score for this session (the lowest on a tie). */
function poolRank(sessionId, n) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < n; i++) {
    const score = fmix32(fnv1a(`${i}:${sessionId}`));
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/**
 * This worker's active sessions (spec D2): a `session` stream (current or moving) or an unanswered command on any
 * socket; plus `joining`, a session whose first stream or command is being added.
 */
function activeSessions(joining) {
  const active = new Set();
  if (joining !== undefined) active.add(joining);
  for (const subscription of subscriptions.values()) if (subscription.channel.kind === "session") active.add(subscription.channel.sessionId);
  eachSocket((conn) => {
    for (const command of conn.pending.values()) active.add(command.session);
  });
  return active;
}

/** ws-pool's N for these active sessions: clamp(ceil(active / perSocket), 1, maxSockets). */
function poolTarget(active) {
  return Math.min(Math.max(Math.ceil(active.size / state.perSocket), 1), state.maxSockets);
}

/**
 * Recomputes N in ws-pool after the active sessions changed: grows at once; shrinks only once the target has
 * stayed below N for SESSION_LINGER_MS (a recompute that reaches N cancels it). `joining` is counted now, so its
 * stream or command goes straight to its bucket of the new size.
 */
function sizePool(joining) {
  if (state.transport !== "ws-pool") return;
  const target = poolTarget(activeSessions(joining));
  if (target > poolSize) {
    resizePool("grow", target, joining);
  } else if (target === poolSize) {
    clearTimeout(shrinkTimer);
    shrinkTimer = undefined;
  } else if (shrinkTimer === undefined) {
    shrinkTimer = setTimeout(() => {
      shrinkTimer = undefined;
      const now = poolTarget(activeSessions());
      if (now < poolSize) resizePool("shrink", now);
    }, SESSION_LINGER_MS);
  }
}

/** N becomes `target` now; every stream and command whose bucket changed moves (rebalance). */
function resizePool(reason, target, joining) {
  const fromPool = poolSize;
  clearTimeout(shrinkTimer);
  shrinkTimer = undefined;
  poolSize = target;
  return rebalance(reason, fromPool, joining);
}

function subscriptionKey(subscription) {
  const { channel } = subscription;
  return socketKeyFor(channel.kind === "session" ? channel.sessionId : null);
}

/**
 * After a policy change (spec D2 "Moves"; reason: "grow" | "shrink" | "setting" | "mode"): every stream whose key
 * changed moves make-before-break; a session's commands move to its new socket together and only while none of
 * them was sent (a sent one is answered on its socket, and the session's later ones wait behind it there); then
 * sockets left with nothing close (at once when the policy no longer produces their key) or linger.
 * Returns the change, which is also its `rebalance` sample (spec D6): `fromPool`/`toPool` are N in ws-pool, else
 * null; `fromSockets` the sockets held before, `toSockets` those held after that the policy still produces; `moved`
 * the sessions whose socket changed; `movedOther` the non-session streams moved. `joining` (a grow's new session)
 * is active and its socket dialed here, so a grow's sample counts both. A change that moved something or resized
 * the pool is recorded once its last moved stream is open on its new socket or its move is off (settleMove).
 */
function rebalance(reason, fromPool, joining) {
  const fromSockets = heldSockets(false);
  const moved = new Set();
  let movedOther = 0;
  const settling = { sample: null, left: 0, startedAt: Date.now() };
  for (const subscription of subscriptions.values()) {
    const key = subscriptionKey(subscription);
    if (subscription.moving && subscription.moving.key !== key) cancelMove(subscription);
    if (subscription.conn.key === key || subscription.moving) continue;
    move(subscription, connFor(key));
    subscription.rebalance = settling;
    settling.left += 1;
    if (subscription.channel.kind === "session") moved.add(subscription.channel.sessionId);
    else movedOther += 1;
  }
  for (const conn of [...conns.values()]) {
    const sessions = strayCommandSessions(conn);
    for (const command of conn.pending.values()) if (command.attempts > 0) sessions.delete(command.session);
    for (const session of sessions) {
      moveCommands(conn, session);
      moved.add(session);
    }
  }
  if (joining !== undefined) connFor(socketKeyFor(joining));
  for (const conn of [...conns.values()]) idle(conn);
  const toPool = state.transport === "ws-pool" ? poolSize : null;
  const result = { reason, fromPool, toPool, fromSockets, toSockets: heldSockets(true), active: activeSessions(joining).size, moved: moved.size, movedOther };
  if (moved.size > 0 || movedOther > 0 || fromPool !== toPool) {
    settling.sample = { metric: "rebalance", ...result };
    if (settling.left === 0) record({ ...settling.sample, settledMs: 0 });
  }
  return result;
}

/** A stream a rebalance moved is open on its new socket, or its move is off: the last one records the sample. */
function settleMove(subscription) {
  const settling = subscription.rebalance;
  if (!settling) return;
  subscription.rebalance = null;
  settling.left -= 1;
  if (settling.left === 0) record({ ...settling.sample, settledMs: Date.now() - settling.startedAt });
}

/** Sockets this worker holds (open or dialing); `policyOnly`: only those whose key the current policy still produces. */
function heldSockets(policyOnly) {
  let count = 0;
  for (const conn of conns.values()) if (conn.ws && (!policyOnly || keyValid(conn.key))) count += 1;
  return count;
}

/** Subscribes on `conn`; the current socket keeps delivering until `conn` opens it (handleControl). */
function move(subscription, conn) {
  subscription.moving = conn;
  sendSub(conn, subscription);
}

function cancelMove(subscription) {
  const target = subscription.moving;
  if (!target) return;
  subscription.moving = null;
  settleMove(subscription);
  if (target.connectionId) sendFrame(target, { t: "unsub", id: subscription.id });
  idle(target);
}

function requestServer(body) {
  return fetch(EVENT_STREAM_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, ...body }),
    keepalive: true,
  });
}

function subscribe(subscription) {
  const conn = subscription.conn;
  if (conn !== sseConn) {
    sendSub(conn, subscription);
    return;
  }
  if (!connectionId || subscriptions.get(subscription.id) !== subscription) return;
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
    // Refused (409 unmanaged session, 403/404 file, ...): fatal, like an
    // EventSource HTTP error. The tab decides whether to retry.
    release(subscription);
    notifyError(subscription, CLOSED);
  }, () => {
    if (!stale()) scheduleReconnect();
  });
}

/** Before its hello a socket has nothing to send on; the hello sends every subscription it carries or takes over. */
function sendSub(conn, subscription) {
  if (conn.connectionId) sendFrame(conn, { t: "sub", id: subscription.id, channel: subscription.channel });
}

function release(subscription) {
  clearTimeout(subscription.retryTimer);
  subscriptions.delete(subscription.id);
  subscription.client.streams.delete(subscription.streamId);
  cancelMove(subscription);
  settleMove(subscription);
  if (subscription.conn !== sseConn) leave(subscription.conn, subscription);
  if (subscription.channel.kind === "session") sizePool();
  source?.removeEventListener(subscription.id, subscription.listener);
  if (subscriptions.size === 0) {
    // Nothing left to deliver: free the browser's socket until a tab asks again.
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    closeSource();
    sseConn.reconnect = null;
  }
}

function open(client, streamId, channel) {
  close(client, streamId);
  // Counted before it joins, so a stream that grows the pool goes straight to its bucket of the new size.
  if (channel.kind === "session") sizePool(channel.sessionId);
  const subscription = {
    id: `s${nextSubscriptionId++}`,
    streamId,
    client,
    channel,
    state: CONNECTING,
    retryTimer: undefined,
    conn: sseConn,
    /** The Conn this stream is moving to (make-before-break), or null. */
    moving: null,
    /** The rebalance whose sample waits for this stream's move to settle (settleMove), or null. */
    rebalance: null,
    // The EventSource's: every frame's `id:` line is its emit time.
    listener: (event) => deliver(subscription, sseConn, event.data, event.lastEventId ? Number(event.lastEventId) : NaN),
  };
  subscriptions.set(subscription.id, subscription);
  client.streams.set(streamId, subscription);
  if (isWebSocketTransport(state.transport)) {
    join(subscription);
    return;
  }
  // Listen before subscribing: frames may arrive before the POST resolves.
  source?.addEventListener(subscription.id, subscription.listener);
  ensureSource();
  subscribe(subscription);
}

function close(client, streamId) {
  const subscription = client.streams.get(streamId);
  if (!subscription) return;
  const conn = subscription.conn;
  const wasConnected = connectionId;
  release(subscription);
  if (conn !== sseConn) {
    // A socket that closed with its last stream, or has no hello yet, holds nothing to drop.
    if (conn.connectionId) sendFrame(conn, { t: "unsub", id: subscription.id });
  } else if (wasConnected && connectionId === wasConnected) {
    requestServer({ unsubscribe: subscription.id }).catch(() => {});
  }
}

function dropClient(client) {
  for (const streamId of [...client.streams.keys()]) close(client, streamId);
}

/** The socket for a socketKeyFor key; dialed on first use. */
function connFor(key) {
  let conn = conns.get(key);
  if (!conn) {
    conn = {
      key,
      ws: null,
      serverId: null,
      connectionId: null,
      subs: new Set(),
      pending: new Map(),
      lastFrameAt: 0,
      dialedAt: 0,
      reconnectDelayMs: RECONNECT_MIN_MS,
      reconnectTimer: undefined,
      lingerTimer: undefined,
      retiring: false,
      clock: null,
      lastEventSampleAt: -Infinity,
      reconnect: null,
      largeFrames: [],
    };
    conns.set(key, conn);
    if (silenceTimer === undefined) silenceTimer = setInterval(checkSilence, SILENCE_CHECK_MS);
    dial(conn);
  }
  clearTimeout(conn.lingerTimer);
  conn.lingerTimer = undefined;
  return conn;
}

function join(subscription) {
  const conn = connFor(subscriptionKey(subscription));
  conn.subs.add(subscription);
  subscription.conn = conn;
  subscribe(subscription);
}

function leave(conn, subscription) {
  conn.subs.delete(subscription);
  idle(conn);
}

/** Whether a socket still carries a stream, has one moving onto it, or holds a command. */
function busy(conn) {
  if (conn.subs.size > 0 || conn.pending.size > 0) return true;
  for (const subscription of subscriptions.values()) if (subscription.moving === conn) return true;
  return false;
}

/**
 * Closes a socket left with nothing: at once when it is the general one (like the
 * EventSource) or the policy no longer produces its key, otherwise after the linger.
 */
function idle(conn) {
  if (busy(conn)) return;
  if (conn.retiring) {
    shut(conn);
  } else if (conn.key === "general" || !keyValid(conn.key)) {
    retire(conn);
  } else if (conn.lingerTimer === undefined) {
    conn.lingerTimer = setTimeout(() => retire(conn), SESSION_LINGER_MS);
  }
}

/** Done with this socket: forgotten now, closed once the commands sent on it are answered. */
function retire(conn) {
  conns.delete(conn.key);
  draining.add(conn);
  clearTimeout(conn.lingerTimer);
  clearTimeout(conn.reconnectTimer);
  conn.retiring = true;
  conn.subs.clear();
  // One waiting to be sent never left the browser, so the tab POSTs it; one waiting for a resend may have run.
  for (const command of conn.pending.values()) {
    if (!command.inFlight) settle(conn, command, command.attempts === 0 ? { cmd: command.n, http: true } : failure(command, TRANSPORT_LOST));
  }
  idle(conn);
}

function shut(conn) {
  draining.delete(conn);
  if (conns.size === 0 && draining.size === 0) {
    clearInterval(silenceTimer);
    silenceTimer = undefined;
  }
  const ws = conn.ws;
  conn.ws = null;
  conn.connectionId = null;
  ws?.close();
}

function dial(conn) {
  const ws = new WebSocket(new URL(EVENT_SOCKET_PATH, self.location.href).href.replace(/^http/, "ws"));
  conn.ws = ws;
  conn.dialedAt = conn.lastFrameAt = Date.now();
  // Events of a socket this Conn replaced (late frames, its close) are ignored.
  ws.onopen = () => {
    if (conn.ws === ws) clockPing(conn);
  };
  ws.onmessage = (event) => {
    if (conn.ws === ws) onSocketFrame(conn, event.data);
  };
  // `error` is always followed by `close`.
  ws.onclose = () => {
    if (conn.ws === ws) redial(conn, backoff(conn), "close");
  };
}

/** A failed socket's next delay: 1 s doubling to 30 s, reset by a hello. */
function backoff(conn) {
  const delay = conn.reconnectDelayMs;
  conn.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
  return delay;
}

/**
 * Gives up on the socket and dials again after `delay` ms (0: now); the next hello re-subscribes its streams and
 * resends its commands. `trigger`: the `reconnect` sample's (spec D6).
 */
function redial(conn, delay, trigger) {
  const ws = conn.ws;
  conn.ws = null;
  conn.connectionId = null;
  ws?.close(FORCED_RECONNECT_CODE);
  for (const command of conn.pending.values()) if (command.inFlight) lost(conn, command);
  if (conn.retiring) return;
  markConnecting(conn.subs);
  // A stream moving away switches to its new socket now: CONNECTING until that one opens it.
  for (const subscription of conn.subs) {
    if (!subscription.moving) continue;
    conn.subs.delete(subscription);
    subscription.conn = subscription.moving;
    subscription.moving = null;
    subscription.conn.subs.add(subscription);
  }
  // Nothing is in flight here now: a moved session's lost commands go again on its socket of now, the ones behind them follow.
  for (const session of strayCommandSessions(conn)) moveCommands(conn, session);
  // A lingering socket (or one left empty above) has nothing to come back for.
  if (!busy(conn)) {
    retire(conn);
    return;
  }
  dropped(conn, trigger);
  clearTimeout(conn.reconnectTimer);
  conn.reconnectTimer = undefined;
  if (delay === 0) {
    dial(conn);
    return;
  }
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = undefined;
    dial(conn);
  }, delay);
}

function sendFrame(conn, frame) {
  conn.ws.send(JSON.stringify(frame));
}

/** Server frames are "<name> <server ms>\n<json>": split at the first newline, the payload passed on unparsed. */
function onSocketFrame(conn, text) {
  const now = Date.now();
  conn.lastFrameAt = now;
  const space = text.indexOf(" ");
  const newline = text.indexOf("\n");
  const name = text.slice(0, space);
  const at = Number(text.slice(space + 1, newline));
  const data = text.slice(newline + 1);
  if (name === "ping") {
    // The server's heartbeat: answered with a clock ping (spec D5), whose pong is a clock sample.
    clockPing(conn);
    return;
  }
  if (name === MUX_CONTROL_EVENT || name === "ack" || name === "reply" || name === "pong") {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (name === MUX_CONTROL_EVENT) handleControl(frame, conn);
    else if (name === "pong") clockSample(conn, frame.c, at, now);
    else onCommandFrame(conn, name, at, frame, data.length);
    return;
  }
  const subscription = subscriptions.get(name);
  if (subscription?.conn === conn) deliver(subscription, conn, data, at);
}

// Agent commands (spec D5 "Commands", "Resend"): each rides its session's socket, keyed by the tab's request id.
// A session's unanswered commands are all on one socket, so they reach omp in the order the tab sent them.

function queueCommand(client, message) {
  const { n, req, body } = message;
  if (!isWebSocketTransport(state.transport)) {
    post(client, { cmd: n, http: true });
    return;
  }
  const command = {
    n,
    client,
    req,
    body,
    session: message.sessionId,
    frame: `{"t":"cmd","rid":${JSON.stringify(req)},"session":${JSON.stringify(message.sessionId)},"advisor":${message.advisor === true},"command":${body}}`,
    attempts: 0,
    inFlight: false,
    serverId: null,
    recvAt: null,
    behindBytes: 0,
    // The reply's socket key, and the bytes queued ahead of the last send (null: never sent).
    socket: socketKeyFor(message.sessionId),
    behindSameBytes: null,
    behindOtherBytes: null,
    deadline: undefined,
    ackTimer: undefined,
  };
  // UTF-8 bytes, as the route counts them; a body under a third of the limit cannot reach it.
  if (body.length * 3 > MAX_AGENT_COMMAND_REQUEST_BYTES && new Blob([body]).size > MAX_AGENT_COMMAND_REQUEST_BYTES) {
    post(client, reply(command, 413, { error: "Agent command is too large", code: "request_too_large" }));
    return;
  }
  sizePool(command.session);
  const conn = connForCommand(command.session);
  conn.pending.set(req, command);
  if (conn.connectionId) sendCommand(conn, command);
  else waitToSend(conn, command);
}

/** The socket holding the session's unanswered commands (a move must not let this one pass them), else the session's socket. */
function connForCommand(session) {
  for (const conn of conns.values()) for (const command of conn.pending.values()) if (command.session === session) return conn;
  return connFor(socketKeyFor(session));
}

/** Sessions with commands on `conn` whose socket is another one now. */
function strayCommandSessions(conn) {
  const sessions = new Set();
  for (const command of conn.pending.values()) if (socketKeyFor(command.session) !== conn.key) sessions.add(command.session);
  return sessions;
}

/** Moves a session's commands, none of them in flight, to its socket of now, in order; a lost one goes again under the resend rules. */
function moveCommands(conn, session) {
  for (const command of [...conn.pending.values()]) {
    if (command.session !== session) continue;
    conn.pending.delete(command.req);
    clearTimeout(command.deadline);
    // Per command: a settle below may start the target's linger, which connFor cancels.
    const target = connFor(socketKeyFor(session));
    target.pending.set(command.req, command);
    if (target.connectionId) sendIfSafe(target, command);
    else waitToSend(target, command);
  }
}

/** Not sent within SEND_DEADLINE_MS: unavailable if it never left the browser, lost if it was sent before. */
function waitToSend(conn, command) {
  command.socket = conn.key;
  command.deadline = setTimeout(() => {
    settle(conn, command, failure(command, command.attempts === 0 ? TRANSPORT_UNAVAILABLE : TRANSPORT_LOST));
  }, SEND_DEADLINE_MS);
}

function sendCommand(conn, command) {
  clearTimeout(command.deadline);
  // Commands sent before it and not yet acked, by session: their bytes go first even once they left the browser's buffer.
  let same = 0;
  let other = 0;
  for (const earlier of conn.pending.values()) {
    if (!earlier.inFlight || earlier.recvAt !== null) continue;
    if (earlier.session === command.session) same += earlier.body.length;
    else other += earlier.body.length;
  }
  const ahead = Math.max(conn.ws.bufferedAmount, same + other);
  command.attempts += 1;
  command.inFlight = true;
  command.serverId = conn.serverId;
  command.recvAt = null;
  command.socket = conn.key;
  command.behindBytes = conn.ws.bufferedAmount;
  // Spec D6 "Uplink": what of the buffer is another session's (or this one's) earlier commands.
  command.behindSameBytes = Math.min(same, command.behindBytes);
  command.behindOtherBytes = Math.min(other, command.behindBytes);
  conn.ws.send(command.frame);
  // No ack in time is a silent hang: the socket is dead even if it never closed.
  const timeout = ACK_TIMEOUT_MS + Math.ceil((ahead + command.body.length) / 32);
  command.ackTimer = setTimeout(() => {
    record({ metric: "hang", socket: conn.key, req: command.req, type: JSON.parse(command.body).type, via: "ws", bytes: command.body.length, waitedMs: timeout });
    redial(conn, backoff(conn), "hang");
  }, timeout);
}

/** Bytes of the commands on this socket that the server has not acked yet. */
function unackedBytes(conn) {
  let bytes = 0;
  for (const command of conn.pending.values()) if (command.inFlight && command.recvAt === null) bytes += command.body.length;
  return bytes;
}

/** After a hello: send what waits, a lost command only where it cannot run twice. */
function sendWaiting(conn) {
  for (const command of conn.pending.values()) if (!command.inFlight) sendIfSafe(conn, command);
}

/** A first send, or a resend to the server that dedupes its rid or of an idempotent command; anything else may have run: lost. */
function sendIfSafe(conn, command) {
  if (command.attempts === 0 || command.serverId === conn.serverId || idempotent(command)) sendCommand(conn, command);
  else settle(conn, command, failure(command, TRANSPORT_LOST));
}

function idempotent(command) {
  const type = JSON.parse(command.body).type;
  return typeof type === "string" && (type.startsWith("get_") || type === "predict_word");
}

/** Its socket dropped before the reply: resent at most once (redial moves it to the session's socket of now), never from a retiring socket. */
function lost(conn, command) {
  command.inFlight = false;
  clearTimeout(command.ackTimer);
  if (conn.retiring || command.attempts > 1) settle(conn, command, failure(command, TRANSPORT_LOST));
  else waitToSend(conn, command);
}

/** `bytes`: the frame's payload length, for a reply's downlink isolation. */
function onCommandFrame(conn, name, at, frame, bytes) {
  const command = conn.pending.get(frame.rid);
  if (!command) return;
  if (name === "ack") {
    clearTimeout(command.ackTimer);
    command.recvAt = at;
  } else {
    const behind = frameArrived(conn, command.session, bytes, at, Date.now());
    settle(conn, command, reply(command, frame.status, frame.body, at, frame.deduped === true, behind && behind.other));
  }
}

function reply(command, status, body, repliedAt = null, deduped = false, replyBehindOtherBytes = null) {
  return {
    cmd: command.n,
    status,
    body,
    recvAt: command.recvAt,
    repliedAt,
    attempts: command.attempts,
    deduped,
    behindBytes: command.behindBytes,
    socket: command.socket,
    behindSameBytes: command.behindSameBytes,
    behindOtherBytes: command.behindOtherBytes,
    replyBehindOtherBytes,
  };
}

function failure(command, body) {
  return reply(command, 503, body);
}

function settle(conn, command, message) {
  clearTimeout(command.deadline);
  clearTimeout(command.ackTimer);
  conn.pending.delete(command.req);
  post(command.client, message);
  idle(conn);
  sizePool();
}

/** Every socket: the current ones, then retired ones still waiting for replies (a dead one answers them transport_lost). */
function eachSocket(fn) {
  for (const conn of conns.values()) fn(conn);
  for (const conn of draining) fn(conn);
}

function checkSilence() {
  const now = Date.now();
  eachSocket((conn) => {
    if (conn.ws && now - conn.lastFrameAt >= WS_SILENCE_MS) redial(conn, backoff(conn), "silence");
  });
}

/**
 * A tab saw the network change or the page come back (SSE mode has no sockets: EventSource reconnects on its own).
 * Every wake but `hidden` and `init` may start a reconnect sample's outage (spec D6 `startAt`).
 */
function wake(reason) {
  const now = Date.now();
  const type = effectiveType();
  // Every tab forwards the same event: the first of a burst keeps the type from before it.
  if (reason !== "hidden" && reason !== "init" && !(lastWake && now - lastWake.at < WAKE_REDIAL_GAP_MS)) {
    lastWake = { at: now, effectiveType: knownEffectiveType ?? type };
  }
  knownEffectiveType = type;
  const justDialed = (conn) => conn.ws && !conn.connectionId && now - conn.dialedAt < WAKE_REDIAL_GAP_MS;
  if (reason === "online" || reason === "network") {
    eachSocket((conn) => {
      if (!justDialed(conn)) redial(conn, 0, reason);
    });
  } else if (reason === "visible") {
    for (const conn of conns.values()) {
      if (justDialed(conn)) continue;
      if (conn.reconnectTimer !== undefined) redial(conn, 0, reason);
      // A pong cannot overtake an upload still ahead of it: the ack timer watches such a socket.
      else if (conn.connectionId && unackedBytes(conn) === 0) probe(conn);
    }
  }
}

/** The server answers a clock ping at once: no frame within VISIBLE_PROBE_MS means the socket died while hidden. */
function probe(conn) {
  const ws = conn.ws;
  const sentAt = Date.now();
  sendFrame(conn, { t: "ping", c: sentAt });
  setTimeout(() => {
    if (conn.ws === ws && conn.lastFrameAt < sentAt) redial(conn, 0, "visible");
  }, VISIBLE_PROBE_MS);
}

function clockPing(conn) {
  sendFrame(conn, { t: "ping", c: Date.now() });
}

/** A clock sample (spec D6, NTP-style) from a ping sent at `c` and answered at the server's `at`; the lowest RTT wins. */
function clockSample(conn, c, at, now) {
  if (!Number.isFinite(c) || !Number.isFinite(at)) return;
  const sample = { offset: at - (c + now) / 2, rtt: now - c };
  if (!conn.clock || sample.rtt < conn.clock.rtt) conn.clock = sample;
  if (!bestClock || sample.rtt < bestClock.rtt) bestClock = sample;
}

/** After an SSE hello: SSE_CLOCK_PROBES reads of the server clock, one after another, while this EventSource lasts. */
async function probeSseClock(current) {
  for (let i = 0; i < SSE_CLOCK_PROBES && source === current; i++) {
    const c = Date.now();
    try {
      const response = await fetch(METRICS_PATH, { cache: "no-store" });
      const body = await response.json();
      clockSample(sseConn, c, body.now, Date.now());
    } catch {
      return;
    }
  }
}

/**
 * Logs a frame of LARGE_FRAME_BYTES or more and returns the bytes of the logged frames it arrived behind, by owner
 * (spec D6 "Cross-session blocking"): those written before it and still arriving when it was written. Null without a clock.
 */
function frameArrived(conn, owner, bytes, at, gotAt) {
  const clock = conn.clock ?? bestClock;
  const log = conn.largeFrames;
  while (log.length > 0 && gotAt - log[0].gotAt > LARGE_FRAME_LOG_MS) log.shift();
  if (!Number.isFinite(at)) return null;
  let behind = null;
  if (clock) {
    behind = { same: 0, other: 0 };
    for (const frame of log) {
      if (frame.at <= at && frame.gotAt + clock.offset > at) behind[frame.owner === owner ? "same" : "other"] += frame.bytes;
    }
  }
  if (bytes >= LARGE_FRAME_BYTES) log.push({ owner, bytes, at, gotAt });
  return behind;
}

/** A stream's frame from its connection: at most one event sample per connection per EVENT_SAMPLE_MS (one behind another session's frame always), then to the tab. */
function deliver(subscription, conn, data, at) {
  const { channel } = subscription;
  const gotAt = Date.now();
  const behind = frameArrived(conn, channel.kind === "session" ? channel.sessionId : "app", data.length, at, gotAt);
  endReconnect(conn, gotAt);
  if (behind && (behind.other > 0 || gotAt - conn.lastEventSampleAt >= EVENT_SAMPLE_MS)) {
    const clock = conn.clock ?? bestClock;
    conn.lastEventSampleAt = gotAt;
    record({
      metric: "event",
      socket: conn.key,
      channel: channel.kind,
      at,
      gotAt,
      offset: clock.offset,
      offsetRtt: clock.rtt,
      bytes: data.length,
      behindSameBytes: behind.same,
      behindOtherBytes: behind.other,
    });
  }
  post(subscription.client, { id: subscription.streamId, type: "message", data });
}

/** A connection dropped (spec D6 `reconnect`): its outage runs from the first drop until a stream gets a frame after the next hello. */
function dropped(conn, trigger) {
  if (conn.reconnect) return;
  const dropAt = Date.now();
  const woke = lastWake !== null && dropAt - lastWake.at <= WAKE_WINDOW_MS;
  conn.reconnect = { trigger, dropAt, startAt: woke ? lastWake.at : dropAt, effectiveTypeBefore: woke ? lastWake.effectiveType : effectiveType(), hello: false };
  // A drop is kept while an outage within BATCH_WINDOW_MS of it may still end and count it.
  let oldest = dropAt;
  eachSocket((other) => {
    if (other.reconnect) oldest = Math.min(oldest, other.reconnect.dropAt);
  });
  if (sseConn.reconnect) oldest = Math.min(oldest, sseConn.reconnect.dropAt);
  recentDrops = recentDrops.filter((at) => at >= oldest - BATCH_WINDOW_MS);
  recentDrops.push(dropAt);
}

/** The first open or stream frame after the hello: the reconnect sample, `batch` counting the drops within BATCH_WINDOW_MS of this one. */
function endReconnect(conn, now) {
  const reconnect = conn.reconnect;
  if (!reconnect?.hello) return;
  conn.reconnect = null;
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
  });
}

/** Whether a stream is on this connection or moving onto it. */
function carriesStream(conn) {
  for (const subscription of subscriptions.values()) if (subscription.conn === conn || subscription.moving === conn) return true;
  return false;
}

// Samples (spec D6): tagged here, buffered (METRICS_BUFFER_MAX, the oldest dropped and counted) and POSTed over HTTP in every mode.

function effectiveType() {
  return self.navigator.connection?.effectiveType ?? null;
}

/** The tags a sample lacks; an action sample (the tab's) also gets the worker's best clock. */
function stamp(sample) {
  const socket = sample.socket ?? "worker";
  let visible = false;
  for (const client of clients) visible = visible || client.visible === true;
  return {
    transport: state.transport,
    pool: state.transport === "ws-pool" ? poolSize : null,
    socket,
    conn: socket.split(":")[0],
    sockets: heldSockets(false) + (source ? 1 : 0),
    clientId,
    effectiveType: effectiveType(),
    visible,
    ...(sample.metric === "action" ? { offset: bestClock?.offset ?? null, offsetRtt: bestClock?.rtt ?? null } : {}),
    ...sample,
  };
}

function record(sample) {
  samples.push(stamp(sample));
  trimSamples();
  // Reaching the count flushes; a failed POST leaves more than that, which then waits for the timer instead of retrying per sample.
  if (samples.length === METRICS_FLUSH_COUNT) flushSamples();
  else scheduleFlush();
}

function trimSamples() {
  const over = samples.length - METRICS_BUFFER_MAX;
  if (over <= 0) return;
  samples.splice(0, over);
  droppedSamples += over;
}

function scheduleFlush() {
  if (flushTimer === undefined && samples.length > 0) flushTimer = setTimeout(flushSamples, METRICS_FLUSH_MS);
}

/** POSTs the oldest METRICS_FLUSH_COUNT samples (and a `dropped` count); a failure keeps them for the next flush. */
function flushSamples() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (flushing || samples.length === 0) return;
  const batch = samples.splice(0, METRICS_FLUSH_COUNT);
  const droppedCount = droppedSamples;
  droppedSamples = 0;
  flushing = true;
  fetch(METRICS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ samples: droppedCount > 0 ? batch.concat(stamp({ metric: "dropped", count: droppedCount })) : batch }),
  })
    .then((response) => response.ok, () => false)
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

function attach(port) {
  const client = { port, streams: new Map() };
  clients.add(client);
  // Tabs assume SSE until told otherwise.
  if (isWebSocketTransport(state.transport)) post(client, { transport: state.transport });
  port.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    switch (message.op) {
      case "open":
        open(client, message.id, message.channel);
        break;
      case "close":
        close(client, message.id);
        break;
      case "bye":
        dropClient(client);
        break;
      case "wake":
        client.visible = message.visible === true;
        if (typeof message.clientId === "string") clientId = message.clientId;
        wake(message.reason);
        break;
      case "metric":
        if (message.sample && typeof message.sample === "object") record(message.sample);
        break;
      case "cmd":
        queueCommand(client, message);
        break;
      case "lock":
        // MessagePort has no close event. The tab holds this lock for its
        // whole life; it is granted to us only once that tab is gone
        // (closed, crashed, discarded), however it died.
        self.navigator.locks?.request(message.name, () => {
          clients.delete(client);
          dropClient(client);
        });
        break;
    }
  };
}

if (typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope) {
  self.onconnect = (event) => attach(event.ports[0]);
} else {
  attach(self);
}
