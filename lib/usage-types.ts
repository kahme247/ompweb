export type UsageTimeRange = "today" | "7d" | "30d" | "90d" | "month" | "all";
export type UsageGranularity = "daily" | "monthly" | "projects";
export type UsageMetricView = "cost" | "tokens";
export type UsageBreakdownView = "model" | "day" | "project" | "host";
export type CostQualityTier = "provider_reported" | "model_priced" | "unpriced";

export interface ModelRates {
  input: number;      // USD per million tokens
  output: number;     // USD per million tokens
  cacheRead: number;  // USD per million tokens
  cacheWrite: number; // USD per million tokens
}

export interface UsageRecord {
  timestamp: number;
  sessionId: string;
  sessionCwd: string;
  provider: string;
  model: string;
  input: number;        // uncached input tokens
  output: number;       // output tokens
  reasoning: number;    // reasoning / thought tokens
  cacheRead: number;    // prompt cache read tokens
  cacheWrite: number;   // prompt cache write tokens
  totalTokens: number;
  cost: number;         // USD
  cacheSavings: number; // USD
  costQuality: CostQualityTier;
  /**
   * Id of the transcript entry the usage came from (for a `task` result
   * summary: the task entry id + `#` + the subagent id). omp copies entries
   * with their ids and timestamps (`/tan`, `/fork`, branches), so the same id
   * + timestamp in several files is one billed request.
   */
  entryId?: string;
  /**
   * For a `task` result summary: the subagent transcript it duplicates
   * (`<artifacts dir>/<id>.jsonl`). The summary only counts while neither it
   * nor a copy of it has that transcript with usage from before the summary,
   * since the transcript is counted in full.
   */
  subagentFile?: string;
  /**
   * Start of the session that owns the transcript (its header timestamp).
   * Among copies of one request, the earliest-started session's row counts.
   */
  sessionStarted: number;
}

export interface UsageSummary {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheSavings: number;
  activeDays: number;
  tokensPerActiveDay: number;
  cachePercentage: number;
  costQuality: {
    providerReported: number; // percentage 0-100
    modelPriced: number;      // percentage 0-100
    unpriced: number;         // percentage 0-100
  };
}

export interface ProviderUsageSummary {
  provider: string;
  name: string;
  cost: number;
  tokens: number;
  share: number; // 0-100 percentage of total cost (or total tokens if total cost is 0)
  color: string;
}

export interface ModelUsageSummary {
  model: string;
  provider: string;
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  share: number; // 0-100 percentage
  recordsCount: number;
}

export interface TimeSeriesPoint {
  date: string; // ISO format: "YYYY-MM-DD" or "YYYY-MM"
  label: string; // e.g. "Aug 3", "Sep 1", "2026-08"
  timestamp: number;
  totalCost: number;
  totalTokens: number;
  byProvider: Record<string, { cost: number; tokens: number }>;
}

export interface DayUsageSummary {
  date: string; // "YYYY-MM-DD"
  label: string; // e.g. "Aug 3, 2026"
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  share: number; // 0-100 percentage
}

export interface ProjectUsageSummary {
  project: string; // directory path
  projectName: string; // display folder name
  hostId: string;
  hostLabel: string;
  cost: number;
  tokens: number;
  share: number; // 0-100 percentage
  sessionsCount: number;
}

export interface UsageReportScanInfo {
  transcriptsScanned: number;
  transcriptsOutsideWindow: number;
  usageRecordsCount: number;
  durationSeconds: number;
  scannedAt: number;
}

export interface UsageReport {
  timeRange: UsageTimeRange;
  granularity: UsageGranularity;
  summary: UsageSummary;
  providers: ProviderUsageSummary[];
  timeSeries: TimeSeriesPoint[];
  modelBreakdown: ModelUsageSummary[];
  dayBreakdown: DayUsageSummary[];
  projectBreakdown: ProjectUsageSummary[];
  hostBreakdown: HostUsageSummary[];
  scanInfo: UsageReportScanInfo;
}

export interface UsageQueryOptions {
  range?: UsageTimeRange;
  granularity?: UsageGranularity;
  project?: string;
  from?: number;
  to?: number;
  forceRefresh?: boolean;
}

/** One transcript as its host last saw it; a changed stamp means it must be read again. */
export interface UsageTranscriptStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface UsageSessionStamps {
  session: string;
  transcripts: UsageTranscriptStamp[];
}

/** Every transcript the host counts usage from. The host fails the op rather than leave one out it cannot examine. */
export interface UsageTranscriptIndex {
  parserVersion: number;
  sessions: UsageSessionStamps[];
}

export interface UsageReadRequest {
  session: string;
  paths: string[];
  /** Records of `paths[0]` that earlier answers delivered: this one continues after them. */
  skip?: number;
}

export interface UsageTranscriptRecords extends UsageTranscriptStamp {
  records: UsageRecord[];
  /** The transcript has more records than one answer holds: ask for it again, skipping the ones received. */
  more?: boolean;
}

/** `missing`: gone, or not a transcript this host lists. A path asked for and in neither list was not reached within
 * the page limits: ask again. A file with `more` is the last of its page. */
export interface UsageRecordsPage {
  files: UsageTranscriptRecords[];
  missing: string[];
}

/** `stale`: the last pull failed. `unsupported`: the host's daemon predates the usage ops. */
export type HostUsageSyncState = "current" | "syncing" | "offline" | "stale" | "unsupported";

export interface HostUsageStatus {
  hostId: string;
  label: string;
  state: HostUsageSyncState;
  /** When the stored rows were last brought up to date; null before the first full pull. */
  syncedAt: number | null;
}

export interface HostUsageSummary extends HostUsageStatus {
  cost: number;
  tokens: number;
  share: number; // 0-100 percentage
  sessionsCount: number;
}
