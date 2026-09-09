"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity, Bot, Check, ChevronDown, Copy,
  CircleDollarSign, Clock3, Cpu, Gauge, GitBranch, Network, RefreshCw,
  UserRound, Wrench, type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import type { GenerationSpeedInfo, SessionStatsInfo, TodoPhase } from "@/lib/pi-types";
import { countNestedSubagents, formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { formatCompactNumber, formatPercent, getCacheHitRate } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import { TodoList } from "./TodoList";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

// Panels unmount when their inputs are empty and remount when they fill
const TODO_COLLAPSED_STORAGE_KEY = "omp-web:composer-todo-collapsed";
const SUBAGENTS_COLLAPSED_STORAGE_KEY = "omp-web:composer-subagents-collapsed";

function loadCollapsed(key: string, defaultExpanded: boolean): boolean {
  if (typeof window === "undefined") return !defaultExpanded;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return !defaultExpanded;
    return raw === "true";
  } catch {
    return !defaultExpanded;
  }
}

function saveCollapsed(key: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(key, String(collapsed));
  } catch {
    // Storage is optional UI state; the in-memory value still applies.
  }
}

const SUBAGENT_STATE_KEYS: Record<SubagentInfo["status"], string> = {
  started: "chatWindow.subagentState.started",
  completed: "chatWindow.subagentState.completed",
  failed: "chatWindow.subagentState.failed",
  aborted: "chatWindow.subagentState.aborted",
};

function SubagentStatusBadge({ subagent }: { subagent: SubagentInfo }) {
  return <SubagentStatusIcon status={subagent.status} live={subagent.source !== "history"} />;
}

