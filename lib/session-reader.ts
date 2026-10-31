import { closeSync, existsSync, fstatSync, openSync, readSync, statSync, type Stats } from "fs";
import { normalize as normalizePath } from "path";
import { getAgentDir } from "./omp/paths";
import {
  containsBlobRef,
  invalidateAllSessionScanCaches,
  invalidateSessionFileListCache,
  invalidateSessionScanCache,
  listAllSessionInfos,
  loadSessionFile,
  MAX_SESSION_LOAD_BYTES,
  readSessionHeaderSync,
  resolveBlobRefsInEntries,
  type OmpSessionInfo,
  type ResolveBlobOptions,
} from "./omp/session-files";
import type {
  AgentMessage,
  CompactionEntry,
  CustomMessage,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionInfo,
} from "./types";
import { normalizeToolCalls } from "./normalize";
import { isRecord } from "./type-guards";
import { toolResultContentAsUrls } from "./media-cache";
import { taskResultRetryFailure, taskResultStructuredOutput, taskResultUsageCost } from "./task-result-details";
import type { TodoPhase } from "./pi-types";
import { projectIdentityKey, sessionPathKey } from "./paths";
import { resolveProject, type ProjectInfo } from "./worktree";
import { selectHistoryRange, type SessionHistoryCursor, type SessionHistoryPage } from "./session-sync";
import { PASSIVE_TOOL_CONTEXT } from "./chat-transcript-plan";

export { getAgentDir };

/**
 * `header.parentSession` has two forms in omp: a session FILE PATH (branch /
 * createBranchedSession, the RPC path omp-web drives) and a bare SESSION ID
 * (SessionManager.fork, reached from the TUI /fork, `omp --fork` and /tan).
 * Resolve the path form first, then fall back to an id match, so TUI-forked
 * sessions are not rendered as unrelated roots.
 */
function matchParentSessionId(
  parentSession: string,
  pathToId: Map<string, string>,
  knownIds: Set<string>,
): string | undefined {
  const byPath = pathToId.get(sessionPathKey(parentSession));
  if (byPath) return byPath;
  return knownIds.has(parentSession) ? parentSession : undefined;
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  const ompSessions: OmpSessionInfo[] = await listAllSessionInfos();
  const pathToId = new Map<string, string>();
  const knownIds = new Set<string>();
  for (const s of ompSessions) {
    pathToId.set(sessionPathKey(s.path), s.id);
    knownIds.add(s.id);
  }

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  // Bound concurrency so 100+ unique cwds don't spawn 100 parallel git processes.
  const uniqueCwds = [...new Set(ompSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  const CONCURRENCY = 6;
  for (let i = 0; i < uniqueCwds.length; i += CONCURRENCY) {
    const chunk = uniqueCwds.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (cwd) => {
      projectByCwd.set(cwd, await resolveProject(cwd));
    }));
  }

  return ompSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      // omp renamed the display field to `title`; the internal shape keeps `name`.
      name: s.title,
      created: s.created instanceof Date && !Number.isNaN(s.created.getTime())
        ? s.created.toISOString()
        : s.modified.toISOString(),
      modified: s.modified.toISOString(),
      ...(s.lastMessageAt ? { lastMessageAt: s.lastMessageAt.toISOString() } : {}),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath
        ? matchParentSessionId(s.parentSessionPath, pathToId, knownIds)
        : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      projectKey: projectIdentityKey(project?.projectRoot ?? s.cwd),
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  // Flipped once the watchdog below retires this scan: a hung load that
  // resolves after the slot moved on must not overwrite fresher cache data.
  let retired = false;
  const loadPromise = loadAllSessions().then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((globalThis.__piSessionListGeneration ?? 0) === generation && !retired) {
      globalThis.__piSessionListCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });
  // A load that never settles (a stuck sync syscall, a hung git spawn that
  // slipped past its timeout) must not be handed to every future caller
  // forever — the coalescing slot would pin the wedge until process restart.
  // Drop the slot after a generous deadline; the cache stays unset, so the
  // next request starts a fresh scan.
  const watchdog = setTimeout(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
      retired = true;
    }
  }, SESSION_LIST_LOAD_DEADLINE_MS);
  watchdog.unref?.();

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  watchdog.unref?.();

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;
/** Beyond this, an unsettled in-flight list load stops being coalesced. */
const SESSION_LIST_LOAD_DEADLINE_MS = 60_000;

/** Invalidate the session LIST metadata (30s TTL result + generation gate)
 * and the directory-walk cache, but leave per-session parse caches intact.
 * Use this when a session changed but you know which one: call
 * invalidateSessionEntriesCache(path) for the specific file instead of paying
 * for a full parse-cache flush. */
export function invalidateSessionListMeta(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
  // The session-file walk cache keys on the sessions-root mtime, which does
  // not change when a file is added inside an existing project subdirectory
  // (Windows/NTFS). Clear it too so new sessions appear immediately.
  invalidateSessionFileListCache();
}

export function invalidateSessionListCache(): void {
  invalidateSessionListMeta();
  // Drop cached entry parses so a mutation preserving size+mtime (rare) can
  // never serve stale entries; the (size, mtimeMs) key already invalidates
  // the common case, this closes the remaining window.
  globalThis.__ompSessionEntriesCache?.clear();
  globalThis.__ompSessionHistoryIndexes?.clear();
  // Unknown-source changes (full-flush fallback) have no known path to target
  // with invalidateSessionEntriesCache: clear every per-file SCAN memo too, or
  // an unknown same-size + same-mtime rewrite would keep serving the OLD list
  // summary (stale title/parent) from __ompSessionScanCache.
  invalidateAllSessionScanCaches();
}

