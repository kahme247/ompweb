import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { decodeBlobFrame, LINK_LIMITS, PartJoiner, queuedLine, SeqWindow, withSeq } from "./hosts/link-protocol.ts";
import { UPLOAD_STALL_MS, UPLOAD_WINDOW_BYTES } from "./upload-limits.ts";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "./image-attachments.ts";
import { buildEventStreamWorker } from "../server/client-env.ts";

// Runs the real lib/event-stream-worker.ts, bundled (unminified, so its top-level `samples` stays readable) the way
// server/client-env.ts bundles it, in a VM with fake browser globals: EventSource, WebSocket, fetch, Web Locks and tab
// MessagePorts. Time (Date.now, setTimeout, setInterval) is the host's, so t.mock.timers drives it.
// `/api/transport-metrics` answers the SSE clock probe as a server `serverOffset` ms ahead and records every sample batch
// POSTed to it (`metricsStatus` its HTTP status); `/api/events/link` answers a refused upgrade's diagnosis GET (`linkStatus`).
const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("./event-stream-worker.ts", import.meta.url))], target: "browser", format: "esm" });
assert.ok(built.success, built.logs.join("\n"));
const workerSource = await built.outputs[0].text();

const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadWorker({ respond = () => ({ status: 200, body: { ok: true } }), serverOffset = 0, metricsStatus = () => 200, linkStatus = () => 426, metricsHang = () => false, linkHang = () => false } = {}) {
  const sources = [];
  const sockets = [];
  const posts = [];
  const probes = [];
  const requests = [];
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

  /** The browser's WebSocket: `sent` holds what the worker sent (parsed), `receive` delivers a server line. */
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
    send(data) {
      // `accumulate`: a slow link, whose buffer the test drains by hand.
      if (this.accumulate) this.bufferedAmount += typeof data === "string" ? data.length : data.byteLength;
      if (typeof data !== "string") {
        const { id, bytes } = decodeBlobFrame(new Uint8Array(data));
        this.sent.push({ binary: true, id, bytes: Uint8Array.from(bytes) });
        return;
      }
      this.sent.push(JSON.parse(data));
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
    receive(message) {
      this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
    }
    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }

  class SharedWorkerGlobalScope {}
  const self = Object.create(SharedWorkerGlobalScope.prototype);
  self.onconnect = null;
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
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    Date: { now: () => Date.now() },
    AbortController,
    JSON,
    Map,
    Set,
    Math,
    Promise,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (id) => clearInterval(id),
    fetch: async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/transport-metrics") {
        if (init?.method !== "POST") probes.push(Date.now());
        else flushes.push(JSON.parse(init.body).samples);
        // A request that never answers, ended only by the worker's abort.
        if (metricsHang()) await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ now: Date.now() + serverOffset }) };
        const status = metricsStatus();
        return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
      }
      if (url === "/api/events/link") {
        // A diagnosis GET that never answers, ended only by the worker's abort.
        if (linkHang()) await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        const status = linkStatus();
        if (status === 0) throw new TypeError("Failed to fetch");
        return { ok: false, status, json: async () => ({}) };
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
    context,
    sources,
    sockets,
    posts,
    probes,
    requests,
    flushes,
    connectTab,
    get source() {
      return sources.at(-1);
    },
    get socket() {
      return sockets.at(-1);
    },
    releaseLock: (name) => locks.get(name)?.(),
  };
}

const running = { kind: "running" };
const session = (sessionId) => ({ kind: "session", sessionId });
const subscribedIds = (posts, connectionId) =>
  posts.filter((post) => post.connectionId === connectionId && post.subscribe).map((post) => post.subscribe.id);

// Instrumentation: the worker buffers samples until a flush POSTs them.

/** The samples of `metric` recorded and not flushed yet, oldest first (copied out of the context). */
const recorded = (worker, metric) =>
  Array.from(vm.runInContext("samples", worker.context), (sample) => ({ ...sample })).filter((sample) => sample.metric === metric);
const pick = (sample, keys) => Object.fromEntries(keys.map((key) => [key, sample[key]]));

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

// The browser link (docs/specs/2026-11-01-browser-link-design.md).

const TIMERS = { apis: ["setTimeout", "setInterval", "Date"] };

/**
 * The server end of the link, following the worker's latest socket: numbers what it sends, applies what the worker
 * sends once (parts joined, as lib/browser-link.ts does) and acks on request. A fresh link starts both counters over.
 */
function linkServer(worker) {
  let up = new SeqWindow();
  const joiner = new PartJoiner(Infinity);
  const read = new Map();
  let downSeq = 0;
  let applied = [];
  const opened = new Set();
  const srv = {
    get socket() {
      return worker.socket;
    },
    get applied() {
      return srv.read();
    },
    /** Opens the latest socket and answers its hello. */
    welcome({ resumed = false, token = "tok1", serverId = "srv1", ack } = {}) {
      if (srv.socket.readyState === 0) srv.socket.open();
      if (!resumed) {
        up = new SeqWindow();
        downSeq = 0;
        applied = [];
      }
      srv.socket.receive({ type: "welcome", v: 1, token, serverId, resumed, ack: ack ?? up.acked });
    },
    /** What the worker sent that the server applied, oldest first. */
    read() {
      for (const socket of worker.sockets) {
        for (let i = read.get(socket) ?? 0; i < socket.sent.length; i++) {
          const message = socket.sent[i];
          if (message.seq === undefined || !up.applied(message.seq)) continue;
          if (message.type !== "part") applied.push(message);
          else {
            const line = joiner.add(message);
            if (line !== null) applied.push(JSON.parse(line));
          }
        }
        read.set(socket, socket.sent.length);
      }
      return applied;
    },
    /** Marks everything sent so far as read without applying it: lost in flight. */
    lose() {
      for (const socket of worker.sockets) read.set(socket, socket.sent.length);
    },
    ack() {
      srv.read();
      srv.socket.receive({ type: "ack", ack: up.acked });
    },
    line(json, seq = ++downSeq) {
      srv.socket.receive(withSeq(queuedLine(json), seq));
      return seq;
    },
    event(name, data, at = Date.now(), seq) {
      return srv.line(`{"type":"e","name":${JSON.stringify(name)},"at":${at},"data":${typeof data === "string" ? data : JSON.stringify(data)}}`, seq);
    },
    reply(rid, status, body, { recvAt = Date.now(), at = Date.now(), deduped = false } = {}) {
      return srv.line(JSON.stringify({ type: "reply", rid, status, recvAt, at, deduped, data: body }));
    },
    ping: () => srv.socket.receive({ type: "ping", at: Date.now() }),
    subs: () => srv.read().filter((message) => message.type === "sub"),
    cmds: () => srv.read().filter((message) => message.type === "cmd"),
    /** Opens every subscription the server has not opened yet. */
    openAll() {
      for (const sub of srv.subs()) {
        if (opened.has(sub)) continue;
        opened.add(sub);
        srv.event("mux", { type: "open", sub: sub.id });
      }
    },
  };
  return srv;
}

/** One tab opens these streams and the SSE hello says the setting is `ws`; the link is dialed, welcomed and every stream open. */
function linked(worker, channels) {
  const tab = worker.connectTab();
  channels.forEach((channel, index) => tab.open(index + 1, channel));
  worker.source.hello("c0", "ws");
  const srv = linkServer(worker);
  srv.welcome();
  srv.openAll();
  tab.received.length = 0;
  return { tab, srv };
}

const OK = { success: true, data: {} };
const command = (tab, n, sessionId, body, req = `r${n}`) => tab.send({ op: "cmd", n, req, sessionId, advisor: false, body: JSON.stringify(body), type: body.type });
const answers = (tab) => tab.received.filter((message) => message.cmd !== undefined);
const errors = (tab) => tab.received.filter((message) => message.type === "error" || message.type === "open");
const sized = (type, length) => ({ type, message: "x".repeat(length) });

/** Advances time with the server's 15 s ping, so only a link that really goes quiet trips the silence check. */
function advance(t, worker, ms) {
  for (let left = ms; left > 0; left -= 15_000) {
    t.mock.timers.tick(Math.min(left, 15_000));
    if (worker.socket?.readyState === 1) worker.socket.receive({ type: "ping", at: Date.now() });
  }
}

