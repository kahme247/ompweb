// Composer uploads end to end on this process: the main registry (lib/uploads.ts) and the hub, linked over a loopback
// WebSocket to a real `ompweb host` daemon (runHostDaemon) that stages and attaches the files.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const scratch = mkdtempSync(join(tmpdir(), "omp-web-uploads-"));
const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, ompBin: process.env.OMP_WEB_OMP_BIN };
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
// No omp here: the host links as omp-missing, which is linked.
process.env.OMP_WEB_OMP_BIN = join(scratch, "no-omp");

const linkRoute = await import("../app/api/hosts/link/route.ts");
const uploadsRoute = await import("../app/api/uploads/route.ts");
const uploadRoute = await import("../app/api/uploads/[id]/route.ts");
const hub = await import("./hosts/hub.ts");
const { createHost, rotateLocalHostToken } = await import("./hosts/registry.ts");
const { runHostDaemon } = await import("./hosts/daemon.ts");
const { decodeBlobFrame, LINK_LIMITS } = await import("./hosts/link-protocol.ts");
const { sanitizeUploadName, StagedUploads } = await import("./hosts/uploads.ts");
const { getSessionsDir } = await import("./omp/paths.ts");
const { runAgentCommand } = await import("./agent-command.ts");
const { LinkDriver, linkHost } = await import("./hosts/link-driver.test-helper.mjs");
const { UPLOAD_WINDOW_BYTES } = await import("./upload-limits.ts");
const uploads = await import("./uploads.ts");

const PIECE = LINK_LIMITS.pieceBytes;
const OWNER = "open";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const sockets = new Set();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: { "/api/hosts/link": { GET: (req) => linkRoute.GET(req, { upgrade: (data) => server.upgrade(req, { data }) }) } },
  websocket: {
    ...hub.hostLinkSocket,
    open(ws) {
      sockets.add(ws);
    },
    close(ws, code, reason) {
      sockets.delete(ws);
      hub.hostLinkSocket.close(ws, code, reason);
    },
  },
  fetch: () => new Response("not found", { status: 404 }),
});

let hostId;
let daemon;

