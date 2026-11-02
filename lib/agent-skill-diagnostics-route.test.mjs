import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { linkLocalHost, listedSession, ompChild } from "./hosts/link-driver.test-helper.mjs";

// Real POST /api/agent/[id] handler for a saved session on this machine. Its
// daemon is driven by hand, so a `spawn` request is the observable proof that
// an omp child was created.
const agentRoute = await import("../app/api/agent/[id]/route.ts");
const hub = await import("./hosts/hub.ts");

const SAVED_ID = "01a0e6b0-d916-7610-8343-f4a766ba0051";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-skill-diagnostics-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const spawns = [];
const daemon = await linkLocalHost();
const omp = ompChild(daemon, SAVED_ID);
daemon.serve({
  async spawn(args) {
    spawns.push(args);
    await daemon.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
    return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
  },
  listSessions: () => [listedSession(SAVED_ID)],
  sessionFileExists: () => true,
  invalidateSessionLists: () => null,
}, (message) => (message.type === "kill" ? daemon.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" }) : omp(message)));

after(() => {
  hub.closeHostLink("local");
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const launches = () => spawns.length;

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
  spawns.length = 0;
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
  await globalThis.__ompSessions.get(SAVED_ID)?.destroyAndWait();
});