test("ws: one link carries every stream; its lines go after the welcome and frames reach their tabs raw", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, running);
  tab.open(2, session("a"));
  worker.source.hello("c0", "ws");
  assert.equal(worker.source.closed, true, "the EventSource closes");
  assert.deepEqual(worker.posts, [], "nothing subscribes over SSE");
  assert.deepEqual(worker.sockets.map((socket) => socket.url), ["wss://example.test/api/events/link"]);

  const srv = linkServer(worker);
  srv.socket.open();
  assert.deepEqual(srv.socket.sent, [{ type: "hello", v: 1, token: null, ack: 0 }, { type: "ping", c: Date.now() }]);
  assert.deepEqual(srv.read(), [], "nothing sequenced before the welcome");
  srv.welcome();
  assert.deepEqual(srv.subs().map((sub) => [sub.seq, sub.id, sub.channel]), [[1, "s1", running], [2, "s2", session("a")]]);
  srv.openAll();
  srv.event("s2", '{"type":"connected"}');
  // A frame's data may hold its own `data` and `seq` keys: the worker passes the raw text on.
  srv.event("s1", '{"data":{"seq":3},"seq":4}');
  assert.deepEqual(tab.received, [
    { transport: "ws" },
    { id: 1, type: "open" },
    { id: 2, type: "open" },
    { id: 2, type: "message", data: '{"type":"connected"}' },
    { id: 1, type: "message", data: '{"data":{"seq":3},"seq":4}' },
  ]);
  assert.deepEqual(worker.connectTab().received, [{ transport: "ws" }], "a tab attaching later learns the mode");
  assert.equal(worker.sockets.length, 1);
});

test("a command goes over the link under its session and its reply reaches the tab with the server's times", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  srv.ack();
  command(tab, 1, "a", { type: "get_state" });
  const [cmd] = srv.cmds();
  assert.deepEqual(cmd, { type: "cmd", rid: "r1", session: "a", advisor: false, command: { type: "get_state" }, seq: 2 });
  srv.reply("r1", 200, { success: true, data: { model: "m" } }, { recvAt: 100, at: 200, deduped: true });
  assert.deepEqual(answers(tab), [{
    cmd: 1, status: 200, body: { success: true, data: { model: "m" } }, recvAt: 100, repliedAt: 200, attempts: 1, deduped: true,
    behindBytes: 0, socket: "link", behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: null,
  }]);
});

test("a small command passes another session's large prompt, and the window bounds what is unacked", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  srv.ack();
  const before = srv.socket.sent.length;
  command(tab, 1, "a", sized("prompt", 3 * 1024 * 1024));
  command(tab, 2, "b", { type: "get_state" });
  const sequenced = () => srv.socket.sent.slice(before).filter((message) => message.seq !== undefined);
  // The window is checked before each unit: pieces of the prompt go until it is full, nothing more until the server acks.
  const first = sequenced();
  assert.ok(first.length <= 3 && first.every((message) => message.type === "part"), first.map((message) => message.type).join());
  const unacked = first.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  assert.ok(unacked <= LINK_LIMITS.unackedBytes + LINK_LIMITS.pieceBytes, `${unacked} bytes unacked`);
  srv.ack();
  // b's command passes the rest of the 3 MiB: one more piece of a, then b (round-robin per session).
  assert.deepEqual(sequenced().slice(first.length, first.length + 2).map((message) => message.rid ?? message.type), ["part", "r2"]);

  // The socket's own buffer is full: no line goes out, even with the window open, until it drains (an ack still does).
  srv.socket.bufferedAmount = 2 * LINK_LIMITS.pieceBytes;
  srv.ack();
  const held = sequenced().length;
  t.mock.timers.tick(LINK_LIMITS.flushMs);
  assert.equal(sequenced().length, held);
  srv.socket.bufferedAmount = 0;
  t.mock.timers.tick(LINK_LIMITS.flushMs);
  assert.ok(sequenced().length > held, "polled again once the buffer drained");
  while (srv.cmds().length < 2) srv.ack();
  assert.deepEqual(srv.cmds().map((cmd) => [cmd.rid, cmd.command.message?.length ?? 0]), [["r2", 0], ["r1", 3 * 1024 * 1024]]);
});

test("a late reply never reconnects: only 30 s without any frame does", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  command(tab, 1, "a", { type: "prompt", message: "long task" });
  srv.ack();
  assert.deepEqual(srv.cmds().map((cmd) => cmd.rid), ["r1"], "the server has it");
  // No reply for two minutes, but the server's pings keep coming.
  advance(t, worker, 120_000);
  assert.equal(worker.sockets.length, 1);
  assert.equal(srv.socket.closeCode, null);
  assert.deepEqual(answers(tab), [], "still waiting");

  t.mock.timers.tick(29_999);
  assert.equal(srv.socket.closeCode, null);
  t.mock.timers.tick(1);
  assert.equal(worker.sockets[0].closeCode, 4000, "given up for a resume");
  t.mock.timers.tick(1_000);
  assert.equal(worker.sockets.length, 2);
  assert.deepEqual(tab.received, [], "the tabs see nothing of a drop");
});

test("a drop resumes: the hello carries token and ack, unacked lines go again once, missed frames arrive once, and the tabs see nothing", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running, session("a")]);
  srv.ack();
  srv.event("s2", { n: 1 });
  srv.event("s2", { n: 2 });
  t.mock.timers.tick(LINK_LIMITS.flushMs);
  assert.deepEqual(srv.socket.sent.at(-1), { type: "ack", ack: 4 }, "applied lines are acked within flushMs");
  command(tab, 1, "a", { type: "set_model", provider: "p", modelId: "m" });
  srv.lose();
  srv.event("s2", { n: 3 });
  srv.socket.drop();
  // Sent while the link is down.
  command(tab, 2, "a", { type: "abort" });
  t.mock.timers.tick(1_000);

  const second = worker.socket;
  assert.equal(worker.sockets.length, 2);
  second.open();
  assert.deepEqual(second.sent[0], { type: "hello", v: 1, token: "tok1", ack: 5 });
  srv.welcome({ resumed: true });
  // The server resends what it had not seen acked (n: 3) and goes on (n: 4).
  srv.event("s2", { n: 3 }, Date.now(), 5);
  srv.event("s2", { n: 4 }, Date.now(), 6);
  assert.deepEqual(second.sent.filter((message) => message.seq !== undefined).map((message) => [message.seq, message.rid]), [[3, "r1"], [4, "r2"]], "the lost command again under its seq, then the new one");
  assert.deepEqual(srv.cmds().map((cmd) => cmd.rid), ["r1", "r2"]);
  assert.deepEqual(tab.received.filter((message) => message.id === 2).map((message) => JSON.parse(message.data).n), [1, 2, 3, 4]);
  assert.deepEqual(errors(tab), [], "no error and no second open: nothing was re-subscribed");
  assert.equal(srv.subs().length, 2, "subscribed once, before the drop");
});

test("resync when the gap is gone: streams subscribe again, unsent commands go, sent ones follow the dedupe rules", (t) => {
  t.mock.timers.enable(TIMERS);
  for (const [serverId, waited, expected] of [
    ["srv1", 0, { setModel: "resent", getState: "resent" }],
    ["srv2", 0, { setModel: "lost", getState: "resent" }],
    ["srv1", 600_000, { setModel: "lost", getState: "resent" }],
  ]) {
    const worker = loadWorker();
    const { tab, srv } = linked(worker, [running]);
    command(tab, 1, "a", { type: "set_model", provider: "p", modelId: "m" });
    command(tab, 2, "a", { type: "get_state" });
    srv.read();
    t.mock.timers.tick(waited);
    srv.socket.drop();
    command(tab, 3, "a", { type: "abort" });
    t.mock.timers.tick(1_000);
    srv.welcome({ resumed: false, token: "tok2", serverId });
    assert.deepEqual(errors(tab), [{ id: 1, type: "error", readyState: 0 }], "the stream reconnects");
    assert.deepEqual(srv.subs().map((sub) => [sub.seq, sub.id]), [[1, "s1"]], "and subscribes again on the new link");
    const sent = srv.cmds().map((cmd) => cmd.rid);
    assert.deepEqual(sent, expected.setModel === "resent" ? ["r1", "r2", "r3"] : ["r2", "r3"], `${serverId} after ${waited} ms`);
    if (expected.setModel === "lost") assert.deepEqual(pick(answers(tab)[0], ["cmd", "status", "body", "attempts"]), { cmd: 1, status: 503, body: { error: "The connection to omp-web dropped before the answer arrived; the command may have run.", code: "transport_lost" }, attempts: 1 });
    srv.reply("r2", 200, OK, { deduped: serverId === "srv1" });
    assert.equal(answers(tab).find((answer) => answer.cmd === 2).attempts, 2, "a resend keeps its rid and counts");
  }
});

