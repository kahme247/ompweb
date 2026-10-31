import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// A zone with DST makes the wall-clock cases deterministic on any machine and
// lets the spring-forward case run. Must be set before the first Date use.
process.env.TZ = "America/New_York";

const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const {
  SCHEDULED_TASK_LIMITS,
  applyScheduledTaskPatch,
  createScheduledTask,
  dueScheduleSlot,
  latestScheduleSlot,
  nextScheduleSlot,
  nextScheduledRun,
  parseScheduledTaskInput,
  parseScheduledTaskStore,
  withScheduledTaskRun,
} = await jiti.import("./scheduled-tasks.ts");

const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const FRIDAY_1530 = { kind: "weekly", days: [5], time: "15:30" };
const baseInput = {
  name: "Weekly journal",
  cwd: "/work/journal",
  prompt: "Update the journal",
  schedule: FRIDAY_1530,
  sessionMode: "new",
  model: null,
  thinkingLevel: null,
  enabled: true,
};

test("create input is trimmed, defaults to enabled, and keeps weekdays sorted and unique", () => {
  const parsed = parseScheduledTaskInput({
    ...baseInput,
    name: "  Weekly journal ",
    prompt: "\n Update the journal \n",
    schedule: { kind: "weekly", days: [5, 1, 5], time: "09:05" },
    enabled: undefined,
  }, false);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.name, "Weekly journal");
  assert.equal(parsed.value.prompt, "Update the journal");
  assert.deepEqual(parsed.value.schedule, { kind: "weekly", days: [1, 5], time: "09:05" });
  assert.equal(parsed.value.enabled, true);
});

test("invalid fields are reported per field instead of being stored", () => {
  const parsed = parseScheduledTaskInput({
    name: "",
    cwd: "relative/dir",
    prompt: "   ",
    schedule: { kind: "daily", time: "24:00" },
    sessionMode: "sometimes",
    model: { provider: "anthropic" },
    thinkingLevel: "extreme",
    enabled: "yes",
  }, false);
  assert.equal(parsed.ok, false);
  assert.deepEqual(Object.keys(parsed.errors).sort(), ["cwd", "enabled", "model", "name", "prompt", "schedule", "sessionMode", "thinkingLevel"]);
  const tooOften = parseScheduledTaskInput({ ...baseInput, schedule: { kind: "interval", everyMinutes: SCHEDULED_TASK_LIMITS.minIntervalMinutes - 1 } }, false);
  assert.equal(tooOften.ok, false);
  const noDays = parseScheduledTaskInput({ ...baseInput, schedule: { kind: "weekly", days: [], time: "10:00" } }, false);
  assert.equal(noDays.ok, false);
});

test("a patch validates and returns only the keys it carries", () => {
  assert.deepEqual(parseScheduledTaskInput({ enabled: false }, true), { ok: true, value: { enabled: false } });
  const bad = parseScheduledTaskInput({ schedule: { kind: "hourly" } }, true);
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors), ["schedule"]);
});

test("daily and weekly slots follow local wall-clock time", () => {
  const daily = { kind: "daily", time: "15:30" };
  assert.deepEqual(nextScheduleSlot(daily, local(2026, 10, 1), local(2026, 10, 26, 9)), local(2026, 10, 26, 15, 30));
  // Exactly at the slot: the next one is tomorrow (slots are strictly after).
  assert.deepEqual(nextScheduleSlot(daily, local(2026, 10, 1), local(2026, 10, 26, 15, 30)), local(2026, 10, 27, 15, 30));
  // Monday 2026-10-26 → Friday 2026-10-30; at Friday's slot → the next Friday.
  assert.deepEqual(nextScheduleSlot(FRIDAY_1530, local(2026, 10, 1), local(2026, 10, 26, 12)), local(2026, 10, 30, 15, 30));
  assert.deepEqual(nextScheduleSlot(FRIDAY_1530, local(2026, 10, 1), local(2026, 10, 30, 15, 30)), local(2026, 11, 6, 15, 30));
  assert.deepEqual(latestScheduleSlot(FRIDAY_1530, local(2026, 10, 1), local(2026, 10, 26, 12)), local(2026, 10, 23, 15, 30));
});

test("interval slots count from the anchor", () => {
  const every = { kind: "interval", everyMinutes: 90 };
  const anchor = local(2026, 10, 26, 10, 0);
  assert.equal(latestScheduleSlot(every, anchor, local(2026, 10, 26, 11, 29)), null);
  assert.deepEqual(latestScheduleSlot(every, anchor, local(2026, 10, 26, 13, 10)), local(2026, 10, 26, 13, 0));
  assert.deepEqual(nextScheduleSlot(every, anchor, local(2026, 10, 26, 13, 0)), local(2026, 10, 26, 14, 30));
  assert.deepEqual(nextScheduleSlot(every, anchor, local(2026, 10, 26, 9, 0)), anchor);
});

