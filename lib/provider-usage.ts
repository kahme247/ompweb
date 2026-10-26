import { execFile } from "child_process";
import { promisify } from "util";
import { resolveOmpBin } from "./omp/omp-cli";
import { asNumber, isRecord } from "./type-guards";
import type {
  ProviderUsageReport,
  ProviderUsageSnapshot,
  ProviderUsageWindowId,
} from "./provider-usage-types";

const execFileAsync = promisify(execFile);
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 4 * 1024 * 1024;
const USAGE_CACHE_TTL_MS = 5 * 60_000;

type UsageQuery = { provider?: string; modelId?: string };

type CachedUsage = { expiresAt: number; output: string };

let usageCache: CachedUsage | undefined;
let usageInFlight: Promise<string> | undefined;
let usageInFlightForced = false;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeWindowId(scope: Record<string, unknown>, window: Record<string, unknown>): ProviderUsageWindowId | undefined {
  const windowId = nonEmptyString(scope.windowId);
  if (windowId === "5h" || windowId === "7d" || windowId === "monthly" || windowId === "30d" || windowId === "daily") {
    if (windowId === "30d") return "monthly";
    if (windowId === "daily") return "5h";
    return windowId;
  }
  const durationMs = asNumber(window.durationMs);
  if (durationMs === undefined) return undefined;
  if (Math.abs(durationMs - 5 * 60 * 60 * 1000) <= 60_000) return "5h";
  if (Math.abs(durationMs - 7 * 24 * 60 * 60 * 1000) <= 60_000) return "7d";
  if (Math.abs(durationMs - 30 * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000) return "monthly";
  if (Math.abs(durationMs - 24 * 60 * 60 * 1000) <= 60_000) return "5h";
  return undefined;
}

function usageWindow(
  windowId: ProviderUsageWindowId,
  fraction: number,
  window: Record<string, unknown>,
  now: number,
): ProviderUsageReport["fiveHour"] {
  const resetAt = asNumber(window.resetsAt);
  if (windowId === "5h") {
    return {
      percent: fraction * 100,
      ...(resetAt !== undefined ? { resetMinutes: Math.max(0, Math.round((resetAt - now) / 60_000)) } : {}),
    };
  }
  return {
    percent: fraction * 100,
    ...(resetAt !== undefined ? { resetHours: Math.max(0, Math.round((resetAt - now) / 3_600_000)) } : {}),
  };
}

type UsageLimit = { id: ProviderUsageWindowId; fraction: number; window: Record<string, unknown> };

type UsageGroup = {
  priority: number;
  modelId?: string;
  tier?: string;
  bucket?: string;
  limits: Map<ProviderUsageWindowId, UsageLimit>;
};

/**
 * Bucket name for an Antigravity limit, if omp distinguishes one.
 *
 * Antigravity quotas split by backend counter, not by model/tier, and omp
 * reports that split only in the limit's label/id — never in scope. The
 * quota-summary path labels a bucket "Gemini" or "Claude & GPT (shared)"
 * (the latter is one shared third-party quota, duplicated by omp into
 * anthropic/openai counter ids, so it must stay one bucket, not two);
 * the model-based path labels it "Usage (Google)" / "Usage (Anthropic)" /
 * "Usage (OpenAI)". A bare id counter is used only as a fallback, and
 * never for a shared limit, so the shared bucket is never invented twice.
 * Other providers return undefined: Anthropic's Fable bucket already
 * arrives as scope.tier, and no other provider's labels are bucket names.
 */
function antigravityBucket(rawLimit: Record<string, unknown>, scope: Record<string, unknown>): string | undefined {
  const label = nonEmptyString(rawLimit.label);
  if (label === "Gemini" || label === "Claude & GPT (shared)") return label;
  const usageMatch = label ? /^Usage \((.+)\)$/.exec(label) : null;
  // The model-based path names the Google counter "Google"; the quota
  // summary path names the same counter "Gemini". Unify on "Gemini" so
  // the two fetch paths never split one counter into two rows.
  if (usageMatch) return usageMatch[1] === "Google" ? "Gemini" : usageMatch[1];
  if (scope.shared === true) return undefined;
  const id = nonEmptyString(rawLimit.id);
  const counter = id ? id.split(":")[1] : undefined;
  if (counter === "google") return "Gemini";
  if (counter === "anthropic") return "Anthropic";
  if (counter === "openai") return "OpenAI";
  return undefined;
}

function normalizeReport(
  rawReport: Record<string, unknown>,
  query: UsageQuery,
  now: number,
  reportIndex: number,
): ProviderUsageReport[] {
  const provider = nonEmptyString(rawReport.provider);
  if (!provider || (query.provider && provider !== query.provider)) return [];
  const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
  const activeModelId = query.modelId?.toLowerCase();
  const groups = new Map<string, UsageGroup>();

  for (const rawLimit of limits) {
    if (!isRecord(rawLimit) || !isRecord(rawLimit.scope) || !isRecord(rawLimit.amount)) continue;
    const scope = rawLimit.scope;
    const amount = rawLimit.amount;
    const fraction = asNumber(amount.usedFraction);
    if (fraction === undefined) continue;
    const window = isRecord(rawLimit.window) ? rawLimit.window : {};
    const windowId = normalizeWindowId(scope, window);
    if (!windowId) continue;
    const modelId = nonEmptyString(scope.modelId);
    if (activeModelId && modelId && modelId.toLowerCase() !== activeModelId) continue;
    const tier = nonEmptyString(scope.tier);
    const normalizedModelId = modelId?.toLowerCase();
    const normalizedTier = tier?.toLowerCase();
    // Antigravity buckets must not merge: without a bucket in the key, a
    // Gemini weekly limit and a Claude & GPT weekly limit collapse into
    // one group and only the larger fraction survives (#284).
    const bucket = provider === "google-antigravity" || provider === "antigravity"
      ? antigravityBucket(rawLimit, scope)
      : undefined;
    const groupKey = `${normalizedModelId ?? ""}\0${normalizedTier ?? ""}\0${bucket ?? ""}`;
    const priority = modelId ? (normalizedTier ? 0 : 1) : normalizedTier ? 2 : 3;
    let group = groups.get(groupKey);
    if (!group) {
      group = { priority, modelId, tier, bucket, limits: new Map() };
      groups.set(groupKey, group);
    }
    const candidate = { id: windowId, fraction, window };
    const current = group.limits.get(windowId);
    if (!current || fraction > current.fraction) group.limits.set(windowId, candidate);
  }

  const selectedGroups = [...groups.values()];
  if (activeModelId && selectedGroups.length > 0) {
    // Keep every group tied at the best priority, not just the first:
    // Antigravity's Gemini and shared buckets share priority (no modelId,
    // no tier) and differ only by bucket, so picking one would drop a
    // quota bucket from a model-filtered query (#284, CodeRabbit).
    const bestPriority = Math.min(...selectedGroups.map((group) => group.priority));
    const kept = selectedGroups.filter((group) => group.priority === bestPriority);
    selectedGroups.splice(0, selectedGroups.length, ...kept);
  }
  const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
  // Email only: unredacted account ids are opaque UUIDs, so those accounts
  // show as "Account N".
  const label = nonEmptyString(metadata?.email);
  const plan = nonEmptyString(metadata?.planType);
  if (selectedGroups.length === 0) {
    return [{
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      noLimits: true,
    }];
  }
  return selectedGroups.flatMap((group) => {
    const result: ProviderUsageReport = {
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      ...(group.modelId ? { modelId: group.modelId } : {}),
      ...(group.tier ? { tier: group.tier } : {}),
      ...(group.bucket ? { bucket: group.bucket } : {}),
    };
    for (const candidate of group.limits.values()) {
      const normalized = usageWindow(candidate.id, candidate.fraction, candidate.window, now);
      if (candidate.id === "5h" && !result.fiveHour) result.fiveHour = normalized;
      if (candidate.id === "7d" && !result.sevenDay) result.sevenDay = normalized;
      if (candidate.id === "monthly" && !result.monthly) result.monthly = normalized;
    }
    return result.fiveHour || result.sevenDay || result.monthly ? [result] : [];
  });
}

export function parseProviderUsageOutput(output: string, query: UsageQuery = {}, now = Date.now()): ProviderUsageSnapshot {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");
  const rawReports = Array.isArray(payload.reports) ? payload.reports : [];
  const reports = rawReports.flatMap((report, index) => isRecord(report) ? normalizeReport(report, query, now, index) : []);
  const generatedAt = asNumber(payload.generatedAt) ?? null;
  return { generatedAt, reports };
}

async function fetchProviderUsage(refresh = false): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  if (refresh) {
    await execFileAsync(bin, ["usage", "invalidate"], {
      timeout: USAGE_TIMEOUT_MS,
      maxBuffer: USAGE_MAX_BUFFER,
      windowsHide: true,
    });
  }
  // Unredacted so accounts show their real email; only the parsed label, plan
  // and windows reach the browser, never the raw metadata.
  const { stdout } = await execFileAsync(bin, ["usage", "--json"], {
    timeout: USAGE_TIMEOUT_MS,
    maxBuffer: USAGE_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

function getUsageOutput(refresh = false): Promise<string> {
  if (!refresh && usageCache && usageCache.expiresAt > Date.now()) return Promise.resolve(usageCache.output);
  if (usageInFlight) {
    return refresh && !usageInFlightForced
      ? usageInFlight.then(() => getUsageOutput(true), () => getUsageOutput(true))
      : usageInFlight;
  }
  usageInFlightForced = refresh;
  usageInFlight = fetchProviderUsage(refresh)
    .then((output) => {
      usageCache = { output, expiresAt: Date.now() + USAGE_CACHE_TTL_MS };
      return output;
    })
    .finally(() => { usageInFlight = undefined; });
  return usageInFlight;
}

export async function getProviderUsage(query: UsageQuery = {}, refresh = false): Promise<ProviderUsageSnapshot> {
  return parseProviderUsageOutput(await getUsageOutput(refresh), query);
}
