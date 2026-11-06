// Composer uploads end to end on this process: the main registry (lib/uploads.ts) and the hub, linked over a loopback
// WebSocket to a real `ompweb host` daemon (runHostDaemon) that stages and attaches the files.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const outbox = await import("./message-outbox.ts");
const { closeOutboxStore } = outbox;
const { closeNotificationStore } = await import("./notification-store.ts");
const { requestOwner } = await import("./web-auth.ts");
const agentRoute = await import("../app/api/agent/[id]/route.ts");
const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
const { RpcCommandError } = await import("./omp/rpc-process.ts");

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
  for (let value = await predicate(); ; value = await predicate()) {
    if (value) return value;
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
  closeNotificationStore();
  closeOutboxStore();
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

/** A frame from the upload's current sender: the browser link or HTTP request whose start registered last. */
const forwardFrame = (owner, id, bytes) => uploads.forwardUploadFrame(owner, id, bytes, globalThis.__ompUploads?.get(id)?.sink);

/** Forward bytes[from, to) in pieces inside the upload window, as the browser worker does. False once the sink failed. */
async function pump(id, bytes, from, to, sink) {
  for (let at = from; at < to; at += PIECE) {
    while (at - sink.received >= UPLOAD_WINDOW_BYTES && !sink.failed) await sleep(2);
    if (sink.failed) return false;
    assert.equal(forwardFrame(OWNER, id, bytes.subarray(at, Math.min(to, at + PIECE))), true);
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

/** The sessions' project directory: a `#`, a space and parens, so the link targets must encode the directory too. */
const PROJECT = "-project #1 (x)";

/** A session file under the daemon's sessions directory (none needs to exist yet). */
function session() {
  const sessionId = randomUUID();
  const dir = join(getSessionsDir(), PROJECT);
  mkdirSync(dir, { recursive: true });
  // The daemon answers with the canonical path (macOS: /var is /private/var).
  return { host: { id: hostId }, sessionId, sessionFile: join(realpathSync(dir), `2026-11-02_${sessionId}.jsonl`) };
}

const uploadsDir = (s) => join(s.sessionFile.slice(0, -".jsonl".length), "local", "uploads");
/** The link target of a file in `dir`. The project directory's encoding is spelled out, so the test does not just
 * repeat the production encoder; the temp path around it (a profile name with a space on Windows) is encoded as the
 * link encodes any path. */
const encodeLink = (path) => encodeURI(path).replace(/[()#?&]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const linkTo = (dir, encodedName) => {
  const [before, after] = join(dir, "x").slice(0, -1).split(PROJECT);
  return `${encodeLink(before)}-project%20%231%20%28x%29${encodeLink(after)}${encodedName}`;
};

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

test("workspace publication enforces upload owner and host and cannot also attach to a session", async () => {
  const destination = join(scratch, "workspace");
  mkdirSync(destination, { recursive: true });
  await hub.getHost(hostId).sessionOps.validateCwd(destination);
  const id = await uploadFile(Buffer.from("workspace-only bytes"), "workspace.txt");
  try {
    await assert.rejects(uploads.publishWorkspaceUpload(id, "another-owner", hostId, destination, "workspace.txt", "error"), (e) => e.code === "upload_missing");
    await assert.rejects(uploads.publishWorkspaceUpload(id, OWNER, "local", destination, "workspace.txt", "error"), (e) => e.code === "upload_wrong_host");
    const result = await uploads.publishWorkspaceUpload(id, OWNER, hostId, destination, "workspace.txt", "error");
    assert.equal(readFileSync(result.path, "utf8"), "workspace-only bytes");
    assert.deepEqual(await uploads.publishWorkspaceUpload(id, OWNER, hostId, destination, "workspace.txt", "error"), result);
    await assert.rejects(uploads.attachUploads([id], OWNER, session(), { type: "prompt", message: "" }), (e) => e.code === "upload_destination_conflict");
    assert.throws(() => uploads.takeUploads({ type: "prompt", uploads: [id] }, OWNER), (e) => e.code === "upload_destination_conflict");
  } finally { await uploads.abortUpload(id, OWNER); }
  assert.equal(readFileSync(join(destination, "workspace.txt"), "utf8"), "workspace-only bytes");
});

test("a WS sender superseded by an HTTP resume cannot append its late frames: the file stays byte-exact", async () => {
  const bytes = randomBytes(2 * PIECE);
  const id = randomUUID();
  const request = { id, hostId, owner: OWNER, name: "handoff.bin", size: bytes.byteLength, type: "" };
  const ws = recorder();
  await uploads.startUpload({ ...request, sink: ws });
  assert.equal(uploads.forwardUploadFrame(OWNER, id, bytes.subarray(0, PIECE), ws), true);
  await until(() => ws.received === PIECE, "the first piece on the host");
  // The worker hands the upload to HTTP: the POST resumes it at the host's offset with its own sink.
  const { received } = await uploads.startUpload({ ...request, sink: { ack() {}, error() {} } });
  assert.equal(received, PIECE);
  // A frame the old socket still had in flight arrives now.
  assert.equal(uploads.forwardUploadFrame(OWNER, id, bytes.subarray(0, PIECE), ws), false, "a superseded sender is refused");
  const completed = await uploads.putUploadChunk(id, OWNER, PIECE, bytes.subarray(PIECE));
  assert.deepEqual({ received: completed.received, done: completed.done }, { received: bytes.byteLength, done: true });
  assert.match(completed.proof, /^[A-Za-z0-9_-]{43}$/);
  const s = session();
  await uploads.attachUploads([id], OWNER, s, { type: "prompt", message: "" });
  assert.equal(sha(readFileSync(join(uploadsDir(s), "handoff.bin"))), sha(bytes));
});

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
  assert.equal(command.message, `look\n\nAttached files (this session's local:// directory):\n- [\`local://uploads/data.bin\`](${linkTo(uploadsDir(s), "data.bin")}) (${path}, 6.3 MB, application/octet-stream)`);
  // The staged bytes are gone; the small receipt stays until the daemon's 24 h sweep.
  assert.deepEqual(readdirSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads")).filter((name) => name.startsWith(id)), [`${id}.json`]);
});

test("a taken name gets ' (1)'; a path-traversal name stays inside uploads/; any name makes a working link", async () => {
  const s = session();
  const first = await uploadFile(Buffer.from("one"), "a.txt", "text/plain");
  const second = await uploadFile(Buffer.from("two"), "a.txt", "text/plain");
  const evil = await uploadFile(Buffer.from("evil"), "../../../evil.txt", "text/plain");
  const odd = await uploadFile(Buffer.from("odd"), "x`y #1 &amp; 50%.txt", "text/plain");
  const command = { type: "prompt", message: "" };
  await uploads.attachUploads([first, second, evil, odd], OWNER, s, command);
  const dir = uploadsDir(s);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(dir, "a (1).txt"), "utf8"), "two");
  assert.equal(readFileSync(join(dir, "evil.txt"), "utf8"), "evil");
  assert.deepEqual(command.message.split("\n"), [
    "Attached files (this session's local:// directory):",
    `- [\`local://uploads/a.txt\`](${linkTo(dir, "a.txt")}) (${join(dir, "a.txt")}, 3 B, text/plain)`,
    `- [\`local://uploads/a (1).txt\`](${linkTo(dir, "a%20%281%29.txt")}) (${join(dir, "a (1).txt")}, 3 B, text/plain)`,
    `- [\`local://uploads/evil.txt\`](${linkTo(dir, "evil.txt")}) (${join(dir, "evil.txt")}, 4 B, text/plain)`,
    // The code span outgrows the backtick; `#`, `&`, `%` and spaces are encoded in the target only.
    `- [\`\`local://uploads/x\`y #1 &amp; 50%.txt\`\`](${linkTo(dir, "x%60y%20%231%20%26amp;%2050%25.txt")}) (${join(dir, "x`y #1 &amp; 50%.txt")}, 3 B, text/plain)`,
  ]);
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
  assert.equal(forwardFrame("session:intruder", id, bytes.subarray(0, PIECE)), false);
  assert.equal(await pump(id, bytes, 0, bytes.byteLength, sink), true);
  await until(() => sink.done || sink.failed, "the owner's upload to finish");
  assert.equal(sink.failed, null);
  const s = session();
  await uploads.attachUploads([id], OWNER, s, { type: "prompt", message: "" });
  assert.equal(sha(readFileSync(join(uploadsDir(s), "mine.bin"))), sha(bytes));
});

for (const conflict of [{ name: "different.bin" }, { type: "application/zip" }]) {
  test(`a conflicting ${Object.keys(conflict)[0]} start leaves the original upload usable`, async () => {
    const id = randomUUID();
    const bytes = randomBytes(PIECE + 5);
    const sink = recorder();
    const request = { id, hostId, owner: OWNER, name: "original.bin", type: "application/octet-stream", size: bytes.length, sink };
    await uploads.startUpload(request);
    assert.deepEqual(await uploads.putUploadChunk(id, OWNER, 0, bytes.subarray(0, PIECE)), { received: PIECE, done: false });
    await assert.rejects(
      uploads.startUpload({ ...request, ...conflict, sink: recorder() }),
      (error) => error.status === 409 && error.code === "upload_id_conflict",
    );
    assert.deepEqual(await uploads.putUploadChunk(id, OWNER, PIECE, new Uint8Array(0)), { received: PIECE, done: false });
    assert.equal(await pump(id, bytes, PIECE, bytes.length, sink), true);
    await until(() => sink.done || sink.failed, "the original upload to finish after the rejected start");
    assert.equal(sink.done, true, "the original sink still receives completion");
    assert.equal(sink.failed, null);
    const target = session();
    await uploads.attachUploads([id], OWNER, target, { type: "prompt", message: "" });
    assert.deepEqual(readFileSync(join(uploadsDir(target), request.name)), bytes);
  });
}

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

test("an abort its host could not take reaches it once the host links again", async () => {
  const host = await linkHost("Abort later");
  const id = randomUUID();
  await openOn(host, id, 10);
  host.drop();
  await uploads.abortUpload(id, OWNER);
  await host.dial();
  const req = await until(() => takeReqs(host).find((line) => line.op === "uploadAbort"), "the queued abort");
  assert.equal(req.args.id, id);
  await host.answer(req, null);
  // Delivered once: another hello sends nothing more.
  host.drop();
  await host.dial();
  await sleep(50);
  assert.deepEqual(takeReqs(host), []);
  host.drop();
});

test("an abort of an upload this server no longer registers goes to the host the browser names; another owner's is refused", async () => {
  const host = await linkHost("Unregistered abort");
  // A finished upload a restarted server forgot: only the browser still knows its host.
  const id = randomUUID();
  const aborting = uploads.abortUpload(id, OWNER, host.id);
  const req = await until(() => takeReqs(host).find((line) => line.op === "uploadAbort"), "the abort");
  assert.equal(req.args.id, id);
  await host.answer(req, null);
  await aborting;

  const theirs = randomUUID();
  await openOn(host, theirs, 10);
  await uploads.abortUpload(theirs, "someone-else", host.id);
  await uploads.abortUpload(randomUUID(), OWNER, "no-such-host");
  await sleep(50);
  assert.deepEqual(takeReqs(host), [], "no abort for another owner's upload, nor for an unknown host");
  assert.equal(globalThis.__ompPendingAborts?.has("no-such-host") ?? false, false, "an unknown host keeps nothing pending");
  host.drop();
});

test("a Retry of a failed upload is not deleted by the abort its failure left pending", async () => {
  const host = await linkHost("Retry after abort");
  const id = randomUUID();
  const timeout = hub.linkTimings.opTimeoutMs;
  hub.linkTimings.opTimeoutMs = 20;
  try {
    // The host did not answer in time: the abort waits for its next hello.
    await uploads.abortUpload(id, OWNER, host.id);
  } finally {
    hub.linkTimings.opTimeoutMs = timeout;
  }
  takeReqs(host);
  // The Retry opens the same id again.
  await openOn(host, id, 10);
  host.drop();
  await host.dial();
  await sleep(50);
  assert.deepEqual(takeReqs(host).filter((req) => req.op === "uploadAbort"), [], "the replay must not delete the resumed upload");
  host.drop();
});

test("an abort still in flight when a Retry of its id starts is not parked when it then times out", async () => {
  const host = await linkHost("Retry during abort");
  const id = randomUUID();
  const timeout = hub.linkTimings.opTimeoutMs;
  hub.linkTimings.opTimeoutMs = 50;
  let aborting;
  try {
    aborting = uploads.abortUpload(id, OWNER, host.id);
  } finally {
    hub.linkTimings.opTimeoutMs = timeout;
  }
  // A slow daemon: the Retry's start goes out while the abort is still unanswered.
  const sink = recorder();
  const starting = uploads.startUpload({ id, hostId: host.id, owner: OWNER, name: "h.bin", size: 10, type: "", sink });
  await aborting;
  const start = takeReqs(host).find((req) => req.op === "uploadStart");
  await host.answer(start, { received: 0, done: false });
  await starting;
  host.drop();
  await host.dial();
  await sleep(50);
  assert.deepEqual(takeReqs(host).filter((req) => req.op === "uploadAbort"), [], "the timed-out abort must not delete the Retry");
  host.drop();
});

test("a host keeps at most 1000 aborts pending, the newest", async () => {
  const host = await linkHost("Many aborts");
  host.drop();
  const ids = Array.from({ length: 1001 }, () => randomUUID());
  for (const id of ids) await uploads.abortUpload(id, OWNER, host.id);
  await host.dial();
  const replayed = [];
  await until(() => {
    replayed.push(...takeReqs(host).filter((req) => req.op === "uploadAbort"));
    return replayed.length >= 1000;
  }, "the replay");
  await sleep(50);
  replayed.push(...takeReqs(host).filter((req) => req.op === "uploadAbort"));
  assert.equal(replayed.length, 1000);
  assert.equal(replayed.some((req) => req.args.id === ids[0]), false, "the oldest went");
  for (const req of replayed) await host.answer(req, null);
  host.drop();
});

test("main stops an upload sent past its window: 429 upload_window_exceeded, and its later chunks stay here", async () => {
  const host = await linkHost("No acks");
  const id = randomUUID();
  const sink = await openOn(host, id, 64 * PIECE);
  // With no ack, the window and a piece of slack reach the host; the next chunk stops the upload.
  const fits = UPLOAD_WINDOW_BYTES / PIECE + 1;
  for (let i = 0; i < fits + 3; i++) assert.equal(forwardFrame(OWNER, id, new Uint8Array(PIECE)), true);
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
  for (let i = 0; i < 3; i++) assert.equal(forwardFrame(OWNER, id, new Uint8Array(PIECE).fill(i)), true);
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
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(PIECE)), true);
  const put = uploads.putUploadChunk(id, OWNER, 0, new Uint8Array(PIECE));
  const outcome = await Promise.race([put.then(() => "accepted", (error) => error), sleep(200).then(() => "still waiting")]);
  assert.deepEqual([outcome.code, outcome.received], ["upload_offset", 0], String(outcome));
  host.drop();
});

