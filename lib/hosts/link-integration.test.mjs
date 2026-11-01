import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// A real `ompweb host` process with its own HOME (a second "machine") linked
// over loopback HTTP to the link routes, served here through node:http.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const hostBin = join(repoRoot, "bin", "omp-web-host.js");
const scratch = mkdtempSync(join(tmpdir(), "omp-web-link-it-"));
const mainAgentDir = join(scratch, "main-agent");
const daemonHome = join(scratch, "laptop");
const daemonAgentDir = join(daemonHome, ".omp", "agent");
const sessionsDir = join(daemonAgentDir, "sessions");
const projectDir = join(daemonHome, "project");
mkdirSync(join(sessionsDir, "-project"), { recursive: true });
mkdirSync(projectDir, { recursive: true });

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = mainAgentDir;

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": repoRoot } });
const linkRoute = await jiti.import("../../app/api/hosts/link/route.ts");
const blobRoute = await jiti.import("../../app/api/hosts/link/blob/[reqId]/route.ts");
const hub = await jiti.import("./hub.ts");
const { createHost } = await jiti.import("./registry.ts");
const { LINK_ACK_HEADER, LINK_HELLO_HEADER, LINK_NONCE_HEADER } = await jiti.import("./link-protocol.ts");
const { startRpcSession } = await jiti.import("../rpc-manager.ts");

// Windows cannot spawn a shebang script: run it through a .cmd launcher (which wrapWindowsScript routes via cmd.exe).
function writeFakeOmp(file, source) {
  if (process.platform !== "win32") {
    writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    return;
  }
  writeFileSync(`${file}.cjs`, source);
  writeFileSync(file, `@"${process.execPath.replaceAll("%", "%%")}" "${file.replaceAll("%", "%%")}.cjs" %*\r\n`);
}

const FRAMES = 200;
const fakeOmp = join(scratch, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
writeFakeOmp(fakeOmp, `if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
const path = require("node:path");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const sessionFile = path.join(${JSON.stringify(sessionsDir)}, "-project", "fake-live.jsonl");
out({ type: "ready" });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  const reply = (data) => out({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type === "get_state") return reply({ sessionId: "remote-live", sessionFile, isStreaming: false, isCompacting: false });
  if (command.type !== "prompt") return reply({});
  reply({ agentInvoked: true });
  out({ type: "agent_start" });
  for (let i = 1; i <= ${FRAMES}; i++) out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: String(i) }] } });
  out({ type: "agent_end", isTerminal: true, messages: [] });
});
process.stdin.on("end", () => process.exit(0));
`);

function writeSession(name, id, messages) {
  const lines = [{ type: "session", version: 3, id, cwd: projectDir, timestamp: "2026-01-01T00:00:00.000Z" }];
  let parentId = null;
  messages.forEach((content, i) => {
    const entryId = `${id}-m${i}`;
    lines.push({ type: "message", id: entryId, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: content }] : content } });
    parentId = entryId;
  });
  const file = join(sessionsDir, "-project", name);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}
// Session ids are UUIDs; main drops list entries with any other id.
const SMALL_ID = "11111111-2222-4333-8444-000000000001";
const BIG_ID = "11111111-2222-4333-8444-000000000002";
const smallFile = writeSession("2026-01-01_small.jsonl", SMALL_ID, ["hello", "hi"]);
writeSession("2026-01-02_big.jsonl", BIG_ID, Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(10_000)}`));
assert.ok(statSync(join(sessionsDir, "-project", "2026-01-02_big.jsonl")).size > 2_000_000);

// Faults the adapter injects once each, and what it observed.
const faults = { loseStdin: false, cutUplinkBeforeApply: false, cutUplinkAfterApply: false };
const seen = { cuts: [], blobUploads: 0 };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const name of ["authorization", "content-type", LINK_HELLO_HEADER, LINK_ACK_HEADER, LINK_NONCE_HEADER]) {
    if (typeof req.headers[name] === "string") headers.set(name, req.headers[name]);
  }
  const request = (bytes = body) => new Request(url, { method: req.method, headers, body: req.method === "POST" ? bytes : undefined });
  const blob = /^\/api\/hosts\/link\/blob\/([^/]+)$/.exec(url.pathname);
  let response;
  if (url.pathname === "/api/hosts/link" && req.method === "GET") {
    response = await linkRoute.GET(request());
  } else if (url.pathname === "/api/hosts/link" && req.method === "POST") {
    const carriesFrames = body.includes('"message_update');
    if (faults.cutUplinkBeforeApply && carriesFrames) {
      // The connection breaks mid-batch: the server only got half the body.
      faults.cutUplinkBeforeApply = false;
      seen.cuts.push("uplink-before-apply");
      await linkRoute.POST(request(body.subarray(0, Math.floor(body.length / 2))));
      req.socket.destroy();
      return;
    }
    response = await linkRoute.POST(request());
    if (faults.cutUplinkAfterApply && carriesFrames) {
      // Applied, but the ack never reaches the daemon: it must resend.
      faults.cutUplinkAfterApply = false;
      seen.cuts.push("uplink-after-apply");
      req.socket.destroy();
      return;
    }
  } else if (blob && req.method === "POST") {
    seen.blobUploads += 1;
    response = await blobRoute.POST(request(), { params: Promise.resolve({ reqId: decodeURIComponent(blob[1]) }) });
  } else {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  // The daemon hung up: stop main's stream, as Next does.
  res.once("close", () => void reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    if (faults.loseStdin && Buffer.from(value).includes('"type":"stdin"')) {
      // The downlink drops with this stdin line still in flight.
      faults.loseStdin = false;
      seen.cuts.push("downlink");
      void reader.cancel().catch(() => {});
      req.socket.destroy();
      return;
    }
    res.write(value);
  }
  res.end();
});

let hostId;
let daemon;
let daemonLog = "";
const sessions = [];

function waitFor(predicate, what, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}\n${daemonLog}`));
      }
    }, 20);
  });
}

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { host, token } = createHost("Laptop");
  hostId = host.id;
  const env = { ...process.env, HOME: daemonHome, USERPROFILE: daemonHome, PI_CODING_AGENT_DIR: daemonAgentDir, OMP_WEB_OMP_BIN: fakeOmp };

  const login = spawnSync(process.execPath, [hostBin, "login", "--url", url], { env, input: `${token}\n`, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);
  const saved = join(daemonAgentDir, "omp-web", "host.json");
  if (process.platform !== "win32") assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(saved, "utf8")), { url, token });
  assert.ok(!login.stdout.includes(token) && !login.stderr.includes(token));

  daemon = spawn(process.execPath, [hostBin], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.on("data", (chunk) => { daemonLog += chunk; });
  daemon.stderr.on("data", (chunk) => { daemonLog += chunk; });
  await waitFor(() => hub.getHost(hostId).status() === "online", "the daemon to link");
});

