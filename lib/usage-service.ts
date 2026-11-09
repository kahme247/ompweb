import { statSync } from "fs";
import { basename, join } from "path";
import { getAgentDir } from "./omp/paths";
import { readModelsConfig } from "./omp/models-config";
import { forEachFileLineSync, invalidateSessionFileListCache, readSessionHeaderSync } from "./omp/session-files";
import { SUBAGENT_ID_RE } from "./subagent-types";
import { isRecord } from "./type-guards";
import {
  calculateCacheSavings,
  calculateUsageCost,
  resolveModelRates,
} from "./usage-rates";
import { runSingleFlight } from "./single-flight";
import { runUsageReportInWorker } from "./usage-report-worker";
import type {
  UsageQueryOptions,
  UsageRecord,
  UsageReport,
  UsageTimeRange,
} from "./usage-types";

/**
 * Version of the rules `parseSessionUsage` applies. Bump it whenever those
 * rules change what a transcript yields: records from other rules are never
 * reused. It is stored per synced file in usage.db — per file, not per
 * database, because several omp-web builds can share one usage.db, so a file
 * last synced by any other rule set is re-parsed — and on every in-memory
 * cache entry, since the cache lives on globalThis and outlives a dev hot
 * reload that brings in new rules.
 * v2: artifact transcripts counted; entry ids, task-summary targets and the
 * owning session's start stored.
 */
export const USAGE_PARSER_VERSION = 2;

interface SessionUsageCacheEntry {
  parserVersion: number;
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
  sessionTimestamp: number;
}

export const MAX_USAGE_CACHE_ENTRIES = 2000;
export const MAX_USAGE_CACHE_BYTES = 64 * 1024 * 1024; // 64 MiB

let usageCacheApproxBytes = 0;

declare global {
  var __ompUsageCache: Map<string, SessionUsageCacheEntry> | undefined;
}

function getUsageCache(): Map<string, SessionUsageCacheEntry> {
  if (!globalThis.__ompUsageCache) {
    globalThis.__ompUsageCache = new Map();
  }
  return globalThis.__ompUsageCache;
}

function estimateUsageEntryBytes(entry: SessionUsageCacheEntry): number {
  return entry.records.length * 200 + 128;
}

function setUsageCacheEntry(filePath: string, entry: SessionUsageCacheEntry): void {
  const cache = getUsageCache();
  const existing = cache.get(filePath);
  if (existing) {
    usageCacheApproxBytes -= estimateUsageEntryBytes(existing);
  }
  const entryBytes = estimateUsageEntryBytes(entry);
  cache.set(filePath, entry);
  usageCacheApproxBytes += entryBytes;

  while (cache.size > MAX_USAGE_CACHE_ENTRIES || usageCacheApproxBytes > MAX_USAGE_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    const old = cache.get(oldestKey);
    if (old) usageCacheApproxBytes -= estimateUsageEntryBytes(old);
    cache.delete(oldestKey);
  }
}

/** Clear the per-file parse cache: a rescan must re-read the transcripts. */
function invalidateSessionUsageCache(): void {
  globalThis.__ompUsageCache?.clear();
  usageCacheApproxBytes = 0;
}

/**
 * Clear everything cached about usage: the per-file parses and every computed
 * report. The reset for tests, and for any caller that knows the database was
 * rebuilt underneath it.
 */
export function invalidateUsageCache(): void {
  invalidateSessionUsageCache();
  globalThis.__ompUsageReportCache?.clear();
}

/**
 * Format a Date object to "YYYY-MM-DD" in local time.
 */
export function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Format a Date object to "YYYY-MM" in local time.
 */
export function toLocalMonthString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Format date for short chart axis label: e.g. "Aug 3" or "2026-08".
 */
export function formatChartDateLabel(dateStr: string, isMonthly: boolean): string {
  if (isMonthly) {
    const parts = dateStr.split("-");
    if (parts.length >= 2) {
      const monthIdx = parseInt(parts[1], 10) - 1;
      return `${MONTH_NAMES[monthIdx] || parts[1]} ${parts[0]}`;
    }
    return dateStr;
  }
  const parts = dateStr.split("-");
  if (parts.length >= 3) {
    const monthIdx = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    return `${MONTH_NAMES[monthIdx] || parts[1]} ${day}`;
  }
  return dateStr;
}

/**
 * Format full date for table display: e.g. "Aug 3, 2026".
 */
export function formatFullDateLabel(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length >= 3) {
    const monthIdx = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    return `${MONTH_NAMES[monthIdx] || parts[1]} ${day}, ${parts[0]}`;
  }
  return dateStr;
}

/**
 * Compute timestamp range [startMs, endMs] for a given time range preset.
 */
