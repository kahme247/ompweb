import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Runs the real public/event-stream-worker.js in a VM with fake browser
// globals: EventSource, fetch, Web Locks, and tab MessagePorts.
const workerSource = readFileSync(new URL("../public/event-stream-worker.js", import.meta.url), "utf8");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadWorker({ respond = () => ({ status: 200, body: { ok: true } }) } = {}) {
  const sources = [];
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
    hello(connectionId) {
      this.readyState = FakeEventSource.OPEN;
      this.dispatch("mux", { type: "hello", connectionId });
    }
    drop(readyState) {
      this.readyState = readyState;
      this.onerror?.();
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

  const context = vm.createContext({
    self,
    SharedWorkerGlobalScope,
    EventSource: FakeEventSource,
    JSON,
    Map,
    Math,
    Promise,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
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