/** Invalidate session-list metadata plus ONLY the given file's parse caches
 * when the path is known; without a path, fall back to the full flush (list
 * + every session's parse caches). This is the shared entry point for code
 * that edits a session and knows which file it touched — a busy session must
 * not force unrelated open sessions to re-parse their transcripts. */
export function invalidateSessionCaches(filePath?: string): void {
  if (filePath) {
    invalidateSessionListMeta();
    invalidateSessionEntriesCache(filePath);
  } else {
    invalidateSessionListCache();
  }
}

/** Invalidate ONLY the per-session caches for one session file (full-entry
 * parse + list scan window). Callers that know exactly which session changed
 * (live RPC events carrying the session file path, the file watcher with a
 * concrete filename) use this instead of invalidateSessionListCache() so
 * unrelated sessions keep their parsed-entry cache — a single busy session no
 * longer forces every other open session to re-parse multi-MB transcripts.
 * The key is normalized with sessionPathKey so Windows case/spacing variants
 * still hit the same entry. */
export function invalidateSessionEntriesCache(filePath: string): void {
  globalThis.__ompSessionEntriesCache?.delete(sessionPathKey(filePath));
  for (const [key, index] of globalThis.__ompSessionHistoryIndexes ?? []) {
    if (index.pathKey === sessionPathKey(filePath)) globalThis.__ompSessionHistoryIndexes?.delete(key);
  }
  invalidateSessionScanCache(filePath);
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) {
    if (existsSync(cached)) return cached;
    // A deleted session must never resolve: callers spawn omp with --resume
    // against the path, and omp silently creates a NEW session when the file
    // is gone. Drop the dead entry directly; the list cache stays valid, so
    // repeated 404 polls for the same id do not force a full rescan each time.
    // (listAllSessions would drop it anyway on the next real list mutation.)
    invalidateSessionPathCache(sessionId);
  }

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  const resolved = getPathCache().get(sessionId);
  if (!resolved) return null;
  if (!existsSync(resolved)) {
    invalidateSessionPathCache(sessionId);
    return null;
  }
  return resolved;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

/**
 * Resolve a `header.parentSession` value (either a session file path or a bare
 * session id — see matchParentSessionId) to the parent's session id.
 */
export async function resolveParentSessionId(parentSession: string): Promise<string | undefined> {
  if (!parentSession) return undefined;
  const byPath = await resolveSessionIdByPath(parentSession);
  if (byPath) return byPath;
  // Id form: only accept it when a session file with that id still exists.
  return (await resolveSessionPath(parentSession)) ? parentSession : undefined;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

/** Bounded, title-slot-aware header read (never loads message bodies). */
export function readSessionHeader(filePath: string): SessionHeader | null {
  return readSessionHeaderSync(filePath);
}

/** Full-file entry parse memoized on (path, size, mtimeMs). Read-only scans
 * (subagent history, file-reference checks, thinking routes) re-parse MB-scale
 * session files on every 15s reconcile poll and again at run end; the memo
 * turns each UNCHANGED file's parse into a single stat — the same convention
 * as scanSessionInfoCached. Stored on globalThis for hot-reload safety and
 * LRU-bounded. Entries are SHARED across cache hits: callers must treat them
 * as immutable (all current callers only read). */
interface SessionEntriesCacheEntry {
  size: number;
  mtimeMs: number;
  entries: SessionEntry[];
}

declare global {
  var __ompSessionEntriesCache: Map<string, SessionEntriesCacheEntry> | undefined;
}

const MAX_SESSION_ENTRIES_CACHE_ENTRIES = 32;
/** Byte cap on CACHED FILE SIZES (parsed JS expands several-fold). Without it,
 *  32 cached near-1GiB transcripts could pin tens of GB of heap. */
const MAX_SESSION_ENTRIES_CACHE_BYTES = 256 * 1024 * 1024;

function getSessionEntriesCache(): Map<string, SessionEntriesCacheEntry> {
  if (!globalThis.__ompSessionEntriesCache) globalThis.__ompSessionEntriesCache = new Map();
  return globalThis.__ompSessionEntriesCache;
}

function loadSessionEntriesCached(filePath: string): SessionEntry[] {
  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(filePath);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    // Missing/unreadable file — mirror loadSessionFile's lenient empty result.
    return loadSessionFile(filePath).entries;
  }
  const cache = getSessionEntriesCache();
  const key = sessionPathKey(filePath);
  const cached = cache.get(key);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.entries;
  }
  const entries = loadSessionFile(filePath).entries;
  // A single file larger than the WHOLE cache budget would pin the entire
  // budget for itself (the old `cache.size > 1` guard never evicted it) and
  // starve every other session's cached parse. Skip the cache for such
  // giants: they re-parse per request, which is bounded work (the read is
  // chunked; parse is O(entries)) and far cheaper than evicting all peers.
  // The per-request parse cost is the accepted trade-off for staying within
  // the memory budget — the alternative (caching) makes concurrent large
  // sessions OOM the server.
  if (size > MAX_SESSION_ENTRIES_CACHE_BYTES) {
    // The file outgrew the budget: any cached entry for this path is stale
    // (keyed on the OLD smaller size) and would keep burning eviction budget
    // until LRU got to it — drop it now.
    cache.delete(key);
    return entries;
  }
  cache.set(key, { size, mtimeMs, entries });
  // Two bounds: entry count and total cached file bytes (parsed JS expands
  // several-fold). Total-bytes eviction keeps the cache within budget.
  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.size;
  while (cache.size > 1 && (cache.size > MAX_SESSION_ENTRIES_CACHE_ENTRIES || totalBytes > MAX_SESSION_ENTRIES_CACHE_BYTES)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    totalBytes -= cache.get(oldestKey)?.size ?? 0;
    cache.delete(oldestKey);
  }
  return entries;
}

