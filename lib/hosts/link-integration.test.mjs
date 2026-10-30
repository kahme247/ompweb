import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

const linkRoute = await import("../../app/api/hosts/link/route.ts");
const blobRoute = await import("../../app/api/hosts/link/blob/[reqId]/route.ts");
const hub = await import("./hub.ts");
const { createHost } = await import("./registry.ts");
const { LINK_ACK_HEADER, LINK_HELLO_HEADER, LINK_NONCE_HEADER } = await import("./link-protocol.ts");
const { AgentSessionWrapper, getRpcSession, resumeInterruptedSessions, startRpcSession } = await import("../rpc-manager.ts");
const { RESUME_PROMPT } = await import("../session-resume.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");

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
// "slow": the first half at once, the rest one by one once the test creates slowGo(sessionId).
const SLOW_HALF = 20;
const SLOW_FRAMES = 80;
const slowGo = (sessionId) => join(scratch, `go-${sessionId}`);
// Every omp child appends {pid, kind: "start" | "stdin", ...} here.
const ompLogFile = join(scratch, "omp.log");
const ompLog = () => (existsSync(ompLogFile) ? readFileSync(ompLogFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const fakeOmp = join(scratch, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
writeFakeOmp(fakeOmp, `if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
const fs = require("node:fs");
const path = require("node:path");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const log = (entry) => fs.appendFileSync(${JSON.stringify(ompLogFile)}, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
const resumeAt = process.argv.indexOf("--resume");
const resumed = resumeAt === -1 ? null : process.argv[resumeAt + 1];
// As omp does, a new session's file is written only once its first assistant message ends.
const sessionId = resumed ? JSON.parse(fs.readFileSync(resumed, "utf8").split("\\n")[0]).id : require("node:crypto").randomUUID();
const sessionFile = resumed ?? path.join(${JSON.stringify(sessionsDir)}, "-project", sessionId + ".jsonl");
let prompt = null;
let streaming = false;
let text = "";
const update = (next) => {
  text = String(next);
  out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });
};
const end = () => {
  streaming = false;
  if (!fs.existsSync(sessionFile)) {
    const at = new Date().toISOString();
    const lines = [
      { type: "session", version: 3, id: sessionId, cwd: ${JSON.stringify(projectDir)}, timestamp: at },
      { type: "message", id: "m0", parentId: null, timestamp: at, message: { role: "user", content: prompt } },
      { type: "message", id: "m1", parentId: "m0", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } },
    ];
    fs.writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
  }
  out({ type: "agent_end", isTerminal: true, messages: [] });
};
log({ kind: "start", sessionId });
out({ type: "ready", supportedProtocolVersions: [1, 2] });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  log({ kind: "stdin", command });
  const reply = (data) => out({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type === "negotiate_protocol") return reply({ protocolVersion: 2 });
  if (command.type === "get_state") return reply({ sessionId, sessionFile, isStreaming: streaming, isCompacting: false });
  // A dialog answer and a host tool result are frames: omp sends no response to them.
  if (command.type === "extension_ui_response") {
    update("answered " + command.answers[0].selectedOptions[0]);
    return end();
  }
  if (command.type === "host_tool_result") {
    update("tool " + command.result.content[0].text);
    return end();
  }
  if (command.type !== "prompt") return reply({});
  reply({ agentInvoked: true });
  prompt = command.message;
  streaming = true;
  out({ type: "agent_start" });
  if (command.message === "ask") return out({ type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }] });
  if (command.message === "tool") {
    // A host tool call, then one more frame once the test creates the go file.
    out({ type: "host_tool_call", id: "h1", toolCallId: "c1", toolName: "browser_open", arguments: { url: "https://a.test" } });
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(${JSON.stringify(scratch)}, "go-" + sessionId))) return;
      clearInterval(timer);
      update("while stopping");
    }, 25);
    return;
  }
  if (command.message === "late") {
    // An ask and an agent tool call, once the test creates the go file.
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(${JSON.stringify(scratch)}, "go-" + sessionId))) return;
      clearInterval(timer);
      out({ type: "extension_ui_request", id: "q2", method: "ask", questions: [{ id: "q", question: "Late", options: [{ label: "B" }] }] });
      out({ type: "host_tool_call", id: "h2", toolCallId: "c2", toolName: "send_to_session", arguments: { sessionId: ${JSON.stringify("11111111-2222-4333-8444-000000000001")}, message: "hi" } });
    }, 25);
    return;
  }
  if (command.message === "slow") {
    for (let i = 1; i <= ${SLOW_HALF}; i++) update(i);
    let sent = ${SLOW_HALF};
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(${JSON.stringify(scratch)}, "go-" + sessionId))) return;
      update(++sent);
      if (sent === ${SLOW_FRAMES}) {
        clearInterval(timer);
        end();
      }
    }, 25);
    return;
  }
  for (let i = 1; i <= ${FRAMES}; i++) update(i);
  end();
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
const ASK_ID = "11111111-2222-4333-8444-000000000003";
const TOOL_ID = "11111111-2222-4333-8444-000000000004";
const LATE_ID = "11111111-2222-4333-8444-000000000005";
const smallFile = writeSession("2026-01-01_small.jsonl", SMALL_ID, ["hello", "hi"]);
const askFile = writeSession("2026-01-03_ask.jsonl", ASK_ID, ["ask me", "sure"]);
const toolFile = writeSession("2026-01-04_tool.jsonl", TOOL_ID, ["use a tool", "ok"]);
const lateFile = writeSession("2026-01-05_late.jsonl", LATE_ID, ["late", "ok"]);
writeSession("2026-01-02_big.jsonl", BIG_ID, Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(10_000)}`));
assert.ok(statSync(join(sessionsDir, "-project", "2026-01-02_big.jsonl")).size > 2_000_000);

// Faults the adapter injects once each, and what it observed.
const faults = { loseStdin: false, cutUplinkBeforeApply: false, cutUplinkAfterApply: false };
// `kills`: the channel of each `kill` main sent down to the daemon; `refusedPosts`: the bodies of uplink POSTs answered 503.
const seen = { cuts: [], blobUploads: 0, posting: 0, kills: [], refusedPosts: [] };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "POST") {
    seen.posting += 1;
    res.once("close", () => { seen.posting -= 1; });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const name of ["authorization", "content-type", LINK_HELLO_HEADER, LINK_ACK_HEADER, LINK_NONCE_HEADER]) {
    if (typeof req.headers[name] === "string") headers.set(name, req.headers[name]);
  }
  const request = (bytes = body) => new Request(url, { method: req.method, headers, body: req.method === "POST" ? bytes : undefined });
  const blob = /^\/api\/hosts\/link\/blob\/([^/]+)$/.exec(url.pathname);
  // node:http has no idle timeout to lift.
  const context = { disableIdleTimeout() {} };
  let response;
  if (url.pathname === "/api/hosts/link" && req.method === "GET") {
    response = await linkRoute.GET(request(), context);
  } else if (url.pathname === "/api/hosts/link" && req.method === "POST") {
    const carriesFrames = body.includes('"message_update');
    if (faults.cutUplinkBeforeApply && carriesFrames) {
      // The connection breaks mid-batch: the server only got half the body.
      faults.cutUplinkBeforeApply = false;
      seen.cuts.push("uplink-before-apply");
      await linkRoute.POST(request(body.subarray(0, Math.floor(body.length / 2))), context);
      req.socket.destroy();
      return;
    }
    response = await linkRoute.POST(request(), context);
    if (response.status === 503) seen.refusedPosts.push(body.toString());
    if (faults.cutUplinkAfterApply && carriesFrames) {
      // Applied, but the ack never reaches the daemon: it must resend.
      faults.cutUplinkAfterApply = false;
      seen.cuts.push("uplink-after-apply");
      req.socket.destroy();
      return;
    }
  } else if (blob && req.method === "POST") {
    seen.blobUploads += 1;
    response = await blobRoute.POST(request(), { ...context, params: Promise.resolve({ reqId: decodeURIComponent(blob[1]) }) });
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
    for (const [, ch] of Buffer.from(value).toString().matchAll(/"type":"kill","ch":"([^"]+)"/g)) seen.kills.push(ch);
    res.write(value);
  }
  res.end();
});

