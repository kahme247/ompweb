import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Real daemon processes, native files and the authenticated WebSocket link. The
// same relative path has different bytes under each owner's root and main's decoy.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-owner-files-")));
const hostBin = fileURLToPath(new URL("../../bin/omp-web-host.js", import.meta.url));
const originalEnv = { ...process.env };
const MAIN_ID = "11111111-2222-4333-8444-000000000011";
const A_ID = "11111111-2222-4333-8444-000000000012";
const B_ID = "11111111-2222-4333-8444-000000000013";
const UNKNOWN_ID = "11111111-2222-4333-8444-000000000099";
const binarySize = 8 * 1024 * 1024;
const docx = Buffer.from([
  "UEsDBBQAAAAIAFWKal26d6ScywAAAFMBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbJWQvVLDQAyEX+XmWiYnQ0HB2E4BtEDBC2jO",
  "sn3D/c1JCeHtkRNIQUcp7Wq/HfX7U4rmSI1DyYO9dZ3dj/37VyU2qmQe7CpSHwDYr5SQXamUVZlLSyg6tgUq+g9cCO667h58yUJZ",
  "drJl2LF/ohkPUczzSdcXSqPI1jxejBtrsFhrDB5FdTjm6Q9l90Nwenn28Boq36jBwti/av0WJjJv2OQFk8bBZ2kTTMUfkiLcZvwX",
  "r8xz8HS939JqK56YQ15SdFclYci/PeD8tvEbUEsDBBQAAAAIAFWKal1fM5VSlQAAAAcBAAALAAAAX3JlbHMvLnJlbHONzzsOwjAM",
  "BuCrRD5AnTIwoKZdWLoiLhAlblPRPOSE1+3JwEARA6N///osd8PDr+JGnJcYFLSNhKHvTrTqUoPslpRFbYSswJWSDojZOPI6NzFR",
  "qJspsteljjxj0uaiZ8KdlHvkTwO2phitAh5tC+L8TPSPHadpMXSM5uoplB8nvhpV1jxTUXCPbNG+46aygH2Hmxf7F1BLAwQUAAAA",
  "CABVimpd0Z5b8oQAAAC1AAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRY5RDsIgEESvQjhAt/rhR0PpETwDArYkZZcsKHp7ocb48zYz",
  "k90dtbziLp6ecyCc5WkY5aJVnRzZR/RYRIsxT3WWWylpAsh289HkgZLHlt2JoylN8gqV2CUm63MOuMYdzuN4gWgCyn7yRu7dZ+rg",
  "jqKvFT2L3zMF3evkg+ngdw/+nfQHUEsBAhQDFAAAAAgAVYpqXbp3pJzLAAAAUwEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50",
  "X1R5cGVzXS54bWxQSwECFAMUAAAACABVimpdXzOVUpUAAAAHAQAACwAAAAAAAAAAAAAAgAH8AAAAX3JlbHMvLnJlbHNQSwECFAMU",
  "AAAACABVimpd0Z5b8oQAAAC1AAAAEQAAAAAAAAAAAAAAgAG6AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAbQIA",
  "AAAA",
].join(""), "base64");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function machine(name, id, byte) {
  const home = join(scratch, name);
  const agent = join(home, ".omp", "agent");
  const project = join(home, "project");
  const artifacts = join(home, "artifacts");
  const sessionFile = join(agent, "sessions", "project", `${id}.jsonl`);
  for (const directory of [join(agent, "sessions", "project"), join(project, "uploads"), join(project, "node_modules"), artifacts, join(home, "fresh")]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(project, "shared.txt"), `${name} unpublished\n`);
  writeFileSync(join(project, `${name}-only.txt`), name);
  writeFileSync(join(project, "tracked.txt"), "committed\n");
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  writeFileSync(join(project, "binary.bin"), Buffer.alloc(binarySize, byte));
  writeFileSync(join(project, "empty.bin"), "");
  writeFileSync(join(project, "image.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(project, "image.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><text>${name}</text></svg>`);
  writeFileSync(join(project, "audio.wav"), `${name} audio`);
  writeFileSync(join(project, "document.pdf"), `%PDF-1.7\n${name}\n`);
  writeFileSync(join(project, "document.docx"), name === "central" ? Buffer.from("central decoy") : docx);
  writeFileSync(join(project, "node_modules", "ignored.txt"), name);
  writeFileSync(join(project, "uploads", "existing.txt"), `${name} original`);
  mkdirSync(join(project, "uploads", "directory"));
  writeFileSync(join(artifacts, "result.txt"), `${name} artifact`);
  writeFileSync(join(artifacts, "unreferenced.txt"), `${name} private`);
  writeFileSync(join(home, "fresh", "fresh.txt"), `${name} before transcript`);
  for (const name of ["agent.db", "agent.db-wal", "agent.db-shm", "agent.db-journal", "models.yml"]) writeFileSync(join(agent, name), "credential-do-not-return");
  writeFileSync(join(agent, "AGENTS.md"), `${name} instructions`);
  writeFileSync(join(project, "too-large.txt"), "");
  truncateSync(join(project, "too-large.txt"), 256 * 1024 + 1);
  writeFileSync(join(project, "too-large.png"), "");
  truncateSync(join(project, "too-large.png"), 10 * 1024 * 1024 + 1);
  writeFileSync(join(project, "too-large.docx"), "");
  truncateSync(join(project, "too-large.docx"), 10 * 1024 * 1024 + 1);
  for (let n = 0; n < 205; n++) writeFileSync(join(project, `needle-${name}-${String(n).padStart(3, "0")}.ts`), "export {};\n");
  git(project, "init", "-q");
  git(project, "config", "user.name", "owner files fixture");
  git(project, "config", "user.email", "ompweb@example.invalid");
  git(project, "add", "tracked.txt");
  git(project, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  writeFileSync(join(project, "tracked.txt"), `${name} dirty\n`);
  const references = ["~/artifacts/result.txt", ...["agent.db", "agent.db-wal", "agent.db-shm", "agent.db-journal", "models.yml"].map((name) => join(agent, name))];
  writeFileSync(sessionFile, [
    { type: "session", version: 3, id, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: references.join("\n") }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { name, id, home, agent, project, artifacts, sessionFile, byte, process: null, log: "", hostId: null };
}

const central = machine("central", MAIN_ID, 0x43);
const ownerA = machine("owner-a", A_ID, 0x41);
const ownerB = machine("owner-b", B_ID, 0x42);
process.env.HOME = central.home;
process.env.USERPROFILE = central.home;
process.env.PI_CONFIG_DIR = ".omp";
process.env.PI_CODING_AGENT_DIR = central.agent;
const fakeOmp = join(scratch, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
const ompScript = `if(process.argv.includes('--version')){console.log('18.0.0-files-fixture');process.exit(0)}
const path=require('node:path');
const sessionId=require('node:crypto').randomUUID();
const sessionFile=path.join(process.env.PI_CODING_AGENT_DIR,'sessions',sessionId+'.jsonl');
const out=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
out({type:'ready',supportedProtocolVersions:[1,2]});
require('node:readline').createInterface({input:process.stdin}).on('line',(line)=>{
 const command=JSON.parse(line);
 const data=command.type==='negotiate_protocol'?{protocolVersion:2}:command.type==='get_state'?{sessionId,sessionFile,isStreaming:false,isCompacting:false}:{};
 out({type:'response',id:command.id,command:command.type,success:true,data});
});
process.stdin.on('end',()=>process.exit(0));`;
if (process.platform === "win32") {
  writeFileSync(`${fakeOmp}.cjs`, ompScript);
  writeFileSync(fakeOmp, `@"${process.execPath.replaceAll("%", "%%")}" "${fakeOmp.replaceAll("%", "%%")}.cjs" %*\r\n`);
} else writeFileSync(fakeOmp, `#!${process.execPath}\n${ompScript}`, { mode: 0o755 });

const linkRoute = await import("../../app/api/hosts/link/route.ts");
const hub = await import("./hub.ts");
const { createHost, rotateLocalHostToken } = await import("./registry.ts");
const { hostSessions, listSessionsAllHosts } = await import("./session-index.ts");
const { getRpcSession, startRpcSession } = await import("../rpc-manager.ts");
const { allowFileRoot } = await import("../file-access.ts");
const { decodeBlobFrame, LINK_LIMITS } = await import("./link-protocol.ts");
const { requestHostControl } = await import("./host-control.ts");
const { StagedUploads, STAGED_MAX_AGE_MS } = await import("./uploads.ts");
const { EventStreamConnection } = await import("../event-stream-hub.ts");
const { closeNotificationStore } = await import("../notification-store.ts");
const filesRoute = await import("../../app/api/files/[...path]/route.ts");
const indexRoute = await import("../../app/api/file-index/route.ts");
const statusRoute = await import("../../app/api/git/status/route.ts");
const diffRoute = await import("../../app/api/git/diff/route.ts");
allowFileRoot(central.project);

const sockets = new Map();
const socketWrappers = new WeakMap();
const wire = [];
function record(direction, ws, frame) {
  if (typeof frame === "string") wire.push({ direction, hostId: ws.data.hostId, textBytes: Buffer.byteLength(frame) });
  else {
    const blob = decodeBlobFrame(new Uint8Array(frame));
    wire.push({ direction, hostId: ws.data.hostId, id: blob.id, bytes: blob.bytes.byteLength });
  }
}
function wrap(ws) {
  let wrapper = socketWrappers.get(ws);
  if (!wrapper) {
    wrapper = { data: ws.data, send(frame) { record("down", ws, frame); return ws.send(frame); }, close: (code, reason) => ws.close(code, reason), terminate: () => ws.terminate() };
    socketWrappers.set(ws, wrapper);
  }
  return wrapper;
}
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: { "/api/hosts/link": { GET: (request) => linkRoute.GET(request, { upgrade: (data) => server.upgrade(request, { data }) }) } },
  websocket: {
    ...hub.hostLinkSocket,
    open(ws) { sockets.set(ws, ws.data); },
    message(ws, frame) { record("up", ws, frame); hub.hostLinkSocket.message(wrap(ws), frame); },
    drain(ws) { hub.hostLinkSocket.drain(wrap(ws)); },
    close(ws) { sockets.delete(ws); hub.hostLinkSocket.close(wrap(ws)); },
  },
});

async function until(predicate, what, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, `Timed out waiting for ${what}\n${ownerA.log}\n${ownerB.log}\n${central.log}`);
    await sleep(20);
  }
}
async function startDaemon(machine, token) {
  const env = { ...process.env, HOME: machine.home, USERPROFILE: machine.home, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: machine.agent, OMP_WEB_OMP_BIN: fakeOmp, OMP_WEB_DISABLE_AUTOUPDATE: "1" };
  const url = `http://127.0.0.1:${server.port}`;
  const login = spawnSync("node", [hostBin, "login", "--url", url], { env, input: `${token}\n`, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);
  machine.process = spawn("node", [hostBin], { env, stdio: ["ignore", "pipe", "pipe"] });
  machine.process.stdout.on("data", (chunk) => { machine.log += chunk; });
  machine.process.stderr.on("data", (chunk) => { machine.log += chunk; });
  await until(() => hub.getHost(machine.hostId)?.status() === "online", `${machine.name} daemon to link`, 20000);
}
async function stopDaemon(machine) {
  if (!machine.process || machine.process.exitCode !== null) return;
  const exited = new Promise((resolve) => machine.process.once("exit", resolve));
  machine.process.kill("SIGTERM");
  await exited;
}
before(async () => {
  const a = createHost("Files owner A");
  const b = createHost("Files owner B");
  ownerA.hostId = a.host.id;
  ownerB.hostId = b.host.id;
  central.hostId = "local";
  await Promise.all([startDaemon(central, rotateLocalHostToken()), startDaemon(ownerA, a.token), startDaemon(ownerB, b.token)]);
  const listed = await listSessionsAllHosts();
  for (const machine of [central, ownerA, ownerB]) assert.equal(listed.find((session) => session.id === machine.id)?.hostId ?? "local", machine.hostId);
});
after(async () => {
  await Promise.all([...new Set(globalThis.__ompSessions?.values() ?? [])].map((session) => session.destroyAndWait()));
  await Promise.all([central, ownerA, ownerB].map(stopDaemon));
  await server.stop(true);
  closeNotificationStore();
  hub.flushLinkSamples();
  process.env = originalEnv;
  rmSync(scratch, { recursive: true, force: true });
});

const slash = (value) => value.replace(/\\/g, "/");
function fileRequest(filePath, type, sessionId, init = {}, query = {}) {
  const segments = slash(filePath).replace(/^\/+/, "").split("/");
  const url = new URL(`http://main.test/api/files/${segments.map(encodeURIComponent).join("/")}`);
  url.searchParams.set("type", type);
  if (sessionId !== null) url.searchParams.set("sessionId", sessionId);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const request = new Request(url, init);
  const context = { params: Promise.resolve({ path: segments }), disableIdleTimeout() {} };
  return init.method === "POST" ? filesRoute.POST(request, context) : filesRoute.GET(request, context);
}
function projectRequest(route, machine, query = {}, sessionId = machine.id) {
  const url = new URL("http://main.test/api/workspace");
  url.searchParams.set("cwd", machine.project);
  if (sessionId !== null) url.searchParams.set("sessionId", sessionId);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return route.GET(new Request(url));
}
function upload(machine, entries, conflict, directory = join(machine.project, "uploads")) {
  const form = new FormData();
  for (const [name, bytes] of entries) form.append("files", new File([bytes], name));
  return fileRequest(directory, "upload", machine.id, { method: "POST", body: form }, conflict ? { conflict } : {});
}
const checkUpload = (machine, fileNames, directory = join(machine.project, "uploads")) => fileRequest(directory, "upload-check", machine.id, { method: "POST", body: JSON.stringify({ fileNames }), headers: { "content-type": "application/json" } });
async function jsonOK(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
function watchConnection() {
  const frames = [];
  const connection = new EventStreamConnection(undefined, {
    heartbeatMs: 60000,
    write(name, _at, data) { frames.push({ name, data: JSON.parse(data) }); return true; },
    backpressured: () => false,
    heartbeat: () => true,
    close() {},
  });
  return { connection, frames };
}

test("completed multipart staging keeps native bytes leased through abort and sweep and releases busy accounting", async (t) => {
  const id = randomUUID();
  const attempt = randomUUID();
  const payload = Buffer.from("native staged multipart bytes");
  let done = false;
  const staging = new StagedUploads((ack) => { if (ack.id === id && ack.done) done = true; }, join(scratch, "lease-staging"));
  t.after(() => staging.abort(id));
  await staging.start({ id, attempt, name: "multipart", type: "application/octet-stream", size: payload.length });
  staging.write(id, payload);
  await until(() => done, "native staging completion");
  await assert.rejects(staging.withCompleted(id, 1, async () => assert.fail("oversized staged body must not be consumed")), (error) => error.code === "upload_total_too_large");
  const gate = Promise.withResolvers();
  let leased;
  const consuming = staging.withCompleted(id, 1024, async (file) => {
    leased = file;
    assert.deepEqual(readFileSync(file), payload);
    await gate.promise;
    assert.deepEqual(readFileSync(file), payload);
    return "consumed";
  });
  await until(() => leased, "completed-body lease");
  assert.equal(staging.busy(), true);
  let aborted = false;
  const aborting = staging.abort(id).then(() => { aborted = true; });
  try {
    await staging.sweep(Date.now() + STAGED_MAX_AGE_MS + 1);
    assert.equal(aborted, false);
    assert.deepEqual(readFileSync(leased), payload);
  } finally { gate.resolve(); }
  assert.equal(await consuming, "consumed");
  await aborting;
  assert.equal(staging.busy(), false);
  assert.equal(existsSync(leased), false);
});

// Break caught: using main's allow-list/path resolver, or another selected
// session's owner, instead of the source session's immutable identity.
test("the identical file URL reads each real owner and leaves sessionless local reads unchanged", async () => {
  for (const machine of [ownerA, ownerB, central]) {
    const response = await fileRequest("shared.txt", "read", machine.id);
    assert.deepEqual(await jsonOK(response), { content: `${machine.name} unpublished\n`, language: "text", size: Buffer.byteLength(`${machine.name} unpublished\n`) });
  }
  const local = await fileRequest("shared.txt", "read", null);
  assert.equal((await jsonOK(local)).content, "central unpublished\n");
});

test("a real live session browses its actual cwd before any lazy transcript or session-list entry exists", async (t) => {
  const cwd = join(ownerA.home, "fresh");
  const started = await startRpcSession("", "", cwd, undefined, false, null, undefined, hub.getHost(ownerA.hostId));
  t.after(() => started.session.destroyAndWait());
  assert.equal(started.session.cwd, cwd);
  assert.ok(!(await hostSessions(ownerA.hostId, true)).some((session) => session.id === started.realSessionId));
  const state = await started.session.send({ type: "get_state" });
  assert.equal(existsSync(state.sessionFile), false);
  const read = await fileRequest("fresh.txt", "read", started.realSessionId);
  assert.equal((await jsonOK(read)).content, "owner-a before transcript");
  const listing = await jsonOK(await fileRequest(cwd, "list", started.realSessionId));
  assert.ok(listing.entries.some((entry) => entry.name === "fresh.txt" && !entry.isDir));
  assert.equal((await fileRequest(join(central.home, "fresh", "fresh.txt"), "read", started.realSessionId, {}, { cwd: join(central.home, "fresh"), hostId: "local" })).status, 403);
});

test("durable real owner metadata keeps an unpublished workspace browsable after its live wrapper is gone", async (t) => {
  const creationId = "native-files-journal";
  const cwd = join(ownerA.home, ".project_worktrees", "session", creationId);
  git(ownerA.project, "worktree", "add", "-b", `session/${creationId}`, "--", cwd, "HEAD");
  writeFileSync(join(cwd, "unpublished.txt"), "owner-a durable unpublished");
  const started = await startRpcSession("", "", cwd, undefined, false, null, undefined, hub.getHost(ownerA.hostId));
  t.after(() => started.session.destroyAndWait());
  const { realSessionId } = started;
  const state = await started.session.send({ type: "get_state" });
  assert.equal(existsSync(state.sessionFile), false);
  // A saved admission journal is input data, like the native JSONL fixtures;
  // the owner/session identity here came from the actual child, not a fake op.
  const requestFingerprint = "a".repeat(64);
  const identity = { cloneRoot: ownerA.project, creationId, hostId: ownerA.hostId, launchConfig: null, origin: "https://example.invalid/project.git", poolId: "files", projectId: "project", ref: null, requestFingerprint };
  const fingerprint = createHash("sha256").update("ompweb:pool-creation:v1:").update(JSON.stringify(identity)).digest("hex");
  const journalPath = join(central.agent, "omp-web", "pool-starts.json");
  writeFileSync(journalPath, JSON.stringify({ version: 1, starts: [{ creationId, poolId: "files", projectId: "project", requestFingerprint, fingerprint, hostId: ownerA.hostId, origin: identity.origin, cloneRoot: ownerA.project, prepared: { cwd, projectRoot: ownerA.project, baseCommit: git(ownerA.project, "rev-parse", "HEAD").trim() }, creation: "started", initialization: "complete", sessionId: realSessionId, reserved: false }] }));
  t.after(() => rmSync(journalPath, { force: true }));
  await started.session.destroyAndWait();
  assert.ok(!getRpcSession(realSessionId)?.isAlive());
  assert.ok(!(await hostSessions(ownerA.hostId, true)).some((session) => session.id === realSessionId));
  const read = await jsonOK(await fileRequest(join(cwd, "unpublished.txt"), "read", realSessionId));
  assert.equal(read.content, "owner-a durable unpublished");
  const listing = await jsonOK(await fileRequest(cwd, "list", realSessionId));
  assert.ok(listing.entries.some((entry) => entry.name === "unpublished.txt"));
  assert.equal((await fileRequest(join(central.project, "shared.txt"), "read", realSessionId, {}, { cwd: central.project, hostId: "local" })).status, 403);
});

test("owner directory listings preserve hidden filtering and existing entry DTOs", async () => {
  const visible = await jsonOK(await fileRequest("~/project", "list", A_ID));
  assert.equal(visible.path, slash(ownerA.project));
  assert.ok(visible.entries.some((entry) => entry.name === "owner-a-only.txt"));
  assert.ok(!visible.entries.some((entry) => entry.name === "central-only.txt" || entry.name === "node_modules" || entry.name === ".git"));
  assert.deepEqual(visible.entries.find((entry) => entry.name === "uploads"), { name: "uploads", isDir: true, size: 0, modified: "" });
  const hidden = await jsonOK(await fileRequest("~/project", "list", A_ID, {}, { hidden: 1 }));
  assert.ok(hidden.entries.some((entry) => entry.name === "node_modules" && entry.isDir));
});

test("owner binary reads preserve metadata, download disposition and exact HTTP ranges", async () => {
  const empty = await fileRequest("~/project/empty.bin", "download", A_ID);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("content-length"), "0");
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  const metadata = await jsonOK(await fileRequest("~/project/document.pdf", "meta", A_ID));
  assert.equal(metadata.mime, "application/pdf");
  assert.equal(metadata.previewKind, "pdf");
  assert.equal(metadata.size, Buffer.byteLength("%PDF-1.7\nowner-a\n"));
  for (const [name, mime, contents] of [["image.png", "image/png", Buffer.from("89504e470d0a1a0a", "hex")], ["audio.wav", "audio/wav", Buffer.from("owner-a audio")], ["document.pdf", "application/pdf", Buffer.from("%PDF-1.7\nowner-a\n")]]) {
    const response = await fileRequest(`~/project/${name}`, "read", A_ID);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mime);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
  }
  const svg = await fileRequest("~/project/image.svg", "read", A_ID);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await svg.text(), /owner-a/);
  for (const [range, status, contentRange, length] of [["bytes=3-9", 206, `bytes 3-9/${binarySize}`, 7], ["bytes=-4", 206, `bytes ${binarySize - 4}-${binarySize - 1}/${binarySize}`, 4], [`bytes=${binarySize}-`, 416, `bytes */${binarySize}`, 0], ["bytes=0-1,3-4", 416, `bytes */${binarySize}`, 0]]) {
    const response = await fileRequest("~/project/binary.bin", "download", A_ID, { headers: { range } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-range"), contentRange);
    assert.match(response.headers.get("content-disposition"), /^attachment;.*binary\.bin/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(length, 0x41));
  }
});

test("DOCX previews convert owner bytes with the existing sandbox and security headers", async () => {
  const response = await fileRequest("~/project/document.docx", "preview", A_ID);
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(await response.text(), /<p>Owner document<\/p>/);
});

test("owner previews preserve text, image and DOCX byte limits before transferring contents", async () => {
  for (const [name, type, code] of [["too-large.txt", "read", "file_too_large_preview"], ["too-large.png", "read", "image_too_large"], ["too-large.docx", "preview", "docx_too_large"]]) {
    const response = await fileRequest(`~/project/${name}`, type, A_ID);
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, code);
  }
});