test("a slot skipped by a DST jump still fires once that day and the next day is normal", () => {
  const daily = { kind: "daily", time: "02:30" }; // 2026-03-08 02:30 does not exist in New York
  const first = nextScheduleSlot(daily, local(2026, 3, 1), local(2026, 3, 8, 0, 0));
  assert.equal(first.getDate(), 8);
  assert.ok(first > local(2026, 3, 8, 0, 0));
  assert.deepEqual(nextScheduleSlot(daily, local(2026, 3, 1), first), local(2026, 3, 9, 2, 30));
});

test("due slots fire once, late ones are catch-up, and missed slots collapse into one run", () => {
  // Created Thursday: the first Friday slot is owed exactly once.
  let task = createScheduledTask(baseInput, "st_1", local(2026, 10, 22, 12));
  assert.equal(dueScheduleSlot(task, local(2026, 10, 23, 15, 29)), null);
  assert.deepEqual(dueScheduleSlot(task, local(2026, 10, 23, 15, 30, 20)), { slot: local(2026, 10, 23, 15, 30), trigger: "schedule" });
  task = { ...task, lastSlotAt: local(2026, 10, 23, 15, 30).toISOString() };
  assert.equal(dueScheduleSlot(task, local(2026, 10, 23, 15, 31)), null);
  // Server down from before the 10-30 slot until 11-09: one catch-up for the
  // newest missed slot (11-06), not one per missed Friday.
  assert.deepEqual(dueScheduleSlot(task, local(2026, 11, 9, 8)), { slot: local(2026, 11, 6, 15, 30), trigger: "catch-up" });
  assert.equal(dueScheduleSlot({ ...task, enabled: false }, local(2026, 11, 9, 8)), null);
});

test("a task created after today's slot does not fire it", () => {
  const task = createScheduledTask(baseInput, "st_2", local(2026, 10, 23, 16));
  assert.equal(dueScheduleSlot(task, local(2026, 10, 23, 16, 5)), null);
  assert.deepEqual(nextScheduledRun(task, local(2026, 10, 23, 16, 5)), local(2026, 10, 30, 15, 30));
});

test("rescheduling or re-enabling never fires a slot that is already past", () => {
  const created = createScheduledTask({ ...baseInput, schedule: { kind: "daily", time: "15:00" } }, "st_3", local(2026, 10, 20, 8));
  const moved = applyScheduledTaskPatch(created, { schedule: { kind: "daily", time: "09:00" } }, local(2026, 10, 26, 12));
  assert.equal(dueScheduleSlot(moved, local(2026, 10, 26, 12, 1)), null);
  assert.deepEqual(nextScheduledRun(moved, local(2026, 10, 26, 12, 1)), local(2026, 10, 27, 9, 0));

  const paused = applyScheduledTaskPatch(created, { enabled: false }, local(2026, 10, 21, 8));
  assert.equal(nextScheduledRun(paused, local(2026, 10, 24, 8)), null);
  const resumed = applyScheduledTaskPatch(paused, { enabled: true }, local(2026, 10, 24, 16));
  assert.equal(dueScheduleSlot(resumed, local(2026, 10, 24, 16, 1)), null);
  assert.deepEqual(nextScheduledRun(resumed, local(2026, 10, 24, 16, 1)), local(2026, 10, 25, 15, 0));

  // A same-value schedule save is not a reschedule.
  const resaved = applyScheduledTaskPatch(created, { schedule: { kind: "daily", time: "15:00" }, name: "Renamed" }, local(2026, 10, 26, 12));
  assert.equal(resaved.lastSlotAt, created.lastSlotAt);
});

test("moving the workspace or switching session mode forgets the continued session", () => {
  const task = { ...createScheduledTask({ ...baseInput, sessionMode: "continue" }, "st_4", local(2026, 10, 1)), lastSessionId: "session-a" };
  assert.equal(applyScheduledTaskPatch(task, { prompt: "Changed" }, local(2026, 10, 2)).lastSessionId, "session-a");
  assert.equal(applyScheduledTaskPatch(task, { cwd: "/work/other" }, local(2026, 10, 2)).lastSessionId, null);
  assert.equal(applyScheduledTaskPatch(task, { sessionMode: "new" }, local(2026, 10, 2)).lastSessionId, null);
});

