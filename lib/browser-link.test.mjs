import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setImmediate } from "node:timers/promises";

// Hello reads the browserTransport setting and `hosts` the registry; keep both off the real agent dir.
const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-browser-link-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const { browserLink, browserLinkLimits, browserLinkTimings, DEDUPE_MAX } = await import("./browser-link.ts");
const upgradeRoute = await import("../app/api/events/link/route.ts");
const { serverId } = await import("./event-stream-hub.ts");
const { COMMAND_DEDUPE_MS } = await import("./event-stream-protocol.ts");
const { LINK_LIMITS, PartJoiner, queuedLine, SeqWindow, withSeq } = await import("./hosts/link-protocol.ts");

/** Bun's ServerWebSocket as the handler sees it: records frames and the first close; `full` makes send report backpressure. */
function fakeSocket(owner = "open", { sendThrows = () => false } = {}) {
  const ws = {
    data: { kind: "browser", owner, link: null },
    sent: [],
    closed: null,
    full: false,
    send(text) {
      if (sendThrows(text)) throw new Error("send failed");
      ws.sent.push(text);
      return ws.full ? -1 : text.length;
    },
    close(code, reason) {
      ws.closed ??= { code, reason };
    },
  };
  return ws;
}

const frame = (ws, message) => browserLink.message(ws, typeof message === "string" ? message : JSON.stringify(message));

/** The browser's side of a link across its sockets: applies sequenced lines once (parts joined) and acks them. */
function browser() {
  const down = new SeqWindow();
  const parts = new PartJoiner(Infinity);
  const read = new Map();
  const applied = [];
  let upSeq = 0;
  const self = {
    applied,
    control: [],
    ws: null,
    /** Dials and says hello; the welcome comes back at once. */
    connect(t, { owner = "open", token = self.welcome?.token ?? null } = {}) {
      const ws = fakeSocket(owner);
      browserLink.open(ws);
      t.after(() => browserLink.close(ws));
      self.ws = ws;
      frame(ws, { type: "hello", v: 1, token, ack: down.acked });
      self.welcome = JSON.parse(ws.sent[0]);
      read.set(ws, 1);
      if (!self.welcome.resumed) self.reset();
      return ws;
    },
    /** A resync starts both directions over. */
    reset() {
      Object.assign(down, new SeqWindow());
      upSeq = 0;
    },
    /** Applies what the server sent since the last read. */
    read(ws = self.ws) {
      for (let i = read.get(ws); i < ws.sent.length; i++) {
        const message = JSON.parse(ws.sent[i]);
        if (!("seq" in message)) self.control.push(message);
        else if (down.applied(message.seq)) {
          if (message.type !== "part") applied.push(message);
          else {
            const line = parts.add(message);
            if (line !== null) applied.push(JSON.parse(line));
          }
        }
      }
      read.set(ws, ws.sent.length);
      return applied;
    },
    ack(ws = self.ws) {
      self.read(ws);
      frame(ws, { type: "ack", ack: down.acked });
    },
    /** A sequenced message, numbered as the worker's LinkSender would. */
    send(body, seq = ++upSeq) {
      frame(self.ws, withSeq(queuedLine(JSON.stringify(body)), seq).trimEnd());
      return seq;
    },
    events: (name) => applied.filter((message) => message.type === "e" && (name === undefined || message.name === name)),
    replies: () => applied.filter((message) => message.type === "reply"),
  };
  return self;
}

// performance.now, not Date.now: a test mocks Date.now.
async function until(predicate, what) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await setImmediate();
  }
}

/** Waits until `predicate` holds over what `peer` has applied. */
const settled = (peer, predicate, what) => until(() => (peer.read(), predicate()), what);

function withSession(t, id, session) {
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(id, session);
  t.after(() => globalThis.__ompSessions.delete(id));
}

