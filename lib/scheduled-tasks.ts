// Scheduled tasks: pure types, validation and schedule arithmetic shared by the
// server (store + runner), the API routes, the settings UI and the tests.
// No Node or browser APIs here. All wall-clock fields are evaluated in the
// server's local time zone: the server is what wakes up and runs the prompt.

import { DEFAULT_THINKING_LEVELS } from "./thinking-levels";
import { isRecord } from "./type-guards";

export const SCHEDULED_TASK_LIMITS = {
  maxTasks: 100,
  maxNameLength: 80,
  maxPromptLength: 20_000,
  minIntervalMinutes: 5,
  maxIntervalMinutes: 7 * 24 * 60,
  /** Runs kept per task; older entries are dropped on each new run. */
  maxRunsPerTask: 20,
} as const;

/** Upper bound for one run; the session keeps running past it, only the
 *  run record stops waiting and is marked failed. */
export const SCHEDULED_RUN_TIMEOUT_MS = 6 * 60 * 60_000;
/** Longest a run holds its lease and stays "running": the turn timeout plus
 *  time to start the session and write the final record. Past it, the run's
 *  owner is gone even if a process with its pid exists (a reused pid). */
export const SCHEDULED_RUN_MAX_MS = SCHEDULED_RUN_TIMEOUT_MS + 10 * 60_000;

export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, as Date#getDay

export type TaskSchedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: ScheduleWeekday[]; time: string };

/** "new": every run starts a fresh session. "continue": every run is sent to
 *  the session the previous run used (a fresh one when there is none yet). */
export type ScheduledTaskSessionMode = "new" | "continue";

export interface ScheduledTaskModel {
  provider: string;
  modelId: string;
}

/** Fields a client may set. */
export interface ScheduledTaskInput {
  name: string;
  cwd: string;
  prompt: string;
  schedule: TaskSchedule;
  sessionMode: ScheduledTaskSessionMode;
  model: ScheduledTaskModel | null;
  thinkingLevel: string | null;
  enabled: boolean;
}

export interface ScheduledTask extends ScheduledTaskInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Interval schedules count from here; reset whenever the schedule changes. */
  anchorAt: string;
  /** Newest schedule slot already handled (run, skipped, or deliberately not
   *  caught up). Slots at or before it never fire. */
  lastSlotAt: string;
  /** Session the previous run used; "continue" mode sends the next run there. */
  lastSessionId: string | null;
}

export type ScheduledTaskRunTrigger = "schedule" | "catch-up" | "manual";
export type ScheduledTaskRunStatus = "running" | "completed" | "failed" | "skipped" | "interrupted";

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  trigger: ScheduledTaskRunTrigger;
  /** The schedule slot this run belongs to; null for manual runs. */
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  status: ScheduledTaskRunStatus;
  error: string | null;
  /** omp-web process that owns a running run; a dead owner means interrupted. */
  pid: number | null;
}

export interface ScheduledTaskStore {
  version: 1;
  tasks: ScheduledTask[];
  runs: ScheduledTaskRun[];
}

/** GET /api/scheduled-tasks payload. */
export interface ScheduledTaskListResponse {
  tasks: Array<ScheduledTask & { nextRunAt: string | null; running: boolean }>;
  runs: ScheduledTaskRun[];
  timeZone: string;
  schedulerEnabled: boolean;
}

export type ScheduledTaskFieldErrors = Partial<Record<keyof ScheduledTaskInput, string>>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ScheduledTaskFieldErrors };

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function emptyScheduledTaskStore(): ScheduledTaskStore {
  return { version: 1, tasks: [], runs: [] };
}

