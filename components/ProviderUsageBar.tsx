"use client";

import { useState } from "react";
import { ChevronRight, Gauge } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatUsageReset, usageTone, useProviderUsage } from "./AppShell-provider-usage";
import type { ProviderUsageReport, ProviderUsageWindow } from "@/lib/provider-usage-types";

interface WindowDef {
  short: string;
  pick: (report: ProviderUsageReport) => ProviderUsageWindow | undefined;
}

const WINDOWS: WindowDef[] = [
  { short: "5H", pick: (r) => r.fiveHour },
  { short: "7D", pick: (r) => r.sevenDay },
  { short: "30D", pick: (r) => r.monthly },
];

const COLLAPSED_STORAGE_KEY = "omp-web:provider-usage-collapsed";

function worstWindow(report: ProviderUsageReport): { short: string; window: ProviderUsageWindow } | null {
  let best: { short: string; window: ProviderUsageWindow } | null = null;
  for (const def of WINDOWS) {
    const window = def.pick(report);
    if (window && (best === null || window.percent > best.window.percent)) {
      best = { short: def.short, window };
    }
  }
  return best;
}

function DetailMeter({ short, window, t }: {
  short: string;
  window: ProviderUsageWindow;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const pct = Math.round(window.percent);
  const tone = usageTone(pct);
  const rawReset = window.resetMinutes ?? window.resetHours;
  const reset = rawReset !== undefined
    ? formatUsageReset(rawReset, window.resetMinutes !== undefined ? "minutes" : "hours")
    : null;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em", width: 22, flexShrink: 0 }}>{short}</span>
      <span style={{ flex: 1, minWidth: 0, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: tone, borderRadius: 2 }} />
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {pct}%
      </span>
      {reset && (
        <span style={{ fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
          {t("providerUsage.resets", { value: reset })}
        </span>
      )}
    </span>
  );
}

// Compact provider rate-limit block pinned above Settings in the sidebar: one
// slim row per account (worst window only), click to expand the full detail.
export function ProviderUsageBar() {
  const { t } = useI18n();
  const { snapshot, loading, error } = useProviderUsage("", 5 * 60_000);
  const reports = snapshot?.reports ?? [];
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      // No stored choice yet → start hidden; an explicit expand persists.
      return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });

  let worst: { percent: number; window: string } | null = null;
  for (const report of reports) {
    const best = worstWindow(report);
    if (best && (worst === null || best.window.percent > worst.percent)) {
      worst = { percent: Math.round(best.window.percent), window: best.short };
    }
  }

  return (
    <section
      aria-label={t("appShell.sectionProviderUsage")}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 8px 6px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
        minHeight: 0,
        maxHeight: "32vh",
        overflowY: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => {
          const next = !v;
          try {
            window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
          } catch {
            // The preference still applies for this page load.
          }
          return next;
        })}
        aria-expanded={!collapsed}
        title={t("appShell.sectionProviderUsage")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          boxSizing: "border-box",
          padding: "0 4px",
          minWidth: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <ChevronRight
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
        <span aria-hidden="true" style={{ display: "flex", color: "var(--accent)", flexShrink: 0 }}>
          <Gauge size={13} strokeWidth={2} aria-hidden="true" />
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("appShell.sectionProviderUsage")}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-mono)", color: worst ? usageTone(worst.percent) : "var(--text-dim)", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          {loading && reports.length === 0
            ? t("appShell.providerUsageLoading")
            : error
              ? t("appShell.providerUsageUnavailable")
              : worst
                ? t("providerUsage.highest", { percent: worst.percent, window: worst.window })
                : t("appShell.providerUsageNoData")}
        </span>
      </button>
      {!collapsed && reports.map((report, index) => {
        const account = report.accountLabel ?? t("appShell.account", { number: report.accountIndex ?? index + 1 });
        const key = `${report.provider}:${account}:${report.modelId ?? "all"}:${index}`;
        const best = worstWindow(report);
        const expanded = expandedKey === key;
        const pct = best ? Math.round(best.window.percent) : 0;
        const tone = usageTone(pct);
        return (
          <div key={key} style={{ borderRadius: "var(--radius-control)", background: expanded ? "var(--bg-subtle)" : "transparent" }}>
            <button
              type="button"
              onClick={() => setExpandedKey((prev) => (prev === key ? null : key))}
              aria-expanded={report.noLimits ? undefined : expanded}
              title={account}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 6px 4px",
                background: "none",
                border: "none",
                cursor: report.noLimits ? "default" : "pointer",
                textAlign: "left",
                minWidth: 0,
              }}
            >
              {!report.noLimits && (
                <ChevronRight
                  size={11}
                  strokeWidth={2}
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    color: "var(--text-dim)",
                    transform: expanded ? "rotate(90deg)" : "none",
                    transition: "transform var(--dur-med) var(--ease-out-warm)",
                  }}
                />
              )}
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 10, color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", padding: "0 5px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, lineHeight: 1.7 }}>
                {report.provider}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {account}
              </span>
              {report.noLimits ? (
                <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>∞</span>
              ) : (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {pct}%
                </span>
              )}
            </button>
            {!report.noLimits && (
              <div style={{ height: 3, margin: "0 6px 0 23px", borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: tone, borderRadius: 2 }} />
              </div>
            )}
            {expanded && !report.noLimits && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px 7px 23px", fontFamily: "var(--font-mono)" }}>
                {WINDOWS.map((def) => {
                  const window = def.pick(report);
                  return window ? <DetailMeter key={def.short} short={def.short} window={window} t={t} /> : null;
                })}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
