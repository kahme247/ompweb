import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { uptime } from "os";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { isValidSessionId } from "./session-file-references-core";
import { isRecord } from "./type-guards";
import { loadWebServerSettings } from "./web-settings";

/** Sent to each session that was mid-run when omp-web stopped. */
export const RESUME_PROMPT = "Session interrupted and resumed. Continue as you would have done without the interruption.";

/** How long a session whose omp process died stays recorded. A stop signal
 *  reaches every process in the service at once, so a child can die just
 *  before omp-web's own shutdown handler runs; a crash while omp-web keeps
 *  running is dropped after this window instead of resumed on the next start. */
export const EXIT_GRACE_MS = 2_000;

export interface InterruptibleSession {
  id: string;
  /** The child's spawn-time --advisor flag, restored on resume. */
  advisor: boolean;
}

interface TrackerState {
  /** The lists previous runs left behind, claimed before this run writes. */
  leftover: InterruptibleSession[];
  sessions: Map<string, InterruptibleSession>;
  drops: Map<string, NodeJS.Timeout>;
  shuttingDown: boolean;
}

declare global {
  var __ompResumeTracker: TrackerState | undefined;
}

// On globalThis so it survives Next.js hot-reload and is shared by every
// bundle that imports this module. Created on first use, which claims the
// previous runs' lists before anything in this run can overwrite them.
function tracker(): TrackerState {
  globalThis.__ompResumeTracker ??= { leftover: readLeftover(), sessions: new Map(), drops: new Map(), shuttingDown: false };
  return globalThis.__ompResumeTracker;
}

// Each omp-web instance keeps its own list, named by pid, so two instances
// sharing an agent dir never overwrite or resume each other's running sessions.
// The unsuffixed name is the list written before per-instance lists existed.
const LIST_NAME = /^omp-web-interrupted-sessions(?:-(\d+))?\.json$/;

/** True when the list at `path`, written by `pid`, belongs to a running omp-web. */
// ponytail: pid liveness only; same-boot pid reuse (or an unreaped zombie
// writer) leaves that list unresumed, and hosts sharing an agent dir are not detected.
function ownedByLiveInstance(path: string, pid: number): boolean {
  if (pid === process.pid) return false;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Vanished or unreadable: the owner may be rewriting it, so leave it alone.
    return true;
  }
  // A list from before this boot is stale even if its pid is in use again.
  if (mtimeMs < Date.now() - uptime() * 1000) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLeftover(): InterruptibleSession[] {
  const dir = getAgentDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions = new Map<string, InterruptibleSession>();
  for (const name of names) {
    const match = LIST_NAME.exec(name);
    if (!match) continue;
    const path = resolve(dir, name);
    if (match[1] && ownedByLiveInstance(path, Number(match[1]))) continue;
    // Rename claims the list atomically: of two instances starting together,
    // only one gets it.
    const claimed = `${path}.claimed-${process.pid}`;
    try {
      renameSync(path, claimed);
    } catch {
      continue;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(claimed, "utf8"));
      const list = isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions : [];
      for (const entry of list) {
        if (isRecord(entry) && typeof entry.id === "string" && isValidSessionId(entry.id)) {
          sessions.set(entry.id, { id: entry.id, advisor: entry.advisor === true });
        }
      }
    } catch {
      // A corrupt list resumes nothing.
    }
    rmSync(claimed, { force: true });
  }
  return [...sessions.values()];
}

function interruptedPath(): string {
  return resolve(getAgentDir(), `omp-web-interrupted-sessions-${process.pid}.json`);
}

export interface ForeignRunningList {
  /** The other omp-web instance that wrote the list. */
  pid: number;
  ids: string[];
}

/**
 * The per-instance running lists of OTHER live omp-web instances sharing this
 * agent dir. Read-only: the caller must never rename or claim these — that is
 * `readLeftover()`'s job for its own start, and claiming one here would drop
 * another instance's resume list. A session listed here is being run by that
 * instance right now.
 */
export function readForeignRunningLists(): ForeignRunningList[] {
  const dir = getAgentDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const lists: ForeignRunningList[] = [];
  for (const name of names) {
    const match = LIST_NAME.exec(name);
    // The unsuffixed list predates per-instance lists and has no owner pid.
    if (!match?.[1]) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const path = resolve(dir, name);
    if (!ownedByLiveInstance(path, pid)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      const entries = isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions : [];
      const ids: string[] = [];
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.id === "string" && isValidSessionId(entry.id)) ids.push(entry.id);
      }
      if (ids.length > 0) lists.push({ pid, ids });
    } catch {
      // Unreadable mid-write: the next refresh sees the finished file.
    }
  }
  return lists;
}

function writeInterrupted(sessions: InterruptibleSession[]): void {
  const path = interruptedPath();
  try {
    if (sessions.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(resolve(path, ".."), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch (error) {
    console.warn(`[omp-web] could not record running sessions for resume: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Keep the on-disk list of running sessions current. A session leaves the list
 * when its run ends normally (its process is still alive), or EXIT_GRACE_MS
 * after its process died unless omp-web is shutting down by then.
 */
export function recordRunningSessions(running: InterruptibleSession[], isAlive: (id: string) => boolean): void {
  const state = tracker();
  if (state.shuttingDown) return;
  if (!loadWebServerSettings().autoResumeSessions) {
    if (state.sessions.size > 0 || state.drops.size > 0) {
      for (const timer of state.drops.values()) clearTimeout(timer);
      state.drops.clear();
      state.sessions.clear();
      writeInterrupted([]);
    }
    return;
  }
  let changed = false;
  const runningIds = new Set<string>();
  for (const session of running) {
    runningIds.add(session.id);
    const drop = state.drops.get(session.id);
    if (drop) {
      clearTimeout(drop);
      state.drops.delete(session.id);
    }
    const previous = state.sessions.get(session.id);
    if (previous?.advisor !== session.advisor) {
      state.sessions.set(session.id, session);
      changed = true;
    }
  }
  for (const id of state.sessions.keys()) {
    if (runningIds.has(id)) continue;
    if (isAlive(id)) {
      state.sessions.delete(id);
      changed = true;
    } else if (!state.drops.has(id)) {
      const timer = setTimeout(() => {
        state.drops.delete(id);
        if (state.shuttingDown || !state.sessions.delete(id)) return;
        writeInterrupted([...state.sessions.values()]);
      }, EXIT_GRACE_MS);
      timer.unref?.();
      state.drops.set(id, timer);
    }
  }
  if (changed) writeInterrupted([...state.sessions.values()]);
}

/** Freeze the list: from here on, dying children are shutdown, not run ends. */
export function markShuttingDown(): void {
  tracker().shuttingDown = true;
}

/**
 * Hand out the list left by the previous run, once. Returns nothing when the
 * setting is off, so a stale list never resumes sessions later.
 */
export function takeInterruptedSessions(): InterruptibleSession[] {
  const state = tracker();
  const sessions = state.leftover;
  state.leftover = [];
  return loadWebServerSettings().autoResumeSessions ? sessions : [];
}
