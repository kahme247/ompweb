import { existsSync, statSync } from "fs";
import { normalize as normalizePath, sep } from "path";
import { getAgentDir, normalizeProfileName } from "./omp/paths";
import { loadProjectRegistry } from "./project-registry";
import {
  invalidateSessionFileListCache,
  listAllSessionInfos,
  loadSessionFile,
  readSessionHeaderSync,
  type OmpSessionInfo,
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
import { taskResultRetryFailure, taskResultStructuredOutput, taskResultUsageCost } from "./task-result-details";
import type { TodoPhase } from "./pi-types";
import { projectIdentityKey, sessionPathKey } from "./paths";
import { resolveProject, type ProjectInfo } from "./worktree";

import { sessionKeyForProfile } from "./session-identity";
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
  profile: string | undefined,
  pathToId: Map<string, string>,
  knownIds: Set<string>,
): string | undefined {
  const byPath = pathToId.get(sessionPathKey(parentSession));
  if (byPath) return byPath;
  const scopedId = sessionKeyForProfile(profile, parentSession);
  return knownIds.has(scopedId) ? scopedId : undefined;
}
/**
 * 查询会话 cwd 所属工作区的 Profile。会话可从工作区子目录启动，
 * 因此按最长工作区路径匹配 cwd 与解析出的项目根目录。
 */
function profileForSessionWorkspace(
  workspaceProfiles: ReadonlyArray<{ pathKey: string; profile: string }>,
  cwd: string,
  projectRoot: string,
): string | undefined {
  const candidates = [projectIdentityKey(projectRoot), projectIdentityKey(cwd)];
  const match = workspaceProfiles.find(({ pathKey }) => candidates.some((candidate) => (
    candidate === pathKey || candidate.startsWith(pathKey.endsWith(sep) ? pathKey : `${pathKey}${sep}`)
  )));
  return match?.profile;
}


