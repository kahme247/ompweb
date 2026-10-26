export type ProviderUsageWindowId = "5h" | "7d" | "monthly";

export interface ProviderUsageWindow {
  percent: number;
  resetMinutes?: number;
  resetHours?: number;
}

export interface ProviderUsageReport {
  provider: string;
  accountLabel?: string;
  accountIndex?: number;
  plan?: string;
  modelId?: string;
  tier?: string;
  /**
   * Human bucket name for providers whose quotas split by backend counter
   * rather than by model/tier — currently Antigravity ("Gemini",
   * "Claude & GPT (shared)", "Anthropic", "OpenAI"). Anthropic's Fable
   * bucket is carried by `tier` instead and needs no bucket.
   */
  bucket?: string;
  noLimits?: boolean;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
}

export interface ProviderUsageSnapshot {
  generatedAt: number | null;
  reports: ProviderUsageReport[];
}

export interface ProviderUsageContext {
  provider: string;
  modelId: string;
}