test("a PUT of the last bytes resolves on the host's done ack, not on the ack that reaches the size first", async () => {
  const host = await linkHost("Final fsync");
  const id = randomUUID();
  await openOn(host, id, 2 * PIECE);
  const first = uploads.putUploadChunk(id, OWNER, 0, new Uint8Array(PIECE));
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: PIECE, done: false });
  assert.deepEqual(await first, { received: PIECE, done: false }, "an intermediate PUT needs only its byte ack");
  const put = uploads.putUploadChunk(id, OWNER, PIECE, new Uint8Array(PIECE));
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: 2 * PIECE, done: false });
  assert.equal(await Promise.race([put.then(() => "resolved"), sleep(100).then(() => "pending")]), "pending");
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: 2 * PIECE, done: true });
  const completed = await put;
  assert.deepEqual({ received: completed.received, done: completed.done }, { received: 2 * PIECE, done: true });
  assert.match(completed.proof, /^[A-Za-z0-9_-]{43}$/);
  host.drop();
});

test("late error, progress and done acks from a superseded attempt are ignored after the new start answered", async () => {
  const host = await linkHost("Stale error");
  const id = randomUUID();
  const sink = await openOn(host, id, 4 * PIECE);
  const attemptA = globalThis.__ompUploads.get(id).attempt;
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(PIECE)), true);
  const starting = uploads.startUpload({ id, hostId: host.id, owner: OWNER, name: "h.bin", size: 4 * PIECE, type: "", sink });
  const [req] = takeReqs(host);
  const attemptB = req.args.attempt;
  const error = { status: 507, code: "upload_write_failed", message: "disk full" };
  await host.post({ type: "upload_ack", id, attempt: attemptA, received: 0, done: false, error });
  await host.answer(req, { received: 0, done: false });
  await starting;
  await host.post({ type: "upload_ack", id, attempt: attemptA, received: 0, done: false, error });
  assert.equal(sink.failed, null, "a queued old error cannot fail the answered new start");
  await host.post({ type: "upload_ack", id, attempt: attemptA, received: PIECE, done: false });
  await host.post({ type: "upload_ack", id, attempt: attemptA, received: 4 * PIECE, done: true });
  assert.deepEqual([sink.received, sink.done], [0, false]);
  assert.deepEqual(await uploads.putUploadChunk(id, OWNER, 0, new Uint8Array(0)), { received: 0, done: false });
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(PIECE)), true, "still registered");
  assert.match(attemptA, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(attemptB, attemptA);
  assert.equal(globalThis.__ompUploads.get(id).attempt, attemptB);
  await host.post({ type: "upload_ack", id, attempt: attemptB, received: 0, done: false, error });
  assert.equal(sink.failed?.code, "upload_write_failed");
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(PIECE)), false, "gone");
  host.drop();
});

