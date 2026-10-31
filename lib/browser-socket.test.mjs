import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setImmediate } from "node:timers/promises";

// Hello reads the browserTransport setting and `hosts` the registry; keep both off the real agent dir.
const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-browser-socket-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const { browserSocket, DEDUPE_MAX, DEDUPE_WINDOW_MS, MAX_COMMAND_FRAME_BYTES, WS_COALESCE_BYTES } = await import("./browser-socket.ts");
const upgradeRoute = await import("../app/api/events/ws/route.ts");
const { getEventStreamConnection, serverId } = await import("./event-stream-hub.ts");

/** Bun's ServerWebSocket as the handler sees it: records frames and the first close. */
function fakeSocket({ sendThrows = () => false } = {}) {
  const ws = {
    data: { kind: "browser", connection: null },
    sent: [],
    closed: null,
    buffered: 0,
    send(text) {
      if (sendThrows(text)) throw new Error("send failed");
      ws.sent.push(text);
      return text.length;
    },
    close(code, reason) {
      ws.closed ??= { code, reason };
    },
    getBufferedAmount: () => ws.buffered,
  };
  return ws;
}

function parse(s) {
  const [head, json] = [s.slice(0, s.indexOf("\n")), s.slice(s.indexOf("\n") + 1)];
  const [name, at] = head.split(" ");
  return { name, at: Number(at), data: JSON.parse(json) };
}

/** Frames after the hello, without their time. */
const frames = (ws) => ws.sent.slice(1).map(parse).map(({ name, data }) => ({ name, data }));

/** A socket the handler opened, closed again when the test ends. */
function opened(t, options) {
  const ws = fakeSocket(options);
  browserSocket.open(ws);
  t.after(() => browserSocket.close(ws));
  return ws;
}

const message = (ws, frame) => browserSocket.message(ws, JSON.stringify(frame));

// performance.now, not Date.now: a test mocks Date.now.
async function until(predicate, what) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await setImmediate();
  }
}

function withSession(t, id, session) {
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(id, session);
  t.after(() => globalThis.__ompSessions.delete(id));
}

/** A live idle wrapper that records what it was sent. */
function fakeWrapper({ advisorSpawned = false, send } = {}) {
  const self = {
    advisorSpawned,
    sent: [],
    destroyed: 0,
    isAlive: () => true,
    isRunning: () => false,
    isEditingHistory: () => false,
    async send(command) {
      self.sent.push(command);
      return send ? send(command) : { ok: true };
    },
    async destroyAndWait() {
      self.destroyed += 1;
    },
  };
  return self;
}

const replies = (ws) => frames(ws).filter((frame) => frame.name === "reply").map((frame) => frame.data);

test("open sends hello with connectionId, serverId and transport", (t) => {
  const before = Date.now();
  const ws = opened(t);
  assert.equal(ws.sent.length, 1);
  const hello = parse(ws.sent[0]);
  assert.equal(hello.name, "mux");
  assert.ok(hello.at >= before && hello.at <= Date.now(), `emit time ${hello.at}`);
  assert.deepEqual(hello.data, { type: "hello", connectionId: ws.data.connection.id, serverId: serverId(), transport: "sse", perSocket: 4, maxSockets: 16 });
  assert.equal(getEventStreamConnection(ws.data.connection.id), ws.data.connection);
});

test("sub opens a channel; a refused sub answers refused and keeps the socket", async (t) => {
  const ws = opened(t);
  message(ws, { t: "sub", id: "s1", channel: { kind: "session", sessionId: "not-managed-here" } });
  await until(() => frames(ws).length === 1, "the refusal");
  assert.deepEqual(frames(ws), [
    { name: "mux", data: { type: "refused", sub: "s1", status: 409, error: "Session is not managed by omp-web", code: "session_not_managed" } },
  ]);
  assert.equal(ws.closed, null);

  // A channel the server cannot parse is refused like the POST's 400.
  message(ws, { t: "sub", id: "s3", channel: { kind: "bogus" } });
  assert.deepEqual(frames(ws)[1], {
    name: "mux",
    data: { type: "refused", sub: "s3", status: 400, error: "Invalid event stream request", code: "invalid_event_stream_request" },
  });

  message(ws, { t: "sub", id: "s2", channel: { kind: "hosts" } });
  await until(() => frames(ws).length === 4, "the hosts snapshot");
  const [, , open, snapshot] = frames(ws);
  assert.deepEqual(open, { name: "mux", data: { type: "open", sub: "s2" } });
  assert.equal(snapshot.name, "s2");
  assert.deepEqual(snapshot.data.hosts.map((host) => host.id), ["local"]);
  assert.equal(ws.closed, null);
});

