import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// The hub keeps its links on globalThis; every test links its own host.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-hub-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const hub = await import("./hub.ts");
const { encodeBlobFrame, LINK_LIMITS, LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
const { createHost } = await import("./registry.ts");
const { getRpcSession, startRpcSession } = await import("../rpc-manager.ts");
const { resumeOnHostLink } = await import("../session-resume.ts");
const { LinkDriver, linkHost, listedSession, ompChild, until, upgradeSocket } = await import("./link-driver.test-helper.mjs");

const defaultTimings = { ...hub.linkTimings };
test.afterEach(() => Object.assign(hub.linkTimings, defaultTimings));

const URL_BASE = "http://main.test/api/hosts/link";

function hello(overrides = {}) {
  return { type: "hello", v: LINK_PROTOCOL_VERSION, ompVersion: "14.0.0", platform: "linux", home: "/home/u", autoApproveExtension: false, ack: 0, channels: [], ...overrides };
}

/** Open a socket with `token` and send `message` as its first frame. */
function dial(token, message = hello()) {
  const { response, socket } = upgradeSocket(token);
  assert.equal(response, undefined);
  socket.frame(`${JSON.stringify(message)}\n`);
  return socket;
}

/** One frame from the daemon; returns the acks the hub answered it with. */
function frame(socket, text) {
  const before = socket.frames.length;
  socket.frame(text);
  return socket.frames.slice(before).map((sent) => JSON.parse(sent)).filter((message) => message.type === "ack").map((message) => message.ack);
}

/** One uplink frame on `link`'s socket: the daemon's `ack` line, then `messages`. Returns the hub's acks for it. */
function linkPost(link, messages, ack = 0) {
  return frame(link.down.socket, [{ type: "ack", ack }, ...messages].map((m) => `${JSON.stringify(m)}\n`).join(""));
}

/** A pre-WebSocket (v3) daemon's hello POST. */
function outdatedPost(token, body) {
  return hub.handleOutdatedLinkPost(new Request(URL_BASE, { method: "POST", headers: { authorization: `Bearer ${token}` }, body }));
}

/** A body stream that records whether the handler ever read from it. */
function watchedBody() {
  const watched = { pulled: false };
  // Ends on the first read, so a handler that does read it still answers.
  watched.stream = new ReadableStream({
    pull(controller) {
      watched.pulled = true;
      controller.close();
    },
  }, { highWaterMark: 0 });
  return watched;
}

/** Reads a socket one hub message at a time, skipping the hub's acks (linkPost returns those); null once closed. */
function downlink(socket) {
  return {
    socket,
    async next() {
      for (;;) {
        const message = await socket.next();
        if (message?.type !== "ack") return message;
      }
    },
    /** Next message that is not a ping. */
    async nextReal() {
      for (;;) {
        const message = await this.next();
        if (message?.type !== "ping") return message;
      }
    },
    /** The daemon's side of the socket goes away. */
    cancel: () => socket.close(1006),
  };
}

/** Dial a socket; resolves after its welcome. */
async function openLink(token, overrides = {}) {
  const down = downlink(dial(token, hello(overrides)));
  const welcome = await down.next();
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.v, LINK_PROTOCOL_VERSION);
  return { welcome, down };
}

async function linkedHost(label = "Build box", overrides = {}) {
  const { host, token } = createHost(label);
  const { welcome, down } = await openLink(token, overrides);
  assert.deepEqual(welcome, { type: "welcome", v: LINK_PROTOCOL_VERSION, hostId: host.id });
  return { id: host.id, token, down, remote: hub.getHost(host.id) };
}

/** Answer the spawn request the hub sent and return the resolved SpawnResult. */
async function spawnOverLink(link, extraUp = []) {
  const { down, remote } = link;
  const spawning = remote.spawnRpc({ cwd: "/w", recordedCwd: null, sessionFile: "", advisor: false });
  const req = await down.nextReal();
  assert.equal(req.type, "req");
  assert.equal(req.op, "spawn");
  const result = { cwd: "/w", fellBack: false, launchAdvisor: false, autoApproveExtension: true };
  return { req, spawning, result, post: (messages) => linkPost(link, [...extraUp, ...messages], req.seq) };
}

test("a missing, malformed or wrong bearer token gets 401 before any upgrade or body read", async () => {
  createHost("Real");
  for (const authorization of [undefined, "Basic abc", "Bearer ", "Bearer not-a-token"]) {
    const headers = authorization ? { authorization } : {};
    let upgraded = false;
    const refused = hub.handleLinkUpgrade(new Request(URL_BASE, { headers: { ...headers, upgrade: "websocket" } }), () => (upgraded = true));
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: "Invalid host token" });
    assert.equal(upgraded, false, "no socket before the token is verified");
    const postBody = watchedBody();
    const post = new Request(URL_BASE, { method: "POST", headers, body: postBody.stream, duplex: "half" });
    assert.equal((await hub.handleOutdatedLinkPost(post)).status, 401);
    assert.equal(postBody.pulled, false, "the body must not be read before the token is verified");
    assert.equal(post.bodyUsed, false);
  }
});

test("a hello with another version is closed 4426 with the server's version and marks the host needs-upgrade", async () => {
  const { host, token } = createHost("Other version");
  for (const v of [LINK_PROTOCOL_VERSION + 1, 3]) {
    const socket = dial(token, hello({ v }));
    assert.deepEqual(socket.closed, { code: 4426, reason: '{"serverVersion":4}' });
    const listed = hub.listHosts().find((h) => h.id === host.id);
    assert.equal(listed.status, "needs-upgrade");
    // Settings renders "needs upgrade (host vN, server vM)" from these.
    assert.equal(listed.hostVersion, v);
    assert.equal(listed.serverVersion, LINK_PROTOCOL_VERSION);
  }
});

