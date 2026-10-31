import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

process.env.TZ = "America/New_York";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-scheduled-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const { createScheduledTaskRunner, ScheduledTaskRunningError, startScheduledTaskScheduler } = await jiti.import("./scheduled-task-runner.ts");
const { createScheduledTask, emptyScheduledTaskStore, SCHEDULED_RUN_MAX_MS } = await jiti.import("./scheduled-tasks.ts");
const {
  acquireScheduledRunLease,
  claimScheduledSlot,
  loadScheduledTaskStore,
  releaseScheduledRunLease,
  releaseScheduledSlot,
  tryOwnFile,
  updateScheduledTaskStore,
} = await jiti.import("./scheduled-task-store.ts");
const listRoute = await jiti.import("../app/api/scheduled-tasks/route.ts");
const taskRoute = await jiti.import("../app/api/scheduled-tasks/[id]/route.ts");

const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const input = (overrides = {}) => ({
  name: "Journal",
  cwd: "/work/journal",
  prompt: "Update the journal",
  schedule: { kind: "weekly", days: [5], time: "15:30" },
  sessionMode: "new",
  model: null,
  thinkingLevel: null,
  enabled: true,
  ...overrides,
});

/** A session whose turn ends when the test says so. */
function fakeSession(id) {
  const session = {
    sessionId: id,
    running: false,
    sent: [],
    destroyed: false,
    endTurn: null,
    failTurn: null,
    rejectPrompt: null,
    isRunning: () => session.running,
    async send(command) {
      session.sent.push(command);
      if (command.type === "prompt") {
        if (session.rejectPrompt) throw session.rejectPrompt;
        session.running = true;
      }
      return null;
    },
    waitForTurnEnd() {
      return new Promise((resolve, reject) => {
        session.endTurn = () => { session.running = false; resolve(); };
        session.failTurn = (error) => { session.running = false; reject(error); };
      });
    },
    async destroyAndWait() { session.destroyed = true; },
  };
  return session;
}

/** One runner over an in-memory store; pass the same `disk` to several
 *  harnesses to model omp-web instances sharing an agent dir. */
function harness({ start = local(2026, 10, 22, 12), claim = () => true, releaseClaim = () => {}, alive = () => false, disk = { store: emptyScheduledTaskStore() } } = {}) {
  const h = {
    now: start,
    sessions: [],
    opened: [],
    createError: null,
    /** Error the next spawned session throws when it receives the prompt. */
    promptError: null,
    claims: [],
    /** Task ids whose run lease another omp-web instance holds. */
    foreignLeases: new Set(),
    leases: new Set(),
    /** When set, every store write throws it (a full or unwritable disk). */
    writeError: null,
    /** Number of upcoming store writes that fail once each. */
    failWrites: 0,
    /** Retry waits, with the leases held at that moment. */
    delays: [],
    releasedSlots: [],
    logs: [],
  };
  h.runner = createScheduledTaskRunner({
    now: () => h.now,
    load: () => structuredClone(disk.store),
    update(fn) {
      if (h.writeError) throw h.writeError;
      if (h.failWrites > 0) {
        h.failWrites -= 1;
        throw new Error("EBUSY: resource busy or locked");
      }
      const draft = structuredClone(disk.store);
      const result = fn(draft);
      if (result !== false) disk.store = draft;
      return result;
    },
    claimSlot: (taskId, slot) => { h.claims.push([taskId, slot.toISOString()]); return claim(taskId, slot); },
    releaseSlot: (taskId, slot) => { h.releasedSlots.push([taskId, slot.toISOString()]); releaseClaim(taskId, slot); },
    acquireRunLease: (taskId) => {
      if (h.foreignLeases.has(taskId)) return null;
      h.leases.add(taskId);
      return `lease-${taskId}`;
    },
    // Only the token this lease was acquired with gives it back.
    releaseRunLease: (taskId, lease) => { if (lease === `lease-${taskId}`) h.leases.delete(taskId); },
    directoryExists: (path) => path !== "/missing",
    isProcessAlive: alive,
    async createSession(cwd) {
      if (h.createError) throw h.createError;
      const session = fakeSession(`s${h.sessions.length + 1}`);
      session.cwd = cwd;
      session.rejectPrompt = h.promptError;
      h.sessions.push(session);
      return session;
    },
    async openSession(id) {
      h.opened.push(id);
      return h.sessions.find((session) => session.sessionId === id) ?? null;
    },
    formatSessionTime: () => "2026-10-23 15:30",
    log: (message) => h.logs.push(message),
    delay: async (ms) => { h.delays.push({ ms, leases: [...h.leases] }); },
  });
  h.store = () => disk.store;
  /** Replace the stored runs, as another process may have left them. */
  h.setRuns = (runs) => { disk.store = { ...disk.store, runs }; };
  h.runsOf = (taskId) => disk.store.runs.filter((run) => run.taskId === taskId);
  return h;
}