/** A live idle wrapper: its session channel (`emit` sends an event) and its commands (recorded in `sent`). */
function fakeWrapper({ send } = {}) {
  const self = {
    advisorSpawned: false,
    sent: [],
    destroyed: 0,
    emit: null,
    detached: 0,
    isAlive: () => true,
    isRunning: () => false,
    isEditingHistory: () => false,
    getStreamSnapshot: () => ({ cursor: { streamId: "stream-1", sequence: 0 } }),
    onEvent(fn) {
      self.emit = fn;
      return () => {
        self.detached += 1;
        self.emit = null;
      };
    },
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

/** A browser subscribed to the session channel of `id` as s1, every frame so far acked. */
async function watching(t, id, wrapper = fakeWrapper()) {
  withSession(t, id, wrapper);
  const peer = browser();
  peer.connect(t);
  peer.send({ type: "sub", id: "s1", channel: { kind: "session", sessionId: id } });
  await settled(peer, () => peer.events("s1").length === 1, "the session's connected frame");
  peer.ack();
  return { peer, wrapper };
}

test("a hello without a token gets a fresh link: welcome, then the connection's hello as seq 1", (t) => {
  const peer = browser();
  const ws = peer.connect(t);
  assert.match(peer.welcome.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual({ ...peer.welcome, token: "t" }, { type: "welcome", v: 1, token: "t", serverId: serverId(), resumed: false, ack: 0 });
  const [hello] = peer.read();
  assert.equal(hello.seq, 1);
  assert.equal(hello.name, "mux");
  assert.deepEqual({ ...hello.data, connectionId: "c" }, { type: "hello", connectionId: "c", serverId: serverId(), transport: "sse" });
  assert.equal(ws.closed, null);
});

test("sub opens a channel and every frame is answered with an ack; a refused sub answers refused", async (t) => {
  const peer = browser();
  peer.connect(t);
  peer.send({ type: "sub", id: "s2", channel: { kind: "hosts" } });
  assert.ok(peer.ws.sent.map((text) => JSON.parse(text)).some((m) => m.type === "ack" && m.ack === 1), "the sub is acked");
  await settled(peer, () => peer.events("s2").length === 1, "the hosts snapshot");
  assert.deepEqual(peer.events("mux").map((m) => m.data.type), ["hello", "open"]);
  assert.deepEqual(peer.events("s2")[0].data.hosts.map((host) => host.id), ["local"]);

  peer.send({ type: "sub", id: "s3", channel: { kind: "bogus" } });
  peer.send({ type: "sub", id: "s4", channel: { kind: "session", sessionId: "not-managed-here" } });
  await settled(peer, () => peer.events("mux").length === 4, "both refusals");
  assert.deepEqual(peer.events("mux").slice(2).map((m) => m.data), [
    { type: "refused", sub: "s3", status: 400, error: "Invalid event stream request", code: "invalid_event_stream_request" },
    { type: "refused", sub: "s4", status: 409, error: "Session is not managed by omp-web", code: "session_not_managed" },
  ]);
  assert.equal(peer.ws.closed, null);
});

test("a command reply passes a large event backlog on a slow peer, and control frames pass the full window", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-backlog", fakeWrapper({ send: async () => ({ model: "m" }) }));
  const mark = peer.ws.sent.length;
  // Eight 1 MiB tool results queue behind each other on s1.
  for (let i = 0; i < 8; i++) wrapper.emit({ type: "tool_execution_end", i, result: "x".repeat(1024 * 1024) });
  peer.send({ type: "cmd", rid: "r1", session: "sess-backlog", advisor: false, command: { type: "get_state" } });
  await until(() => wrapper.sent.length === 1, "the command to run");
  await setImmediate();

  // The window is full and the peer reads nothing: a clock ping is still answered at once.
  const before = peer.ws.sent.length;
  frame(peer.ws, { type: "ping", c: 7 });
  assert.deepEqual(pick(JSON.parse(peer.ws.sent[before]), ["type", "c"]), { type: "pong", c: 7 });

  // The slow peer acks what arrived, one round at a time, until the reply is among it.
  let rounds = 0;
  while (peer.read() && peer.replies().length === 0) {
    assert.ok(rounds++ < 40, "the reply never came");
    peer.ack();
  }
  assert.deepEqual(peer.replies()[0].data, { success: true, data: { model: "m" } });
  // Ahead of it on the wire: about the window and a piece of the 8 MiB, not the backlog.
  const at = peer.ws.sent.findIndex((text) => text.startsWith('{"type":"reply"'));
  const ahead = peer.ws.sent.slice(mark, at).filter((text) => JSON.parse(text).seq !== undefined).join("").length;
  assert.ok(ahead <= LINK_LIMITS.unackedBytes + 2 * LINK_LIMITS.pieceBytes, `${ahead} bytes ahead of the reply`);
  // The backlog still arrives whole and in order.
  while (peer.read() && peer.events("s1").length < 9) peer.ack();
  assert.deepEqual(peer.events("s1").slice(1).map((m) => m.data.i), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("a dropped socket resumes: the new socket gets exactly the frames the peer missed, without a re-subscribe", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-resume");
  wrapper.emit({ type: "message_start", n: 1 });
  peer.read();
  // Written to the socket but lost in flight: the peer never applies it there.
  wrapper.emit({ type: "message_end", n: 2 });
  browserLink.close(peer.ws);
  wrapper.emit({ type: "tool_execution_start", n: 3 });
  wrapper.emit({ type: "tool_execution_end", n: 4 });

  const ws = peer.connect(t);
  assert.equal(peer.welcome.resumed, true);
  wrapper.emit({ type: "agent_end", n: 5 });
  peer.read();
  assert.deepEqual(peer.events("s1").map((m) => m.data.n ?? m.data.type), ["connected", 1, 2, 3, 4, 5]);
  // On the new socket: the lost frame, the two queued while it was gone and the new one, each once.
  assert.deepEqual(ws.sent.slice(1).map((text) => JSON.parse(text).data?.n), [2, 3, 4, 5]);
  assert.deepEqual(peer.events("mux").map((m) => m.data.type), ["hello", "open"], "no second open: nothing was re-subscribed");
  assert.equal(wrapper.detached, 0);
});

test("on resume the browser's unacked lines are resent and a seq already applied runs once", async (t) => {
  const wrapper = fakeWrapper({ send: async () => ({ done: true }) });
  const { peer } = await watching(t, "sess-resend", wrapper);
  const cmd = { type: "cmd", rid: "r1", session: "sess-resend", advisor: false, command: { type: "set_model", provider: "p", modelId: "m" } };
  const seq = peer.send(cmd);
  await until(() => wrapper.sent.length === 1, "the command");
  browserLink.close(peer.ws);
  peer.connect(t);
  assert.equal(peer.welcome.ack, seq, "the welcome tells the browser what was applied");
  peer.send(cmd, seq);
  await until(() => peer.read() && peer.replies().length === 1, "the reply");
  await setImmediate();
  assert.equal(wrapper.sent.length, 1);
  assert.equal(peer.read() && peer.replies().length, 1, "one reply, sent on the socket that was there");
});

test("resume TTL: a link whose socket stays gone is dropped; its token then gets a fresh link and the channel is released", async (t) => {
  const saved = browserLinkTimings.resumeMs;
  browserLinkTimings.resumeMs = 20;
  t.after(() => (browserLinkTimings.resumeMs = saved));
  const { peer, wrapper } = await watching(t, "sess-ttl");
  const { token } = peer.welcome;
  browserLink.close(peer.ws);
  await until(() => wrapper.detached === 1, "the subscription's release");
  peer.connect(t, { token });
  assert.equal(peer.welcome.resumed, false);
  assert.notEqual(peer.welcome.token, token);
  assert.equal(peer.welcome.ack, 0);
  assert.deepEqual(peer.read().at(-1).seq, 1, "numbering starts over");
});

test("backlog overflow drops the link: the socket closes 4410 and its token gets a fresh link", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-overflow");
  const { token } = peer.welcome;
  const chunk = "x".repeat(4 * 1024 * 1024);
  for (let i = 0; i * chunk.length <= browserLinkLimits.backlogBytes + chunk.length && peer.ws.closed === null; i++) wrapper.emit({ type: "tool_execution_end", chunk });
  assert.equal(peer.ws.closed?.code, 4410);
  assert.equal(wrapper.detached, 1);
  peer.connect(t, { token });
  assert.equal(peer.welcome.resumed, false);
});

test("an unknown token (a restarted server forgot its links) gets a fresh link", (t) => {
  const peer = browser();
  peer.connect(t, { token: "A".repeat(43) });
  assert.equal(peer.welcome.resumed, false);
  assert.notEqual(peer.welcome.token, "A".repeat(43));
});

test("a token from another web session is refused, and the owner's link is left alone", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-owner");
  const { token } = peer.welcome;
  browserLink.close(peer.ws);
  wrapper.emit({ type: "message_end", n: 1 });

  const intruder = browser();
  intruder.connect(t, { owner: "session:other", token });
  assert.equal(intruder.welcome.resumed, false);
  assert.notEqual(intruder.welcome.token, token);
  assert.deepEqual(intruder.read().map((m) => m.name), ["mux"], "only its own hello, nothing of the owner's");

  peer.connect(t, { token });
  assert.equal(peer.welcome.resumed, true);
  assert.deepEqual(peer.read().filter((m) => m.name === "s1").at(-1).data, { type: "message_end", n: 1 });
});

test("the upgrade binds the socket to its web session: the cookie's hash, else trusted or open", () => {
  const seen = [];
  const upgrade = (data) => (seen.push(data), true);
  const get = (headers, up = upgrade) => upgradeRoute.GET(new Request("http://omp.test/api/events/link", { headers }), { upgrade: up });
  assert.equal(get({}, () => false).status, 426);
  assert.equal(get({ cookie: "omp_web_session=abc; other=1" }), undefined);
  assert.equal(get({ "x-omp-web-auth": "nope" }), undefined);
  const hash = createHash("sha256").update("abc").digest("base64url");
  assert.deepEqual(seen, [{ kind: "browser", owner: `session:${hash}`, link: null }, { kind: "browser", owner: "open", link: null }]);
});

test("a command resent after a resync runs once: the (session, rid) dedupe replays its reply", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  const wrapper = fakeWrapper({ send: async () => ({ ran: true }) });
  withSession(t, "sess-dup", wrapper);
  const cmd = { type: "cmd", rid: "same", session: "sess-dup", advisor: false, command: { type: "set_model", provider: "p", modelId: "m" } };
  const first = browser();
  first.connect(t);
  first.send(cmd);
  await until(() => first.read() && first.replies().length === 1, "the first reply");

  const second = browser();
  second.connect(t, { token: null });
  second.send(cmd);
  await until(() => second.read() && second.replies().length === 1, "the replay");
  assert.deepEqual(second.replies()[0].data, { success: true, data: { ran: true } });
  assert.equal(second.replies()[0].deduped, true);
  assert.equal(first.replies()[0].deduped, false);
  assert.equal(wrapper.sent.length, 1);
});

test("a reply carries status, body, recvAt and its time; a bad session answers 400 and the link stays", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  const wrapper = fakeWrapper({ send: async () => ({ model: "m" }) });
  withSession(t, "sess-reply", wrapper);
  const peer = browser();
  peer.connect(t);
  const before = Date.now();
  peer.send({ type: "cmd", rid: "reply-1", session: "sess-reply", advisor: false, command: { type: "get_state" } });
  peer.send({ type: "cmd", rid: "reply-2", session: "sess-reply", advisor: false, command: {} });
  for (const session of [undefined, "", 42, "x".repeat(513)]) peer.send({ type: "cmd", rid: "bad", session, advisor: false, command: { type: "get_state" } });
  await until(() => peer.read() && peer.replies().length === 6, "every reply");
  const byRid = (rid) => peer.replies().filter((reply) => reply.rid === rid);
  const [[ok], [invalid], bad] = [byRid("reply-1"), byRid("reply-2"), byRid("bad")];
  assert.equal(bad.length, 4);
  assert.deepEqual(pick(ok, ["rid", "status", "deduped", "data"]), { rid: "reply-1", status: 200, deduped: false, data: { success: true, data: { model: "m" } } });
  assert.ok(ok.recvAt >= before && ok.recvAt <= ok.at && ok.at <= Date.now());
  assert.deepEqual(pick(invalid, ["rid", "status", "data"]), { rid: "reply-2", status: 400, data: { error: "command type is required", code: "command_type_required" } });
  for (const reply of bad) assert.deepEqual(pick(reply, ["status", "data"]), { status: 400, data: { error: "Invalid event stream request", code: "invalid_event_stream_request" } });
  assert.equal(peer.ws.closed, null);
});

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