test("a pre-WebSocket daemon's hello POST gets 426 with both versions", async () => {
  const { host, token } = createHost("v3 daemon");
  const refused = await outdatedPost(token, `${JSON.stringify(hello({ v: 3 }))}\n`);
  assert.equal(refused.status, 426);
  assert.deepEqual(await refused.json(), { error: "Link protocol version mismatch", hostVersion: 3, serverVersion: 4 });
  const listed = hub.listHosts().find((h) => h.id === host.id);
  assert.deepEqual([listed.status, listed.hostVersion], ["needs-upgrade", 3]);
  const garbled = await outdatedPost(token, "not json");
  assert.equal(garbled.status, 426);
  assert.deepEqual(await garbled.json(), { error: "Link protocol version mismatch", hostVersion: null, serverVersion: 4 });
});

test("an authenticated request that does not upgrade gets 426", async () => {
  const { token } = createHost("Plain GET");
  const response = hub.handleLinkUpgrade(new Request(URL_BASE, { headers: { authorization: `Bearer ${token}` } }), () => false);
  assert.equal(response.status, 426);
  assert.deepEqual(await response.json(), { error: "The host link is a WebSocket" });
});

test("a first frame that is not a hello closes the socket 1008", async () => {
  const { host, token } = createHost("Not a hello");
  for (const first of [new Uint8Array([1, 2, 3]), "not json", '{"type":"stdout","v":4,"seq":1,"ch":"c","line":"x"}']) {
    const { socket } = upgradeSocket(token);
    socket.frame(first);
    assert.equal(socket.closed?.code, 1008, String(first));
    assert.equal(hub.getHost(host.id).status(), "offline");
  }
});

test("a hello frame listing hundreds of channels links", async () => {
  const { token } = createHost("Busy box");
  const channels = Array.from({ length: 300 }, (_, i) => ({ ch: `ch-${String(i).padStart(4, "0")}`, sessionId: null, cwd: "/w", pending: [] }));
  const { down } = await openLink(token, { channels });
  // The listed children are orphans of a previous run of this server: each gets its kill.
  const kills = [];
  while (kills.length < channels.length) {
    const message = await down.nextReal();
    if (message.type === "kill") kills.push(message.ch);
  }
  assert.deepEqual(kills, channels.map(({ ch }) => ch));
  await down.cancel();
});

test("hello without omp marks the host omp-missing and spawnRpc rejects", async () => {
  const { id, remote, down } = await linkedHost("No omp", { ompVersion: null });
  const listed = hub.listHosts().find((h) => h.id === id);
  assert.equal(listed.status, "omp-missing");
  assert.equal(listed.ompVersion, null);
  assert.equal(listed.platform, "linux");
  assert.equal(listed.hostVersion, LINK_PROTOCOL_VERSION);
  assert.equal(remote.status(), "omp-missing");
  await assert.rejects(remote.spawnRpc({ cwd: "/w", recordedCwd: null, sessionFile: "", advisor: false }), /omp is not installed on No omp/);
  await down.cancel();
});

test("a second link with the same token closes the first socket with 4409, and frames still arriving on it are ignored", async () => {
  const a = await linkedHost("Two daemons");
  assert.deepEqual(linkPost(a, [{ type: "stdout", seq: 500, ch: "none", line: "x" }]), [500]);
  // Daemon B links with the same token: a fresh process (ack 0) restarts the uplink window.
  const b = { ...a, ...(await openLink(a.token, { ack: 0 })) };
  assert.equal(await a.down.next(), null);
  assert.deepEqual(a.down.socket.closed, { code: 4409, reason: "replaced by a newer link" });

  const { req, spawning, result, post } = await spawnOverLink(b);
  assert.deepEqual(post([{ type: "res", seq: 1, id: req.id, ok: true, result }]), [1]);
  const { transport } = await spawning;
  const lines = [];
  transport.onLine((line) => lines.push(line));
  // A's late frame names B's channel and B's next seq: it reaches no transport and takes no seq from B.
  assert.deepEqual(linkPost(a, [{ type: "stdout", seq: 2, ch: req.args.ch, line: "from A" }]), []);
  assert.deepEqual(post([{ type: "stdout", seq: 2, ch: req.args.ch, line: "from B" }]), [2]);
  assert.deepEqual(lines, ["from B"]);
  await b.down.cancel();
});

test("closeHostLink closes the socket, rejects pending ops, exits its children and marks the host offline", async () => {
  const link = await linkedHost("Closing");
  const { req, spawning, result, post } = await spawnOverLink(link);
  await post([{ type: "res", seq: 1, id: req.id, ok: true, result }]);
  const { transport } = await spawning;
  let exited = null;
  transport.onExit((code, signal) => { exited = { code, signal }; });
  const pending = link.remote.sessionOps.listSessions();
  assert.equal((await link.down.nextReal()).op, "listSessions");
  hub.closeHostLink(link.id);
  assert.deepEqual(exited, { code: null, signal: null }, "nothing will report a revoked host's children again");
  assert.equal(await link.down.next(), null);
  assert.equal(link.down.socket.closed.code, 1000);
  await assert.rejects(pending, (error) => error.status === 503);
  assert.equal(link.remote.status(), "offline");
});

test("an op with no answer within opTimeoutMs rejects with 504 naming the host", async () => {
  hub.linkTimings.opTimeoutMs = 30;
  const { remote, down } = await linkedHost("Slow box");
  await assert.rejects(remote.sessionOps.listSessions(), (error) => {
    assert.equal(error.status, 504);
    assert.match(error.message, /Slow box/);
    return true;
  });
  await down.cancel();
});

test("an op that timed out is not resent after the daemon redials", async () => {
  hub.linkTimings.opTimeoutMs = 30;
  const link = await linkedHost("Lid closed");
  // A half-open socket: the req goes out and nothing comes back.
  await assert.rejects(link.remote.sessionOps.deleteSession("s1", []), (error) => error.status === 504);
  await link.down.cancel();
  const again = { token: link.token, ...(await openLink(link.token)) };
  const listing = link.remote.sessionOps.listSessions();
  const next = await again.down.nextReal();
  assert.equal(next.op, "listSessions", "a delete the user saw fail must never run later");
  await linkPost(again, [{ type: "res", seq: 1, id: next.id, ok: true, result: [] }], next.seq);
  assert.deepEqual(await listing, []);
  await again.down.cancel();
});