async function until(predicate, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

before(async () => {
  const { host, token } = createHost("Laptop");
  hostId = host.id;
  daemon = runHostDaemon({ url: `http://127.0.0.1:${server.port}`, token, allowHttp: false });
  await until(() => ["online", "omp-missing"].includes(hub.getHost(hostId).status()) && sockets.size === 1, "the daemon to link");
});

after(async () => {
  await daemon?.stop();
  await server.stop(true);
  hub.flushLinkSamples();
  for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.agentDir], ["OMP_WEB_OMP_BIN", previous.ompBin]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A sink that records the host's acks and the first error. */
function recorder() {
  return {
    received: 0,
    done: false,
    failed: null,
    ack(received, done) {
      this.received = received;
      this.done = done;
    },
    error(status, code, message) {
      this.failed ??= { status, code, message };
    },
  };
}

/** Forward bytes[from, to) in pieces inside the upload window, as the browser worker does. False once the sink failed. */
async function pump(id, bytes, from, to, sink) {
  for (let at = from; at < to; at += PIECE) {
    while (at - sink.received >= UPLOAD_WINDOW_BYTES && !sink.failed) await sleep(2);
    if (sink.failed) return false;
    assert.equal(uploads.forwardUploadFrame(OWNER, id, bytes.subarray(at, Math.min(to, at + PIECE))), true);
  }
  return true;
}

/** Upload `bytes` as `name` to the linked host; resolves the upload id once the host reports it done. */
async function uploadFile(bytes, name = "data.bin", type = "application/octet-stream") {
  const id = randomUUID();
  const sink = recorder();
  const { received } = await uploads.startUpload({ id, hostId, owner: OWNER, name, size: bytes.byteLength, type, sink });
  assert.equal(received, 0);
  assert.equal(await pump(id, bytes, 0, bytes.byteLength, sink), true);
  await until(() => sink.done || sink.failed, "the upload to finish");
  assert.equal(sink.failed, null);
  return id;
}

/** A session file under the daemon's sessions directory (none needs to exist yet). */
function session() {
  const sessionId = randomUUID();
  const dir = join(getSessionsDir(), "-project");
  mkdirSync(dir, { recursive: true });
  // The daemon answers with the canonical path (macOS: /var is /private/var).
  return { host: { id: hostId }, sessionId, sessionFile: join(realpathSync(dir), `2026-11-02_${sessionId}.jsonl`) };
}

const uploadsDir = (s) => join(s.sessionFile.slice(0, -".jsonl".length), "local", "uploads");

/** What the hub sent a hand-driven host since the last call, taken off its socket: its lines (pings and acks too) and
 * its binary frames, decoded. */
function taken(host) {
  const lines = [];
  const chunks = [];
  for (const frame of host.socket.frames.splice(0)) {
    if (typeof frame !== "string") chunks.push(decodeBlobFrame(frame));
    else {
      const line = JSON.parse(frame);
      if (typeof line.seq === "number") host.ack = Math.max(host.ack, line.seq);
      lines.push(line);
    }
  }
  return { lines, chunks };
}

const takeReqs = (host) => taken(host).lines.filter((line) => line.type === "req");

/** An upload opened on a hand-driven host, which answers its start with `received` 0. */
async function openOn(host, id, size, sink = recorder()) {
  const starting = uploads.startUpload({ id, hostId: host.id, owner: OWNER, name: "h.bin", size, type: "", sink });
  await host.answer(takeReqs(host)[0], { received: 0, done: false });
  await starting;
  return sink;
}

test("a host link dropped mid-upload fails it 503; a new start resumes from the host's offset; the attached file matches its SHA-256 and the prompt names it", async () => {
  const bytes = randomBytes(6 * 1024 * 1024 + 123);
  const id = randomUUID();
  const sink = recorder();
  await uploads.startUpload({ id, hostId, owner: OWNER, name: "data.bin", size: bytes.byteLength, type: "application/octet-stream", sink });
  await pump(id, bytes, 0, 3 * 1024 * 1024, sink);
  const [old] = sockets;
  old.terminate();
  await until(() => sink.failed, "the upload to hear of the drop");
  assert.equal(sink.failed.code, "host_offline");

  // Resent until the daemon has redialed: the host answers with what it has written.
  const resumed = recorder();
  let received;
  await until(async () => {
    try {
      ({ received } = await uploads.startUpload({ id, hostId, owner: OWNER, name: "data.bin", size: bytes.byteLength, type: "application/octet-stream", sink: resumed }));
      return true;
    } catch (error) {
      assert.equal(error.status, 503, error.message);
      return false;
    }
  }, "the upload to resume");
  assert.ok(!sockets.has(old));
  assert.ok(received <= 3 * 1024 * 1024, String(received));
  resumed.received = received;
  assert.equal(await pump(id, bytes, received, bytes.byteLength, resumed), true);
  await until(() => resumed.done || resumed.failed, "the resumed upload to finish");
  assert.equal(resumed.failed, null);
  assert.equal(resumed.received, bytes.byteLength);

  const s = session();
  const command = { type: "prompt", message: "look" };
  await uploads.attachUploads([id], OWNER, s, command);
  const path = join(uploadsDir(s), "data.bin");
  assert.equal(sha(readFileSync(path)), sha(bytes));
  assert.equal(command.message, `look\n\nAttached files (this session's local:// directory):\n- local://uploads/data.bin (${path}, 6.3 MB, application/octet-stream)`);
  // The staged copy is gone.
  assert.deepEqual(readdirSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads")).filter((name) => name.startsWith(id)), []);
});

test("a taken name gets ' (1)'; a path-traversal name stays inside uploads/", async () => {
  const s = session();
  const first = await uploadFile(Buffer.from("one"), "a.txt", "text/plain");
  const second = await uploadFile(Buffer.from("two"), "a.txt", "text/plain");
  const evil = await uploadFile(Buffer.from("evil"), "../../../evil.txt", "text/plain");
  const command = { type: "prompt", message: "" };
  await uploads.attachUploads([first, second, evil], OWNER, s, command);
  const dir = uploadsDir(s);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(dir, "a (1).txt"), "utf8"), "two");
  assert.equal(readFileSync(join(dir, "evil.txt"), "utf8"), "evil");
  assert.ok(command.message.startsWith("Attached files (this session's local:// directory):\n- local://uploads/a.txt ("));
  assert.ok(command.message.includes("- local://uploads/a (1).txt ("));
  assert.ok(command.message.includes("- local://uploads/evil.txt ("));
  assert.equal(sanitizeUploadName(".."), "file");
  assert.equal(sanitizeUploadName("..\\..\\x.zip"), "x.zip");
});

test("an upload to a v5 daemon fails 426 host_upgrade_required; to This machine's, 426 host_restart_required", async () => {
  const old = await linkHost("Old", { hello: { v: 5 } });
  await assert.rejects(
    uploads.startUpload({ id: randomUUID(), hostId: old.id, owner: OWNER, name: "x", size: 1, type: "", sink: recorder() }),
    (error) => error.status === 426 && error.code === "host_upgrade_required" && error.message === "Update ompweb on Old to attach files",
  );
  old.drop();
  // An in-place upgrade leaves this machine's daemon running on its old link version: a restart is what it needs.
  const local = new LinkDriver("local", rotateLocalHostToken());
  await local.dial({ hello: { v: 5 } });
  await assert.rejects(
    uploads.startUpload({ id: randomUUID(), hostId: "local", owner: OWNER, name: "x", size: 1, type: "", sink: recorder() }),
    (error) => error.status === 426 && error.code === "host_restart_required",
  );
  local.drop();
});

test("a start of a known id by another owner, host or size fails 409 upload_id_conflict; that owner's chunks for it are refused", async () => {
  const bytes = randomBytes(PIECE + 5);
  const id = randomUUID();
  const sink = recorder();
  const start = (overrides) => uploads.startUpload({ id, hostId, owner: OWNER, name: "mine.bin", size: bytes.byteLength, type: "", sink, ...overrides });
  await start({});
  const elsewhere = createHost("Elsewhere").host.id;
  for (const overrides of [{ owner: "session:intruder", sink: recorder() }, { hostId: elsewhere }, { size: bytes.byteLength + 1 }]) {
    await assert.rejects(start(overrides), (error) => error.status === 409 && error.code === "upload_id_conflict", JSON.stringify(overrides));
  }
  // The intruder's failed up_start still put the id on its browser link (lib/browser-link.ts): only the owner check
  // stops its chunks here.
  assert.equal(uploads.forwardUploadFrame("session:intruder", id, bytes.subarray(0, PIECE)), false);
  assert.equal(await pump(id, bytes, 0, bytes.byteLength, sink), true);
  await until(() => sink.done || sink.failed, "the owner's upload to finish");
  assert.equal(sink.failed, null);
  const s = session();
  await uploads.attachUploads([id], OWNER, s, { type: "prompt", message: "" });
  assert.equal(sha(readFileSync(join(uploadsDir(s), "mine.bin"))), sha(bytes));
});

test("attachUploads refuses another owner's upload (404) and one staged on another host than the session's (409)", async () => {
  const id = await uploadFile(Buffer.from("attach me"), "attach.txt");
  const s = session();
  await assert.rejects(uploads.attachUploads([id], "session:intruder", s, { type: "prompt", message: "" }), (error) => error.status === 404 && error.code === "upload_missing");
  const other = { ...s, host: { id: createHost("Other").host.id } };
  await assert.rejects(uploads.attachUploads([id], OWNER, other, { type: "prompt", message: "" }), (error) => error.status === 409 && error.code === "upload_wrong_host");
  // Neither attached it: the owner still can, to its session on the upload's host.
  await uploads.attachUploads([id], OWNER, s, { type: "prompt", message: "" });
  assert.equal(readFileSync(join(uploadsDir(s), "attach.txt"), "utf8"), "attach me");
});

test("of two overlapping starts of one upload, the latest one's answer sets where its bytes go on from", async () => {
  const host = await linkHost("Two starts");
  const id = randomUUID();
  const start = () => uploads.startUpload({ id, hostId: host.id, owner: OWNER, name: "s", size: 4 * PIECE, type: "", sink: recorder() });
  const first = start();
  const second = start();
  const [one, two] = takeReqs(host);
  assert.deepEqual([one.op, two.op], ["uploadStart", "uploadStart"]);
  await host.answer(two, { received: PIECE, done: false });
  assert.deepEqual(await second, { received: PIECE });
  await host.answer(one, { received: 0, done: false });
  assert.deepEqual(await first, { received: 0 });
  // The offset the registry holds: a PUT at any other answers 409 with it.
  await assert.rejects(uploads.putUploadChunk(id, OWNER, 1, new Uint8Array(0)), (error) => error.code === "upload_offset" && error.received === PIECE);
  host.drop();
});

test("an upload aborted while its host opened it is aborted there again once the start answers", async () => {
  const host = await linkHost("Abort race");
  const id = randomUUID();
  const starting = uploads.startUpload({ id, hostId: host.id, owner: OWNER, name: "a", size: 10, type: "", sink: recorder() });
  const aborting = uploads.abortUpload(id, OWNER);
  const [start, abort] = takeReqs(host);
  assert.deepEqual([start.op, abort.op], ["uploadStart", "uploadAbort"]);
  // The host ran the abort first, then the start staged the file anew.
  await host.answer(abort, null);
  await aborting;
  await host.answer(start, { received: 0, done: false });
  await assert.rejects(starting, (error) => error.status === 404 && error.code === "upload_missing");
  assert.deepEqual(takeReqs(host).map((req) => [req.op, req.args.id]), [["uploadAbort", id]]);
  host.drop();
});

test("main stops an upload sent past its window: 429 upload_window_exceeded, and its later chunks stay here", async () => {
  const host = await linkHost("No acks");
  const id = randomUUID();
  const sink = await openOn(host, id, 64 * PIECE);
  // With no ack, the window and a piece of slack reach the host; the next chunk stops the upload.
  const fits = UPLOAD_WINDOW_BYTES / PIECE + 1;
  for (let i = 0; i < fits + 3; i++) assert.equal(uploads.forwardUploadFrame(OWNER, id, new Uint8Array(PIECE)), true);
  assert.deepEqual([sink.failed?.status, sink.failed?.code], [429, "upload_window_exceeded"]);
  assert.equal(taken(host).chunks.length, fits);
  host.drop();
});

test("a new start drops the chunks still queued for the host: they would land after the offset it reports", async () => {
  const host = await linkHost("Backpressure");
  const id = randomUUID();
  await openOn(host, id, 8 * PIECE);
  // Bun queues this frame over the socket's buffer: what follows waits in the hub for its drain.
  const send = host.socket.send;
  host.socket.send = function (data) {
    send.call(this, data);
    return -1;
  };
  for (let i = 0; i < 3; i++) assert.equal(uploads.forwardUploadFrame(OWNER, id, new Uint8Array(PIECE).fill(i)), true);
  const again = uploads.startUpload({ id, hostId: host.id, owner: OWNER, name: "h.bin", size: 8 * PIECE, type: "", sink: recorder() });
  host.socket.send = send;
  hub.hostLinkSocket.drain(host.socket);
  const { lines, chunks } = taken(host);
  assert.equal(chunks.length, 1, "only the chunk that went out before the start");
  const [req] = lines.filter((line) => line.type === "req");
  assert.equal(req.op, "uploadStart");
  await host.answer(req, { received: PIECE, done: false });
  assert.deepEqual(await again, { received: PIECE });
  host.drop();
});

test("a PUT while chunks are still unacked answers 409 upload_offset: its bytes would land after theirs", async () => {
  const host = await linkHost("In flight");
  const id = randomUUID();
  await openOn(host, id, 4 * PIECE);
  assert.equal(uploads.forwardUploadFrame(OWNER, id, new Uint8Array(PIECE)), true);
  const put = uploads.putUploadChunk(id, OWNER, 0, new Uint8Array(PIECE));
  const outcome = await Promise.race([put.then(() => "accepted", (error) => error), sleep(200).then(() => "still waiting")]);
  assert.deepEqual([outcome.code, outcome.received], ["upload_offset", 0], String(outcome));
  host.drop();
});

test("an owner may have 32 unfinished uploads at once (429 too_many_uploads); idle ones make room", async () => {
  const host = await linkHost("Many");
  const served = host.serve({ uploadStart: () => ({ received: 0, done: false }) });
  const start = (owner) => uploads.startUpload({ id: randomUUID(), hostId: host.id, owner, name: "m", size: 1, type: "", sink: recorder() });
  for (let i = 0; i < 32; i++) await start("session:many");
  await assert.rejects(start("session:many"), (error) => error.status === 429 && error.code === "too_many_uploads");
  await start("session:other");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10 * 60_000 + 1;
    await start("session:many");
  } finally {
    Date.now = realNow;
  }
  host.drop();
  await served;
});

