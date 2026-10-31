import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { setTimeout as sleep } from "timers/promises";
import { allowFileRoot } from "./file-access";
import { getRpcSession, resolveSpawnCwdResult, startRpcSession } from "./rpc-manager";
import {
  acquireScheduledRunLease,
  claimScheduledSlot,
  isProcessAlive,
  loadScheduledTaskStore,
  pruneScheduledSlotClaims,
  releaseScheduledRunLease,
  releaseScheduledSlot,
  updateScheduledTaskStore,
} from "./scheduled-task-store";
import { invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "./session-reader";
import {
  applyScheduledTaskPatch,
  createScheduledTask,
  dueScheduleSlot,
  nextScheduledRun,
  SCHEDULED_RUN_MAX_MS,
  SCHEDULED_RUN_TIMEOUT_MS,
  SCHEDULED_TASK_LIMITS,
  withScheduledTaskRun,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskListResponse,
  type ScheduledTaskRun,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskStore,
} from "./scheduled-tasks";

// Runs scheduled tasks inside the omp-web server process. Each run is an
// ordinary omp session started through the same paths the UI uses, so it
// shows up live in the sidebar and can be opened, steered or continued.
// State that must survive Next.js hot reloads (in-flight runs, the timer)
// lives on globalThis, like the session registry in rpc-manager.

/** A run's session as the runner needs it (AgentSessionWrapper satisfies it). */
export interface ScheduledRunSession {
  readonly sessionId: string;
  isRunning(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
  waitForTurnEnd(timeoutMs: number): Promise<void>;
  destroyAndWait(): Promise<void>;
}

export interface ScheduledTaskRunnerDeps {
  now(): Date;
  load(): ScheduledTaskStore;
  update<T>(update: (store: ScheduledTaskStore) => T | false): T | false;
  claimSlot(taskId: string, slot: Date): boolean;
  /** Give back a claim this process made. */
  releaseSlot(taskId: string, slot: Date): void;
  /** Cross-instance "a run of this task is in flight": the lease's token, or
   *  null while another live process holds it. */
  acquireRunLease(taskId: string): string | null;
  /** Give back the lease `acquireRunLease` returned. */
  releaseRunLease(taskId: string, lease: string): void;
  directoryExists(path: string): boolean;
  isProcessAlive(pid: number): boolean;
  /** Spawn a fresh session in `cwd` (no prompt sent). */
  createSession(cwd: string): Promise<ScheduledRunSession>;
  /** Attach to an existing session, or null when it no longer exists. */
  openSession(sessionId: string): Promise<ScheduledRunSession | null>;
  /** Format a run time for the session name, in the server's local time. */
  formatSessionTime(date: Date): string;
  log(message: string): void;
  /** Wait before retrying a failed write. */
  delay(ms: number): Promise<void>;
}

export class ScheduledTaskNotFoundError extends Error {
  code = "scheduled_task_not_found";
  constructor() {
    super("Scheduled task not found");
  }
}

export class ScheduledTaskLimitError extends Error {
  code = "scheduled_task_limit";
  constructor() {
    super(`At most ${SCHEDULED_TASK_LIMITS.maxTasks} scheduled tasks can exist`);
  }
}

export class ScheduledTaskRunningError extends Error {
  code = "scheduled_task_running";
  constructor() {
    super("This task is already running");
  }
}

/** Attempts at writing a run's final record before its lease is released;
 *  a record still unwritten then is written by the next `reconcileRuns`. */
const FINAL_RECORD_ATTEMPTS = 3;
const FINAL_RECORD_RETRY_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StartedScheduledRun {
  /** The record once the prompt was accepted, or the skip/failure record. */
  run: ScheduledTaskRun;
  /** Settles with the final record when the turn ends. */
  done: Promise<ScheduledTaskRun>;
}

export interface ScheduledTaskRunner {
  /** Fire every slot that is due now; returns the runs it started. */
  tick(): Promise<ScheduledTaskRun[]>;
  list(schedulerEnabled: boolean): ScheduledTaskListResponse;
  create(input: ScheduledTaskInput): ScheduledTask;
  update(id: string, patch: Partial<ScheduledTaskInput>): ScheduledTask;
  remove(id: string): void;
  /** Throws ScheduledTaskRunningError while a run of the task is in flight
   *  in this or another omp-web process. */
  runNow(id: string): Promise<ScheduledTaskRun>;
  /** Mark runs whose owning process is gone (or forgot them) as interrupted,
   *  and write final records this process could not write when its runs ended. */
  reconcileRuns(): void;
  /** Never throws for run-time problems (they become the record), except a
   *  manual run of a task already running: ScheduledTaskRunningError. */
  startRun(task: ScheduledTask, trigger: ScheduledTaskRunTrigger, scheduledFor: Date | null): Promise<StartedScheduledRun>;
  isActive(taskId: string): boolean;
}

export function createScheduledTaskRunner(deps: ScheduledTaskRunnerDeps): ScheduledTaskRunner {
  /** taskId → id of its in-flight run in this process. */
  const active = new Map<string, string>();
  /** runId → final record of a run of this process whose write kept failing;
   *  `reconcileRuns` writes it in place of "interrupted". */
  const unrecorded = new Map<string, ScheduledTaskRun>();
  /** taskId → session of its last run here whose turn was still going when
   *  the run stopped waiting (the turn cap): it counts as the task's run
   *  until it goes idle, so no second session of the task starts beside it. */
  const overrun = new Map<string, ScheduledRunSession>();

  const saveRun = (run: ScheduledTaskRun) => {
    deps.update((store) => {
      if (!store.tasks.some((task) => task.id === run.taskId)) return false;
      store.runs = withScheduledTaskRun(store.runs, run);
      return true;
    });
  };

  const setLastSession = (taskId: string, sessionId: string) => {
    deps.update((store) => {
      const task = store.tasks.find((entry) => entry.id === taskId);
      if (!task || task.lastSessionId === sessionId) return false;
      task.lastSessionId = sessionId;
      return true;
    });
  };

  const finish = (run: ScheduledTaskRun, status: ScheduledTaskRun["status"], error: string | null) => {
    Object.assign(run, { status, error, finishedAt: deps.now().toISOString(), pid: null });
    saveRun(run);
  };

  /** `finish` for a run that ended, retried a few times; throws the last error. */
  const finishEnded = async (run: ScheduledTaskRun, status: ScheduledTaskRun["status"], error: string | null) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        finish(run, status, error);
        return;
      } catch (saveError) {
        if (attempt >= FINAL_RECORD_ATTEMPTS) throw saveError;
        await deps.delay(FINAL_RECORD_RETRY_MS);
      }
    }
  };

  /**
   * Start one run. Resolves once the prompt was accepted (or the run was
   * skipped or failed to start) with the run record; `done` settles (never
   * rejects) when the turn ends.
   */
  async function startRun(task: ScheduledTask, trigger: ScheduledTaskRunTrigger, scheduledFor: Date | null): Promise<StartedScheduledRun> {
    const run: ScheduledTaskRun = {
      id: `run_${randomUUID()}`,
      taskId: task.id,
      trigger,
      scheduledFor: scheduledFor?.toISOString() ?? null,
      startedAt: deps.now().toISOString(),
      finishedAt: null,
      sessionId: null,
      status: "running",
      error: null,
      pid: process.pid,
    };
    // The lease covers other omp-web instances on the agent dir; `active`
    // covers this one (and lets the lease reclaim a lost record of ours).
    if (overrun.get(task.id)?.isRunning() === false) overrun.delete(task.id);
    const lease = active.has(task.id) || overrun.has(task.id) ? null : deps.acquireRunLease(task.id);
    if (lease === null) {
      if (trigger === "manual") throw new ScheduledTaskRunningError();
      finish(run, "skipped", "The previous run of this task was still running.");
      return { run, done: Promise.resolve(run) };
    }
    active.set(task.id, run.id);
    const release = () => {
      if (active.get(task.id) === run.id) active.delete(task.id);
      deps.releaseRunLease(task.id, lease);
    };

    let session: ScheduledRunSession | null = null;
    let created = false;
    try {
      saveRun(run);
      if (!deps.directoryExists(task.cwd)) throw new Error(`Workspace directory does not exist: ${task.cwd}`);
      if (task.sessionMode === "continue" && task.lastSessionId) {
        session = await deps.openSession(task.lastSessionId);
        if (session?.isRunning()) {
          release();
          run.sessionId = session.sessionId;
          finish(run, "skipped", "The continued session was busy.");
          return { run, done: Promise.resolve(run) };
        }
      }
      if (!session) {
        session = await deps.createSession(task.cwd);
        created = true;
        await session.send({ type: "set_session_name", name: `${task.name} · ${deps.formatSessionTime(deps.now())}` });
      }
      if (task.model) await session.send({ type: "set_model", provider: task.model.provider, modelId: task.model.modelId });
      if (task.thinkingLevel) await session.send({ type: "set_thinking_level", level: task.thinkingLevel });
      run.sessionId = session.sessionId;
      saveRun(run);
      setLastSession(task.id, session.sessionId);
      // Register before sending so a fast turn cannot end unobserved. If the
      // prompt below fails, the catch settles the run and nothing awaits this
      // waiter; its later timeout must not surface as an unhandled rejection.
      const turnEnd = session.waitForTurnEnd(SCHEDULED_RUN_TIMEOUT_MS);
      turnEnd.catch(() => {});
      await session.send({ type: "prompt", message: task.prompt });
      const live = session;
      const done = turnEnd.then(
        () => ({ status: "completed" as const, error: null }),
        (error: unknown) => ({ status: "failed" as const, error: errorMessage(error) }),
      ).then(async (outcome) => {
        // The wait hit the cap but the turn goes on: still this task's run.
        if (live.isRunning()) overrun.set(task.id, live);
        // A non-owner write moves the session to a new id; follow it.
        const movedTo = live.sessionId && live.sessionId !== run.sessionId ? live.sessionId : null;
        if (movedTo) run.sessionId = movedTo;
        // Still under the lease, so a retried write cannot race a new run.
        try {
          await finishEnded(run, outcome.status, outcome.error);
        } catch (error) {
          unrecorded.set(run.id, run);
          throw error;
        }
        if (movedTo) setLastSession(task.id, movedTo);
      }).catch((error: unknown) => {
        // Nobody awaits `done`; a failed history write must not become an
        // unhandled rejection (instrumentation exits the server on those).
        deps.log(`scheduled task ${task.id}: could not record the end of run ${run.id}: ${errorMessage(error)}`);
      }).then(() => run).finally(release);
      return { run, done };
    } catch (error) {
      // A session spawned for a prompt that never ran would idle as an
      // orphaned child; a continued session belongs to the user and stays.
      if (created && session) await session.destroyAndWait().catch(() => {});
      try {
        finish(run, "failed", errorMessage(error));
      } finally {
        release();
      }
      deps.log(`scheduled task ${task.id} failed to start: ${run.error}`);
      return { run, done: Promise.resolve(run) };
    }
  }

  /** Fire every slot that is due now. Returns the runs it started. */
  async function tick(): Promise<ScheduledTaskRun[]> {
    const now = deps.now();
    const started: ScheduledTaskRun[] = [];
    for (const task of deps.load().tasks) {
      const due = dueScheduleSlot(task, now);
      if (!due) continue;
      // Only the instance that claimed the slot touches the task. Were a
      // loser to advance the watermark first, the winner would find the slot
      // already taken and fire it nowhere. A loser that ticks again before
      // the winner's write just fails the claim again.
      if (!deps.claimSlot(task.id, due.slot)) continue;
      let current: ScheduledTask | false;
      try {
        current = deps.update((store) => {
          const entry = store.tasks.find((candidate) => candidate.id === task.id);
          if (!entry || new Date(entry.lastSlotAt).getTime() >= due.slot.getTime()) return false;
          entry.lastSlotAt = due.slot.toISOString();
          return entry;
        });
      } catch (error) {
        // The slot stays due; give the claim back so the next tick fires it
        // instead of finding the claim and skipping the slot for good.
        try {
          deps.releaseSlot(task.id, due.slot);
        } catch (releaseError) {
          deps.log(`scheduled task ${task.id}: could not release the claim on slot ${due.slot.toISOString()}: ${errorMessage(releaseError)}`);
        }
        throw error;
      }
      if (current === false) continue;
      deps.log(`running scheduled task ${task.id} (${due.trigger}, slot ${due.slot.toISOString()})`);
      started.push((await startRun(current, due.trigger, due.slot)).run);
    }
    return started;
  }

  /** Mark runs whose owning process is gone (or forgot them) as interrupted,
   *  and write the final records this process could not write when its runs
   *  ended. A run older than the longest one is gone even if its pid was reused. */
  function reconcileRuns(): void {
    deps.update((store) => {
      let changed = false;
      const now = deps.now();
      for (const run of store.runs) {
        const final = unrecorded.get(run.id);
        if (final) {
          Object.assign(run, final);
          changed = true;
          continue;
        }
        if (run.status !== "running") continue;
        const orphaned = run.pid === null
          || (run.pid === process.pid
            ? active.get(run.taskId) !== run.id
            : !deps.isProcessAlive(run.pid) || now.getTime() - new Date(run.startedAt).getTime() > SCHEDULED_RUN_MAX_MS);
        if (!orphaned) continue;
        Object.assign(run, { status: "interrupted", finishedAt: run.finishedAt ?? now.toISOString(), pid: null });
        changed = true;
      }
      return changed;
    });
    // Written now, or their task and its history were deleted.
    unrecorded.clear();
  }

  function list(schedulerEnabled: boolean): ScheduledTaskListResponse {
    reconcileRuns();
    const store = deps.load();
    const now = deps.now();
    const runningTasks = new Set(store.runs.filter((run) => run.status === "running").map((run) => run.taskId));
    return {
      tasks: store.tasks.map((task) => ({
        ...task,
        nextRunAt: nextScheduledRun(task, now)?.toISOString() ?? null,
        running: runningTasks.has(task.id),
      })),
      runs: store.runs,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedulerEnabled,
    };
  }

  function create(input: ScheduledTaskInput): ScheduledTask {
    const task = deps.update((store) => {
      if (store.tasks.length >= SCHEDULED_TASK_LIMITS.maxTasks) throw new ScheduledTaskLimitError();
      const created = createScheduledTask(input, `st_${randomUUID()}`, deps.now());
      store.tasks.push(created);
      return created;
    });
    if (task === false) throw new Error("Scheduled task store rejected the write");
    return task;
  }

  function update(id: string, patch: Partial<ScheduledTaskInput>): ScheduledTask {
    const task = deps.update((store) => {
      const index = store.tasks.findIndex((entry) => entry.id === id);
      if (index < 0) throw new ScheduledTaskNotFoundError();
      store.tasks[index] = applyScheduledTaskPatch(store.tasks[index], patch, deps.now());
      return store.tasks[index];
    });
    if (task === false) throw new Error("Scheduled task store rejected the write");
    return task;
  }

  /** Delete a task and its history. A run in flight keeps going as a session. */
  function remove(id: string): void {
    deps.update((store) => {
      if (!store.tasks.some((task) => task.id === id)) throw new ScheduledTaskNotFoundError();
      store.tasks = store.tasks.filter((task) => task.id !== id);
      store.runs = store.runs.filter((run) => run.taskId !== id);
      return true;
    });
  }

  async function runNow(id: string): Promise<ScheduledTaskRun> {
    const task = deps.load().tasks.find((entry) => entry.id === id);
    if (!task) throw new ScheduledTaskNotFoundError();
    return (await startRun(task, "manual", null)).run;
  }

  return { tick, list, create, update, remove, runNow, reconcileRuns, startRun, isActive: (taskId) => active.has(taskId) };
}

