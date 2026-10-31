import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "./image-attachments.ts";

// Runs the real public/event-stream-worker.js in a VM with fake browser
// globals: EventSource, WebSocket, fetch, Web Locks, and tab MessagePorts.
// Time (Date.now, setTimeout, setInterval) is the host's, so t.mock.timers drives it.
// `/api/transport-metrics` answers the SSE clock probe as a server `serverOffset` ms ahead and
// records every sample batch POSTed to it (`metricsStatus` its HTTP status).
const workerSource = readFileSync(new URL("../public/event-stream-worker.js", import.meta.url), "utf8");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadWorker({ respond = () => ({ status: 200, body: { ok: true } }), serverOffset = 0, metricsStatus = () => 200 } = {}) {
  const sources = [];
  const sockets = [];
  const posts = [];
  const probes = [];
  const flushes = [];
  const locks = new Map();

  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.listeners = new Map();
      this.closed = false;
      this.onerror = null;
      sources.push(this);
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
    }
    removeEventListener(name, fn) {
      this.listeners.get(name)?.delete(fn);
    }
    close() {
      this.closed = true;
      this.readyState = FakeEventSource.CLOSED;
    }
    dispatch(name, data, lastEventId = "") {
      for (const fn of this.listeners.get(name) ?? []) fn({ data: typeof data === "string" ? data : JSON.stringify(data), lastEventId });
    }
    hello(connectionId, transport, settings) {
      this.readyState = FakeEventSource.OPEN;
      this.dispatch("mux", { type: "hello", connectionId, ...(transport ? { transport } : {}), ...settings });
    }
    drop(readyState) {
      this.readyState = readyState;
      this.onerror?.();
    }
  }

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.bufferedAmount = 0;
      this.closeCode = null;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      sockets.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close(code = 1005) {
      if (this.readyState === 3) return;
      this.closeCode = code;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    frame(name, at, payload) {
      this.onmessage?.({ data: `${name} ${at}\n${JSON.stringify(payload)}` });
    }
    hello(connectionId, { serverId = "srv1", transport = "ws-session" } = {}) {
      this.frame("mux", Date.now(), { type: "hello", connectionId, serverId, transport });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.({ code: 1006 });
    }
  }

  class SharedWorkerGlobalScope {}
  const self = Object.create(SharedWorkerGlobalScope.prototype);
  self.navigator = {
    locks: {
      request(name, callback) {
        locks.set(name, callback);
        return Promise.resolve();
      },
    },
  };
  self.location = { href: "https://example.test/" };

  const context = vm.createContext({
    self,
    SharedWorkerGlobalScope,
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
    URL,
    Blob,
    Date: { now: () => Date.now() },
    JSON,
    Map,
    Math,
    Promise,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (id) => clearInterval(id),
    fetch: async (url, init) => {
      if (url === "/api/transport-metrics") {
        if (init?.method !== "POST") {
          probes.push(Date.now());
          return { ok: true, status: 200, json: async () => ({ now: Date.now() + serverOffset }) };
        }
        flushes.push(JSON.parse(init.body).samples);
        const status = metricsStatus();
        return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
      }
      const body = JSON.parse(init.body);
      posts.push(body);
      const { status, body: responseBody } = respond(body);
      return { ok: status >= 200 && status < 300, status, json: async () => responseBody };
    },
  });
  vm.runInContext(workerSource, context);

  function connectTab() {
    const received = [];
    const port = {
      onmessage: null,
      postMessage: (message) => received.push(structuredClone(message)),
    };
    self.onconnect({ ports: [port] });
    return {
      received,
      send: (message) => port.onmessage({ data: message }),
      open: (id, channel) => port.onmessage({ data: { op: "open", id, channel } }),
      close: (id) => port.onmessage({ data: { op: "close", id } }),
    };
  }

  return {
    // Top-level `function` declarations are its properties; `let` bindings need vm.runInContext.
    context,
    sources,
    sockets,
    posts,
    probes,
    flushes,
    connectTab,
    get source() {
      return sources.at(-1);
    },
    releaseLock: (name) => locks.get(name)?.(),
  };
}

const running = { kind: "running" };
const session = (sessionId) => ({ kind: "session", sessionId });
const subscribedIds = (posts, connectionId) =>
  posts.filter((post) => post.connectionId === connectionId && post.subscribe).map((post) => post.subscribe.id);

// Instrumentation (spec D6): the worker buffers samples until a flush POSTs them.

/** The samples of `metric` recorded and not flushed yet, oldest first (copied out of the context). */
const recorded = (worker, metric) =>
  Array.from(vm.runInContext("samples", worker.context), (sample) => ({ ...sample })).filter((sample) => sample.metric === metric);
const pick = (sample, keys) => Object.fromEntries(keys.map((key) => [key, sample[key]]));
const lastPing = (socket) => socket.sent.filter((frame) => frame.t === "ping").at(-1);

/** Answers the socket's latest clock ping now, as a server `offset` ms ahead with the RTT split evenly. */
function pong(socket, offset) {
  const { c } = lastPing(socket);
  socket.frame("pong", (c + Date.now()) / 2 + offset, { c });
}

/** A frame payload whose JSON is exactly `length` characters. */
function payload(length) {
  const body = { x: "" };
  body.x = "x".repeat(length - JSON.stringify(body).length);
  return body;
}

test("every tab's streams share one EventSource and frames reach only their own stream", async () => {
  const worker = loadWorker();
  const tabA = worker.connectTab();
  const tabB = worker.connectTab();
  tabA.open(1, running);
  tabB.open(1, running);
  tabB.open(2, session("abc"));
  assert.equal(worker.sources.length, 1, "one socket regardless of tabs and streams");
  assert.equal(worker.posts.length, 0, "subscriptions wait for the connection id");

  worker.source.hello("c1");
  await flush();
  const [subA, subB1, subB2] = subscribedIds(worker.posts, "c1");
  assert.deepEqual(worker.posts.find((post) => post.subscribe?.id === subB2).subscribe.channel, session("abc"));

  for (const sub of [subA, subB1, subB2]) worker.source.dispatch("mux", { type: "open", sub });
  worker.source.dispatch(subB2, "{\"type\":\"connected\"}");
  worker.source.dispatch(subA, "{\"type\":\"running\"}");

  assert.deepEqual(tabA.received, [{ id: 1, type: "open" }, { id: 1, type: "message", data: "{\"type\":\"running\"}" }]);
  assert.deepEqual(tabB.received, [
    { id: 1, type: "open" },
    { id: 2, type: "open" },
    { id: 2, type: "message", data: "{\"type\":\"connected\"}" },
  ]);
});

test("a refused subscription fails only its own stream as CLOSED", async () => {
  const worker = loadWorker({
    respond: (body) => body.subscribe?.channel.kind === "session"
      ? { status: 409, body: { error: "Session is not managed by omp-web", code: "session_not_managed" } }
      : { status: 200, body: { ok: true } },
  });
  const tab = worker.connectTab();
  tab.open(1, running);
  tab.open(2, session("file-only"));
  worker.source.hello("c1");
  await flush();
  await flush();
  assert.deepEqual(tab.received, [{ id: 2, type: "error", readyState: 2 }]);

  const [runningSub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub: runningSub });
  assert.deepEqual(tab.received.at(-1), { id: 1, type: "open" });
  assert.equal(worker.source.closed, false);
});

test("a dropped socket reports CONNECTING and the next hello re-subscribes every stream", async () => {
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, running);
  tab.open(2, session("abc"));
  worker.source.hello("c1");
  await flush();
  for (const sub of subscribedIds(worker.posts, "c1")) worker.source.dispatch("mux", { type: "open", sub });
  tab.received.length = 0;

  worker.source.drop(0); // EventSource auto-reconnects
  assert.deepEqual(tab.received, [
    { id: 1, type: "error", readyState: 0 },
    { id: 2, type: "error", readyState: 0 },
  ]);

  worker.source.hello("c2");
  await flush();
  const resubscribed = subscribedIds(worker.posts, "c2");
  assert.equal(resubscribed.length, 2, "both streams re-subscribe on the new connection");
  for (const sub of resubscribed) worker.source.dispatch("mux", { type: "open", sub });
  assert.deepEqual(tab.received.slice(2), [{ id: 1, type: "open" }, { id: 2, type: "open" }]);
  assert.equal(worker.sources.length, 1, "a recoverable drop reuses EventSource's own reconnect");
});

test("a server restart between hello and subscribe reconnects with a fresh socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let restarted = true;
  const worker = loadWorker({
    respond: () => restarted
      ? { status: 404, body: { error: "Unknown event stream connection", code: "unknown_connection" } }
      : { status: 200, body: { ok: true } },
  });
  const tab = worker.connectTab();
  tab.open(1, running);
  const first = worker.source;
  first.hello("stale");
  await flush();
  await flush();
  assert.equal(first.closed, true);

  restarted = false;
  t.mock.timers.tick(1000);
  assert.equal(worker.sources.length, 2);
  worker.source.hello("fresh");
  await flush();
  assert.equal(subscribedIds(worker.posts, "fresh").length, 1);
});

test("a server-ended subscription reconnects after the EventSource retry delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, { kind: "file", path: "/w/notes.txt", sessionId: null });
  worker.source.hello("c1");
  await flush();
  const [sub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub });
  worker.source.dispatch("mux", { type: "end", sub });
  assert.deepEqual(tab.received.at(-1), { id: 1, type: "error", readyState: 0 });

  t.mock.timers.tick(2999);
  assert.equal(subscribedIds(worker.posts, "c1").length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(subscribedIds(worker.posts, "c1"), [sub, sub]);
});