test("a due slot starts one session with the task's name, model and prompt, then completes", async () => {
  const h = harness();
  const task = h.runner.create(input({ model: { provider: "anthropic", modelId: "claude" }, thinkingLevel: "high" }));
  h.now = local(2026, 10, 23, 15, 30, 10);
  const [run] = await h.runner.tick();
  assert.equal(run.trigger, "schedule");
  assert.equal(run.status, "running");
  assert.equal(run.sessionId, "s1");
  assert.deepEqual(h.sessions[0].sent.map((command) => command.type), ["set_session_name", "set_model", "set_thinking_level", "prompt"]);
  assert.equal(h.sessions[0].sent[0].name, "Journal · 2026-10-23 15:30");
  assert.equal(h.sessions[0].sent.at(-1).message, "Update the journal");
  assert.equal(h.sessions[0].cwd, "/work/journal");
  assert.equal(h.runner.list(true).tasks[0].running, true);

  // The same slot never fires again.
  h.now = local(2026, 10, 23, 15, 31);
  assert.deepEqual(await h.runner.tick(), []);

  h.sessions[0].endTurn();
  await new Promise((resolve) => setImmediate(resolve));
  const [stored] = h.runsOf(task.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.pid, null);
  assert.equal(h.runner.isActive(task.id), false);
  assert.deepEqual(h.runner.list(true).tasks[0].nextRunAt, local(2026, 10, 30, 15, 30).toISOString());
});

test("an instance that loses the slot claim leaves the task alone and does not run it", async () => {
  const h = harness({ claim: () => false });
  const task = h.runner.create(input());
  const before = structuredClone(h.store());
  h.now = local(2026, 10, 23, 15, 30, 5);
  // Even with the store unwritable: a loser never writes, so nothing throws.
  h.writeError = new Error("Timed out waiting for scheduled-tasks.json.lock");
  assert.deepEqual(await h.runner.tick(), []);
  assert.equal(h.sessions.length, 0);
  assert.deepEqual(h.store(), before);
  assert.deepEqual(h.releasedSlots, []);
  assert.deepEqual(h.runsOf(task.id), []);
});

test("a slot fires in the instance that claimed it even when a losing instance ticks first", async () => {
  const disk = { store: emptyScheduledTaskStore() };
  const claims = new Set();
  const claimOnce = (taskId, slot) => !claims.has(`${taskId}@${slot.getTime()}`) && Boolean(claims.add(`${taskId}@${slot.getTime()}`));
  const loser = harness({ disk, claim: claimOnce });
  let loserTick = null;
  // The winner claims the slot; the loser's whole tick runs before the
  // winner's watermark write.
  const winner = harness({ disk, claim: (taskId, slot) => { const won = claimOnce(taskId, slot); loserTick = loser.runner.tick(); return won; } });
  const task = winner.runner.create(input());
  winner.now = loser.now = local(2026, 10, 23, 15, 30, 5);
  const runs = await winner.runner.tick();
  assert.deepEqual(await loserTick, []);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduledFor, local(2026, 10, 23, 15, 30).toISOString());
  assert.equal(winner.sessions.length, 1);
  assert.equal(loser.sessions.length, 0);
  assert.equal(disk.store.tasks[0].lastSlotAt, local(2026, 10, 23, 15, 30).toISOString());
  assert.equal(winner.runsOf(task.id).length, 1);
});

test("a slot whose watermark write fails is given back and fires on the next tick", async () => {
  const claims = new Set();
  const key = (taskId, slot) => `${taskId}@${slot.getTime()}`;
  const h = harness({
    claim: (taskId, slot) => !claims.has(key(taskId, slot)) && Boolean(claims.add(key(taskId, slot))),
    releaseClaim: (taskId, slot) => claims.delete(key(taskId, slot)),
  });
  const task = h.runner.create(input());
  h.now = local(2026, 10, 23, 15, 30, 5);
  h.writeError = new Error("Timed out waiting for scheduled-tasks.json.lock");
  await assert.rejects(h.runner.tick(), /Timed out/);
  assert.deepEqual([...claims], []);
  h.writeError = null;
  const [run] = await h.runner.tick();
  assert.equal(run.status, "running");
  assert.equal(run.scheduledFor, local(2026, 10, 23, 15, 30).toISOString());
  assert.equal(h.runsOf(task.id).length, 1);
});

test("a slot the winner has not recorded yet stays unclaimable for the loser", async () => {
  const h = harness({ claim: () => false });
  h.runner.create(input());
  h.now = local(2026, 10, 23, 15, 30, 5);
  assert.deepEqual(await h.runner.tick(), []);
  h.now = local(2026, 10, 23, 15, 31);
  assert.deepEqual(await h.runner.tick(), []);
  assert.equal(h.claims.length, 2);
  assert.equal(h.sessions.length, 0);
});