test("a command with no link answers transport_unavailable after 15 s; an oversize one answers 413 at once", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  srv.socket.drop();
  command(tab, 1, "a", { type: "prompt", message: "hi" });
  t.mock.timers.tick(14_999);
  assert.deepEqual(answers(tab), []);
  t.mock.timers.tick(1);
  assert.deepEqual(pick(answers(tab)[0], ["cmd", "status", "body"]), { cmd: 1, status: 503, body: { error: "Not sent: no connection to omp-web.", code: "transport_unavailable" } });
  srv.welcome({ resumed: true });
  assert.deepEqual(srv.cmds(), [], "it never leaves the browser later");

  // UTF-8 bytes, as the route counts them.
  command(tab, 2, "a", { type: "prompt", message: "€".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES / 3) });
  assert.deepEqual(pick(answers(tab)[1], ["cmd", "status", "body"]), { cmd: 2, status: 413, body: { error: "Agent command is too large", code: "request_too_large" } });
});

/** Ticks in half seconds until the worker dials a new socket (the backoff before it), at most `max` ms. */
function nextDial(t, worker, max = 32_000) {
  const dialed = worker.sockets.length;
  for (let waited = 0; waited < max && worker.sockets.length === dialed; waited += 500) t.mock.timers.tick(500);
  assert.equal(worker.sockets.length, dialed + 1, "a new dial");
}

test("a refused upgrade falls back to SSE for 5 minutes only after 3 in a row whose GET answered 426; offline only redials", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ linkStatus: () => 0 });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c0", "ws");
  worker.socket.drop();
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal(worker.sockets.length, 2, "offline: the link is dialed again");
  assert.deepEqual(tab.received, [{ transport: "ws" }]);

  // A proxy that strips Upgrade: every dial closes before it opens, and the plain GET reaches the server (426).
  const proxied = loadWorker({ linkStatus: () => 426 });
  const other = proxied.connectTab();
  other.open(1, running);
  proxied.source.hello("c0", "ws");
  for (const refusal of [1, 2]) {
    proxied.socket.drop();
    await flush();
    assert.deepEqual(other.received, [{ transport: "ws" }], `refusal ${refusal}: still on the link`);
    nextDial(t, proxied);
  }
  proxied.socket.drop();
  await flush();
  assert.deepEqual(other.received, [{ transport: "ws" }, { transport: "sse" }], "the third falls back");
  assert.equal(proxied.sources.length, 2, "an EventSource again");
  const dialed = proxied.sockets.length;
  proxied.source.hello("c1", "ws");
  await flush();
  assert.deepEqual(subscribedIds(proxied.posts, "c1"), ["s1"], "the setting still says ws, but the worker stays on SSE");
  other.send({ op: "cmd", n: 1, req: "r1", sessionId: "a", advisor: false, body: "{}", type: "get_state" });
  assert.deepEqual(other.received.at(-1), { cmd: 1, http: true });
  t.mock.timers.tick(300_000);
  assert.equal(proxied.sockets.length, dialed + 1, "5 minutes later a background probe dials the link");
  assert.equal(proxied.source.closed, false, "the tab stays on the EventSource while the probe runs");
  assert.deepEqual(other.received.at(-1), { cmd: 1, http: true });
});

test("after a fallback the 5-minute timer probes in the background: a refused probe changes nothing, an opened one switches to the link", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ linkStatus: () => 426 });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c0", "ws");
  for (let refusal = 0; refusal < 3; refusal++) {
    if (refusal) nextDial(t, worker);
    worker.socket.drop();
    await flush();
  }
  assert.deepEqual(tab.received, [{ transport: "ws" }, { transport: "sse" }], "fell back");
  const received = tab.received.length;
  const dialed = worker.sockets.length;
  const sources = worker.sources.length;

  t.mock.timers.tick(300_000);
  assert.equal(worker.sockets.length, dialed + 1, "the probe dials the link URL");
  assert.equal(worker.sockets.at(-1).url, "wss://example.test/api/events/link");
  worker.sockets.at(-1).drop();
  assert.equal(tab.received.length, received, "a refused probe sends the tab nothing: no error, no reconnect");
  assert.equal(worker.sources.length, sources, "and opens no second EventSource");
  assert.equal(worker.source.closed, false);
  t.mock.timers.tick(299_999);
  assert.equal(worker.sockets.length, dialed + 1, "the next probe waits another 5 minutes");
  t.mock.timers.tick(1);
  assert.equal(worker.sockets.length, dialed + 2);

  const probe = worker.sockets.at(-1);
  probe.open();
  assert.equal(probe.closeCode, 1000, "the probe closes with DONE_CODE");
  assert.deepEqual(tab.received.slice(received), [{ transport: "ws" }], "only now the mode switches");
  assert.equal(worker.source.closed, true);
  assert.equal(worker.sockets.length, dialed + 3, "and the link itself dials");
});

test("a command already sent when the upgrades are refused answers transport_lost, or goes back to the tab as http when it is read-only", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ linkStatus: () => 426 });
  const { tab, srv } = linked(worker, [running]);
  command(tab, 1, "a", { type: "set_model", provider: "p", modelId: "m" });
  command(tab, 2, "a", { type: "get_state" });
  srv.read();
  assert.equal(srv.cmds().length, 2, "both commands went out");
  srv.socket.drop();
  for (let refusal = 1; refusal <= 3; refusal++) {
    nextDial(t, worker);
    worker.socket.drop();
    await flush();
  }
  assert.equal(tab.received.some((message) => message.transport === "sse"), true, "fell back");
  const [changing, reading] = answers(tab);
  assert.deepEqual(pick(changing, ["cmd", "status"]), { cmd: 1, status: 503 });
  assert.equal(changing.body.code, "transport_lost");
  assert.deepEqual(reading, { cmd: 2, http: true }, "the tab sends the read-only command over HTTP");
  const dialed = worker.sockets.length;
  t.mock.timers.tick(120_000);
  assert.equal(worker.sockets.length, dialed, "no redial for commands that already answered");
});

test("a network flap does not fall back: dials while offline, and a 426 at link-up followed by an open, count for nothing", async (t) => {
  t.mock.timers.enable(TIMERS);
  let status = 0;
  const worker = loadWorker({ linkStatus: () => status });
  const { tab, srv } = linked(worker, [running]);
  const navigator = worker.context.self.navigator;
  // The network goes: the open link drops, and dials fail while the browser knows it is offline, even should a GET
  // somehow answer 426 then.
  navigator.onLine = false;
  srv.socket.drop();
  for (const offlineStatus of [0, 426, 426, 0]) {
    status = offlineStatus;
    nextDial(t, worker);
    worker.socket.drop();
    await flush();
  }
  // Link-up: the browser is online, the GET reaches the server (426), but this dial had already failed.
  navigator.onLine = true;
  status = 426;
  nextDial(t, worker);
  worker.socket.drop();
  await flush();
  // The next dial opens: the count starts over.
  nextDial(t, worker);
  srv.welcome({ resumed: true });
  // Two more refused dials with a 426 would make three in a row only without that reset.
  for (let i = 0; i < 2; i++) {
    srv.socket.drop();
    nextDial(t, worker);
    worker.socket.drop();
    await flush();
  }
  assert.equal(tab.received.some((message) => message.transport === "sse"), false, "never on SSE");
  assert.equal(worker.sources.length, 1, "no EventSource opened");
  nextDial(t, worker);
});