test("a dead tab's subscriptions are released and the last stream frees the socket", async () => {
  const worker = loadWorker();
  const tabA = worker.connectTab();
  const tabB = worker.connectTab();
  tabA.send({ op: "lock", name: "tab-a" });
  tabA.open(1, running);
  tabB.open(1, running);
  worker.source.hello("c1");
  await flush();
  const [subA, subB] = subscribedIds(worker.posts, "c1");

  worker.releaseLock("tab-a"); // tab A crashed or was closed
  await flush();
  assert.deepEqual(worker.posts.filter((post) => post.unsubscribe).map((post) => post.unsubscribe), [subA]);
  worker.source.dispatch(subA, "{}");
  assert.deepEqual(tabA.received, [], "a dead tab receives nothing");
  assert.equal(worker.source.closed, false, "the surviving tab keeps the socket");

  tabB.send({ op: "bye" });
  assert.equal(worker.source.closed, true, "no subscriptions left: the socket is released");
  worker.source.dispatch(subB, "{}");
  assert.deepEqual(tabB.received, []);

  tabB.open(2, running);
  assert.equal(worker.sources.length, 2, "a later stream reopens the socket on demand");
});

// WebSocket mode (docs/specs/2026-10-31-browser-transport-experiment-design.md D2, D5).

const TIMERS = { apis: ["setTimeout", "setInterval", "Date"] };

/** One tab opens these streams; the SSE hello then says the setting is `transport` (plus `settings`, e.g. the pool's). */
function webSocketMode(worker, channels, transport = "ws-session", settings) {
  const tab = worker.connectTab();
  channels.forEach((channel, index) => tab.open(index + 1, channel));
  worker.source.hello("c0", transport, settings);
  return tab;
}

function connect(socket, connectionId, options) {
  socket.open();
  socket.hello(connectionId, options);
}

const subs = (socket) => socket.sent.filter((frame) => frame.t === "sub");

function openAll(socket) {
  for (const { id } of subs(socket)) socket.frame("mux", Date.now(), { type: "open", sub: id });
}

/** Advances time with the server's 10 s ping on every open socket, so only a socket that really goes quiet trips the silence check. */
function advance(t, worker, ms) {
  for (let left = ms; left > 0; left -= 10_000) {
    t.mock.timers.tick(Math.min(left, 10_000));
    for (const socket of worker.sockets) if (socket.readyState === 1) socket.frame("ping", Date.now(), {});
  }
}

test("ws-session keeps a general socket and one per session", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const file = { kind: "file", path: "/w/notes.txt", sessionId: "a" };
  const tab = webSocketMode(worker, [running, file, session("a"), session("b")]);

  assert.equal(worker.source.closed, true);
  assert.deepEqual(worker.posts, [], "nothing subscribes over SSE");
  assert.deepEqual(worker.sockets.map((socket) => socket.url), Array(3).fill("wss://example.test/api/events/ws"));
  const [general, a, b] = worker.sockets;
  assert.deepEqual(general.sent, [], "subscriptions wait for the socket's hello");
  worker.sockets.forEach((socket, index) => connect(socket, `w${index}`));
  assert.deepEqual(subs(general).map((frame) => frame.channel), [running, file]);
  assert.deepEqual(subs(a).map((frame) => frame.channel), [session("a")]);
  assert.deepEqual(subs(b).map((frame) => frame.channel), [session("b")]);

  for (const socket of worker.sockets) openAll(socket);
  b.frame(subs(b)[0].id, Date.now(), { type: "connected" });
  assert.deepEqual(tab.received, [
    { transport: "ws-session" },
    { id: 1, type: "open" },
    { id: 2, type: "open" },
    { id: 3, type: "open" },
    { id: 4, type: "open" },
    { id: 4, type: "message", data: "{\"type\":\"connected\"}" },
  ]);
  assert.deepEqual(worker.sockets.map((socket) => socket.closeCode), [null, null, null], "each socket's hello repeats the mode and tears nothing down");
  assert.equal(worker.sources.length, 1);
  assert.deepEqual(worker.connectTab().received, [{ transport: "ws-session" }], "a tab attaching later learns the mode");
});

test("a transport control switches back: sockets close and one EventSource resubscribes everything", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a")]);
  const [general, a] = worker.sockets;
  connect(general, "w1");
  connect(a, "w2");
  openAll(general);
  openAll(a);
  const socketSubs = [...subs(general), ...subs(a)].map((frame) => frame.id);
  tab.received.length = 0;

  general.frame("mux", Date.now(), { type: "transport", transport: "sse" });
  assert.notEqual(general.closeCode, null);
  assert.notEqual(a.closeCode, null);
  assert.deepEqual(tab.received, [
    { transport: "sse" },
    { id: 1, type: "error", readyState: 0 },
    { id: 2, type: "error", readyState: 0 },
  ]);
  assert.equal(worker.sources.length, 2, "one new EventSource");

  worker.source.hello("c1", "sse");
  await flush();
  const resubscribed = subscribedIds(worker.posts, "c1");
  assert.deepEqual(resubscribed, socketSubs, "every stream, once");
  for (const sub of resubscribed) worker.source.dispatch("mux", { type: "open", sub });
  a.frame(socketSubs[1], Date.now(), { type: "late" });
  a.drop();
  worker.source.dispatch("mux", { type: "transport", transport: "sse" });
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "client-1" });
  assert.deepEqual(tab.received.slice(3), [{ id: 1, type: "open" }, { id: 2, type: "open" }]);
  assert.equal(worker.source.closed, false, "the same mode again and a wake leave SSE alone");
  assert.equal(worker.sources.length, 2);
  assert.equal(worker.sockets.length, 2);
});

test("a session socket lingers 30 s after its last stream, and a stream within the linger reuses it", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a")]);
  const [general, a] = worker.sockets;
  connect(general, "w1");
  connect(a, "w2");
  const [first] = subs(a);

  tab.close(2);
  assert.deepEqual(a.sent.at(-1), { t: "unsub", id: first.id });
  advance(t, worker, 29_000);
  tab.open(3, session("a"));
  assert.equal(worker.sockets.length, 2, "the lingering socket is reused");
  assert.equal(subs(a).length, 2);
  assert.deepEqual(subs(a).at(-1).channel, session("a"));

  tab.close(3);
  advance(t, worker, 29_999);
  assert.equal(a.closeCode, null);
  advance(t, worker, 1);
  assert.notEqual(a.closeCode, null, "closed 30 s after its last stream");

  assert.equal(general.closeCode, null);
  tab.close(1);
  assert.notEqual(general.closeCode, null, "the general socket closes with its last stream");
  assert.equal(worker.sockets.length, 2);
});

test("25 s of silence reconnects with backoff and resubscribes on the next hello; frames from the old socket are ignored", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running]);
  const [first] = worker.sockets;
  connect(first, "w1");
  const [{ id }] = subs(first);
  first.frame("mux", Date.now(), { type: "open", sub: id });
  tab.received.length = 0;

  t.mock.timers.tick(24_999);
  assert.equal(first.closeCode, null);
  t.mock.timers.tick(1);
  assert.equal(first.closeCode, 4000);
  assert.deepEqual(tab.received, [{ id: 1, type: "error", readyState: 0 }]);

  t.mock.timers.tick(999);
  assert.equal(worker.sockets.length, 1, "1 s backoff");
  t.mock.timers.tick(1);
  const [, second] = worker.sockets;
  second.drop();
  t.mock.timers.tick(1_999);
  assert.equal(worker.sockets.length, 2, "a failed dial doubles the backoff");
  t.mock.timers.tick(1);
  const [, , third] = worker.sockets;
  connect(third, "w3");
  assert.deepEqual(subs(third), [{ t: "sub", id, channel: running }]);

  first.frame(id, Date.now(), { type: "stale" });
  first.frame("mux", Date.now(), { type: "open", sub: id });
  first.drop();
  assert.deepEqual(tab.received.slice(1), [], "the replaced socket is ignored");
  third.frame("mux", Date.now(), { type: "open", sub: id });
  assert.deepEqual(tab.received.slice(1), [{ id: 1, type: "open" }]);

  third.drop();
  t.mock.timers.tick(1_000);
  assert.equal(worker.sockets.length, 4, "the hello reset the backoff");
});

test("wake online redials every socket at once; wake visible probes and redials only a socket silent for 3 s", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a"), session("b")]);
  worker.sockets.forEach((socket, index) => connect(socket, `w${index}`));
  const wake = (reason) => tab.send({ op: "wake", reason, visible: true, clientId: "client-1" });
  const urls = worker.sockets.map((socket) => socket.url);

  wake("online");
  assert.deepEqual(worker.sockets.slice(0, 3).map((socket) => socket.closeCode), [4000, 4000, 4000]);
  const redialed = worker.sockets.slice(3);
  assert.deepEqual(redialed.map((socket) => socket.url), urls, "all three at once, no backoff");
  redialed.forEach((socket, index) => connect(socket, `x${index}`));
  assert.deepEqual(redialed.map((socket) => subs(socket).map((frame) => frame.channel)), [[running], [session("a")], [session("b")]]);

  t.mock.timers.tick(1_000);
  const [general, a, b] = redialed;
  wake("visible");
  for (const socket of redialed) assert.deepEqual(socket.sent.at(-1), { t: "ping", c: Date.now() });
  general.frame("pong", Date.now(), { c: Date.now() });
  a.frame("pong", Date.now(), { c: Date.now() });
  t.mock.timers.tick(2_999);
  assert.equal(b.closeCode, null);
  t.mock.timers.tick(1);
  assert.deepEqual(redialed.map((socket) => socket.closeCode), [null, null, 4000]);
  assert.equal(worker.sockets.length, 7);
  assert.equal(worker.sockets.at(-1).url, urls[2]);

  worker.sockets.at(-1).drop();
  wake("visible");
  assert.equal(worker.sockets.length, 8, "a socket waiting in backoff dials now");
  wake("hidden");
  assert.equal(worker.sockets.length, 8);
  connect(worker.sockets.at(-1), "y");
  wake("network");
  assert.equal(worker.sockets.length, 11);
});