test("a slot missed while the server was down runs once as catch-up", async () => {
  const h = harness();
  h.runner.create(input());
  h.now = local(2026, 11, 2, 9);
  const runs = await h.runner.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, "catch-up");
  assert.equal(runs[0].scheduledFor, local(2026, 10, 30, 15, 30).toISOString());
  assert.deepEqual(h.claims, [[runs[0].taskId, local(2026, 10, 30, 15, 30).toISOString()]]);
});

test("a slot that would overlap the previous run is recorded as skipped", async () => {
  const h = harness();
  const task = h.runner.create(input({ schedule: { kind: "interval", everyMinutes: 30 } }));
  h.now = local(2026, 10, 22, 12, 30, 5);
  await h.runner.tick();
  h.now = local(2026, 10, 22, 13, 0, 5);
  const [second] = await h.runner.tick();
  assert.equal(second.status, "skipped");
  assert.match(second.error, /still running/);
  assert.equal(h.sessions.length, 1);
  await assert.rejects(h.runner.runNow(task.id), ScheduledTaskRunningError);
});

test("continue mode reuses the previous run's session and skips while it is busy", async () => {
  const h = harness();
  const task = h.runner.create(input({ sessionMode: "continue" }));
  const first = await h.runner.runNow(task.id);
  assert.equal(first.sessionId, "s1");
  assert.equal(h.store().tasks[0].lastSessionId, "s1");

  // The scheduled turn ended, but the user is now working in that session:
  // the next run is skipped instead of interrupting them or forking a new one.
  h.sessions[0].endTurn();
  await new Promise((resolve) => setImmediate(resolve));
  h.sessions[0].running = true;
  const busy = await h.runner.runNow(task.id);
  assert.equal(busy.status, "skipped");
  assert.equal(busy.sessionId, "s1");

  h.sessions[0].running = false;
  const second = await h.runner.runNow(task.id);
  assert.equal(second.sessionId, "s1");
  assert.equal(h.sessions.length, 1);
  assert.deepEqual(h.opened, ["s1", "s1"]);
  // A continued session is not renamed again.
  assert.equal(h.sessions[0].sent.filter((command) => command.type === "set_session_name").length, 1);
});

test("continue mode starts a fresh session when the previous one is gone", async () => {
  const h = harness();
  const task = h.runner.create(input({ sessionMode: "continue" }));
  await h.runner.runNow(task.id);
  h.sessions[0].endTurn();
  await new Promise((resolve) => setImmediate(resolve));
  h.sessions.length = 0; // deleted outside omp-web
  const next = await h.runner.runNow(task.id);
  assert.equal(next.sessionId, "s1");
  assert.equal(next.status, "running");
});

test("start failures are recorded and never leave an orphaned session", async () => {
  const h = harness();
  const missing = h.runner.create(input({ cwd: "/missing" }));
  const noDir = await h.runner.runNow(missing.id);
  assert.equal(noDir.status, "failed");
  assert.match(noDir.error, /does not exist/);

  const task = h.runner.create(input({ name: "Other" }));
  h.createError = new Error("omp not found");
  assert.equal((await h.runner.runNow(task.id)).error, "omp not found");
  h.createError = null;

  // The prompt fails after a fresh session was spawned: that child is torn down.
  const rejected = h.runner.create(input({ name: "Rejected" }));
  h.promptError = new Error("model unavailable");
  const run = await h.runner.runNow(rejected.id);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "model unavailable");
  assert.equal(h.sessions.at(-1).destroyed, true);
  for (const id of [missing.id, task.id, rejected.id]) assert.equal(h.runner.isActive(id), false);
});

test("a turn that fails marks the run failed with the error", async () => {
  const h = harness();
  const task = h.runner.create(input());
  await h.runner.runNow(task.id);
  h.sessions[0].failTurn(new Error("Target session turn failed."));
  await new Promise((resolve) => setImmediate(resolve));
  const [run] = h.runsOf(task.id);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "Target session turn failed.");
  assert.equal(h.runner.isActive(task.id), false);
});

test("a session whose turn outlived the run's cap keeps the task from starting another until it goes idle", async () => {
  for (const sessionMode of ["new", "continue"]) {
    const h = harness();
    const task = h.runner.create(input({ sessionMode, schedule: { kind: "interval", everyMinutes: 30 } }));
    await h.runner.runNow(task.id);
    const first = h.sessions[0];
    // The run stops waiting at the cap; the session's turn keeps going.
    first.failTurn(new Error("Timed out waiting for the turn to end."));
    first.running = true;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.runsOf(task.id)[0].status, "failed", sessionMode);
    h.now = local(2026, 10, 22, 12, 30, 5);
    const [skipped] = await h.runner.tick();
    assert.equal(skipped.status, "skipped", sessionMode);
    await assert.rejects(h.runner.runNow(task.id), ScheduledTaskRunningError);
    assert.equal(h.sessions.length, 1, `${sessionMode}: no second session beside the running one`);
    first.running = false;
    assert.equal((await h.runner.runNow(task.id)).status, "running", sessionMode);
  }
});