test("an old error ack cannot fail a deleted and recreated registry entry with the same upload id", async () => {
  const host = await linkHost("Recreated upload");
  const id = randomUUID();
  await openOn(host, id, PIECE);
  const attemptA = globalThis.__ompUploads.get(id).attempt;
  const aborting = uploads.abortUpload(id, OWNER);
  await host.answer(takeReqs(host)[0], null);
  await aborting;
  const sink = await openOn(host, id, PIECE);
  const attemptB = globalThis.__ompUploads.get(id).attempt;
  await host.post({ type: "upload_ack", id, attempt: attemptA, received: 0, done: false, error: { status: 507, code: "upload_write_failed", message: "old write" } });
  assert.equal(sink.failed, null);
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(1)), true, "recreated upload stays registered");
  assert.notEqual(attemptB, attemptA);
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
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(1)), true);
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: 1, done: true });
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
    assert.ok(command.message.includes("- [`local://uploads/h.bin`](/remote/s/local/uploads/h.bin) (/remote/s/local/uploads/h.bin, 1 B, application/octet-stream)"), command.message);
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
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(11)), true);
  assert.equal(sink.failed?.code, "upload_too_large");
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(1)), false);

  const dir = join(scratch, "staged");
  const acks = [];
  const staged = new StagedUploads((ack) => acks.push(ack), dir);
  const daemonId = randomUUID();
  assert.deepEqual(await staged.start({ id: daemonId, name: "small", size: 4, type: "", attempt: randomUUID() }), { received: 0, done: false });
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
  assert.deepEqual({ received: last.received, done: last.done }, { received: bytes.byteLength, done: true });
  assert.match(last.proof, /^[A-Za-z0-9_-]{43}$/);
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

  // A staged upload this server no longer registers (it restarted): DELETE ?host= still reaches its host.
  const forgotten = randomUUID();
  await uploadsRoute.POST(new Request(base, { method: "POST", body: JSON.stringify({ id: forgotten, host: hostId, name: "f", size: 5, type: "" }) }));
  const forgottenFile = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads", `${forgotten}.part`);
  globalThis.__ompUploads.delete(forgotten);
  const byHost = await uploadRoute.DELETE(new Request(`${base}/${forgotten}?host=${encodeURIComponent(hostId)}`, { method: "DELETE" }), { params: Promise.resolve({ id: forgotten }) });
  assert.equal(byHost.status, 204);
  await until(() => !existsSync(forgottenFile), "the forgotten upload's staged file to go");
});

test("two overlapping attaches of one upload make one host copy: no ' (1)' twin, no upload_missing", async () => {
  const s = session();
  const id = await uploadFile(Buffer.from("once"), "twin.txt", "text/plain");
  const [a, b] = [{ type: "prompt", message: "" }, { type: "prompt", message: "" }];
  await Promise.all([uploads.attachUploads([id], OWNER, s, a), uploads.attachUploads([id], OWNER, s, b)]);
  assert.deepEqual(readdirSync(uploadsDir(s)), ["twin.txt"]);
  assert.equal(a.message, b.message);
  assert.ok(a.message.includes("- [`local://uploads/twin.txt`]("));
});

test("a prompt with uploads reaches the session with the Attached files block, and the file is on the host's disk", async (t) => {
  const s = session();
  const id = await uploadFile(Buffer.from("end to end"), "e2e.txt", "text/plain");
  const sent = [];
  const live = {
    host: s.host, sessionId: s.sessionId, sessionFile: s.sessionFile, advisorSpawned: false,
    isAlive: () => true, isRunning: () => false, isEditingHistory: () => false,
    withPendingCommand: async (callback) => await callback(),
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
  assert.equal(sent[0].message, `read it\n\nAttached files (this session's local:// directory):\n- [\`local://uploads/e2e.txt\`](${linkTo(uploadsDir(s), "e2e.txt")}) (${path}, 10 B, text/plain)`);
  assert.equal("uploads" in sent[0], false, "omp never sees the field");
});

test("a Stop sent behind a prompt still attaching reaches the session after the prompt; another session is not delayed", async (t) => {
  const host = await linkHost("Fence");
  const s = { host: { id: host.id }, sessionId: randomUUID(), sessionFile: "/remote/fence.jsonl" };
  const other = { host: { id: host.id }, sessionId: randomUUID(), sessionFile: "/remote/other.jsonl" };
  const id = randomUUID();
  await openOn(host, id, 1);
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(1)), true);
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: 1, done: true });
  const sent = [];
  const live = (session) => ({
    host: session.host, sessionId: session.sessionId, sessionFile: session.sessionFile, advisorSpawned: false,
    isAlive: () => true, isRunning: () => true, isEditingHistory: () => false,
    withPendingCommand: async (callback) => await callback(),
    send: async (command) => { sent.push(`${session.sessionId}:${command.type}`); return {}; },
  });
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[s.sessionId, live(s)], [other.sessionId, live(other)]]);
  t.after(() => { globalThis.__ompSessions = previous; });

  const prompt = runAgentCommand(s.sessionId, { type: "prompt", message: "go", uploads: [id] }, false, OWNER);
  let req;
  await until(() => (req = takeReqs(host)[0]), "the attach request");
  assert.equal(req.op, "uploadAttach");
  const stop = runAgentCommand(s.sessionId, { type: "abort_and_restore_queue" }, false, OWNER);
  assert.equal((await runAgentCommand(other.sessionId, { type: "abort" }, false, OWNER)).status, 200);
  await sleep(50);
  assert.deepEqual(sent, [`${other.sessionId}:abort`], "the Stop waits for the prompt; the other session does not");
  await host.answer(req, { path: "/remote/fence/local/uploads/h.bin", url: "local://uploads/h.bin" });
  assert.equal((await prompt).status, 200);
  assert.equal((await stop).status, 200);
  assert.deepEqual(sent.slice(1), [`${s.sessionId}:prompt`, `${s.sessionId}:abort_and_restore_queue`]);
  assert.equal(globalThis.__ompSendFences.size, 0, "settled fences leave no entry");

  // A failed attach releases the fence: the Stop goes through and the failure response is unchanged.
  const failing = randomUUID();
  const bad = runAgentCommand(s.sessionId, { type: "prompt", message: "x", uploads: [failing] }, false, OWNER);
  assert.equal((await bad).status, 404);
  assert.equal((await runAgentCommand(s.sessionId, { type: "abort" }, false, OWNER)).status, 200);
  host.drop();
});