test("a wake from every tab redials each socket once; a dial still without a hello after 1 s is redialed", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tabs = [webSocketMode(worker, [running, session("a")]), worker.connectTab(), worker.connectTab()];
  worker.sockets.forEach((socket, index) => connect(socket, `w${index}`));
  const wakeAll = (reason) => {
    for (const tab of tabs) tab.send({ op: "wake", reason, visible: true, clientId: "client-1" });
  };

  wakeAll("online");
  assert.equal(worker.sockets.length, 4, "one new dial per socket, not one per tab");
  t.mock.timers.tick(999);
  wakeAll("network");
  assert.equal(worker.sockets.length, 4);
  t.mock.timers.tick(1);
  wakeAll("network");
  assert.equal(worker.sockets.length, 6);
});

test("refused fails only its stream as CLOSED", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("file-only")]);
  const [general, sessionSocket] = worker.sockets;
  connect(general, "w1");
  connect(sessionSocket, "w2");
  const [{ id: refused }] = subs(sessionSocket);

  sessionSocket.frame("mux", Date.now(), { type: "refused", sub: refused, status: 409, error: "Session is not managed by omp-web", code: "session_not_managed" });
  sessionSocket.frame(refused, Date.now(), {});
  openAll(general);
  assert.deepEqual(tab.received.slice(1), [{ id: 2, type: "error", readyState: 2 }, { id: 1, type: "open" }]);
  assert.equal(general.closeCode, null);
});

test("end resubscribes after 3 s on the same socket", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [{ kind: "file", path: "/w/notes.txt", sessionId: null }]);
  const [general] = worker.sockets;
  connect(general, "w1");
  const [{ id }] = subs(general);
  general.frame("mux", Date.now(), { type: "open", sub: id });
  general.frame("mux", Date.now(), { type: "end", sub: id });
  assert.deepEqual(tab.received.at(-1), { id: 1, type: "error", readyState: 0 });

  t.mock.timers.tick(2_999);
  assert.equal(subs(general).length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(subs(general).map((frame) => frame.id), [id, id]);
  assert.equal(worker.sockets.length, 1);
});

// Agent commands over the session socket (spec D5 "Commands", "Resend").

/** A tab's command as lib/event-stream.ts posts it; `req` defaults to `r<n>`. */
function command(tab, n, sessionId, body, { req = `r${n}`, advisor = false } = {}) {
  tab.send({ op: "cmd", n, req, sessionId, advisor, body: JSON.stringify(body) });
}

/** A command whose JSON is exactly `length` characters. */
function sized(type, length) {
  const body = { type, message: "" };
  body.message = "x".repeat(length - JSON.stringify(body).length);
  return body;
}

const commands = (socket) => socket.sent.filter((frame) => frame.t === "cmd");
const answers = (tab) => tab.received.filter((message) => "cmd" in message);
const OK = { success: true, data: { ok: 1 } };

test("a command opens its session socket, is sent after hello, and the reply reaches the tab", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running]);
  connect(worker.sockets[0], "w0");

  command(tab, 7, "a", { type: "get_state" }, { advisor: true });
  assert.equal(worker.sockets.length, 2);
  const [general, a] = worker.sockets;
  assert.equal(a.url, "wss://example.test/api/events/ws");
  a.open();
  assert.deepEqual(a.sent, [{ t: "ping", c: Date.now() }], "the command waits for the hello; the open sent a clock ping");
  a.hello("w1");
  assert.deepEqual(a.sent, [{ t: "ping", c: Date.now() }, { t: "cmd", rid: "r7", session: "a", advisor: true, command: { type: "get_state" } }]);
  assert.deepEqual(commands(general), []);

  a.frame("ack", 1_000, { rid: "r7" });
  advance(t, worker, 40_000);
  assert.equal(a.closeCode, null, "open while the command is unanswered, with no stream on it");
  a.frame("reply", 1_005, { rid: "r7", status: 200, body: OK });
  assert.deepEqual(answers(tab), [{
    cmd: 7, status: 200, body: OK, recvAt: 1_000, repliedAt: 1_005, attempts: 1, deduped: false, behindBytes: 0,
    socket: "session:a", behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: null,
  }]);

  advance(t, worker, 29_999);
  assert.equal(a.closeCode, null);
  advance(t, worker, 1);
  assert.notEqual(a.closeCode, null, "the linger starts with the reply");
});

test("a command frame names its session", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [socket] = worker.sockets;
  connect(socket, "w1");
  command(tab, 1, "a", { type: "compact" });
  assert.deepEqual(commands(socket), [{ t: "cmd", rid: "r1", session: "a", advisor: false, command: { type: "compact" } }]);
});

test("a missed ack is a hang: the socket redials and the command is resent once with the same rid", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [first] = worker.sockets;
  connect(first, "w1");

  command(tab, 1, "a", sized("prompt", 3_200));
  assert.equal(commands(first).length, 1);
  advance(t, worker, 10_099);
  assert.equal(first.closeCode, null);
  advance(t, worker, 1);
  assert.equal(first.closeCode, 4000, "10 000 + 3 200 / 32 ms without an ack");
  assert.deepEqual(recorded(worker, "hang").map((sample) => pick(sample, ["socket", "conn", "req", "type", "via", "bytes", "waitedMs"])), [
    { socket: "session:a", conn: "session", req: "r1", type: "prompt", via: "ws", bytes: 3_200, waitedMs: 10_100 },
  ]);

  t.mock.timers.tick(1_000);
  const [, second] = worker.sockets;
  connect(second, "w2");
  assert.deepEqual(commands(second).map((frame) => frame.rid), ["r1"]);
  second.frame("ack", 12_000, { rid: "r1" });
  second.frame("reply", 12_001, { rid: "r1", status: 200, body: OK, deduped: true });
  assert.deepEqual(answers(tab), [{
    cmd: 1, status: 200, body: OK, recvAt: 12_000, repliedAt: 12_001, attempts: 2, deduped: true, behindBytes: 0,
    socket: "session:a", behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: null,
  }]);
  assert.equal(commands(first).length + commands(second).length, 2, "sent once, resent once");
});

test("after a drop, non-idempotent commands are resent only to the same serverId", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  connect(worker.sockets[0], "w0", { serverId: "srv1" });
  /** Drops the current socket and connects its redial under `serverId`. */
  const restart = (serverId) => {
    worker.sockets.at(-1).drop();
    t.mock.timers.tick(1_000);
    connect(worker.sockets.at(-1), "w", { serverId });
    return worker.sockets.at(-1);
  };
  const lost = (cmd, attempts) => ({
    cmd,
    status: 503,
    body: { error: "The connection to omp-web dropped before the answer arrived; the command may have run.", code: "transport_lost" },
    recvAt: null,
    repliedAt: null,
    attempts,
    deduped: false,
    behindBytes: 0,
    socket: "session:a",
    behindSameBytes: 0,
    behindOtherBytes: 0,
    replyBehindOtherBytes: null,
  });

  command(tab, 1, "a", { type: "prompt", message: "hi" });
  let socket = restart("srv2");
  assert.deepEqual(commands(socket), [], "another server never saw its rid");
  assert.deepEqual(answers(tab), [lost(1, 1)]);

  command(tab, 2, "a", { type: "get_state" });
  socket = restart("srv3");
  assert.deepEqual(commands(socket).map((frame) => frame.rid), ["r2"], "idempotent: resent anywhere");
  socket.frame("reply", 5, { rid: "r2", status: 200, body: OK });
  assert.equal(answers(tab)[1].attempts, 2);

  command(tab, 3, "a", { type: "prompt", message: "again" });
  socket = restart("srv3");
  assert.deepEqual(commands(socket).map((frame) => frame.rid), ["r3"], "the same server dedupes its rid");
  socket = restart("srv3");
  assert.deepEqual(commands(socket), [], "at most one resend");
  assert.deepEqual(answers(tab).slice(2), [lost(3, 2)]);
});