test("uploads inspect conflicts and mutate only the owner filesystem with error, skip and overwrite semantics", async () => {
  const inspection = await jsonOK(await checkUpload(ownerA, ["existing.txt", "new.bin", "directory"]));
  assert.deepEqual(inspection, { conflicts: ["existing.txt", "directory"], nonReplaceable: ["directory"] });
  const conflict = await upload(ownerA, [["existing.txt", "replacement"]]);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "upload_conflict");
  assert.equal(readFileSync(join(ownerA.project, "uploads", "existing.txt"), "utf8"), "owner-a original");
  const before = wire.length;
  const payload = Buffer.alloc(2 * 1024 * 1024 + 7, 0x7b);
  const skipped = await jsonOK(await upload(ownerA, [["existing.txt", "discarded"], ["new.bin", payload]], "skip"));
  assert.deepEqual(skipped, { uploaded: ["new.bin"], skipped: ["existing.txt"], errors: [] });
  assert.deepEqual(readFileSync(join(ownerA.project, "uploads", "new.bin")), payload);
  assert.ok(wire.slice(before).some((frame) => frame.direction === "down" && frame.bytes > 0), "uploaded bytes use existing binary framing, not JSON/base64");
  assert.ok(wire.slice(before).filter((frame) => frame.direction === "down" && frame.bytes !== undefined).every((frame) => frame.bytes <= 1024 * 1024));
  const overwritten = await jsonOK(await upload(ownerA, [["existing.txt", "owner-a replacement"]], "overwrite"));
  assert.deepEqual(overwritten, { uploaded: ["existing.txt"], skipped: [], errors: [] });
  assert.equal(readFileSync(join(ownerA.project, "uploads", "existing.txt"), "utf8"), "owner-a replacement");
  assert.equal(readFileSync(join(central.project, "uploads", "existing.txt"), "utf8"), "central original");
  assert.equal(existsSync(join(central.project, "uploads", "new.bin")), false);
});