test("runs owned by a dead process, forgotten by this one, or older than any run become interrupted", () => {
  const h = harness({ alive: (pid) => pid === 4242 });
  const task = h.runner.create(input());
  const base = { taskId: task.id, trigger: "manual", scheduledFor: null, startedAt: "2026-10-22T16:00:00.000Z", finishedAt: null, sessionId: null, status: "running", error: null };
  h.setRuns([
    { ...base, id: "dead", pid: 999_999 },
    { ...base, id: "mine", pid: process.pid },
    { ...base, id: "other-alive", pid: 4242 },
    // Its pid now belongs to an unrelated process (reused after a reboot).
    { ...base, id: "reused-pid", pid: 4242, startedAt: new Date(h.now.getTime() - SCHEDULED_RUN_MAX_MS - 1).toISOString() },
  ]);
  h.runner.reconcileRuns();
  const byId = Object.fromEntries(h.store().runs.map((run) => [run.id, run.status]));
  assert.deepEqual(byId, { dead: "interrupted", mine: "interrupted", "other-alive": "running", "reused-pid": "interrupted" });
});

test("a run another instance is running is skipped on schedule and refused on Run now", async () => {
  const h = harness();
  const task = h.runner.create(input({ schedule: { kind: "interval", everyMinutes: 30 } }));
  h.foreignLeases.add(task.id);
  h.now = local(2026, 10, 22, 12, 30, 5);
  const [run] = await h.runner.tick();
  assert.equal(run.status, "skipped");
  await assert.rejects(h.runner.runNow(task.id), ScheduledTaskRunningError);
  assert.equal(h.sessions.length, 0);

  h.foreignLeases.clear();
  const started = await h.runner.runNow(task.id);
  assert.equal(started.status, "running");
  assert.deepEqual([...h.leases], [task.id]);
  h.sessions[0].endTurn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...h.leases], []);
});

test("a failed history write when a run ends is logged, frees the task, and is written by the next reconcile", async () => {
  const h = harness();
  const task = h.runner.create(input());
  const { done } = await h.runner.startRun(h.store().tasks[0], "manual", null);
  h.writeError = new Error("ENOSPC: no space left on device");
  h.sessions[0].endTurn();
  const finished = await done; // resolves; an unhandled rejection would exit the server
  assert.equal(finished.status, "completed");
  assert.match(h.logs.at(-1), /could not record the end of run/);
  assert.equal(h.runner.isActive(task.id), false);
  assert.deepEqual([...h.leases], []);
  // The record stays "running" until a write succeeds; the next reconcile
  // then writes the kept outcome, not "interrupted".
  assert.equal(h.runsOf(task.id)[0].status, "running");
  h.writeError = null;
  h.runner.reconcileRuns();
  assert.equal(h.runsOf(task.id)[0].status, "completed");
  assert.equal(h.runsOf(task.id)[0].pid, null);
});

test("a failed history write when a run ends is retried while the task's lease is held", async () => {
  const h = harness();
  const task = h.runner.create(input());
  const { done } = await h.runner.startRun(h.store().tasks[0], "manual", null);
  h.failWrites = 2;
  h.sessions[0].endTurn();
  await done;
  assert.equal(h.runsOf(task.id)[0].status, "completed");
  assert.deepEqual(h.delays, [{ ms: 1000, leases: [task.id] }, { ms: 1000, leases: [task.id] }]);
  assert.equal(h.logs.some((message) => /could not record/.test(message)), false);
  assert.deepEqual([...h.leases], []);
});

test("a failed history write at start frees the task instead of wedging it as running", async () => {
  const h = harness();
  const task = h.runner.create(input());
  h.writeError = new Error("EACCES: permission denied");
  await assert.rejects(h.runner.runNow(task.id), /EACCES/);
  assert.equal(h.runner.isActive(task.id), false);
  assert.deepEqual([...h.leases], []);
  h.writeError = null;
  assert.equal((await h.runner.runNow(task.id)).status, "running");
});

test("slot claims are exclusive on disk, and a released claim can be made again", () => {
  const slot = local(2026, 10, 23, 15, 30);
  assert.equal(claimScheduledSlot("st_disk", slot), true);
  assert.equal(claimScheduledSlot("st_disk", slot), false);
  assert.equal(claimScheduledSlot("st_disk", local(2026, 10, 30, 15, 30)), true);
  releaseScheduledSlot("st_disk", slot);
  releaseScheduledSlot("st_disk", slot); // already gone: fine
  assert.equal(claimScheduledSlot("st_disk", slot), true);
});

/** A process that stays alive until the test ends, so an owner file naming
 *  it has a live owner on every platform. */
async function liveProcess(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { child.kill(); });
  await once(child, "spawn");
  return child;
}