test("ops pending when the socket closes reject at once and are not resent", async () => {
  hub.linkTimings.opTimeoutMs = 2_000;
  const link = await linkedHost("Lid closing");
  const pending = link.remote.sessionOps.listSessions();
  const first = await link.down.nextReal();
  await link.down.cancel();
  const started = Date.now();
  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "host_offline");
    return true;
  });
  assert.ok(Date.now() - started < hub.linkTimings.opTimeoutMs, "not at the op timeout");
  const again = { token: link.token, ...(await openLink(link.token, { ack: 0 })) };
  const listing = link.remote.sessionOps.listSessions();
  const next = await again.down.nextReal();
  assert.notEqual(next.id, first.id, "a rejected op is not resent");
  await linkPost(again, [{ type: "res", seq: 1, id: next.id, ok: true, result: [] }], next.seq);
  assert.deepEqual(await listing, []);
  await again.down.cancel();
});

test("a version-mismatched dial leaves a healthy link online", async () => {
  const link = await linkedHost("Healthy");
  assert.equal(dial(link.token, hello({ v: 3 })).closed.code, 4426);
  assert.equal((await outdatedPost(link.token, JSON.stringify(hello({ v: 3 })))).status, 426);
  assert.equal(link.remote.status(), "online");
  assert.equal(hub.listHosts().find((h) => h.id === link.id).hostVersion, LINK_PROTOCOL_VERSION);
  assert.equal(link.down.socket.closed, null, "the healthy socket stays open");
  await link.down.cancel();
});

test("output held for a remote child nobody reads yet stops at channelBufferBytes: the child is killed, not buffered on", async () => {
  const saved = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 100;
  try {
    const link = await linkedHost("Chatty");
    const { req, spawning, result, post } = await spawnOverLink(link);
    const { ch } = req.args;
    const line = "x".repeat(40);
    await post([
      { type: "res", seq: 1, id: req.id, ok: true, result },
      { type: "stdout", seq: 2, ch, line },
      { type: "stderr", seq: 3, ch, chunk: line },
      // 121 bytes held with this one: over the cap.
      { type: "stdout", seq: 4, ch, line: `${line}!` },
      { type: "stdout", seq: 5, ch, line },
    ]);
    const { transport } = await spawning;
    const kill = await link.down.nextReal();
    assert.deepEqual([kill.type, kill.ch, kill.force], ["kill", ch, true]);
    // What was held before the cap still reaches the first reader.
    const lines = [];
    const chunks = [];
    transport.onLine((held) => lines.push(held));
    transport.onStderr((held) => chunks.push(held));
    assert.deepEqual(lines, [line]);
    assert.deepEqual(chunks, [line]);
    await link.down.cancel();
  } finally {
    LINK_LIMITS.channelBufferBytes = saved;
  }
});

test("a validateCwd result must carry string paths", async () => {
  const link = await linkedHost("Paths");
  const bad = link.remote.sessionOps.validateCwd("/w");
  const badReq = await link.down.nextReal();
  await linkPost(link, [{ type: "res", seq: 1, id: badReq.id, ok: true, result: { ok: true, value: { cwd: 1, projectRoot: "/w" } } }], badReq.seq);
  await assert.rejects(bad, (error) => error.status === 502 && error.code === "host_bad_result");
  const good = link.remote.sessionOps.validateCwd("/w");
  const goodReq = await link.down.nextReal();
  const value = { ok: true, value: { cwd: "/w", projectRoot: "/w" } };
  await linkPost(link, [{ type: "res", seq: 2, id: goodReq.id, ok: true, result: value }], goodReq.seq);
  assert.deepEqual(await good, value);
  await link.down.cancel();
});

test("export, session and context results must have the fields the routes read", async () => {
  const link = await linkedHost("Shapes");
  let seq = 0;
  /** Run `call` and answer its req with `value` as the OpResult value. */
  const answer = async (call, value) => {
    const pending = call();
    const req = await link.down.nextReal();
    await linkPost(link, [{ type: "res", seq: ++seq, id: req.id, ok: true, result: { ok: true, value } }], req.seq);
    return pending;
  };
  const ops = link.remote.sessionOps;
  const options = { deferThinking: false, deferMedia: false };
  const contextOptions = (extra) => ({ ...options, includePreCompaction: false, boundary: false, sync: null, ...extra });
  const badResult = (error) => error.status === 502 && error.code === "host_bad_result";
  await assert.rejects(answer(() => ops.exportSession("s1"), { html: 1, fileName: "s.html" }), badResult);
  await assert.rejects(answer(() => ops.exportSession("s1"), null), badResult);
  await assert.rejects(answer(() => ops.readSession("s1", options), "not a session"), badResult);
  await assert.rejects(answer(() => ops.readSession("s1", options), { info: {}, context: null }), badResult);
  await assert.rejects(answer(() => ops.readContext("s1", undefined, contextOptions()), { context: 3 }), badResult);
  await assert.rejects(answer(() => ops.readContext("s1", undefined, contextOptions({ boundary: true })), { entryIds: "e1" }), badResult);
  await assert.rejects(answer(() => ops.readContext("s1", undefined, contextOptions({ sync: { cursor: null, limit: 10 } })), { leafId: null, tipId: null }), badResult);

  const exported = { html: "<p>", fileName: "s.html" };
  assert.deepEqual((await answer(() => ops.exportSession("s1"), exported)).value, exported);
  const session = { filePath: "/f", info: { id: "s1" }, leafId: null, tree: [], context: { messages: [] } };
  assert.deepEqual((await answer(() => ops.readSession("s1", options), session)).value, session);
  const page = { history: { messages: [] }, leafId: "e1", tipId: "e1" };
  assert.deepEqual((await answer(() => ops.readContext("s1", "e1", contextOptions({ sync: { cursor: null, limit: 10 } })), page)).value, page);
  assert.deepEqual((await answer(() => ops.readContext("s1", undefined, contextOptions({ boundary: true })), { entryIds: ["e1"] })).value, { entryIds: ["e1"] });
  assert.deepEqual((await answer(() => ops.readContext("s1", undefined, contextOptions()), { context: { messages: [] } })).value, { context: { messages: [] } });
  await link.down.cancel();
});