async function loadAllSessions(): Promise<SessionInfo[]> {
  const registry = loadProjectRegistry();
  // 空字符串显式指向默认 profile；不能传 undefined，否则会继承 omp-web 进程 profile。
  const profiles = new Set<string>([""]);
  for (const project of registry.projects) {
    const profile = project.launchConfig?.profile;
    if (profile) profiles.add(normalizeProfileName(profile) ?? "");
  }
  const workspaceProfiles = registry.projects.flatMap((project) => {
    const profile = normalizeProfileName(project.launchConfig?.profile);
    return profile ? [{ pathKey: projectIdentityKey(project.path), profile }] : [];
  }).sort((a, b) => b.pathKey.length - a.pathKey.length);
  const profileSessions = await Promise.all(
    [...profiles].map(async (profileValue) => ({
      profile: normalizeProfileName(profileValue),
      sessions: await listAllSessionInfos(profileValue),
    })),
  );
  const ompSessions: Array<{ profile: string | undefined; session: OmpSessionInfo }> = [];
  const seenPaths = new Set<string>();
  for (const { profile, sessions } of profileSessions) {
    for (const session of sessions) {
      if (seenPaths.has(session.path)) continue;
      seenPaths.add(session.path);
      ompSessions.push({ profile, session });
    }
  }
  ompSessions.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
  const pathToId = new Map<string, string>();
  const knownIds = new Set<string>();
  for (const { profile, session } of ompSessions) {
    const sessionKey = sessionKeyForProfile(profile, session.id);
    pathToId.set(sessionPathKey(session.path), sessionKey);
    knownIds.add(sessionKey);
  }

  const uniqueCwds = [...new Set(ompSessions.map(({ session }) => session.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  const CONCURRENCY = 6;
  for (let i = 0; i < uniqueCwds.length; i += CONCURRENCY) {
    const chunk = uniqueCwds.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (cwd) => {
      projectByCwd.set(cwd, await resolveProject(cwd));
    }));
  }

  return ompSessions.flatMap(({ profile, session: s }) => {
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? s.cwd;
    const configuredProfile = profileForSessionWorkspace(workspaceProfiles, s.cwd, projectRoot);
    // 已配置 Profile 的工作区及其子目录只显示所属 Profile，避免默认目录混入。
    if (configuredProfile !== undefined && configuredProfile !== profile) return [];

    const id = sessionKeyForProfile(profile, s.id);
    cacheSessionPath(id, s.path);
    return [{
      path: s.path,
      id,
      profile,
      cwd: s.cwd,
      name: s.title,
      created: s.created instanceof Date && !Number.isNaN(s.created.getTime())
        ? s.created.toISOString()
        : s.modified.toISOString(),
      modified: s.modified.toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath
        ? matchParentSessionId(s.parentSessionPath, profile, pathToId, knownIds)
        : undefined,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    }];
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

  const loadPromise = loadAllSessions().then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((globalThis.__piSessionListGeneration ?? 0) === generation) {
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

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
  // The session-file walk cache keys on the sessions-root mtime, which does
  // not change when a file is added inside an existing project subdirectory
  // (Windows/NTFS). Clear it too so new sessions appear immediately.
  invalidateSessionFileListCache();
  // Drop cached entry parses so a mutation preserving size+mtime (rare) can
  // never serve stale entries; the (size, mtimeMs) key already invalidates
  // the common case, this closes the remaining window.
  globalThis.__ompSessionEntriesCache?.clear();
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
export async function resolveParentSessionId(parentSession: string, profile?: string): Promise<string | undefined> {
  if (!parentSession) return undefined;
  const byPath = await resolveSessionIdByPath(parentSession);
  if (byPath) return byPath;
  const parentId = sessionKeyForProfile(profile, parentSession);
  // 原生 parentSession 的裸 id 与当前会话共用 profile。
  return (await resolveSessionPath(parentId)) ? parentId : undefined;
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
  const cached = cache.get(filePath);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.entries;
  }
  const entries = loadSessionFile(filePath).entries;
  cache.set(filePath, { size, mtimeMs, entries });
  // Two bounds: entry count and total cached file bytes (parsed JS expands
  // several-fold). Inserted files larger than the whole budget are still
  // cached — they are evicted by the next insert, and skipping the cache
  // would re-parse the giants on every request.
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

  for (let index = path.length - 1; index >= 0; index--) {
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
  const emptyContext: SessionContext = { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  // Explicitly null — navigated to before the first entry.
  if (leafId === null) return emptyContext;

  let leaf: SessionEntry | undefined;
  if (leafId) leaf = byId.get(leafId);
  if (!leaf) leaf = entries[entries.length - 1];
  if (!leaf) return emptyContext;

  // Walk leaf → root. Corrupt files can contain parent cycles; stop at the
  // first repeat so the walk stays bounded.
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  // Settings scan along the path: thinking level, model roles, last compaction.
  let thinkingLevel = "off";
  const models: Record<string, string> = {};
  // Once an explicit default model_change is on the path, assistant-message
  // inference must not overwrite it (temporary fallbacks carry the wrong id).
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
        // Legacy pi entry shape.
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

  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  const appendEntry = (entry: SessionEntry) => {
    const message = entry.type === "compaction"
      ? compactionUiMessage(entry, entry.id === compaction?.id)
      : entryToUiMessage(entry, options);
    if (message) {
      messages.push(message);
      entryIds.push(entry.id);
    }
  };

  if (compaction && !options.includePreCompaction) {
    const activeCompaction = compaction;
    // Agent-context view: active summary first, then entries kept from
    // firstKeptEntryId up to the compaction, then everything after it.
    appendEntry(activeCompaction);
    const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === activeCompaction.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === activeCompaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) appendEntry(entry);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      appendEntry(path[i]);
    }
  } else {
    for (const entry of path) appendEntry(entry);
  }

  // Effective model: the "default" role, as "provider/modelId" (modelId may
  // itself contain slashes, e.g. openrouter ids).
  let model: SessionContext["model"] = null;
  const defaultModel = models.default;
  if (defaultModel) {
    const separator = defaultModel.indexOf("/");
    model = separator > 0
      ? { provider: defaultModel.slice(0, separator), modelId: defaultModel.slice(separator + 1) }
      : { provider: "", modelId: defaultModel };
  }

  return { messages, entryIds, thinkingLevel, model, todoPhases: getTodoPhasesFromEntries(entries, leafId) };
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

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
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
    if (Object.keys(kept).length > 0) return { ...rest, details: kept };
  }
  return rest;
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;
  // Shape-malformed-but-JSON-valid files can carry a string content here
  // (import accepts arbitrary content); the loader tolerates such lines, so
  // the converter must too instead of crashing the whole session view.
  if (!Array.isArray(message.content)) return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
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
        return {
          role: "custom",
          customType: "developer",
          content: raw.content,
          display: true,
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
        ? omitToolResultBase64Images(normalizeToolCalls(raw))
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