test("worker upload validation refuses paths, unsafe basenames, symlinks and oversized bodies without writes", async () => {
  for (const names of [["../escape.txt"], ["nested\\escape.txt"], ["same.txt", "same.txt"], []]) assert.equal((await checkUpload(ownerA, names)).status, 400);
  assert.equal((await checkUpload(ownerA, ["x.txt"], "uploads")).status, 403);
  assert.equal((await checkUpload(ownerA, ["x.txt"], central.project)).status, 403);
  const tooLarge = await upload(ownerA, [["oversized.bin", Buffer.alloc(25 * 1024 * 1024 + 1)]]);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "upload_file_too_large");
  const totalLimit = await fileRequest(join(ownerA.project, "uploads"), "upload", A_ID, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(102 * 1024 * 1024) }, body: "" });
  assert.equal(totalLimit.status, 413);
  assert.equal((await totalLimit.json()).code, "upload_total_too_large");
  assert.equal(existsSync(join(ownerA.project, "uploads", "oversized.bin")), false);
});

test("worker confinement rejects traversal and symlink escapes even with forged browser roots and host IDs", { skip: process.platform === "win32" && "symlinks require additional Windows privileges" }, async () => {
  symlinkSync(ownerA.artifacts, join(ownerA.project, "escape"), "dir");
  symlinkSync(join(ownerA.agent, "agent.db"), join(ownerA.project, "credentials.txt"));
  symlinkSync(join(ownerA.artifacts, "unreferenced.txt"), join(ownerA.project, "uploads", "link.txt"));
  const extra = { cwd: ownerA.artifacts, hostId: "local" };
  for (const file of ["../artifacts/unreferenced.txt", "~/project/escape/unreferenced.txt", "~/project/credentials.txt"]) assert.equal((await fileRequest(file, "read", A_ID, {}, extra)).status, 403);
  assert.equal((await checkUpload(ownerA, ["write.txt"], join(ownerA.project, "escape"))).status, 403);
  const cannotReplace = await upload(ownerA, [["link.txt", "stolen"], ["directory", "wrong"]], "overwrite");
  assert.equal(cannotReplace.status, 207);
  const result = await cannotReplace.json();
  assert.deepEqual(result.uploaded, []);
  assert.deepEqual(result.errors.map((error) => error.name), ["link.txt", "directory"]);
  assert.equal(readFileSync(join(ownerA.artifacts, "unreferenced.txt"), "utf8"), "owner-a private");
  assert.equal(existsSync(join(ownerA.artifacts, "write.txt")), false);
});

