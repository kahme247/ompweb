import { statSync } from "fs";
import { basename } from "path";
import { readModelsConfig } from "./omp/models-config";
import { forEachFileLineSync, invalidateSessionFileListCache } from "./omp/session-files";
import { isRecord } from "./type-guards";
import {
  calculateCacheSavings,
  calculateUsageCost,
  resolveModelRates,
} from "./usage-rates";
import { getUsageReportFromDb } from "./usage-db";
import type {
  UsageQueryOptions,
  UsageRecord,
  UsageReport,
  UsageTimeRange,
} from "./usage-types";

interface SessionUsageCacheEntry {
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

/** Clear in-memory usage cache (useful on session mutation or manual refresh). */
export function invalidateUsageCache(): void {
  globalThis.__ompUsageCache?.clear();
  usageCacheApproxBytes = 0;
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
 * Parse an individual session .jsonl file and extract all Assistant usage records.
 * Uses mtime + file size cache to avoid disk reading on subsequent requests.
 */
export function parseSessionUsage(filePath: string, customModelsConfig = readModelsConfig()): UsageRecord[] {
  let stats;
  try {
    stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0) return [];
  } catch {
    return [];
  }

  const cache = getUsageCache();
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.records;
  }

  let sessionId = basename(filePath, ".jsonl");
  let sessionCwd = "";
  let sessionTimestamp = stats.mtimeMs;
  let activeProvider = "";
  let activeModel = "";
  const records: UsageRecord[] = [];

  try {
    forEachFileLineSync(filePath, (rawLine) => {
      if (!rawLine || rawLine.length < 5) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;

      const type = parsed.type;

      if (type === "session") {
        if (typeof parsed.id === "string") sessionId = parsed.id;
        if (typeof parsed.cwd === "string") sessionCwd = parsed.cwd;
        if (typeof parsed.timestamp === "string") {
          const t = new Date(parsed.timestamp).getTime();
          if (!isNaN(t)) sessionTimestamp = t;
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
              });
            }
          }
        } else if (role === "toolResult" && msg.toolName === "task" && isRecord(msg.details)) {
          // Subagent task dispatches may carry usage results
          const results = Array.isArray(msg.details.results) ? msg.details.results : [];
          for (const res of results) {
            if (isRecord(res) && isRecord(res.usage)) {
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
 */
export async function getUsageReport(options: UsageQueryOptions = {}): Promise<UsageReport> {
  if (options.forceRefresh) {
    invalidateUsageCache();
    invalidateSessionFileListCache();
  }
  return getUsageReportFromDb(options);
}