test("a command not sent within 15 s answers transport_unavailable; an oversize one answers 413 locally", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("b")]);
  const [b] = worker.sockets;
  connect(b, "w1");

  command(tab, 1, "a", { type: "get_state" });
  assert.equal(worker.sockets.length, 2, "its session socket dials and never opens");
  advance(t, worker, 14_999);
  assert.deepEqual(answers(tab), []);
  advance(t, worker, 1);
  assert.deepEqual(answers(tab), [{
    cmd: 1,
    status: 503,
    body: { error: "Not sent: no connection to omp-web.", code: "transport_unavailable" },
    recvAt: null,
    repliedAt: null,
    attempts: 0,
    deduped: false,
    behindBytes: 0,
    socket: "session:a",
    behindSameBytes: null,
    behindOtherBytes: null,
    replyBehindOtherBytes: null,
  }]);

  command(tab, 2, "b", { type: "prompt", message: "hi" });
  b.drop();
  advance(t, worker, 14_999);
  assert.equal(answers(tab).length, 1, "a lost command waits for the next socket");
  advance(t, worker, 1);
  assert.deepEqual(answers(tab)[1].body.code, "transport_lost", "and is lost when none comes within 15 s");

  const sockets = worker.sockets.length;
  command(tab, 3, "c", sized("prompt", MAX_AGENT_COMMAND_REQUEST_BYTES + 1));
  // Multibyte characters: under the limit in characters, over it in UTF-8 bytes like the route counts.
  command(tab, 4, "c", { type: "prompt", message: "é".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES / 2) });
  const tooLarge = {
    status: 413, body: { error: "Agent command is too large", code: "request_too_large" }, recvAt: null, repliedAt: null, attempts: 0, deduped: false, behindBytes: 0,
    socket: "session:c", behindSameBytes: null, behindOtherBytes: null, replyBehindOtherBytes: null,
  };
  assert.deepEqual(answers(tab).slice(2), [{ cmd: 3, ...tooLarge }, { cmd: 4, ...tooLarge }]);
  assert.equal(worker.sockets.length, sockets, "no socket for a command the route would refuse");
});

test("an abort behind a large prompt waits on the same socket, is sent once, and reports behindBytes", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");

  command(tab, 1, "a", sized("prompt", 8_000_000));
  a.bufferedAmount = 8_000_000;
  command(tab, 2, "a", { type: "abort" });
  assert.deepEqual(commands(a).map((frame) => frame.rid), ["r1", "r2"], "both on the session's one socket");

  advance(t, worker, 259_999);
  assert.equal(a.closeCode, null, "10 000 + 8 000 000 / 32 ms: a slow upload is not a hang, for the prompt or the abort behind it");
  a.bufferedAmount = 0;
  a.frame("ack", 259_000, { rid: "r1" });
  a.frame("ack", 259_001, { rid: "r2" });
  a.frame("reply", 259_002, { rid: "r2", status: 200, body: OK });
  assert.deepEqual(answers(tab), [{
    cmd: 2, status: 200, body: OK, recvAt: 259_001, repliedAt: 259_002, attempts: 1, deduped: false, behindBytes: 8_000_000,
    socket: "session:a", behindSameBytes: 8_000_000, behindOtherBytes: 0, replyBehindOtherBytes: null,
  }]);
  assert.equal(commands(a).length, 2, "the abort was sent once");
  assert.equal(worker.sockets.length, 1);
});

test("in SSE mode a cmd answers http: true", () => {
  const worker = loadWorker();
  const tab = worker.connectTab();
  command(tab, 1, "a", { type: "get_state" });
  assert.deepEqual(tab.received, [{ cmd: 1, http: true }]);
  assert.equal(worker.sockets.length, 0);
});

test("switching to SSE keeps a socket until its pending command settles, then closes it", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a")]);
  const [general, a] = worker.sockets;
  connect(general, "w0");
  connect(a, "w1");
  command(tab, 1, "a", { type: "prompt", message: "hi" });
  a.frame("ack", 10, { rid: "r1" });
  command(tab, 2, "c", { type: "compact" });
  const c = worker.sockets[2];
  connect(c, "w2");
  c.frame("ack", 12, { rid: "r2" });
  command(tab, 3, "b", { type: "get_state" });
  const b = worker.sockets[3];
  b.open();

  general.frame("mux", Date.now(), { type: "transport", transport: "sse" });
  assert.notEqual(general.closeCode, null);
  assert.notEqual(b.closeCode, null);
  assert.deepEqual(answers(tab), [{ cmd: 3, http: true }], "a command still waiting for its hello never left: it goes over HTTP");
  assert.equal(a.closeCode, null, "a socket with a command in flight stays open");
  assert.equal(c.closeCode, null);
  command(tab, 4, "a", { type: "get_state" });
  assert.deepEqual(answers(tab).at(-1), { cmd: 4, http: true }, "it takes no new commands");
  assert.equal(commands(a).length, 1);

  advance(t, worker, 60_000);
  a.frame("reply", 11, { rid: "r1", status: 200, body: OK });
  assert.deepEqual(answers(tab).at(-1), {
    cmd: 1, status: 200, body: OK, recvAt: 10, repliedAt: 11, attempts: 1, deduped: false, behindBytes: 0,
    socket: "session:a", behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: null,
  });
  assert.notEqual(a.closeCode, null, "closed once its last command settled");

  c.drop();
  assert.equal(answers(tab).at(-1).body.code, "transport_lost", "one that drops meanwhile is lost");
  t.mock.timers.tick(60_000);
  assert.equal(worker.sockets.length, 4, "a retired socket never redials");
});

test("a retiring socket with a command in flight is still checked: silence or a network change answers transport_lost", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a"), session("c")]);
  const [general, a, c] = worker.sockets;
  connect(general, "w0");
  connect(a, "w1");
  connect(c, "w2");
  command(tab, 1, "a", { type: "compact" });
  a.frame("ack", Date.now(), { rid: "r1" });
  command(tab, 2, "c", { type: "bash", command: "sleep 60" });
  c.frame("ack", Date.now(), { rid: "r2" });

  general.frame("mux", Date.now(), { type: "transport", transport: "sse" });
  assert.deepEqual([a.closeCode, c.closeCode], [null, null], "both wait for their replies");
  t.mock.timers.tick(10_000);
  c.frame("ping", Date.now(), {});
  t.mock.timers.tick(10_000);
  c.frame("ping", Date.now(), {});
  t.mock.timers.tick(4_999);
  assert.deepEqual(answers(tab), []);
  t.mock.timers.tick(1);
  assert.equal(a.closeCode, 4000, "25 s without a frame");
  assert.equal(c.closeCode, null);
  assert.deepEqual(answers(tab).map((answer) => [answer.cmd, answer.status, answer.body.code]), [[1, 503, "transport_lost"]]);

  tab.send({ op: "wake", reason: "online", visible: true, clientId: "client-1" });
  assert.equal(c.closeCode, 4000);
  assert.deepEqual(answers(tab).map((answer) => [answer.cmd, answer.body.code]), [[1, "transport_lost"], [2, "transport_lost"]]);
  t.mock.timers.tick(60_000);
  assert.equal(worker.sockets.length, 3, "neither redials");
});

test("a visible wake does not probe a socket still uploading an unacked command; the ack timer covers it", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");
  const visible = () => tab.send({ op: "wake", reason: "visible", visible: true, clientId: "client-1" });

  command(tab, 1, "a", sized("prompt", 8_000_000));
  a.bufferedAmount = 8_000_000;
  t.mock.timers.tick(5_000);
  visible();
  t.mock.timers.tick(3_000);
  assert.equal(a.closeCode, null, "a pong cannot overtake the upload ahead of it");
  advance(t, worker, 20_000);
  assert.equal(a.closeCode, null);
  assert.deepEqual(a.sent.map((frame) => frame.t), ["ping", "sub", "cmd", "ping", "ping"], "sent once; pings only for the open and the server's two heartbeats, never a probe");
  assert.equal(worker.sockets.length, 1);

  a.bufferedAmount = 0;
  a.frame("ack", Date.now(), { rid: "r1" });
  visible();
  assert.deepEqual(a.sent.at(-1), { t: "ping", c: Date.now() }, "acked: probed again");
});

test("the ack timer counts unacked commands ahead on the socket, even once they left its buffer", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");

  command(tab, 1, "a", sized("prompt", 3_200_000));
  command(tab, 2, "a", { type: "abort" });
  assert.equal(a.bufferedAmount, 0, "the browser already handed the prompt to the network");
  advance(t, worker, 109_999);
  assert.equal(a.closeCode, null, "the abort waits out the prompt's 10 000 + 3 200 000 / 32 ms, not only its own 10 s");
  a.frame("ack", Date.now(), { rid: "r1" });
  a.frame("ack", Date.now(), { rid: "r2" });
  a.frame("reply", Date.now(), { rid: "r2", status: 200, body: OK });
  assert.deepEqual(answers(tab).map((answer) => [answer.cmd, answer.status, answer.attempts]), [[2, 200, 1]]);
  assert.equal(commands(a).length, 2);
});

test("ws-client puts every channel and every session on one socket", (t) => {
  t.mock.timers.enable(TIMERS);
  // ws-pool holds one pool socket for two sessions too (one bucket: 2 sessions ≤ perSocket 4).
  for (const transport of ["ws-client", "ws-pool"]) {
    const worker = loadWorker();
    const file = { kind: "file", path: "/w/notes.txt", sessionId: "a" };
    const tab = webSocketMode(worker, [running, file, session("a"), session("b")], transport);
    assert.equal(worker.sockets.length, 1, transport);
    const [socket] = worker.sockets;
    connect(socket, "w1", { transport });
    assert.deepEqual(subs(socket).map((frame) => frame.channel), [running, file, session("a"), session("b")]);
    command(tab, 1, "a", { type: "get_state" });
    command(tab, 2, "b", { type: "compact" });
    assert.deepEqual(commands(socket).map((frame) => [frame.rid, frame.session]), [["r1", "a"], ["r2", "b"]]);
    assert.equal(worker.sockets.length, 1, `${transport}: every session's commands ride it`);
    assert.deepEqual(tab.received, [{ transport }]);
  }
});