test("after an outage, a dial that fails as the network comes back is retried within a second, not after the outage's backoff", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ linkStatus: () => 0 });
  const { tab, srv } = linked(worker, [running]);
  const wake = (reason) => tab.send({ op: "wake", reason, visible: true, clientId: "client-1" });
  // 10 s offline: the dials at 0, 1, 3 and 7 s fail, and the next delay has grown to 16 s.
  worker.context.self.navigator.onLine = false;
  srv.socket.drop();
  for (let i = 0; i < 4; i++) {
    nextDial(t, worker);
    worker.socket.drop();
    await flush();
  }
  // Link-up: the wake's dial fails before the route settles.
  worker.context.self.navigator.onLine = true;
  wake("online");
  const dialed = worker.sockets.length;
  worker.socket.drop();
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal(worker.sockets.length, dialed + 1, "the next dial 1 s later");
});

test("switching to SSE: streams move to the EventSource, an unsent command goes back as http, a sent one is answered on the link, which then closes", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  command(tab, 1, "a", { type: "get_state" });
  srv.read();
  srv.socket.bufferedAmount = 2 * LINK_LIMITS.pieceBytes;
  command(tab, 2, "a", { type: "get_messages" });
  srv.event("mux", { type: "transport", transport: "sse" });
  assert.deepEqual(tab.received, [{ transport: "sse" }, { id: 1, type: "error", readyState: 0 }, { cmd: 2, http: true }]);
  worker.source.hello("c1");
  await flush();
  assert.deepEqual(subscribedIds(worker.posts, "c1"), ["s1"]);
  assert.equal(srv.socket.closeCode, null, "kept for the command it carries");
  // The buffer drains: what was queued for the link and is now SSE's does not go out on it (the tab POSTs r2).
  srv.socket.bufferedAmount = 0;
  t.mock.timers.tick(LINK_LIMITS.flushMs);
  assert.deepEqual(srv.read().slice(-2).map((message) => [message.type, message.id ?? message.rid]), [["cmd", "r1"], ["unsub", "s1"]]);
  srv.reply("r1", 200, OK);
  assert.equal(answers(tab).at(-1).cmd, 1);
  assert.equal(srv.socket.closeCode, 1000, "then done: the server drops the link at once");
});

test("refused fails only its stream as CLOSED; end resubscribes after 3 s on the link", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running, session("gone")]);
  srv.event("mux", { type: "refused", sub: "s2", status: 409, error: "Session is not managed by omp-web", code: "session_not_managed" });
  assert.deepEqual(tab.received, [{ id: 2, type: "error", readyState: 2 }]);
  srv.event("mux", { type: "end", sub: "s1" });
  assert.deepEqual(tab.received.at(-1), { id: 1, type: "error", readyState: 0 });
  const subscribed = srv.subs().length;
  t.mock.timers.tick(2_999);
  assert.equal(srv.subs().length, subscribed);
  t.mock.timers.tick(1);
  assert.deepEqual(srv.subs().slice(subscribed).map((sub) => sub.id), ["s1"]);
  assert.equal(worker.sockets.length, 1);
});

test("wake online redials at once and resumes; wake visible probes and redials only a link silent for 3 s", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  const wake = (reason) => tab.send({ op: "wake", reason, visible: true, clientId: "client-1" });
  t.mock.timers.tick(2_000);
  wake("online");
  assert.equal(worker.sockets[0].closeCode, 4000);
  assert.equal(worker.sockets.length, 2, "at once");
  wake("online");
  assert.equal(worker.sockets.length, 2, "a second tab's wake within a second redials nothing more");
  srv.welcome({ resumed: true });
  t.mock.timers.tick(2_000);

  wake("visible");
  assert.deepEqual(srv.socket.sent.at(-1), { type: "ping", c: Date.now() });
  srv.socket.receive({ type: "pong", c: Date.now(), at: Date.now() });
  t.mock.timers.tick(3_000);
  assert.equal(worker.sockets.length, 2, "it answered");
  wake("visible");
  t.mock.timers.tick(3_000);
  assert.equal(worker.sockets.length, 3, "silent for 3 s");
  assert.deepEqual(errors(tab), []);
});

test("the last stream closing shuts the link with 1000; a later stream dials a fresh one", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  tab.close(1);
  assert.equal(srv.socket.closeCode, 1000);
  tab.open(2, running);
  assert.equal(worker.sockets.length, 2);
  worker.socket.open();
  assert.deepEqual(worker.socket.sent[0], { type: "hello", v: 1, token: null, ack: 0 });
});

test("applied lines are acked within flushMs, at once past a piece; a duplicate is acked but not applied", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  const acks = () => srv.socket.sent.filter((message) => message.type === "ack");
  const before = acks().length;
  srv.event("s1", { n: 1 });
  srv.event("s1", { n: 1 }, Date.now(), 2);
  assert.equal(acks().length, before);
  t.mock.timers.tick(LINK_LIMITS.flushMs);
  assert.deepEqual(acks().slice(before), [{ type: "ack", ack: 2 }]);
  assert.equal(tab.received.length, 1);
  srv.event("s1", payload(LINK_LIMITS.pieceBytes));
  assert.deepEqual(acks().at(-1), { type: "ack", ack: 3 }, "past a piece: at once");
});

// Measurement, the same in both transports.

/** The server pings; the clock ping the worker answers with comes back `rtt` ms later, stamped `offset` ms ahead. */
function clock(t, srv, rtt, offset) {
  srv.ping();
  const { c } = srv.socket.sent.at(-1);
  t.mock.timers.tick(rtt);
  srv.socket.receive({ type: "pong", c, at: (c + Date.now()) / 2 + offset });
}

test("one worker-wide clock: the lowest RTT of the last 20 samples within 5 minutes; a frame before any clock is recorded with the first one", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { srv } = linked(worker, [running]);
  /** The clock of an event sample, a second after the last one. */
  const eventClock = () => {
    t.mock.timers.tick(1_000);
    srv.event("s1", { n: 1 });
    return pick(recorded(worker, "event").at(-1), ["offset", "offsetRtt"]);
  };

  const heldAt = Date.now();
  srv.event("s1", { n: 0 }, heldAt + 5_000);
  assert.deepEqual(recorded(worker, "event"), [], "no clock yet");
  clock(t, srv, 40, 5_010);
  assert.deepEqual(recorded(worker, "event").map((sample) => pick(sample, ["gotAt", "offset", "offsetRtt"])), [{ gotAt: heldAt, offset: 5_010, offsetRtt: 40 }], "the first frame, with the first clock");

  clock(t, srv, 10, 5_000);
  assert.deepEqual(eventClock(), { offset: 5_000, offsetRtt: 10 }, "a lower RTT wins");
  srv.socket.receive({ type: "pong", c: Date.now() + 100, at: Date.now() + 9_000 });
  assert.deepEqual(eventClock(), { offset: 5_000, offsetRtt: 10 }, "a negative RTT (the device clock stepped back mid-ping) is ignored");

  // The device clock steps: after 5 minutes the old samples age out, even with a lower RTT.
  advance(t, worker, 300_000);
  clock(t, srv, 30, 7_000);
  assert.deepEqual(eventClock(), { offset: 7_000, offsetRtt: 30 });
  advance(t, worker, 400_000);
  assert.deepEqual(eventClock(), { offset: 7_000, offsetRtt: 30 }, "the newest sample stays while nothing replaces it");

  clock(t, srv, 20, 8_000);
  for (let n = 0; n < 19; n++) clock(t, srv, 50, 8_100);
  assert.deepEqual(eventClock(), { offset: 8_000, offsetRtt: 20 });
  clock(t, srv, 50, 8_100);
  assert.deepEqual(eventClock(), { offset: 8_100, offsetRtt: 50 }, "only the last 20 samples count");
});