const ownerDir = join(agentDir, "owner-files");
mkdirSync(ownerDir, { recursive: true });
const reclaimMarker = (path, content) => `${path}.reclaim-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
const leasesDir = join(agentDir, "omp-web", "scheduled-task-leases");
/** Now on the monotonic clock that owner files measure their holds on. */
const mono = () => Number(process.hrtime.bigint() / 1_000_000n);
/** Reclaim markers are held as long as the store lock. */
const MARKER_HOLD_MS = 60_000;

/** Set this process's monotonic clock back by `ms` until the returned
 *  function runs: holds taken meanwhile have already ended for every other
 *  process, as if their owner had stalled past them. */
function backdateHolds(t, ms) {
  const realHrtime = process.hrtime.bigint;
  const clock = t.mock.method(process.hrtime, "bigint", () => realHrtime() - BigInt(ms) * 1_000_000n);
  return () => clock.mock.restore();
}

/** The first of `files` to exist. Polls without the event loop, which a
 *  store update in progress may be holding up. */
function waitForAny(...files) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = files.find((file) => existsSync(file));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${files.join(" or ")}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const storeModule = fileURLToPath(new URL("./scheduled-task-store.ts", import.meta.url));
const reclaimerScript = `
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";
const [store, path, holdMs, inWindow, resume, result] = process.argv.slice(1);
let outcome;
try {
  const { tryOwnFile } = await createJiti(store).import(store);
  outcome = { token: tryOwnFile(path, { holdMs: holdMs ? Number(holdMs) : undefined, beforeRemove() {
    writeFileSync(inWindow, "");
    while (!existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } }) };
} catch (error) {
  outcome = { error: String(error?.stack ?? error) };
}
writeFileSync(result + ".tmp", JSON.stringify(outcome));
renameSync(result + ".tmp", result);
`;

/**
 * Another omp-web instance reclaiming `path` from an owner whose hold ended:
 * a child process that runs `tryOwnFile` and, holding the reclaim marker with
 * the stale token read again, waits for `finish()` before it removes the file.
 */
function startReclaimer(t, path, holdMs = "") {
  const dir = mkdtempSync(join(agentDir, "reclaimer-"));
  const [inWindow, resume, result] = ["in-window", "resume", "result"].map((name) => join(dir, name));
  const child = spawn(process.execPath, ["--input-type=module", "-e", reclaimerScript, storeModule, path, String(holdMs), inWindow, resume, result], { cwd: repoRoot, stdio: "ignore" });
  t.after(() => { child.kill(); });
  return {
    /** Blocks until the child is about to remove the stale file. */
    waitInWindow() {
      if (waitForAny(inWindow, result) === result) throw new Error(`the reclaimer never reached the removal: ${readFileSync(result, "utf8")}`);
    },
    /** Lets the child remove the file and take the path; the token it holds. */
    finish() {
      writeFileSync(resume, "");
      waitForAny(result);
      const { token, error } = JSON.parse(readFileSync(result, "utf8"));
      if (error) throw new Error(error);
      return token;
    },
  };
}

test("run leases on disk block a live owner and are reclaimed from a dead one", async (t) => {
  const leaseFile = join(leasesDir, "st_lease");
  mkdirSync(leasesDir, { recursive: true });
  const other = await liveProcess(t);
  writeFileSync(leaseFile, `${other.pid} other-instance`);
  assert.equal(acquireScheduledRunLease("st_lease"), null);
  releaseScheduledRunLease("st_lease", `${process.pid} earlier-lease`); // not this lease: left alone
  assert.equal(readFileSync(leaseFile, "utf8"), `${other.pid} other-instance`);
  writeFileSync(leaseFile, "999999 exited-instance"); // an owner that has exited
  const lease = acquireScheduledRunLease("st_lease");
  assert.equal(readFileSync(leaseFile, "utf8"), lease);
  const [pid, token, expiresAt, heldUntil] = lease.trim().split(" ");
  assert.equal(Number(pid), process.pid);
  assert.ok(token);
  // A lease lasts the longest run, then a reused pid cannot keep it.
  assert.ok(Math.abs(Number(heldUntil) - (mono() + SCHEDULED_RUN_MAX_MS)) < 60_000);
  assert.ok(Math.abs(Number(expiresAt) - (Date.now() + SCHEDULED_RUN_MAX_MS)) < 60_000);
  // Ours already (its run record was lost): taken over afresh.
  const again = acquireScheduledRunLease("st_lease");
  assert.notEqual(again, lease);
  releaseScheduledRunLease("st_lease", lease); // superseded: left alone
  assert.equal(readFileSync(leaseFile, "utf8"), again);
  releaseScheduledRunLease("st_lease", again);
  assert.equal(existsSync(leaseFile), false);
  assert.deepEqual(readdirSync(leasesDir), []);
});

test("a live pid keeps an owner file only until its hold ends", async (t) => {
  const other = await liveProcess(t);
  const path = join(ownerDir, "expiring");
  const now = Date.now();
  const held = mono();
  // A live owner within its hold blocks. A file from an older build is judged
  // by its pid alone, whatever its wall-clock expiry says.
  for (const content of [`${other.pid} holding ${now + 30_000} ${held + 30_000}\n`, `${other.pid} legacy-owner`, `${other.pid} older-build ${now - 1}\n`]) {
    writeFileSync(path, content);
    assert.equal(tryOwnFile(path), null, content);
    assert.equal(readFileSync(path, "utf8"), content);
  }
  // The pid now belongs to an unrelated process (reused after a crash or a
  // reboot), but the hold has ended, ends later than any hold taken in this
  // boot could (it was taken before a reboot), or is not a time: taken over.
  for (const content of [`${other.pid} ended ${now + 30_000} ${held - 1}\n`, `${other.pid} before-reboot ${now + 30_000} ${held + 2 * 60_000}\n`, `${other.pid} garbled ${now + 30_000} not-a-time\n`]) {
    writeFileSync(path, content);
    const taken = tryOwnFile(path);
    assert.equal(readFileSync(path, "utf8"), taken, content);
    const [pid, , , heldUntil] = taken.trim().split(" ");
    assert.equal(Number(pid), process.pid);
    assert.ok(Number(heldUntil) > mono() && Number(heldUntil) <= mono() + 60_000);
    rmSync(path);
  }
  assert.deepEqual(readdirSync(ownerDir), []);
});

test("setting the wall clock never frees a live owner's file", async (t) => {
  const other = await liveProcess(t);
  const leaseFile = join(leasesDir, "st_clock");
  const path = join(ownerDir, "clock");
  mkdirSync(leasesDir, { recursive: true });
  const lease = `${other.pid} running ${Date.now() + SCHEDULED_RUN_MAX_MS} ${mono() + SCHEDULED_RUN_MAX_MS}\n`;
  const lock = `${other.pid} updating ${Date.now() + 30_000} ${mono() + 30_000}\n`;
  writeFileSync(leaseFile, lease);
  writeFileSync(path, lock);
  const realNow = Date.now;
  const year = 365 * 24 * 60 * 60_000;
  for (const step of [-year, year]) {
    const clock = t.mock.method(Date, "now", () => realNow() + step);
    assert.equal(acquireScheduledRunLease("st_clock"), null, `wall clock moved by ${step} ms`);
    assert.equal(tryOwnFile(path), null, `wall clock moved by ${step} ms`);
    clock.mock.restore();
  }
  assert.equal(readFileSync(leaseFile, "utf8"), lease);
  assert.equal(readFileSync(path, "utf8"), lock);
  rmSync(leaseFile);
  rmSync(path);
});

test("a store lock left by an earlier process with this pid is taken over", () => {
  const dir = join(agentDir, "omp-web");
  const lockFile = join(dir, "scheduled-tasks.json.lock");
  mkdirSync(dir, { recursive: true });
  // Its hold ended, or an older build wrote it (this process never does),
  // even while that build's wall-clock expiry is still ahead.
  for (const content of [`${process.pid} previous-process ${Date.now() + 30_000} ${mono() - 1}\n`, `${process.pid} previous-process ${Date.now() + 30_000}\n`, `${process.pid} previous-process`]) {
    writeFileSync(lockFile, content);
    assert.equal(updateScheduledTaskStore(() => false), false, content);
    assert.equal(existsSync(lockFile), false, content);
  }
});

test("two reclaimers of one dead owner never both take the file", () => {
  const path = join(ownerDir, "two-reclaimers");
  writeFileSync(path, "999999 dead-owner");
  let second = null;
  let secondContent = null;
  // The second reclaimer runs entirely after the first read the dead owner
  // and before it reclaimed: it removes the stale file and takes the path.
  const first = tryOwnFile(path, {
    beforeReclaim: () => {
      second = tryOwnFile(path);
      secondContent = readFileSync(path, "utf8");
    },
  });
  assert.equal(readFileSync(path, "utf8"), second);
  assert.equal(secondContent, second);
  assert.equal(first, null);
  rmSync(path);
  assert.deepEqual(readdirSync(ownerDir), []);
});

test("a reclaimer never removes a live owner's file that replaced the dead one", async (t) => {
  const other = await liveProcess(t);
  for (const reclaimOwn of [false, true]) {
    const path = join(ownerDir, `replaced-${reclaimOwn}`);
    writeFileSync(path, "999999 dead-owner");
    // Another instance reclaims the dead owner's file and takes the path
    // between this reclaimer's read and its removal.
    const taken = tryOwnFile(path, { reclaimOwn, beforeReclaim: () => writeFileSync(path, `${other.pid} live-owner`) });
    assert.equal(taken, null);
    assert.equal(readFileSync(path, "utf8"), `${other.pid} live-owner`);
    rmSync(path);
  }
  assert.deepEqual(readdirSync(ownerDir), []);
});

test("a reclaim left unfinished by a dead reclaimer is taken over", () => {
  const path = join(ownerDir, "dead-reclaimer");
  writeFileSync(path, "999999 dead-owner");
  writeFileSync(reclaimMarker(path, "999999 dead-owner"), "999998 dead-reclaimer");
  assert.ok(tryOwnFile(path));
  assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid} `));
  rmSync(path);
  assert.deepEqual(readdirSync(ownerDir), []);
});