test("one rid runs once: a duplicate joins in flight, a later one replays; past COMMAND_DEDUPE_MS it runs again", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const wrapper = fakeWrapper({ send: async (command) => (command.type === "hold" ? held : {}) });
  withSession(t, "sess-dedupe", wrapper);
  const peer = browser();
  peer.connect(t);
  const cmd = { type: "cmd", rid: "r1", session: "sess-dedupe", advisor: false, command: { type: "hold" } };
  peer.send(cmd);
  peer.send(cmd);
  release({ done: true });
  await until(() => peer.read() && peer.replies().length === 2, "both replies");
  assert.deepEqual(peer.replies().map((reply) => reply.deduped), [false, true]);
  assert.equal(wrapper.sent.length, 1);

  const now = Date.now();
  t.mock.method(Date, "now", () => now + COMMAND_DEDUPE_MS + 1);
  peer.send({ ...cmd, command: { type: "quick" } });
  await until(() => peer.read() && peer.replies().length === 3, "the expired rid's reply");
  assert.equal(peer.replies()[2].deduped, false);
  assert.equal(wrapper.sent.length, 2);
  t.mock.restoreAll();
});

test("dedupe entries beyond DEDUPE_MAX drop the oldest settled first, never one in flight", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const wrapper = fakeWrapper({ send: async (command) => (command.type === "hold" ? held : {}) });
  withSession(t, "sess-cap", wrapper);
  const peer = browser();
  peer.connect(t);
  const cmd = (rid, type = "quick") => ({ type: "cmd", rid, session: "sess-cap", advisor: false, command: { type } });
  peer.send(cmd("in-flight", "hold"));
  for (let i = 0; i < DEDUPE_MAX - 1; i++) peer.send(cmd(`r${i}`));
  await until(() => wrapper.sent.length === DEDUPE_MAX, "the settled commands");
  await setImmediate();
  peer.send(cmd("newest"));
  peer.send(cmd("r0"));
  await until(() => wrapper.sent.length === DEDUPE_MAX + 2, "r0 to run again");
  peer.send(cmd("in-flight", "hold"));
  release({});
  await until(() => peer.read() && peer.replies().filter((reply) => reply.rid === "in-flight").length === 2, "both in-flight replies");
  assert.equal(wrapper.sent.length, DEDUPE_MAX + 2, "the in-flight rid was kept and joined");
});