/** Session entries without blob resolution (fine for reference/thinking scans). */
export function getSessionEntries(filePath: string): SessionEntry[] {
  return loadSessionEntriesCached(filePath);
}

/** Surface loadSessionFile's `too_large` marker (loadSessionEntriesCached
 * drops it by returning only `.entries`) without paying for a fresh parse:
 * the size check is a stat, and the cached read below serves everything
 * else. Header reads are bounded and succeed on giant files, so this check is
 * what tells a 413 (file too large) from a 404 (missing/malformed). */
function loadEntriesOrThrowTooLarge(filePath: string): SessionEntry[] {
  try {
    if (statSync(filePath).size > MAX_SESSION_LOAD_BYTES) {
      // The cached entry (keyed on the old, smaller size) can never match
      // again — drop it instead of letting it linger until LRU eviction.
      getSessionEntriesCache().delete(sessionPathKey(filePath));
      throw new SessionFileTooLargeError(filePath);
    }
  } catch (error) {
    if (error instanceof SessionFileTooLargeError) throw error;
    // Missing/unreadable — mirror loadSessionFile's lenient empty result;
    // loadSessionEntriesCached handles the same case identically.
  }
  return loadSessionEntriesCached(filePath);
}

/** Thrown by getSessionEntriesForDisplay when the session file exists but is
 * larger than MAX_SESSION_LOAD_BYTES. The header read is bounded and succeeds
 * on such files, so routes cannot rely on a null header to detect the
 * overload — without this error the loader's too_large marker was dropped
 * (`.entries` is the empty array) and routes returned 200 with an empty
 * transcript, making history look deleted. Routes catch this and respond 413
 * with the stable `session_file_too_large` code. */
export class SessionFileTooLargeError extends Error {
  readonly code = "session_file_too_large" as const;
  constructor(filePath: string) {
    super(`Session file is too large to open in omp-web: ${filePath}`);
    this.name = "SessionFileTooLargeError";
  }
}
export class SessionFileMalformedError extends Error {
  readonly code = "session_file_malformed" as const;
  constructor(filePath: string) {
    super(`Session file is missing or malformed: ${filePath}`);
    this.name = "SessionFileMalformedError";
  }
}


/**
 * Display-path entry read for the session/context routes: reuses the memoized
 * (size, mtimeMs) parse cache WITHOUT blob resolution for entries that don't
 * reference blobs, and deep-copies ONLY the entries that do before resolving
 * their blob refs. The cache stays clean (shared objects are never mutated),
 * and the expensive deep copy is paid only for blob-bearing entries — the
 * common image-free session clones nothing (the array is shallow-copied).
 * Throws SessionFileTooLargeError when the file exceeds the load ceiling.
 */
export function getSessionEntriesForDisplay(filePath: string, options: ResolveBlobOptions = {}): SessionEntry[] {
  const entries = loadEntriesOrThrowTooLarge(filePath);
  return toDisplayEntries(entries, options);
}

/** Blob-resolution transform shared by the sync and deduplicated display
 * reads. */
function toDisplayEntries(entries: SessionEntry[], options: ResolveBlobOptions): SessionEntry[] {
  if (entries.length === 0) return entries;
  // Blob-bearing entries are deep-copied so resolution never mutates the
  // shared cache object; blob-free entries are shared as-is.
  const out: SessionEntry[] = new Array(entries.length);
  let copiedAny = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (
      options.skipToolResultImages &&
      entry.type === "message" &&
      ((entry.message as { role?: string } | null | undefined)?.role === "toolResult")
    ) {
      // Caller turns these images into media URLs — share the entry without blob work.
      out[i] = entry;
      continue;
    }
    if (!containsBlobRef(entry)) {
      out[i] = entry;
      continue;
    }
    // Blob-bearing entries are deep-copied so resolution never mutates the
    // shared cache object.
    out[i] = structuredClone(entry) as SessionEntry;
    copiedAny = true;
  }
  if (copiedAny) {
    resolveBlobRefsInEntries(out, options);
  }
  return out;
}

// In-flight parse dedup, keyed like the entries cache. Concurrent display
// reads for the SAME file share one parse instead of stacking duplicate
// work: for cache-skipped oversized files this removes the double parse on
// same-tick requests, and it is the load-bearing correctness point once the
// parse moves into the (async) worker queue — without the map, concurrent
// callers would each enqueue their own parse. Stored on globalThis for
// hot-reload safety; bounded by the number of distinct files being read
// concurrently, and entries are removed as soon as their parse settles.
declare global {
  var __ompEntriesInFlight: Map<string, Promise<SessionEntry[]>> | undefined;
}

function getInFlightEntries(): Map<string, Promise<SessionEntry[]>> {
  if (!globalThis.__ompEntriesInFlight) globalThis.__ompEntriesInFlight = new Map();
  return globalThis.__ompEntriesInFlight;
}

