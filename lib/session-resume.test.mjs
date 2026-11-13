import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LinkDriver, linkLocalHost, ompChild, until } from "./hosts/link-driver.test-helper.mjs";

/** A new omp-web process: fresh tracker, same agent dir. */
function restart() {
  globalThis.__ompResumeTracker = undefined;
}

const { EXIT_GRACE_MS, markShuttingDown, recordRunningSessions, resumeOnHostLink, takeInterruptedSessions } = await import("./session-resume.ts");
const { saveWebServerSettings } = await import("./web-settings.ts");
const hub = await import("./hosts/hub.ts");
const { createHost } = await import("./hosts/registry.ts");
const { getRpcSession, resumeInterruptedSessions } = await import("./rpc-manager.ts");

/** A v10 daemon's `open` answer that joins the listed channel `expectedChannel`. */
const joined = ({ expectedChannel, launch }) => ({
  ch: expectedChannel, joined: true, pending: [], streaming: null, cwd: launch.cwd,
  fellBack: false, launchAdvisor: false, advisorSpawned: false, autoApproveExtension: false,
});

/** Fresh agent dir and tracker per test; the resume setting starts as given. */
function setup(t, { enabled }) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-resume-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__ompResumeTracker = undefined;
  t.after(() => {
    for (const timer of globalThis.__ompResumeTracker?.drops.values() ?? []) clearTimeout(timer);
    globalThis.__ompResumeTracker = undefined;
    // The hub's held link samples go to this test's agent dir, before it is gone.
    hub.flushLinkSamples();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  saveWebServerSettings({ autoResumeSessions: enabled });
  // Seeds use the pre-per-instance name; this instance writes its own pid's list.
  const listPath = join(agentDir, "omp-web-interrupted-sessions.json");
  const ownPath = join(agentDir, `omp-web-interrupted-sessions-${process.pid}.json`);
  const recorded = () => (existsSync(ownPath) ? JSON.parse(readFileSync(ownPath, "utf8")).sessions.map((s) => s.id) : []);
  return { agentDir, listPath, ownPath, recorded };
}

const A = { id: "01a0e6b0-d916-7610-8343-f4a766ba005a", advisor: false, hostId: "local" };
const B = { id: "01a0e6b0-d916-7610-8343-f4a766ba005b", advisor: true, hostId: "local" };

test("with the setting off nothing is recorded and a leftover list is discarded", (t) => {
  const { listPath, recorded } = setup(t, { enabled: false });
  writeFileSync(listPath, JSON.stringify({ sessions: [A] }));
  recordRunningSessions([B], () => true);
  assert.deepEqual(recorded(), []);
  assert.deepEqual(takeInterruptedSessions(), []);
});

test("a run that ends normally leaves the list; one still running stays", (t) => {
  const { recorded } = setup(t, { enabled: true });
  recordRunningSessions([A, B], () => true);
  assert.deepEqual(recorded(), [A.id, B.id]);
  recordRunningSessions([B], () => true);
  assert.deepEqual(recorded(), [B.id]);
  recordRunningSessions([], () => true);
  assert.deepEqual(recorded(), []);
});

test("a crashed child is dropped after the grace window while omp-web keeps running", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { recorded } = setup(t, { enabled: true });
  recordRunningSessions([A], () => true);
  recordRunningSessions([], () => false);
  assert.deepEqual(recorded(), [A.id], "kept until the grace window passes");
  t.mock.timers.tick(EXIT_GRACE_MS);
  assert.deepEqual(recorded(), []);
});

test("children dying just before the shutdown handler are still resumed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ownPath } = setup(t, { enabled: true });
  recordRunningSessions([A, B], () => true);
  recordRunningSessions([], () => false);
  markShuttingDown();
  recordRunningSessions([], () => false);
  t.mock.timers.tick(EXIT_GRACE_MS);
  restart();
  assert.deepEqual(takeInterruptedSessions(), [A, B]);
  assert.equal(existsSync(ownPath), false, "the list is consumed");
  assert.deepEqual(takeInterruptedSessions(), [], "handed out once");
});

test("a session started before resume runs does not overwrite the previous run's list", (t) => {
  const { listPath, recorded } = setup(t, { enabled: true });
  writeFileSync(listPath, JSON.stringify({ sessions: [A] }));
  recordRunningSessions([B], () => true);
  assert.deepEqual(recorded(), [B.id]);
  assert.deepEqual(takeInterruptedSessions(), [A]);
});

test("entries with an invalid session id are ignored", (t) => {
  const { listPath } = setup(t, { enabled: true });
  writeFileSync(listPath, JSON.stringify({ sessions: [{ id: "../../etc/passwd" }, { id: 7 }, A] }));
  restart();
  assert.deepEqual(takeInterruptedSessions(), [A]);
});

/** A running process standing in for another omp-web instance. */
function liveInstance(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child.pid;
}