test("SSE: three clock probes after hello and one every 10 s; the first snapshot is recorded with the first clock; lastEventId gives event samples", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ serverOffset: 2_000 });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c1");
  assert.deepEqual(worker.requests.slice(0, 2), ["POST /api/events", "GET /api/transport-metrics"],
    "the subscribes go first: on HTTP/1.1 a probe ahead would hold one of the 6 connections first paint needs");
  const [sub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub });
  // The snapshot arrives before the first probe's answer.
  worker.source.dispatch(sub, { n: 1 }, String(Date.now() + 2_000 - 7));
  assert.deepEqual(recorded(worker, "event"), []);
  await flush();
  assert.equal(worker.probes.length, 3, "three GET /api/transport-metrics after the hello");
  const [event] = recorded(worker, "event");
  assert.deepEqual(pick(event, ["transport", "socket", "conn", "sockets", "channel", "offset", "offsetRtt"]), {
    transport: "sse", socket: "sse", conn: "sse", sockets: 1, channel: "running", offset: 2_000, offsetRtt: 0,
  });
  assert.equal(event.gotAt + event.offset - event.at, 7);
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(worker.probes.length, 3);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(worker.probes.length, 4);

  // The EventSource drops: one reconnect sample, from the error to the first open after the next hello (which probes again).
  t.mock.timers.tick(5_000);
  const droppedAt = Date.now();
  worker.source.drop(0);
  t.mock.timers.tick(700);
  worker.source.hello("c2");
  await flush();
  assert.equal(worker.probes.length, 7);
  assert.deepEqual(recorded(worker, "reconnect"), []);
  const [again] = subscribedIds(worker.posts, "c2");
  worker.source.dispatch("mux", { type: "open", sub: again });
  assert.deepEqual(recorded(worker, "reconnect").map((sample) => pick(sample, ["socket", "conn", "trigger", "dropAt", "startAt", "firstFrameAt", "batch", "resumed"])), [
    { socket: "sse", conn: "sse", trigger: "error", dropAt: droppedAt, startAt: droppedAt, firstFrameAt: droppedAt + 700, batch: 1, resumed: undefined },
  ]);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(worker.probes.length, 8, "one probe chain per connection: the dropped connection's stopped");
});

test("a clock probe that never answers is abandoned after 10 s: the probe chain goes on", async (t) => {
  t.mock.timers.enable(TIMERS);
  let hang = true;
  const worker = loadWorker({ metricsHang: () => hang });
  worker.connectTab().open(1, running);
  worker.source.hello("c1");
  await flush();
  assert.equal(worker.probes.length, 1, "the first probe is waiting");
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(worker.probes.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(worker.probes.length, 2, "its deadline passed: the chain sends its second probe");
  hang = false;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(worker.probes.length, 3, "the second was abandoned too: the third, now answered, ends the chain's three");
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(worker.probes.length, 4, "then one every 10 s");
});

test("a sample POST that never answers is abandoned after 10 s: its samples are kept and the next flush sends them", async (t) => {
  t.mock.timers.enable(TIMERS);
  let hang = true;
  const worker = loadWorker({ metricsHang: () => hang });
  const tab = worker.connectTab();
  tab.send({ op: "metric", sample: { metric: "test", n: 0 } });
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(worker.flushes.length, 1, "the POST is waiting");
  t.mock.timers.tick(10_500);
  await flush();
  assert.deepEqual(recorded(worker, "test").map((sample) => sample.n), [0], "abandoned: kept");
  hang = false;
  t.mock.timers.tick(30_000);
  await flush();
  assert.deepEqual(worker.flushes.at(-1).filter((sample) => sample.metric === "test").map((sample) => sample.n), [0], "sent again, not stuck behind the hung one");
  assert.deepEqual(recorded(worker, "test"), []);
});

test("a tab's bye forgets its client even without Web Locks: it hears no mode change; reopening a stream brings it back", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const gone = worker.connectTab();
  const stays = worker.connectTab();
  stays.open(1, running);
  worker.source.hello("c1");
  gone.send({ op: "bye" });
  worker.source.dispatch("mux", { type: "transport", transport: "ws" });
  assert.deepEqual(gone.received, [], "a closed tab is not posted to");
  assert.deepEqual(stays.received, [{ transport: "ws" }]);
  gone.open(1, running);
  assert.deepEqual(gone.received, [{ transport: "ws" }], "back from the bfcache: told the mode it missed");
});

test("a sample POST has 10 s plus its body at 2 KB/s: a big batch on a slow link is not abandoned at 10 s", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ metricsHang: () => true });
  const tab = worker.connectTab();
  for (let n = 0; n < 200; n++) tab.send({ op: "metric", sample: { metric: "test", n, pad: "x".repeat(1_000) } });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(worker.flushes.length, 1, "the POST of the full batch is waiting");
  const length = JSON.stringify({ samples: worker.flushes[0] }).length;
  assert.ok(length > 200_000);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(recorded(worker, "test").length, 0, "still waiting after 10 s: its samples are not back in the buffer");
  t.mock.timers.tick(length / 2);
  await flush();
  assert.equal(recorded(worker, "test").length, 200, "abandoned at 10 s + body / 2 KB/s: kept for the next flush");
});

test("a bfcache return with no streams: its first message, a wake, brings the client back and tells it the mode once", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const gone = worker.connectTab();
  worker.connectTab().open(1, running);
  worker.source.hello("c1");
  gone.send({ op: "bye" });
  gone.send({ op: "bye" });
  worker.source.dispatch("mux", { type: "transport", transport: "ws" });
  assert.deepEqual(gone.received, [], "a second bye does not bring it back");
  gone.send({ op: "wake", reason: "visible", visible: true });
  gone.send({ op: "wake", reason: "visible", visible: true });
  assert.deepEqual(gone.received, [{ transport: "ws" }], "told once, on the first message");
  assert.equal(vm.runInContext("clients.size", worker.context), 2, "it is in the worker's clients again, to hear the next change");
});

test("an SSE hello that switches to the link starts no clock probes, and the earlier connection's stop", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  worker.connectTab().open(1, running);
  worker.source.hello("c1");
  await flush();
  assert.equal(worker.probes.length, 3);
  worker.source.drop(0);
  worker.source.hello("c2", "ws");
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(10_000);
    await flush();
  }
  assert.equal(worker.probes.length, 3, "on the link its pings keep the clock");
});

test("at most one event sample per connection per second; every sample carries transport, socket, conn and sockets", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { srv } = linked(worker, [running]);
  clock(t, srv, 0, 0);
  const start = Date.now();
  srv.event("s1", { n: 1 });
  t.mock.timers.tick(500);
  srv.event("s1", { n: 2 });
  t.mock.timers.tick(500);
  srv.event("s1", { n: 3 });
  assert.deepEqual(recorded(worker, "event").map((sample) => [sample.gotAt - start, ...Object.values(pick(sample, ["transport", "socket", "conn", "sockets"]))]), [
    [0, "ws", "link", "link", 1],
    [1_000, "ws", "link", "link", 1],
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

  const ws = loadWorker();
  const { srv } = linked(ws, [session("a"), session("b")]);
  clock(t, srv, 0, 0);
  behind((sessionId, at, data) => srv.event(sessionId === "a" ? "s1" : "s2", data, at));
  assert.deepEqual(isolation(ws), sharedPipe, "ws");

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
});

test("a command's isolation bytes count what the link held ahead of it when it was queued", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  srv.ack();
  command(tab, 1, "a", sized("prompt", 200_000));
  command(tab, 2, "b", { type: "get_state" });
  command(tab, 3, "a", { type: "abort" });
  srv.read();
  for (const rid of ["r2", "r3"]) srv.reply(rid, 200, OK);
  const [b, a] = answers(tab).map((answer) => pick(answer, ["cmd", "socket", "behindBytes", "behindSameBytes", "behindOtherBytes"]));
  assert.equal(b.socket, "link");
  assert.ok(b.behindBytes > 200_000, `${b.behindBytes}`);
  assert.deepEqual([b.behindSameBytes, b.behindOtherBytes], [0, JSON.stringify(sized("prompt", 200_000)).length]);
  assert.deepEqual([a.behindSameBytes, a.behindOtherBytes], [JSON.stringify(sized("prompt", 200_000)).length, JSON.stringify({ type: "get_state" }).length]);
});