/** Deduplicated display-path entry read. Semantically identical to
 * getSessionEntriesForDisplay; concurrent calls for the same file share one
 * parse and resolve to the SAME entry array (callers must treat it as
 * immutable, like all cached entry reads). Rejections are never memoized: a
 * transient failure must not poison later reads. */
export async function getSessionEntriesForDisplayAsync(
  filePath: string,
  options: ResolveBlobOptions = {},
): Promise<SessionEntry[]> {
  const key = sessionPathKey(filePath);
  const cache = getSessionEntriesCache();
  // Same too-large gate as the sync display read: past the load ceiling the
  // routes must get the structured 413 error, not an empty transcript — and
  // the stale (small-size) cache entry for this path can never match again.
  let stat: { size: number; mtimeMs: number } | null = null;
  try {
    stat = statSync(filePath);
  } catch {
    stat = null; // missing/unreadable: fall through to the lenient load
  }
  if (stat && stat.size > MAX_SESSION_LOAD_BYTES) {
    getSessionEntriesCache().delete(key);
    throw new SessionFileTooLargeError(filePath);
  }
  // Fast path: unchanged file is a single stat away (same key convention as
  // loadSessionEntriesCached) — no parse, no dedup bookkeeping.
  if (stat) {
    const cached = cache.get(key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      cache.delete(key);
      cache.set(key, cached);
      return toDisplayEntries(cached.entries, options);
    }
  }

  const inFlight = getInFlightEntries().get(key);
  if (inFlight) return inFlight.then((entries) => toDisplayEntries(entries, options));

  // Defer the synchronous parse by one microtask so same-tick callers land
  // on the in-flight map instead of each starting their own parse.
  const parse = Promise.resolve().then(() => loadSessionEntriesCached(filePath));
  getInFlightEntries().set(key, parse);
  try {
    const entries = await parse;
    return toDisplayEntries(entries, options);
  } finally {
    const map = getInFlightEntries();
    if (map.get(key) === parse) map.delete(key);
  }
}

interface HistoryEntryRange {
  id: string;
  offset: number;
  length: number;
  firstKeptEntryId?: string;
  legacyCustom?: boolean;
}

interface SessionHistoryIndex {
  pathKey: string;
  version: string;
  bytes: number;
  rows: HistoryEntryRange[];
  entryIds: string[];
  positions: Map<string, number>;
  compactionId: string | null;
  metadata: Omit<SessionContext, "messages" | "entryIds">;
  leafId: string | null;
  tipId: string | null;
}

declare global {
  var __ompSessionHistoryIndexes: Map<string, SessionHistoryIndex> | undefined;
}

// Independent of the 256 MiB RAW parse cache: only offsets, IDs and selected
// branch metadata live here, never transcript bodies or compaction summaries.
// Charge UTF-16 strings plus per-row/map overhead; both LRU bounds apply.
const MAX_HISTORY_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_INDEXES = 32;