function parseSchedule(value: unknown): TaskSchedule | string {
  if (!isRecord(value)) return "Schedule is required";
  if (value.kind === "interval") {
    const every = value.everyMinutes;
    if (typeof every !== "number" || !Number.isInteger(every)
      || every < SCHEDULED_TASK_LIMITS.minIntervalMinutes || every > SCHEDULED_TASK_LIMITS.maxIntervalMinutes) {
      return `Interval must be a whole number of minutes between ${SCHEDULED_TASK_LIMITS.minIntervalMinutes} and ${SCHEDULED_TASK_LIMITS.maxIntervalMinutes}`;
    }
    return { kind: "interval", everyMinutes: every };
  }
  if (value.kind === "daily" || value.kind === "weekly") {
    if (typeof value.time !== "string" || !TIME_PATTERN.test(value.time)) return "Time must be HH:MM (24-hour)";
    if (value.kind === "daily") return { kind: "daily", time: value.time };
    if (!Array.isArray(value.days)) return "Pick at least one weekday";
    const days = new Set<ScheduleWeekday>();
    for (const day of value.days) {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) return "Weekdays must be 0 (Sunday) to 6 (Saturday)";
      days.add(day as ScheduleWeekday);
    }
    if (days.size === 0) return "Pick at least one weekday";
    return { kind: "weekly", days: [...days].sort((a, b) => a - b), time: value.time };
  }
  return "Unknown schedule kind";
}

function parseModel(value: unknown): ScheduledTaskModel | null | string {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return "Model must be { provider, modelId } or null";
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  if (!provider || !modelId) return "Model needs both provider and modelId";
  return { provider, modelId };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * Validate a create body (`partial: false`) or a PATCH body (`partial: true`,
 * only the keys present are checked and returned). Strings are trimmed; the
 * prompt keeps its inner whitespace.
 */
export function parseScheduledTaskInput(body: unknown, partial: false): ParseResult<ScheduledTaskInput>;
export function parseScheduledTaskInput(body: unknown, partial: true): ParseResult<Partial<ScheduledTaskInput>>;
export function parseScheduledTaskInput(body: unknown, partial: boolean): ParseResult<Partial<ScheduledTaskInput>> {
  if (!isRecord(body)) return { ok: false, errors: { name: "Request body must be a JSON object" } };
  const errors: ScheduledTaskFieldErrors = {};
  const value: Partial<ScheduledTaskInput> = {};
  const has = (key: keyof ScheduledTaskInput) => !partial || key in body;

  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) errors.name = "Name is required";
    else if (name.length > SCHEDULED_TASK_LIMITS.maxNameLength) errors.name = `Name is limited to ${SCHEDULED_TASK_LIMITS.maxNameLength} characters`;
    else value.name = name;
  }
  if (has("cwd")) {
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) errors.cwd = "Workspace is required";
    else if (!isAbsolutePath(cwd)) errors.cwd = "Workspace must be an absolute path";
    else value.cwd = cwd;
  }
  if (has("prompt")) {
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) errors.prompt = "Prompt is required";
    else if (prompt.length > SCHEDULED_TASK_LIMITS.maxPromptLength) errors.prompt = `Prompt is limited to ${SCHEDULED_TASK_LIMITS.maxPromptLength} characters`;
    else value.prompt = prompt.trim();
  }
  if (has("schedule")) {
    const schedule = parseSchedule(body.schedule);
    if (typeof schedule === "string") errors.schedule = schedule;
    else value.schedule = schedule;
  }
  if (has("sessionMode")) {
    if (body.sessionMode === "new" || body.sessionMode === "continue") value.sessionMode = body.sessionMode;
    else errors.sessionMode = "Session mode must be \"new\" or \"continue\"";
  }
  if (has("model")) {
    const model = parseModel(body.model);
    if (typeof model === "string") errors.model = model;
    else value.model = model;
  }
  if (has("thinkingLevel")) {
    const level = body.thinkingLevel;
    if (level === null || level === undefined || level === "") value.thinkingLevel = null;
    else if (typeof level === "string" && DEFAULT_THINKING_LEVELS.includes(level)) value.thinkingLevel = level;
    else errors.thinkingLevel = "Unknown thinking level";
  }
  if (has("enabled")) {
    if (typeof body.enabled === "boolean") value.enabled = body.enabled;
    else if (!partial && body.enabled === undefined) value.enabled = true;
    else errors.enabled = "Enabled must be true or false";
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Build a new task. `lastSlotAt = now`: nothing before creation ever fires. */
export function createScheduledTask(input: ScheduledTaskInput, id: string, now: Date): ScheduledTask {
  const at = now.toISOString();
  return { ...input, id, createdAt: at, updatedAt: at, anchorAt: at, lastSlotAt: at, lastSessionId: null };
}

/**
 * Apply a validated patch. Changing the schedule or re-enabling a task resets
 * the slot watermark to `now`, so neither fires a slot that is already past
 * (e.g. moving today's 15:00 run to 09:00 at noon, or resuming after a pause).
 * Moving the workspace or switching session mode forgets the continued session.
 */
export function applyScheduledTaskPatch(task: ScheduledTask, patch: Partial<ScheduledTaskInput>, now: Date): ScheduledTask {
  const at = now.toISOString();
  const next: ScheduledTask = { ...task, ...patch, updatedAt: at };
  const scheduleChanged = patch.schedule !== undefined && JSON.stringify(patch.schedule) !== JSON.stringify(task.schedule);
  if (scheduleChanged) next.anchorAt = at;
  if (scheduleChanged || (patch.enabled === true && !task.enabled)) next.lastSlotAt = at;
  if ((patch.cwd !== undefined && patch.cwd !== task.cwd) || (patch.sessionMode !== undefined && patch.sessionMode !== task.sessionMode)) {
    next.lastSessionId = null;
  }
  return next;
}

function parseClock(time: string): { hours: number; minutes: number } {
  const match = TIME_PATTERN.exec(time);
  if (!match) throw new Error(`Invalid time ${time}`);
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** Local wall-clock slot `daysFromBase` days after `base`'s calendar day. A
 *  time skipped by a DST jump resolves to the shifted instant Date picks. */
function localSlot(base: Date, daysFromBase: number, time: string): Date {
  const { hours, minutes } = parseClock(time);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysFromBase, hours, minutes, 0, 0);
}

/** First slot strictly after `after`. */
export function nextScheduleSlot(schedule: TaskSchedule, anchorAt: Date, after: Date): Date {
  if (schedule.kind === "interval") {
    const step = schedule.everyMinutes * 60_000;
    const elapsed = after.getTime() - anchorAt.getTime();
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / step) + 1;
    return new Date(anchorAt.getTime() + steps * step);
  }
  for (let day = 0; day <= 8; day += 1) {
    const slot = localSlot(after, day, schedule.time);
    if (slot.getTime() > after.getTime() && (schedule.kind === "daily" || schedule.days.includes(slot.getDay() as ScheduleWeekday))) return slot;
  }
  throw new Error("No schedule slot within eight days");
}

