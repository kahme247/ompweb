import { useState, useEffect, useRef, useCallback } from "react";
import type { ProviderUsageReport, ProviderUsageSnapshot } from "@/lib/provider-usage-types";

export function formatUsageReset(value: number, unit: "minutes" | "hours"): string {
  if (unit === "minutes") {
    if (value < 60) return `${value}m`;
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (value < 24) return `${value}h`;
  const days = Math.floor(value / 24);
  const hours = value % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Label that distinguishes one usage row from another row for the same
 * provider and account, or undefined when the row needs none.
 * Antigravity rows carry their bucket ("Gemini", "Claude & GPT (shared)");
 * Anthropic rows carry their tier, capitalised ("Fable", "Opus", "Sonnet")
 * — the shared account-wide row has no tier and stays plain "Anthropic".
 * Other providers' tiers are quota tiers, not bucket names, so they are
 * not promoted to a label here.
 */
export function usageBucketLabel(report: ProviderUsageReport): string | undefined {
  if (report.bucket) return report.bucket;
  if (report.provider === "anthropic" && report.tier) {
    return report.tier.charAt(0).toUpperCase() + report.tier.slice(1);
  }
  return undefined;
}

export function usageTone(percent: number): string {
  if (percent >= 80) return "var(--status-error)";
  if (percent >= 50) return "var(--status-warning)";
  return "var(--text-muted)";
}

export function formatProviderUsageReport(report: ProviderUsageReport, noLimitsLabel: string): string {
  if (report.noLimits) return noLimitsLabel;
  const parts: string[] = [];
  if (report.tier) parts.push(report.tier);
  if (report.fiveHour) {
    const reset = report.fiveHour.resetMinutes === undefined
      ? ""
      : ` (${formatUsageReset(report.fiveHour.resetMinutes, "minutes")})`;
    parts.push(`5h ${Math.round(report.fiveHour.percent)}%${reset}`);
  }
  if (report.sevenDay) {
    const reset = report.sevenDay.resetHours === undefined
      ? ""
      : ` (${formatUsageReset(report.sevenDay.resetHours, "hours")})`;
    parts.push(`7d ${Math.round(report.sevenDay.percent)}%${reset}`);
  }
  if (report.monthly) {
    const reset = report.monthly.resetHours === undefined
      ? ""
      : ` (${formatUsageReset(report.monthly.resetHours, "hours")})`;
    parts.push(`mo ${Math.floor(report.monthly.percent)}%${reset}`);
  }
  return parts.join(" · ");
}

export type ProviderUsageState = {
  snapshot: ProviderUsageSnapshot | null;
  loading: boolean;
  error: boolean;
};

export function useProviderUsage(query: string | null, refreshMs?: number): ProviderUsageState & { refresh: () => Promise<boolean> } {
  const [state, setState] = useState<ProviderUsageState>({ snapshot: null, loading: false, error: false });
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (query === null) {
      setState({ snapshot: null, loading: false, error: false });
      return;
    }
    const controller = new AbortController();
    setState({ snapshot: null, loading: true, error: false });
    let inFlight: Promise<boolean> | undefined;
    let inFlightForced = false;
    const load = (force = false): Promise<boolean> => {
      if (controller.signal.aborted) return Promise.resolve(false);
      if (inFlight) {
        return force && !inFlightForced ? inFlight.then(() => load(true)) : inFlight;
      }
      if (force) setState((previous) => ({ ...previous, loading: true, error: false }));
      const params = new URLSearchParams(query);
      if (force) params.set("refresh", "true");
      const queryString = params.toString();
      inFlightForced = force;
      inFlight = (async () => {
        try {
          const response = await fetch(`/api/provider-usage${queryString ? `?${queryString}` : ""}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const snapshot = await response.json() as ProviderUsageSnapshot;
          if (controller.signal.aborted) return false;
          setState({ snapshot, loading: false, error: false });
          return true;
        } catch {
          if (!controller.signal.aborted) setState({ snapshot: null, loading: false, error: true });
          return false;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    };
    refreshRef.current = () => load(true);
    void load();
    const interval = refreshMs ? window.setInterval(() => void load(), refreshMs) : undefined;
    return () => {
      refreshRef.current = async () => false;
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [query, refreshMs]);
  return { ...state, refresh };
}