test("owner config instructions remain readable but credentials and SQLite sidecars cannot be read or overwritten", async () => {
  writeFileSync(join(ownerA.agent, "models.yml"), "public committed fixture\n");
  git(ownerA.agent, "init", "-q");
  git(ownerA.agent, "config", "user.name", "owner files fixture");
  git(ownerA.agent, "config", "user.email", "ompweb@example.invalid");
  git(ownerA.agent, "add", "models.yml");
  git(ownerA.agent, "-c", "commit.gpgsign=false", "commit", "-qm", "config fixture");
  writeFileSync(join(ownerA.agent, "models.yml"), "credential-do-not-return");
  const rules = await jsonOK(await fileRequest("~/.omp/agent/AGENTS.md", "read", A_ID));
  assert.equal(rules.content, "owner-a instructions");
  for (const name of ["agent.db", "agent.db-wal", "agent.db-shm", "agent.db-journal", "models.yml"]) {
    assert.equal((await projectRequest(diffRoute, { ...ownerA, project: ownerA.agent }, { path: join(ownerA.agent, name) })).status, 403, `Git diff ${name}`);
    for (const type of ["read", "download", "meta"]) assert.equal((await fileRequest(`~/.omp/agent/${name}`, type, A_ID)).status, 403, `${type} ${name}`);
    const overwrite = await upload(ownerA, [[name, "overwrite-secret"]], "overwrite", ownerA.agent);
    assert.equal(overwrite.status, 403, name);
    assert.equal(readFileSync(join(ownerA.agent, name), "utf8"), "credential-do-not-return");
  }
});