test("cmd acks, then replies with the route's status and body", async (t) => {
  const live = fakeWrapper({ advisorSpawned: true, send: async () => ({ model: "m" }) });
  withSession(t, "sess-reply", live);
  const ws = opened(t);
  message(ws, { t: "cmd", rid: "reply-1", session: "sess-reply", advisor: true, command: { type: "get_state" } });
  await until(() => ws.sent.length === 3, "ack and reply");
  const [ack, reply] = ws.sent.slice(1).map(parse);
  assert.deepEqual([ack.name, ack.data], ["ack", { rid: "reply-1" }]);
  assert.deepEqual([reply.name, reply.data], ["reply", { rid: "reply-1", status: 200, body: { success: true, data: { model: "m" } } }]);
  assert.ok(ack.at <= reply.at);
  // advisor: true matched the idle child's spawn flag: the fast path, no respawn.
  assert.deepEqual(live.sent, [{ type: "get_state" }]);
  assert.equal(live.destroyed, 0);

  // The route's failures come back as its status and body.
  message(ws, { t: "cmd", rid: "reply-2", session: "sess-reply", advisor: true, command: {} });
  await until(() => replies(ws).length === 2, "the 400 reply");
  assert.deepEqual(replies(ws)[1], { rid: "reply-2", status: 400, body: { error: "command type is required", code: "command_type_required" } });
});

test("one rid runs once: a duplicate joins in flight, a later one replays with deduped", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const live = fakeWrapper({ send: async (command) => (command.type === "hold" ? held : {}) });
  withSession(t, "sess-dedupe", live);
  const ws = opened(t);

  const cmd = { t: "cmd", rid: "r1", session: "sess-dedupe", advisor: false, command: { type: "hold" } };
  message(ws, cmd);
  message(ws, cmd);
  await setImmediate();
  assert.deepEqual(frames(ws), [{ name: "ack", data: { rid: "r1" } }, { name: "ack", data: { rid: "r1" } }]);
  release({ done: true });
  await until(() => replies(ws).length === 2, "both replies");
  const reply = { rid: "r1", status: 200, body: { success: true, data: { done: true } } };
  assert.deepEqual(replies(ws), [reply, { ...reply, deduped: true }]);
  message(ws, cmd);
  await until(() => replies(ws).length === 3, "the replay");
  assert.deepEqual(replies(ws)[2], { ...reply, deduped: true });
  assert.equal(live.sent.length, 1, "one rid reached omp once");

  // Past DEDUPE_WINDOW_MS after it settled, the rid is forgotten and runs again.
  const now = Date.now();
  t.mock.method(Date, "now", () => now + DEDUPE_WINDOW_MS + 1);
  message(ws, { ...cmd, command: { type: "quick" } });
  await until(() => replies(ws).length === 4, "the expired rid's reply");
  assert.equal(replies(ws)[3].deduped, undefined);
  assert.equal(live.sent.length, 2);
  t.mock.restoreAll();
});

test("one socket runs commands of several sessions, each against its own session", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  const a = fakeWrapper({ send: async () => ({ from: "a" }) });
  const b = fakeWrapper({ send: async () => ({ from: "b" }) });
  withSession(t, "multi-a", a);
  withSession(t, "multi-b", b);
  const ws = opened(t);

  message(ws, { t: "cmd", rid: "r1", session: "multi-a", advisor: false, command: { type: "get_state" } });
  message(ws, { t: "cmd", rid: "r2", session: "multi-b", advisor: false, command: { type: "set_model", provider: "p", modelId: "m" } });
  await until(() => replies(ws).length === 2, "both replies");

  assert.deepEqual(a.sent, [{ type: "get_state" }]);
  assert.deepEqual(b.sent, [{ type: "set_model", provider: "p", modelId: "m" }]);
  assert.deepEqual(Object.fromEntries(replies(ws).map(({ rid, ...reply }) => [rid, reply])), {
    r1: { status: 200, body: { success: true, data: { from: "a" } } },
    r2: { status: 200, body: { success: true, data: { from: "b" } } },
  });
});