test("an attach outlasts the usual op deadline: it may copy 2 GiB to another device", async () => {
  const host = await linkHost("Slow disk");
  const id = randomUUID();
  await openOn(host, id, 1);
  assert.equal(uploads.forwardUploadFrame(OWNER, id, new Uint8Array(1)), true);
  await host.post({ type: "upload_ack", id, received: 1, done: true });
  const timeout = hub.linkTimings.opTimeoutMs;
  hub.linkTimings.opTimeoutMs = 20;
  try {
    const command = { type: "prompt", message: "" };
    const attaching = uploads.attachUploads([id], OWNER, { host: { id: host.id }, sessionFile: "/remote/s.jsonl", sessionId: randomUUID() }, command);
    const [req] = takeReqs(host);
    assert.equal(req.op, "uploadAttach");
    await sleep(100);
    await host.answer(req, { path: "/remote/s/local/uploads/h.bin", url: "local://uploads/h.bin" });
    await attaching;
    assert.ok(command.message.includes("- local://uploads/h.bin (/remote/s/local/uploads/h.bin, 1 B, application/octet-stream)"), command.message);
  } finally {
    hub.linkTimings.opTimeoutMs = timeout;
  }
  host.drop();
});

test("a prompt naming another owner's upload fails 404 upload_missing; uploads on another command fail 400", async () => {
  const id = await uploadFile(Buffer.from("mine"));
  const response = await runAgentCommand("nobody", { type: "prompt", message: "x", uploads: [id] }, false, "session:someone-else");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "upload_missing");
  const wrongType = await runAgentCommand("nobody", { type: "get_state", uploads: [id] }, false, OWNER);
  assert.equal(wrongType.status, 400);
  assert.equal((await wrongType.json()).code, "invalid_uploads");
});