function historyFileVersion(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** The shared loader still owns title slots, lenient parsing and migrations.
 * Discard bodies before retaining each entry; keep only selection inputs. */
function historyEntryMetadata(entry: SessionEntry): SessionEntry {
  const compact: Record<string, unknown> = {
    type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
  };
  if (entry.type === "message" && isRecord(entry.message)) {
    const message = entry.message;
    compact.message = {
      role: message.role, provider: message.provider, model: message.model,
      ...(message.role === "toolResult" && message.toolName === "todo" ? {
        toolName: message.toolName, isError: message.isError,
        details: isRecord(message.details) ? { phases: message.details.phases } : undefined,
      } : {}),
    };
  } else if (entry.type === "model_change") {
    Object.assign(compact, { model: entry.model, role: entry.role, provider: entry.provider, modelId: entry.modelId });
  } else if (entry.type === "thinking_level_change") {
    compact.thinkingLevel = entry.thinkingLevel;
  } else if (entry.type === "compaction") {
    compact.firstKeptEntryId = entry.firstKeptEntryId;
    compact.firstKeptEntryIndex = (entry as unknown as Record<string, unknown>).firstKeptEntryIndex;
  } else if (entry.type === "branch_summary") {
    compact.summary = entry.summary ? "present" : "";
  } else if (entry.type === "custom" && entry.customType === "user_todo_edit") {
    compact.customType = entry.customType;
    compact.data = isRecord(entry.data) ? { phases: entry.data.phases } : undefined;
  }
  return compact as unknown as SessionEntry;
}

function buildHistoryIndex(
  filePath: string, version: string, leafId?: string, includePreCompaction?: boolean,
): SessionHistoryIndex {
  const ranges = new WeakMap<SessionEntry, { offset: number; length: number }>();
  const loaded = loadSessionFile(filePath, {
    projectEntry(entry, offset, length) {
      const compact = historyEntryMetadata(entry);
      ranges.set(compact, { offset, length });
      return compact;
    },
  });
  if (loaded.error === "too_large") throw new SessionFileTooLargeError(filePath);
  if (!loaded.header) throw new SessionFileMalformedError(filePath);
  const { selected, compactionId, ...metadata } = selectSessionContext(loaded.entries, leafId, { includePreCompaction });
  const rows = selected.map((entry): HistoryEntryRange => ({
    id: entry.id,
    ...ranges.get(entry)!,
    ...(entry.type === "compaction" ? { firstKeptEntryId: entry.firstKeptEntryId } : {}),
    ...(entry.type === "message" && entry.message.role === "custom" ? { legacyCustom: true } : {}),
  }));
  const tipId = loaded.entries.at(-1)?.id ?? null;
  // Detach metadata strings from the parser's JSON source: an ID represented
  // by a sliced V8 string must not pin a multi-megabyte message body.
  const serialized = JSON.stringify({
    rows, compactionId, metadata, tipId,
    leafId: leafId && loaded.entries.some((entry) => entry.id === leafId) ? leafId : tipId,
  });
  const detached = JSON.parse(serialized) as Pick<SessionHistoryIndex, "rows" | "compactionId" | "metadata" | "tipId" | "leafId">;
  const entryIds = detached.rows.map((row) => row.id);
  const positions = new Map(entryIds.map((id, position) => [id, position]));
  const bytes = 256 + serialized.length * 2 + rows.length * 192;
  return { ...detached, pathKey: sessionPathKey(filePath), version, bytes, entryIds, positions };
}

/** Rebuild on any file-version change: growth alone cannot prove that old
 * offsets survived a prefix rewrite. Both readers share the same bounded LRU. */
function getSessionHistoryIndex(filePath: string, leafId?: string, includePreCompaction = false) {
  const cache = globalThis.__ompSessionHistoryIndexes ??= new Map();
  const pathKey = sessionPathKey(filePath);
  const key = JSON.stringify([pathKey, leafId ?? null, includePreCompaction]);
  let stat: Stats | undefined;
  try { stat = statSync(filePath); } catch { /* Missing/unreadable: retain the lenient empty result. */ }
  if (stat && stat.size > MAX_SESSION_LOAD_BYTES) {
    invalidateSessionEntriesCache(filePath);
    throw new SessionFileTooLargeError(filePath);
  }
  const version = stat ? historyFileVersion(stat) : "";
  for (const [cachedKey, cached] of cache) {
    if (cached.pathKey === pathKey && cached.version !== version) cache.delete(cachedKey);
  }
  let index = cache.get(key);
  if (!index) {
    index = buildHistoryIndex(filePath, version, leafId, includePreCompaction);
    if (stat && historyFileVersion(statSync(filePath)) !== version) throw new Error("Session changed while indexing history");
    // An unusually metadata-heavy file still opens, but cannot evict every
    // peer or retain more than the entire index budget by itself.
    if (stat && index.bytes <= MAX_HISTORY_INDEX_BYTES) cache.set(key, index);
  } else {
    cache.delete(key);
    cache.set(key, index);
  }
  let totalBytes = 0;
  for (const cached of cache.values()) totalBytes += cached.bytes;
  while (cache.size > MAX_HISTORY_INDEXES || totalBytes > MAX_HISTORY_INDEX_BYTES) {
    const oldest = cache.keys().next().value!;
    totalBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
  return { index, cache, key };
}

/** Current active context IDs only; no body seeks or blob hydration. The
 * returned IDs are cached and immutable, like getSessionEntries results. */
export function getSessionContextBoundary(filePath: string): { entryIds: string[] } {
  const { index } = getSessionHistoryIndex(filePath);
  return { entryIds: index.entryIds };
}

/** Seek only page bodies. A file changed during indexing/reading must not
 * advance the browser cursor using offsets from a different file version. */
export function getSessionHistoryPage(
  filePath: string,
  cursor: SessionHistoryCursor | null,
  limit: number,
  leafId?: string,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean } = {},
): { history: SessionHistoryPage; leafId: string | null; tipId: string | null } {
  const { index, cache, key } = getSessionHistoryIndex(filePath, leafId, !!options.includePreCompaction);
  const version = index.version;

  const { start, end, ...page } = selectHistoryRange(index.entryIds, cursor, limit, index.positions);
  const rawEntries: SessionEntry[] = [];
  if (start < end) {
    const fd = openSync(filePath, "r");
    try {
      if (historyFileVersion(fstatSync(fd)) !== version) throw new Error("Session changed before reading history");
      for (let i = start; i < end; i++) {
        const row = index.rows[i];
        const buffer = Buffer.allocUnsafe(row.length);
        let read = 0;
        while (read < buffer.length) {
          const count = readSync(fd, buffer, read, buffer.length - read, row.offset + read);
          if (count === 0) throw new Error("Session truncated while reading history");
          read += count;
        }
        const entry = JSON.parse(buffer.toString("utf8").trim()) as SessionEntry;
        // Reuse IDs/compaction links assigned by v1 migration; v2 renamed the
        // hookMessage role. No migrated body is retained between requests.
        entry.id = row.id;
        if (entry.type === "compaction") entry.firstKeptEntryId = row.firstKeptEntryId!;
        if (entry.type === "message" && row.legacyCustom) {
          const message = entry.message as unknown as Record<string, unknown>;
          if (message.role === "hookMessage") message.role = "custom";
        }
        rawEntries.push(entry);
      }
      if (historyFileVersion(fstatSync(fd)) !== version) {
        throw new Error("Session changed while reading history");
      }
    } catch (error) {
      cache.delete(key);
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  const entries = toDisplayEntries(rawEntries, { skipToolResultImages: options.deferToolResultImages });
  const history: SessionHistoryPage = {
    ...page,
    context: {
      ...index.metadata,
      entryIds: index.entryIds.slice(start, end),
      messages: entries.map((entry) => entry.type === "compaction"
        ? compactionUiMessage(entry, entry.id === index.compactionId)
        : entryToUiMessage(entry, options)!),
    },
  };
  return { history, leafId: index.leafId, tipId: index.tipId };
}

function parseTodoPhases(value: unknown): TodoPhase[] | null {
  if (!Array.isArray(value)) return null;
  const statuses = new Set(["pending", "in_progress", "completed", "blocked", "abandoned"]);
  const phases: TodoPhase[] = [];
  for (const phase of value) {
    if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    const tasks = [];
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string" || typeof task.status !== "string" || !statuses.has(task.status)) return null;
      if (task.blocker !== undefined && typeof task.blocker !== "string") return null;
      tasks.push({
        content: task.content,
        status: task.status as TodoPhase["tasks"][number]["status"],
        ...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
      });
    }
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

/** Latest valid todo snapshot on the selected branch, without exposing tool metadata to the client. */
export function getTodoPhasesFromEntries(entries: SessionEntry[], leafId?: string | null): TodoPhase[] {
  if (leafId === null || entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let entry = leafId ? byId.get(leafId) : entries[entries.length - 1];
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    path.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }

  for (let index = 0; index < path.length; index++) {
    const current = path[index];
    if (current.type === "custom" && current.customType === "user_todo_edit") {
      const phases = isRecord(current.data) ? parseTodoPhases(current.data.phases) : null;
      if (phases) return phases;
    }
    if (current.type === "message" && isRecord(current.message) && current.message.role === "toolResult") {
      const message = current.message as { role?: string; toolName?: string; isError?: boolean; details?: unknown };
      if (message.toolName !== "todo" || message.isError) continue;
      const phases = isRecord(message.details) ? parseTodoPhases(message.details.phases) : null;
      if (phases) return phases;
    }
  }
  return [];
}

const SUPERSEDED_COMPACTION_SUMMARY = "[Superseded compaction summary elided after a newer compaction]";

/**
 * Build the display context for a leaf. Port of oh-my-pi's buildSessionContext
 * (session/session-context.ts) path-walk semantics — leaf→root walk with a
 * cycle guard, firstKeptEntryId compaction collapsing, role-based model
 * tracking with legacy assistant-message inference — combined with pi-web's
 * UI message conversion: messages/entryIds stay parallel so fork/navigation
 * targets remain aligned, and the active compaction summary is emitted first
 * (the collapsed view the pi-web UI is built around).
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean } = {},
): SessionContext {
  const { selected, compactionId, ...metadata } = selectSessionContext(entries, leafId, options);
  return {
    ...metadata,
    entryIds: selected.map((entry) => entry.id),
    messages: selected.map((entry) => entry.type === "compaction"
      ? compactionUiMessage(entry, entry.id === compactionId)
      : entryToUiMessage(entry, options)!),
  };
}

/** Select ordering and branch metadata without converting message bodies. */
function selectSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { includePreCompaction?: boolean } = {},
) {
  const empty = { selected: [] as SessionEntry[], compactionId: null as string | null, thinkingLevel: "off", model: null as SessionContext["model"], todoPhases: [] as TodoPhase[] };
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  if (leafId === null) return empty;
  const leaf = (leafId ? byId.get(leafId) : undefined) ?? entries.at(-1);
  if (!leaf) return empty;

  // Walk leaf → root, stopping at the first corrupt parent cycle.
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  let thinkingLevel = "off";
  const models: Record<string, string> = {};
  // Explicit defaults take precedence over temporary assistant fallbacks.
  let hasExplicitDefaultModel = false;
  let compaction: CompactionEntry | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel ?? "off";
    } else if (entry.type === "model_change") {
      if (entry.model) {
        const role = entry.role ?? "default";
        models[role] = entry.model;
        if (role === "default") hasExplicitDefaultModel = true;
      } else if (entry.provider && entry.modelId) {
        models.default = `${entry.provider}/${entry.modelId}`;
        hasExplicitDefaultModel = true;
      }
    } else if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
      if (!hasExplicitDefaultModel && entry.message.provider && entry.message.model) {
        models.default = `${entry.message.provider}/${entry.message.model}`;
      }
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const selected: SessionEntry[] = [];
  const appendEntry = (entry: SessionEntry) => {
    if (entry.type === "compaction" || entry.type === "custom_message"
      || (entry.type === "message" && isRecord(entry.message))
      || (entry.type === "branch_summary" && entry.summary)) {
      selected.push(entry);
    }
  };
  if (compaction && !options.includePreCompaction) {
    const activeCompaction = compaction;
    appendEntry(activeCompaction);
    const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === activeCompaction.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === activeCompaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) appendEntry(entry);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) appendEntry(path[i]);
  } else {
    for (const entry of path) appendEntry(entry);
  }

  let model: SessionContext["model"] = null;
  const defaultModel = models.default;
  if (defaultModel) {
    const separator = defaultModel.indexOf("/");
    model = separator > 0
      ? { provider: defaultModel.slice(0, separator), modelId: defaultModel.slice(separator + 1) }
      : { provider: "", modelId: defaultModel };
  }
  return { selected, compactionId: compaction?.id ?? null, thinkingLevel, model, todoPhases: getTodoPhasesFromEntries(entries, leafId) };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Message-level timestamps arrive as epoch numbers on the wire but ISO
 *  strings in hand-edited/imported files — normalize both to number|undefined
 *  so downstream arithmetic never sees a string (NaN / Invalid Date). */
function normalizeMessageTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return parseEntryTimestamp(value);
  return undefined;
}