test("a reconnect sample: a resumed link ends at its welcome, a resync at the first open; batch counts drops together", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  assert.deepEqual(recorded(worker, "reconnect"), [], "a first dial is no reconnect");
  t.mock.timers.tick(5_000);

  const wokeAt = Date.now();
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "client-1" });
  t.mock.timers.tick(300);
  srv.welcome({ resumed: true });
  assert.deepEqual(recorded(worker, "reconnect").map((sample) => pick(sample, ["socket", "conn", "trigger", "dropAt", "startAt", "firstFrameAt", "batch", "resumed"])), [
    { socket: "link", conn: "link", trigger: "online", dropAt: wokeAt, startAt: wokeAt, firstFrameAt: wokeAt + 300, batch: 1, resumed: true },
  ]);

  t.mock.timers.tick(1_000);
  const droppedAt = Date.now();
  srv.socket.drop();
  t.mock.timers.tick(1_000);
  srv.welcome({ resumed: false, token: "tok2" });
  assert.equal(recorded(worker, "reconnect").length, 1, "a resync's outage lasts until its streams are open again");
  t.mock.timers.tick(200);
  srv.openAll();
  assert.deepEqual(pick(recorded(worker, "reconnect").at(-1), ["trigger", "dropAt", "startAt", "firstFrameAt", "resumed"]), {
    trigger: "close", dropAt: droppedAt, startAt: wokeAt, firstFrameAt: droppedAt + 1_200, resumed: false,
  });
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
  assert.equal(worker.flushes.length, 1, "not on the path that recorded the 200th sample");
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(worker.flushes[1].map((sample) => sample.n), numbers(1, 201), "at 200, right after");

  status = 503;
  for (let n = 201; n < 2_301; n++) metric(n);
  t.mock.timers.tick(0);
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

test("a held SSE frame is dropped when SSE closes: after a switch to the link the first clock does not record it", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c1");
  const [sub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub });
  // Held: the first probe has not answered yet.
  worker.source.dispatch(sub, { n: 1 }, String(Date.now()));
  worker.source.dispatch("mux", { type: "transport", transport: "ws" });
  // The probe already in flight answers now: the worker's first clock.
  await flush();
  const srv = linkServer(worker);
  srv.welcome();
  clock(t, srv, 0, 0);
  assert.deepEqual(recorded(worker, "event"), [], "an SSE frame stamped with the link's tags would count against it");
});

test("an HTTP action's reply is measured against the large frames of the SSE stream it shares a connection with", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, session("a"));
  worker.source.hello("c1");
  await flush();
  const [aSub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub: aSub });
  // Session a's 100 000-char frame, written 50 ms ago, arrives now.
  const arrived = Date.now();
  worker.source.dispatch(aSub, payload(100_000), String(arrived - 50));
  t.mock.timers.tick(5);
  const action = (sessionId, fields) =>
    tab.send({ op: "metric", sample: { metric: "action", req: `r-${sessionId}`, type: "get_state", session: sessionId, via: "http", socket: "http", gotAt: Date.now(), ...fields } });
  action("b", { repliedAt: arrived - 40, replyBehindOtherBytes: null });
  action("a", { repliedAt: arrived - 40, replyBehindOtherBytes: null });
  action("c", { repliedAt: arrived + 1, replyBehindOtherBytes: null });
  action("d", { repliedAt: null, replyBehindOtherBytes: null });
  assert.deepEqual(recorded(worker, "action").map((sample) => [sample.session, sample.replyBehindOtherBytes]), [["b", 100_000], ["a", 0], ["c", 0], ["d", null]]);
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
  assert.deepEqual(recorded(worker, "test").map((sample) => pick(sample, ["n", "clientId", "effectiveType", "visible", "transport", "socket", "conn", "sockets"])), [
    { n: 1, clientId: "client-9", effectiveType: "3g", visible: false, transport: "sse", socket: "worker", conn: "worker", sockets: 0 },
    { n: 2, clientId: "client-9", effectiveType: "3g", visible: true, transport: "sse", socket: "worker", conn: "worker", sockets: 0 },
  ]);
});

test("the production bundle is a classic script without AbortSignal.timeout, AbortSignal.any or Promise.withResolvers", async () => {
  const bundle = await buildEventStreamWorker(fileURLToPath(new URL("..", import.meta.url)));
  for (const forbidden of ["AbortSignal.timeout", "AbortSignal.any", "withResolvers", "import.meta"]) assert.ok(!bundle.includes(forbidden), forbidden);
  assert.doesNotThrow(() => new vm.Script(bundle), "parses as a classic script (no import/export)");
  assert.match(bundle, /^\(\(\)=>\{/, "wrapped: its names stay out of the worker's global scope");
});

test("a command resent after a resync keeps its first send time: a second resync past the dedupe window answers transport_lost, never a third send", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  command(tab, 1, "a", { type: "set_model", provider: "p", modelId: "m" });
  srv.read();
  // Each time the reply is lost with the socket, and the link comes back resynced by the same server.
  const resync = (ms) => {
    advance(t, worker, ms);
    srv.socket.drop();
    t.mock.timers.tick(1_000);
    srv.welcome({ resumed: false, token: `tok-${ms}` });
  };
  resync(9 * 60_000);
  resync(4 * 60_000);
  const sends = worker.sockets.flatMap((socket) => socket.sent).filter((message) => message.type === "cmd" && message.rid === "r1");
  assert.equal(sends.length, 2, "the first send and one resend: 13 min after the first, the server's dedupe may have forgotten it");
  assert.deepEqual(pick(answers(tab)[0], ["cmd", "status", "attempts"]), { cmd: 1, status: 503, attempts: 2 });
  assert.equal(answers(tab)[0].body.code, "transport_lost");
});

test("Stop stays behind its own session's earlier prompt, so it never reaches omp before the run it stops; it still passes other sessions' traffic", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  srv.ack();
  command(tab, 1, "b", sized("prompt", 3 * 1024 * 1024));
  command(tab, 2, "a", sized("prompt", 3 * 1024 * 1024));
  command(tab, 3, "a", { type: "abort" });
  command(tab, 4, "b", { type: "abort" });
  while (srv.cmds().length < 4) srv.ack();
  const order = srv.cmds().map((cmd) => cmd.rid);
  assert.ok(order.indexOf("r3") > order.indexOf("r2"), `a's Stop after a's prompt: ${order}`);
  assert.ok(order.indexOf("r4") > order.indexOf("r1"), `b's Stop after b's prompt: ${order}`);

  // Another session's large prompt does not hold a Stop back.
  command(tab, 5, "c", sized("prompt", 3 * 1024 * 1024));
  command(tab, 6, "d", { type: "abort" });
  while (srv.cmds().length < 6) srv.ack();
  assert.deepEqual(srv.cmds().slice(4).map((cmd) => cmd.rid), ["r6", "r5"]);
});

test("a refused upgrade answered 502 or 504 (the proxy's upstream is down) redials instead of falling back", async (t) => {
  t.mock.timers.enable(TIMERS);
  for (const status of [502, 504]) {
    const worker = loadWorker({ linkStatus: () => status });
    const tab = worker.connectTab();
    tab.open(1, running);
    worker.source.hello("c0", "ws");
    worker.socket.drop();
    await flush();
    t.mock.timers.tick(1_000);
    assert.equal(worker.sockets.length, 2, `${status}: the link is dialed again`);
    assert.deepEqual(tab.received, [{ transport: "ws" }], `${status}: no switch to SSE`);
  }
});

test("a refused upgrade whose diagnosis GET never answers is abandoned after 10 s and the link redials", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ linkHang: () => true });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c0", "ws");
  worker.socket.drop();
  await flush();
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(worker.sockets.length, 1, "the GET is still pending: nothing redials");
  t.mock.timers.tick(1);
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal(worker.sockets.length, 2, "the GET was abandoned (status 0): the link is dialed again");
});

// ---- Uploads (docs/specs/2026-11-02-file-uploads-design.md U4) ----

const UPLOAD_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
/** A file whose every byte says where it is. */
const patterned = (size) => Uint8Array.from({ length: size }, (_, index) => index % 251);
const upload = (tab, blob, id = UPLOAD_ID) => tab.send({ op: "upload", id, host: "h1", name: "data.bin", type: "application/octet-stream", blob });
/** An up_ack; `start`: the `n` of the up_start it answers. */
const upAck = (srv, received, { done = false, start } = {}) =>
  srv.line(JSON.stringify({ type: "up_ack", id: UPLOAD_ID, received, done, ...(start === undefined ? {} : { start }) }));