export function computeTimeRangeBounds(
  range: UsageTimeRange = "30d",
  now: number = Date.now(),
): { startMs: number; endMs: number } {
  const nowDate = new Date(now);
  const endMs = now;

  switch (range) {
    case "today": {
      const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
      return { startMs: todayStart, endMs };
    }
    case "7d": {
      return { startMs: now - 7 * 86400 * 1000, endMs };
    }
    case "30d": {
      return { startMs: now - 30 * 86400 * 1000, endMs };
    }
    case "90d": {
      return { startMs: now - 90 * 86400 * 1000, endMs };
    }
    case "month": {
      const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
      return { startMs: monthStart, endMs };
    }
    case "all": {
      return { startMs: 0, endMs };
    }
    default:
      return { startMs: now - 30 * 86400 * 1000, endMs };
  }
}

/**
 * Parse one transcript .jsonl file and extract all Assistant usage records.
 * Uses mtime + file size cache to avoid disk reading on subsequent requests.
 *
 * `sessionFile` is the session that owns the transcript. For a transcript in
 * that session's artifacts directory (subagent, advisor, `/tan` clone,
 * extension sub-session) the records carry the owner's id and cwd rather than
 * the transcript's own header, so they count toward that session and project.
 */
export function parseSessionUsage(
  filePath: string,
  customModelsConfig = readModelsConfig(),
  sessionFile = filePath,
): UsageRecord[] {
  let stats;
  try {
    stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0) return [];
  } catch {
    return [];
  }

  const cache = getUsageCache();
  const cached = cache.get(filePath);
  if (cached && cached.parserVersion === USAGE_PARSER_VERSION && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.records;
  }

  const isArtifact = sessionFile !== filePath;
  const owner = isArtifact ? readSessionHeaderSync(sessionFile) : null;
  let sessionId = owner?.id ?? basename(sessionFile, ".jsonl");
  let sessionCwd = owner?.cwd ?? "";
  let sessionTimestamp = stats.mtimeMs;
  const ownerStarted = owner ? Date.parse(owner.timestamp) : NaN;
  let sessionStarted = Number.isFinite(ownerStarted) ? ownerStarted : stats.mtimeMs;
  let activeProvider = "";
  let activeModel = "";
  const records: UsageRecord[] = [];

  try {
    forEachFileLineSync(filePath, (rawLine) => {
      if (!rawLine || rawLine.length < 5) return;
      if (!rawLine.includes('"usage"') && !rawLine.includes('"session"') && !rawLine.includes('"model_change"')) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;

      const type = parsed.type;

      if (type === "session") {
        if (!isArtifact && typeof parsed.id === "string") sessionId = parsed.id;
        if (!isArtifact && typeof parsed.cwd === "string") sessionCwd = parsed.cwd;
        if (typeof parsed.timestamp === "string") {
          const t = new Date(parsed.timestamp).getTime();
          if (!isNaN(t)) {
            sessionTimestamp = t;
            if (!isArtifact) sessionStarted = t;
          }
        }
        return;
      }

      if (type === "model_change") {
        if (typeof parsed.provider === "string") activeProvider = parsed.provider;
        if (typeof parsed.modelId === "string") activeModel = parsed.modelId;
        if (typeof parsed.model === "string") {
          if (parsed.model.includes("/")) {
            const parts = parsed.model.split("/");
            activeProvider = parts[0];
            activeModel = parts.slice(1).join("/");
          } else {
            activeModel = parsed.model;
          }
        }
        return;
      }

      if (type === "message" && isRecord(parsed.message)) {
        const msg = parsed.message;
        const role = msg.role;

        if (role === "assistant") {
          const provider = (typeof msg.provider === "string" && msg.provider) ? msg.provider : (activeProvider || "unknown");
          const model = (typeof msg.model === "string" && msg.model) ? msg.model : (activeModel || "unknown");
          const rawUsage = isRecord(msg.usage) ? msg.usage : undefined;

          if (rawUsage) {
            const input = typeof rawUsage.input === "number" ? rawUsage.input : 0;
            const output = typeof rawUsage.output === "number" ? rawUsage.output : 0;
            const reasoning = typeof rawUsage.reasoning === "number"
              ? rawUsage.reasoning
              : typeof rawUsage.reasoningTokens === "number"
                ? rawUsage.reasoningTokens
                : typeof rawUsage.thoughtTokens === "number"
                  ? rawUsage.thoughtTokens
                  : 0;
            const cacheRead = typeof rawUsage.cacheRead === "number" ? rawUsage.cacheRead : 0;
            const cacheWrite = typeof rawUsage.cacheWrite === "number" ? rawUsage.cacheWrite : 0;
            const totalTokens = typeof rawUsage.totalTokens === "number"
              ? rawUsage.totalTokens
              : input + output + cacheRead + cacheWrite;

            let timestamp = sessionTimestamp;
            if (typeof msg.timestamp === "number" && !isNaN(msg.timestamp)) {
              timestamp = msg.timestamp;
            } else if (typeof parsed.timestamp === "string") {
              const parsedTime = new Date(parsed.timestamp).getTime();
              if (!isNaN(parsedTime)) timestamp = parsedTime;
            }

            const rates = resolveModelRates(provider, model, customModelsConfig);
            const { cost, quality } = calculateUsageCost(rawUsage, rates);
            const cacheSavings = calculateCacheSavings(rawUsage, rates);

            if (totalTokens > 0 || cost > 0) {
              records.push({
                timestamp,
                sessionId,
                sessionCwd,
                provider,
                model,
                input,
                output,
                reasoning,
                cacheRead,
                cacheWrite,
                totalTokens,
                cost,
                cacheSavings,
                costQuality: quality,
                entryId: typeof parsed.id === "string" ? parsed.id : undefined,
                sessionStarted,
              });
            }
          }
        } else if (role === "toolResult" && msg.toolName === "task" && isRecord(msg.details)) {
          // A subagent that keeps its own transcript in the artifacts directory
          // is counted from that transcript, so the summary names the file it
          // duplicates and counts only while no copy of it has that transcript.
          // Its entry id (task entry id + subagent id) lets copies of this
          // summary made by /tan or a branch be recognized too (both decided per
          // report, see collectUncountedUsage in usage-db.ts). Background
          // subagents never report usage here at all.
          //
          // omp writes a spawn's transcript into the artifacts directory of the
          // session that ran the `task` call — that session's own file minus
          // `.jsonl` (leaseArtifacts in omp's task/structured-subagent.ts) — which
          // is the file this result is in, not the top-level owning session. So a
          // nested spawn `Parent.Child` whose result is in `<session>/Parent.jsonl`
          // lives at `<session>/Parent/Parent.Child.jsonl`.
          const results = Array.isArray(msg.details.results) ? msg.details.results : [];
          for (const [index, res] of results.entries()) {
            if (isRecord(res) && isRecord(res.usage)) {
              const subagentFile = typeof res.id === "string" && SUBAGENT_ID_RE.test(res.id)
                ? join(filePath.slice(0, -".jsonl".length), `${res.id}.jsonl`)
                : undefined;
              const u = res.usage;
              const subModel = typeof res.resolvedModel === "string"
                ? res.resolvedModel
                : typeof res.model === "string"
                  ? res.model
                  : activeModel || "unknown";
              const subProvider = typeof res.provider === "string" && res.provider
                ? res.provider
                : subModel.includes("/")
                  ? subModel.split("/")[0]
                  : activeProvider || "unknown";

              const input = typeof u.input === "number" ? u.input : 0;
              const output = typeof u.output === "number" ? u.output : 0;
              const reasoning = typeof u.reasoning === "number"
                ? u.reasoning
                : typeof u.reasoningTokens === "number"
                  ? u.reasoningTokens
                  : typeof u.thoughtTokens === "number"
                    ? u.thoughtTokens
                    : 0;
              const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
              const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
              const totalTokens = typeof u.totalTokens === "number" ? u.totalTokens : input + output + cacheRead + cacheWrite;

              let timestamp = sessionTimestamp;
              if (typeof msg.timestamp === "number" && !isNaN(msg.timestamp)) {
                timestamp = msg.timestamp;
              } else if (typeof parsed.timestamp === "string") {
                const parsedTime = new Date(parsed.timestamp).getTime();
                if (!isNaN(parsedTime)) timestamp = parsedTime;
              }

              const rates = resolveModelRates(subProvider, subModel, customModelsConfig);
              const { cost, quality } = calculateUsageCost(u, rates);
              const cacheSavings = calculateCacheSavings(u, rates);

              if (totalTokens > 0 || cost > 0) {
                records.push({
                  timestamp,
                  sessionId,
                  sessionCwd,
                  provider: subProvider,
                  model: subModel,
                  input,
                  output,
                  reasoning,
                  cacheRead,
                  cacheWrite,
                  totalTokens,
                  cost,
                  cacheSavings,
                  costQuality: quality,
                  entryId: typeof parsed.id === "string"
                    ? `${parsed.id}#${typeof res.id === "string" ? res.id : index}`
                    : undefined,
                  subagentFile,
                  sessionStarted,
                });
              }
            }
          }
        }
      }
    });
  } catch {
    // Return partially collected records on read error
  }

  setUsageCacheEntry(filePath, {
    parserVersion: USAGE_PARSER_VERSION,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    records,
    sessionTimestamp,
  });

  return records;
}

