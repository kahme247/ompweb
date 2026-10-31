import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST /api/agent/[id] handler against a real saved-session file. The omp
// binary is a launcher stub that records every launch and exits at once, so a
// launch record is the observable proof that a child process was created.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const agentRoute = await jiti.import("../app/api/agent/[id]/route.ts");

const SAVED_ID = "saved-skill-session";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-skill-diagnostics-route-"));
const projectDir = join(agentDir, "sessions", "-project");
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(projectDir, "2026-01-01_saved.jsonl"),
  `${[
    { type: "session", version: 3, id: SAVED_ID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`,
);

const launchLog = join(agentDir, "omp-launches.log");
const fakeOmp = join(agentDir, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
writeFileSync(
  fakeOmp,
  process.platform === "win32"
    ? `@echo off\r\necho launched>> "${launchLog}"\r\nexit /b 1\r\n`
    : `#!/bin/sh\necho launched >> '${launchLog}'\nexit 1\n`,
  { mode: 0o755 },
);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousBin = process.env.OMP_WEB_OMP_BIN;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_WEB_OMP_BIN = fakeOmp;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
  else process.env.OMP_WEB_OMP_BIN = previousBin;
  rmSync(agentDir, { recursive: true, force: true });
});

const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split(/\r?\n/).filter(Boolean).length : 0);

const post = (id, body, query = "") => agentRoute.POST(
  new Request(`http://localhost/api/agent/${id}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) },
);

/** Replace the process-wide wrapper registry and clear the launch record for one test. */
function useRegistry(t, wrappers = {}) {
  rmSync(launchLog, { force: true });
  const previousSessions = globalThis.__ompSessions;
  const previousLocks = globalThis.__ompStartLocks;
  globalThis.__ompSessions = new Map(Object.entries(wrappers));
  globalThis.__ompStartLocks = new Map();
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompStartLocks = previousLocks;
  });
}

const reply = { cwd: "/workspace", showStartupDiagnostics: false, diagnostics: [] };

function wrapper({ alive = true, running = false, advisorSpawned = false } = {}) {
  const self = {
    advisorSpawned,
    sent: [],
    destroyed: 0,
    isAlive: () => alive,
    isRunning: () => running,
    // The 503 branch of the agent route reads the frame clock; a stand-in
    // session with no run has nothing to report.
    silentForMs: () => null,
    async send(command) {
      self.sent.push(command);
      return reply;
    },
    async destroyAndWait() {
      self.destroyed += 1;
    },
  };
  return self;
}

const COMMANDS = [
  { type: "get_skill_diagnostics" },
  { type: "set_skill_startup_diagnostics", enabled: false },
];

for (const command of COMMANDS) {
  test(`${command.type} for a saved session with no live wrapper is unavailable and never starts omp`, async (t) => {
    useRegistry(t);

    const response = await post(SAVED_ID, command);
    const text = await response.text();

    assert.equal(response.status, 409, text);
    const body = JSON.parse(text);
    assert.equal(body.code, "skill_diagnostics_unavailable");
    assert.match(body.error, /skill diagnostics/i);
    assert.equal(launches(), 0, "no omp child was created");
    assert.equal(globalThis.__ompSessions.size, 0, "no wrapper was registered");
  });

  test(`${command.type} does not resume a session whose wrapper has exited`, async (t) => {
    const exited = wrapper({ alive: false });
    useRegistry(t, { [SAVED_ID]: exited });

    const response = await post(SAVED_ID, command);
    const text = await response.text();

    assert.equal(response.status, 409, text);
    assert.equal(JSON.parse(text).code, "skill_diagnostics_unavailable");
    assert.equal(launches(), 0, "no replacement omp child was created");
    assert.deepEqual(exited.sent, [], "the exited wrapper received nothing");
  });

  test(`${command.type} is answered by an active wrapper without replacing it when the advisor query differs`, async (t) => {
    const live = wrapper({ advisorSpawned: false });
    useRegistry(t, { [SAVED_ID]: live });

    const response = await post(SAVED_ID, command, "?advisor=1");
    const text = await response.text();

    assert.equal(response.status, 200, text);
    assert.equal(live.destroyed, 0, "an idle live child is never restarted to read or flip a setting");
    assert.equal(launches(), 0);
  });
}

test("an ordinary command for the same saved session still starts omp", async (t) => {
  // Control: proves the launch record observes a real start, so the zero-launch
  // assertions above cannot pass vacuously.
  useRegistry(t);

  const response = await post(SAVED_ID, { type: "get_state" });
  const text = await response.text();

  assert.equal(launches(), 1, `a session-owning command resumes omp (response ${response.status}: ${text})`);
  assert.notEqual(response.status, 409);
});

test("GET answers 503 session_slow when omp does not answer the state poll in time", async (t) => {
  // A busy child is not a dead one: the poll must tell clients to retry, never
  // `{running:false}` (which ends the run in their UI).
  // The routes import through the `@/` alias, which jiti instantiates separately
  // from a relative path; the exact class identity is what the route checks.
  const { WebRpcError } = await jiti.import("@/lib/rpc-manager");
  const slow = wrapper();
  slow.send = async () => {
    throw new WebRpcError("omp is busy and did not answer in time; the session keeps running.", "session_slow");
  };
  useRegistry(t, { [SAVED_ID]: slow });

  const response = await agentRoute.GET(
    new Request(`http://localhost/api/agent/${SAVED_ID}`),
    { params: Promise.resolve({ id: SAVED_ID }) },
  );
  const body = JSON.parse(await response.text());

  assert.equal(response.status, 503);
  assert.equal(body.code, "session_slow");
  assert.match(body.error, /keeps running/i);
  assert.equal(body.running, false, "the slow answer carries the wrapper's run state");
  assert.equal(body.alive, true, "the child itself is alive");
  assert.equal(launches(), 0, "the busy child is not replaced");
});

test("GET reports an idle live child as not running but alive", async (t) => {
  // The fresh-spawn case from the report: omp is alive and answers get_state
  // with nothing running, so the answer must not claim a run.
  const idle = wrapper({ alive: true, running: false });
  useRegistry(t, { [SAVED_ID]: idle });

  const response = await agentRoute.GET(
    new Request(`http://localhost/api/agent/${SAVED_ID}`),
    { params: Promise.resolve({ id: SAVED_ID }) },
  );
  const body = JSON.parse(await response.text());

  assert.equal(response.status, 200);
  assert.equal(body.running, false, "no run in flight");
  assert.equal(body.alive, true, "the child is still there");
  assert.equal(launches(), 0, "reading the state never spawns");
});
