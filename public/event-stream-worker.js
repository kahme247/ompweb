// omp-web live-event multiplexer.
//
// Runs as a SharedWorker (one per browser profile) — or a dedicated Worker
// where SharedWorker is unavailable — and holds the ONLY `/api/events`
// EventSource. Every tab's stream (lib/event-stream.ts) is a subscription on
// that one socket, so opening more tabs no longer consumes more of the
// browser's six HTTP/1.1 connections per host.
//
// Plain script, not bundled: mirrors lib/event-stream-protocol.ts.
//
// Tab -> worker:  { op: "open", id, channel } | { op: "close", id }
//                 { op: "lock", name }  (tab holds this Web Lock while alive)
//                 { op: "bye" }         (pagehide: drop this tab's streams)
// Worker -> tab:  { id, type: "open" }
//                 { id, type: "message", data }   (raw JSON string)
//                 { id, type: "error", readyState: 0 | 2 }  (EventSource semantics)
"use strict";

const EVENT_STREAM_PATH = "/api/events";
const MUX_CONTROL_EVENT = "mux";
const UNKNOWN_CONNECTION_CODE = "unknown_connection";
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
// Mirrors EventSource's own reconnect delay after a server-ended stream.
const RESUBSCRIBE_DELAY_MS = 3000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

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

/** The shared socket dropped: every live subscription is reconnecting. */
function markAllConnecting() {
  for (const subscription of subscriptions.values()) {
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
  markAllConnecting();
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
    markAllConnecting();
  };
}

function handleControl(frame) {
  if (frame.type === "hello") {
    connectionId = frame.connectionId;
    reconnectDelayMs = RECONNECT_MIN_MS;
    for (const subscription of subscriptions.values()) subscribe(subscription);
    return;
  }
  const subscription = subscriptions.get(frame.sub);
  if (!subscription) return;
  if (frame.type === "open") {
    subscription.state = OPEN;
    post(subscription.client, { id: subscription.streamId, type: "open" });
  } else if (frame.type === "end") {
    // The server ended this subscription (watcher died, unserializable
    // frame): reconnect it like EventSource would reconnect a closed stream.
    notifyError(subscription, CONNECTING);
    clearTimeout(subscription.retryTimer);
    subscription.retryTimer = setTimeout(() => subscribe(subscription), RESUBSCRIBE_DELAY_MS);
  }
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

function release(subscription) {
  clearTimeout(subscription.retryTimer);
  subscriptions.delete(subscription.id);
  subscription.client.streams.delete(subscription.streamId);
  source?.removeEventListener(subscription.id, subscription.listener);
  if (subscriptions.size === 0) {
    // Nothing left to deliver: free the browser's socket until a tab asks again.
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    closeSource();
  }
}

function open(client, streamId, channel) {
  close(client, streamId);
  const subscription = {
    id: `s${nextSubscriptionId++}`,
    streamId,
    client,
    channel,
    state: CONNECTING,
    retryTimer: undefined,
    listener: (event) => post(client, { id: streamId, type: "message", data: event.data }),
  };
  subscriptions.set(subscription.id, subscription);
  client.streams.set(streamId, subscription);
  // Listen before subscribing: frames may arrive before the POST resolves.
  source?.addEventListener(subscription.id, subscription.listener);
  ensureSource();
  subscribe(subscription);
}

function close(client, streamId) {
  const subscription = client.streams.get(streamId);
  if (!subscription) return;
  const wasConnected = connectionId;
  release(subscription);
  if (wasConnected && connectionId === wasConnected) {
    requestServer({ unsubscribe: subscription.id }).catch(() => {});
  }
}

function dropClient(client) {
  for (const streamId of [...client.streams.keys()]) close(client, streamId);
}

function attach(port) {
  const client = { port, streams: new Map() };
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
      case "lock":
        // MessagePort has no close event. The tab holds this lock for its
        // whole life; it is granted to us only once that tab is gone
        // (closed, crashed, discarded), however it died.
        self.navigator.locks?.request(message.name, () => dropClient(client));
        break;
    }
  };
}

if (typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope) {
  self.onconnect = (event) => attach(event.ports[0]);
} else {
  attach(self);
}
