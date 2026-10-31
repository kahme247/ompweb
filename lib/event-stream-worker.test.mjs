import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Runs the real public/event-stream-worker.js in a VM with fake browser
// globals: EventSource, WebSocket, fetch, Web Locks, and tab MessagePorts.
// Time (Date.now, setTimeout, setInterval) is the host's, so t.mock.timers drives it.
const workerSource = readFileSync(new URL("../public/event-stream-worker.js", import.meta.url), "utf8");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadWorker({ respond = () => ({ status: 200, body: { ok: true } }) } = {}) {
  const sources = [];
  const sockets = [];
  const posts = [];
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
    dispatch(name, data) {
      for (const fn of this.listeners.get(name) ?? []) fn({ data: typeof data === "string" ? data : JSON.stringify(data) });
    }
    hello(connectionId, transport) {
      this.readyState = FakeEventSource.OPEN;
      this.dispatch("mux", { type: "hello", connectionId, ...(transport ? { transport } : {}) });
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
    hello(connectionId, { serverId = "srv1", transport = "websocket" } = {}) {
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
    sources,
    sockets,
    posts,
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

/** One tab opens these streams; the SSE hello then says the setting is WebSocket. */
function webSocketMode(worker, channels) {
  const tab = worker.connectTab();
  channels.forEach((channel, index) => tab.open(index + 1, channel));
  worker.source.hello("c0", "websocket");
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

test("a hello saying websocket moves every stream to a general socket and one socket per session", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const file = { kind: "file", path: "/w/notes.txt", sessionId: "a" };
  const tab = webSocketMode(worker, [running, file, session("a"), session("b")]);

  assert.equal(worker.source.closed, true);
  assert.deepEqual(worker.posts, [], "nothing subscribes over SSE");
  assert.deepEqual(worker.sockets.map((socket) => socket.url), [
    "wss://example.test/api/events/ws",
    "wss://example.test/api/events/ws?session=a",
    "wss://example.test/api/events/ws?session=b",
  ]);
  const [general, a, b] = worker.sockets;
  assert.deepEqual(general.sent, [], "subscriptions wait for the socket's hello");
  worker.sockets.forEach((socket, index) => connect(socket, `w${index}`));
  assert.deepEqual(subs(general).map((frame) => frame.channel), [running, file]);
  assert.deepEqual(subs(a).map((frame) => frame.channel), [session("a")]);
  assert.deepEqual(subs(b).map((frame) => frame.channel), [session("b")]);

  for (const socket of worker.sockets) openAll(socket);
  b.frame(subs(b)[0].id, Date.now(), { type: "connected" });
  assert.deepEqual(tab.received, [
    { transport: "websocket" },
    { id: 1, type: "open" },
    { id: 2, type: "open" },
    { id: 3, type: "open" },
    { id: 4, type: "open" },
    { id: 4, type: "message", data: "{\"type\":\"connected\"}" },
  ]);
  assert.deepEqual(worker.sockets.map((socket) => socket.closeCode), [null, null, null], "each socket's hello repeats the mode and tears nothing down");
  assert.equal(worker.sources.length, 1);
  assert.deepEqual(worker.connectTab().received, [{ transport: "websocket" }], "a tab attaching later learns the mode");
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
  wake("network");
  assert.equal(worker.sockets.length, 11);
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