/** Chunks the worker sent on `socket`, in order. */
const chunks = (socket) => socket.sent.filter((message) => message.binary);
const chunkBytes = (list) => list.reduce((total, chunk) => total + chunk.bytes.byteLength, 0);
/** Lets the worker's File reads (real promises) settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await flush();
}

test("upload chunks take turns with a command on a slow link: the command waits behind less than a window", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  srv.ack();
  const size = 8 * 1024 * 1024;
  upload(tab, new Blob([patterned(size)]));
  const start = srv.read().find((message) => message.type === "up_start");
  assert.deepEqual(pick(start, ["id", "n", "host", "name", "size", "mime"]), { id: UPLOAD_ID, n: 1, host: "h1", name: "data.bin", size, mime: "application/octet-stream" });
  assert.equal(chunks(srv.socket).length, 0, "no chunk before the start's answer");

  srv.socket.accumulate = true;
  upAck(srv, 0, { start: 1 });
  await settle();
  const drain = () => {
    srv.socket.bufferedAmount = 0;
    t.mock.timers.tick(LINK_LIMITS.flushMs);
  };
  drain();
  const before = chunkBytes(chunks(srv.socket));
  assert.ok(before > 0 && before < UPLOAD_WINDOW_BYTES, `${before} bytes of chunks went out before the command`);

  command(tab, 1, "a", { type: "prompt", message: "hi" });
  const sentBefore = srv.socket.sent.length;
  while (!srv.cmds().some((cmd) => cmd.rid === "r1")) drain();
  const cmdAt = srv.socket.sent.findIndex((message) => message.rid === "r1");
  const between = chunkBytes(srv.socket.sent.slice(sentBefore, cmdAt).filter((message) => message.binary));
  assert.ok(between <= LINK_LIMITS.pieceBytes, `the command went after ${between} bytes of chunks (one piece at most: keys take turns)`);
  srv.reply("r1", 200, OK);
  assert.equal(answers(tab).at(-1).status, 200);

  // The upload's window: no more than UPLOAD_WINDOW_BYTES past the host's ack, however long the link drains.
  for (let i = 0; i < 20; i++) drain();
  await settle();
  for (let i = 0; i < 20; i++) drain();
  assert.equal(chunkBytes(chunks(srv.socket)), UPLOAD_WINDOW_BYTES, "the window is full, nothing more until an ack");
  upAck(srv, UPLOAD_WINDOW_BYTES);
  await settle();
  for (let i = 0; i < 20; i++) drain();
  assert.equal(chunkBytes(chunks(srv.socket)), 2 * UPLOAD_WINDOW_BYTES, "an ack opens the window again");
  assert.deepEqual(tab.received.filter((message) => message.up).at(-1), { up: UPLOAD_ID, received: UPLOAD_WINDOW_BYTES, done: false });
});

test("a socket dropped mid-upload resumes from the host's offset: up_start again, chunks from its received", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  const size = 3 * LINK_LIMITS.pieceBytes + 100;
  const bytes = patterned(size);
  upload(tab, new Blob([bytes]));
  upAck(srv, 0, { start: 1 });
  await settle();
  const first = srv.socket;
  assert.equal(chunkBytes(chunks(first)), size, "the whole file fits the window");

  // The host wrote two pieces; the rest was lost with the socket.
  const received = 2 * LINK_LIMITS.pieceBytes;
  first.drop();
  t.mock.timers.tick(1_000);
  assert.notEqual(srv.socket, first, "dialed again");
  srv.welcome({ resumed: true });
  const starts = srv.read().filter((message) => message.type === "up_start");
  assert.deepEqual(starts.map((start) => start.n), [1, 2], "up_start again after the resume, counted");

  // An ack of chunks from before the drop says nothing about where to go on from.
  upAck(srv, 3 * LINK_LIMITS.pieceBytes);
  await settle();
  assert.equal(chunks(srv.socket).length, 0);
  upAck(srv, received, { start: 2 });
  await settle();
  assert.deepEqual(joined(chunks(srv.socket)), bytes.subarray(received), "the rest of the file, from the host's offset");
  upAck(srv, size, { done: true });
  assert.deepEqual(tab.received.filter((message) => message.up).at(-1), { up: UPLOAD_ID, received: size, done: true });
});

/** The bytes of these chunks, in order. */
function joined(list) {
  const bytes = new Uint8Array(chunkBytes(list));
  let at = 0;
  for (const chunk of list) {
    bytes.set(chunk.bytes, at);
    at += chunk.bytes.byteLength;
  }
  return bytes;
}

test("the answer to an earlier up_start, replayed after a resume, is ignored: chunks go from the latest answer's offset", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  const size = 3 * LINK_LIMITS.pieceBytes + 100;
  const bytes = patterned(size);
  upload(tab, new Blob([bytes]));
  // The socket drops before the answer to up_start 1 is applied; up_start 2 goes on the resumed link.
  const first = srv.socket;
  first.drop();
  t.mock.timers.tick(1_000);
  srv.welcome({ resumed: true });
  assert.deepEqual(srv.read().filter((message) => message.type === "up_start").map((start) => start.n), [1, 2]);

  // The server replays answer 1 after up_start 2 went out: where up_start 1 began says nothing about up_start 2.
  upAck(srv, LINK_LIMITS.pieceBytes, { start: 1 });
  await settle();
  assert.equal(chunks(srv.socket).length, 0, "nothing goes on the stale answer");
  // Main's start 2 reports the host's offset (lower: the host lost what start 1 began from).
  upAck(srv, 0, { start: 2 });
  await settle();
  assert.deepEqual(joined(chunks(srv.socket)), bytes, "the whole file, from answer 2's offset");
  upAck(srv, size, { done: true });
  assert.deepEqual(tab.received.filter((message) => message.up).at(-1), { up: UPLOAD_ID, received: size, done: true });
});

test("an upload no answer or ack moves on for UPLOAD_STALL_MS fails 504 upload_stalled, left on the host for a Retry", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  // Time passes on a live link: pings keep it up.
  const wait = (ms) => {
    for (let left = ms; left > 0; left -= 10_000) {
      t.mock.timers.tick(Math.min(10_000, left));
      srv.ping();
      srv.ack();
    }
  };
  const failed = () => tab.received.filter((message) => message.up && message.error).map((message) => message.up);
  const unanswered = "0f0e0d0c-0b0a-4908-8706-0504030201ff";
  upload(tab, new Blob([patterned(4 * UPLOAD_WINDOW_BYTES)]));
  upload(tab, new Blob([patterned(10)]), unanswered);
  wait(UPLOAD_STALL_MS - 1);
  upAck(srv, 0, { start: 1 });
  await settle();
  wait(1);
  assert.deepEqual(failed(), [unanswered], "a start never answered stalls too");
  wait(UPLOAD_STALL_MS - 2);
  upAck(srv, LINK_LIMITS.pieceBytes);
  await settle();
  wait(UPLOAD_STALL_MS - 1);
  assert.deepEqual(failed(), [unanswered], "the start's answer and each ack that moved it re-armed the deadline");
  wait(1);
  assert.deepEqual(failed(), [unanswered, UPLOAD_ID]);
  assert.deepEqual(tab.received.findLast((message) => message.up === UPLOAD_ID), { up: UPLOAD_ID, error: { status: 504, code: "upload_stalled", message: "The upload stopped making progress" } });
  assert.deepEqual(srv.read().filter((message) => message.type === "up_abort"), [], "nothing aborted: a Retry resumes it from the host's offset");
});