test("no uplink traffic for offlineMs marks the host offline and notifies", async () => {
  hub.linkTimings.offlineMs = 40;
  const changed = new Promise((resolve) => {
    const unsubscribe = hub.onHostsChange(() => {
      if (hub.listHosts().some((h) => h.label === "Quiet box" && h.status === "offline")) {
        unsubscribe();
        resolve();
      }
    });
  });
  const { remote, down } = await linkedHost("Quiet box");
  assert.equal(remote.status(), "online");
  const statuses = [];
  remote.onStatus((status) => statuses.push(status));
  const guard = setTimeout(() => {}, 2_000);
  await changed;
  clearTimeout(guard);
  assert.equal(remote.status(), "offline");
  assert.deepEqual(statuses, ["offline"]);
  assert.equal(await down.next(), null, "an offline link drops its socket so the daemon redials");
});

test("onHostHello reports the channels a daemon still runs", async () => {
  const seen = [];
  const unsubscribe = hub.onHostHello((hostId, channels) => seen.push({ hostId, channels }));
  const { id, down } = await linkedHost("Reattach", { channels: [{ ch: "c1", sessionId: null, cwd: "/w", pending: ['{"type":"host_tool_call","id":"t1"}'] }] });
  unsubscribe();
  assert.deepEqual(seen, [{ hostId: id, channels: [{ ch: "c1", sessionId: null, cwd: "/w", pending: ['{"type":"host_tool_call","id":"t1"}'] }] }]);
  await down.cancel();
});

test("on hello a spawned child the daemon no longer lists exits as lost; a spawn not yet applied is kept", async () => {
  const link = await linkedHost("Rebooted");
  const { req, spawning, result, post } = await spawnOverLink(link);
  await post([{ type: "res", seq: 1, id: req.id, ok: true, result }]);
  const { transport } = await spawning;
  const exited = new Promise((resolve) => transport.onExit((code, signal) => resolve({ code, signal })));
  const inFlight = link.remote.spawnRpc({ cwd: "/w", recordedCwd: null, sessionFile: "", advisor: false });
  const pendingReq = await link.down.nextReal();

  // The daemon restarted and redialed before its old socket closed: its children are gone and the second spawn never ran.
  const again = await openLink(link.token, { ack: 0, channels: [] });
  assert.deepEqual(await exited, { code: null, signal: null });
  assert.equal(transport.lost, true);
  const resent = await again.down.nextReal();
  assert.equal(resent.id, pendingReq.id);
  await linkPost(again, [{ type: "res", seq: 1, id: resent.id, ok: true, result }], resent.seq);
  assert.equal((await inFlight).transport.lost, false);
  await again.down.cancel();
});

test("orphanExit rejects with 503 when the host goes offline before the orphan exits", async () => {
  hub.linkTimings.offlineMs = 40;
  const sessionId = "11111111-2222-4333-8444-999999999999";
  const link = await linkedHost("Dozing", { channels: [{ ch: "old", sessionId, cwd: "/w", pending: null }] });
  // No uplink follows the hello: the host goes offline with the orphan still listed.
  await assert.rejects(hub.orphanExit(link.id, sessionId), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "host_offline");
    return true;
  });
  assert.equal(link.remote.status(), "offline");
  await link.down.cancel();
});

test("on hello a listed child with no transport that cannot be adopted is an orphan: killed, and orphanExit waits for it", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const link = await linkedHost("Survivor", { channels: [{ ch: "old", sessionId, cwd: "/w", pending: null }] });
  assert.deepEqual(await link.down.nextReal(), { type: "kill", seq: 1, ch: "old", force: false });
  let gone = false;
  const waiting = hub.orphanExit(link.id, sessionId).then(() => {
    gone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gone, false);
  await linkPost(link, [{ type: "exit", seq: 1, ch: "old", code: null, signal: "SIGTERM" }], 1);
  await waiting;
  await link.down.cancel();
});

const ADOPTED = "11111111-2222-4333-8444-aaaaaaaaaa01";

/** Adoption logs each kill and wrapper dispose; the tests assert on what reaches the daemon instead. */
function quiet(t) {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
}

test("on hello a listed child is adopted by its own identity, in its spawn cwd: no kill, no session lookup, its wrapper registered", async (t) => {
  quiet(t);
  const link = await linkHost("Adopter", { channels: [{ ch: "live", sessionId: ADOPTED, cwd: "/w/project", pending: [] }] });
  t.after(async () => {
    const disposing = getRpcSession(ADOPTED)?.destroyAndWait();
    await link.post({ type: "exit", ch: "live", code: 0, signal: null });
    await disposing;
    hub.closeHostLink(link.id);
  });
  const seen = [];
  const omp = ompChild(link, ADOPTED, { state: { isStreaming: true } });
  // No ops: a new session is in no list before its first reply is written.
  link.serve({}, (message) => {
    seen.push(message);
    return omp(message);
  });
  await until(() => getRpcSession(ADOPTED), "the adopted session");
  const session = getRpcSession(ADOPTED);
  assert.equal(session.adopted, true);
  assert.equal(session.host, hub.getHost(link.id));
  assert.equal(session.cwd, "/w/project");
  assert.equal(session.isRunning(), true);
  assert.deepEqual(seen.filter((message) => message.type === "kill" || message.type === "req"), []);
  assert.ok(seen.some((message) => message.type === "stdin" && message.ch === "live"), "the wrapper talks to the listed channel");
  assert.equal(await hub.adoptedChild(link.id, ADOPTED), true);
  // An adopted child is the live session's, no longer an orphan a start or file op waits for.
  await hub.orphanExit(link.id, ADOPTED);
});

test("a child listed without its replay or without a session is killed", async (t) => {
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa03";
  const link = await linkHost("Overflowing", { channels: [{ ch: "big", sessionId, cwd: "/w", pending: null }, { ch: "fresh", sessionId: null, cwd: "/w", pending: [] }] });
  t.after(() => hub.closeHostLink(link.id));
  assert.deepEqual([await link.next(), await link.next()].map(({ type, ch }) => ({ type, ch })), [{ type: "kill", ch: "big" }, { type: "kill", ch: "fresh" }]);
});