/**
 * Generate full usage report over all sessions according to query options.
 * Backed by the persistent local SQLite usage database.
 *
 * The scan reads every new/changed transcript, so it must never run on the
 * request path more than necessary: the last report for a query is served
 * immediately (`stale: true`) while one background rescan runs, and concurrent
 * requests for the same query share that rescan. A report younger than
 * {@link USAGE_REPORT_REFRESH_MS} is served as current without any rescan, and
 * one older than {@link USAGE_STALE_MAX_AGE_MS} is never served stale: that
 * request waits for the scan instead, so no caller is handed an arbitrarily
 * old report.
 * The scan itself runs in a worker (see usage-report-worker.ts): its
 * synchronous SQLite work must never block this server's event loop.
 */
export async function getUsageReport(options: UsageQueryOptions = {}): Promise<UsageReport> {
  const agentDir = getAgentDir();
  const key = usageReportKey(options, agentDir);

  if (options.forceRefresh) {
    const flights = getUsageReportFlights();
    // A refresh request while this query is already scanning joins that scan
    // instead of starting a second full pass. That scan syncs every changed
    // transcript, so it answers this refresh too.
    const inFlight = flights.get(key);
    if (inFlight) return inFlight;
    // An explicit refresh is never answered from the cache: the user asked for
    // a rescan, and the route's `refresh` parameter has no cooldown. Only the
    // per-file parses are dropped — the computed reports stay, because a failed
    // rescan must leave the last good report in place as a fallback.
    invalidateSessionUsageCache();
    invalidateSessionFileListCache();
    // Only this query's report is stale now; the other queries' cached reports
    // describe the same database, which the rescan rebuilds to the same rows.
    // This query's entry stays cached while the rescan runs and is replaced
    // only by a successful report (refreshUsageReport sets it): a failed
    // rescan must leave the last good report in place as a fallback instead of
    // deleting it and leaving the page with nothing.
    return runSingleFlight(flights, key, () => refreshUsageReport(key, options, agentDir));
  }

  const cached = getUsageReportCache().get(key);
  if (cached) {
    const age = Date.now() - cached.scannedAt;
    if (age < USAGE_REPORT_REFRESH_MS) {
      return { ...cached.report, stale: false, scannedAt: cached.scannedAt };
    }
    // Serve the cached report now; rescans are coalesced per query.
    const promise = runSingleFlight(getUsageReportFlights(), key, () => refreshUsageReport(key, options, agentDir));
    if (age >= USAGE_STALE_MAX_AGE_MS) return promise;
    promise.catch(() => {
      // A failed background rescan keeps the cached report; the next request retries.
    });
    return { ...cached.report, stale: true, scannedAt: cached.scannedAt };
  }

  const promise = runSingleFlight(getUsageReportFlights(), key, () => refreshUsageReport(key, options, agentDir));
  return promise;
}

