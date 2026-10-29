import { closeSync, openSync, readSync, statSync } from "fs";
import { looksLikeRunningTurn } from "./chat-transcript-plan";
import { listOmpProcesses, matchSessionOwner, sessionIdsNamedByProcesses, type OmpProcessInfo } from "./omp-processes";
import { readForeignRunningLists, type ForeignRunningList } from "./session-resume";
import { parseJsonlLenient } from "./omp/session-files";
import { resolveSessionPath } from "./session-reader";
import { isRecord } from "./type-guards";
import type { AgentMessage, ElsewhereSessionInfo, SessionElsewhere } from "./types";

export type { ElsewhereSessionInfo, SessionElsewhere };

/**
 * Who owns a session right now — this instance, another omp-web instance, or a
 * terminal `omp`?
 *
 * omp ≥ 18.5 lets exactly one process write a session: its lease lives in a
 * named mutex / abstract socket (no file to read). A second writer does not
 * fail, it silently moves the conversation to a fresh sibling file on its first
 * write ("open-elsewhere"), which looked like a brand-new chat. omp-web only
 * knew about its own children, so a session driven from a terminal, another
 * omp-web instance or the installed server looked idle.
 *
 * Three portable signals, strongest first (see `detectSessionOwner`):
 *  1. another live omp-web instance lists the session as mid-run,
 *  2. a live `omp` process was started with `--resume <this session>`,
 *  3. the transcript has no trailing `session_exit` and was written recently.
 *
 * Everything here is read-only and failure-tolerant: an unreadable session, a
 * failing process scan or a timeout must never block a send.
 */

/**
 * Mirror of `EXTERNAL_RUN_STALE_MS` (hooks/useAgentSession-stream.ts): a tail
 * that stopped growing for this long is not a live foreign run any more. The
 * hook constant cannot be imported here — that module is browser-side.
 */
export const ELSEWHERE_ACTIVE_WINDOW_MS = 60_000;

/** While a session is known to be elsewhere, re-check it at this cadence so a
 *  finished terminal `omp` clears the badge without a file write. */
export const ELSEWHERE_REFRESH_MS = 10_000;

const TAIL_BYTES = 64 * 1024;
/** Guard against a huge session tree: the transcript signal only needs a file
 *  written inside the activity window, so only this many *recent* candidates
 *  are tail-read per refresh. Sessions with a live owner (process scan) or a
 *  known/cached one are never cut off by this cap. */
const MAX_RECENT_CANDIDATES = 80;

export interface SessionTailState {
  /** The last record is omp's own `session_exit` (the writer closed the file). */
  hasTrailingExit: boolean;
  /** The tail looks mid-turn (tool call without result, or a running tool). */
  looksActive: boolean;
  mtimeMs: number;
}

/** True for the records omp writes while a tool call is executing. */
const LIVE_TOOL_RECORDS: Record<string, true> = {
  tool_execution_start: true,
  tool_execution_update: true,
};

function recordType(record: unknown): string | undefined {
  return isRecord(record) && typeof record.type === "string" ? record.type : undefined;
}

/**
 * Read the last ≤64 KiB of a session file and describe its end. Backward-safe
 * against a half-written last line (parsed leniently, skipped) and against the
 * window starting mid-line (first partial line dropped). Returns null when the
 * file cannot be read.
 */
export function readSessionTailState(filePath: string): SessionTailState | null {
  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    size = stat.size;
    // Integer epoch ms, as documented (docs/android/protocol.md §3.7): mtimeMs
    // is fractional on Windows, and a typed client that decodes `Long` (the
    // Android app) rejects the whole frame on 1793099856021.7422.
    mtimeMs = Math.round(stat.mtimeMs);
  } catch {
    return null;
  }
  if (size === 0) return { hasTrailingExit: false, looksActive: false, mtimeMs };

  const length = Math.min(TAIL_BYTES, size);
  let text: string;
  try {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (length < size) {
    // The window starts mid-record; drop that truncated first line.
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }

  const records = parseJsonlLenient<Record<string, unknown>>(text);
  const tail = records.at(-1);
  const tailType = recordType(tail);
  const hasTrailingExit = tailType === "custom" && tail?.customType === "session_exit";

  let looksActive: boolean;
  if (hasTrailingExit) {
    looksActive = false;
  } else if (tailType === "custom" && typeof tail?.customType === "string" && LIVE_TOOL_RECORDS[tail.customType] === true) {
    // A tool is executing right now; the agent has not settled yet.
    looksActive = true;
  } else {
    // Judge by the last message in the window: a trailing tool result or an
    // assistant tool call means the turn continues.
    const messages: AgentMessage[] = [];
    for (const record of records) {
      if (recordType(record) !== "message") continue;
      const message: unknown = record.message;
      if (isRecord(message) && typeof message.role === "string") {
        // Parsed JSONL entry: the record shape is omp's, validated just enough
        // for `looksLikeRunningTurn` (role + content + stopReason).
        messages.push(message as unknown as AgentMessage);
      }
    }
    looksActive = messages.length > 0 && looksLikeRunningTurn(messages);
  }

  return { hasTrailingExit, looksActive, mtimeMs };
}