test("dedupe is per session: the same rid in two sessions runs twice, the same (session, rid) once", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  const a = fakeWrapper({ send: async () => ({ from: "a" }) });
  const b = fakeWrapper({ send: async () => ({ from: "b" }) });
  withSession(t, "per-a", a);
  withSession(t, "per-b", b);
  const first = opened(t);
  const second = opened(t);
  const cmd = (session) => ({ t: "cmd", rid: "same", session, advisor: false, command: { type: "get_state" } });

  message(first, cmd("per-a"));
  message(first, cmd("per-b"));
  await until(() => replies(first).length === 2, "both sessions' replies");
  assert.deepEqual(replies(first).map((reply) => reply.deduped), [undefined, undefined], "neither replays the other");
  // A resend of a known (session, rid), here on the session's next socket, replays instead of running.
  message(second, cmd("per-a"));
  await until(() => replies(second).length === 1, "the replay");
  assert.deepEqual(replies(second), [{ rid: "same", status: 200, body: { success: true, data: { from: "a" } }, deduped: true }]);
  assert.deepEqual([a.sent.length, b.sent.length], [1, 1]);
});

test("entries beyond DEDUPE_MAX drop the oldest settled first, never one in flight", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const live = fakeWrapper({ send: async (command) => (command.type === "hold" ? held : {}) });
  withSession(t, "sess-cap", live);
  const ws = opened(t);

  message(ws, { t: "cmd", rid: "in-flight", session: "sess-cap", advisor: false, command: { type: "hold" } });
  for (let i = 0; i < DEDUPE_MAX - 1; i++) message(ws, { t: "cmd", rid: `r${i}`, session: "sess-cap", advisor: false, command: { type: "quick" } });
  await until(() => replies(ws).length === DEDUPE_MAX - 1, "the settled replies");
  // The map is full: this one drops r0, the oldest settled.
  message(ws, { t: "cmd", rid: "newest", session: "sess-cap", advisor: false, command: { type: "quick" } });
  await until(() => replies(ws).length === DEDUPE_MAX, "the newest reply");
  assert.equal(live.sent.length, DEDUPE_MAX + 1);

  message(ws, { t: "cmd", rid: "r0", session: "sess-cap", advisor: false, command: { type: "quick" } });
  await until(() => replies(ws).length === DEDUPE_MAX + 1, "r0 again");
  assert.equal(replies(ws).at(-1).deduped, undefined, "r0 was dropped, so it ran again");
  assert.equal(live.sent.length, DEDUPE_MAX + 2);

  message(ws, { t: "cmd", rid: "in-flight", session: "sess-cap", advisor: false, command: { type: "hold" } });
  release({});
  await until(() => replies(ws).filter((reply) => reply.rid === "in-flight").length === 2, "both in-flight replies");
  assert.deepEqual(replies(ws).filter((reply) => reply.rid === "in-flight").map((reply) => reply.deduped), [undefined, true]);
  assert.equal(live.sent.length, DEDUPE_MAX + 2, "the in-flight rid was kept and joined");
});

test("a cmd without a valid session is acked and answered 400; the socket stays", async (t) => {
  const ws = opened(t);
  for (const session of [undefined, "", 42, "x".repeat(513)]) {
    message(ws, { t: "cmd", rid: "bad-session", session, advisor: false, command: { type: "get_state" } });
  }
  const answered = [
    { name: "ack", data: { rid: "bad-session" } },
    { name: "reply", data: { rid: "bad-session", status: 400, body: { error: "Invalid event stream request", code: "invalid_event_stream_request" } } },
  ];
  assert.deepEqual(frames(ws), [...answered, ...answered, ...answered, ...answered]);
  assert.equal(ws.closed, null);

  // 512 characters is still a session id.
  const longest = fakeWrapper();
  withSession(t, "x".repeat(512), longest);
  message(ws, { t: "cmd", rid: "longest", session: "x".repeat(512), advisor: false, command: { type: "get_state" } });
  await until(() => replies(ws).length === 5, "the longest id's reply");
  assert.deepEqual(longest.sent, [{ type: "get_state" }]);
});

