export type UsageTimeRange = "today" | "7d" | "30d" | "90d" | "month" | "all";
export type UsageGranularity = "daily" | "monthly" | "projects";
export type UsageMetricView = "cost" | "tokens";
export type UsageBreakdownView = "model" | "day" | "project" | "session";
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
  cost: number;
  tokens: number;
  share: number; // 0-100 percentage
  sessionsCount: number;
}

/** One model's slice of a conversation's usage. */
export interface SessionModelUsage {
  model: string;
  provider: string;
  cost: number;
  tokens: number;
}

/**
 * Usage of one conversation (session), including its subagent, advisor and
 * other artifact transcripts, which are attributed to the owning session.
 */
export interface SessionUsageSummary {
  sessionId: string;
  /** Session title, else its first message, else the session id. */
  title: string;
  project: string; // session cwd
  projectName: string; // display folder name
  /** Models used, most expensive first. */
  models: SessionModelUsage[];
  cost: number;
  tokens: number;
  share: number; // 0-100 percentage
  requestsCount: number;
  lastActiveAt: number; // ms timestamp of the newest request in the window
  /** The session is no longer in the session list (deleted), so it cannot be opened. */
  deleted: boolean;
  /** The session file is past omp-web's load ceiling (MAX_SESSION_LOAD_BYTES), so it cannot be opened here. */
  tooLarge: boolean;
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
  /** Per conversation, most expensive first. */
  sessionBreakdown: SessionUsageSummary[];
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