/** Newest slot at or before `at`, or null when there is none since the anchor. */
export function latestScheduleSlot(schedule: TaskSchedule, anchorAt: Date, at: Date): Date | null {
  if (schedule.kind === "interval") {
    const step = schedule.everyMinutes * 60_000;
    const elapsed = at.getTime() - anchorAt.getTime();
    if (elapsed < step) return null;
    return new Date(anchorAt.getTime() + Math.floor(elapsed / step) * step);
  }
  for (let day = 0; day >= -8; day -= 1) {
    const slot = localSlot(at, day, schedule.time);
    if (slot.getTime() <= at.getTime() && (schedule.kind === "daily" || schedule.days.includes(slot.getDay() as ScheduleWeekday))) return slot;
  }
  return null;
}

/** How late a slot may fire and still count as on time (else "catch-up"). */
export const ON_TIME_WINDOW_MS = 5 * 60_000;

/**
 * The slot an enabled task owes at `now`: the newest past slot newer than the
 * task's watermark. Missed slots collapse into this one run, so a server that
 * was down for a week runs a weekly task once on return, not once per miss.
 */
export function dueScheduleSlot(task: ScheduledTask, now: Date): { slot: Date; trigger: "schedule" | "catch-up" } | null {
  if (!task.enabled) return null;
  const slot = latestScheduleSlot(task.schedule, new Date(task.anchorAt), now);
  if (!slot || slot.getTime() <= new Date(task.lastSlotAt).getTime()) return null;
  return { slot, trigger: now.getTime() - slot.getTime() <= ON_TIME_WINDOW_MS ? "schedule" : "catch-up" };
}

/** Next time the task will run on its own; null while disabled. */
export function nextScheduledRun(task: ScheduledTask, now: Date): Date | null {
  if (!task.enabled) return null;
  if (dueScheduleSlot(task, now)) return now;
  const watermark = new Date(Math.max(now.getTime(), new Date(task.lastSlotAt).getTime()));
  return nextScheduleSlot(task.schedule, new Date(task.anchorAt), watermark);
}

