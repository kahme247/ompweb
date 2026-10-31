import { createHash, randomUUID } from "crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { emptyScheduledTaskStore, parseScheduledTaskStore, SCHEDULED_RUN_MAX_MS, type ParsedScheduledTaskStore, type ScheduledTaskStore } from "./scheduled-tasks";

// Scheduled tasks on disk: ~/.omp/agent/omp-web/scheduled-tasks.json, shared by
// every browser and by every omp-web instance on the agent dir (an installed
// service plus `npm run dev`). The file is replaced atomically (temp file +
// rename) and every read-modify-write runs under a cross-process lock, so two
// instances never lose each other's updates. A store that cannot be read or
// parsed fails loudly and is never overwritten; a write that would drop
// malformed entries first keeps the file as `scheduled-tasks.json.dropped-<ms>`.
//
// Coordination between instances uses owner files that hold the owner's pid,
// a token unique to that acquisition and when the hold ends, on the wall clock
// (read only by older builds) and on the system's monotonic clock. A file is
// reclaimed once its owner process is gone or its hold has ended on the
// monotonic clock, never sooner (a file from an older build has no monotonic
// end and is held while its pid lives). That clock is not stepped when the
// wall clock is set, so changing the time never frees a live owner's file;
// and a hold never outlasts the longest legitimate one, so a pid reused by an
// unrelated process (after a crash or a reboot) cannot keep a file forever:
// - the store lock (`scheduled-tasks.json.lock`), held for one update;
// - a run lease per task (`scheduled-task-leases/<task>`), held while a run of
//   that task is in flight, so runs of one task never overlap across instances;
// - a claim per schedule slot (`scheduled-task-claims/<task>@<slotMs>`, an
//   empty O_EXCL file), kept, so a slot fires in exactly one instance.

const LOCK_TIMEOUT_MS = 3_000;
const LOCK_RETRY_MS = 20;
/** Store lock and reclaim markers: held for one synchronous update. */
const LOCK_HOLD_MS = 60_000;

function ompWebDir(): string {
  return resolve(getAgentDir(), "omp-web");
}

function storePath(): string {
  return join(ompWebDir(), "scheduled-tasks.json");
}

function claimsDir(): string {
  return join(ompWebDir(), "scheduled-task-claims");
}

function leasePath(taskId: string): string {
  return join(ompWebDir(), "scheduled-task-leases", encodeURIComponent(taskId));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Milliseconds on the system's monotonic clock (libuv: CLOCK_MONOTONIC,
 * mach_absolute_time, QueryPerformanceCounter). Every process on the host
 * reads the same clock, which never goes back within a boot and is not
 * stepped when the wall clock is set. Timers run on it too, so a suspended
 * machine pauses a hold and its owner's deadlines (a run's turn cap) alike.
 */
function monotonicNow(): number {
  return Number(process.hrtime.bigint() / BigInt(1e6));
}

interface OwnerFile {
  /** null when the content is not an owner token (treated as a dead owner). */
  pid: number | null;
  /** When the hold ends on the monotonic clock; null in a file written by an
   *  older build, whose owner is then judged by its pid alone. */
  heldUntil: number | null;
  /** The whole token: unique per acquisition, so it identifies this file. */
  content: string;
}

/** The owner file at `path`, or undefined when there is none. */
function readOwner(path: string): OwnerFile | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const [pidField, , , heldField] = content.trim().split(/\s+/);
  const pid = Number(pidField);
  const heldUntil = heldField === undefined ? null : Number(heldField);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    // A hold that is present but not a number holds nothing.
    heldUntil: heldUntil === null || Number.isFinite(heldUntil) ? heldUntil : 0,
    content,
  };
}

/**
 * True while the owner's hold lasts. The monotonic clock never goes back
 * within a boot, so a hold taken in this boot ends at most `holdMs` from now;
 * one that ends later was taken before a reboot, and its owner is gone. A
 * file from an older build is held while its pid lives, unless that pid is
 * ours: this build never writes one, so an earlier process with our pid did.
 */