test("bytes beyond the announced size fail the upload, on main and on the daemon", async () => {
  const id = randomUUID();
  const sink = recorder();
  await uploads.startUpload({ id, hostId, owner: OWNER, name: "small", size: 10, type: "", sink });
  assert.equal(uploads.forwardUploadFrame(OWNER, id, new Uint8Array(11)), true);
  assert.equal(sink.failed?.code, "upload_too_large");
  assert.equal(uploads.forwardUploadFrame(OWNER, id, new Uint8Array(1)), false);

  const dir = join(scratch, "staged");
  const acks = [];
  const staged = new StagedUploads((ack) => acks.push(ack), dir);
  const daemonId = randomUUID();
  assert.deepEqual(await staged.start({ id: daemonId, name: "small", size: 4, type: "" }), { received: 0, done: false });
  staged.write(daemonId, new Uint8Array(3));
  staged.write(daemonId, new Uint8Array(3));
  await until(() => acks.some((ack) => ack.error), "the daemon to fail the upload");
  assert.equal(acks.find((ack) => ack.error).error.code, "upload_too_large");
  assert.equal(existsSync(join(dir, `${daemonId}.part`)), false);
});

test("the HTTP path (POST, PUT ?offset, DELETE) produces the same file", async () => {
  const bytes = randomBytes(2 * 1024 * 1024 + 7);
  const id = randomUUID();
  const base = `http://main.test/api/uploads`;
  const params = { params: Promise.resolve({ id }) };
  const start = await uploadsRoute.POST(new Request(base, { method: "POST", body: JSON.stringify({ id, host: hostId, name: "http.bin", size: bytes.byteLength, type: "application/octet-stream" }) }));
  assert.deepEqual(await start.json(), { received: 0 });
  const wrong = await uploadRoute.PUT(new Request(`${base}/${id}?offset=5`, { method: "PUT", body: bytes.subarray(0, 10) }), params);
  assert.equal(wrong.status, 409);
  assert.deepEqual(await wrong.json(), { error: "The upload is at another offset", code: "upload_offset", received: 0 });
  let last;
  for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
    const response = await uploadRoute.PUT(new Request(`${base}/${id}?offset=${offset}`, { method: "PUT", body: bytes.subarray(offset, offset + 1024 * 1024) }), params);
    assert.equal(response.status, 200);
    last = await response.json();
    assert.equal(last.received, Math.min(bytes.byteLength, offset + 1024 * 1024));
  }
  assert.deepEqual(last, { received: bytes.byteLength, done: true });
  const s = session();
  await uploads.attachUploads([id], OWNER, s, { type: "prompt", message: "" });
  assert.equal(sha(readFileSync(join(uploadsDir(s), "http.bin"))), sha(bytes));

  // DELETE removes an unfinished upload's staged file.
  const gone = randomUUID();
  await uploadsRoute.POST(new Request(base, { method: "POST", body: JSON.stringify({ id: gone, host: hostId, name: "g", size: 5, type: "" }) }));
  const staged = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads", `${gone}.part`);
  assert.equal(existsSync(staged), true);
  const deleted = await uploadRoute.DELETE(new Request(`${base}/${gone}`, { method: "DELETE" }), { params: Promise.resolve({ id: gone }) });
  assert.equal(deleted.status, 204);
  assert.equal(existsSync(staged), false);
});