test("an advisor toggle cannot replace an idle wrapper while a prompt attaches; dispatch, not its reply, frees the fence", async (t) => {
  const host = await linkHost("Advisor fence");
  t.after(() => host.drop());
  const s = { host: hub.getHost(host.id), sessionId: randomUUID(), sessionFile: "/remote/advisor.jsonl" };
  const otherId = randomUUID();
  const id = randomUUID();
  await openOn(host, id, 1);
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(1)), true);
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: 1, done: true });
  const sent = [];
  let running = false;
  let destroyed = 0;
  let finishPrompt;
  const promptReply = new Promise((resolve) => { finishPrompt = resolve; });
  const live = {
    ...s, advisorSpawned: false,
    isAlive: () => true, isRunning: () => running, isEditingHistory: () => false,
    withPendingCommand: async (callback) => await callback(),
    destroyAndWait: async () => { destroyed += 1; throw new Error("Cannot replace the preparing wrapper"); },
    send: async (command) => {
      sent.push(command.type);
      if (command.type === "prompt") {
        running = true;
        return promptReply;
      }
      return { original: true };
    },
  };
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([
    [s.sessionId, live],
    [otherId, { ...live, send: async () => { sent.push("other"); return {}; } }],
  ]);
  t.after(() => { globalThis.__ompSessions = previous; });

  const prompt = runAgentCommand(s.sessionId, { type: "prompt", message: "go", uploads: [id] }, false, OWNER);
  try {
    let req;
    await until(() => (req = takeReqs(host)[0]), "the advisor attach request");
    assert.equal(req.op, "uploadAttach");
    const state = runAgentCommand(s.sessionId, { type: "get_state" }, true, OWNER);
    assert.equal((await runAgentCommand(otherId, { type: "get_state" }, false, OWNER)).status, 200);
    await sleep(50);
    const destroyedDuringPreparation = destroyed;
    const sentDuringPreparation = [...sent];
    await host.answer(req, { path: "/remote/advisor/local/uploads/h.bin", url: "local://uploads/h.bin" });
    const response = await state;
    assert.equal(destroyedDuringPreparation, 0, "advisor selection must not destroy the wrapper before the prompt dispatches");
    assert.deepEqual(sentDuringPreparation, ["other"], "another session proceeds while this session waits");
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { success: true, data: { original: true } });
    assert.deepEqual(sent, ["other", "prompt", "get_state"], "the busy original wrapper handles the later command before the prompt replies");
    assert.equal(destroyed, 0);
  } finally {
    finishPrompt({});
    host.drop();
    assert.equal((await prompt).status, 200);
  }
  assert.equal(globalThis.__ompSendFences.has(s.sessionId), false);
});

test("the attach fence holds a command sent through another alias of the same wrapper", async (t) => {
  const host = await linkHost("Alias fence");
  t.after(() => host.drop());
  const s = { host: hub.getHost(host.id), sessionId: randomUUID(), sessionFile: "/remote/alias.jsonl" };
  const movedId = randomUUID();
  const id = randomUUID();
  await openOn(host, id, 1);
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(1)), true);
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: 1, done: true });
  const sent = [];
  let destroyed = 0;
  const live = {
    ...s, advisorSpawned: false,
    isAlive: () => true, isRunning: () => sent.includes("prompt"), isEditingHistory: () => false,
    withPendingCommand: async (callback) => await callback(),
    destroyAndWait: async () => { destroyed += 1; throw new Error("Cannot replace the preparing wrapper"); },
    send: async (command) => { sent.push(command.type); return {}; },
  };
  const previous = globalThis.__ompSessions;
  // omp moved the session: the old id stays an alias of the same wrapper.
  globalThis.__ompSessions = new Map([[s.sessionId, live], [movedId, live]]);
  t.after(() => { globalThis.__ompSessions = previous; });

  const prompt = runAgentCommand(s.sessionId, { type: "prompt", message: "go", uploads: [id] }, false, OWNER);
  let req;
  await until(() => (req = takeReqs(host)[0]), "the alias attach request");
  const state = runAgentCommand(movedId, { type: "get_state" }, true, OWNER);
  await sleep(50);
  assert.equal(destroyed, 0, "the other alias waits for the prompt instead of replacing its wrapper");
  assert.deepEqual(sent, []);
  await host.answer(req, { path: "/remote/alias/local/uploads/h.bin", url: "local://uploads/h.bin" });
  assert.equal((await prompt).status, 200);
  assert.equal((await state).status, 200);
  assert.deepEqual(sent, ["prompt", "get_state"]);
  assert.equal(destroyed, 0);
});

test("a failed attach frees the fence and the waiting command selects the latest wrapper", async (t) => {
  const host = await linkHost("Failed attach fence");
  t.after(() => host.drop());
  const s = { host: { id: host.id }, sessionId: randomUUID(), sessionFile: "/remote/failed-fence.jsonl" };
  const id = randomUUID();
  await openOn(host, id, 1);
  assert.equal(forwardFrame(OWNER, id, new Uint8Array(1)), true);
  await host.post({ type: "upload_ack", id, attempt: globalThis.__ompUploads.get(id).attempt, received: 1, done: true });
  const sent = [];
  const live = (name) => ({
    ...s, advisorSpawned: false,
    isAlive: () => true, isRunning: () => false, isEditingHistory: () => false,
    withPendingCommand: async (callback) => await callback(),
    send: async (command) => { sent.push(`${name}:${command.type}`); return {}; },
  });
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[s.sessionId, live("old")]]);
  t.after(() => { globalThis.__ompSessions = previous; });

  const prompt = runAgentCommand(s.sessionId, { type: "prompt", message: "go", uploads: [id] }, false, OWNER);
  let req;
  await until(() => (req = takeReqs(host)[0]), "the failing attach request");
  assert.equal(req.op, "uploadAttach");
  const state = runAgentCommand(s.sessionId, { type: "get_state" }, false, OWNER);
  globalThis.__ompSessions.set(s.sessionId, live("new"));
  await host.post({ type: "res", id: req.id, ok: false, error: { status: 404, code: "upload_missing", message: "Upload is gone" } });
  const failed = await prompt;
  assert.equal(failed.status, 404);
  assert.equal((await failed.json()).code, "upload_missing");
  assert.equal((await state).status, 200);
  assert.deepEqual(sent, ["new:get_state"], "selection happens after the predecessor finishes, not before waiting");
  assert.equal(globalThis.__ompSendFences.has(s.sessionId), false);
});

const loginHeaders = (cookie) => ({ cookie: `omp_web_session=${cookie}` });
const loginOwner = (cookie) => requestOwner(new Request("http://main.test", { headers: loginHeaders(cookie) }));