function holdActive(owner: OwnerFile, holdMs: number): boolean {
  if (owner.heldUntil === null) return owner.pid !== process.pid;
  const now = monotonicNow();
  return owner.heldUntil > now && owner.heldUntil - now <= holdMs;
}

/**
 * Create `path` holding "<pid> <token> <expiresAt> <heldUntil>" (the end of
 * the hold on the wall clock, then on the monotonic clock) in one step: the
 * content goes to a private temp file that is hard-linked into place (link
 * never replaces an existing file). The owner file therefore never exists
 * empty or half written, and a failed write leaves nothing at `path`.
 * Returns the content, or null when `path` already exists.
 */
function createOwnerFile(path: string, holdMs: number): string | null {
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  const content = `${process.pid} ${randomUUID()} ${Date.now() + holdMs} ${monotonicNow() + holdMs}\n`;
  try {
    writeFileSync(temp, content, { flag: "wx" });
    try {
      linkSync(temp, path);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // A leftover private temp file blocks nothing.
    }
  }
}

export interface OwnFileOptions {
  /** Longest the caller holds the file; after that it is reclaimed even
   *  while a process with the owner's pid exists. Default: one store update. */
  holdMs?: number;
  /** A file this process already owns counts as acquired (a run lease whose
   *  run record was lost). */
  reclaimOwn?: boolean;
  /** Test seam: runs after a stale owner was read, before it is reclaimed. */
  beforeReclaim?: () => void;
  /** Test seam: runs while the reclaim marker is held and the stale owner's
   *  token was read again, right before its file is removed. */
  beforeRemove?: () => void;
}

/**
 * Create `path` as this process's owner file and return its content, the
 * token that releases it. An existing file whose owner is dead or whose hold
 * ended is taken over. Returns null while a live owner holds it, or another
 * live process is removing it.
 */
export function tryOwnFile(path: string, options: OwnFileOptions = {}): string | null {
  const holdMs = options.holdMs ?? LOCK_HOLD_MS;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = createOwnerFile(path, holdMs);
    if (created !== null) return created;
    const owner = readOwner(path);
    if (owner === undefined) continue; // released in between
    if (holdActive(owner, holdMs)) {
      // Our own file is taken over afresh, so the new hold gets a full term.
      if (owner.pid === process.pid ? options.reclaimOwn !== true : owner.pid !== null && isProcessAlive(owner.pid)) return null;
    }
    options.beforeReclaim?.();
    if (!removeOwnerFile(path, owner.content, options.beforeRemove)) return null;
  }
  return null;
}

/**
 * Remove `path` only if it still holds `content`. Both a reclaimer taking
 * over a stale owner's file and an owner releasing its own go through here.
 *
 * Reading the token and removing the file cannot be one atomic step, so the
 * removal of each token is serialized instead: only the process that owns
 * `<path>.reclaim-<token hash>` may remove the file holding that token. A
 * token is unique to one acquisition, so while the marker is held nothing
 * else removes or replaces that file; a holder that finds a different token
 * (a newer owner took over) leaves it alone. Were an owner to release without
 * the marker, a reclaimer that had just read its token would delete the next
 * owner's file instead. The marker is itself an owner file, so one left by a
 * process that died is reclaimed the same way; it is held for a few file
 * operations, far less than its hold, so it is removed directly. Returns
 * false while another live process holds the marker (and so removes the file
 * itself).
 */