test("an owner's release never frees a run lease that is being reclaimed", async (t) => {
  const leaseFile = join(leasesDir, "st_overrun");
  // This instance's run stalls past its lease's hold. Another instance
  // reclaims the lease and is about to remove it when the run ends and
  // releases it, and the next run of the task asks for the lease.
  const restore = backdateHolds(t, SCHEDULED_RUN_MAX_MS + 1_000);
  const lease = acquireScheduledRunLease("st_overrun");
  restore();
  const before = mono();
  const reclaimer = startReclaimer(t, leaseFile, SCHEDULED_RUN_MAX_MS);
  reclaimer.waitInWindow();
  // The other process stamps its marker on the clock this one reads.
  const [, , , markerHeldUntil] = readFileSync(reclaimMarker(leaseFile, lease), "utf8").trim().split(" ");
  assert.ok(Number(markerHeldUntil) >= before + MARKER_HOLD_MS && Number(markerHeldUntil) <= mono() + MARKER_HOLD_MS, markerHeldUntil);
  releaseScheduledRunLease("st_overrun", lease);
  const next = acquireScheduledRunLease("st_overrun");
  const reclaimed = reclaimer.finish();
  assert.equal(next, null, "the next run must not get a lease the reclaimer then deletes");
  assert.equal(readFileSync(leaseFile, "utf8"), reclaimed);
  rmSync(leaseFile);
  assert.deepEqual(readdirSync(leasesDir), []);
});