test("run history keeps the newest runs per task", () => {
  let runs = [];
  for (let index = 0; index < SCHEDULED_TASK_LIMITS.maxRunsPerTask + 3; index += 1) {
    runs = withScheduledTaskRun(runs, { id: `a${index}`, taskId: "a", trigger: "manual", scheduledFor: null, startedAt: "", finishedAt: null, sessionId: null, status: "completed", error: null });
  }
  runs = withScheduledTaskRun(runs, { id: "b0", taskId: "b", trigger: "manual", scheduledFor: null, startedAt: "", finishedAt: null, sessionId: null, status: "running", error: null });
  assert.equal(runs.filter((run) => run.taskId === "a").length, SCHEDULED_TASK_LIMITS.maxRunsPerTask);
  assert.equal(runs[0].id, "b0");
  assert.equal(runs[1].id, `a${SCHEDULED_TASK_LIMITS.maxRunsPerTask + 2}`);
  // Updating a run replaces it instead of duplicating it.
  runs = withScheduledTaskRun(runs, { ...runs[0], status: "completed" });
  assert.equal(runs.filter((run) => run.id === "b0").length, 1);
});

test("run history never drops a running record, however many runs follow it", () => {
  const run = (id, status) => ({ id, taskId: "a", trigger: "schedule", scheduledFor: null, startedAt: "", finishedAt: null, sessionId: null, status, error: null });
  let runs = withScheduledTaskRun([], run("in-flight", "running"));
  // Every overlapping slot while it runs records a skip.
  for (let index = 0; index < SCHEDULED_TASK_LIMITS.maxRunsPerTask + 5; index += 1) {
    runs = withScheduledTaskRun(runs, run(`skip${index}`, "skipped"));
  }
  assert.equal(runs.filter((entry) => entry.id === "in-flight").length, 1);
  assert.equal(runs.filter((entry) => entry.status === "skipped").length, SCHEDULED_TASK_LIMITS.maxRunsPerTask);
});

test("the store parser drops malformed tasks, duplicate ids and orphaned runs, and counts them", () => {
  const good = createScheduledTask(baseInput, "st_ok", local(2026, 10, 1));
  const text = JSON.stringify({
    version: 1,
    tasks: [good, { ...good }, { ...good, id: "st_bad", schedule: { kind: "daily", time: "7:00" } }, { ...good, id: "st_nots", anchorAt: "never" }],
    runs: [
      { id: "r1", taskId: "st_ok", trigger: "schedule", scheduledFor: good.createdAt, startedAt: good.createdAt, finishedAt: null, sessionId: null, status: "running", error: null },
      { id: "r2", taskId: "st_bad", trigger: "manual", scheduledFor: null, startedAt: good.createdAt, finishedAt: null, sessionId: null, status: "failed", error: "x" },
      { id: "r3", taskId: "st_ok", trigger: "sometime", scheduledFor: null, startedAt: good.createdAt, finishedAt: null, sessionId: null, status: "failed", error: null },
    ],
  });
  const { store, dropped } = parseScheduledTaskStore(text);
  assert.deepEqual(store.tasks, [good]);
  assert.deepEqual(store.runs.map((run) => run.id), ["r1"]);
  assert.equal(dropped, 5); // three tasks, two runs
  assert.equal(parseScheduledTaskStore(JSON.stringify(store)).dropped, 0);
  assert.equal(parseScheduledTaskStore(JSON.stringify({ version: 1, tasks: "?", runs: [] })).dropped, 1);
  // Tasks over the limit are dropped with their runs.
  const many = Array.from({ length: SCHEDULED_TASK_LIMITS.maxTasks + 1 }, (_, index) => ({ ...good, id: `st_${index}` }));
  const over = { id: "r_over", taskId: `st_${SCHEDULED_TASK_LIMITS.maxTasks}`, trigger: "manual", scheduledFor: null, startedAt: good.createdAt, finishedAt: null, sessionId: null, status: "failed", error: null };
  const limited = parseScheduledTaskStore(JSON.stringify({ version: 1, tasks: many, runs: [over] }));
  assert.equal(limited.store.tasks.length, SCHEDULED_TASK_LIMITS.maxTasks);
  assert.deepEqual(limited.store.runs, []);
  assert.equal(limited.dropped, 2);
  // A damaged file is an error, not an empty store that would then be saved.
  assert.throws(() => parseScheduledTaskStore("{oops"), SyntaxError);
  assert.throws(() => parseScheduledTaskStore("[]"), SyntaxError);
});