test("a Retry under the same id is not failed by the earlier attempt's stall deadline", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  const wait = (ms) => {
    for (let left = ms; left > 0; left -= 10_000) {
      t.mock.timers.tick(Math.min(10_000, left));
      srv.ping();
      srv.ack();
    }
  };
  upload(tab, new Blob([patterned(10)]));
  wait(UPLOAD_STALL_MS / 2);
  // The tab retries before the first attempt stalled: same id, a fresh attempt.
  upload(tab, new Blob([patterned(10)]));
  wait(UPLOAD_STALL_MS / 2 + 1);
  assert.deepEqual(tab.received.filter((message) => message.up === UPLOAD_ID && message.error), [], "the first attempt's deadline died with it");
  wait(UPLOAD_STALL_MS / 2);
  assert.equal(tab.received.filter((message) => message.up === UPLOAD_ID && message.error).length, 1, "the retry's own deadline still fires, once");
});

test("an up_error fails the upload in its tab; a removed upload and a closed tab's send up_abort; SSE hands the rest to the tab", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  const other = worker.connectTab();
  other.send({ op: "lock", name: "tab-b" });
  const [failing, removed, orphaned, handed] = ["a", "b", "c", "d"].map((x) => `0f0e0d0c-0b0a-4908-8706-0504030201${x}0`);
  for (const id of [failing, removed, handed]) upload(tab, new Blob([patterned(10)]), id);
  upload(other, new Blob([patterned(10)]), orphaned);
  const error = { status: 507, code: "upload_write_failed", message: "disk full" };
  srv.line(JSON.stringify({ type: "up_error", id: failing, ...error }));
  assert.deepEqual(tab.received.filter((message) => message.up), [{ up: failing, error }]);

  tab.send({ op: "up_abort", id: removed });
  worker.releaseLock("tab-b");
  await flush();
  assert.deepEqual(srv.read().filter((message) => message.type === "up_abort").map((message) => message.id), [removed, orphaned]);

  // The server's setting goes back to SSE: the tab goes on over HTTP from the host's offset.
  srv.event("mux", { type: "transport", transport: "sse" });
  assert.deepEqual(tab.received.filter((message) => message.up).at(-1), { up: handed, http: true });
});

test("a Retry under the same id starts at a fresh `n`: the stalled attempt's late answers fail and start nothing", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  upload(tab, new Blob([patterned(10)]));
  for (let left = UPLOAD_STALL_MS; left > 0; left -= 10_000) {
    t.mock.timers.tick(Math.min(10_000, left));
    srv.ping();
    srv.ack();
  }
  assert.equal(tab.received.filter((message) => message.up === UPLOAD_ID && message.error).length, 1, "attempt 1 stalled");
  upload(tab, new Blob([patterned(10)]));
  const [first, retry] = srv.read().filter((message) => message.type === "up_start").map((start) => start.n);
  assert.notEqual(retry, first, "the Retry's up_start does not reuse the stalled attempt's n");

  const error = { status: 507, code: "upload_write_failed", message: "disk full" };
  const before = tab.received.length;
  srv.line(JSON.stringify({ type: "up_error", id: UPLOAD_ID, ...error, start: first }));
  upAck(srv, 0, { start: first });
  await settle();
  assert.equal(tab.received.length, before, "the stalled attempt's late answers are ignored");
  assert.equal(chunks(srv.socket).length, 0, "and start no chunks");
  upAck(srv, 0, { start: retry, done: false });
  await settle();
  assert.equal(chunks(srv.socket).length, 1, "the Retry's own answer starts it");
});

test("a server-generated asynchronous error queued under start 1 cannot fail Retry start 2", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-worker-upload-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  const { browserLink } = await import("./browser-link.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const host = await linkHost("Worker generation regression");
  t.after(() => host.drop());
  const sent = [];
  const ws = { data: { kind: "browser", owner: "open", link: null }, send: (text) => (sent.push(JSON.parse(text)), text.length), close() {} };
  browserLink.open(ws);
  t.after(() => browserLink.close(ws, 1000));
  browserLink.message(ws, JSON.stringify({ type: "hello", v: 1, token: null, ack: 0 }));
  const start = (n) => browserLink.message(ws, JSON.stringify({ type: "up_start", seq: n, id: UPLOAD_ID, n, host: host.id, name: "data.bin", size: 10, mime: "" }));
  start(1);
  const first = await host.next();
  await host.answer(first, { received: 0, done: false });
  await settle();
  await host.post({ type: "upload_ack", id: UPLOAD_ID, attempt: first.args.attempt, received: 0, done: false, error: { status: 507, code: "upload_write_failed", message: "old disk error" } });
  const oldError = sent.find((message) => message.type === "up_error");
  assert.ok(oldError, "the real server queued the host's asynchronous error");
  start(2);
  const second = await host.next();
  await host.answer(second, { received: 0, done: false });
  await settle();
  const retryAnswer = sent.find((message) => message.type === "up_ack" && message.start === 2);
  await host.post({ type: "upload_ack", id: UPLOAD_ID, attempt: second.args.attempt, received: 5, done: false });
  await host.post({ type: "upload_ack", id: UPLOAD_ID, attempt: second.args.attempt, received: 10, done: true });
  const progress = sent.filter((message) => message.type === "up_ack" && message.received > 0);
  browserLink.close(ws, 1000);
  host.drop();

  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  upload(tab, new Blob([patterned(10)]));
  for (let left = UPLOAD_STALL_MS; left > 0; left -= 10_000) {
    t.mock.timers.tick(Math.min(10_000, left));
    srv.ping();
    srv.ack();
  }
  assert.equal(tab.received.filter((message) => message.up && message.error).length, 1, "attempt 1 stalled");
  upload(tab, new Blob([patterned(10)]));
  assert.deepEqual(srv.read().filter((message) => message.type === "up_start").map((message) => message.n), [1, 2]);
  const before = tab.received.length;
  // The worker sees the actual server payload, not a hand-added generation tag.
  srv.line(JSON.stringify(oldError));
  await settle();
  assert.equal(tab.received.length, before, "the queued host error does not fail Retry");
  assert.equal(chunks(srv.socket).length, 0, "Retry still waits for its own start answer");
  srv.line(JSON.stringify(retryAnswer));
  await settle();
  assert.deepEqual(joined(chunks(srv.socket)), patterned(10), "Retry sends its file");
  for (const message of progress) srv.line(JSON.stringify(message));
  assert.deepEqual(tab.received.filter((message) => message.up).slice(-2), [
    { up: UPLOAD_ID, received: 5, done: false }, { up: UPLOAD_ID, received: 10, done: true },
  ]);
});

test("an up_error tagged with an earlier up_start fails nothing: only the latest start's (or an untagged one) does", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  upload(tab, new Blob([patterned(10)]));
  srv.socket.drop();
  t.mock.timers.tick(1_000);
  srv.welcome({ resumed: true });
  assert.deepEqual(srv.read().filter((message) => message.type === "up_start").map((start) => start.n), [1, 2]);

  const error = { status: 507, code: "upload_write_failed", message: "disk full" };
  srv.line(JSON.stringify({ type: "up_error", id: UPLOAD_ID, ...error, start: 1 }));
  assert.deepEqual(tab.received.filter((message) => message.up), [], "start 1's failure arrived after start 2 went out");
  srv.line(JSON.stringify({ type: "up_error", id: UPLOAD_ID, ...error, start: 2 }));
  assert.deepEqual(tab.received.filter((message) => message.up), [{ up: UPLOAD_ID, error }]);
});

test("a queued up_abort keeps the link until it is written, then the idle link closes", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const { tab, srv } = linked(worker, [running]);
  upload(tab, new Blob([patterned(10)]));
  tab.close(1);
  assert.equal(srv.socket.closeCode, null, "the upload keeps the link");
  // The socket's buffer is full: the abort waits in the sender.
  srv.socket.bufferedAmount = 2 * LINK_LIMITS.pieceBytes;
  tab.send({ op: "up_abort", id: UPLOAD_ID });
  assert.equal(srv.socket.closeCode, null, "closing now would lose the abort");
  t.mock.timers.tick(LINK_LIMITS.flushMs);
  assert.equal(srv.socket.closeCode, null);
  srv.socket.bufferedAmount = 0;
  t.mock.timers.tick(LINK_LIMITS.flushMs);
  assert.deepEqual(srv.read().filter((message) => message.type === "up_abort").map((message) => message.id), [UPLOAD_ID]);
  assert.equal(srv.socket.closeCode, 1000, "written, nothing left for the link");
});