/** Pass-through branches (user/assistant/toolResult) return the raw message
 *  object — repair only its timestamp, copying when it needs it. */
function withNormalizedTimestamp(message: AgentMessage): AgentMessage {
  const raw = message.timestamp;
  const timestamp = normalizeMessageTimestamp(raw);
  return timestamp === raw ? message : { ...message, timestamp };
}

/**
 * toolResult `details` is provider/tool-internal metadata that dominates real
 * history payloads (measured 643KB of a 1.34MB context on a 533-entry session),
 * and the history UI reads exactly two keys from it: details.patch and
 * details.diff (components/MessageView.tsx getResultDiff). Serialization
 * allowlists those keys — extend the allowlist if MessageView ever reads more.
 * Task toolResults additionally keep a SIZE-BOUNDED subset of their
 * results/progress (telemetry, no full output) so the message flow can render
 * a per-subagent summary. On-disk parsing (loadSessionFile/getSessionEntries)
 * keeps full details.
 */
const TASK_DETAIL_MAX_TEXT = 240;
const TASK_DETAIL_MAX_ROWS = 50;

function truncateTaskDetailText(value: string): string {
  if (value.length <= TASK_DETAIL_MAX_TEXT) return value;
  // Cut by code point so a boundary can never split a surrogate pair.
  return `${[...value].slice(0, TASK_DETAIL_MAX_TEXT).join("")}…`;
}