after(async () => {
  for (const session of sessions) await session.destroyAndWait();
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await exited;
  }
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  globalThis.__ompNotificationStore?.db.close();
  globalThis.__ompNotificationStore = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});

test("the linked host reports itself and lists its sessions", async () => {
  const listed = hub.listHosts().find((h) => h.id === hostId);
  assert.equal(listed.status, "online");
  assert.equal(listed.ompVersion, "14.0.0-fake");
  assert.equal(listed.platform, process.platform);
  const ids = (await hub.getHost(hostId).sessionOps.listSessions()).map((s) => s.id);
  assert.ok(ids.includes(SMALL_ID) && ids.includes(BIG_ID), ids.join(","));
});

test("a 2 MB session read arrives through the blob leg", async () => {
  const before = seen.blobUploads;
  const result = await hub.getHost(hostId).sessionOps.readSession(BIG_ID, { deferThinking: true, deferMedia: true });
  assert.equal(result.ok, true);
  assert.equal(result.value.info.id, BIG_ID);
  assert.equal(result.value.context.messages.length, 200);
  assert.equal(seen.blobUploads, before + 1);
});

test("the host refuses session paths outside its sessions directory", async () => {
  const remote = hub.getHost(hostId);
  assert.equal(await remote.sessionFileExists(smallFile), true);
  assert.equal(await remote.sessionFileExists(join(sessionsDir, "-project", "not-yet.jsonl")), false);
  const outside = join(scratch, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.jsonl"), "{}\n");
  symlinkSync(outside, join(sessionsDir, "escape"));
  // `${sessionsDir}-evil` shares the sessions directory's name as a prefix.
  mkdirSync(`${sessionsDir}-evil`);
  writeFileSync(join(`${sessionsDir}-evil`, "x.jsonl"), "{}\n");
  for (const path of ["/etc/passwd", join(sessionsDir, "..", "omp-web", "host.json"), join(sessionsDir, "escape", "secret.jsonl"), join(`${sessionsDir}-evil`, "x.jsonl"), "relative.jsonl"]) {
    await assert.rejects(remote.sessionFileExists(path), (error) => error.status === 403, path);
  }
  await assert.rejects(
    remote.spawnRpc({ cwd: projectDir, recordedCwd: projectDir, sessionFile: join(sessionsDir, "escape", "secret.jsonl"), advisor: false }),
    (error) => error.status === 403,
  );
});

test("a remote session streams a reply with no frame lost or duplicated across link breaks", async () => {
  const remote = hub.getHost(hostId);
  const { session } = await startRpcSession("", "", projectDir, undefined, false, null, undefined, remote);
  sessions.push(session);
  assert.equal(session.host, remote);
  const texts = [];
  let ended = false;
  session.onEvent((event) => {
    if (event.type === "message_update") texts.push(Number(event.message.content[0].text));
    if (event.type === "agent_end") ended = true;
  });
  faults.loseStdin = true;
  faults.cutUplinkBeforeApply = true;
  faults.cutUplinkAfterApply = true;
  await session.send({ type: "prompt", message: "count" });
  await waitFor(() => ended, "agent_end");
  assert.deepEqual(seen.cuts, ["downlink", "uplink-before-apply", "uplink-after-apply"]);
  assert.deepEqual(texts, Array.from({ length: FRAMES }, (_, i) => i + 1));
});