test("bad frames close the socket: 1008 before a hello, 4426 for another version, 1007 malformed, 1009 over a piece, 1011 when a handler throws", async (t) => {
  const closedBy = (messages, ws = fakeSocket()) => {
    t.after(() => browserLink.close(ws));
    for (const message of messages) frame(ws, message);
    return ws.closed?.code;
  };
  const hello = { type: "hello", v: 1, token: null, ack: 0 };
  assert.equal(closedBy([{ type: "ping", c: 1 }]), 1008);
  assert.equal(closedBy([{ ...hello, v: 2 }]), 4426);
  for (const bad of ["{", "null", JSON.stringify({ type: "sub", seq: 1.5, id: "s1" }), JSON.stringify({ type: "unsub", seq: 1, id: "mux" }), JSON.stringify({ type: "cmd", seq: 1, rid: "", session: "s" }), JSON.stringify({ type: "part", seq: 1, at: 0, end: true, data: "{" })]) {
    assert.equal(closedBy([hello, bad]), 1007, bad);
  }
  assert.equal(closedBy([hello, new Uint8Array([123, 125])]), 1007);
  // Counted in UTF-8 bytes: fewer characters than a piece, more bytes.
  assert.equal(closedBy([hello, JSON.stringify({ type: "ping", c: 1, pad: "€".repeat(LINK_LIMITS.pieceBytes / 2) })]), 1009);

  const logged = t.mock.method(console, "error", () => {});
  const throwing = fakeSocket("open", { sendThrows: (text) => text.includes('"type":"pong"') });
  assert.equal(closedBy([hello, { type: "ping", c: 1 }], throwing), 1011);
  assert.equal(logged.mock.callCount(), 1);
});