test("external artifacts use only the referencing owner's transcript and never authorize sibling files or directory writes", async () => {
  for (const machine of [ownerA, ownerB]) {
    const read = await jsonOK(await fileRequest("~/artifacts/result.txt", "read", machine.id));
    assert.equal(read.content, `${machine.name} artifact`);
    const download = await fileRequest("~/artifacts/result.txt", "download", machine.id);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), `${machine.name} artifact`);
    assert.equal((await fileRequest("~/artifacts/unreferenced.txt", "read", machine.id)).status, 403);
    assert.equal((await fileRequest(machine.artifacts, "list", machine.id)).status, 403);
    assert.equal((await checkUpload(machine, ["write.txt"], machine.artifacts)).status, 403);
  }
  assert.equal((await fileRequest(join(ownerA.artifacts, "result.txt"), "read", B_ID)).status, 403);
});

test("file index and bounded search run in the owner workspace, not a browser-granted cwd", async () => {
  const listing = await jsonOK(await projectRequest(indexRoute, ownerA));
  assert.ok(listing.files.includes("owner-a-only.txt"));
  assert.ok(!listing.files.includes("central-only.txt") && !listing.files.includes("node_modules/ignored.txt"));
  assert.equal(listing.truncated, false);
  const search = await jsonOK(await projectRequest(indexRoute, ownerA, { q: "needle-owner-a", kind: "file", limit: 1 }));
  assert.deepEqual(search.matches, [{ path: "needle-owner-a-000.ts", isDir: false }]);
  assert.equal(search.truncated, true);
  const bounded = await jsonOK(await projectRequest(indexRoute, ownerA, { q: "needle-owner-a", kind: "file", limit: 999999 }));
  assert.equal(bounded.matches.length, 200);
  assert.equal(bounded.truncated, true);
  assert.equal((await projectRequest(indexRoute, central, { hostId: "local" }, A_ID)).status, 403);
});