test("a failed adoption kills the child, blocks a start until it exits, then resumes the run once", async (t) => {
  quiet(t);
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa04";
  const { host, token } = createHost("Wedged");
  t.after(() => hub.closeHostLink(host.id));
  const entry = { id: sessionId, advisor: false, hostId: host.id };
  const resumed = [];
  resumeOnHostLink([entry], async (interrupted) => {
    resumed.push(interrupted);
  });
  const link = new LinkDriver(host.id, token);
  await link.dial({ channels: [{ ch: "wedged", sessionId, cwd: "/w", pending: [] }] });
  const kills = [];
  const omp = ompChild(link, sessionId, { fail: "get_state" });
  link.serve({}, (message) => {
    if (message.type === "kill") kills.push(message.ch);
    return omp(message);
  });
  await until(() => kills.includes("wedged"), "the kill");
  let exited = false;
  const waiting = hub.orphanExit(host.id, sessionId).then(() => {
    exited = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exited, false, "no second child while this one may still write the session file");
  assert.deepEqual(resumed, []);
  await link.post({ type: "exit", ch: "wedged", code: null, signal: "SIGTERM" });
  await waiting;
  await until(() => resumed.length > 0, "the resume");
  assert.deepEqual(resumed, [entry]);
  assert.equal(getRpcSession(sessionId), undefined);
});

test("a start while the adoption re-syncs joins it: no kill, no second child", async (t) => {
  quiet(t);
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa05";
  const link = await linkHost("Busy", { channels: [{ ch: "live", sessionId, cwd: "/w", pending: [] }] });
  t.after(async () => {
    // The child below exits on its kill.
    await getRpcSession(sessionId)?.destroyAndWait();
    hub.closeHostLink(link.id);
  });
  const release = Promise.withResolvers();
  let holding = false;
  const kills = [];
  const spawns = [];
  const omp = ompChild(link, sessionId);
  link.serve({
    async spawn(args) {
      spawns.push(args.ch);
      await link.post({ type: "stdout", ch: args.ch, line: JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] }) });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    sessionFileExists: () => true,
    invalidateSessionLists: () => null,
  }, async (message) => {
    if (message.type === "kill") {
      kills.push(message.ch);
      return link.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" });
    }
    if (message.type === "stdin" && JSON.parse(message.line).type === "get_state" && !holding) {
      holding = true;
      await release.promise;
    }
    return omp(message);
  });
  await until(() => holding, "the adoption's get_state");
  // A tab sends the session a prompt meanwhile.
  const starting = startRpcSession(sessionId, listedSession(sessionId).path, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await new Promise((resolve) => setTimeout(resolve, 20));
  release.resolve();
  const { session } = await starting;
  assert.equal(session.adopted, true);
  assert.equal(getRpcSession(sessionId), session);
  assert.deepEqual(spawns, []);
  assert.deepEqual(kills, []);
});

test("a start of a live adopted session does not wait on its listed child: no 503 while its host is offline", async (t) => {
  quiet(t);
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa06";
  const link = await linkHost("Napping", { channels: [{ ch: "live", sessionId, cwd: "/w", pending: [] }] });
  t.after(async () => {
    // Offline: returns at once; closing the link then exits the channel.
    await getRpcSession(sessionId)?.destroyAndWait();
    hub.closeHostLink(link.id);
  });
  link.serve({}, ompChild(link, sessionId));
  await until(() => getRpcSession(sessionId), "the adoption");
  // The host goes quiet: offline, with its child still running there.
  hub.linkTimings.offlineMs = 30;
  await link.post();
  await until(() => hub.getHost(link.id).status() === "offline", "the host to go offline");
  const { session } = await startRpcSession(sessionId, listedSession(sessionId).path, "/w", undefined, undefined, "/w", undefined, hub.getHost(link.id));
  assert.equal(session, getRpcSession(sessionId));
  assert.equal(session.isAlive(), true);
});

test("an adoption cut short by this server's shutdown leaves the child to the next server, and says so", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa07";
  const { host, token } = createHost("Handed over");
  hub.linkTimings.offlineMs = 50;
  // The shutdown starts as the hello lands: the adoption's first command finds the links frozen.
  const stop = hub.onHostHello((hostId) => {
    if (hostId === host.id) hub.freezeHostLinks();
  });
  t.after(() => {
    stop();
    globalThis.__ompHostHub.frozen = false;
    hub.closeHostLink(host.id);
  });
  const link = new LinkDriver(host.id, token);
  await link.dial({ channels: [{ ch: "live", sessionId, cwd: "/w", pending: [] }] });
  assert.equal(await hub.adoptedChild(host.id, sessionId), false);
  const messages = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(messages.some((message) => /left the omp child of session .* to the next server/.test(message)), messages.join("\n"));
  assert.equal(messages.some((message) => /killing/.test(message)), false);
});

test("freezeHostLinks closes every link socket with 1001, answers upgrades 503 and applies nothing after", async (t) => {
  const link = await linkedHost("Frozen");
  const { host, token } = createHost("Hello at shutdown");
  const early = upgradeSocket(token).socket;
  t.after(() => {
    globalThis.__ompHostHub.frozen = false;
    hub.closeHostLink(link.id);
    hub.closeHostLink(host.id);
  });
  const listing = link.remote.sessionOps.listSessions();
  const req = await link.down.nextReal();
  hub.freezeHostLinks();
  assert.deepEqual(link.down.socket.closed, { code: 1001, reason: "omp-web is restarting" });
  // A frame already on its way, and a hello on a socket upgraded before the freeze: neither is applied or answered.
  assert.deepEqual(linkPost(link, [{ type: "res", seq: 1, id: req.id, ok: true, result: [] }], req.seq), []);
  early.frame(JSON.stringify(hello()));
  assert.deepEqual(early.frames, [], "no welcome");
  assert.equal(hub.getHost(host.id).status(), "offline");
  await assert.rejects(listing, (error) => error.status === 503 && error.code === "host_offline");
  const refused = hub.handleLinkUpgrade(new Request(URL_BASE, { headers: { authorization: `Bearer ${token}`, upgrade: "websocket" } }), () => assert.fail("no socket while frozen"));
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: "omp-web is shutting down" });
});