test("liveness: the server pings every pingMs, and a socket silent for offlineMs is closed; its link stays resumable", async (t) => {
  const saved = { ...browserLinkTimings };
  Object.assign(browserLinkTimings, { pingMs: 15, offlineMs: 60 });
  t.after(() => Object.assign(browserLinkTimings, saved));
  const peer = browser();
  const ws = peer.connect(t);
  await until(() => ws.sent.some((text) => JSON.parse(text).type === "ping"), "a ping");
  const ping = JSON.parse(ws.sent.find((text) => JSON.parse(text).type === "ping"));
  assert.ok(Number.isFinite(ping.at));
  assert.equal(ping.seq, undefined, "control frames skip the queues");
  await until(() => ws.closed !== null, "the offline close");
  peer.connect(t);
  assert.equal(peer.welcome.resumed, true);
});

test("while the socket is gone message updates merge, and the merged one arrives on resume", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-coalesce");
  browserLink.close(peer.ws);
  wrapper.emit({ type: "message_update", messageId: "m1", text: "a" });
  wrapper.emit({ type: "message_update", messageId: "m1", text: "ab" });
  // Nothing was unacked, so no ack would come: the reattach itself sends what merged meanwhile.
  peer.connect(t);
  peer.read();
  assert.deepEqual(peer.events("s1").slice(1).map((m) => m.data), [{ type: "message_update", messageId: "m1", text: "ab" }]);
});

