import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// The hub keeps its links on globalThis; every test links its own host.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-hub-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const hub = await jiti.import("./hub.ts");
const { LINK_ACK_HEADER, LINK_HELLO_HEADER, LINK_LIMITS, LINK_NONCE_HEADER, LINK_PROTOCOL_VERSION } = await jiti.import("./link-protocol.ts");
const { createHost } = await jiti.import("./registry.ts");
const { getRpcSession } = await jiti.import("../rpc-manager.ts");
const { resumeOnHostLink } = await jiti.import("../session-resume.ts");
const { LinkDriver, linkHost, listedSession, ompChild, until } = await import("./link-driver.test-helper.mjs");

const defaultTimings = { ...hub.linkTimings };
test.afterEach(() => Object.assign(hub.linkTimings, defaultTimings));

const URL_BASE = "http://main.test/api/hosts/link";

function hello(overrides = {}) {
  return { type: "hello", v: LINK_PROTOCOL_VERSION, ompVersion: "14.0.0", platform: "linux", home: "/home/u", ack: 0, channels: [], ...overrides };
}

/** POST a hello, as the daemon does before opening its downlink. */
function linkHello(token, message = hello()) {
  return hub.handleLinkPost(new Request(URL_BASE, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, [LINK_HELLO_HEADER]: "1" },
    body: `${JSON.stringify(message)}\n`,
  }));
}

/** The downlink GET naming a hello id. */
function openDown(token, helloId) {
  return hub.handleLinkGet(new Request(URL_BASE, { headers: { authorization: `Bearer ${token}`, [LINK_HELLO_HEADER]: helloId } }));
}

/** The daemon's dial: POST the hello, then GET the downlink with the id main answered. A refused hello is returned as is. */
async function linkGet(token, message = hello()) {
  const offered = await linkHello(token, message);
  if (offered.status !== 200) return offered;
  return openDown(token, (await offered.json()).helloId);
}

/** Uplink headers of one link: `{ token, nonce }` (the nonce from its welcome). */
function linkHeaders({ token, nonce }, ack = 0) {
  return { authorization: `Bearer ${token}`, [LINK_ACK_HEADER]: String(ack), [LINK_NONCE_HEADER]: nonce };
}

function linkPost(link, messages, ack = 0) {
  return hub.handleLinkPost(new Request(URL_BASE, {
    method: "POST",
    headers: linkHeaders(link, ack),
    body: messages.map((m) => `${JSON.stringify(m)}\n`).join(""),
  }));
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

/** Reads the NDJSON downlink one message at a time; null once the stream ended. */
function downlink(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          return JSON.parse(line);
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    /** Next message that is not a ping. */
    async nextReal() {
      for (;;) {
        const message = await this.next();
        if (message?.type !== "ping") return message;
      }
    },
    cancel: () => reader.cancel(),
  };
}

/** Dial the downlink; returns it with the nonce its welcome carried. */
async function openLink(token, overrides = {}) {
  const response = await linkGet(token, hello(overrides));
  assert.equal(response.status, 200);
  const down = downlink(response);
  const welcome = await down.next();
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.v, LINK_PROTOCOL_VERSION);
  assert.match(welcome.nonce, /^[0-9a-f-]{36}$/);
  return { welcome, down, nonce: welcome.nonce };
}