test("Git status and diff preserve DTOs and unpublished owner changes without granting browser paths", async () => {
  const status = await jsonOK(await projectRequest(statusRoute, ownerA));
  assert.equal(status.isGitRepository, true);
  assert.equal(status.repositoryRoot, ownerA.project);
  assert.deepEqual(status.files.find((file) => file.filePath === join(ownerA.project, "tracked.txt")), { filePath: join(ownerA.project, "tracked.txt"), status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" });
  const diff = await jsonOK(await projectRequest(diffRoute, ownerA, { path: join(ownerA.project, "tracked.txt") }));
  assert.equal(diff.supported, true);
  assert.match(diff.patch, /\+owner-a dirty/);
  assert.ok(!diff.patch.includes("central dirty"));
  assert.equal((await projectRequest(statusRoute, central, {}, A_ID)).status, 403);
  assert.equal((await projectRequest(diffRoute, ownerA, { path: join(central.project, "tracked.txt") })).status, 403);
});

test("two native owner watches keep the same logical path separate and detach on unsubscribe", async (t) => {
  const { connection, frames } = watchConnection();
  t.after(() => connection.close());
  for (const [sub, id] of [["a", A_ID], ["b", B_ID]]) assert.deepEqual(await connection.subscribe(sub, { kind: "file", path: "shared.txt", sessionId: id }), { ok: true });
  assert.equal(frames.find((frame) => frame.name === "a" && frame.data.type === "connected").data.filePath, slash(join(ownerA.project, "shared.txt")));
  assert.equal(frames.find((frame) => frame.name === "b" && frame.data.type === "connected").data.filePath, slash(join(ownerB.project, "shared.txt")));
  await sleep(100);
  frames.length = 0;
  writeFileSync(join(central.project, "shared.txt"), "central watch decoy");
  await sleep(150);
  assert.ok(!frames.some((frame) => frame.data.type === "change"));
  writeFileSync(join(ownerA.project, "shared.txt"), "owner-a watch changed");
  await until(() => frames.some((frame) => frame.name === "a" && frame.data.type === "change" && frame.data.size === 21), "owner A's native change");
  assert.ok(!frames.some((frame) => frame.name === "b" && frame.data.type === "change"));
  connection.unsubscribe("a");
  await sleep(100);
  frames.length = 0;
  writeFileSync(join(ownerA.project, "shared.txt"), "detached owner A");
  writeFileSync(join(ownerB.project, "shared.txt"), "owner-b watch changed");
  await until(() => frames.some((frame) => frame.name === "b" && frame.data.type === "change" && frame.data.size === 21), "owner B's native change");
  assert.ok(!frames.some((frame) => frame.name === "a"));
});

test("large downloads use bounded binary results instead of whole-file JSON and preserve exact owner bytes", async () => {
  const before = wire.length;
  const response = await fileRequest("~/project/binary.bin", "download", A_ID);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(binarySize));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(binarySize, 0x41));
  const traffic = wire.slice(before).filter((frame) => frame.direction === "up" && frame.hostId === ownerA.hostId);
  const binary = traffic.filter((frame) => frame.bytes !== undefined);
  assert.ok(binary.reduce((total, frame) => total + frame.bytes, 0) >= binarySize, "file bytes must travel in the binary leg");
  const resultSizes = new Map();
  for (const frame of binary) {
    assert.ok(frame.bytes <= LINK_LIMITS.pieceBytes);
    resultSizes.set(frame.id, (resultSizes.get(frame.id) ?? 0) + frame.bytes);
  }
  assert.ok([...resultSizes.values()].every((size) => size <= 1024 * 1024), "one op must not materialize an unbounded download");
  assert.ok(traffic.reduce((total, frame) => total + (frame.textBytes ?? 0), 0) < 64 * 1024, "binary contents must not also ride JSON/base64");
});