let hostId;
let daemon;
let daemonLog = "";

/** A restart of the web server as the daemon sees it: the old process runs its shutdown
 * handlers (then `whileStopping`) with the daemon's link still open, then the hub, the
 * sessions and the resume state start over, while the daemon and its omp children run on. */
async function restartWeb({ whileStopping } = {}) {
  // A deploy stops the service: SIGTERM, then connections close as the process exits.
  process.emit("SIGTERM");
  await whileStopping?.();
  // Lets anything the stopping server sent down reach the daemon before the link drops.
  await waitFor(() => seen.posting === 0, "the uplink to settle");
  await sleep(50);
  for (const link of globalThis.__ompHostHub.links.values()) {
    clearInterval(link.pingTimer);
    clearTimeout(link.offlineTimer);
  }
  for (const name of ["__ompHostHub", "__ompHostLists", "__ompSessions", "__ompStartLocks", "__ompExitedSessions", "__ompResumeTracker"]) globalThis[name] = undefined;
  // The daemon's downlink drops with the old process: it redials the new one.
  server.closeAllConnections();
}

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

  const login = spawnSync("node", [hostBin, "login", "--url", url], { env, input: `${token}\n`, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);
  const saved = join(daemonAgentDir, "omp-web", "host.json");
  if (process.platform !== "win32") assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(saved, "utf8")), { url, token });
  assert.ok(!login.stdout.includes(token) && !login.stderr.includes(token));

  daemon = spawn("node", [hostBin], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.on("data", (chunk) => { daemonLog += chunk; });
  daemon.stderr.on("data", (chunk) => { daemonLog += chunk; });
  await waitFor(() => hub.getHost(hostId).status() === "online", "the daemon to link");
});