async function linkedHost(label = "Build box", overrides = {}) {
  const { host, token } = createHost(label);
  const { welcome, down, nonce } = await openLink(token, overrides);
  assert.equal(welcome.hostId, host.id);
  return { id: host.id, token, nonce, down, remote: hub.getHost(host.id) };
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

test("a missing, malformed or wrong bearer token gets 401 before the body is read", async () => {
  createHost("Real");
  for (const authorization of [undefined, "Basic abc", "Bearer ", "Bearer not-a-token"]) {
    const headers = authorization ? { authorization } : {};
    assert.equal((await hub.handleLinkGet(new Request(URL_BASE, { headers }))).status, 401);
    const postBody = watchedBody();
    const post = new Request(URL_BASE, { method: "POST", headers, body: postBody.stream, duplex: "half" });
    assert.equal((await hub.handleLinkPost(post)).status, 401);
    const blobBody = watchedBody();
    const blob = new Request(`${URL_BASE}/blob/r1`, { method: "POST", headers, body: blobBody.stream, duplex: "half" });
    assert.equal((await hub.handleLinkBlob(blob, "r1")).status, 401);
    assert.equal(postBody.pulled || blobBody.pulled, false, "the body must not be read before the token is verified");
    assert.equal(post.bodyUsed, false);
  }
});

test("a version mismatch gets 426 with both versions and marks the host needs-upgrade", async () => {
  const { host, token } = createHost("Old daemon");
  const response = await linkGet(token, hello({ v: LINK_PROTOCOL_VERSION + 1 }));
  assert.equal(response.status, 426);
  assert.deepEqual(await response.json(), {
    error: "Link protocol version mismatch",
    hostVersion: LINK_PROTOCOL_VERSION + 1,
    serverVersion: LINK_PROTOCOL_VERSION,
  });
  const listed = hub.listHosts().find((h) => h.id === host.id);
  assert.equal(listed.status, "needs-upgrade");
  // Settings renders "needs upgrade (host vN, server vM)" from these.
  assert.equal(listed.hostVersion, LINK_PROTOCOL_VERSION + 1);
  assert.equal(listed.serverVersion, LINK_PROTOCOL_VERSION);
});

test("the hello rides a POST body, so a hello listing hundreds of channels links", async () => {
  const { token } = createHost("Busy box");
  // Far past an 8 KB proxy header buffer (the hello used to ride a GET header).
  const channels = Array.from({ length: 300 }, (_, i) => ({ ch: `ch-${String(i).padStart(4, "0")}`, sessionId: null, pending: [] }));
  assert.ok(JSON.stringify(channels).length > 8 * 1024);
  const offered = await linkHello(token, hello({ channels }));
  assert.equal(offered.status, 200);
  const { helloId } = await offered.json();
  assert.match(helloId, /^[0-9a-f-]{36}$/);
  const response = await openDown(token, helloId);
  assert.equal(response.status, 200);
  const down = downlink(response);
  assert.equal((await down.next()).type, "welcome");
  // The listed children are orphans of a previous run of this server: each gets its kill.
  const kills = [];
  while (kills.length < channels.length) {
    const message = await down.nextReal();
    if (message.type === "kill") kills.push(message.ch);
  }
  assert.deepEqual(kills, channels.map(({ ch }) => ch));
  // One hello opens one downlink: a replayed GET cannot apply it again.
  assert.equal((await openDown(token, helloId)).status, 400);
  await down.cancel();
});

test("a downlink GET naming no offered hello gets 400", async () => {
  const { token } = createHost("Stray");
  assert.equal((await openDown(token, "not-a-hello-id")).status, 400);
  assert.equal((await hub.handleLinkGet(new Request(URL_BASE, { headers: { authorization: `Bearer ${token}` } }))).status, 400);
});

test("a v1 daemon, whose GET carries the hello itself, gets 426 instead of redialing forever", async () => {
  const { host, token } = createHost("v1 daemon");
  const legacy = Buffer.from(JSON.stringify(hello({ v: 1 }))).toString("base64url");
  const response = await openDown(token, legacy);
  assert.equal(response.status, 426);
  assert.deepEqual(await response.json(), { error: "Link protocol version mismatch", hostVersion: 1, serverVersion: LINK_PROTOCOL_VERSION });
  assert.equal(hub.listHosts().find((h) => h.id === host.id).status, "needs-upgrade");
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

test("a second link with the same token sends replaced on the first stream", async () => {
  const first = await linkedHost("Twice");
  const second = await openLink(first.token);
  assert.notEqual(second.nonce, first.nonce);
  assert.equal((await first.down.next()).type, "replaced");
  assert.equal(await first.down.next(), null);
  await second.down.cancel();
});

test("closeHostLink ends the stream, rejects pending ops, exits its children and marks the host offline", async () => {
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

test("an op that timed out while the downlink was down is not delivered after the daemon redials", async () => {
  hub.linkTimings.opTimeoutMs = 30;
  const link = await linkedHost("Lid closed");
  await link.down.cancel();
  await assert.rejects(link.remote.sessionOps.deleteSession("s1", []), (error) => error.status === 504);
  const again = { token: link.token, ...(await openLink(link.token)) };
  const listing = link.remote.sessionOps.listSessions();
  const next = await again.down.nextReal();
  assert.equal(next.op, "listSessions", "a delete the user saw fail must never run later");
  await linkPost(again, [{ type: "res", seq: 1, id: next.id, ok: true, result: [] }], next.seq);
  assert.deepEqual(await listing, []);
  await again.down.cancel();
});

test("ops pending when the host goes offline reject at the flip and are not resent", async () => {
  hub.linkTimings.offlineMs = 40;
  hub.linkTimings.opTimeoutMs = 2_000;
  const link = await linkedHost("Lid closing");
  const pending = link.remote.sessionOps.listSessions();
  const first = await link.down.nextReal();
  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "host_offline");
    return true;
  });
  assert.equal(link.remote.status(), "offline");
  hub.linkTimings.offlineMs = defaultTimings.offlineMs;
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
  const response = await linkGet(link.token, hello({ v: LINK_PROTOCOL_VERSION + 1 }));
  assert.equal(response.status, 426);
  assert.equal(link.remote.status(), "online");
  assert.equal(hub.listHosts().find((h) => h.id === link.id).hostVersion, LINK_PROTOCOL_VERSION);
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
  assert.equal(await down.next(), null, "an offline link closes its downlink so the daemon redials");
});

test("onHostHello reports the channels a daemon still runs", async () => {
  const seen = [];
  const unsubscribe = hub.onHostHello((hostId, channels) => seen.push({ hostId, channels }));
  const { id, down } = await linkedHost("Reattach", { channels: [{ ch: "c1", sessionId: null, pending: ['{"type":"host_tool_call","id":"t1"}'] }] });
  unsubscribe();
  assert.deepEqual(seen, [{ hostId: id, channels: [{ ch: "c1", sessionId: null, pending: ['{"type":"host_tool_call","id":"t1"}'] }] }]);
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
  await link.down.cancel();

  // The daemon restarted: its children are gone and the second spawn never ran.
  const again = await openLink(link.token, { ack: 0, channels: [] });
  assert.deepEqual(await exited, { code: null, signal: null });
  assert.equal(transport.lost, true);
  const resent = await again.down.nextReal();
  assert.equal(resent.id, pendingReq.id);
  await linkPost({ token: link.token, nonce: again.nonce }, [{ type: "res", seq: 1, id: resent.id, ok: true, result }], resent.seq);
  assert.equal((await inFlight).transport.lost, false);
  await again.down.cancel();
});

test("orphanExit rejects with 503 when the host goes offline before the orphan exits", async () => {
  hub.linkTimings.offlineMs = 40;
  const sessionId = "11111111-2222-4333-8444-999999999999";
  const link = await linkedHost("Dozing", { channels: [{ ch: "old", sessionId, pending: null }] });
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
  const link = await linkedHost("Survivor", { channels: [{ ch: "old", sessionId, pending: null }] });
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

test("on hello a listed child of a session its host lists is adopted: no kill, its wrapper registered", async (t) => {
  const link = await linkHost("Adopter", { channels: [{ ch: "live", sessionId: ADOPTED, pending: [] }] });
  t.after(async () => {
    const disposing = getRpcSession(ADOPTED)?.destroyAndWait();
    await link.post({ type: "exit", ch: "live", code: 0, signal: null });
    await disposing;
    hub.closeHostLink(link.id);
  });
  const seen = [];
  const omp = ompChild(link, ADOPTED, { state: { isStreaming: true } });
  link.serve({ listSessions: () => [listedSession(ADOPTED)] }, (message) => {
    seen.push(message);
    return omp(message);
  });
  await until(() => getRpcSession(ADOPTED), "the adopted session");
  const session = getRpcSession(ADOPTED);
  assert.equal(session.adopted, true);
  assert.equal(session.host, hub.getHost(link.id));
  assert.equal(session.isRunning(), true);
  assert.deepEqual(seen.filter((message) => message.type === "kill"), []);
  assert.ok(seen.some((message) => message.type === "stdin" && message.ch === "live"), "the wrapper talks to the listed channel");
  assert.equal(await hub.adoptedChild(link.id, ADOPTED), true);
  // An adopted child is the live session's, no longer an orphan a start or file op waits for.
  await hub.orphanExit(link.id, ADOPTED);
});

test("on hello a listed child of a session its host does not list is killed", async (t) => {
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa02";
  const link = await linkHost("Forgetful", { channels: [{ ch: "stray", sessionId, pending: [] }] });
  t.after(() => hub.closeHostLink(link.id));
  const kills = [];
  link.serve({ listSessions: () => [listedSession(ADOPTED)] }, (message) => {
    if (message.type === "kill") kills.push(message);
  });
  await until(() => kills.length > 0, "the kill");
  assert.deepEqual(kills.map(({ ch, force }) => ({ ch, force })), [{ ch: "stray", force: false }]);
  assert.equal(getRpcSession(sessionId), undefined);
  assert.equal(await hub.adoptedChild(link.id, sessionId), false);
});

test("a child listed without its replay or without a session is killed without asking for the host's sessions", async (t) => {
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa03";
  const link = await linkHost("Overflowing", { channels: [{ ch: "big", sessionId, pending: null }, { ch: "fresh", sessionId: null, pending: [] }] });
  t.after(() => hub.closeHostLink(link.id));
  assert.deepEqual([await link.next(), await link.next()].map(({ type, ch }) => ({ type, ch })), [{ type: "kill", ch: "big" }, { type: "kill", ch: "fresh" }]);
});

test("a failed adoption kills the child, blocks a start until it exits, then resumes the run once", async (t) => {
  const sessionId = "11111111-2222-4333-8444-aaaaaaaaaa04";
  const { host, token } = createHost("Wedged");
  t.after(() => hub.closeHostLink(host.id));
  const entry = { id: sessionId, advisor: false, hostId: host.id };
  const resumed = [];
  resumeOnHostLink([entry], async (interrupted) => {
    resumed.push(interrupted);
  });
  const link = new LinkDriver(host.id, token);
  await link.dial({ channels: [{ ch: "wedged", sessionId, pending: [] }] });
  const kills = [];
  const omp = ompChild(link, sessionId, { fail: "get_state" });
  link.serve({ listSessions: () => [listedSession(sessionId)] }, (message) => {
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

for (const [op, call, value] of [
  ["archiveSession", (ops, id) => ops.archiveSession(id), { archivedPath: "/a" }],
  ["deleteSession", (ops, id) => ops.deleteSession(id, []), {}],
  ["renameSessionFile", (ops, id) => ops.renameSessionFile(id, "t", "user"), {}],
]) {
  test(`${op} waits for the session's orphan to exit; another session is not delayed`, async () => {
    const sessionId = "11111111-2222-4333-8444-666666666666";
    const link = await linkedHost(`Waiter ${op}`, { channels: [{ ch: "old", sessionId, pending: null }] });
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

test("RemoteHost spawns over the link and its transport replays output sent before subscription", async () => {
  const link = await linkedHost("Spawner");
  const { req, spawning, result, post } = await spawnOverLink(link);
  assert.deepEqual(req.args, { ch: req.args.ch, cwd: "/w", recordedCwd: null, sessionFile: "", advisor: false });
  const ch = req.args.ch;
  // Output can overtake the spawn result; the transport holds it for RpcProcess.
  const response = await post([
    { type: "stdout", seq: 1, ch, line: '{"type":"ready"}' },
    { type: "res", seq: 2, id: req.id, ok: true, result },
  ]);
  assert.deepEqual(await response.json(), { ack: 2 });
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

test("a resent uplink batch applies only the new seq and acks the highest", async () => {
  const link = await linkedHost("Resender");
  const { req, spawning, result, post } = await spawnOverLink(link);
  const ch = req.args.ch;
  const lines = [];
  await post([{ type: "res", seq: 1, id: req.id, ok: true, result }, { type: "stdout", seq: 2, ch, line: "a" }]);
  (await spawning).transport.onLine((line) => lines.push(line));
  // The response to that POST was lost: the daemon resends seq 1-2 with the new seq 3.
  const response = await linkPost(link, [
    { type: "res", seq: 1, id: req.id, ok: true, result },
    { type: "stdout", seq: 2, ch, line: "a" },
    { type: "stdout", seq: 3, ch, line: "b" },
  ]);
  assert.deepEqual(await response.json(), { ack: 3 });
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
  const response = await linkPost(restarted, [{ type: "res", seq: 1, id: req2.id, ok: true, result: [session] }], req2.seq);
  assert.deepEqual(await response.json(), { ack: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(await second)), [session]);
  await restarted.down.cancel();
});

test("large results arrive through the blob leg; daemon results are validated", async () => {
  const link = await linkedHost("Blobby");
  const reading = link.remote.sessionOps.readSession("s1", { deferThinking: true, deferMedia: true });
  const req = await link.down.nextReal();
  assert.deepEqual(req.args, { id: "s1", options: { deferThinking: true, deferMedia: true } });
  const value = { ok: true, value: { info: { id: "s1" }, context: { messages: [] }, big: "x".repeat(100) } };
  const bytes = Buffer.from(JSON.stringify(value));
  const blobRequest = (id, body) => new Request(`${URL_BASE}/blob/${id}`, { method: "POST", headers: linkHeaders(link), body });
  assert.equal((await hub.handleLinkBlob(blobRequest("unknown", bytes), "unknown")).status, 404);
  assert.equal((await hub.handleLinkBlob(blobRequest(req.id, bytes), req.id)).status, 200);
  assert.equal((await hub.handleLinkBlob(blobRequest(req.id, bytes), req.id)).status, 400, "one upload per result");
  await linkPost(link, [{ type: "res", seq: 1, id: req.id, ok: true, blob: { bytes: bytes.byteLength } }], req.seq);
  assert.deepEqual(await reading, value);

  const media = link.remote.sessionOps.readMedia("f".repeat(64));
  const mediaReq = await link.down.nextReal();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await hub.handleLinkBlob(blobRequest(mediaReq.id, png), mediaReq.id)).status, 200);
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
  await link.down.cancel();
});

test("an over-limit batch gets 413; a batch cut mid-line applies nothing", async () => {
  const link = await linkedHost("Flood");
  const tooLarge = await hub.handleLinkPost(new Request(URL_BASE, {
    method: "POST",
    headers: linkHeaders(link),
    body: "x".repeat(LINK_LIMITS.uplinkBytes + 1),
  }));
  assert.equal(tooLarge.status, 413);

  let settled = false;
  const listing = link.remote.sessionOps.listSessions().then((value) => { settled = true; return value; });
  const req = await link.down.nextReal();
  const res = JSON.stringify({ type: "res", seq: 1, id: req.id, ok: true, result: [] });
  const cut = await hub.handleLinkPost(new Request(URL_BASE, {
    method: "POST",
    headers: linkHeaders(link, req.seq),
    body: `${res}\n{"type":"stdout","seq":2,"ch":"c`,
  }));
  assert.equal(cut.status, 400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "no line of a malformed batch is applied");
  assert.deepEqual(await (await linkPost(link, [JSON.parse(res)], req.seq)).json(), { ack: 1 });
  assert.deepEqual(await listing, []);
  await link.down.cancel();
});

test("getHost resolves local, linked and unknown ids", async () => {
  const { localHost } = await jiti.import("./local-host.ts");
  assert.equal(hub.getHost("local"), localHost);
  assert.equal(hub.getHost("no-such-host"), null);
  const { host } = createHost("Never linked");
  const remote = hub.getHost(host.id);
  assert.equal(remote, hub.getHost(host.id), "one RemoteHost per id");
  assert.equal(remote.label, "Never linked");
  assert.equal(remote.status(), "offline");
  await assert.rejects(remote.sessionOps.listSessions(), (error) => error.status === 503);
});

test("a replaced daemon's late POST gets 409 before its body is read and leaves the new uplink window alone", async () => {
  const a = await linkedHost("Two daemons");
  assert.deepEqual(await (await linkPost(a, [{ type: "stdout", seq: 500, ch: "none", line: "x" }])).json(), { ack: 500 });
  // Daemon B links with the same token: a fresh process (ack 0) restarts the uplink window.
  const b = { token: a.token, ...(await openLink(a.token, { ack: 0 })) };
  assert.notEqual(b.nonce, a.nonce);
  assert.equal((await a.down.next()).type, "replaced");

  // A's next POST (seq 501) arrives late, after B linked.
  const late = watchedBody();
  assert.equal((await hub.handleLinkPost(new Request(URL_BASE, { method: "POST", headers: linkHeaders(a), body: late.stream, duplex: "half" }))).status, 409);
  assert.equal(late.pulled, false, "a stale link's body is never read");
  assert.equal((await linkPost(a, [{ type: "stdout", seq: 501, ch: "none", line: "y" }])).status, 409);
  const lateBlob = watchedBody();
  const blob = new Request(`${URL_BASE}/blob/r1`, { method: "POST", headers: linkHeaders(a), body: lateBlob.stream, duplex: "half" });
  assert.equal((await hub.handleLinkBlob(blob, "r1")).status, 409);
  assert.equal(lateBlob.pulled, false);

  // B's first uplink message is seq 1, and it is applied.
  const listing = a.remote.sessionOps.listSessions();
  const req = await b.down.nextReal();
  const fromB = { path: "/b/from-b.jsonl", id: "11111111-2222-4333-8444-bbbbbbbbbbbb", cwd: "/w", created: "c", modified: "m", messageCount: 0, firstMessage: "" };
  const response = await linkPost(b, [{ type: "res", seq: 1, id: req.id, ok: true, result: [fromB] }], req.seq);
  assert.deepEqual(await response.json(), { ack: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(await listing)), [fromB]);
  await b.down.cancel();
});

test("a POST whose link is replaced while its body arrives applies nothing", async () => {
  const a = await linkedHost("Racing");
  const { promise: reading, resolve: onPull } = Promise.withResolvers();
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; }, pull() { onPull(); } }, { highWaterMark: 0 });
  const posting = hub.handleLinkPost(new Request(URL_BASE, { method: "POST", headers: linkHeaders(a), body, duplex: "half" }));
  await reading;
  const b = { token: a.token, ...(await openLink(a.token, { ack: 0 })) };
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "stdout", seq: 7, ch: "none", line: "x" })}\n`));
  controller.close();
  assert.equal((await posting).status, 409);
  assert.deepEqual(await (await linkPost(b, [{ type: "stdout", seq: 1, ch: "none", line: "y" }])).json(), { ack: 1 });
  await b.down.cancel();
});

test("an unreadable host registry answers 503, never 401", async () => {
  const link = await linkedHost("Registry");
  const file = join(agentDir, "omp-web", "hosts.json");
  const saved = readFileSync(file, "utf8");
  const logged = [];
  const originalError = console.error;
  console.error = (line) => logged.push(String(line));
  writeFileSync(file, "{\"hosts\": [");
  try {
    // A 401 would make the daemon stop every omp child it runs.
    assert.equal((await linkGet(link.token)).status, 503);
    assert.equal((await linkPost(link, [])).status, 503);
    assert.equal((await hub.handleLinkBlob(new Request(`${URL_BASE}/blob/r1`, { method: "POST", headers: linkHeaders(link), body: "x" }), "r1")).status, 503);
  } finally {
    writeFileSync(file, saved);
    console.error = originalError;
  }
  assert.ok(logged.some((line) => line.includes("host link refused")));
  assert.equal((await linkPost(link, [])).status, 200);
  await link.down.cancel();
});