test("unsub releases a subscription at once", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-unsub");
  peer.send({ type: "unsub", id: "s1" });
  assert.equal(wrapper.detached, 1);
});

test("a browser done with its link closes 1000 or 1001 and the link ends at once; a drop keeps it", async (t) => {
  for (const [code, kept] of [[1000, false], [1001, false], [1006, true], [4000, true]]) {
    const { peer, wrapper } = await watching(t, `sess-close-${code}`);
    browserLink.close(peer.ws, code);
    assert.equal(wrapper.detached, kept ? 0 : 1, `close ${code}`);
    peer.connect(t);
    assert.equal(peer.welcome.resumed, kept, `close ${code}`);
  }
});

test("read-only commands are not remembered: the same rid runs again and takes no dedupe slot", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  const wrapper = fakeWrapper({ send: async () => ({ ok: 1 }) });
  withSession(t, "sess-read", wrapper);
  const peer = browser();
  peer.connect(t);
  for (const type of ["get_state", "get_state", "predict_word"]) peer.send({ type: "cmd", rid: "r-read", session: "sess-read", advisor: false, command: { type } });
  await settled(peer, () => peer.replies().length === 3, "three replies");
  assert.deepEqual(peer.replies().map((reply) => reply.deduped), [false, false, false]);
  assert.equal(wrapper.sent.length, 3);
  assert.equal(globalThis.__ompBrowserCommands?.size ?? 0, 0);
});