// Moves between WebSocket modes (spec D2 "Moves"): make-before-break.

test("switching ws-session → ws-client moves make-before-break", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a"), session("b")]);
  const [general, a, b] = worker.sockets;
  worker.sockets.forEach((socket, index) => connect(socket, `w${index}`));
  for (const socket of worker.sockets) openAll(socket);
  const [[runningSub], [aSub], [bSub]] = [general, a, b].map((socket) => subs(socket).map((frame) => frame.id));
  command(tab, 1, "a", { type: "prompt", message: "hi" });
  a.frame("ack", Date.now(), { rid: "r1" });
  command(tab, 2, "c", { type: "compact" });
  const c = worker.sockets[3];
  tab.received.length = 0;

  general.frame("mux", Date.now(), { type: "transport", transport: "ws-client", perSocket: 4, maxSockets: 16 });
  assert.equal(worker.sockets.length, 5, "one new socket for everything");
  const client = worker.sockets[4];
  assert.notEqual(c.closeCode, null, "emptied by the move and no ws-client key: closed at once");
  assert.deepEqual([general, a, b].map((socket) => socket.closeCode), [null, null, null], "the old sockets deliver until each stream opens on the new one");
  connect(client, "w9", { transport: "ws-client" });
  assert.deepEqual(subs(client).map((frame) => [frame.id, frame.channel]), [[runningSub, running], [aSub, session("a")], [bSub, session("b")]]);
  assert.deepEqual(commands(client).map((frame) => frame.rid), ["r2"], "the unsent command moved; the sent one stays");

  a.frame(aSub, Date.now(), { n: 1 });
  client.frame("mux", Date.now(), { type: "open", sub: aSub });
  assert.deepEqual(a.sent.at(-1), { t: "unsub", id: aSub });
  a.frame(aSub, Date.now(), { n: 2 });
  client.frame(aSub, Date.now(), { n: 3 });
  assert.deepEqual(tab.received, [
    { transport: "ws-client" },
    { id: 2, type: "message", data: "{\"n\":1}" },
    { id: 2, type: "error", readyState: 0 },
    { id: 2, type: "open" },
    { id: 2, type: "message", data: "{\"n\":3}" },
  ], "a later frame on the old socket is ignored");
  assert.equal(a.closeCode, null, "its command is still in flight");

  client.frame("mux", Date.now(), { type: "open", sub: runningSub });
  assert.notEqual(general.closeCode, null, "general closes once empty");
  client.frame("mux", Date.now(), { type: "open", sub: bSub });
  assert.notEqual(b.closeCode, null);
  a.frame("reply", 7, { rid: "r1", status: 200, body: OK });
  assert.deepEqual(answers(tab).map((answer) => [answer.cmd, answer.status, answer.attempts]), [[1, 200, 1]], "answered on the socket it was sent on");
  assert.notEqual(a.closeCode, null, "closed once its command settled");
  assert.equal(client.closeCode, null);
  assert.equal(worker.sockets.length, 5);
});

test("a refused move keeps the subscription on its old socket", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");
  openAll(a);
  const [{ id }] = subs(a);
  tab.received.length = 0;

  a.frame("mux", Date.now(), { type: "transport", transport: "ws-client" });
  const client = worker.sockets[1];
  connect(client, "w2", { transport: "ws-client" });
  client.frame("mux", Date.now(), { type: "refused", sub: id, status: 409, error: "Session is not managed by omp-web", code: "session_not_managed" });
  assert.deepEqual(client.sent.at(-1), { t: "unsub", id });
  a.frame(id, Date.now(), { n: 1 });
  assert.deepEqual(tab.received, [{ transport: "ws-client" }, { id: 1, type: "message", data: "{\"n\":1}" }], "still OPEN, still delivered by the old socket");
  assert.equal(a.closeCode, null);

  a.frame("mux", Date.now(), { type: "transport", transport: "ws-pool" });
  assert.equal(worker.sockets.length, 3, "the next policy change moves it again");
  assert.notEqual(client.closeCode, null, "an empty socket of another mode closes at once");
});

test("an equal transport frame changes nothing", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a")]);
  worker.sockets.forEach((socket, index) => connect(socket, `w${index}`));
  for (const socket of worker.sockets) openAll(socket);
  const sent = worker.sockets.map((socket) => socket.sent.length);
  tab.received.length = 0;

  for (const socket of worker.sockets) socket.frame("mux", Date.now(), { type: "transport", transport: "ws-session", perSocket: 4, maxSockets: 16 });
  assert.equal(worker.sockets.length, 2, "no dial");
  assert.deepEqual(worker.sockets.map((socket) => socket.sent.length), sent, "no frame");
  assert.deepEqual(tab.received, []);
});

test("a sent command whose socket drops after a move is resent on the session's current socket", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");
  openAll(a);
  const [{ id }] = subs(a);
  command(tab, 1, "a", { type: "prompt", message: "hi" });
  tab.received.length = 0;

  a.frame("mux", Date.now(), { type: "transport", transport: "ws-client" });
  const client = worker.sockets[1];
  connect(client, "w2", { transport: "ws-client" });
  assert.deepEqual(commands(client), [], "sent: it stays on its socket");
  a.drop();
  assert.deepEqual(commands(client).map((frame) => frame.rid), ["r1"], "resent at once on the session's socket of the same server");
  assert.deepEqual(tab.received, [{ transport: "ws-client" }, { id: 1, type: "error", readyState: 0 }], "the moving stream switches to its new socket now");
  client.frame("mux", Date.now(), { type: "open", sub: id });
  client.frame("reply", 7, { rid: "r1", status: 200, body: OK });
  assert.deepEqual(tab.received.slice(2), [
    { id: 1, type: "open" },
    {
      cmd: 1, status: 200, body: OK, recvAt: null, repliedAt: 7, attempts: 2, deduped: false, behindBytes: 0,
      socket: "client", behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: null,
    },
  ]);
  advance(t, worker, 60_000);
  assert.equal(worker.sockets.length, 2, "the old socket never redials");
});

// A session's commands keep their order across a move (spec D2 "Moves", commands).

test("Stop after a prompt still uploading goes behind it on the old socket across a move", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");
  openAll(a);
  const [{ id }] = subs(a);
  command(tab, 1, "a", sized("prompt", 8_000_000));
  a.bufferedAmount = 8_000_000;

  a.frame("mux", Date.now(), { type: "transport", transport: "ws-client" });
  const client = worker.sockets[1];
  connect(client, "w2", { transport: "ws-client" });
  command(tab, 2, "a", { type: "abort" });
  assert.deepEqual(commands(a).map((frame) => frame.rid), ["r1", "r2"], "the Stop queues behind the prompt on the socket it is uploading on");
  assert.deepEqual(commands(client), []);

  a.bufferedAmount = 0;
  a.frame("ack", 100, { rid: "r1" });
  a.frame("ack", 101, { rid: "r2" });
  a.frame("reply", 102, { rid: "r2", status: 200, body: OK });
  a.frame("reply", 103, { rid: "r1", status: 200, body: OK });
  assert.deepEqual(answers(tab).map((answer) => [answer.cmd, answer.status, answer.behindBytes]), [[2, 200, 8_000_000], [1, 200, 0]]);
  command(tab, 3, "a", { type: "get_state" });
  assert.deepEqual(commands(client).map((frame) => frame.rid), ["r3"], "once its commands are answered, the session's next one rides its new socket");
  client.frame("mux", Date.now(), { type: "open", sub: id });
  assert.notEqual(a.closeCode, null, "emptied: closed at once");
});

test("a command queued behind a lost one stays behind it across a move", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a")]);
  const [general, a] = worker.sockets;
  connect(general, "w0");
  connect(a, "w1");
  command(tab, 1, "a", { type: "prompt", message: "hi" });
  a.drop();
  command(tab, 2, "a", { type: "abort" });

  general.frame("mux", Date.now(), { type: "transport", transport: "ws-client" });
  const client = worker.sockets[2];
  connect(client, "w2", { transport: "ws-client" });
  assert.deepEqual(commands(client), [], "the abort waits behind the prompt the drop left unanswered");
  t.mock.timers.tick(1_000);
  const back = worker.sockets[3];
  connect(back, "w3", { transport: "ws-client" });
  assert.deepEqual(commands(back).map((frame) => frame.rid), ["r1", "r2"], "the prompt is resent to the same server, then the abort");
  assert.deepEqual(commands(client), []);
});

test("a further policy change cancels a pending move and starts the next one", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");
  openAll(a);
  const [{ id }] = subs(a);
  tab.received.length = 0;

  a.frame("mux", Date.now(), { type: "transport", transport: "ws-client" });
  const client = worker.sockets[1];
  connect(client, "w2", { transport: "ws-client" });
  assert.deepEqual(subs(client).map((frame) => frame.id), [id]);
  a.frame("mux", Date.now(), { type: "transport", transport: "ws-pool" });
  assert.deepEqual(client.sent.at(-1), { t: "unsub", id });
  assert.notEqual(client.closeCode, null, "no stream, no command and no ws-pool key: closed at once");
  const pool = worker.sockets[2];
  connect(pool, "w3", { transport: "ws-pool" });
  assert.deepEqual(subs(pool).map((frame) => frame.id), [id]);

  client.frame("mux", Date.now(), { type: "open", sub: id });
  a.frame(id, Date.now(), { n: 1 });
  pool.frame("mux", Date.now(), { type: "open", sub: id });
  assert.deepEqual(a.sent.at(-1), { t: "unsub", id });
  assert.notEqual(a.closeCode, null);
  assert.deepEqual(tab.received, [
    { transport: "ws-client" },
    { transport: "ws-pool" },
    { id: 1, type: "message", data: "{\"n\":1}" },
    { id: 1, type: "error", readyState: 0 },
    { id: 1, type: "open" },
  ], "the cancelled socket's open is ignored; the stream reconnects once");
});