test("bad frames close the socket: 1007 for bad JSON or t, 1009 over MAX_COMMAND_FRAME_BYTES, 1011 when a handler throws", async (t) => {
  const closedBy = (data, options) => {
    const ws = opened(t, options);
    browserSocket.message(ws, data);
    return ws;
  };
  for (const data of [
    "{",
    "null",
    JSON.stringify({ t: "nope" }),
    JSON.stringify({ t: "sub", id: "mux", channel: { kind: "running" } }),
    JSON.stringify({ t: "unsub", id: 1 }),
    JSON.stringify({ t: "cmd", rid: "", command: { type: "get_state" } }),
    JSON.stringify({ t: "cmd", rid: "x".repeat(65), command: { type: "get_state" } }),
    new Uint8Array([123, 125]),
  ]) {
    const ws = closedBy(data);
    assert.equal(ws.closed?.code, 1007, String(data));
    assert.equal(ws.sent.length, 1, `nothing answered ${data}`);
  }
  // Counted in UTF-8 bytes: fewer characters than the cap, more bytes.
  for (const pad of ["x".repeat(MAX_COMMAND_FRAME_BYTES), "€".repeat(MAX_COMMAND_FRAME_BYTES / 2)]) {
    const ws = closedBy(JSON.stringify({ t: "ping", c: 1, pad }));
    assert.equal(ws.closed?.code, 1009);
    assert.equal(ws.sent.length, 1, "no pong");
  }

  const logged = t.mock.method(console, "error", () => {});
  withSession(t, "sess-throw", fakeWrapper());
  const cmd = JSON.stringify({ t: "cmd", rid: "throw-1", session: "sess-throw", advisor: false, command: { type: "get_state" } });
  // A throw inside the handler (the ack) and a rejection after it (the reply) both end only that socket.
  const onAck = closedBy(cmd, { sendThrows: (text) => text.startsWith("ack ") });
  assert.equal(onAck.closed?.code, 1011);
  const onReply = closedBy(JSON.stringify({ t: "cmd", rid: "throw-2", session: "sess-throw", advisor: false, command: { type: "get_state" } }), {
    sendThrows: (text) => text.startsWith("reply "),
  });
  await until(() => onReply.closed, "the 1011 close");
  assert.equal(onReply.closed.code, 1011);
  assert.equal(logged.mock.callCount(), 2);
});

test("ping answers pong with c", (t) => {
  const ws = opened(t);
  const before = Date.now();
  message(ws, { t: "ping", c: 1234.5 });
  const pong = parse(ws.sent[1]);
  assert.deepEqual([pong.name, pong.data], ["pong", { c: 1234.5 }]);
  assert.ok(pong.at >= before && pong.at <= Date.now());
});

test("close releases every subscription", async (t) => {
  globalThis.__ompRunningListeners ??= new Set();
  const baseline = globalThis.__ompRunningListeners.size;
  const ws = opened(t);
  message(ws, { t: "sub", id: "s1", channel: { kind: "running" } });
  message(ws, { t: "sub", id: "s2", channel: { kind: "running" } });
  await until(() => frames(ws).length === 4, "both subscriptions");
  assert.equal(globalThis.__ompRunningListeners.size, baseline + 2);
  message(ws, { t: "unsub", id: "s1" });
  assert.equal(globalThis.__ompRunningListeners.size, baseline + 1);
  const { connection } = ws.data;
  browserSocket.close(ws);
  assert.equal(globalThis.__ompRunningListeners.size, baseline, "running listeners must not leak past the socket");
  assert.equal(connection.isClosed, true);
  assert.equal(getEventStreamConnection(connection.id), undefined);
});

test("a socket behind by more than WS_COALESCE_BYTES coalesces message updates until drain", async (t) => {
  const session = {
    emit: null,
    isAlive: () => true,
    getStreamSnapshot: () => ({ cursor: { streamId: "test-stream", sequence: 0 } }),
    onEvent(fn) {
      session.emit = fn;
      return () => {};
    },
  };
  withSession(t, "sess-coalesce", session);
  const ws = opened(t);
  message(ws, { t: "sub", id: "s1", channel: { kind: "session", sessionId: "sess-coalesce" } });
  await until(() => frames(ws).length === 2, "open and connected");
  ws.buffered = WS_COALESCE_BYTES + 1;
  session.emit({ type: "message_update", text: "a" });
  session.emit({ type: "message_update", text: "ab" });
  assert.equal(frames(ws).length, 2, "held while behind");
  ws.buffered = 0;
  browserSocket.drain(ws);
  assert.deepEqual(frames(ws).slice(2), [{ name: "s1", data: { type: "message_update", text: "ab" } }]);
});

test("upgrade: 426 without an upgrade; any query upgrades with no session bound", () => {
  const get = (query, upgrade) => upgradeRoute.GET(new Request(`http://omp.test/api/events/ws${query}`), { upgrade });
  assert.equal(get("", () => false).status, 426);

  const seen = [];
  const upgrade = (data) => (seen.push(data), true);
  for (const query of ["", "?session=", `?session=${"x".repeat(513)}`, "?session=a"]) {
    assert.equal(get(query, upgrade), undefined, query.slice(0, 20));
  }
  assert.deepEqual(seen, Array(4).fill({ kind: "browser", connection: null }));
});
