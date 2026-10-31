import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// A real `ompweb host` process with its own HOME (a second "machine") linked
// over a loopback WebSocket to the link route and the hub's socket handler, served here through Bun.serve.
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
const hub = await import("./hub.ts");
const { createHost, revokeHost } = await import("./registry.ts");
const { AgentSessionWrapper, getRpcSession, resumeInterruptedSessions, startRpcSession } = await import("../rpc-manager.ts");
const { RESUME_PROMPT } = await import("../session-resume.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
const { closeNotificationStore } = await import("../notification-store.ts");

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
// Every omp child appends {pid, kind: "start" | "stdin" | "out" | "pad", ...} here.
const ompLogFile = join(scratch, "omp.log");
const ompLog = () => (existsSync(ompLogFile) ? readFileSync(ompLogFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
/** Whether omp children have written stdout lines containing each of `parts`. */
const ompSaid = (...parts) => {
  const lines = ompLog().filter((entry) => entry.kind === "out").map((entry) => entry.line);
  return parts.every((part) => lines.some((line) => line.includes(part)));
};
const fakeOmp = join(scratch, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
writeFakeOmp(fakeOmp, `if (process.argv.includes("--version")) { console.log("14.0.0-fake"); process.exit(0); }
const fs = require("node:fs");
const path = require("node:path");
const log = (entry) => fs.appendFileSync(${JSON.stringify(ompLogFile)}, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
const out = (frame) => {
  const line = JSON.stringify(frame);
  log({ kind: "out", line });
  process.stdout.write(line + "\\n");
};
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
  // Bulk stdin (the backpressure test): logged without its padding.
  if (command.type === "pad") return log({ kind: "pad", n: command.n });
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

// Faults the bridge injects once each, and what it observed.
const faults = { loseStdin: false, cutUplinkBeforeApply: false, cutUplinkAfterApply: false };
// `kills`: the channel of each `kill` main sent down to the daemon; `refusedUpgrades`: link GETs answered 503.
const seen = { cuts: [], binaryFrames: 0, kills: [], refusedUpgrades: 0 };

// The open link sockets, and the one stand-in the hub sees for each (it keys its state on socket identity).
const sockets = new Set();
const wrappers = new WeakMap();
/** An open socket whose hello the hub took (Bun runs `close` within terminate(), so a cut socket is already gone). */
const linked = () => [...sockets].some((ws) => ws.data.hello);
// On while the hub applies a frame whose answer must be lost.
let dropSends = false;

function wrap(ws) {
  let wrapper = wrappers.get(ws);
  if (wrapper) return wrapper;
  wrapper = {
    data: ws.data,
    send(frame) {
      if (dropSends) return 0;
      if (typeof frame === "string") {
        if (faults.loseStdin && frame.includes('"type":"stdin"')) {
          // The downlink drops with this stdin line still in flight.
          faults.loseStdin = false;
          seen.cuts.push("downlink");
          ws.terminate();
          return 0;
        }
        for (const [, ch] of frame.matchAll(/"type":"kill","ch":"([^"]+)"/g)) seen.kills.push(ch);
      }
      return ws.send(frame);
    },
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
  wrappers.set(ws, wrapper);
  return wrapper;
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/api/hosts/link": {
      GET(req) {
        const response = linkRoute.GET(req, { upgrade: (data) => server.upgrade(req, { data }) });
        if (response?.status === 503) seen.refusedUpgrades += 1;
        return response;
      },
      POST: (req) => linkRoute.POST(req),
    },
  },
  websocket: {
    ...hub.hostLinkSocket,
    open(ws) {
      sockets.add(ws);
    },
    message(ws, data) {
      const carriesFrames = typeof data === "string" && data.includes('"message_update');
      if (faults.cutUplinkBeforeApply && carriesFrames) {
        // The connection breaks before this frame arrives.
        faults.cutUplinkBeforeApply = false;
        seen.cuts.push("uplink-before-apply");
        ws.terminate();
        return;
      }
      if (typeof data !== "string") seen.binaryFrames += 1;
      if (faults.cutUplinkAfterApply && carriesFrames) {
        // Applied, but the ack never reaches the daemon: it must resend.
        faults.cutUplinkAfterApply = false;
        seen.cuts.push("uplink-after-apply");
        // The hub's handlers never throw: it contains a throw by closing that socket.
        dropSends = true;
        hub.hostLinkSocket.message(wrap(ws), data);
        dropSends = false;
        ws.terminate();
        return;
      }
      hub.hostLinkSocket.message(wrap(ws), data);
    },
    close(ws) {
      sockets.delete(ws);
      hub.hostLinkSocket.close(wrap(ws));
    },
  },
});

let hostId;
let daemon;
let daemonLog = "";

/** A restart of the web server as the daemon sees it: the old process runs its shutdown
 * handlers (then `whileStopping`), which close the daemon's link with 1001, then the hub, the
 * sessions and the resume state start over, while the daemon and its omp children run on. */
async function restartWeb({ whileStopping } = {}) {
  // A deploy stops the service: SIGTERM freezes the hub, which closes every link socket.
  process.emit("SIGTERM");
  await whileStopping?.();
  // The frozen hub answers upgrades 503, so no socket opens until the globals reset.
  await waitFor(() => sockets.size === 0, "the frozen hub to close the link");
  for (const link of globalThis.__ompHostHub.links.values()) {
    clearInterval(link.pingTimer);
    clearTimeout(link.offlineTimer);
  }
  for (const name of ["__ompHostHub", "__ompHostLists", "__ompSessions", "__ompStartLocks", "__ompExitedSessions", "__ompResumeTracker"]) globalThis[name] = undefined;
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
  const url = `http://127.0.0.1:${server.port}`;
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
  // This run's wrappers only: those of a server restartWeb replaced died with it. In parallel: on Windows
  // the soft kill does not end the remote child, so each waits for the force kill 10 s after dispose starts.
  await Promise.all([...new Set(globalThis.__ompSessions?.values() ?? [])].map((session) => session.destroyAndWait()));
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await exited;
  }
  await server.stop(true);
  closeNotificationStore();
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

test("a 2 MB session read arrives in one binary frame", async () => {
  const before = seen.binaryFrames;
  const result = await hub.getHost(hostId).sessionOps.readSession(BIG_ID, { deferThinking: true, deferMedia: true });
  assert.equal(result.ok, true);
  assert.equal(result.value.info.id, BIG_ID);
  assert.equal(result.value.context.messages.length, 200);
  assert.equal(seen.binaryFrames, before + 1);
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
  // The last cut can end the socket that brought agent_end; until the daemon redials, ops fail host_offline.
  await waitFor(linked, "the daemon to relink");
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
  const refusedBefore = seen.refusedUpgrades;
  await restartWeb({
    async whileStopping() {
      // The tab's connection closes with the server: a live server answers its open call with an error.
      leave();
      // omp sends more output while the server stops.
      writeFileSync(slowGo(TOOL_ID), "");
      await waitFor(() => ompSaid("while stopping") && seen.refusedUpgrades > refusedBefore, "output while stopping, and a redial refused");
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
  const refusedBefore = seen.refusedUpgrades;
  await restartWeb({
    async whileStopping() {
      writeFileSync(slowGo(LATE_ID), "");
      // The stopping server takes neither line in: the daemon keeps both for the next server.
      await waitFor(() => ompSaid("q2", "send_to_session") && seen.refusedUpgrades > refusedBefore, "both requests sent while stopping, and a redial refused");
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

test("a daemon that stops reading is closed at the hub's backpressure limit; after its redial each line it missed reaches omp once", { skip: process.platform === "win32" && "SIGSTOP is POSIX-only" }, async () => {
  const { session } = await startRpcSession("", "", projectDir, undefined, false, null, undefined, hub.getHost(hostId));
  // 48 MiB of stdin: past the 16 MiB backpressure limit plus what loopback's kernel buffers hold.
  const count = 8;
  const pad = "x".repeat(6 * 1024 * 1024);
  daemon.kill("SIGSTOP");
  try {
    for (let n = 1; n <= count; n++) session.proc.transport.write(`${JSON.stringify({ type: "pad", n, pad })}\n`, assert.ifError);
    // Well inside the hub's 30 s offline timer: only the backpressure limit closes the socket this soon.
    await waitFor(() => !linked(), "the hub to close the socket at its backpressure limit", 10_000);
  } finally {
    daemon.kill("SIGCONT");
  }
  const pads = () => ompLog().filter((entry) => entry.kind === "pad").map((entry) => entry.n);
  await waitFor(() => pads().length >= count, "every line to reach omp");
  // Room for a second delivery to show up.
  await sleep(300);
  assert.deepEqual(pads(), Array.from({ length: count }, (_, i) => i + 1));
});

test("revoking the host closes its socket; the daemon is refused 401, stops its omp children and exits 1", async () => {
  const children = [...new Set(ompLog().filter((entry) => entry.kind === "start").map((entry) => entry.pid))];
  assert.equal(revokeHost(hostId), true);
  hub.closeHostLink(hostId);
  await waitFor(() => daemon.exitCode !== null, "the daemon to exit");
  assert.equal(daemon.exitCode, 1, daemonLog);
  assert.match(daemonLog, /revoked/);
  for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `omp child ${pid} still runs`);
});
