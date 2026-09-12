"use client";

import React, { useEffect, useState } from "react";
import { ListChecks, Target } from "lucide-react";
import type { ActiveGoal, ActivePlan } from "@/lib/web-mode-state";
import { formatGoalElapsed } from "@/lib/web-mode-state";
import { useI18n } from "@/lib/i18n";

/** Compact action button for the queued follow-up bar. */
export function QueuedActionButton({
  onClick,
  title,
  accent = false,
  disabled = false,
  children,
}: {
  onClick: () => void;
  title: string;
  accent?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        flexShrink: 0,
        padding: "4px 8px", minHeight: 24,
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: accent ? "var(--accent)" : "var(--text-dim)",
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontSize: 11,
        fontWeight: accent ? 600 : 400,
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        if (!accent) e.currentTarget.style.color = "var(--text-muted)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        if (!accent) e.currentTarget.style.color = "var(--text-dim)";
      }}
    >
      {children}
    </button>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: "1px solid color-mix(in srgb, var(--status-error) 35%, transparent)",
        borderRadius: "var(--radius-control)",
        background: "color-mix(in srgb, var(--status-error) 8%, transparent)",
        color: "var(--status-error)",
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t("chatInput.modelError")}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</div>
      </div>
    </div>
  );
}

export function ComposerModeStatus({ goal, plan }: { goal?: ActiveGoal | null; plan?: ActivePlan | null }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!goal) return;
    setExpanded(false);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [goal]);

  if (!goal && !plan) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
      {goal && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? t("chatInput.collapseGoal") : t("chatInput.expandGoal")}
          style={{
            display: "flex", alignItems: expanded ? "flex-start" : "center", gap: 8,
            width: "100%", padding: "6px 9px",
            border: "1px solid color-mix(in srgb, var(--accent) 32%, var(--border))",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))",
            color: "var(--text)", cursor: "pointer", textAlign: "left",
            transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
          }}
        >
          <Target size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: expanded ? 1 : 0, color: "var(--accent)" }} aria-hidden="true" />
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {t("chatInput.goalActive")} · {formatGoalElapsed(now - goal.startedAt)}
          </span>
          <span style={{ minWidth: 0, flex: 1, overflow: expanded ? "visible" : "hidden", textOverflow: expanded ? undefined : "ellipsis", whiteSpace: expanded ? "pre-wrap" : "nowrap", fontSize: 12, lineHeight: 1.4 }}>
            {goal.objective}
          </span>
        </button>
      )}
      {plan && (
        <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
          <ListChecks size={14} strokeWidth={2} style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
          <span style={{ fontWeight: 600 }}>{t("chatInput.planningInProgress")}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }}>{plan.objective}</span>
        </div>
      )}
    </div>
  );
}
