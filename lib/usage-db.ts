import { existsSync, mkdirSync, statSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "path";
import { readModelsConfig, type ModelsFileConfig } from "./omp/models-config";
import { getAgentDir, getSessionsDir } from "./omp/paths";
import { listSessionFiles } from "./omp/session-files";
import {
  formatChartDateLabel,
  formatFullDateLabel,
  parseSessionUsage,
  toLocalDateString,
  toLocalMonthString,
  computeTimeRangeBounds,
} from "./usage-service";
import { getProviderColor, getProviderDisplayName } from "./usage-rates";
import type {
  DayUsageSummary,
  ModelUsageSummary,
  ProjectUsageSummary,
  ProviderUsageSummary,
  TimeSeriesPoint,
  UsageQueryOptions,
  UsageRecord,
  UsageReport,
  UsageSummary,
} from "./usage-types";

declare global {
  var __ompUsageDatabase: DatabaseSync | undefined;
  var __ompUsageDatabasePath: string | undefined;
}

/** Get the path to the usage SQLite database file (~/.omp/agent/usage.db). */
export function getUsageDbPath(): string {
  const dir = getAgentDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "usage.db");
}

/**
 * Open or reuse the persistent SQLite database for usage tracking.
 */
export function getUsageDatabase(customPath?: string): DatabaseSync {
  const targetPath = customPath || getUsageDbPath();

  if (globalThis.__ompUsageDatabase && globalThis.__ompUsageDatabasePath === targetPath) {
    return globalThis.__ompUsageDatabase;
  }

  if (globalThis.__ompUsageDatabase) {
    try {
      globalThis.__ompUsageDatabase.close();
    } catch {
      // Ignore close error on re-init
    }
  }

  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(targetPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS synced_files (
      file_path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      file_size INTEGER NOT NULL,
      records_count INTEGER NOT NULL,
      synced_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_cwd TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      cache_savings REAL NOT NULL,
      cost_quality TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_file_path ON usage_records(file_path);
    CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider);
    CREATE INDEX IF NOT EXISTS idx_usage_records_session_cwd ON usage_records(session_cwd);
  `);

  globalThis.__ompUsageDatabase = db;
  globalThis.__ompUsageDatabasePath = targetPath;
  return db;
}

/** Close the usage database instance. */
export function closeUsageDatabase(): void {
  if (globalThis.__ompUsageDatabase) {
    try {
      globalThis.__ompUsageDatabase.close();
    } catch {
      // Ignore
    }
    globalThis.__ompUsageDatabase = undefined;
    globalThis.__ompUsageDatabasePath = undefined;
  }
}

export interface SyncStats {
  filesScanned: number;
  filesUpdated: number;
  filesDeleted: number;
  recordsInserted: number;
}

/**
 * Incrementally sync all session .jsonl files into the SQLite usage database.
 * Only parses files that are new or whose mtime/size has changed.
 */
export function syncSessionFilesToDb(
  sessionFiles: string[],
  customModelsConfig: ModelsFileConfig = readModelsConfig(),
  customDb?: DatabaseSync,
): SyncStats {
  const db = customDb || getUsageDatabase();
  const now = Date.now();

  // 1. Fetch currently synced files from SQLite
  const syncedRows = db.prepare("SELECT file_path, mtime_ms, file_size FROM synced_files").all() as Array<{
    file_path: string;
    mtime_ms: number;
    file_size: number;
  }>;

  const syncedMap = new Map<string, { mtime_ms: number; file_size: number }>();
  for (const row of syncedRows) {
    syncedMap.set(row.file_path, { mtime_ms: row.mtime_ms, file_size: row.file_size });
  }

  let filesUpdated = 0;
  let recordsInserted = 0;

  const insertRecordStmt = db.prepare(`
    INSERT INTO usage_records (
      file_path, session_id, session_cwd, timestamp, provider, model,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
      cache_write_tokens, total_tokens, cost, cache_savings, cost_quality
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `);

  const deleteRecordsStmt = db.prepare("DELETE FROM usage_records WHERE file_path = ?");
  const upsertSyncedFileStmt = db.prepare(`
    INSERT OR REPLACE INTO synced_files (file_path, mtime_ms, file_size, records_count, synced_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const currentFilesSet = new Set<string>();

  // 2. Incremental sync for new / modified files
  for (const filePath of sessionFiles) {
    let stats;
    try {
      stats = statSync(filePath);
      if (!stats.isFile() || stats.size === 0) continue;
    } catch {
      continue;
    }
    currentFilesSet.add(filePath);
    const existing = syncedMap.get(filePath);
    if (existing && existing.mtime_ms === stats.mtimeMs && existing.file_size === stats.size) {
      // File has not changed since last sync
      continue;
    }

    // Parse records from disk
    const records: UsageRecord[] = parseSessionUsage(filePath, customModelsConfig);

    // Save in transaction
    db.exec("BEGIN TRANSACTION;");
    try {
      deleteRecordsStmt.run(filePath);

      for (const r of records) {
        insertRecordStmt.run(
          filePath,
          r.sessionId,
          r.sessionCwd,
          r.timestamp,
          r.provider,
          r.model,
          r.input,
          r.output,
          r.reasoning,
          r.cacheRead,
          r.cacheWrite,
          r.totalTokens,
          r.cost,
          r.cacheSavings,
          r.costQuality,
        );
        recordsInserted++;
      }

      upsertSyncedFileStmt.run(filePath, stats.mtimeMs, stats.size, records.length, now);
      db.exec("COMMIT;");
      filesUpdated++;
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  // 3. Purge deleted session files
  let filesDeleted = 0;
  const deleteSyncedFileStmt = db.prepare("DELETE FROM synced_files WHERE file_path = ?");

  for (const filePath of syncedMap.keys()) {
    if (!currentFilesSet.has(filePath) || !existsSync(filePath)) {
      db.exec("BEGIN TRANSACTION;");
      try {
        deleteRecordsStmt.run(filePath);
        deleteSyncedFileStmt.run(filePath);
        db.exec("COMMIT;");
        filesDeleted++;
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }
    }
  }

  return {
    filesScanned: sessionFiles.length,
    filesUpdated,
    filesDeleted,
    recordsInserted,
  };
}

/**
 * Execute SQL analytics queries over the SQLite database to generate a full UsageReport.
 */
export async function getUsageReportFromDb(
  options: UsageQueryOptions = {},
  customDb?: DatabaseSync,
): Promise<UsageReport> {
  const startTime = Date.now();
  const timeRange = options.range || "30d";
  const granularity = options.granularity || "daily";
  const projectFilter = options.project ? options.project.trim().toLowerCase() : undefined;

  const db = customDb || getUsageDatabase();
  if (options.forceRefresh) {
    try {
      db.exec("DELETE FROM synced_files; DELETE FROM usage_records;");
    } catch {
      // Ignore
    }
  }

  // Sync latest sessions from disk before querying
  const sessionsDir = getSessionsDir();
  const sessionFiles = existsSync(sessionsDir) ? await listSessionFiles(sessionsDir) : [];
  syncSessionFilesToDb(sessionFiles, readModelsConfig(), db);
  const hasExplicitBounds =
    typeof options.from === "number" &&
    typeof options.to === "number" &&
    !isNaN(options.from) &&
    !isNaN(options.to);

  const { startMs, endMs } = hasExplicitBounds
    ? { startMs: options.from!, endMs: options.to! }
    : computeTimeRangeBounds(timeRange, startTime);

  // Build WHERE clause
  const params: (number | string)[] = [startMs, endMs];
  let whereProject = "";
  if (projectFilter) {
    whereProject = " AND LOWER(session_cwd) LIKE ? ";
    params.push(`%${projectFilter}%`);
  }

  // 1. Summary Query
  const summaryRow = db
    .prepare(
      `
      SELECT
        COUNT(*) AS usageRecordsCount,
        COALESCE(SUM(cost), 0) AS totalCost,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(cache_savings), 0) AS cacheSavings,
        COUNT(DISTINCT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime')) AS activeDays,
        SUM(CASE WHEN cost_quality = 'provider_reported' THEN 1 ELSE 0 END) AS providerReportedCount,
        SUM(CASE WHEN cost_quality = 'model_priced' THEN 1 ELSE 0 END) AS modelPricedCount,
        SUM(CASE WHEN cost_quality = 'unpriced' THEN 1 ELSE 0 END) AS unpricedCount
      FROM usage_records
      WHERE timestamp >= ? AND timestamp <= ? ${whereProject}
    `,
    )
    .get(...params) as Record<string, number>;

  const totalCost = summaryRow?.totalCost ?? 0;
  const totalTokens = summaryRow?.totalTokens ?? 0;
  const inputTokens = summaryRow?.inputTokens ?? 0;
  const outputTokens = summaryRow?.outputTokens ?? 0;
  const reasoningTokens = summaryRow?.reasoningTokens ?? 0;
  const cacheReadTokens = summaryRow?.cacheReadTokens ?? 0;
  const cacheWriteTokens = summaryRow?.cacheWriteTokens ?? 0;
  const cacheSavings = summaryRow?.cacheSavings ?? 0;
  const activeDays = summaryRow?.activeDays ?? 0;
  const totalRecords = summaryRow?.usageRecordsCount ?? 0;

  const costQuality = {
    providerReported: totalRecords > 0 ? ((summaryRow.providerReportedCount || 0) / totalRecords) * 100 : 0,
    modelPriced: totalRecords > 0 ? ((summaryRow.modelPricedCount || 0) / totalRecords) * 100 : 0,
    unpriced: totalRecords > 0 ? ((summaryRow.unpricedCount || 0) / totalRecords) * 100 : 0,
  };

  const tokensPerActiveDay = activeDays > 0 ? Math.round(totalTokens / activeDays) : 0;
  const cachePercentage =
    cacheReadTokens + inputTokens > 0 ? (cacheReadTokens / (cacheReadTokens + inputTokens)) * 100 : 0;

  const summary: UsageSummary = {
    totalCost,
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheSavings,
    activeDays,
    tokensPerActiveDay,
    cachePercentage,
    costQuality,
  };

  // 2. Providers Query
  const providerRows = db
    .prepare(
      `
      SELECT
        provider,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens
      FROM usage_records
      WHERE timestamp >= ? AND timestamp <= ? ${whereProject}
      GROUP BY provider
      ORDER BY cost DESC, tokens DESC
    `,
    )
    .all(...params) as Array<{ provider: string; cost: number; tokens: number }>;

  const providers: ProviderUsageSummary[] = providerRows.map((row) => {
    const share =
      totalCost > 0
        ? (row.cost / totalCost) * 100
        : totalTokens > 0
          ? (row.tokens / totalTokens) * 100
          : 0;
    return {
      provider: row.provider,
      name: getProviderDisplayName(row.provider),
      cost: row.cost,
      tokens: row.tokens,
      share,
      color: getProviderColor(row.provider),
    };
  });

  // 3. Time Series Query
  const isMonthly = granularity === "monthly";
  const strftimeFormat = isMonthly ? "%Y-%m" : "%Y-%m-%d";

  const timeSeriesRows = db
    .prepare(
      `
      SELECT
        strftime('${strftimeFormat}', timestamp / 1000, 'unixepoch', 'localtime') AS bucketDate,
        provider,
        MIN(timestamp) AS minTimestamp,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens
      FROM usage_records
      WHERE timestamp >= ? AND timestamp <= ? ${whereProject}
      GROUP BY bucketDate, provider
      ORDER BY bucketDate ASC
    `,
    )
    .all(...params) as Array<{
    bucketDate: string;
    provider: string;
    minTimestamp: number;
    cost: number;
    tokens: number;
  }>;

  const timeSeriesMap = new Map<
    string,
    {
      timestamp: number;
      totalCost: number;
      totalTokens: number;
      byProvider: Record<string, { cost: number; tokens: number }>;
    }
  >();

  // Continuous bucket interpolation (bounded to prevent multi-decade stalls)
  if (startMs > 0 && endMs >= startMs) {
    const cur = new Date(startMs);
    const end = new Date(endMs);
    const maxDailySpanMs = 730 * 86400 * 1000;
    const maxMonthlySpanMonths = 120;

    if (isMonthly) {
      cur.setDate(1);
      let monthsCount = 0;
      while (
        (cur <= end || toLocalMonthString(cur) === toLocalMonthString(end)) &&
        monthsCount < maxMonthlySpanMonths
      ) {
        const key = toLocalMonthString(cur);
        if (!timeSeriesMap.has(key)) {
          timeSeriesMap.set(key, {
            timestamp: cur.getTime(),
            totalCost: 0,
            totalTokens: 0,
            byProvider: {},
          });
        }
        cur.setMonth(cur.getMonth() + 1);
        monthsCount++;
      }
    } else {
      if (end.getTime() - cur.getTime() > maxDailySpanMs) {
        cur.setTime(end.getTime() - maxDailySpanMs);
      }
      let daysCount = 0;
      while ((cur <= end || toLocalDateString(cur) === toLocalDateString(end)) && daysCount < 730) {
        const key = toLocalDateString(cur);
        if (!timeSeriesMap.has(key)) {
          timeSeriesMap.set(key, {
            timestamp: cur.getTime(),
            totalCost: 0,
            totalTokens: 0,
            byProvider: {},
          });
        }
        cur.setDate(cur.getDate() + 1);
        daysCount++;
      }
    }
  }

  // Populate actual data points from SQL rows
  for (const row of timeSeriesRows) {
    const key = row.bucketDate;
    let bucket = timeSeriesMap.get(key);
    if (!bucket) {
      bucket = {
        timestamp: row.minTimestamp,
        totalCost: 0,
        totalTokens: 0,
        byProvider: {},
      };
      timeSeriesMap.set(key, bucket);
    }

    bucket.totalCost += row.cost;
    bucket.totalTokens += row.tokens;

    if (!bucket.byProvider[row.provider]) {
      bucket.byProvider[row.provider] = { cost: 0, tokens: 0 };
    }
    bucket.byProvider[row.provider].cost += row.cost;
    bucket.byProvider[row.provider].tokens += row.tokens;
  }

  const timeSeries: TimeSeriesPoint[] = Array.from(timeSeriesMap.entries())
    .map(([date, data]) => ({
      date,
      label: formatChartDateLabel(date, isMonthly),
      timestamp: data.timestamp,
      totalCost: data.totalCost,
      totalTokens: data.totalTokens,
      byProvider: data.byProvider,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 4. Model Breakdown Query
  const modelRows = db
    .prepare(
      `
      SELECT
        model,
        provider,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
        COUNT(*) AS recordsCount
      FROM usage_records
      WHERE timestamp >= ? AND timestamp <= ? ${whereProject}
      GROUP BY model, provider
      ORDER BY cost DESC, tokens DESC
    `,
    )
    .all(...params) as Array<{
    model: string;
    provider: string;
    cost: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    recordsCount: number;
  }>;

  const modelBreakdown: ModelUsageSummary[] = modelRows.map((row) => ({
    ...row,
    share:
      totalCost > 0
        ? (row.cost / totalCost) * 100
        : totalTokens > 0
          ? (row.tokens / totalTokens) * 100
          : 0,
  }));

  // 5. Day Breakdown Query
  const dayRows = db
    .prepare(
      `
      SELECT
        strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') AS date,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens
      FROM usage_records
      WHERE timestamp >= ? AND timestamp <= ? ${whereProject}
      GROUP BY date
      ORDER BY date DESC
    `,
    )
    .all(...params) as Array<{
    date: string;
    cost: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  }>;

  const dayBreakdown: DayUsageSummary[] = dayRows.map((row) => ({
    ...row,
    label: formatFullDateLabel(row.date),
    share:
      totalCost > 0
        ? (row.cost / totalCost) * 100
        : totalTokens > 0
          ? (row.tokens / totalTokens) * 100
          : 0,
  }));

  // 6. Project Breakdown Query
  const projectRows = db
    .prepare(
      `
      SELECT
        session_cwd AS project,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COUNT(DISTINCT session_id) AS sessionsCount
      FROM usage_records
      WHERE timestamp >= ? AND timestamp <= ? ${whereProject}
      GROUP BY session_cwd
      ORDER BY cost DESC, tokens DESC
    `,
    )
    .all(...params) as Array<{
    project: string;
    cost: number;
    tokens: number;
    sessionsCount: number;
  }>;

  const projectBreakdown: ProjectUsageSummary[] = projectRows.map((row) => ({
    project: row.project || "Default Project",
    projectName: basename(row.project || "Default Project") || row.project,
    cost: row.cost,
    tokens: row.tokens,
    share:
      totalCost > 0
        ? (row.cost / totalCost) * 100
        : totalTokens > 0
          ? (row.tokens / totalTokens) * 100
          : 0,
    sessionsCount: row.sessionsCount,
  }));

  // Scan info
  const totalSyncedRow = db.prepare("SELECT COUNT(*) as c FROM synced_files").get() as { c: number };
  const inWindowSyncedRow = db
    .prepare(
      `
      SELECT COUNT(DISTINCT file_path) as c
      FROM usage_records
      WHERE timestamp >= ? AND timestamp <= ? ${whereProject}
    `,
    )
    .get(...params) as { c: number };

  const transcriptsScanned = totalSyncedRow?.c ?? sessionFiles.length;
  const transcriptsInWindow = inWindowSyncedRow?.c ?? 0;
  const transcriptsOutsideWindow = Math.max(0, transcriptsScanned - transcriptsInWindow);
  const durationSeconds = Math.max(0.001, (Date.now() - startTime) / 1000);

  return {
    timeRange,
    granularity,
    summary,
    providers,
    timeSeries,
    modelBreakdown,
    dayBreakdown,
    projectBreakdown,
    scanInfo: {
      transcriptsScanned,
      transcriptsOutsideWindow,
      usageRecordsCount: totalRecords,
      durationSeconds: parseFloat(durationSeconds.toFixed(3)),
      scannedAt: Date.now(),
    },
  };
}