/** Real HTTP registration, host bytes/fsync and SQLite completion; only the authenticated middleware is outside this fixture. */
async function continuityFile(cookie, name = "continuity.txt", text = "preserved bytes", id = randomUUID()) {
  const body = { id, host: hostId, name, size: Buffer.byteLength(text), type: "text/plain" };
  const started = await uploadsRoute.POST(new Request("http://main.test/api/uploads", {
    method: "POST", headers: loginHeaders(cookie), body: JSON.stringify(body),
  }));
  assert.equal(started.status, 200, await started.clone().text());
  const completed = await uploadRoute.PUT(new Request(`http://main.test/api/uploads/${id}?offset=0`, {
    method: "PUT", headers: loginHeaders(cookie), body: Buffer.from(text),
  }), { params: Promise.resolve({ id }) });
  assert.equal(completed.status, 200, await completed.clone().text());
  return { id, body, ...(await completed.json()) };
}

function continuitySession(t, { offline = false, refuse = false } = {}) {
  const s = session();
  const listeners = new Set();
  let generation = 0;
  const live = {
    ...s, advisorSpawned: false, offline, sent: [],
    host: { id: hostId, status: () => live.offline ? "offline" : "online" },
    isAlive: () => true, isRunning: () => true, isEditingHistory: () => false,
    withPendingCommand: async (callback) => callback(),
    getMessageCommandGeneration: () => generation,
    hasPendingMessageCommands: () => false,
    confirmMessageCommandGeneration() {},
    watchMessageReplacement(...args) { return AgentSessionWrapper.prototype.watchMessageReplacement.call(live, ...args); },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(command) {
      if (live.offline) throw new WebRpcError("Host offline", "host_offline", "refused");
      if (command.type === "get_state") return { queuedMessages: { steering: [], followUp: [] } };
      // As sendNativeMessageCommand: the write is recorded before omp's answer, a refusal included.
      (globalThis.__ompNativeWrites ??= new WeakSet()).add(command);
      if (refuse) throw new RpcCommandError(command.type, "Controlled native refusal");
      generation += 1;
      live.sent.push(structuredClone(command));
      const event = { type: "queue_update", steering: [], followUp: [command.message] };
      for (const listener of [...listeners]) listener(event);
      return {};
    },
  };
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(s.sessionId, live);
  t.after(() => globalThis.__ompSessions.delete(s.sessionId));
  return live;
}

async function continuityAdd(live, file, cookie = "renewed-login", overrides = {}) {
  return agentRoute.POST(new Request(`http://main.test/api/agent/${live.sessionId}`, {
    method: "POST", headers: loginHeaders(cookie),
    body: JSON.stringify({
      type: "outbox_add", scope: outbox.outboxScope(), id: randomUUID(), mode: "followUp", message: "read it",
      uploads: [file.id], uploadProofs: { [file.id]: file.proof }, ...overrides,
    }),
  }), { params: Promise.resolve({ id: live.sessionId }) });
}