test("past the process-wide backlog budget the oldest detached link is dropped; attached and newer detached links stay", async (t) => {
  const saved = { ...browserLinkLimits };
  t.after(() => Object.assign(browserLinkLimits, saved));
  const a = await watching(t, "sess-budget-a");
  const b = await watching(t, "sess-budget-b");
  const c = await watching(t, "sess-budget-c");
  const [tokenA, tokenB] = [a.peer.welcome.token, b.peer.welcome.token];
  browserLink.close(a.peer.ws);
  browserLink.close(b.peer.ws);
  browserLinkLimits.totalBacklogBytes = 3.5 * 1024 * 1024;
  const mib = "x".repeat(1024 * 1024);
  a.wrapper.emit({ type: "tool_execution_end", mib });
  b.wrapper.emit({ type: "tool_execution_end", mib });
  assert.equal(a.wrapper.detached + b.wrapper.detached, 0, "under the budget");
  // The attached link's unread 2 MiB takes the total over: the oldest detached link goes, and only it.
  c.wrapper.emit({ type: "tool_execution_end", mib, more: mib });
  assert.deepEqual([a.wrapper.detached, b.wrapper.detached, c.wrapper.detached], [1, 0, 0]);
  assert.equal(c.peer.ws.closed, null);
  a.peer.connect(t, { token: tokenA });
  assert.equal(a.peer.welcome.resumed, false, "its browser resyncs");
  b.peer.connect(t, { token: tokenB });
  assert.equal(b.peer.welcome.resumed, true);
});

test("a socket that sends no hello within helloMs is closed 1008; one that did stays", async (t) => {
  const saved = browserLinkTimings.helloMs;
  browserLinkTimings.helloMs = 20;
  t.after(() => (browserLinkTimings.helloMs = saved));
  const silent = fakeSocket();
  t.after(() => browserLink.close(silent));
  browserLink.open(silent);
  const peer = browser();
  const ws = peer.connect(t);
  await until(() => silent.closed !== null, "the silent socket's close");
  assert.deepEqual(silent.closed, { code: 1008, reason: "No hello" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ws.closed, null);
});

test("Bun's backpressure (-1) holds further lines until drain; then they go in order", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-drain");
  peer.ws.full = true;
  const mark = peer.ws.sent.length;
  for (let n = 1; n <= 3; n++) wrapper.emit({ type: "message_end", n });
  assert.equal(peer.ws.sent.length, mark + 1, "the line Bun queued, then nothing until drain");
  peer.ws.full = false;
  browserLink.drain(peer.ws);
  peer.read();
  assert.deepEqual(peer.events("s1").slice(1).map((m) => m.data.n), [1, 2, 3]);
});

test("a second socket for the same link replaces the first with 4409, and the old socket's frames are ignored", async (t) => {
  const wrapper = fakeWrapper({ send: async () => ({}) });
  const { peer } = await watching(t, "sess-replace", wrapper);
  const old = peer.ws;
  peer.connect(t);
  assert.equal(peer.welcome.resumed, true);
  assert.deepEqual(old.closed, { code: 4409, reason: "Replaced by a newer socket" });
  frame(old, withSeq(queuedLine(JSON.stringify({ type: "cmd", rid: "stale", session: "sess-replace", advisor: false, command: { type: "set_model", provider: "p", modelId: "m" } })), 99).trimEnd());
  await setImmediate();
  assert.equal(wrapper.sent.length, 0);
});