function removeOwnerFile(path: string, content: string, beforeRemove?: () => void): boolean {
  const marker = `${path}.reclaim-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  const markerContent = tryOwnFile(marker);
  if (markerContent === null) return false;
  try {
    if (readOwner(path)?.content === content) {
      beforeRemove?.();
      rmSync(path, { force: true });
    }
  } finally {
    try {
      if (readOwner(marker)?.content === markerContent) rmSync(marker, { force: true });
    } catch {
      // Unreadable: it is reclaimed once its hold ends.
    }
  }
  return true;
}

/** Remove this process's owner file `path`, holding `content`, unless it was
 *  taken over in the meantime. Never throws. */
function release(path: string, content: string): void {
  try {
    // On false, a live reclaimer holds the marker and removes the file itself.
    removeOwnerFile(path, content);
  } catch {
    // Unreadable, or no marker could be written: reclaimed once its hold ends.
  }
}

/** The file's text and parse; throws when it exists but cannot be read or parsed. */
function readScheduledTaskStore(): ParsedScheduledTaskStore & { text: string | null } {
  const path = storePath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store: emptyScheduledTaskStore(), dropped: 0, text: null };
    throw error;
  }
  try {
    return { ...parseScheduledTaskStore(text), text };
  } catch (error) {
    // Not a SyntaxError: routes map those to "invalid request body".
    throw new Error(`Cannot parse ${path}; fix or remove it: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Current store. Throws when the file exists but cannot be read or parsed. */
export function loadScheduledTaskStore(): ScheduledTaskStore {
  return readScheduledTaskStore().store;
}

/** Keep the file as it is before a write drops `dropped` malformed entries
 *  from it; throws (so nothing is written) when the copy fails. */
function backUpDroppedEntries(text: string, dropped: number): void {
  const backup = `${storePath()}.dropped-${Date.now()}`;
  writeFileSync(backup, text, { encoding: "utf8", flag: "wx" });
  console.warn(`[omp-web] ${storePath()}: ${dropped} malformed entr${dropped === 1 ? "y was" : "ies were"} dropped; the previous file is kept as ${backup}`);
}

function saveScheduledTaskStore(store: ScheduledTaskStore): void {
  const path = storePath();
  mkdirSync(ompWebDir(), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

/**
 * Apply `update` to the current store and persist the result, under the
 * cross-process store lock (re-read inside it). `update` may mutate the store
 * it receives; returning `false` skips the write.
 */
export function updateScheduledTaskStore<T>(update: (store: ScheduledTaskStore) => T | false): T | false {
  const lockPath = `${storePath()}.lock`;
  const deadline = monotonicNow() + LOCK_TIMEOUT_MS;
  let lock = tryOwnFile(lockPath);
  while (lock === null) {
    if (monotonicNow() >= deadline) throw new Error(`Timed out waiting for ${lockPath} (another omp-web process holds it)`);
    sleepSync(LOCK_RETRY_MS);
    lock = tryOwnFile(lockPath);
  }
  try {
    const { store, dropped, text } = readScheduledTaskStore();
    const result = update(store);
    if (result !== false) {
      if (dropped > 0 && text !== null) backUpDroppedEntries(text, dropped);
      saveScheduledTaskStore(store);
    }
    return result;
  } finally {
    release(lockPath, lock);
  }
}

/** Take the task's run lease and return its token, which releases it; null
 *  while another live process runs the task. A lease left by this process
 *  (its run record was lost) is taken over. */
export function acquireScheduledRunLease(taskId: string): string | null {
  return tryOwnFile(leasePath(taskId), { holdMs: SCHEDULED_RUN_MAX_MS, reclaimOwn: true });
}

/** Give back the lease `acquireScheduledRunLease` returned; one another
 *  instance took over once its hold ended is left alone. */
export function releaseScheduledRunLease(taskId: string, lease: string): void {
  release(leasePath(taskId), lease);
}

function slotClaimPath(taskId: string, slot: Date): string {
  return join(claimsDir(), `${encodeURIComponent(taskId)}@${slot.getTime()}`);
}

/** True when this process is the first to claim the slot. */
export function claimScheduledSlot(taskId: string, slot: Date): boolean {
  mkdirSync(claimsDir(), { recursive: true });
  try {
    closeSync(openSync(slotClaimPath(taskId, slot), "wx"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Give back a slot claim (only one this process made); a missing claim is fine. */
export function releaseScheduledSlot(taskId: string, slot: Date): void {
  rmSync(slotClaimPath(taskId, slot), { force: true });
}

/** Remove claim files older than `maxAgeMs`; best effort. */
export function pruneScheduledSlotClaims(now: Date, maxAgeMs = 30 * 24 * 60 * 60_000): void {
  try {
    for (const name of readdirSync(claimsDir())) {
      const path = join(claimsDir(), name);
      if (now.getTime() - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
    }
  } catch {
    // A missing directory or a racing prune by another instance is harmless.
  }
}