test("switching to SSE while a move is pending closes every socket and subscribes each stream once over SSE", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [running, session("a")]);
  const [general, a] = worker.sockets;
  connect(general, "w0");
  connect(a, "w1");
  openAll(general);
  openAll(a);
  const ids = [...subs(general), ...subs(a)].map((frame) => frame.id);
  tab.received.length = 0;

  general.frame("mux", Date.now(), { type: "transport", transport: "ws-client" });
  const client = worker.sockets[2];
  connect(client, "w2", { transport: "ws-client" });
  assert.deepEqual(subs(client).map((frame) => frame.id), ids);
  general.frame("mux", Date.now(), { type: "transport", transport: "sse" });
  assert.deepEqual([general, a, client].map((socket) => socket.closeCode === null), [false, false, false]);
  client.frame("mux", Date.now(), { type: "open", sub: ids[0] });
  worker.source.hello("c1", "sse");
  await flush();
  assert.deepEqual(subscribedIds(worker.posts, "c1"), ids, "every stream, once");
  assert.deepEqual(tab.received, [
    { transport: "ws-client" },
    { transport: "sse" },
    { id: 1, type: "error", readyState: 0 },
    { id: 2, type: "error", readyState: 0 },
  ]);
  assert.equal(worker.sockets.length, 3);
});

test("a move survives its new socket reconnecting: the next hello subscribes the moving stream again", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, [session("a")]);
  const [a] = worker.sockets;
  connect(a, "w1");
  openAll(a);
  const [{ id }] = subs(a);
  tab.received.length = 0;

  a.frame("mux", Date.now(), { type: "transport", transport: "ws-client" });
  const first = worker.sockets[1];
  connect(first, "w2", { transport: "ws-client" });
  first.drop();
  t.mock.timers.tick(1_000);
  const second = worker.sockets[2];
  connect(second, "w3", { transport: "ws-client" });
  assert.deepEqual(subs(second).map((frame) => frame.id), [id], "subscribed once on the redialed socket");

  a.frame(id, Date.now(), { n: 1 });
  second.frame("mux", Date.now(), { type: "open", sub: id });
  assert.deepEqual(a.sent.at(-1), { t: "unsub", id });
  assert.notEqual(a.closeCode, null);
  assert.deepEqual(tab.received, [
    { transport: "ws-client" },
    { id: 1, type: "message", data: "{\"n\":1}" },
    { id: 1, type: "error", readyState: 0 },
    { id: 1, type: "open" },
  ], "the old socket delivered until the move completed");
});

// ws-pool sizing (spec D2 "ws-pool sizing"): N follows the active sessions; rendezvous ranks pick the bucket.

const poolSize = (worker) => vm.runInContext("poolSize", worker.context);

/** Distinct ids `s0, s1, …`, the i-th the first free one whose rank among `n` pool sockets is `ranks[i]`. */
function idsRanked(worker, n, ranks) {
  const taken = new Set();
  return ranks.map((rank) => {
    for (let i = 0; ; i++) {
      const id = `s${i}`;
      if (!taken.has(id) && worker.context.poolRank(id, n) === rank) {
        taken.add(id);
        return id;
      }
    }
  });
}

/** Every rebalance() result from now on, in order (wrapped inside the context: Bun's vm does not route a reassigned context property to the script's binding). */
function rebalances(worker) {
  vm.runInContext("var rebalanced = []; { const original = rebalance; rebalance = (...args) => { const result = original(...args); rebalanced.push(result); return result; }; }", worker.context);
  return { get results() { return Array.from(vm.runInContext("rebalanced", worker.context), (result) => ({ ...result })); } };
}

const POOL = { transport: "ws-pool" };

test("poolRank spreads sessions and moves only the minimum when N changes", () => {
  const { poolRank } = loadWorker().context;
  const ids = Array.from({ length: 1000 }, (_, i) => `s${i}`);
  const ranks = (n) => ids.map((id) => poolRank(id, n));
  for (let n = 1; n <= 16; n++) assert.ok(ranks(n).every((rank) => Number.isInteger(rank) && rank >= 0 && rank < n), `N = ${n}`);
  const four = ranks(4);
  const five = ranks(5);
  for (let bucket = 0; bucket < 4; bucket++) {
    const size = four.filter((rank) => rank === bucket).length;
    assert.ok(size >= 200 && size <= 300, `bucket ${bucket} holds ${size}`);
  }
  const changed = ids.filter((_, i) => four[i] !== five[i]);
  assert.ok(changed.length >= 150 && changed.length <= 250, `4 → 5 moved ${changed.length}`);
  assert.deepEqual(changed, ids.filter((_, i) => five[i] === 4), "4 → 5 moves only ids to the new index; 5 → 4 moves exactly the ids of the removed one");
});

test("the pool grows at once with the active sessions", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const [stays, moves, joins] = idsRanked(worker, 2, [0, 1, 1]);
  const tab = webSocketMode(worker, [running, session(stays), session(moves)], "ws-pool", { perSocket: 2, maxSockets: 16 });
  assert.equal(poolSize(worker), 1);
  assert.equal(worker.sockets.length, 1, "one socket, pool:0");
  const [pool0] = worker.sockets;
  connect(pool0, "w0", POOL);
  openAll(pool0);
  const movesSub = subs(pool0)[2].id;

  const spy = rebalances(worker);
  tab.open(4, session(joins));
  assert.equal(poolSize(worker), 2, "grown in the same tick");
  assert.equal(worker.sockets.length, 2, "pool:1 is dialed only now");
  assert.deepEqual(spy.results, [{ reason: "grow", fromPool: 1, toPool: 2, fromSockets: 1, toSockets: 2, active: 3, moved: 1, movedOther: 0 }], "the joining session counts as active and its socket as held");
  const pool1 = worker.sockets[1];
  connect(pool1, "w1", POOL);
  assert.deepEqual(subs(pool1).map((frame) => frame.channel), [session(moves), session(joins)], "the session now ranked 1 moves; the new one joins its bucket directly");
  assert.deepEqual(subs(pool0).map((frame) => frame.channel), [running, session(stays), session(moves)], "running and the session ranked 0 stay; nothing new on pool:0");
  pool1.frame("mux", Date.now(), { type: "open", sub: movesSub });
  assert.deepEqual(pool0.sent.at(-1), { t: "unsub", id: movesSub });
  assert.equal(pool0.closeCode, null);
});

test("the pool shrinks only after 30 s below target, and going back above cancels it", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const [stays, moves, joins] = idsRanked(worker, 2, [0, 1, 1]);
  const tab = webSocketMode(worker, [session(stays), session(moves), session(joins)], "ws-pool", { perSocket: 2 });
  assert.equal(poolSize(worker), 2);
  const [pool0, pool1] = worker.sockets;
  connect(pool0, "w0", POOL);
  connect(pool1, "w1", POOL);
  openAll(pool0);
  openAll(pool1);
  const [{ id: movesSub }] = subs(pool1);
  const spy = rebalances(worker);

  tab.close(3);
  advance(t, worker, 10_000);
  tab.open(3, session(joins));
  command(tab, 1, moves, { type: "prompt", message: "hi" });
  assert.deepEqual(commands(pool1).map((frame) => frame.rid), ["r1"]);
  pool1.frame("ack", Date.now(), { rid: "r1" });
  advance(t, worker, 10_000);
  tab.close(3);
  advance(t, worker, 29_999);
  assert.equal(poolSize(worker), 2, "the reopen cancelled the first drop's timer: 30 s count from the second");
  assert.deepEqual(subs(pool0).map((frame) => frame.channel), [session(stays)]);
  assert.deepEqual(spy.results, [], "the reopen moved nothing");
  advance(t, worker, 1);
  assert.equal(poolSize(worker), 1, "30 s below: shrunk");
  assert.deepEqual(spy.results, [{ reason: "shrink", fromPool: 2, toPool: 1, fromSockets: 2, toSockets: 1, active: 2, moved: 1, movedOther: 0 }]);
  assert.deepEqual(subs(pool0).map((frame) => frame.channel), [session(stays), session(moves)], "pool:1's session moves to pool:0");
  assert.equal(pool1.closeCode, null, "pool:1 delivers until the move completes");
  pool0.frame("mux", Date.now(), { type: "open", sub: movesSub });
  assert.deepEqual(pool1.sent.at(-1), { t: "unsub", id: movesSub });
  assert.equal(pool1.closeCode, null, "its sent command is still unanswered");
  pool1.frame("reply", Date.now(), { rid: "r1", status: 200, body: OK });
  assert.deepEqual(answers(tab).map((answer) => [answer.cmd, answer.status]), [[1, 200]]);
  assert.notEqual(pool1.closeCode, null, "answered: pool:1 closes");
  assert.equal(worker.sockets.length, 2);
});