test("an owner's release never frees the store lock while it is being reclaimed", async (t) => {
  const lockFile = join(agentDir, "omp-web", "scheduled-tasks.json.lock");
  let reclaimer;
  // This update stalls past the lock's hold. Another instance reclaims the
  // lock and is about to remove it when the update ends and releases it, and
  // the next update asks for the lock.
  const restore = backdateHolds(t, SCHEDULED_RUN_MAX_MS + 1_000);
  assert.equal(updateScheduledTaskStore(() => {
    restore();
    reclaimer = startReclaimer(t, lockFile);
    reclaimer.waitInWindow();
    return false;
  }), false);
  const next = tryOwnFile(lockFile);
  const reclaimed = reclaimer.finish();
  assert.equal(next, null, "the next update must not get a lock the reclaimer then deletes");
  assert.equal(readFileSync(lockFile, "utf8"), reclaimed);
  rmSync(lockFile);
});

test("an owner file whose write fails is never left behind", async (t) => {
  const path = join(ownerDir, "failed-write");
  const realWriteFileSync = fs.writeFileSync;
  const writeMock = t.mock.method(fs, "writeFileSync", (file, data, options) => {
    if (!String(file).startsWith(`${path}.`)) return realWriteFileSync(file, data, options);
    realWriteFileSync(file, "", options); // created, then the disk fills up
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  });
  syncBuiltinESMExports();
  t.after(() => { writeMock.mock.restore(); syncBuiltinESMExports(); });
  const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { tryOwnFile: tryOwnWithFullDisk } = await isolated.import("./scheduled-task-store.ts");
  assert.throws(() => tryOwnWithFullDisk(path), /ENOSPC/);
  assert.equal(writeMock.mock.callCount() > 0, true, "positive control: the owner write went through the mock");
  writeMock.mock.restore();
  syncBuiltinESMExports();
  assert.deepEqual(readdirSync(ownerDir), []);
  // Nothing blocks the next owner.
  assert.ok(tryOwnFile(path));
  rmSync(path);
});

test("a damaged store file is reported and never overwritten", async () => {
  const storeFile = join(agentDir, "omp-web", "scheduled-tasks.json");
  mkdirSync(join(agentDir, "omp-web"), { recursive: true });
  const before = existsSync(storeFile) ? readFileSync(storeFile, "utf8") : null;
  writeFileSync(storeFile, "{\"version\":1,\"tasks\":[");
  try {
    assert.throws(() => updateScheduledTaskStore(() => true), /Cannot parse/);
    assert.equal(readFileSync(storeFile, "utf8"), "{\"version\":1,\"tasks\":[");
    assert.equal((await listRoute.GET()).status, 500);
  } finally {
    if (before === null) rmSync(storeFile, { force: true });
    else writeFileSync(storeFile, before);
  }
});