test("a lost native link aborts transient multipart staging rather than leaving an active upload behind", async () => {
  const id = randomUUID();
  const attempt = randomUUID();
  const bytes = Buffer.from("partial native workspace body");
  const part = join(ownerB.agent, "omp-web", "uploads", `${id}.part`);
  await hub.hostUploadOp(ownerB.hostId, "uploadStart", { id, attempt, name: "workspace-multipart", type: "application/octet-stream", size: bytes.length * 2, workspaceBody: true });
  assert.equal(hub.sendUploadFrame(ownerB.hostId, id, bytes), true);
  await until(() => existsSync(part) && readFileSync(part).length === bytes.length, "native partial multipart bytes");
  assert.deepEqual(readFileSync(part), bytes);
  hub.closeHostLink(ownerB.hostId);
  await until(() => !existsSync(part), "lost-link multipart staging cleanup");
  await until(() => hub.getHost(ownerB.hostId).status() === "online", "owner B to relink", 20000);
  if (process.platform !== "win32") {
    await until(async () => {
      try { await requestHostControl("drain", ownerB.agent); return true; }
      catch (error) { if (error.code !== "host_busy") throw error; return false; }
    }, "partial multipart busy accounting to release");
    await requestHostControl("resume", ownerB.agent);
  }
});

