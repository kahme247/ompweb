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
const { createHost } = await import("./hosts/registry.ts");
const { runHostDaemon } = await import("./hosts/daemon.ts");
const { encodeBlobFrame, LINK_LIMITS } = await import("./hosts/link-protocol.ts");
const { sanitizeUploadName, StagedUploads } = await import("./hosts/uploads.ts");
const { getSessionsDir } = await import("./omp/paths.ts");
const { runAgentCommand } = await import("./agent-command.ts");
const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
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
    while (at - sink.received >= uploads.UPLOAD_WINDOW_BYTES && !sink.failed) await sleep(2);
    if (sink.failed) return false;
    assert.equal(uploads.forwardUploadFrame(OWNER, encodeBlobFrame(id, bytes.subarray(at, Math.min(to, at + PIECE)))), true);
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

test("a socket dropped mid-upload resumes from the host's offset; the attached file matches its SHA-256 and the prompt names it", async () => {
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

test("an upload to a v5 daemon fails 426 host_upgrade_required", async () => {
  const old = await linkHost("Old", { hello: { v: 5 } });
  await assert.rejects(
    uploads.startUpload({ id: randomUUID(), hostId: old.id, owner: OWNER, name: "x", size: 1, type: "", sink: recorder() }),
    (error) => error instanceof uploads.UploadError && error.status === 426 && error.code === "host_upgrade_required",
  );
  old.drop();
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
  assert.equal(uploads.forwardUploadFrame(OWNER, encodeBlobFrame(id, new Uint8Array(11))), true);
  assert.equal(sink.failed?.code, "upload_too_large");
  assert.equal(uploads.forwardUploadFrame(OWNER, encodeBlobFrame(id, new Uint8Array(1))), false);

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