// ── Process singleton ────────────────────────────────────────────────────

const TICK_MS = 30_000;

declare global {
  var __ompScheduledTaskRunner: ScheduledTaskRunner | undefined;
  var __ompScheduledTaskTimer: NodeJS.Timeout | undefined;
}

/** The scheduler is on unless OMP_WEB_DISABLE_SCHEDULER=1 (manual runs and
 *  editing keep working either way). */
export function isSchedulerEnabled(): boolean {
  return process.env.OMP_WEB_DISABLE_SCHEDULER !== "1";
}

function defaultDeps(): ScheduledTaskRunnerDeps {
  return {
    now: () => new Date(),
    load: loadScheduledTaskStore,
    update: updateScheduledTaskStore,
    claimSlot: claimScheduledSlot,
    releaseSlot: releaseScheduledSlot,
    acquireRunLease: acquireScheduledRunLease,
    releaseRunLease: releaseScheduledRunLease,
    directoryExists: existsSync,
    isProcessAlive,
    async createSession(cwd) {
      // A unique key: startRpcSession coalesces callers that share one.
      const { session } = await startRpcSession(`__scheduled__${randomUUID()}`, "", cwd, undefined, undefined);
      allowFileRoot(cwd);
      invalidateSessionListCache();
      return session;
    },
    async openSession(sessionId) {
      const live = getRpcSession(sessionId);
      if (live?.isAlive()) return live;
      const filePath = await resolveSessionPath(sessionId);
      if (!filePath) return null;
      const header = readSessionHeader(filePath);
      const { cwd } = resolveSpawnCwdResult(header?.cwd);
      return (await startRpcSession(sessionId, filePath, cwd, undefined, undefined, header?.cwd)).session;
    },
    formatSessionTime: (date) => {
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    },
    log: (message) => console.log(`[omp-web] ${message}`),
    delay: (ms) => sleep(ms),
  };
}