export interface DetectOwnerOptions {
  /** Sessions this process owns (live wrapper) — never elsewhere. */
  isLocal?: (sessionId: string) => boolean;
  /** Our own child for this session crashed here: a missing `session_exit`
   *  plus a recent write is explained locally, so the weakest signal (a
   *  transcript-only guess) is not a foreign owner. */
  ownCrashed?: (sessionId: string) => boolean;
  /** Pids that must not count as the owner (our own child's stale cmdline). */
  excludePids?: number[];
  /** Injected scan results (tests, or one shared scan for a whole session list). */
  processes?: OmpProcessInfo[];
  foreignLists?: ForeignRunningList[];
  /**
   * Pre-read tail. `undefined` (default) reads the file; `null` means "no tail
   * available" — a file that stopped growing longer ago than the activity
   * window cannot be a live transcript signal, but a live owning process must
   * still be reported (the list refresh passes null for old sessions instead
   * of reading 64 KiB per old chat).
   */
  tail?: SessionTailState | null;
  now?: () => number;
}

/**
 * Decide whether someone else holds this session. The caller must have ruled
 * out its own live wrapper (`isLocal`) — this function's job is the foreign
 * side only. Every failure degrades to `null` (do not block).
 */
export async function detectSessionOwner(
  sessionId: string,
  sessionFile: string | null | undefined,
  options: DetectOwnerOptions = {},
): Promise<SessionElsewhere | null> {
  if (options.isLocal?.(sessionId)) return null;
  try {
    const now = options.now?.() ?? Date.now();
    const tail = options.tail !== undefined
      ? options.tail
      : (sessionFile ? readSessionTailState(sessionFile) : null);

    const lists = options.foreignLists ?? readForeignRunningLists();
    const listOwner = lists.find((list) => list.ids.includes(sessionId));
    if (listOwner) {
      // Another omp-web is mid-run on it; that outranks any tail heuristic.
      return {
        kind: "omp-web",
        source: "instance-list",
        running: true,
        active: true,
        ...(tail ? { lastActivityAt: tail.mtimeMs } : {}),
      };
    }

    const processes = options.processes ?? (await listOmpProcesses()).processes;
    const owner = matchSessionOwner(processes, { sessionId, sessionFile: sessionFile ?? undefined, excludePids: options.excludePids });
    if (owner) {
      return {
        kind: "terminal",
        source: "process",
        // A live owning process keeps ownership even while it is idle between
        // turns; `running` only says "mid-turn right now".
        running: tail?.looksActive === true,
        active: true,
        ...(tail ? { lastActivityAt: tail.mtimeMs } : {}),
      };
    }

    if (!tail || tail.hasTrailingExit) return null;
    if (options.ownCrashed?.(sessionId)) return null;
    if (now - tail.mtimeMs >= ELSEWHERE_ACTIVE_WINDOW_MS) return null;
    return {
      kind: "terminal",
      source: "transcript",
      running: tail.looksActive,
      active: true,
      lastActivityAt: tail.mtimeMs,
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Snapshot for the sidebar and the SSE `running` frames
//
// `notifyRunningChange` is synchronous and called from the hot path of omp's
// event loop, so it cannot await a process scan. This cache is refreshed by the
// session-list route, the SSE file watcher and a small self-scheduling tick
// while anything is elsewhere; readers only filter by time.
// ----------------------------------------------------------------------------

interface CachedElsewhere {
  id: string;
  sessionFile: string;
  state: SessionElsewhere;
}

interface ElsewhereState {
  entries: Map<string, CachedElsewhere>;
  notifier: (() => void) | null;
  timer: NodeJS.Timeout | undefined;
  /** One refresh in flight at a time; later callers share its result. */
  refreshing: Promise<ElsewhereSessionInfo[]> | null;
  /** Candidates that arrived while `refreshing` was in flight; the pass that
   *  follows it re-detects them. Without this queue a file watcher event that
   *  landed mid-scan was dropped, and the broadcast carried a map that
   *  predated the file it was about. */
  pending: Map<string, ElsewhereCandidate>;
  /** Options of the callers that queued into `pending` (merged). */
  pendingOptions: RefreshElsewhereOptions | null;
  /** Registered by `rpc-manager`; see `ElsewhereOwnershipContext`. */
  ownershipContext: ElsewhereOwnershipContext | null;
}

declare global {
  var __ompElsewhereState: ElsewhereState | undefined;
}

function elsewhereState(): ElsewhereState {
  const state = globalThis.__ompElsewhereState ??= {
    entries: new Map(),
    notifier: null,
    timer: undefined,
    refreshing: null,
    pending: new Map(),
    pendingOptions: null,
    ownershipContext: null,
  };
  // Next.js compiles every route as its own server bundle, so this module is
  // evaluated once per bundle in one process. Everything the tick needs must
  // live on `globalThis` (as it survives hot-reload too); a module-local `let`
  // is invisible to the other bundles and the registration silently misses.
  // A state object created by an older module version lacks fields added
  // later, so fill them in.
  state.pending ??= new Map();
  state.pendingOptions ??= null;
  state.ownershipContext ??= null;
  return state;
}

/** Sessions an entry may still describe; a transcript-only signal goes stale
 *  with its last write, ownership signals are cleared by the next refresh. */
function isStale(entry: CachedElsewhere, now: number): boolean {
  return entry.state.source === "transcript"
    && entry.state.lastActivityAt !== undefined
    && now - entry.state.lastActivityAt >= ELSEWHERE_ACTIVE_WINDOW_MS;
}

/** Drop expired entries and return what is left. Never scans by itself. */
export function getElsewhereSessions(now = Date.now()): ElsewhereSessionInfo[] {
  const state = elsewhereState();
  const out: ElsewhereSessionInfo[] = [];
  for (const [id, entry] of state.entries) {
    if (isStale(entry, now)) {
      state.entries.delete(id);
      continue;
    }
    out.push({ id, ...entry.state });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ElsewhereCandidate {
  id: string;
  sessionFile?: string;
  mtimeMs?: number;
}

export interface RefreshElsewhereOptions {
  isLocal?: (sessionId: string) => boolean;
  ownCrashed?: (sessionId: string) => boolean;
  /** Pids that must never count as an owner (our own omp children). */
  excludePids?: number[];
  now?: () => number;
}

/**
 * This instance's own-liveness checks. The routes pass them per call; the
 * self-tick has no caller to take them from, and without them it re-detected a
 * chat this instance had itself taken over (its own child still names the
 * original file on `--resume`) as a foreign owner — forever, while the child
 * lived. Registered from `rpc-manager` (which owns the registry and the child
 * pids) exactly like `setElsewhereChangeNotifier`, so there is no import cycle.
 */
export interface ElsewhereOwnershipContext {
  isLocal?: (sessionId: string) => boolean;
  ownCrashed?: (sessionId: string) => boolean;
  /** Read on every refresh: our children change while the tick waits. */
  excludePids?: () => number[];
}

/** Register (or clear) the ownership context every refresh falls back to. */
export function setElsewhereOwnershipContext(context: ElsewhereOwnershipContext | null): void {
  // On the shared state, never in a module-local binding: the caller
  // (`rpc-manager`) and the tick (`refreshElsewhereSessions` below) commonly
  // live in different Next server bundles, i.e. in different evaluations of
  // this module in the same process.
  elsewhereState().ownershipContext = context;
}

/** Merge the options of two callers queued into the same follow-up pass: the
 *  first explicit value per field wins, so a queuing caller's own hooks are
 *  never replaced by a later caller that passed none. */
function mergeRefreshOptions(
  current: RefreshElsewhereOptions | null,
  next: RefreshElsewhereOptions,
): RefreshElsewhereOptions {
  if (!current) return next;
  return {
    isLocal: current.isLocal ?? next.isLocal,
    ownCrashed: current.ownCrashed ?? next.ownCrashed,
    excludePids: current.excludePids ?? next.excludePids,
    now: current.now ?? next.now,
  };
}

/**
 * Re-detect ownership for the given sessions (plus everything already cached)
 * and replace the snapshot. Sessions known to be locally owned are dropped.
 */
export function refreshElsewhereSessions(
  candidates: ElsewhereCandidate[],
  options: RefreshElsewhereOptions = {},
): Promise<ElsewhereSessionInfo[]> {
  const state = elsewhereState();
  if (state.refreshing) {
    // The active pass snapshotted its own candidates, so these ids cannot make
    // it. Queue them for the pass that follows instead of dropping them: the
    // caller broadcasts the returned snapshot, and an answer that predates its
    // own files would show the wrong owners until the next event.
    for (const candidate of candidates) {
      const previous = state.pending.get(candidate.id);
      state.pending.set(candidate.id, {
        id: candidate.id,
        // Keep the newest knowledge per field: a later event without a path
        // must not erase the file an earlier one resolved.
        sessionFile: candidate.sessionFile ?? previous?.sessionFile,
        mtimeMs: candidate.mtimeMs ?? previous?.mtimeMs,
      });
    }
    state.pendingOptions = mergeRefreshOptions(state.pendingOptions, options);
    return state.refreshing.then(() => {
      const pending = [...state.pending.values()];
      if (pending.length === 0) return getElsewhereSessions();
      const pendingOptions = state.pendingOptions ?? {};
      state.pending.clear();
      state.pendingOptions = null;
      return refreshElsewhereSessions(pending, pendingOptions);
    });
  }
  state.refreshing = (async () => {
    const now = options.now?.() ?? Date.now();
    // Per-call values win; the registered context covers callers without any
    // (the self-tick). Read from the shared state, not a module-local binding:
    // the tick can run in a different server bundle than the registration.
    const context = state.ownershipContext;
    const isLocal = options.isLocal ?? context?.isLocal;
    const ownCrashed = options.ownCrashed ?? context?.ownCrashed;
    const excludePids = options.excludePids ?? context?.excludePids?.();
    const byId = new Map<string, ElsewhereCandidate>();
    // The tail is only read for files written inside the activity window —
    // that is the only signal a silent old file could contribute.
    const stale = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.sessionFile) continue;
      if (candidate.mtimeMs !== undefined && Number.isFinite(candidate.mtimeMs) && now - candidate.mtimeMs >= ELSEWHERE_ACTIVE_WINDOW_MS) {
        stale.add(candidate.id);
      }
      byId.set(candidate.id, candidate);
    }
    for (const entry of state.entries.values()) {
      if (!byId.has(entry.id)) byId.set(entry.id, { id: entry.id, sessionFile: entry.sessionFile });
    }
    if (byId.size === 0) {
      state.entries.clear();
      return [];
    }
    // One shared scan for the whole list: the scan itself is TTL-cached and
    // single-flight, and the foreign instance lists are one directory read.
    const scan = await listOmpProcesses();
    const foreignLists = readForeignRunningLists();
    // The scan decides which sessions need a closer look: it names the files a
    // live foreign `omp` opened, so an idle owner outside the recent window is
    // found by its own command line. Instance-list ids come from the same
    // "someone else says it runs" source.
    const ownerIds = sessionIdsNamedByProcesses(scan.processes, byId.values());
    for (const list of foreignLists) {
      for (const id of list.ids) if (byId.has(id)) ownerIds.add(id);
    }
    const queue: ElsewhereCandidate[] = [];
    const queued = new Set<string>();
    const enqueue = (candidate: ElsewhereCandidate) => {
      if (queued.has(candidate.id)) return;
      queued.add(candidate.id);
      queue.push(candidate);
    };
    // Known owners first: an idle `omp --resume` between turns has no recent
    // write, and a cached entry must never be starved by a burst of new files.
    for (const entry of state.entries.values()) enqueue({ id: entry.id, sessionFile: entry.sessionFile });
    for (const id of ownerIds) enqueue(byId.get(id) ?? { id });
    // Everything else can only contribute the transcript signal, so a recent
    // write is what makes it a candidate — and only that tier is capped.
    let recent = 0;
    for (const candidate of byId.values()) {
      if (queued.has(candidate.id) || stale.has(candidate.id)) continue;
      if (recent >= MAX_RECENT_CANDIDATES) break;
      recent += 1;
      enqueue(candidate);
    }
    for (const candidate of queue) {
      if (isLocal?.(candidate.id)) {
        state.entries.delete(candidate.id);
        continue;
      }
      const detected = await detectSessionOwner(candidate.id, candidate.sessionFile, {
        isLocal,
        ownCrashed,
        excludePids,
        processes: scan.processes,
        foreignLists,
        // An owner-derived candidate with an old file is not read; its owner
        // signal is enough.
        tail: stale.has(candidate.id) ? null : undefined,
        now: options.now,
      });
      if (detected) {
        state.entries.set(candidate.id, { id: candidate.id, sessionFile: candidate.sessionFile ?? "", state: detected });
        continue;
      }
      // A failed scan is not evidence of absence: keep a known process owner
      // (and an instance-list one) until a scan actually answers again, or one
      // timeout would erase a live owner for good. A transcript entry still
      // ages out with its window.
      const previous = state.entries.get(candidate.id);
      if (!scan.ok && previous && previous.state.source !== "transcript") continue;
      state.entries.delete(candidate.id);
    }
    return getElsewhereSessions(now);
  })().finally(() => {
    state.refreshing = null;
    scheduleElsewhereTick();
  });
  return state.refreshing;
}

/** Re-detect ownership for session ids whose files just changed. */
export async function refreshElsewhereForSessionIds(
  sessionIds: string[],
  options: RefreshElsewhereOptions = {},
): Promise<ElsewhereSessionInfo[]> {
  const candidates: ElsewhereCandidate[] = [];
  for (const id of sessionIds) {
    const sessionFile = await resolveSessionPath(id).catch(() => null);
    if (sessionFile) candidates.push({ id, sessionFile });
  }
  if (candidates.length === 0) return getElsewhereSessions();
  return refreshElsewhereSessions(candidates, options);
}

/**
 * Register the broadcaster that must run when the snapshot changes on its own
 * (an entry expiring, or a terminal `omp` exiting). rpc-manager registers
 * `notifyRunningChange` on every broadcast, so the two modules stay free of an
 * import cycle.
 */
export function setElsewhereChangeNotifier(notify: () => void): void {
  elsewhereState().notifier = notify;
}

function scheduleElsewhereTick(): void {
  const state = elsewhereState();
  clearTimeout(state.timer);
  state.timer = undefined;
  if (state.entries.size === 0) return;
  let at = Date.now() + ELSEWHERE_REFRESH_MS;
  for (const entry of state.entries.values()) {
    if (entry.state.source !== "transcript" || entry.state.lastActivityAt === undefined) continue;
    at = Math.min(at, entry.state.lastActivityAt + ELSEWHERE_ACTIVE_WINDOW_MS);
  }
  const timer = setTimeout(() => {
    state.timer = undefined;
    // Re-check ownership, then broadcast whatever changed: a process that
    // exited or a transcript that stopped growing disappears from the badge.
    void refreshElsewhereSessions([...state.entries.values()].map((entry) => ({
      id: entry.id,
      sessionFile: entry.sessionFile,
    }))).then(() => {
      state.notifier?.();
    }).catch(() => {
      // A failed re-check (a throwing ownership callback, a scan that rejects
      // outside its soft-failure path) must not become an unhandled rejection:
      // Node ends the process on those. The previous snapshot stays, and the
      // tick armed in `finally` retries it.
    });
  }, Math.max(0, at - Date.now()));
  timer.unref?.();
  state.timer = timer;
}

/** Reset the snapshot (tests). */
export function resetElsewhereSessions(): void {
  const state = elsewhereState();
  state.entries.clear();
  clearTimeout(state.timer);
  state.timer = undefined;
  state.refreshing = null;
  state.pending.clear();
  state.pendingOptions = null;
}