for (const [op, call, value] of [
  ["archiveSession", (ops, id) => ops.archiveSession(id), { archivedPath: "/a" }],
  ["deleteSession", (ops, id) => ops.deleteSession(id, []), {}],
  ["renameSessionFile", (ops, id) => ops.renameSessionFile(id, "t", "user"), {}],
]) {
  test(`${op} waits for the session's orphan to exit; another session is not delayed`, async () => {
    const sessionId = "11111111-2222-4333-8444-666666666666";
    const link = await linkedHost(`Waiter ${op}`, { channels: [{ ch: "old", sessionId, cwd: "/w", pending: null }] });
    assert.equal((await link.down.nextReal()).type, "kill");
    const ops = link.remote.sessionOps;
    let seq = 0;
    const reply = (req) => linkPost(link, [{ type: "res", seq: ++seq, id: req.id, ok: true, result: { ok: true, value } }], req.seq);
    let settled = false;
    const pending = call(ops, sessionId).then((result) => { settled = true; return result; });
    // An unrelated session goes straight to the daemon while the orphan lives.
    const other = call(ops, "other-session");
    const otherReq = await link.down.nextReal();
    assert.equal(otherReq.op, op);
    assert.equal(otherReq.args.id, "other-session");
    await reply(otherReq);
    await other;
    assert.equal(settled, false);
    // The orphan exits: only now is the session's own op sent.
    await linkPost(link, [{ type: "exit", seq: ++seq, ch: "old", code: null, signal: "SIGTERM" }], otherReq.seq);
    const req = await link.down.nextReal();
    assert.equal(req.op, op);
    assert.equal(req.args.id, sessionId);
    await reply(req);
    await pending;
    await link.down.cancel();
  });
}

test("archive and project-update results must have the fields the routes read", async () => {
  const link = await linkedHost("Archivist");
  let seq = 0;
  const answer = async (call, value) => {
    const pending = call();
    const req = await link.down.nextReal();
    await linkPost(link, [{ type: "res", seq: ++seq, id: req.id, ok: true, result: { ok: true, value } }], req.seq);
    return pending;
  };
  const ops = link.remote.sessionOps;
  const badResult = (error) => error.status === 502 && error.code === "host_bad_result";
  await assert.rejects(answer(() => ops.archiveSession("s1"), { archivedPath: 1 }), badResult);
  await assert.rejects(answer(() => ops.archiveSession("s1"), null), badResult);
  await assert.rejects(answer(() => ops.updateProject([]), { projects: "p", newRoots: [] }), badResult);
  await assert.rejects(answer(() => ops.updateProject([]), { projects: [], newRoots: "r" }), badResult);
  await assert.rejects(answer(() => ops.updateProject([]), { projects: [] }), badResult);
  await assert.rejects(answer(() => ops.updateProject([]), { projects: [null], newRoots: [] }), badResult);
  await assert.rejects(answer(() => ops.updateProject([]), { projects: [{ path: "/p", addedAt: "t", hidden: "false" }], newRoots: [] }), badResult);
  await assert.rejects(answer(() => ops.updateProject([]), { projects: [], newRoots: [7] }), badResult);
  assert.deepEqual((await answer(() => ops.archiveSession("s1"), { archivedPath: "/a" })).value, { archivedPath: "/a" });
  assert.deepEqual((await answer(() => ops.updateProject([]), { projects: [], newRoots: [] })).value, { projects: [], newRoots: [] });
  await link.down.cancel();
});

test("the hello carries the host's extension auto-approve: an adopted run spawned nothing to report it", async () => {
  const link = await linkedHost("Auto-approver", { autoApproveExtension: true });
  assert.equal(link.remote.autoApproveExtension(), true);
  await link.down.cancel();
});

test("RemoteHost spawns over the link and its transport replays output sent before subscription", async () => {
  const link = await linkedHost("Spawner");
  const { req, spawning, result, post } = await spawnOverLink(link);
  assert.deepEqual(req.args, { ch: req.args.ch, cwd: "/w", recordedCwd: null, sessionFile: "", advisor: false });
  const ch = req.args.ch;
  // Output can overtake the spawn result; the transport holds it for RpcProcess.
  assert.deepEqual(post([
    { type: "stdout", seq: 1, ch, line: '{"type":"ready"}' },
    { type: "res", seq: 2, id: req.id, ok: true, result },
  ]), [2]);
  const spawned = await spawning;
  assert.equal(spawned.cwd, "/w");
  assert.equal(link.remote.autoApproveExtension(), true);
  const lines = [];
  spawned.transport.onLine((line) => lines.push(line));
  assert.deepEqual(lines, ['{"type":"ready"}']);

  await new Promise((resolve) => spawned.transport.write('{"type":"get_state"}\n', resolve));
  assert.deepEqual(await link.down.nextReal(), { type: "stdin", seq: req.seq + 1, ch, line: '{"type":"get_state"}\n' });
  spawned.transport.killTree(true);
  assert.deepEqual(await link.down.nextReal(), { type: "kill", seq: req.seq + 2, ch, force: true });

  const exited = new Promise((resolve) => spawned.transport.onExit((code, signal) => resolve({ code, signal })));
  await linkPost(link, [{ type: "exit", seq: 3, ch, code: null, signal: "SIGKILL" }]);
  assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
  await link.down.cancel();
});

test("a resent uplink frame applies only the new seq and acks the highest", async () => {
  const link = await linkedHost("Resender");
  const { req, spawning, result, post } = await spawnOverLink(link);
  const ch = req.args.ch;
  const lines = [];
  await post([{ type: "res", seq: 1, id: req.id, ok: true, result }, { type: "stdout", seq: 2, ch, line: "a" }]);
  (await spawning).transport.onLine((line) => lines.push(line));
  // The hub's ack for that frame was lost: the daemon resends seq 1-2 with the new seq 3.
  assert.deepEqual(linkPost(link, [
    { type: "res", seq: 1, id: req.id, ok: true, result },
    { type: "stdout", seq: 2, ch, line: "a" },
    { type: "stdout", seq: 3, ch, line: "b" },
  ]), [3]);
  assert.deepEqual(lines, ["a", "b"]);
  await link.down.cancel();
});