/** The process-wide runner (created on first use). */
export function getScheduledTaskRunner(): ScheduledTaskRunner {
  globalThis.__ompScheduledTaskRunner ??= createScheduledTaskRunner(defaultDeps());
  return globalThis.__ompScheduledTaskRunner;
}

/** Start the periodic tick (idempotent). The first tick runs immediately so a
 *  slot missed while omp-web was down catches up right after startup. */
export async function startScheduledTaskScheduler(): Promise<void> {
  if (!isSchedulerEnabled() || globalThis.__ompScheduledTaskTimer) return;
  const runner = getScheduledTaskRunner();
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runner.tick();
    } catch (error) {
      console.warn(`[omp-web] scheduled task tick failed: ${errorMessage(error)}`);
    } finally {
      ticking = false;
    }
  };
  // The timer goes in before any store access: the list reports an enabled
  // scheduler as running, so a store that cannot be read at boot must only
  // fail ticks until it is fixed, not leave this instance off for good.
  globalThis.__ompScheduledTaskTimer = setInterval(() => void tick(), TICK_MS);
  globalThis.__ompScheduledTaskTimer.unref?.();
  pruneScheduledSlotClaims(new Date());
  try {
    runner.reconcileRuns();
  } catch (error) {
    console.warn(`[omp-web] scheduled task run reconciliation failed: ${errorMessage(error)}`);
  }
  await tick();
}