/** Add a run, keeping the newest `maxRunsPerTask` finished runs per task
 *  (newest first). Running records are always kept: dropping one would show
 *  the task idle while its run is still in flight. */
export function withScheduledTaskRun(runs: readonly ScheduledTaskRun[], run: ScheduledTaskRun): ScheduledTaskRun[] {
  const next = [run, ...runs.filter((entry) => entry.id !== run.id)];
  const perTask = new Map<string, number>();
  return next.filter((entry) => {
    if (entry.status === "running") return true;
    const count = (perTask.get(entry.taskId) ?? 0) + 1;
    perTask.set(entry.taskId, count);
    return count <= SCHEDULED_TASK_LIMITS.maxRunsPerTask;
  });
}

const TIMESTAMP_KEYS = ["createdAt", "updatedAt", "anchorAt", "lastSlotAt"] as const;

/** One stored task, or null when any field is malformed. */
function parseStoredTask(value: unknown): ScheduledTask | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  const input = parseScheduledTaskInput(value, false);
  if (!input.ok) return null;
  const times: Partial<Record<(typeof TIMESTAMP_KEYS)[number], string>> = {};
  for (const key of TIMESTAMP_KEYS) {
    const time = value[key];
    if (typeof time !== "string" || Number.isNaN(Date.parse(time))) return null;
    times[key] = time;
  }
  const lastSessionId = value.lastSessionId;
  if (lastSessionId !== null && typeof lastSessionId !== "string") return null;
  return { ...input.value, id: value.id, ...(times as Record<(typeof TIMESTAMP_KEYS)[number], string>), lastSessionId };
}

const RUN_STATUSES: Record<ScheduledTaskRunStatus, true> = { running: true, completed: true, failed: true, skipped: true, interrupted: true };
const RUN_TRIGGERS: Record<ScheduledTaskRunTrigger, true> = { schedule: true, "catch-up": true, manual: true };

function isRunRecord(value: unknown): value is ScheduledTaskRun {
  return isRecord(value)
    && typeof value.id === "string" && typeof value.taskId === "string"
    && typeof value.trigger === "string" && Object.hasOwn(RUN_TRIGGERS, value.trigger)
    && typeof value.status === "string" && Object.hasOwn(RUN_STATUSES, value.status)
    && typeof value.startedAt === "string"
    && (value.scheduledFor === null || typeof value.scheduledFor === "string")
    && (value.finishedAt === null || typeof value.finishedAt === "string")
    && (value.sessionId === null || typeof value.sessionId === "string")
    && (value.error === null || typeof value.error === "string")
    && (value.pid === undefined || value.pid === null || (typeof value.pid === "number" && Number.isInteger(value.pid)));
}

export interface ParsedScheduledTaskStore {
  store: ScheduledTaskStore;
  /** Entries of the file that `store` does not keep (malformed, duplicate,
   *  over the task limit, or runs of a task that is not kept). Saving `store`
   *  over the file would lose them. */
  dropped: number;
}

/**
 * Parse the on-disk store. Malformed entries are left out of `store` and
 * counted in `dropped`; a file that is not a JSON object throws (SyntaxError),
 * so a damaged store is reported instead of being read as empty and then
 * overwritten.
 */
export function parseScheduledTaskStore(text: string): ParsedScheduledTaskStore {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new SyntaxError("Scheduled task store is not a JSON object");
  let dropped = 0;
  const list = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    if (value !== undefined) dropped += 1;
    return [];
  };
  const rawTasks = list(raw.tasks);
  const rawRuns = list(raw.runs);
  const tasks: ScheduledTask[] = [];
  const ids = new Set<string>();
  for (const entry of rawTasks) {
    const task = parseStoredTask(entry);
    if (!task || ids.has(task.id) || tasks.length >= SCHEDULED_TASK_LIMITS.maxTasks) continue;
    ids.add(task.id);
    tasks.push(task);
  }
  const runs = rawRuns
    .filter(isRunRecord)
    .filter((run) => ids.has(run.taskId))
    .map((run) => ({ ...run, pid: run.pid ?? null }));
  dropped += rawTasks.length - tasks.length + rawRuns.length - runs.length;
  return { store: { version: 1, tasks, runs }, dropped };
}