test("another live instance's list is neither resumed nor overwritten, and this one records its own", (t) => {
  const { agentDir, recorded } = setup(t, { enabled: true });
  const ownerPath = join(agentDir, `omp-web-interrupted-sessions-${liveInstance(t)}.json`);
  writeFileSync(ownerPath, JSON.stringify({ sessions: [A] }));
  restart();
  assert.deepEqual(takeInterruptedSessions(), []);
  recordRunningSessions([B], () => true);
  recordRunningSessions([], () => true);
  assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")).sessions, [A], "the owner's list stays intact");
  recordRunningSessions([B], () => true);
  assert.deepEqual(recorded(), [B.id]);
});

test("a list whose writer has exited is resumed", (t) => {
  const { agentDir } = setup(t, { enabled: true });
  const deadPath = join(agentDir, `omp-web-interrupted-sessions-${spawnSync(process.execPath, ["-e", "0"]).pid}.json`);
  writeFileSync(deadPath, JSON.stringify({ sessions: [A] }));
  restart();
  assert.deepEqual(takeInterruptedSessions(), [A]);
  assert.equal(existsSync(deadPath), false, "the list is consumed");
});

test("a list from before the last boot is resumed even if its pid is in use again", (t) => {
  const { agentDir } = setup(t, { enabled: true });
  const stalePath = join(agentDir, `omp-web-interrupted-sessions-${liveInstance(t)}.json`);
  writeFileSync(stalePath, JSON.stringify({ sessions: [A] }));
  utimesSync(stalePath, 0, 0);
  restart();
  assert.deepEqual(takeInterruptedSessions(), [A]);
});

test("a list entry written before hosts existed reads back as local", (t) => {
  const { listPath } = setup(t, { enabled: true });
  writeFileSync(listPath, JSON.stringify({ sessions: [{ id: A.id, advisor: true }] }));
  restart();
  assert.deepEqual(takeInterruptedSessions(), [{ id: A.id, advisor: true, hostId: "local" }]);
});

// Every v10 link owns its runs' lifecycle (the host resumes them), so a linked host's entry is never resumed by this server.
test("a remote entry waits for its host's hello, then is left to that host, which owns its lifecycle", async (t) => {
  const { listPath } = setup(t, { enabled: true });
  const { host, token } = createHost("Laptop");
  t.after(() => hub.closeHostLink(host.id));
  const remote = { id: B.id, advisor: false, hostId: host.id };
  writeFileSync(listPath, JSON.stringify({ sessions: [remote] }));
  restart();
  const resumed = [];
  resumeOnHostLink(takeInterruptedSessions(), async (entry) => {
    resumed.push(entry);
  });
  await sleep(10);
  assert.deepEqual(resumed, [], "waits for the host to link");

  const link = new LinkDriver(host.id, token);
  await link.dial();
  await sleep(10);
  assert.equal(hub.hostOwnsLifecycle(host.id), true);
  assert.deepEqual(resumed, [], "the host resumes its own runs");

  await link.drop();
  await link.dial();
  await sleep(10);
  assert.deepEqual(resumed, [], "a later hello resumes nothing either");
});

test("a remote entry whose child the server adopts on hello is not resumed", async (t) => {
  // The adoption's wrapper logs its dispose on cleanup.
  t.mock.method(console, "info", () => {});
  let link = null;
  // Before setup's cleanup: disposing the wrapper records running sessions in this test's agent dir.
  t.after(async () => {
    if (!link) return;
    const disposing = getRpcSession(B.id)?.destroyAndWait();
    await link.post({ type: "exit", ch: "live", code: 0, signal: null });
    await disposing;
    hub.closeHostLink(link.id);
  });
  const { listPath } = setup(t, { enabled: true });
  const { host, token } = createHost("Adopted laptop");
  const remote = { id: B.id, advisor: false, hostId: host.id };
  writeFileSync(listPath, JSON.stringify({ sessions: [remote] }));
  restart();
  const resumed = [];
  resumeOnHostLink(takeInterruptedSessions(), async (entry) => {
    resumed.push(entry);
  });

  link = new LinkDriver(host.id, token);
  await link.dial({ channels: [{ ch: "live", sessionId: remote.id, cwd: "/w", pending: [] }] });
  link.serve({ open: joined }, ompChild(link, remote.id, { state: { isStreaming: true } }));
  await until(() => getRpcSession(remote.id), "the adoption");
  await sleep(10);
  assert.deepEqual(resumed, [], "the run goes on in the adopted child");
});

test("this machine's interrupted run waits for its daemon's hello and is left to it", async (t) => {
  const opens = [];
  t.after(() => hub.closeHostLink("local"));
  const { listPath } = setup(t, { enabled: true });
  writeFileSync(listPath, JSON.stringify({ sessions: [A] }));
  restart();
  await resumeInterruptedSessions();
  await sleep(10);
  assert.equal(getRpcSession(A.id), undefined, "nothing starts before this machine's daemon links");

  // The daemon owns its runs' lifecycle: it resumes them itself, and this server opens nothing.
  const link = await linkLocalHost();
  link.serve({ open: (args) => opens.push(args) });
  await sleep(10);
  assert.equal(hub.hostOwnsLifecycle("local"), true);
  assert.deepEqual(opens, []);
  assert.equal(getRpcSession(A.id), undefined);
});