test("downlink messages the daemon did not ack are resent after it redials", async () => {
  const link = await linkedHost("Redial");
  const { req, spawning, result, post } = await spawnOverLink(link);
  await post([{ type: "res", seq: 1, id: req.id, ok: true, result }]);
  const { transport } = await spawning;
  transport.write("one\n", () => {});
  transport.write("two\n", () => {});
  // The daemon applied "one" before its downlink broke; "two" was lost in flight.
  const one = await link.down.nextReal();
  await link.down.cancel();
  const again = await openLink(link.token, { ack: one.seq });
  assert.deepEqual(await again.down.nextReal(), { type: "stdin", seq: one.seq + 1, ch: req.args.ch, line: "two\n" });
  await again.down.cancel();
});

test("the hub answers each uplink frame with one ack; an ack line from the daemon trims the downlink outbox", async () => {
  const link = await linkedHost("Acker");
  const { req, spawning, result } = await spawnOverLink(link);
  assert.deepEqual(linkPost(link, [{ type: "res", seq: 1, id: req.id, ok: true, result }], 0), [1]);
  const { transport } = await spawning;
  transport.write("one\n", () => {});
  transport.write("two\n", () => {});
  const one = await link.down.nextReal();
  await link.down.nextReal();
  // Nothing sequenced, only the daemon's ack and a pong: still one ack back, which the daemon waits for.
  assert.deepEqual(frame(link.down.socket, `${JSON.stringify({ type: "ack", ack: one.seq })}\n{"type":"pong"}\n`), [1]);
  await link.down.cancel();
  // A hello with ack 0 acks nothing: that ack line alone took the spawn req and "one" out of the outbox.
  const again = await openLink(link.token, { ack: 0 });
  assert.deepEqual(await again.down.nextReal(), { type: "stdin", seq: one.seq + 1, ch: req.args.ch, line: "two\n" });
  await again.down.cancel();
});

test("a restarted daemon (hello ack 0) starts a fresh uplink sequence", async () => {
  const link = await linkedHost("Restarted");
  const first = link.remote.sessionOps.listSessions();
  const req = await link.down.nextReal();
  await linkPost(link, [{ type: "res", seq: 1, id: req.id, ok: true, result: [] }], req.seq);
  assert.deepEqual(await first, []);
  await link.down.cancel();

  const restarted = { token: link.token, ...(await openLink(link.token, { ack: 0 })) };
  const second = link.remote.sessionOps.listSessions();
  const req2 = await restarted.down.nextReal();
  assert.ok(req2.seq > req.seq, "the hub keeps numbering its downlink");
  const session = { path: "/s/a.jsonl", id: "11111111-2222-4333-8444-555555555555", cwd: "/w", created: "c", modified: "m", messageCount: 0, firstMessage: "" };
  assert.deepEqual(linkPost(restarted, [{ type: "res", seq: 1, id: req2.id, ok: true, result: [session] }], req2.seq), [1]);
  assert.deepEqual(JSON.parse(JSON.stringify(await second)), [session]);
  await restarted.down.cancel();
});

test("a binary frame carries a large result ahead of its res; an unknown id or a second frame for one op is ignored", async () => {
  const link = await linkedHost("Blobby");
  const { socket } = link.down;
  const reading = link.remote.sessionOps.readSession("s1", { deferThinking: true, deferMedia: true });
  const req = await link.down.nextReal();
  assert.deepEqual(req.args, { id: "s1", options: { deferThinking: true, deferMedia: true } });
  const value = { ok: true, value: { info: { id: "s1" }, context: { messages: [] }, big: "x".repeat(100) } };
  const bytes = Buffer.from(JSON.stringify(value));
  socket.frame(encodeBlobFrame("unknown", bytes));
  socket.frame(encodeBlobFrame(req.id, bytes));
  socket.frame(encodeBlobFrame(req.id, Buffer.from("not the result")));
  assert.equal(socket.closed, null);
  await linkPost(link, [{ type: "res", seq: 1, id: req.id, ok: true, blob: { bytes: bytes.byteLength } }], req.seq);
  assert.deepEqual(await reading, value);

  const media = link.remote.sessionOps.readMedia("f".repeat(64));
  const mediaReq = await link.down.nextReal();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  socket.frame(encodeBlobFrame(mediaReq.id, png));
  await linkPost(link, [{ type: "res", seq: 2, id: mediaReq.id, ok: true, blob: { bytes: 4 } }], mediaReq.seq);
  const result = await media;
  assert.equal(result.ok, true);
  assert.deepEqual([...result.value], [...png]);

  assert.deepEqual(await link.remote.sessionOps.readMedia("../etc/passwd"), { ok: false, status: 400, code: "invalid_hash", error: "Invalid media hash" });

  const bad = link.remote.sessionOps.readSessionState("s1");
  const badReq = await link.down.nextReal();
  await linkPost(link, [{ type: "res", seq: 3, id: badReq.id, ok: true, result: { ok: "yes" } }], badReq.seq);
  await assert.rejects(bad, (error) => error.status === 502 && /Blobby/.test(error.message));

  const failed = link.remote.sessionOps.readSessionState("s1");
  const failedReq = await link.down.nextReal();
  await linkPost(link, [{ type: "res", seq: 4, id: failedReq.id, ok: false, error: { status: 200, code: "x", message: "boom" } }], failedReq.seq);
  await assert.rejects(failed, (error) => error.status === 502 && /boom/.test(error.message));

  // A binary frame that names no request is not a result.
  socket.frame(new Uint8Array([0]));
  assert.equal(socket.closed?.code, 1008);
});