test("a write that would drop malformed store entries keeps the previous file first", (t) => {
  const dir = join(agentDir, "omp-web");
  const storeFile = join(dir, "scheduled-tasks.json");
  mkdirSync(dir, { recursive: true });
  const before = existsSync(storeFile) ? readFileSync(storeFile, "utf8") : null;
  const backups = () => readdirSync(dir).filter((name) => name.startsWith("scheduled-tasks.json.dropped-"));
  const warn = t.mock.method(console, "warn", () => {});
  const good = createScheduledTask(input(), "st_good", local(2026, 10, 1));
  const broken = { ...good, id: "st_broken", schedule: { kind: "daily", time: "7:00" } };
  const brokenRun = { id: "r_broken", taskId: "st_broken", trigger: "manual", scheduledFor: null, startedAt: good.createdAt, finishedAt: null, sessionId: null, status: "failed", error: null, pid: null };
  const original = JSON.stringify({ version: 1, tasks: [good, broken], runs: [brokenRun] });
  writeFileSync(storeFile, original);
  try {
    // Reading never writes, and a skipped write keeps everything.
    assert.deepEqual(loadScheduledTaskStore().tasks.map((task) => task.id), ["st_good"]);
    assert.equal(updateScheduledTaskStore(() => false), false);
    assert.deepEqual(backups(), []);
    assert.equal(readFileSync(storeFile, "utf8"), original);

    updateScheduledTaskStore((store) => { store.tasks[0].name = "Renamed"; return true; });
    const [backup] = backups();
    assert.ok(backup, "the file with the dropped entries is kept");
    assert.equal(readFileSync(join(dir, backup), "utf8"), original);
    assert.match(warn.mock.calls.at(-1).arguments[0], /2 malformed entries were dropped/);
    assert.deepEqual(loadScheduledTaskStore().tasks.map((task) => task.name), ["Renamed"]);

    // The rewritten file has nothing left to drop: no second copy.
    updateScheduledTaskStore((store) => { store.tasks[0].name = "Again"; return true; });
    assert.equal(backups().length, 1);
  } finally {
    for (const name of backups()) rmSync(join(dir, name));
    if (before === null) rmSync(storeFile, { force: true });
    else writeFileSync(storeFile, before);
  }
});

test("an enabled scheduler starts even when the store cannot be read at boot", async (t) => {
  const storeFile = join(agentDir, "omp-web", "scheduled-tasks.json");
  mkdirSync(join(agentDir, "omp-web"), { recursive: true });
  const before = existsSync(storeFile) ? readFileSync(storeFile, "utf8") : null;
  const disabled = process.env.OMP_WEB_DISABLE_SCHEDULER;
  delete process.env.OMP_WEB_DISABLE_SCHEDULER;
  const warn = t.mock.method(console, "warn", () => {});
  writeFileSync(storeFile, "{\"version\":1,\"tasks\":[");
  try {
    await startScheduledTaskScheduler();
    // The list reports this instance's scheduler as on; it must be.
    assert.ok(globalThis.__ompScheduledTaskTimer);
    assert.match(warn.mock.calls.map((call) => call.arguments[0]).join("\n"), /Cannot parse/);
  } finally {
    clearInterval(globalThis.__ompScheduledTaskTimer);
    delete globalThis.__ompScheduledTaskTimer;
    delete globalThis.__ompScheduledTaskRunner;
    if (disabled === undefined) delete process.env.OMP_WEB_DISABLE_SCHEDULER;
    else process.env.OMP_WEB_DISABLE_SCHEDULER = disabled;
    if (before === null) rmSync(storeFile, { force: true });
    else writeFileSync(storeFile, before);
  }
});

test("routes validate input, persist tasks and map missing ids to 404", async () => {
  const json = (body) => new Request("http://localhost/api/scheduled-tasks", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const bad = await listRoute.POST(json({ ...input({ cwd: agentDir }), schedule: { kind: "daily", time: "25:00" } }));
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys((await bad.json()).fields), ["schedule"]);

  const noDir = await listRoute.POST(json(input({ cwd: join(agentDir, "nope") })));
  assert.equal(noDir.status, 400);
  assert.equal((await noDir.json()).code, "directory_not_found");

  const created = await listRoute.POST(json(input({ cwd: agentDir })));
  assert.equal(created.status, 201);
  const { task } = await created.json();
  assert.equal(loadScheduledTaskStore().tasks[0].id, task.id);

  const listed = await (await listRoute.GET()).json();
  assert.equal(listed.tasks.length, 1);
  assert.equal(typeof listed.tasks[0].nextRunAt, "string");
  assert.equal(typeof listed.timeZone, "string");

  const params = { params: Promise.resolve({ id: task.id }) };
  const patch = await taskRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ enabled: false }) }), params);
  assert.equal((await patch.json()).task.enabled, false);
  assert.equal((await (await listRoute.GET()).json()).tasks[0].nextRunAt, null);

  assert.equal((await taskRoute.DELETE(new Request("http://localhost", { method: "DELETE" }), params)).status, 200);
  const gone = await taskRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ enabled: true }) }), params);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).code, "scheduled_task_not_found");
});