/** Minimum age before a served report starts a background rescan. */
export const USAGE_REPORT_REFRESH_MS = 5_000;

/** Oldest report served while a rescan runs; past this the request waits for it. */
export const USAGE_STALE_MAX_AGE_MS = 5 * 60_000;

/** Number of query reports kept; the usage page asks for one or two at a time. */
const MAX_CACHED_USAGE_REPORTS = 24;

interface CachedUsageReport {
  report: UsageReport;
  scannedAt: number;
}

declare global {
  var __ompUsageReportCache: Map<string, CachedUsageReport> | undefined;
  var __ompUsageReportFlights: Map<string, Promise<UsageReport>> | undefined;
}

function getUsageReportCache(): Map<string, CachedUsageReport> {
  if (!globalThis.__ompUsageReportCache) globalThis.__ompUsageReportCache = new Map();
  return globalThis.__ompUsageReportCache;
}

function getUsageReportFlights(): Map<string, Promise<UsageReport>> {
  if (!globalThis.__ompUsageReportFlights) globalThis.__ompUsageReportFlights = new Map();
  return globalThis.__ompUsageReportFlights;
}

/** Query identity: two requests share a report only for the same window,
 *  granularity and filters — and the same agent dir (the DB it was read from). */
function usageReportKey(options: UsageQueryOptions, agentDir: string): string {
  return [
    agentDir,
    options.range ?? "",
    options.granularity ?? "",
    options.project ?? "",
    options.from ?? "",
    options.to ?? "",
  ].join("|");
}

async function refreshUsageReport(
  key: string,
  options: UsageQueryOptions,
  agentDir: string,
): Promise<UsageReport> {
  const report = await runUsageReportInWorker(options, agentDir);
  const cached: CachedUsageReport = { report, scannedAt: report.scannedAt };
  const cache = getUsageReportCache();
  cache.delete(key);
  cache.set(key, cached);
  while (cache.size > MAX_CACHED_USAGE_REPORTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { ...report, stale: false };
}