/** Icon-first telemetry keeps the compact roster scannable without label noise. */
function SubagentMetric({ icon: Icon, label, children }: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-label={label}
      title={label}
      data-subagent-metric={label}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <Icon size={11} strokeWidth={1.8} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

/** Compact live/secondary line under a chip label (tool, retry, telemetry). */
function SubagentActivityLine({ subagent }: { subagent: SubagentInfo }) {
  const { t } = useI18n();
  const progress = subagent.progress;
  const retryActive = Boolean(progress?.retryState ?? progress?.retryFailure);
  const parts: ReactNode[] = [];

  if (retryActive) {
    const attempt = progress?.retryState?.attempt ?? progress?.retryFailure?.attempt ?? 0;
    const maxAttempts = progress?.retryState?.maxAttempts ?? 0;
    const label = maxAttempts > 0
      ? t("chatWindow.subagentRetrying", { attempt, max: maxAttempts })
      : t("chatWindow.subagentRetryAttempt", { attempt });
    parts.push(
      <SubagentMetric key="retry" icon={RefreshCw} label={label}>
        {maxAttempts > 0 ? `${attempt}/${maxAttempts}` : attempt}
      </SubagentMetric>,
    );
  } else if (subagent.status === "started") {
    const activity = progress?.currentTool
      ? `${progress.currentTool}${progress.lastIntent ? ` — ${progress.lastIntent}` : ""}`
      : progress?.lastIntent;
    if (activity) {
      parts.push(
        <SubagentMetric key="activity" icon={progress?.currentTool ? Wrench : Activity} label={activity}>
          {activity}
        </SubagentMetric>,
      );
    }
  }

  const nested = countNestedSubagents(progress);
  const source = subagent.agentSource && subagent.agentSource !== "bundled" ? subagent.agentSource : null;
  const tokens = formatTokens(progress?.tokens);
  const cost = formatCost(progress?.cost);
  const ctxTokens = formatTokens(progress?.contextTokens);
  const context = ctxTokens
    ? `${ctxTokens}/${formatTokens(progress?.contextWindow) ?? "?"}`
    : null;
  const model = shortModel(progress?.resolvedModel);
  const duration = subagent.source === "history" ? formatDuration(progress?.durationMs) : null;
  const meta: ReactNode[] = [
    source ? <SubagentMetric key="source" icon={UserRound} label={source}>{source === "user" ? null : source}</SubagentMetric> : null,
    nested > 0 ? <SubagentMetric key="nested" icon={GitBranch} label={t("chatWindow.subagentNestedCount", { count: nested })}>{nested}</SubagentMetric> : null,
    tokens ? <SubagentMetric key="tokens" icon={Cpu} label={t("chatWindow.tokensUnit", { count: tokens })}>{tokens}</SubagentMetric> : null,
    cost ? <SubagentMetric key="cost" icon={CircleDollarSign} label={cost}>{cost}</SubagentMetric> : null,
    context ? <SubagentMetric key="context" icon={Gauge} label={t("chatWindow.contextGauge", { used: ctxTokens ?? "?", total: formatTokens(progress?.contextWindow) ?? "?" })}>{context}</SubagentMetric> : null,
    model ? <SubagentMetric key="model" icon={Bot} label={model}>{model}</SubagentMetric> : null,
    duration ? <SubagentMetric key="duration" icon={Clock3} label={duration}>{duration}</SubagentMetric> : null,
  ].filter(Boolean);
  if (meta.length > 0) {
    parts.push(
      <span key="meta" style={{ display: "inline-flex", flexWrap: "wrap", gap: "2px 7px" }}>
        {meta}
      </span>,
    );
  }

  if (parts.length === 0) return null;
  return (
    <span
      style={{
        display: "flex",
        minWidth: 0,
        overflow: "hidden",
        fontSize: 10.5,
        fontFamily: "var(--font-mono)",
        color: retryActive ? "var(--accent)" : "var(--text-dim)",
        lineHeight: 1.4,
        gap: 7,
        flexWrap: "wrap",
      }}
    >
      {parts}
    </span>
  );
}

function SubagentsPanel({ subagents, onSelectSubagent, defaultExpanded = false }: {
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
  /** Initial expansion (default: collapsed — the header still shows the live summary). */
  defaultExpanded?: boolean;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(SUBAGENTS_COLLAPSED_STORAGE_KEY, defaultExpanded));
  const runningCount = subagents.filter((subagent) => subagent.source !== "history" && subagent.status === "started").length;

  if (subagents.length === 0) return null;

  return (
    <section
      aria-label={t("chatWindow.subagentsPanel")}
      className="overflow-hidden border border-border bg-bg-subtle"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => { saveCollapsed(SUBAGENTS_COLLAPSED_STORAGE_KEY, !value); return !value; })}
        title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
        className={`ui-focus-ring flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text-muted ${collapsed ? "" : "border-b border-border"}`}
        style={{ background: "none" }}
      >
        <Network size={14} strokeWidth={1.8} aria-hidden />
        <strong className="font-medium text-text">{t("chatWindow.subagentsPanel")}</strong>
        <span
          className="ml-auto inline-flex items-center gap-1.5"
          aria-label={t("chatWindow.subagentSummary", { running: runningCount, total: subagents.length })}
          title={t("chatWindow.subagentSummary", { running: runningCount, total: subagents.length })}
        >
          <span>{runningCount}/{subagents.length}</span>
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          style={{
            color: "var(--text-dim)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
      </button>
      {!collapsed && (
        <div
          className="flex flex-wrap gap-1.5 px-3 py-2.5 animate-slide-down"
          style={{ maxHeight: "min(30vh, 240px)", overflowY: "auto" }}
        >
          {subagents.map((subagent) => {
            const stateLabel = t(SUBAGENT_STATE_KEYS[subagent.status]);
            const label = `${subagent.agent} · ${stateLabel} · ${subagent.task ?? subagent.description ?? ""}`.replace(/\s+$/, "");
            const live = subagent.source !== "history";
            return (
              <button
                key={subagent.id}
                type="button"
                className="ui-focus-ring"
                onClick={() => onSelectSubagent(subagent)}
                aria-label={label}
                title={`${label}${subagent.detached ? " (async)" : ""}`}
                style={{
                  display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
                  maxWidth: 320, padding: "5px 9px",
                  border: "1px solid color-mix(in srgb, var(--border) 86%, transparent)",
                  borderRadius: "var(--radius-control)",
                  background: "var(--bg)",
                  fontSize: 11.5,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  color: live && subagent.status === "started" ? "var(--text)" : "var(--text-dim)",
                  opacity: live && subagent.status === "started" ? 1 : 0.72,
                  transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 40%, var(--border))";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--border) 86%, transparent)";
                  e.currentTarget.style.background = "var(--bg)";
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%" }}>
                  <SubagentStatusBadge subagent={subagent} />
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
                    {subagent.agent}
                  </span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                    {subagent.task ?? subagent.description ?? stateLabel}
                  </span>
                  {subagent.detached && (
                    <span
                      aria-hidden
                      style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontFamily: "var(--font-mono)" }}
                    >
                      ⤴
                    </span>
                  )}
                </span>
                <SubagentActivityLine subagent={subagent} />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Session panels attached to the composer: live todo plan + running
 * subagent roster. Each is independently collapsible via its header row
 * (`chevron`) and starts collapsed; the headers always show live progress /
 * running-summary. Rendered pinned above the chat input. */
export function ComposerPanels({ todoPhases, subagents, onSelectSubagent, defaultExpanded = false }: {
  todoPhases: TodoPhase[];
  subagents: SubagentInfo[];
  onSelectSubagent: (subagent: SubagentInfo) => void;
  /** Initial expansion of both panels (default: collapsed). */
  defaultExpanded?: boolean;
}) {
  const [todoCollapsed, setTodoCollapsed] = useState(() => loadCollapsed(TODO_COLLAPSED_STORAGE_KEY, defaultExpanded));
  if (todoPhases.length === 0 && subagents.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
      <TodoList
        phases={todoPhases}
        collapsible
        defaultExpanded={defaultExpanded}
        collapsed={todoCollapsed}
        onCollapsedChange={(collapsed) => { saveCollapsed(TODO_COLLAPSED_STORAGE_KEY, collapsed); setTodoCollapsed(collapsed); }}
      />
      <SubagentsPanel subagents={subagents} onSelectSubagent={onSelectSubagent} defaultExpanded={defaultExpanded} />
    </div>
  );
}

/** Context detail for the composer ring popover: usage bar plus the full
 * session / messages / tokens grids. No chrome of its own — the popover
 * frame owns the title and the Compact action. Renders nothing until the
 * session reports stats or usage.
 *
 * NOTE: omp reports context as a single total (tokens/window/percent) — there
 * is no per-category breakdown on the wire, so none is shown here. */
export function ContextDetailPanel({ sessionStats, contextUsage, modelCapacity, generationSpeed }: {
  sessionStats?: SessionStatsInfo | null;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  modelCapacity?: { contextWindow?: number; maxTokens?: number } | null;
  generationSpeed?: GenerationSpeedInfo | null;
}) {
  const { t, locale } = useI18n();
  const [copiedField, setCopiedField] = useState<"file" | "id" | null>(null);
  const copyTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(copyTimerRef.current);
  }, []);

  const ctx = contextUsage ?? sessionStats?.contextUsage ?? null;
  if (!sessionStats && !ctx) return null;

  const pct = ctx?.percent ?? null;
  const tone = pct !== null && pct > 90
    ? "var(--status-error)"
    : pct !== null && pct > 70
      ? "var(--status-warning)"
      : "var(--text-muted)";
  const costStr = sessionStats ? formatCost(sessionStats.cost) : null;
  const cacheHitRate = sessionStats ? getCacheHitRate(sessionStats.tokens.input, sessionStats.tokens.cacheRead) : null;

  const copyField = (field: "file" | "id", value: string) => {
    void copyText(value).then(() => {
      clearTimeout(copyTimerRef.current);
      setCopiedField(field);
      copyTimerRef.current = setTimeout(() => setCopiedField(null), 1400);
    });
  };

  const statRow = (label: string, value: string, copy?: "file" | "id", copyValue?: string) => (
    <div key={label} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
      <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{value}</span>
        {copy && copyValue && (
          <button
            type="button"
            onClick={() => copyField(copy, copyValue)}
            aria-label={copiedField === copy ? t("appShell.copied") : t("appShell.copyFilePath")}
            title={copiedField === copy ? t("appShell.copied") : t("appShell.copyFilePath")}
            style={{ display: "inline-flex", padding: 2, background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)" }}
          >
            {copiedField === copy
              ? <Check size={11} strokeWidth={2.4} aria-hidden="true" />
              : <Copy size={11} strokeWidth={2} aria-hidden="true" />}
          </button>
        )}
      </span>
    </div>
  );

  const sectionTitleStyle = { fontSize: 11, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ctx?.contextWindow ? (
            <div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {ctx.tokens !== null && ctx.tokens !== undefined ? formatCompactNumber(ctx.tokens) : "?"}
                  {" / "}{formatCompactNumber(ctx.contextWindow)}
                  {pct !== null ? ` (${formatPercent(pct)})` : ""}
                </span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct !== null ? Math.min(100, Math.max(0, pct)) : 0}%`, background: tone, borderRadius: 3 }} />
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 5, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                <span>{t("composerContext.windowSize", { tokens: formatCompactNumber(ctx.contextWindow) })}</span>
                {modelCapacity?.maxTokens ? <span>{t("composerContext.maxOutput", { tokens: formatCompactNumber(modelCapacity.maxTokens) })}</span> : null}
                {generationSpeed?.current != null || generationSpeed?.average != null ? (
                  <span>
                    {generationSpeed?.current != null && generationSpeed?.average != null
                      ? t("composerContext.speed", { current: generationSpeed.current.toFixed(1), average: generationSpeed.average.toFixed(1) })
                      : t("composerContext.speedCurrent", { current: (generationSpeed?.current ?? generationSpeed?.average ?? 0).toFixed(1) })}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {sessionStats && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <div style={{ minWidth: 0 }}>
                <h4 style={sectionTitleStyle}>{t("appShell.sectionSessionInfo")}</h4>
                {sessionStats.sessionName ? statRow(t("appShell.statName"), sessionStats.sessionName) : null}
                {statRow(t("appShell.statFile"), sessionStats.sessionFile ?? t("appShell.inMemory"), "file", sessionStats.sessionFile)}
                {statRow(t("appShell.statId"), sessionStats.sessionId, "id", sessionStats.sessionId)}
              </div>
              <div style={{ minWidth: 0 }}>
                <h4 style={sectionTitleStyle}>{t("appShell.sectionMessages")}</h4>
                {statRow(t("appShell.statUser"), sessionStats.userMessages.toLocaleString(locale))}
                {statRow(t("appShell.statAssistant"), sessionStats.assistantMessages.toLocaleString(locale))}
                {statRow(t("appShell.statToolCalls"), sessionStats.toolCalls.toLocaleString(locale))}
                {statRow(t("appShell.statToolResults"), sessionStats.toolResults.toLocaleString(locale))}
                {statRow(t("appShell.statTotal"), sessionStats.totalMessages.toLocaleString(locale))}
              </div>
              <div style={{ minWidth: 0 }}>
                <h4 style={sectionTitleStyle}>{t("appShell.sectionTokens")}</h4>
                {statRow(t("appShell.statInput"), sessionStats.tokens.input.toLocaleString(locale))}
                {statRow(t("appShell.statOutput"), sessionStats.tokens.output.toLocaleString(locale))}
                {sessionStats.tokens.cacheRead > 0 ? statRow(t("appShell.statCacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)) : null}
                {sessionStats.tokens.cacheWrite > 0 ? statRow(t("appShell.statCacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)) : null}
                {statRow(t("appShell.statTotal"), sessionStats.tokens.total.toLocaleString(locale))}
                {cacheHitRate !== null ? statRow(t("appShell.statCacheRate"), formatPercent(cacheHitRate)) : null}
                {costStr ? statRow(t("appShell.statCost"), costStr) : null}
              </div>
            </div>
          )}
        </div>
  );
}