test("upload continuity: HTTP completion and concurrent completed starts return one durable proof without renewing its age", async () => {
  const file = await continuityFile("initial-login");
  assert.match(file.proof, /^[A-Za-z0-9_-]{43}$/);
  const at = globalThis.__ompOutboxStore.db.prepare("SELECT at FROM completed_uploads WHERE id = ?").get(file.id).at;
  const replies = await Promise.all(Array.from({ length: 3 }, async () => {
    const response = await uploadsRoute.POST(new Request("http://main.test/api/uploads", {
      method: "POST", headers: loginHeaders("initial-login"), body: JSON.stringify(file.body),
    }));
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.deepEqual(replies.map(({ proof }) => proof), [file.proof, file.proof, file.proof]);
  assert.equal(globalThis.__ompOutboxStore.db.prepare("SELECT at FROM completed_uploads WHERE id = ?").get(file.id).at, at);
});

test("upload continuity: a renewed cookie attaches the completed bytes through the actual outbox consumer", async (t) => {
  const file = await continuityFile("before-login");
  const live = continuitySession(t);
  const response = await continuityAdd(live, file);
  assert.equal(response.status, 200, await response.clone().text());
  await until(() => live.sent.length || outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "proof-authorized dispatch");
  assert.equal(live.sent.length, 1, JSON.stringify(outbox.outboxEntries(live.sessionId)));
  assert.equal(readFileSync(join(uploadsDir(live), "continuity.txt"), "utf8"), "preserved bytes");
  assert.ok(live.sent[0].message.includes("local://uploads/continuity.txt"));
  assert.equal("uploadProofs" in live.sent[0], false);
  assert.equal("uploads" in live.sent[0], false);
  assert.equal(JSON.stringify(live.sent).includes(file.proof), false);
});

test("upload continuity: mixed original owners survive acceptance then SQLite and registry restart without public authority leaks", async (t) => {
  const old = await continuityFile("older-cookie", "old.txt", "old bytes");
  const fresh = await continuityFile("renewed-login", "new.txt", "new bytes");
  const live = continuitySession(t, { offline: true });
  const response = await continuityAdd(live, old, "renewed-login", {
    uploads: [old.id, fresh.id], uploadProofs: { [old.id]: old.proof },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const receipt = await response.json();
  await until(() => outbox.outboxEntries(live.sessionId)[0]?.state === "waiting_host", "held attachment");
  const publicJson = JSON.stringify([receipt, outbox.outboxEntries(live.sessionId)]);
  for (const secret of [old.proof, fresh.proof, loginOwner("older-cookie"), loginOwner("renewed-login")]) {
    assert.equal(publicJson.includes(secret), false, "public receipt/snapshot cannot disclose attachment authority");
  }
  assert.equal(globalThis.__ompUploads.get(old.id).owner, loginOwner("older-cookie"), "acceptance never transfers ownership");
  outbox.closeOutboxStore();
  globalThis.__ompOutbox = undefined;
  globalThis.__ompUploads.clear();
  const previous = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = "a".repeat(64);
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
    else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = previous;
  });
  live.offline = false;
  outbox.pumpOutbox(live.sessionId);
  await until(() => live.sent.length || outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "accepted private authority after restart");
  assert.equal(live.sent.length, 1, JSON.stringify(outbox.outboxEntries(live.sessionId)));
  assert.equal(readFileSync(join(uploadsDir(live), "old.txt"), "utf8"), "old bytes");
  assert.equal(readFileSync(join(uploadsDir(live), "new.txt"), "utf8"), "new bytes");
  assert.ok(live.sent[0].message.includes("local://uploads/old.txt"));
  assert.ok(live.sent[0].message.includes("local://uploads/new.txt"));
});

test("upload continuity: legacy original-owner sends remain proof-free while renewed-owner direct prompt, steer and follow_up consume proofs privately", async (t) => {
  const live = continuitySession(t);
  for (const type of ["prompt", "steer", "follow_up"]) {
    const file = await continuityFile("direct-old", `${type}.txt`, type);
    const response = await runAgentCommand(live.sessionId, {
      type, message: "read", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
    }, false, loginOwner("direct-new"));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(readFileSync(join(uploadsDir(live), `${type}.txt`), "utf8"), type);
    assert.equal("uploadProofs" in live.sent.at(-1), false);
  }
  const legacy = await continuityFile("same-owner", "legacy.txt", "legacy");
  const response = await runAgentCommand(live.sessionId, { type: "prompt", message: "old client", uploads: [legacy.id] }, false, loginOwner("same-owner"));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(readFileSync(join(uploadsDir(live), "legacy.txt"), "utf8"), "legacy");
});

test("upload continuity: missing, tampered and swapped proofs refuse acceptance without losing staged bytes", async (t) => {
  const a = await continuityFile("private-a", "private.txt", "keep me");
  const b = await continuityFile("private-b", "other.txt", "not that file");
  const live = continuitySession(t);
  for (const uploadProofs of [undefined, { [a.id]: "x".repeat(43) }, { [a.id]: b.proof }, { [b.id]: a.proof }]) {
    const response = await continuityAdd(live, a, "unauthorized", { uploadProofs });
    assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
    assert.deepEqual(outbox.outboxEntries(live.sessionId), []);
    assert.deepEqual(live.sent, []);
  }
  const response = await runAgentCommand(live.sessionId, { type: "prompt", message: "recover", uploads: [a.id] }, false, loginOwner("private-a"));
  assert.equal(response.status, 200);
  assert.equal(readFileSync(join(uploadsDir(live), "private.txt"), "utf8"), "keep me");
});

test("upload continuity: malformed claims and forged JSON receipts never supply private authority", async (t) => {
  const file = await continuityFile("real-owner");
  const live = continuitySession(t);
  for (const uploadProofs of [null, [], "secret", { [file.id]: 42 }, { [randomUUID()]: "x".repeat(43) }]) {
    const response = await continuityAdd(live, file, "intruder", { uploadProofs });
    assert.equal(response.status, 400, await response.clone().text());
    assert.deepEqual(outbox.outboxEntries(live.sessionId), []);
  }
  const forged = await continuityAdd(live, file, "intruder", {
    uploadProofs: undefined, owner: loginOwner("real-owner"),
    upload_receipts: [{ ...file.body, owner: loginOwner("real-owner") }],
    trustedUploads: [{ id: file.id, owner: loginOwner("real-owner") }],
  });
  assert.ok(forged.status >= 400 && forged.status < 500, await forged.clone().text());
  assert.deepEqual(live.sent, []);
});

test("upload continuity: expired and changed-scope proofs cannot authorize a new message after registry restart", async (t) => {
  const live = continuitySession(t);
  for (const condition of ["expired", "scope"]) {
    const file = await continuityFile("scope-old", `${condition}.txt`);
    if (condition === "expired") {
      globalThis.__ompOutboxStore.db.prepare("UPDATE completed_uploads SET at = ? WHERE id = ?").run(Date.now() - 24 * 60 * 60 * 1000 - 1, file.id);
    }
    globalThis.__ompUploads.clear();
    outbox.closeOutboxStore();
    const previous = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
    if (condition === "scope") process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = "b".repeat(64);
    try {
      const response = await continuityAdd(live, file);
      assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
      assert.deepEqual(outbox.outboxEntries(live.sessionId), []);
      assert.deepEqual(live.sent, []);
    } finally {
      if (previous === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
      else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = previous;
    }
  }
});

test("upload continuity: known message IDs dedupe before their upload proofs expire", async (t) => {
  const file = await continuityFile("dedupe-old");
  const live = continuitySession(t, { offline: true });
  const id = randomUUID();
  const first = await continuityAdd(live, file, "dedupe-new", { id });
  assert.equal(first.status, 200);
  await until(() => outbox.outboxEntries(live.sessionId)[0]?.state === "waiting_host", "dedupe held");
  globalThis.__ompOutboxStore.db.prepare("UPDATE completed_uploads SET at = ? WHERE id = ?").run(Date.now() - 24 * 60 * 60 * 1000 - 1, file.id);
  globalThis.__ompUploads.clear();
  const repeated = await continuityAdd(live, file, "another-renewed-cookie", { id });
  assert.equal(repeated.status, 200, await repeated.clone().text());
  assert.equal((await repeated.json()).data.entry.id, id);
  assert.equal(outbox.outboxEntries(live.sessionId).length, 1);
});

test("upload continuity: proofs do not grant start, chunk or cancellation and canceled IDs get unrelated authority on reuse", async (t) => {
  const file = await continuityFile("cancel-owner");
  const intruder = loginOwner("cancel-new");
  await assert.rejects(uploads.startUpload({ ...file.body, hostId, owner: intruder, sink: recorder(), proof: file.proof }), (error) => error.code === "upload_id_conflict");
  await assert.rejects(uploads.putUploadChunk(file.id, intruder, file.received, Buffer.alloc(0)), (error) => error.code === "upload_missing");
  await uploads.abortUpload(file.id, intruder, hostId);
  const live = continuitySession(t);
  assert.equal((await continuityAdd(live, file, "cancel-new")).status, 200, "cross-owner abort must not destroy the owner's file");
  await until(() => live.sent.length === 1, "the uncanceled owner's delivery");
  const canceled = await continuityFile("cancel-owner", "reuse.txt", "first upload");
  await uploads.abortUpload(canceled.id, loginOwner("cancel-owner"), hostId);
  const reused = await continuityFile("cancel-owner", "reuse.txt", "second upload", canceled.id);
  assert.notEqual(reused.proof, canceled.proof);
  const response = await continuityAdd(live, reused, "cancel-new", { uploadProofs: { [reused.id]: canceled.proof } });
  assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
  assert.equal(live.sent.length, 1);
});

test("upload continuity: valid proofs retain host confinement and attach the same file into the selected session's own path", async (t) => {
  const file = await continuityFile("host-owner");
  const live = continuitySession(t);
  const otherHost = createHost("Wrong upload destination").host.id;
  live.host.id = otherHost;
  const response = await continuityAdd(live, file);
  if (response.status === 200) {
    await until(() => outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "wrong-host dispatch refusal");
  } else {
    assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
  }
  assert.deepEqual(live.sent, []);
  live.host.id = hostId;
  const original = session();
  mkdirSync(uploadsDir(original), { recursive: true });
  writeFileSync(join(uploadsDir(original), "continuity.txt"), "preserved bytes");
  const moved = await runAgentCommand(live.sessionId, {
    type: "prompt", message: "attach to this session", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("renewed-login"));
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(live.sent.length, 1);
  const targetPath = join(uploadsDir(live), "continuity.txt");
  assert.equal(readFileSync(targetPath, "utf8"), "preserved bytes");
  assert.ok(live.sent[0].message.includes(targetPath), "the prompt names the selected session's local file");
  assert.equal(live.sent[0].message.includes(uploadsDir(original)), false, "no original-session filesystem path is reused");
  assert.equal("uploadProofs" in live.sent[0], false);
  assert.equal(readFileSync(join(uploadsDir(original), "continuity.txt"), "utf8"), "preserved bytes");
});

test("upload continuity: durable receipt failure cannot publish a completed bearer proof", async () => {
  // Ensure the database exists before installing the actual SQLite write refusal.
  outbox.outboxEntries("receipt-failure");
  const id = randomUUID();
  const body = { id, host: hostId, name: "failure.txt", size: 1, type: "text/plain" };
  const started = await uploadsRoute.POST(new Request("http://main.test/api/uploads", { method: "POST", body: JSON.stringify(body) }));
  assert.equal(started.status, 200);
  globalThis.__ompOutboxStore.db.exec("CREATE TRIGGER refuse_completion BEFORE INSERT ON completed_uploads BEGIN SELECT RAISE(FAIL, 'controlled disk refusal'); END");
  try {
    const response = await uploadRoute.PUT(new Request(`http://main.test/api/uploads/${id}?offset=0`, { method: "PUT", body: "x" }), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 500);
    const failed = await response.json();
    assert.equal(failed.code, "upload_receipt_failed");
    assert.equal("proof" in failed, false);
    assert.equal(outbox.completedUpload(id), null);
  } finally {
    globalThis.__ompOutboxStore.db.exec("DROP TRIGGER refuse_completion");
  }
});

test("upload continuity: completed proof survives a server restart before renewed-cookie acceptance", async (t) => {
  const file = await continuityFile("pre-restart", "restart.txt", "disk receipt");
  globalThis.__ompUploads.clear();
  outbox.closeOutboxStore();
  const live = continuitySession(t);
  const response = await continuityAdd(live, file);
  assert.equal(response.status, 200, await response.clone().text());
  await until(() => live.sent.length || outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "restored receipt dispatch");
  assert.equal(live.sent.length, 1, JSON.stringify(outbox.outboxEntries(live.sessionId)));
  assert.equal(readFileSync(join(uploadsDir(live), "restart.txt"), "utf8"), "disk receipt");
});

test("upload continuity: native refusal preserves original ownership, file and proof for same-session recovery", async (t) => {
  const file = await continuityFile("refusal-old", "refused.txt", "not lost");
  const live = continuitySession(t, { refuse: true });
  const response = await runAgentCommand(live.sessionId, {
    type: "follow_up", message: "try", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("refusal-new"));
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error, "Controlled native refusal");
  assert.equal(globalThis.__ompUploads.get(file.id).owner, loginOwner("refusal-old"));
  assert.equal(readFileSync(join(uploadsDir(live), "refused.txt"), "utf8"), "not lost");
  assert.deepEqual(live.sent, []);
  live.send = async (command) => { live.sent.push(structuredClone(command)); return {}; };
  const recovered = await runAgentCommand(live.sessionId, {
    type: "follow_up", message: "retry", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("refusal-new"));
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal(readdirSync(uploadsDir(live)).filter((name) => name.startsWith("refused")).length, 1);
  assert.equal("uploadProofs" in live.sent[0], false);
});

test("upload continuity: an already-attached ID replays only within its original session, never into another session", async (t) => {
  const file = await continuityFile("bound-owner", "bound.txt", "session-bound bytes");
  const original = session();
  const first = { type: "prompt", message: "read" };
  const replay = { type: "prompt", message: "read" };
  await uploads.attachUploads([file.id], loginOwner("bound-owner"), original, first);
  await uploads.attachUploads([file.id], loginOwner("bound-owner"), original, replay);
  assert.equal(replay.message, first.message);
  assert.deepEqual(readdirSync(uploadsDir(original)), ["bound.txt"], "same-session replay does not create another copy");
  const target = continuitySession(t);
  const response = await runAgentCommand(target.sessionId, {
    type: "prompt", message: "cannot move an attached ID",
    uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("bound-renewed"));
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal((await response.json()).code, "upload_missing");
  assert.deepEqual(target.sent, []);
  assert.equal(existsSync(join(uploadsDir(target), "bound.txt")), false);
  assert.equal(readFileSync(join(uploadsDir(original), "bound.txt"), "utf8"), "session-bound bytes");
});

test("upload continuity: an accepted intent cannot consume replacement bytes after its upload ID is reused", async (t) => {
  const file = await continuityFile("retained-owner", "retained.txt", "first bytes");
  const live = continuitySession(t, { offline: true });
  const accepted = await continuityAdd(live, file);
  assert.equal(accepted.status, 200);
  await until(() => outbox.outboxEntries(live.sessionId)[0]?.state === "waiting_host", "the retained intent");
  await uploads.abortUpload(file.id, loginOwner("retained-owner"), hostId);
  const restarted = await uploadsRoute.POST(new Request("http://main.test/api/uploads", {
    method: "POST", headers: loginHeaders("retained-owner"), body: JSON.stringify(file.body),
  }));
  if (restarted.ok) {
    const replaced = await uploadRoute.PUT(new Request(`http://main.test/api/uploads/${file.id}?offset=0`, {
      method: "PUT", headers: loginHeaders("retained-owner"), body: "other bytes",
    }), { params: Promise.resolve({ id: file.id }) });
    assert.equal(replaced.status, 200, await replaced.clone().text());
  } else {
    assert.ok(restarted.status >= 400 && restarted.status < 500, await restarted.clone().text());
  }
  globalThis.__ompUploads.clear();
  outbox.closeOutboxStore();
  live.offline = false;
  outbox.startOutbox();
  outbox.pumpOutbox(live.sessionId);
  await until(() => live.sent.length || outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "the original intent's outcome");
  if (live.sent.length) {
    assert.equal(readFileSync(join(uploadsDir(live), "retained.txt"), "utf8"), "first bytes", "a prior acceptance is not authority for replacement content");
  } else {
    assert.equal(outbox.outboxEntries(live.sessionId)[0].state, "failed", "the old intent remains visible if its file was canceled");
  }
});

test("upload continuity: direct attachment preparation cannot consume a later upload generation", async (t) => {
  const file = await continuityFile("direct-generation-owner", "direct-generation.txt", "first bytes");
  const live = continuitySession(t);
  let release;
  const prior = new Promise((resolve) => { release = resolve; });
  globalThis.__ompSendFences ??= new Map();
  globalThis.__ompSendFences.set(live.sessionId, prior);
  const sending = runAgentCommand(live.sessionId, {
    type: "follow_up", message: "read the original", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("direct-generation-renewed"));
  try {
    await uploads.abortUpload(file.id, loginOwner("direct-generation-owner"), hostId);
    await continuityFile("direct-generation-owner", "direct-generation.txt", "other bytes", file.id);
  } finally {
    release();
  }
  const response = await sending;
  if (response.ok) {
    assert.equal(readFileSync(join(uploadsDir(live), "direct-generation.txt"), "utf8"), "first bytes", "preparation authorizes one upload generation, not a later file");
  } else {
    assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
    assert.deepEqual(live.sent, []);
  }
});

test("upload continuity: proof authority is current when a new outbox entry is committed", async (t) => {
  const file = await continuityFile("admission-owner", "admission.txt", "first bytes");
  const live = continuitySession(t, { offline: true });
  const id = randomUUID();
  const accepting = outbox.runOutboxCommand(live.sessionId, {
    type: "outbox_add", id, scope: outbox.outboxScope(), mode: "followUp", message: "keep my file",
    uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("admission-renewed"));
  const canceling = uploads.abortUpload(file.id, loginOwner("admission-owner"), hostId);
  const response = await accepting;
  await canceling;
  assert.ok(response.status >= 400 && response.status < 500, "a canceled proof cannot be accepted after the asynchronous session lookup");
  assert.equal(outbox.outboxEntries(live.sessionId).some((entry) => entry.id === id), false);
  assert.deepEqual(live.sent, []);
});

test("upload continuity: a fresh proof cannot reuse another main instance's stale attached receipt", async (t) => {
  const file = await continuityFile("cached-owner", "cached.txt", "first bytes");
  const live = continuitySession(t);
  await uploads.attachUploads([file.id], loginOwner("cached-owner"), live, { type: "prompt", message: "" });
  const oldRegistration = globalThis.__ompUploads.get(file.id);
  await uploads.abortUpload(file.id, loginOwner("cached-owner"), hostId);
  const replacement = await continuityFile("cached-owner", "cached.txt", "other bytes", file.id);
  // A different live main keeps its old memory snapshot while SQLite and the host have a newer completion.
  globalThis.__ompUploads.set(file.id, oldRegistration);
  const response = await runAgentCommand(live.sessionId, {
    type: "follow_up", message: "read the new file", uploads: [file.id], uploadProofs: { [file.id]: replacement.proof },
  }, false, loginOwner("cached-renewed"));
  assert.equal(response.status, 200, await response.clone().text());
  const fresh = readdirSync(uploadsDir(live)).filter((name) => readFileSync(join(uploadsDir(live), name), "utf8") === "other bytes");
  assert.equal(fresh.length, 1, "fresh authority must resolve the fresh file, not a cached older path");
  assert.ok(live.sent[0].message.includes(join(uploadsDir(live), fresh[0])));
  assert.equal(readFileSync(join(uploadsDir(live), "cached.txt"), "utf8"), "first bytes", "the earlier session file is not overwritten");
});

test("upload continuity: cached attachment receipts still require a regular file before native dispatch", async (t) => {
  const file = await continuityFile("missing-target-owner", "missing-target.txt");
  const live = continuitySession(t);
  await uploads.attachUploads([file.id], loginOwner("missing-target-owner"), live, { type: "prompt", message: "" });
  rmSync(join(uploadsDir(live), "missing-target.txt"));
  const response = await runAgentCommand(live.sessionId, {
    type: "follow_up", message: "not without its file", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("missing-target-renewed"));
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal((await response.json()).code, "upload_missing");
  assert.deepEqual(live.sent, []);
});

test("upload continuity: a completed proof is not reused after the host loses its staged file", async (t) => {
  const file = await continuityFile("lost-stage-owner", "lost-stage.txt", "first bytes");
  rmSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "uploads", `${file.id}.part`));
  const restarted = await uploadsRoute.POST(new Request("http://main.test/api/uploads", {
    method: "POST", headers: loginHeaders("lost-stage-owner"), body: JSON.stringify(file.body),
  }));
  if (restarted.ok) {
    const replacement = await uploadRoute.PUT(new Request(`http://main.test/api/uploads/${file.id}?offset=0`, {
      method: "PUT", headers: loginHeaders("lost-stage-owner"), body: "other bytes",
    }), { params: Promise.resolve({ id: file.id }) });
    assert.equal(replacement.status, 200, await replacement.clone().text());
  } else {
    assert.ok(restarted.status >= 400 && restarted.status < 500, await restarted.clone().text());
  }
  const live = continuitySession(t);
  const response = await continuityAdd(live, file);
  if (response.ok) {
    await until(() => live.sent.length || outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "the lost stage outcome");
  } else {
    assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
  }
  assert.deepEqual(live.sent, [], "a lost completion cannot grant authority for a newly written file");
});

test("upload continuity: an older native reply cannot forget a newer upload generation", async (t) => {
  const file = await continuityFile("reply-owner", "reply.txt", "first bytes");
  const live = continuitySession(t);
  const originalSend = live.send.bind(live);
  let release;
  let observed;
  let first = true;
  const released = new Promise((resolve) => { release = resolve; });
  const sent = new Promise((resolve) => { observed = resolve; });
  live.send = async (command) => {
    const result = await originalSend(command);
    if (first && command.type === "follow_up") {
      first = false;
      observed();
      await released;
    }
    return result;
  };
  const sending = runAgentCommand(live.sessionId, {
    type: "follow_up", message: "first", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
  }, false, loginOwner("reply-renewed"));
  let replacement;
  try {
    await sent;
    await uploads.abortUpload(file.id, loginOwner("reply-owner"), hostId);
    replacement = await continuityFile("reply-owner", "reply.txt", "other bytes", file.id);
  } finally {
    release();
  }
  assert.equal((await sending).status, 200);
  const response = await runAgentCommand(live.sessionId, {
    type: "follow_up", message: "second", uploads: [file.id], uploadProofs: { [file.id]: replacement.proof },
  }, false, loginOwner("reply-another-cookie"));
  assert.equal(response.status, 200, await response.clone().text());
  const fresh = readdirSync(uploadsDir(live)).filter((name) => readFileSync(join(uploadsDir(live), name), "utf8") === "other bytes");
  assert.equal(fresh.length, 1);
  assert.ok(live.sent[1].message.includes(join(uploadsDir(live), fresh[0])));
});

test("upload continuity: legacy acceptance survives first proof issuance for the same completed file", async (t) => {
  const file = await continuityFile("legacy-upgrade-owner", "legacy-upgrade.txt", "original bytes");
  globalThis.__ompOutboxStore.db.prepare("UPDATE completed_uploads SET proof = NULL, scope = NULL WHERE id = ?").run(file.id);
  globalThis.__ompUploads.clear();
  const live = continuitySession(t, { offline: true });
  const accepted = await continuityAdd(live, file, "legacy-upgrade-owner", { uploadProofs: undefined });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  await until(() => outbox.outboxEntries(live.sessionId)[0]?.state === "waiting_host", "legacy owner acceptance");
  // A receipt already accepted by a pre-continuity server has no generation binding.
  const entryId = (await accepted.json()).data.entry.id;
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET upload_receipts = json_remove(upload_receipts, '$[0].completionKey') WHERE id = ?").run(entryId);
  globalThis.__ompOutboxStore.db.prepare("UPDATE completed_uploads SET proof = NULL, scope = NULL WHERE id = ?").run(file.id);
  globalThis.__ompUploads.clear();
  const completed = await uploadsRoute.POST(new Request("http://main.test/api/uploads", {
    method: "POST", headers: loginHeaders("legacy-upgrade-owner"), body: JSON.stringify(file.body),
  }));
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.match((await completed.json()).proof, /^[A-Za-z0-9_-]{43}$/);
  globalThis.__ompUploads.clear();
  outbox.closeOutboxStore();
  live.offline = false;
  outbox.startOutbox();
  outbox.pumpOutbox(live.sessionId);
  await until(() => live.sent.length || outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "legacy accepted delivery");
  assert.equal(live.sent.length, 1, JSON.stringify(outbox.outboxEntries(live.sessionId)));
  assert.equal(readFileSync(join(uploadsDir(live), "legacy-upgrade.txt"), "utf8"), "original bytes");
});

test("upload continuity: direct legacy preparation survives first proof issuance while fenced", async (t) => {
  const file = await continuityFile("legacy-direct-owner", "legacy-direct.txt", "original bytes");
  globalThis.__ompOutboxStore.db.prepare("UPDATE completed_uploads SET proof = NULL, scope = NULL WHERE id = ?").run(file.id);
  globalThis.__ompUploads.clear();
  const live = continuitySession(t);
  let release;
  const prior = new Promise((resolve) => { release = resolve; });
  globalThis.__ompSendFences ??= new Map();
  globalThis.__ompSendFences.set(live.sessionId, prior);
  const sending = runAgentCommand(live.sessionId, {
    type: "follow_up", message: "read it", uploads: [file.id],
  }, false, loginOwner("legacy-direct-owner"));
  try {
    const completed = await uploadsRoute.POST(new Request("http://main.test/api/uploads", {
      method: "POST", headers: loginHeaders("legacy-direct-owner"), body: JSON.stringify(file.body),
    }));
    assert.equal(completed.status, 200, await completed.clone().text());
  } finally {
    release();
  }
  const response = await sending;
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(readFileSync(join(uploadsDir(live), "legacy-direct.txt"), "utf8"), "original bytes");
  assert.equal(live.sent.length, 1);
});

test("upload continuity: first proof issuance during held transcript preparation preserves the file", async (t) => {
  const cookie = "active-legacy-owner";
  const file = await continuityFile(cookie, "active-legacy.txt", "original legacy bytes");
  const live = continuitySession(t, { offline: true });
  const accepted = await continuityAdd(live, file, cookie, { uploadProofs: undefined });
  assert.equal(accepted.status, 200);
  await until(() => outbox.outboxEntries(live.sessionId)[0]?.state === "waiting_host", "legacy held intent");
  const entryId = (await accepted.json()).data.entry.id;
  globalThis.__ompOutboxStore.db.prepare("UPDATE entries SET upload_receipts = json_remove(upload_receipts, '$[0].completionKey', '$[0].owner', '$[0].completedAt') WHERE id = ?").run(entryId);
  globalThis.__ompOutboxStore.db.prepare("UPDATE completed_uploads SET proof = NULL, scope = NULL WHERE id = ?").run(file.id);
  globalThis.__ompUploads.clear();
  let observed, release;
  const preparing = new Promise((resolve) => { observed = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  live.isRunning = () => false;
  live.host.sessionOps = { readContext: async () => {
    observed();
    await gate;
    return { ok: true, value: { entryIds: [] } };
  } };
  live.offline = false;
  outbox.pumpOutbox(live.sessionId);
  await preparing;
  try {
    const replay = await uploadsRoute.POST(new Request("http://main.test/api/uploads", {
      method: "POST", headers: loginHeaders(cookie), body: JSON.stringify(file.body),
    }));
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.match((await replay.json()).proof, /^[A-Za-z0-9_-]{43}$/);
  } finally { release(); }
  await until(() => live.sent.length || outbox.outboxEntries(live.sessionId)[0]?.state === "failed", "active legacy outcome");
  assert.equal(live.sent.length, 1, JSON.stringify(outbox.outboxEntries(live.sessionId)));
  assert.equal(readFileSync(join(uploadsDir(live), "active-legacy.txt"), "utf8"), "original legacy bytes");
});