after(async () => {
  // This run's wrappers only: those of a server restartWeb replaced died with it.
  for (const session of new Set(globalThis.__ompSessions?.values() ?? [])) await session.destroyAndWait();
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

/** The new session the streaming test starts; it stays live, idle, on the daemon. */
let countSessionId;

test("a remote session streams a reply with no frame lost or duplicated across link breaks", async () => {
  const remote = hub.getHost(hostId);
  const { session, realSessionId } = await startRpcSession("", "", projectDir, undefined, false, null, undefined, remote);
  countSessionId = realSessionId;
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

test("a restarted web server adopts its running omp children, resumed or new: each pid streams on with no gap or duplicate, no kill reaches the daemon, nothing resumes them", async (t) => {
  saveWebServerSettings({ autoResumeSessions: true });
  const adopt = AgentSessionWrapper.prototype.adopt;
  t.after(() => {
    AgentSessionWrapper.prototype.adopt = adopt;
    saveWebServerSettings({ autoResumeSessions: false });
  });
  const remote = hub.getHost(hostId);
  // A resumed session, and a new one (no --resume) in its first reply: it names itself only in
  // its get_state, and no session list has it until that reply ends and omp writes its file.
  const runs = [
    await startRpcSession(SMALL_ID, smallFile, projectDir, undefined, false, projectDir, undefined, remote),
    await startRpcSession("", "", projectDir, undefined, false, null, undefined, remote),
  ].map(({ session, realSessionId }) => ({ session, id: realSessionId, texts: [] }));
  for (const run of runs) {
    run.session.onEvent((event) => {
      if (event.type === "message_update") run.texts.push(Number(event.message.content[0].text));
    });
    await run.session.send({ type: "prompt", message: "slow" });
  }
  await waitFor(() => runs.every((run) => run.texts.length === SLOW_HALF), "the first half of each run");
  const interrupted = join(mainAgentDir, `omp-web-interrupted-sessions-${process.pid}.json`);
  await waitFor(() => existsSync(interrupted) && runs.every((run) => readFileSync(interrupted, "utf8").includes(run.id)), "the runs to be recorded for resume");
  const newSessionFile = join(sessionsDir, "-project", `${runs[1].id}.jsonl`);
  assert.equal(existsSync(newSessionFile), false, "the new session has no file yet");
  // Live on the daemon too: the earlier test's idle new session.
  const ids = [...runs.map((run) => run.id), countSessionId];
  const killsBefore = seen.kills.length;

  // Watch each next wrapper from its first frame: frames held across the restart are applied during adopt().
  const adopted = new Map();
  AgentSessionWrapper.prototype.adopt = function (replay) {
    const events = [];
    this.onEvent((event) => events.push(event), { internal: true });
    adopted.set(this, events);
    return adopt.call(this, replay);
  };
  await restartWeb();
  // As instrumentation does when the new server starts.
  await resumeInterruptedSessions();
  for (const run of runs) writeFileSync(slowGo(run.id), "");
  await waitFor(() => ids.every((id) => getRpcSession(id)), "the adoptions");
  for (const run of runs) {
    const events = adopted.get(getRpcSession(run.id));
    await waitFor(() => events.some((event) => event.type === "agent_end"), "the run to end");
    for (const event of events) if (event.type === "message_update") run.texts.push(Number(event.message.content[0].text));
    assert.deepEqual(run.texts, Array.from({ length: SLOW_FRAMES }, (_, i) => i + 1), run.id);
  }
  assert.deepEqual(seen.kills.slice(killsBefore), [], "no kill reached the daemon");
  // The first reply completed in the adopted child, which then wrote the session.
  assert.equal(JSON.parse(readFileSync(newSessionFile, "utf8").split("\n")[0]).id, runs[1].id);

  const log = ompLog();
  for (const id of ids) {
    const starts = log.filter((entry) => entry.kind === "start" && entry.sessionId === id);
    assert.equal(starts.length, 1, `no second child was spawned for ${id}`);
    const handshakes = log.filter((entry) => entry.pid === starts[0].pid && entry.command?.type === "negotiate_protocol");
    assert.equal(handshakes.length, 2, `the new server re-synced the same child of ${id}`);
  }
  assert.equal(log.some((entry) => entry.command?.message === RESUME_PROMPT), false, "no resume prompt");
});

test("a run waiting on an ask shows the dialog again after a web restart, and the answer reaches the same omp child", async () => {
  const { session } = await startRpcSession(ASK_ID, askFile, projectDir, undefined, false, projectDir, undefined, hub.getHost(hostId));
  let asked = false;
  session.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.id === "q1") asked = true;
  });
  await session.send({ type: "prompt", message: "ask" });
  await waitFor(() => asked, "the ask");

  const killsBefore = seen.kills.length;
  await restartWeb();
  await waitFor(() => getRpcSession(ASK_ID), "the adoption");
  // A tab opening the session after the restart.
  const events = [];
  const adopted = getRpcSession(ASK_ID);
  adopted.onEvent((event) => events.push(event));
  assert.equal(events.find((event) => event.type === "extension_ui_request" && event.id === "q1")?.method, "ask");
  await adopted.send({ type: "extension_ui_response", id: "q1", answers: [{ id: "q", selectedOptions: ["A"] }] });
  await waitFor(() => events.some((event) => event.type === "agent_end"), "the answered run to end");
  assert.ok(events.some((event) => event.type === "message_update" && event.message.content[0].text === "answered A"));

  const log = ompLog();
  const starts = log.filter((entry) => entry.kind === "start" && entry.sessionId === ASK_ID);
  assert.equal(starts.length, 1, "no second child was spawned");
  assert.ok(log.some((entry) => entry.pid === starts[0].pid && entry.command?.type === "extension_ui_response" && entry.command.id === "q1"));
  assert.deepEqual(seen.kills.slice(killsBefore).filter((ch) => ch === getRpcSession(ASK_ID).proc.transport.ch), [], "no kill reached the asking child");
});

test("a stopping web server sends nothing more and takes nothing in: a closing tab rejects no host tool call, and output waits for the next server", async (t) => {
  const adopt = AgentSessionWrapper.prototype.adopt;
  t.after(() => {
    AgentSessionWrapper.prototype.adopt = adopt;
  });
  const { session } = await startRpcSession(TOOL_ID, toolFile, projectDir, undefined, false, projectDir, undefined, hub.getHost(hostId));
  await session.send({ type: "set_host_tools", tools: [{ name: "browser_open", description: "Open a page", parameters: { type: "object" } }] });
  const before = [];
  const leave = session.onEvent((event) => before.push(event));
  await session.send({ type: "prompt", message: "tool" });
  await waitFor(() => before.some((event) => event.type === "host_tool_call" && event.id === "h1"), "the host tool call");

  const adopted = new Map();
  AgentSessionWrapper.prototype.adopt = function (replay) {
    const events = [];
    this.onEvent((event) => events.push(event), { internal: true });
    adopted.set(this, events);
    return adopt.call(this, replay);
  };
  const refusedBefore = seen.refusedPosts.length;
  await restartWeb({
    async whileStopping() {
      // The tab's connection closes with the server: a live server answers its open call with an error.
      leave();
      // omp sends more output while the server stops.
      writeFileSync(slowGo(TOOL_ID), "");
      await waitFor(() => seen.refusedPosts.length > refusedBefore, "an uplink POST refused while stopping");
    },
  });
  assert.equal(ompLog().some((entry) => entry.command?.type === "host_tool_result"), false, "no rejection reached omp");
  assert.equal(before.some((event) => event.type === "message_update"), false, "the stopping server applied none of it");

  await waitFor(() => getRpcSession(TOOL_ID), "the adoption");
  const next = getRpcSession(TOOL_ID);
  const events = adopted.get(next);
  const stopping = () => events.filter((event) => event.type === "message_update" && event.message.content[0].text === "while stopping");
  await waitFor(() => stopping().length > 0, "the refused output to reach the next server");
  // A tab of the next server gets the still-open call and answers it.
  const tab = [];
  next.onEvent((event) => tab.push(event));
  assert.ok(tab.some((event) => event.type === "host_tool_call" && event.id === "h1"));
  await next.send({ type: "host_tool_result", id: "h1", result: { content: [{ type: "text", text: "opened" }] } });
  await waitFor(() => tab.some((event) => event.type === "agent_end"), "the run to end");
  assert.ok(tab.some((event) => event.type === "message_update" && event.message.content[0].text === "tool opened"));
  assert.equal(stopping().length, 1, "delivered once");
  assert.deepEqual(ompLog().filter((entry) => entry.command?.type === "host_tool_result").map((entry) => entry.command.result.content[0].text), ["opened"]);
});

test("a request omp opens while the web server stops reaches the next server once: one dialog, one agent tool result", async (t) => {
  const adopt = AgentSessionWrapper.prototype.adopt;
  t.after(() => {
    AgentSessionWrapper.prototype.adopt = adopt;
  });
  const { session } = await startRpcSession(LATE_ID, lateFile, projectDir, undefined, false, projectDir, undefined, hub.getHost(hostId));
  let started = false;
  session.onEvent((event) => {
    if (event.type === "agent_start") started = true;
  });
  await session.send({ type: "prompt", message: "late" });
  await waitFor(() => started, "the run");

  const adopted = new Map();
  AgentSessionWrapper.prototype.adopt = function (replay) {
    const events = [];
    this.onEvent((event) => events.push(event), { internal: true });
    adopted.set(this, events);
    return adopt.call(this, replay);
  };
  const refusedBefore = seen.refusedPosts.length;
  await restartWeb({
    async whileStopping() {
      writeFileSync(slowGo(LATE_ID), "");
      // The stopping server acks neither line: the daemon lists both in its hello and resends both.
      const refused = () => seen.refusedPosts.slice(refusedBefore).join("");
      await waitFor(() => refused().includes("q2") && refused().includes("send_to_session"), "both requests refused while stopping");
    },
  });

  await waitFor(() => getRpcSession(LATE_ID), "the adoption");
  const events = adopted.get(getRpcSession(LATE_ID));
  const results = () => ompLog().filter((entry) => entry.command?.type === "host_tool_result" && entry.command.id === "h2");
  await waitFor(() => results().length > 0, "the agent tool result");
  // Room for a second delivery to show up.
  await sleep(300);
  assert.equal(events.filter((event) => event.type === "extension_ui_request" && event.id === "q2").length, 1, "one dialog");
  assert.equal(results().length, 1, "one agent tool result");
});