test("paused downloads apply backpressure and cancellation releases worker maintenance accounting", { skip: process.platform === "win32" && "maintenance control is Unix-only" }, async () => {
  const before = wire.length;
  const response = await fileRequest("~/project/binary.bin", "download", B_ID);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    await sleep(150);
    const sent = wire.slice(before).filter((frame) => frame.direction === "up").reduce((total, frame) => total + (frame.bytes ?? 0), 0);
    assert.ok(sent <= 2 * 1024 * 1024, `a paused browser caused ${sent} bytes of read-ahead`);
    await assert.rejects(requestHostControl("drain", ownerB.agent), (error) => error.code === "host_busy");
  } finally {
    await reader.cancel();
  }
  let drained;
  await until(async () => {
    try { drained = await requestHostControl("drain", ownerB.agent); return true; }
    catch (error) { if (error.code !== "host_busy") throw error; return false; }
  }, "cancelled download resources to release");
  assert.equal(drained.drained, true);
  await requestHostControl("resume", ownerB.agent);
  const afterCancel = wire.length;
  await sleep(150);
  assert.equal(wire.slice(afterCancel).filter((frame) => frame.direction === "up").reduce((total, frame) => total + (frame.bytes ?? 0), 0), 0);
});

test("link loss fails an in-flight owner stream and ends its watch rather than reading central decoys", async (t) => {
  const { connection, frames } = watchConnection();
  t.after(() => connection.close());
  assert.deepEqual(await connection.subscribe("offline-watch", { kind: "file", path: "shared.txt", sessionId: B_ID }), { ok: true });
  const response = await fileRequest("~/project/binary.bin", "download", B_ID);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.every((byte) => byte === 0x42));
  await stopDaemon(ownerB);
  assert.ok(ownerB.process.exitCode !== null || ownerB.process.signalCode !== null, "the native owner process has exited");
  // Reported host status has a liveness grace; actual socket loss refuses ops immediately.
  await until(() => ![...sockets.values()].some((data) => data.hostId === ownerB.hostId), "owner B's native socket to close");
  await assert.rejects(hub.getHost(ownerB.hostId).sessionOps.listSessions(), (error) => error.status === 503 && error.code === "host_offline");
  let received = first.value.byteLength;
  await assert.rejects(async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      assert.ok(next.value.every((byte) => byte === 0x42));
    }
  });
  assert.ok(received < binarySize);
  await until(() => frames.some((frame) => frame.name === "mux" && frame.data.type === "end" && frame.data.sub === "offline-watch"), "offline owner watch to detach");
  assert.equal(connection.subscriptionCount, 0);
});

test("known offline and unknown source identities explicitly refuse every filesystem surface without local fallback", async (t) => {
  for (const [id, expected] of [[B_ID, 503], [UNKNOWN_ID, 404]]) {
    for (const type of ["read", "download", "meta", "list"]) {
      const response = await fileRequest(type === "list" ? "~/project" : "~/project/shared.txt", type, id, {}, { hostId: "local", cwd: central.project });
      assert.equal(response.status, expected, `${id} ${type}`);
    }
    assert.equal((await fileRequest(central.project, "upload-check", id, { method: "POST", body: JSON.stringify({ fileNames: ["no-fallback.txt"] }) })).status, expected);
    assert.equal((await upload({ ...central, id }, [["no-fallback.txt", "must-not-write-central"]])).status, expected);
    for (const route of [indexRoute, statusRoute, diffRoute]) assert.equal((await projectRequest(route, central, { path: join(central.project, "tracked.txt") }, id)).status, expected);
    const { connection } = watchConnection();
    t.after(() => connection.close());
    const watched = await connection.subscribe(id, { kind: "file", path: "shared.txt", sessionId: id });
    assert.equal(watched.ok, false);
    assert.equal(watched.status, expected);
    assert.equal(connection.subscriptionCount, 0);
  }
  assert.equal(existsSync(join(central.project, "no-fallback.txt")), false);
  assert.equal(existsSync(join(central.project, "uploads", "no-fallback.txt")), false);
});