test("recomputes while the shrink timer runs leave it running: steady command traffic still shrinks after 30 s", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const [a, b] = idsRanked(worker, 2, [0, 1]);
  const tab = webSocketMode(worker, [session(a), session(b)], "ws-pool", { perSocket: 1 });
  assert.equal(poolSize(worker), 2);
  const [pool0] = worker.sockets;
  worker.sockets.forEach((socket, index) => connect(socket, `w${index}`, POOL));

  tab.close(2);
  for (let n = 1; n <= 5; n++) {
    advance(t, worker, 5_000);
    command(tab, n, a, { type: "get_state" });
    pool0.frame("reply", Date.now(), { rid: `r${n}`, status: 200, body: OK });
  }
  assert.equal(answers(tab).length, 5);
  advance(t, worker, 4_999);
  assert.equal(poolSize(worker), 2);
  advance(t, worker, 1);
  assert.equal(poolSize(worker), 1, "30 s after the drop, however many recomputes came in between");
});

test("maxSockets caps the pool and a setting change resizes at once", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { poolRank } = worker.context;
  const ids = ["a", "b", "c", "d", "e"];
  webSocketMode(worker, ids.map(session), "ws-pool", { perSocket: 1, maxSockets: 2 });
  assert.equal(poolSize(worker), 2);
  assert.equal(worker.sockets.length, new Set(ids.map((id) => poolRank(id, 2))).size);
  const [first] = worker.sockets;
  connect(first, "w0", POOL);

  first.frame("mux", Date.now(), { type: "transport", transport: "ws-pool", perSocket: 1, maxSockets: 4 });
  assert.equal(poolSize(worker), 4, "in the same tick");
  assert.equal(worker.sockets.length, new Set([...ids.map((id) => poolRank(id, 2)), ...ids.map((id) => poolRank(id, 4))]).size, "the new buckets are dialed now");
});

test("non-session channels stay on pool:0", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const [ranked1, second, third] = idsRanked(worker, 2, [1, 0, 0]);
  const file = { kind: "file", path: "/w/notes.txt", sessionId: ranked1 };
  const tab = webSocketMode(worker, [running, file, session(ranked1)], "ws-pool", { perSocket: 1 });
  const [pool0] = worker.sockets;
  connect(pool0, "w0", POOL);

  tab.open(4, session(second));
  tab.open(5, session(third));
  assert.equal(poolSize(worker), 3);
  worker.sockets.slice(1).forEach((socket, index) => connect(socket, `w${index + 1}`, POOL));
  const carried = worker.sockets.flatMap((socket) => subs(socket).map((frame) => frame.channel)).filter((channel) => channel.kind !== "session");
  assert.deepEqual(carried, [running, file], "subscribed once each, on pool:0, and never moved");
  assert.deepEqual(subs(pool0).slice(0, 2).map((frame) => frame.channel), [running, file]);
});

test("a command keeps its session active until answered", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const [a, z] = idsRanked(worker, 2, [0, 1]);
  const tab = webSocketMode(worker, [session(a)], "ws-pool", { perSocket: 1 });
  const [pool0] = worker.sockets;
  connect(pool0, "w0", POOL);

  command(tab, 1, z, { type: "get_state" });
  assert.equal(poolSize(worker), 2, "a session with only a command counts");
  const pool1 = worker.sockets[1];
  connect(pool1, "w1", POOL);
  assert.deepEqual(commands(pool1).map((frame) => frame.rid), ["r1"], "it rides its bucket of the grown pool");
  assert.deepEqual(commands(pool0), []);
  pool1.frame("ack", Date.now(), { rid: "r1" });
  advance(t, worker, 60_000);
  assert.equal(poolSize(worker), 2, "unanswered: still active");

  pool1.frame("reply", Date.now(), { rid: "r1", status: 200, body: OK });
  advance(t, worker, 29_999);
  assert.equal(poolSize(worker), 2);
  assert.equal(pool1.closeCode, null);
  advance(t, worker, 1);
  assert.equal(poolSize(worker), 1, "the shrink timer started at the reply");
  assert.notEqual(pool1.closeCode, null);
});

test("a pong sets the min-RTT clock and event samples measure gotAt + offset − at", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  webSocketMode(worker, [running], "ws-client");
  const [client] = worker.sockets;
  connect(client, "w0", { transport: "ws-client" });
  openAll(client);
  const [{ id }] = subs(client);
  client.frame(id, Date.now(), { n: 0 });
  assert.deepEqual(recorded(worker, "event"), [], "no clock yet: no event sample");

  // The open sent a clock ping; its pong takes 40 ms and is stamped 5 030 ms after it left: offset 5 010.
  const opened = lastPing(client);
  t.mock.timers.tick(40);
  client.frame("pong", opened.c + 5_030, { c: opened.c });
  // The server's heartbeat is answered with a clock ping; this pong takes 10 ms: offset 5 000, the lower RTT, wins.
  client.frame("ping", Date.now() + 5_000, {});
  const answered = lastPing(client);
  assert.equal(answered.c, Date.now());
  t.mock.timers.tick(10);
  client.frame("pong", answered.c + 5_005, { c: answered.c });

  client.frame(id, Date.now() + 5_000 - 5, { n: 1 });
  const [event] = recorded(worker, "event");
  assert.deepEqual(pick(event, ["socket", "conn", "channel", "offset", "offsetRtt", "bytes", "behindSameBytes", "behindOtherBytes"]), {
    socket: "client", conn: "client", channel: "running", offset: 5_000, offsetRtt: 10, bytes: 7, behindSameBytes: 0, behindOtherBytes: 0,
  });
  assert.equal(event.gotAt + event.offset - event.at, 5);
});

test("SSE: three clock probes after hello, then lastEventId gives event samples", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ serverOffset: 2_000 });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c1");
  await flush();
  assert.equal(worker.probes.length, 3, "three GET /api/transport-metrics after the hello");
  const [sub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub });
  worker.source.dispatch(sub, { n: 1 }, String(Date.now() + 2_000 - 7));
  const [event] = recorded(worker, "event");
  assert.deepEqual(pick(event, ["transport", "pool", "socket", "conn", "sockets", "channel", "offset", "offsetRtt"]), {
    transport: "sse", pool: null, socket: "sse", conn: "sse", sockets: 1, channel: "running", offset: 2_000, offsetRtt: 0,
  });
  assert.equal(event.gotAt + event.offset - event.at, 7);

  // The EventSource drops: one reconnect sample, from the error to the first open after the next hello (which probes again).
  t.mock.timers.tick(5_000);
  const droppedAt = Date.now();
  worker.source.drop(0);
  t.mock.timers.tick(700);
  worker.source.hello("c2");
  await flush();
  assert.equal(worker.probes.length, 6);
  assert.deepEqual(recorded(worker, "reconnect"), []);
  const [again] = subscribedIds(worker.posts, "c2");
  worker.source.dispatch("mux", { type: "open", sub: again });
  assert.deepEqual(recorded(worker, "reconnect").map((sample) => pick(sample, ["socket", "conn", "trigger", "dropAt", "startAt", "firstFrameAt", "batch"])), [
    { socket: "sse", conn: "sse", trigger: "error", dropAt: droppedAt, startAt: droppedAt, firstFrameAt: droppedAt + 700, batch: 1 },
  ]);
});

test("at most one event sample per connection per second", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  webSocketMode(worker, [running, session("a")]);
  const [general, a] = worker.sockets;
  for (const socket of [general, a]) {
    connect(socket, "w");
    openAll(socket);
    pong(socket, 0);
  }
  const [{ id: runningSub }] = subs(general);
  const [{ id: aSub }] = subs(a);
  const start = Date.now();
  general.frame(runningSub, Date.now(), { n: 1 });
  t.mock.timers.tick(500);
  general.frame(runningSub, Date.now(), { n: 2 });
  a.frame(aSub, Date.now(), { n: 3 });
  t.mock.timers.tick(499);
  general.frame(runningSub, Date.now(), { n: 4 });
  t.mock.timers.tick(1);
  general.frame(runningSub, Date.now(), { n: 5 });
  assert.deepEqual(recorded(worker, "event").map((sample) => [sample.socket, sample.gotAt - start]), [["general", 0], ["session:a", 500], ["general", 1_000]]);
});

test("every sample carries transport, pool, socket, conn and sockets", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const [first, second] = idsRanked(worker, 2, [0, 1]);
  webSocketMode(worker, [session(first), session(second)], "ws-pool", { perSocket: 1 });
  assert.equal(poolSize(worker), 2);
  const [pool0, pool1] = worker.sockets;
  for (const socket of [pool0, pool1]) {
    connect(socket, "w", POOL);
    openAll(socket);
  }
  pong(pool1, 0);
  const [{ id }] = subs(pool1);
  pool1.frame(id, Date.now(), { n: 1 });
  assert.deepEqual(recorded(worker, "event").map((sample) => pick(sample, ["transport", "pool", "socket", "conn", "sockets"])), [
    { transport: "ws-pool", pool: 2, socket: "pool:1", conn: "pool", sockets: 2 },
  ]);
});