function taskDetailAsync(value: unknown): Record<string, string> | undefined {
  // Project async to its documented fields only (state/jobId/type) — extra
  // payload fields must not ride the bounded history response.
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const key of ["state", "jobId", "type"] as const) {
    if (typeof value[key] === "string") out[key] = truncateTaskDetailText(value[key]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const TASK_DETAIL_PROGRESS_KEYS = [
  "index", "id", "agent", "agentSource", "status", "task", "assignment", "lastIntent",
  "toolCount", "requests", "tokens", "contextTokens", "contextWindow", "cost", "durationMs",
  "modelRole", "resolvedModel", "resolvedModelIsFallback", "retryFailure",
] as const;

const TASK_DETAIL_RESULT_KEYS = [
  "index", "id", "agent", "agentSource", "status", "task", "assignment", "exitCode",
  "truncated", "structuredOutput", "durationMs", "tokens", "requests", "contextTokens",
  "contextWindow", "modelRole", "resolvedModel", "resolvedModelIsFallback", "error",
  "aborted", "abortReason", "outputPath", "patchPath", "branchName", "retryFailure",
] as const;

function keepTaskToolResultDetails(details: Record<string, unknown>): Record<string, unknown> | null {
  const kept: Record<string, unknown> = {};
  const results = Array.isArray(details.results) ? details.results : [];
  const progress = Array.isArray(details.progress) ? details.progress : [];
  if (results.length === 0 && progress.length === 0 && !isRecord(details.async)) return null;

  if (typeof details.totalDurationMs === "number") kept.totalDurationMs = details.totalDurationMs;
  if (isRecord(details.async)) {
    const asyncInfo = taskDetailAsync(details.async);
    if (asyncInfo) kept.async = asyncInfo;
  }

  const pickRecord = (raw: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    if (!isRecord(raw)) return null;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
    // Bound every string field that rides the history payload.
    for (const key of ["task", "assignment", "error", "abortReason", "lastIntent", "agent", "modelRole", "resolvedModel", "outputPath", "patchPath", "branchName"] as const) {
      if (typeof out[key] === "string") out[key] = truncateTaskDetailText(out[key]);
    }
    // Settled results carry cost in `usage.cost`, not top-level `cost`.
    if (typeof out.cost !== "number") {
      const usageCost = taskResultUsageCost(raw.usage);
      if (usageCost !== undefined) out.cost = usageCost;
    }
    // Project nested objects to bounded, UI-only shapes.
    if (raw.retryFailure !== undefined) {
      const retryFailure = taskResultRetryFailure(raw.retryFailure, truncateTaskDetailText);
      if (retryFailure) out.retryFailure = retryFailure;
      else delete out.retryFailure;
    }
    if (raw.structuredOutput !== undefined) {
      const structuredOutput = taskResultStructuredOutput(raw.structuredOutput, truncateTaskDetailText);
      if (structuredOutput) out.structuredOutput = structuredOutput;
      else delete out.structuredOutput;
    }
    return out;
  };

  if (progress.length > 0) {
    kept.progress = progress
      .slice(0, TASK_DETAIL_MAX_ROWS)
      .map((raw) => pickRecord(raw, TASK_DETAIL_PROGRESS_KEYS))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }
  if (results.length > 0) {
    kept.results = results
      .slice(0, TASK_DETAIL_MAX_ROWS)
      .map((raw) => pickRecord(raw, TASK_DETAIL_RESULT_KEYS))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

function keepHubToolResultDetails(details: Record<string, unknown>): Record<string, unknown> | null {
  const op = details.op;
  if (typeof op !== "string" || (op !== "send" && op !== "jobs")) return null;
  const kept: Record<string, unknown> = { op };
  if (op === "send") {
    const to = hubDetailTargets(details.to);
    if (to) kept.to = to;
    if (Array.isArray(details.receipts)) {
      const receipts = details.receipts
        .slice(0, TASK_DETAIL_MAX_ROWS)
        .map((raw) => {
          if (!isRecord(raw)) return null;
          const out: Record<string, string> = {};
          if (typeof raw.to === "string") out.to = truncateTaskDetailText(raw.to);
          if (typeof raw.outcome === "string") out.outcome = truncateTaskDetailText(raw.outcome);
          return Object.keys(out).length > 0 ? out : null;
        })
        .filter((entry): entry is Record<string, string> => entry !== null);
      if (receipts.length > 0) kept.receipts = receipts;
    }
  } else {
    if (Array.isArray(details.jobs)) {
      const jobs = details.jobs
        .slice(0, TASK_DETAIL_MAX_ROWS)
        .map((raw) => {
          if (!isRecord(raw)) return null;
          const out: Record<string, unknown> = {};
          for (const key of ["id", "type", "status", "label", "resolvedModel"] as const) {
            if (typeof raw[key] === "string") out[key] = truncateTaskDetailText(raw[key]);
          }
          if (typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)) out.durationMs = raw.durationMs;
          return Object.keys(out).length > 0 ? out : null;
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      if (jobs.length > 0) kept.jobs = jobs;
    }
  }
  return Object.keys(kept).length > 1 ? kept : null;
}

function hubDetailTargets(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
  if (!list) return undefined;
  const out = list
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, TASK_DETAIL_MAX_ROWS)
    .map((entry) => truncateTaskDetailText(entry));
  return out.length > 0 ? out : undefined;
}

function stripToolResultDetails(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult" || message.details === undefined) return message;
  const { details, ...rest } = message;
  if (isRecord(details)) {
    const kept: Record<string, unknown> = {};
    if (typeof details.patch === "string") kept.patch = details.patch;
    if (typeof details.diff === "string") kept.diff = details.diff;
    if (message.toolName === "task") {
      const taskDetails = keepTaskToolResultDetails(details);
      if (taskDetails) Object.assign(kept, taskDetails);
    }
    if (message.toolName === "hub") {
      const hubDetails = keepHubToolResultDetails(details);
      if (hubDetails) Object.assign(kept, hubDetails);
    }
    if (Object.keys(kept).length > 0) return { ...rest, details: kept };
  }
  return rest;
}

function toolResultImagesAsUrls(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;
  const content = toolResultContentAsUrls(message.content);
  return content === message.content ? message : { ...message, content };
}

function compactionUiMessage(entry: CompactionEntry, active: boolean): CustomMessage {
  return {
    role: "custom",
    customType: "compaction",
    content: active ? entry.summary : SUPERSEDED_COMPACTION_SUMMARY,
    display: true,
    details: {
      tokensBefore: entry.tokensBefore,
      ...(entry.tokensAfter !== undefined ? { tokensAfter: entry.tokensAfter } : {}),
      ...(entry.method !== undefined ? { method: entry.method } : {}),
      firstKeptEntryId: entry.firstKeptEntryId,
    },
    timestamp: parseEntryTimestamp(entry.timestamp),
  };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
export function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  switch (entry.type) {
    case "message": {
      // Imports and hand-edits can produce message entries whose `message`
      // object is missing; skip them like any other unmappable entry instead
      // of crashing every reader of the file.
      if (!isRecord(entry.message)) return null;
      const raw = entry.message;
      // omp-only roles are folded into displayable custom messages so the
      // existing role-keyed UI renders them without new components.
      if (raw.role === "developer") {
        // Passive tool context is display-only: it rides on its tool card
        // (collectToolResults), never as a row or in copied transcripts.
        const passive = raw.passiveToolContext === true;
        return {
          role: "custom",
          customType: passive ? PASSIVE_TOOL_CONTEXT : "developer",
          content: raw.content,
          display: !passive,
          timestamp: normalizeMessageTimestamp(raw.timestamp),
        };
      }
      if (raw.role === "pythonExecution") {
        const output = raw.output ? `\n\`\`\`\n${raw.output}\n\`\`\`` : "\n(no output)";
        const status = raw.cancelled
          ? "\n(execution cancelled)"
          : raw.exitCode ? `\nExecution failed with code ${raw.exitCode}` : "";
        return {
          role: "custom",
          customType: "python-execution",
          content: `Ran Python:\n\`\`\`python\n${raw.code}\n\`\`\`${output}${status}`,
          display: true,
          timestamp: normalizeMessageTimestamp(raw.timestamp),
        };
      }
      if (raw.role === "fileMention") {
        // Guard against shape-malformed entries (missing/non-array `files`)
        // the same way the loader tolerates bad lines: one bad entry must not
        // 500 the entire session view.
        const files = Array.isArray(raw.files)
          ? (raw.files as unknown[]).filter((f): f is { path: string } =>
              !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string")
          : [];
        return {
          role: "custom",
          customType: "file-mention",
          content: `Attached file${files.length === 1 ? "" : "s"}:\n${files.map((f) => `- ${f.path}`).join("\n")}`,
          display: true,
          timestamp: normalizeMessageTimestamp(raw.timestamp),
        };
      }
      const normalized = options.deferToolResultImages
        ? toolResultImagesAsUrls(normalizeToolCalls(raw))
        : normalizeToolCalls(raw);
      const message = stripToolResultDetails(normalized);
      if (!options.deferThinking || message.role !== "assistant") return withNormalizedTimestamp(message);
      // Guard like the loader does for bad lines: normalizeToolCalls passes
      // non-array content through unchanged, so a string-content assistant
      // entry must not 500 the whole context route.
      if (!Array.isArray(message.content)) return withNormalizedTimestamp(message);
      const deferred = {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
      return withNormalizedTimestamp(deferred);
    }
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
        branchSummary: true,
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      // model_change, thinking_level_change, service_tier_change, label,
      // title_change, session_init, ttsr_injection, mode_change, custom,
      // session_info: metadata entries with no chat rendering.
      return null;
  }
}