test("a text frame over uplinkBytes closes 1009; a frame with one malformed line or an unsafe seq applies nothing and closes 1007", async () => {
  const flood = await linkedHost("Flood");
  // UTF-8 bytes, not characters: under the cap in characters, over it in bytes.
  assert.deepEqual(frame(flood.down.socket, "é".repeat(LINK_LIMITS.uplinkBytes / 2 + 1)), []);
  assert.equal(flood.down.socket.closed?.code, 1009);

  const badLines = ['{"type":"stdout","seq":2,"ch":"c', '{"type":"future","seq":1e300}', '{"type":"stdout","seq":-1,"ch":"none","line":"x"}'];
  for (const [i, bad] of badLines.entries()) {
    const link = await linkedHost(`Malformed ${i}`);
    let settled = false;
    const listing = link.remote.sessionOps.listSessions().then(() => { settled = true; }, (error) => error);
    const req = await link.down.nextReal();
    const res = JSON.stringify({ type: "res", seq: 1, id: req.id, ok: true, result: [] });
    assert.deepEqual(frame(link.down.socket, `${JSON.stringify({ type: "ack", ack: req.seq })}\n${res}\n${bad}`), [], bad);
    assert.equal(link.down.socket.closed?.code, 1007, bad);
    // The close fails the op: the res beside the bad line was never applied.
    assert.equal((await listing)?.code, "host_offline", bad);
    assert.equal(settled, false, bad);
  }
});

test("unknown uplink messages are acked and skipped, warning once per type; the known ones in the batch apply", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const link = await linkedHost("Newer daemon");
  const listing = link.remote.sessionOps.listSessions();
  const req = await link.down.nextReal();
  assert.deepEqual(linkPost(link, [
    { type: "future", seq: 1, x: 1 },
    { type: "future", seq: 2 },
    { type: "res", seq: 3, id: req.id, ok: true, result: [] },
    { type: "other", seq: 4 },
  ], req.seq), [4]);
  assert.deepEqual(await listing, []);
  assert.deepEqual(warn.mock.calls.map((call) => String(call.arguments[0]).match(/"(\w+)"/)?.[1]), ["future", "other"]);
  await link.down.cancel();
});

test("an unknown type is warned about again on a new link of the same host", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const a = await linkedHost("Redialing daemon");
  await linkPost(a, [{ type: "future", seq: 1 }]);
  await linkPost(a, [{ type: "future", seq: 2 }]);
  assert.equal(warn.mock.calls.length, 1);
  const b = { token: a.token, ...(await openLink(a.token, { ack: 0 })) };
  await linkPost(b, [{ type: "future", seq: 1 }]);
  assert.equal(warn.mock.calls.length, 2, "the new link starts a new set");
  await b.down.cancel();
});

test("unknown-type warnings are capped per link and escaped", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const link = await linkedHost("Chatty daemon");
  const types = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const hostile = "evil\n\u001b[31m" + "x".repeat(100_000);
  assert.deepEqual(linkPost(link, [...types, hostile].map((type, i) => ({ type, seq: i + 1 }))), [21], "every seq is still applied");
  const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.equal(lines.length, 16);
  assert.ok(lines.every((line) => !/[\n\u001b]/.test(line) && line.length < 200));
  await link.down.cancel();
});

test("a daemon message that only the server may send is logged each time, skipped and acked", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const link = await linkedHost("Confused daemon");
  assert.deepEqual(linkPost(link, [
    { type: "stdin", seq: 1, ch: "c", line: "x" },
    { type: "stdin", seq: 2, ch: "c", line: "x" },
  ]), [2]);
  const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes('"stdin" is not valid from the daemon')), lines.join("|"));
  await link.down.cancel();
});

test("a daemon's unknown_op answer surfaces as a 501 HostOpError", async () => {
  const link = await linkedHost("Older daemon");
  const listing = link.remote.sessionOps.listSessions();
  const req = await link.down.nextReal();
  await linkPost(link, [{ type: "res", seq: 1, id: req.id, ok: false, error: { status: 501, code: "unknown_op", message: "Unknown host op: listSessions" } }], req.seq);
  await assert.rejects(listing, (error) => error.name === "HostOpError" && error.status === 501 && error.code === "unknown_op");
  await link.down.cancel();
});

test("getHost resolves local, linked and unknown ids", async () => {
  // This machine is its daemon's link, also before any record exists: offline until a daemon links.
  const local = hub.getHost("local");
  assert.equal(local, hub.getHost("local"), "one RemoteHost for this machine");
  assert.equal(local.id, "local");
  assert.equal(local.label, "This machine");
  assert.equal(local.status(), "offline");
  await assert.rejects(local.sessionOps.listSessions(), (error) => error.status === 503);
  assert.equal(hub.getHost("no-such-host"), null);
  const { host } = createHost("Never linked");
  const remote = hub.getHost(host.id);
  assert.equal(remote, hub.getHost(host.id), "one RemoteHost per id");
  assert.equal(remote.label, "Never linked");
  assert.equal(remote.status(), "offline");
  await assert.rejects(remote.sessionOps.listSessions(), (error) => error.status === 503);
});

test("an unreadable host registry answers 503, never 401", async () => {
  const { token } = createHost("Registry");
  const file = join(agentDir, "omp-web", "hosts.json");
  const saved = readFileSync(file, "utf8");
  const logged = [];
  const originalError = console.error;
  console.error = (line) => logged.push(String(line));
  writeFileSync(file, "{\"hosts\": [");
  try {
    // A 401 would make the daemon stop every omp child it runs.
    assert.equal(upgradeSocket(token).response?.status, 503);
    assert.equal((await outdatedPost(token, JSON.stringify(hello({ v: 3 })))).status, 503);
  } finally {
    writeFileSync(file, saved);
    console.error = originalError;
  }
  assert.ok(logged.some((line) => line.includes("host link refused")));
  assert.equal(upgradeSocket(token).response, undefined);
});

test("the websocket handler bounds what one peer can make the server hold", () => {
  assert.equal(hub.hostLinkSocket.maxPayloadLength, LINK_LIMITS.blobBytes + 256);
  assert.equal(hub.hostLinkSocket.backpressureLimit, LINK_LIMITS.uplinkBytes);
  assert.equal(hub.hostLinkSocket.closeOnBackpressureLimit, true);
});