test("an event behind another session's large frame records behindOtherBytes and is sampled despite the 1/s limit", async (t) => {
  t.mock.timers.enable(TIMERS);
  // Session a's 100 000-char frame was written at T and arrived at T + 50; b's, written at T + 10, came right behind it.
  const behind = (deliver) => {
    deliver("a", Date.now() - 50, payload(100_000));
    deliver("b", Date.now() - 40, { n: 1 });
  };
  const isolation = (worker) => recorded(worker, "event").map((sample) => [sample.bytes, sample.behindSameBytes, sample.behindOtherBytes]);
  const sharedPipe = [[100_000, 0, 0], [7, 0, 100_000]];

  const client = loadWorker();
  webSocketMode(client, [session("a"), session("b")], "ws-client");
  const [socket] = client.sockets;
  connect(socket, "w0", { transport: "ws-client" });
  openAll(socket);
  pong(socket, 0);
  const ids = Object.fromEntries(subs(socket).map((frame) => [frame.channel.sessionId, frame.id]));
  behind((sessionId, at, data) => socket.frame(ids[sessionId], at, data));
  assert.deepEqual(isolation(client), sharedPipe, "ws-client");

  const sse = loadWorker();
  const tab = sse.connectTab();
  tab.open(1, session("a"));
  tab.open(2, session("b"));
  sse.source.hello("c1");
  await flush();
  const [aSub, bSub] = subscribedIds(sse.posts, "c1");
  for (const sub of [aSub, bSub]) sse.source.dispatch("mux", { type: "open", sub });
  behind((sessionId, at, data) => sse.source.dispatch(sessionId === "a" ? aSub : bSub, data, String(at)));
  assert.deepEqual(isolation(sse), sharedPipe, "sse");

  const separate = loadWorker();
  webSocketMode(separate, [session("a"), session("b")]);
  const [a, b] = separate.sockets;
  for (const each of [a, b]) {
    connect(each, "w");
    openAll(each);
  }
  pong(a, 0);
  behind((sessionId, at, data) => {
    const each = sessionId === "a" ? a : b;
    each.frame(subs(each)[0].id, at, data);
  });
  assert.deepEqual(isolation(separate), [[100_000, 0, 0], [7, 0, 0]], "ws-session: separate sockets");
});

test("a command behind another session's unacked upload records behindOtherBytes", (t) => {
  t.mock.timers.enable(TIMERS);
  for (const [transport, socketKey, behindOtherBytes] of [["ws-client", "client", 150_000], ["ws-session", "session:b", 0]]) {
    const worker = loadWorker();
    const tab = webSocketMode(worker, [session("a"), session("b")], transport);
    for (const socket of worker.sockets) connect(socket, "w", { transport });
    command(tab, 1, "a", sized("prompt", 200_000));
    for (const socket of worker.sockets) socket.bufferedAmount = 150_000;
    command(tab, 2, "b", { type: "get_state" });
    const carrier = worker.sockets.find((socket) => commands(socket).some((frame) => frame.rid === "r2"));
    carrier.frame("ack", Date.now(), { rid: "r2" });
    carrier.frame("reply", Date.now(), { rid: "r2", status: 200, body: OK });
    assert.deepEqual(pick(answers(tab)[0], ["socket", "behindBytes", "behindSameBytes", "behindOtherBytes"]), { socket: socketKey, behindBytes: 150_000, behindSameBytes: 0, behindOtherBytes }, transport);
  }
});

test("a reconnect sample runs from the wake to the first open after resubscribe; batch counts the sockets redialed together", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = webSocketMode(worker, idsRanked(worker, 3, [0, 1, 2]).map(session), "ws-pool", { perSocket: 1 });
  assert.equal(worker.sockets.length, 3);
  for (const socket of worker.sockets) {
    connect(socket, "w", POOL);
    openAll(socket);
  }
  assert.deepEqual(recorded(worker, "reconnect"), [], "a first dial is no reconnect");
  advance(t, worker, 5_000);

  const wokeAt = Date.now();
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "client-1" });
  const redialed = worker.sockets.slice(3);
  assert.equal(redialed.length, 3);
  t.mock.timers.tick(300);
  for (const socket of redialed) connect(socket, "x", POOL);
  assert.deepEqual(recorded(worker, "reconnect"), [], "the hello alone ends nothing");
  t.mock.timers.tick(200);
  for (const socket of redialed) openAll(socket);
  const samples = recorded(worker, "reconnect");
  assert.deepEqual(samples.map((sample) => sample.socket), ["pool:0", "pool:1", "pool:2"]);
  for (const sample of samples) {
    assert.deepEqual(pick(sample, ["conn", "trigger", "dropAt", "startAt", "firstFrameAt", "batch", "sockets"]), {
      conn: "pool", trigger: "online", dropAt: wokeAt, startAt: wokeAt, firstFrameAt: wokeAt + 500, batch: 3, sockets: 3,
    });
  }

  // A later drop within 60 s of a wake starts at the wake: the visible probe gives up on a silent socket 3 s after it.
  t.mock.timers.tick(1_000);
  const visibleAt = Date.now();
  tab.send({ op: "wake", reason: "visible", visible: true, clientId: "client-1" });
  pong(redialed[0], 0);
  pong(redialed[1], 0);
  t.mock.timers.tick(3_000);
  const [last] = worker.sockets.slice(6);
  connect(last, "y", POOL);
  openAll(last);
  assert.deepEqual(pick(recorded(worker, "reconnect").at(-1), ["socket", "trigger", "dropAt", "startAt", "batch"]), {
    socket: "pool:2", trigger: "visible", dropAt: visibleAt + 3_000, startAt: visibleAt, batch: 1,
  });
});

test("a resize records one rebalance with its churn and settledMs", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const [stays, first, second, joins] = idsRanked(worker, 2, [0, 1, 1, 1]);
  const tab = webSocketMode(worker, [session(stays), session(first), session(second)], "ws-pool", { perSocket: 3 });
  const [pool0] = worker.sockets;
  connect(pool0, "w0", POOL);
  openAll(pool0);
  const [, firstSub, secondSub] = subs(pool0).map((frame) => frame.id);

  tab.open(4, session(joins));
  assert.equal(poolSize(worker), 2);
  const pool1 = worker.sockets[1];
  t.mock.timers.tick(100);
  connect(pool1, "w1", POOL);
  t.mock.timers.tick(100);
  pool1.frame("mux", Date.now(), { type: "open", sub: firstSub });
  const joinedSub = subs(pool1).find((frame) => frame.channel.sessionId === joins).id;
  pool1.frame("mux", Date.now(), { type: "open", sub: joinedSub });
  assert.deepEqual(recorded(worker, "rebalance"), [], "written once the last move is open");
  t.mock.timers.tick(150);
  pool1.frame("mux", Date.now(), { type: "open", sub: secondSub });
  assert.deepEqual(recorded(worker, "rebalance").map((sample) => pick(sample, ["socket", "conn", "pool", "reason", "fromPool", "toPool", "fromSockets", "toSockets", "active", "moved", "movedOther", "settledMs"])), [
    { socket: "worker", conn: "worker", pool: 2, reason: "grow", fromPool: 1, toPool: 2, fromSockets: 1, toSockets: 2, active: 4, moved: 2, movedOther: 0, settledMs: 350 },
  ]);
});

test("samples flush at 200 or every 30 s, survive a failed POST, cap at 2 000 and report dropped", async (t) => {
  t.mock.timers.enable(TIMERS);
  let status = 200;
  const worker = loadWorker({ metricsStatus: () => status });
  const tab = worker.connectTab();
  const metric = (n) => tab.send({ op: "metric", sample: { metric: "test", n } });
  const numbers = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

  metric(0);
  t.mock.timers.tick(29_999);
  assert.equal(worker.flushes.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(worker.flushes.map((batch) => batch.map((sample) => sample.n)), [[0]], "30 s after the first sample");

  for (let n = 1; n <= 200; n++) metric(n);
  await flush();
  assert.deepEqual(worker.flushes[1].map((sample) => sample.n), numbers(1, 201), "at 200, at once");

  status = 503;
  for (let n = 201; n < 2_301; n++) metric(n);
  await flush();
  assert.equal(worker.flushes.length, 3, "one POST at 200, which failed; no retry per sample after it");
  assert.deepEqual(recorded(worker, "test").map((sample) => sample.n), numbers(301, 2_301), "kept; above 2 000 the oldest are dropped");

  status = 200;
  t.mock.timers.tick(30_000);
  await flush();
  const after = worker.flushes.slice(3);
  assert.ok(after.every((batch) => batch.length <= 201), "at most 200 samples and the dropped count per POST");
  assert.deepEqual(after.flat().filter((sample) => sample.metric === "test").map((sample) => sample.n), numbers(301, 2_301));
  assert.deepEqual(after[0].at(-1).metric, "dropped");
  assert.deepEqual(after.flat().filter((sample) => sample.metric === "dropped").map((sample) => pick(sample, ["count", "socket", "conn"])), [{ count: 100, socket: "worker", conn: "worker" }]);
  assert.deepEqual(recorded(worker, "test"), []);
});

test("every sample carries clientId, effectiveType and visible", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  worker.context.self.navigator.connection = { effectiveType: "3g" };
  const tab = worker.connectTab();
  const other = worker.connectTab();
  tab.send({ op: "wake", reason: "hidden", visible: false, clientId: "client-9" });
  tab.send({ op: "metric", sample: { metric: "test", n: 1 } });
  other.send({ op: "wake", reason: "init", visible: true, clientId: "client-9" });
  tab.send({ op: "metric", sample: { metric: "test", n: 2 } });
  assert.deepEqual(recorded(worker, "test").map((sample) => pick(sample, ["n", "clientId", "effectiveType", "visible", "transport", "socket", "conn", "sockets", "pool"])), [
    { n: 1, clientId: "client-9", effectiveType: "3g", visible: false, transport: "sse", socket: "worker", conn: "worker", sockets: 0, pool: null },
    { n: 2, clientId: "client-9", effectiveType: "3g", visible: true, transport: "sse", socket: "worker", conn: "worker", sockets: 0, pool: null },
  ]);
});