test("two overlapping attaches of one upload make one host copy: no ' (1)' twin, no upload_missing", async () => {
  const s = session();
  const id = await uploadFile(Buffer.from("once"), "twin.txt", "text/plain");
  const [a, b] = [{ type: "prompt", message: "" }, { type: "prompt", message: "" }];
  await Promise.all([uploads.attachUploads([id], OWNER, s, a), uploads.attachUploads([id], OWNER, s, b)]);
  assert.deepEqual(readdirSync(uploadsDir(s)), ["twin.txt"]);
  assert.equal(a.message, b.message);
  assert.ok(a.message.includes("- local://uploads/twin.txt ("));
});

test("a prompt with uploads reaches the session with the Attached files block, and the file is on the host's disk", async (t) => {
  const s = session();
  const id = await uploadFile(Buffer.from("end to end"), "e2e.txt", "text/plain");
  const sent = [];
  const live = {
    host: s.host, sessionId: s.sessionId, sessionFile: s.sessionFile, advisorSpawned: false,
    isAlive: () => true, isRunning: () => false, isEditingHistory: () => false,
    send: async (command) => { sent.push(structuredClone(command)); return { ok: true }; },
  };
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[s.sessionId, live]]);
  t.after(() => { globalThis.__ompSessions = previous; });

  const response = await runAgentCommand(s.sessionId, { type: "prompt", message: "read it", uploads: [id] }, false, OWNER);
  assert.equal(response.status, 200, await response.clone().text());
  const path = join(uploadsDir(s), "e2e.txt");
  assert.equal(readFileSync(path, "utf8"), "end to end");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, `read it\n\nAttached files (this session's local:// directory):\n- local://uploads/e2e.txt (${path}, 10 B, text/plain)`);
  assert.equal("uploads" in sent[0], false, "omp never sees the field");
});
