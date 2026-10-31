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

const { browserSocket, handleBrowserSocketUpgrade, DEDUPE_MAX, DEDUPE_WINDOW_MS, MAX_COMMAND_FRAME_BYTES, WS_COALESCE_BYTES } = await import("./browser-socket.ts");
const { getEventStreamConnection, serverId } = await import("./event-stream-hub.ts");

/** Bun's ServerWebSocket as the handler sees it: records frames and the first close. */
function fakeSocket(sessionId = null, { sendThrows = () => false } = {}) {
  const ws = {
    data: { kind: "browser", sessionId, connection: null },
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
function opened(t, sessionId = null, options) {
  const ws = fakeSocket(sessionId, options);
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
  assert.deepEqual(hello.data, { type: "hello", connectionId: ws.data.connection.id, serverId: serverId(), transport: "sse" });
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

test("cmd on a session socket acks, then replies with the route's status and body", async (t) => {
  const live = fakeWrapper({ advisorSpawned: true, send: async () => ({ model: "m" }) });
  withSession(t, "sess-reply", live);
  const ws = opened(t, "sess-reply");
  message(ws, { t: "cmd", rid: "reply-1", advisor: true, command: { type: "get_state" } });
  await until(() => ws.sent.length === 3, "ack and reply");
  const [ack, reply] = ws.sent.slice(1).map(parse);
  assert.deepEqual([ack.name, ack.data], ["ack", { rid: "reply-1" }]);
  assert.deepEqual([reply.name, reply.data], ["reply", { rid: "reply-1", status: 200, body: { success: true, data: { model: "m" } } }]);
  assert.ok(ack.at <= reply.at);
  // advisor: true matched the idle child's spawn flag: the fast path, no respawn.
  assert.deepEqual(live.sent, [{ type: "get_state" }]);
  assert.equal(live.destroyed, 0);

  // The route's failures come back as its status and body.
  message(ws, { t: "cmd", rid: "reply-2", advisor: true, command: {} });
  await until(() => replies(ws).length === 2, "the 400 reply");
  assert.deepEqual(replies(ws)[1], { rid: "reply-2", status: 400, body: { error: "command type is required", code: "command_type_required" } });
});

test("one rid runs once: a duplicate joins in flight, a later one replays with deduped", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const live = fakeWrapper({ send: async (command) => (command.type === "hold" ? held : {}) });
  withSession(t, "sess-dedupe", live);
  const ws = opened(t, "sess-dedupe");

  const cmd = { t: "cmd", rid: "r1", advisor: false, command: { type: "hold" } };
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

test("entries beyond DEDUPE_MAX drop the oldest settled first, never one in flight", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const live = fakeWrapper({ send: async (command) => (command.type === "hold" ? held : {}) });
  withSession(t, "sess-cap", live);
  const ws = opened(t, "sess-cap");

  message(ws, { t: "cmd", rid: "in-flight", advisor: false, command: { type: "hold" } });
  for (let i = 0; i < DEDUPE_MAX - 1; i++) message(ws, { t: "cmd", rid: `r${i}`, advisor: false, command: { type: "quick" } });
  await until(() => replies(ws).length === DEDUPE_MAX - 1, "the settled replies");
  // The map is full: this one drops r0, the oldest settled.
  message(ws, { t: "cmd", rid: "newest", advisor: false, command: { type: "quick" } });
  await until(() => replies(ws).length === DEDUPE_MAX, "the newest reply");
  assert.equal(live.sent.length, DEDUPE_MAX + 1);

  message(ws, { t: "cmd", rid: "r0", advisor: false, command: { type: "quick" } });
  await until(() => replies(ws).length === DEDUPE_MAX + 1, "r0 again");
  assert.equal(replies(ws).at(-1).deduped, undefined, "r0 was dropped, so it ran again");
  assert.equal(live.sent.length, DEDUPE_MAX + 2);

  message(ws, { t: "cmd", rid: "in-flight", advisor: false, command: { type: "hold" } });
  release({});
  await until(() => replies(ws).filter((reply) => reply.rid === "in-flight").length === 2, "both in-flight replies");
  assert.deepEqual(replies(ws).filter((reply) => reply.rid === "in-flight").map((reply) => reply.deduped), [undefined, true]);
  assert.equal(live.sent.length, DEDUPE_MAX + 2, "the in-flight rid was kept and joined");
});

test("cmd on the general socket is 400 invalid_event_stream_request", (t) => {
  const ws = opened(t);
  message(ws, { t: "cmd", rid: "general-1", advisor: false, command: { type: "get_state" } });
  assert.deepEqual(frames(ws), [
    { name: "ack", data: { rid: "general-1" } },
    { name: "reply", data: { rid: "general-1", status: 400, body: { error: "Invalid event stream request", code: "invalid_event_stream_request" } } },
  ]);
  assert.equal(ws.closed, null);
});

test("bad frames close the socket: 1007 for bad JSON or t, 1009 over MAX_COMMAND_FRAME_BYTES, 1011 when a handler throws", async (t) => {
  const closedBy = (data, sessionId = null, options) => {
    const ws = opened(t, sessionId, options);
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
  const cmd = JSON.stringify({ t: "cmd", rid: "throw-1", advisor: false, command: { type: "get_state" } });
  // A throw inside the handler (the ack) and a rejection after it (the reply) both end only that socket.
  const onAck = closedBy(cmd, "sess-throw", { sendThrows: (text) => text.startsWith("ack ") });
  assert.equal(onAck.closed?.code, 1011);
  const onReply = closedBy(JSON.stringify({ t: "cmd", rid: "throw-2", advisor: false, command: { type: "get_state" } }), "sess-throw", {
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

test("upgrade: 426 without an upgrade, 400 for a bad session, data carries the session id", async () => {
  const request = (query = "") => new Request(`http://omp.test/api/events/ws${query}`);
  const refused = handleBrowserSocketUpgrade(request(), () => false);
  assert.equal(refused.status, 426);

  for (const query of ["?session=", `?session=${"x".repeat(513)}`]) {
    let upgraded = false;
    const response = handleBrowserSocketUpgrade(request(query), () => (upgraded = true));
    assert.equal(response.status, 400, query.slice(0, 20));
    assert.equal((await response.json()).code, "invalid_event_stream_request");
    assert.equal(upgraded, false, "no socket for a bad session id");
  }

  const seen = [];
  const upgrade = (data) => (seen.push(data), true);
  assert.equal(handleBrowserSocketUpgrade(request(), upgrade), undefined);
  assert.equal(handleBrowserSocketUpgrade(request(`?session=${"x".repeat(512)}`), upgrade), undefined);
  assert.deepEqual(seen, [
    { kind: "browser", sessionId: null, connection: null },
    { kind: "browser", sessionId: "x".repeat(512), connection: null },
  ]);
});