test("a trusted-header request without a session cookie is owned by `trusted`; a wrong header is `open`", (t) => {
  const saved = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = createHash("sha256").update("proxy-secret").digest("hex");
  t.after(() => {
    if (saved === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
    else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = saved;
  });
  const seen = [];
  for (const secret of ["proxy-secret", "wrong"]) {
    upgradeRoute.GET(new Request("http://omp.test/api/events/link", { headers: { "x-omp-web-auth": secret } }), { upgrade: (data) => (seen.push(data.owner), true) });
  }
  assert.deepEqual(seen, ["trusted", "open"]);
});

test("replies of different sessions are sent fair: a small one passes another session's large reply", async (t) => {
  globalThis.__ompBrowserCommands?.clear();
  withSession(t, "sess-big", fakeWrapper({ send: async () => ({ text: "x".repeat(3 * 1024 * 1024) }) }));
  withSession(t, "sess-small", fakeWrapper({ send: async () => ({ ok: true }) }));
  const peer = browser();
  peer.connect(t);
  peer.ack();
  const cmd = (rid, session) => ({ type: "cmd", rid, session, advisor: false, command: { type: "set_model", provider: "p", modelId: "m" } });
  peer.send(cmd("big", "sess-big"));
  peer.send(cmd("small", "sess-small"));
  await until(() => peer.ws.sent.some((text) => text.startsWith('{"type":"part"')), "the big reply going out");
  await setImmediate();
  for (let i = 0; i < 40 && !(peer.read() && peer.replies().length === 2); i++) peer.ack();
  const small = peer.ws.sent.findIndex((text) => text.includes('"rid":"small"'));
  const lastPart = peer.ws.sent.findLastIndex((text) => text.startsWith('{"type":"part"'));
  assert.ok(small >= 0 && small < lastPart, `the small reply (line ${small}) went before the big one ended (line ${lastPart})`);
});

test("a resume whose hello acks past what the server sent is clamped to it: later frames still arrive once", async (t) => {
  const { peer, wrapper } = await watching(t, "sess-clamp");
  wrapper.emit({ type: "message_end", n: 1 });
  browserLink.close(peer.ws);
  wrapper.emit({ type: "message_end", n: 2 });
  const ws = fakeSocket();
  t.after(() => browserLink.close(ws));
  browserLink.open(ws);
  frame(ws, { type: "hello", v: 1, token: peer.welcome.token, ack: Number.MAX_SAFE_INTEGER });
  assert.equal(JSON.parse(ws.sent[0]).resumed, true);
  wrapper.emit({ type: "message_end", n: 3 });
  const lines = () => ws.sent.slice(1).map((text) => JSON.parse(text)).filter((m) => m.type === "e");
  // n: 1 counts as acked (the clamp acks what was sent); n: 2 and 3 follow, numbered on from what was sent.
  assert.deepEqual(lines().map((m) => [m.seq, m.data.n]), [[5, 2], [6, 3]]);
  frame(ws, { type: "ack", ack: 6 });
  wrapper.emit({ type: "message_end", n: 4 });
  assert.deepEqual(lines().at(-1).data.n, 4, "the window opened again");
});

test("the budget keeps a link that was detached and has resumed, however old its detach", async (t) => {
  globalThis.__ompBrowserLinks?.clear();
  const saved = { ...browserLinkLimits };
  t.after(() => Object.assign(browserLinkLimits, saved));
  const a = await watching(t, "sess-budget-resumed-a");
  const b = await watching(t, "sess-budget-resumed-b");
  const tokenA = a.peer.welcome.token;
  browserLink.close(a.peer.ws);
  browserLink.close(b.peer.ws);
  a.peer.connect(t, { token: tokenA });
  assert.equal(a.peer.welcome.resumed, true);
  browserLinkLimits.totalBacklogBytes = 2.5 * 1024 * 1024;
  const mib = "x".repeat(1024 * 1024);
  b.wrapper.emit({ type: "tool_execution_end", mib });
  a.wrapper.emit({ type: "tool_execution_end", mib, more: mib });
  assert.deepEqual([a.wrapper.detached, b.wrapper.detached], [0, 1], "the detached one goes, not the resumed one detached before it");
});

test("the budget drops only detached links with bytes to free: empty ones stay when attached links alone are over", async (t) => {
  globalThis.__ompBrowserLinks?.clear();
  const saved = { ...browserLinkLimits };
  t.after(() => Object.assign(browserLinkLimits, saved));
  const idle = await watching(t, "sess-budget-idle");
  const busy = await watching(t, "sess-budget-busy");
  browserLink.close(idle.peer.ws);
  browserLinkLimits.totalBacklogBytes = 1024 * 1024;
  busy.wrapper.emit({ type: "tool_execution_end", mib: "x".repeat(2 * 1024 * 1024) });
  assert.deepEqual([idle.wrapper.detached, busy.wrapper.detached], [0, 0]);
  idle.peer.connect(t, { token: idle.peer.welcome.token });
  assert.equal(idle.peer.welcome.resumed, true);
});
