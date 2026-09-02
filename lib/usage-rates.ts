import type { ModelsFileConfig } from "./omp/models-config";
import type { CostQualityTier, ModelRates } from "./usage-types";

/**
 * Built-in standard per-million token pricing rates (USD) for major LLM families.
 * Rates represent: { input, output, cacheRead, cacheWrite } in USD per 1,000,000 tokens.
 */
export const DEFAULT_MODEL_RATES: Record<string, ModelRates> = {
  // --- Anthropic ---
  "claude-3-7-sonnet": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-7-sonnet-latest": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet-latest": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  "claude-3-opus": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-3-opus-latest": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-3-haiku": { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 },
  "claude-sonnet-4": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },

  // --- OpenAI ---
  "gpt-4o": { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 2.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  "gpt-4o-2024-11-20": { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 2.5 },
  "gpt-4o-2024-08-06": { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 2.5 },
  "gpt-4o-2024-05-13": { input: 5.0, output: 15.0, cacheRead: 2.5, cacheWrite: 5.0 },
  "chatgpt-4o-latest": { input: 5.0, output: 15.0, cacheRead: 2.5, cacheWrite: 5.0 },
  "gpt-4-turbo": { input: 10.0, output: 30.0, cacheRead: 5.0, cacheWrite: 10.0 },
  "gpt-4": { input: 30.0, output: 60.0, cacheRead: 30.0, cacheWrite: 30.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5, cacheRead: 0.5, cacheWrite: 0.5 },
  "o1": { input: 15.0, output: 60.0, cacheRead: 7.5, cacheWrite: 15.0 },
  "o1-preview": { input: 15.0, output: 60.0, cacheRead: 7.5, cacheWrite: 15.0 },
  "o1-mini": { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
  "o3": { input: 15.0, output: 60.0, cacheRead: 7.5, cacheWrite: 15.0 },
  "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
  "gpt-5": { input: 5.0, output: 20.0, cacheRead: 2.5, cacheWrite: 5.0 },

  // --- Google Gemini ---
  "gemini-2.5-pro": { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
  "gemini-2.0-pro": { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },

  // --- DeepSeek ---
  "deepseek-chat": { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  "deepseek-v3": { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  "deepseek-r1": { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },

  // --- Mistral ---
  "mistral-large": { input: 2.0, output: 6.0, cacheRead: 2.0, cacheWrite: 2.0 },
  "mistral-small": { input: 0.2, output: 0.6, cacheRead: 0.2, cacheWrite: 0.2 },
  "codestral": { input: 0.3, output: 0.9, cacheRead: 0.3, cacheWrite: 0.3 },
  "devstral": { input: 0.3, output: 0.9, cacheRead: 0.3, cacheWrite: 0.3 },
  "ministral-8b": { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1 },
  "ministral-3b": { input: 0.04, output: 0.04, cacheRead: 0.04, cacheWrite: 0.04 },

  // --- Meta / Open Source / Qwen ---
  "llama-3.3-70b": { input: 0.59, output: 0.79, cacheRead: 0.59, cacheWrite: 0.59 },
  "llama-3.1-70b": { input: 0.59, output: 0.79, cacheRead: 0.59, cacheWrite: 0.59 },
  "llama-3.1-8b": { input: 0.05, output: 0.08, cacheRead: 0.05, cacheWrite: 0.05 },
  "llama-3.1-405b": { input: 2.5, output: 3.0, cacheRead: 2.5, cacheWrite: 2.5 },
  "qwen-2.5-coder-32b": { input: 0.2, output: 0.2, cacheRead: 0.2, cacheWrite: 0.2 },
  "qwen-2.5-72b": { input: 0.35, output: 0.4, cacheRead: 0.35, cacheWrite: 0.35 },
  "qwen-max": { input: 1.6, output: 6.4, cacheRead: 0.4, cacheWrite: 1.6 },
  "qwen-plus": { input: 0.4, output: 1.2, cacheRead: 0.1, cacheWrite: 0.4 },
  "qwen-turbo": { input: 0.05, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05 },
};

/**
 * Prefix/Regex pattern rules for matching versioned or full model names to default rates.
 */
const MODEL_PREFIX_RULES: Array<{ pattern: RegExp; rates: ModelRates }> = [
  { pattern: /claude-3[.-]7[.-]sonnet/i, rates: DEFAULT_MODEL_RATES["claude-3-7-sonnet"] },
  { pattern: /claude-3[.-]5[.-]sonnet/i, rates: DEFAULT_MODEL_RATES["claude-3-5-sonnet"] },
  { pattern: /claude-3[.-]5[.-]haiku/i, rates: DEFAULT_MODEL_RATES["claude-3-5-haiku"] },
  { pattern: /claude-3[.-]opus/i, rates: DEFAULT_MODEL_RATES["claude-3-opus"] },
  { pattern: /claude-3[.-]haiku/i, rates: DEFAULT_MODEL_RATES["claude-3-haiku"] },
  { pattern: /claude-sonnet-4/i, rates: DEFAULT_MODEL_RATES["claude-sonnet-4"] },
  { pattern: /claude-opus-4/i, rates: DEFAULT_MODEL_RATES["claude-opus-4"] },
  { pattern: /gpt-4o-mini/i, rates: DEFAULT_MODEL_RATES["gpt-4o-mini"] },
  { pattern: /gpt-4o/i, rates: DEFAULT_MODEL_RATES["gpt-4o"] },
  { pattern: /gpt-4-turbo/i, rates: DEFAULT_MODEL_RATES["gpt-4-turbo"] },
  { pattern: /gpt-4/i, rates: DEFAULT_MODEL_RATES["gpt-4"] },
  { pattern: /gpt-3\.5-turbo/i, rates: DEFAULT_MODEL_RATES["gpt-3.5-turbo"] },
  { pattern: /o1-mini/i, rates: DEFAULT_MODEL_RATES["o1-mini"] },
  { pattern: /o1-preview/i, rates: DEFAULT_MODEL_RATES["o1-preview"] },
  { pattern: /o1\b/i, rates: DEFAULT_MODEL_RATES["o1"] },
  { pattern: /o3-mini/i, rates: DEFAULT_MODEL_RATES["o3-mini"] },
  { pattern: /o3\b/i, rates: DEFAULT_MODEL_RATES["o3"] },
  { pattern: /gemini-2\.5-pro/i, rates: DEFAULT_MODEL_RATES["gemini-2.5-pro"] },
  { pattern: /gemini-2\.5-flash/i, rates: DEFAULT_MODEL_RATES["gemini-2.5-flash"] },
  { pattern: /gemini-2\.0-flash-lite/i, rates: DEFAULT_MODEL_RATES["gemini-2.0-flash-lite"] },
  { pattern: /gemini-2\.0-flash/i, rates: DEFAULT_MODEL_RATES["gemini-2.0-flash"] },
  { pattern: /gemini-2\.0-pro/i, rates: DEFAULT_MODEL_RATES["gemini-2.0-pro"] },
  { pattern: /gemini-1\.5-pro/i, rates: DEFAULT_MODEL_RATES["gemini-1.5-pro"] },
  { pattern: /gemini-1\.5-flash/i, rates: DEFAULT_MODEL_RATES["gemini-1.5-flash"] },
  { pattern: /deepseek.*r1/i, rates: DEFAULT_MODEL_RATES["deepseek-r1"] },
  { pattern: /deepseek.*reasoner/i, rates: DEFAULT_MODEL_RATES["deepseek-reasoner"] },
  { pattern: /deepseek.*v3/i, rates: DEFAULT_MODEL_RATES["deepseek-v3"] },
  { pattern: /deepseek.*chat/i, rates: DEFAULT_MODEL_RATES["deepseek-chat"] },
  { pattern: /codestral/i, rates: DEFAULT_MODEL_RATES["codestral"] },
  { pattern: /mistral-large/i, rates: DEFAULT_MODEL_RATES["mistral-large"] },
  { pattern: /mistral-small/i, rates: DEFAULT_MODEL_RATES["mistral-small"] },
  { pattern: /llama-3\.3-70b/i, rates: DEFAULT_MODEL_RATES["llama-3.3-70b"] },
  { pattern: /llama-3\.1-70b/i, rates: DEFAULT_MODEL_RATES["llama-3.1-70b"] },
  { pattern: /llama-3\.1-8b/i, rates: DEFAULT_MODEL_RATES["llama-3.1-8b"] },
  { pattern: /llama-3\.1-405b/i, rates: DEFAULT_MODEL_RATES["llama-3.1-405b"] },
  { pattern: /qwen.*coder.*32b/i, rates: DEFAULT_MODEL_RATES["qwen-2.5-coder-32b"] },
  { pattern: /qwen.*72b/i, rates: DEFAULT_MODEL_RATES["qwen-2.5-72b"] },
];

/**
 * Normalize model identifier by stripping provider prefix (e.g. "anthropic/claude-3-7-sonnet" -> "claude-3-7-sonnet")
 * and variant suffixes like ":thinking".
 */
export function normalizeModelId(modelId: string): string {
  if (!modelId) return "";
  let clean = modelId.trim().toLowerCase();
  if (clean.includes("/")) {
    clean = clean.split("/").pop() || clean;
  }
  if (clean.includes(":")) {
    clean = clean.split(":")[0];
  }
  return clean;
}

const ratesCache = new Map<string, ModelRates | null>();

export function clearRatesCache(): void {
  ratesCache.clear();
}

/**
 * Resolve token pricing rates for a given provider and modelId.
 * Checks custom models.yml configuration first, then default rates catalog.
 */
export function resolveModelRates(
  provider: string,
  modelId: string,
  customConfig?: ModelsFileConfig | null,
): ModelRates | null {
  if (!modelId) return null;
  const normProvider = provider ? provider.trim().toLowerCase() : "";
  const normModel = normalizeModelId(modelId);
  const cacheKey = customConfig
    ? `${normProvider}::${normModel}::custom`
    : `${normProvider}::${normModel}::default`;
  const cached = ratesCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = resolveModelRatesUncached(normProvider, normModel, modelId, customConfig);
  if (ratesCache.size > 2000) ratesCache.clear();
  ratesCache.set(cacheKey, result);
  return result;
}

function resolveModelRatesUncached(
  normProvider: string,
  normModel: string,
  modelId: string,
  customConfig?: ModelsFileConfig | null,
): ModelRates | null {
  // 1. Check custom models.yml config if provided
  if (customConfig?.providers) {
    // Exact provider match or any provider with matching model
    for (const [pKey, pVal] of Object.entries(customConfig.providers)) {
      if (!normProvider || pKey.toLowerCase() === normProvider) {
        const customModel = pVal.models?.find(
          (m) => m.id.toLowerCase() === normModel || normalizeModelId(m.id) === normModel,
        );
        if (customModel?.cost && typeof customModel.cost === "object") {
          const c = customModel.cost;
          if (typeof c.input === "number" || typeof c.output === "number") {
            const inRate = typeof c.input === "number" ? c.input : 0;
            const outRate = typeof c.output === "number" ? c.output : 0;
            return {
              input: inRate,
              output: outRate,
              cacheRead: typeof c.cacheRead === "number" ? c.cacheRead : inRate * 0.1,
              cacheWrite: typeof c.cacheWrite === "number" ? c.cacheWrite : inRate * 1.25,
            };
          }
        }
      }
    }
  }

  // 2. Exact match in default catalog
  if (DEFAULT_MODEL_RATES[normModel]) {
    return DEFAULT_MODEL_RATES[normModel];
  }

  // 3. Pattern / prefix rules
  for (const rule of MODEL_PREFIX_RULES) {
    if (rule.pattern.test(normModel) || rule.pattern.test(modelId)) {
      return rule.rates;
    }
  }

  return null;
}

export interface RawUsageInput {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?:
    | number
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
}

/**
 * Calculate token cost in USD and determine cost quality tier.
 */
export function calculateUsageCost(
  usage: RawUsageInput | undefined | null,
  rates: ModelRates | null,
): { cost: number; quality: CostQualityTier } {
  if (!usage) return { cost: 0, quality: "unpriced" };

  // 1. Provider-reported cost in usage metadata
  if (typeof usage.cost === "number" && !isNaN(usage.cost) && usage.cost > 0) {
    return { cost: usage.cost, quality: "provider_reported" };
  }

  if (usage.cost && typeof usage.cost === "object") {
    if (typeof usage.cost.total === "number" && !isNaN(usage.cost.total) && usage.cost.total > 0) {
      return { cost: usage.cost.total, quality: "provider_reported" };
    }
    const inCost = typeof usage.cost.input === "number" ? usage.cost.input : 0;
    const outCost = typeof usage.cost.output === "number" ? usage.cost.output : 0;
    const crCost = typeof usage.cost.cacheRead === "number" ? usage.cost.cacheRead : 0;
    const cwCost = typeof usage.cost.cacheWrite === "number" ? usage.cost.cacheWrite : 0;
    const sum = inCost + outCost + crCost + cwCost;
    if (sum > 0) {
      return { cost: sum, quality: "provider_reported" };
    }
  }

  // 2. Computed from catalog rates
  if (rates) {
    const inTokens = usage.input || 0;
    const outTokens = usage.output || 0;
    const crTokens = usage.cacheRead || 0;
    const cwTokens = usage.cacheWrite || 0;

    const inCost = (inTokens * rates.input) / 1_000_000;
    const outCost = (outTokens * rates.output) / 1_000_000;
    const crCost = (crTokens * rates.cacheRead) / 1_000_000;
    const cwCost = (cwTokens * rates.cacheWrite) / 1_000_000;

    const total = inCost + outCost + crCost + cwCost;
    return { cost: total, quality: "model_priced" };
  }

  // 3. Unpriced fallback
  return { cost: 0, quality: "unpriced" };
}

/**
 * Calculate dollars saved by prompt caching: (cacheRead / 1M) * (inputRate - cacheReadRate)
 */
export function calculateCacheSavings(
  usage: RawUsageInput | undefined | null,
  rates: ModelRates | null,
): number {
  if (!usage) return 0;
  const cacheRead = usage.cacheRead || 0;
  if (cacheRead <= 0 || !rates) return 0;

  const savingsPerMillion = Math.max(0, rates.input - rates.cacheRead);
  return (cacheRead * savingsPerMillion) / 1_000_000;
}

/**
 * Distinct, theme-consistent brand colors for known AI providers.
 */
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#D97706",    // Warm Amber
  claude: "#D97706",
  openai: "#10B981",       // Emerald Green
  codex: "#06B6D4",        // Cyan
  "openai-codex": "#06B6D4",
  google: "#3B82F6",       // Blue
  gemini: "#3B82F6",
  deepseek: "#6366F1",     // Indigo
  openrouter: "#8B5CF6",   // Purple
  mistral: "#F97316",      // Orange
  groq: "#EC4899",         // Pink
  ollama: "#64748B",       // Slate
  local: "#64748B",
  bedrock: "#F59E0B",      // Amber
  azure: "#0284C7",        // Sky Blue
  cohere: "#14B8A6",       // Teal
  together: "#A855F7",     // Purple
  xai: "#E11D48",          // Rose
  grok: "#E11D48",
  alibaba: "#EA580C",      // Burnt Orange
  qwen: "#EA580C",
};

/**
 * Get distinct provider color. Falls back to deterministic HSL hash for custom providers.
 */
export function getProviderColor(providerId: string): string {
  if (!providerId) return "#64748B";
  const key = providerId.trim().toLowerCase();
  if (PROVIDER_COLORS[key]) return PROVIDER_COLORS[key];

  // Deterministic HSL color generator for unknown/custom providers
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 48%)`;
}

/**
 * Get friendly display name for provider.
 */
export function getProviderDisplayName(providerId: string): string {
  if (!providerId) return "Unknown";
  const key = providerId.trim().toLowerCase();
  switch (key) {
    case "anthropic":
    case "claude":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "codex":
    case "openai-codex":
      return "Codex";
    case "google":
    case "gemini":
      return "Google";
    case "deepseek":
      return "DeepSeek";
    case "openrouter":
      return "OpenRouter";
    case "mistral":
      return "Mistral";
    case "groq":
      return "Groq";
    case "ollama":
      return "Ollama";
    case "local":
      return "Local";
    case "bedrock":
      return "AWS Bedrock";
    case "azure":
      return "Azure OpenAI";
    case "cohere":
      return "Cohere";
    case "together":
      return "Together AI";
    case "xai":
    case "grok":
      return "xAI";
    case "alibaba":
    case "qwen":
      return "Alibaba Cloud";
    default:
      return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }
}
