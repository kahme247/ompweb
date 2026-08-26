"use client";

import { useState, type ReactNode } from "react";
import {
  Activity, Bot, ChevronDown,
  CircleDollarSign, Clock3, Cpu, Gauge, GitBranch, Network, RefreshCw,
  UserRound, Wrench, X, type LucideIcon,
} from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import type { TodoPhase } from "@/lib/pi-types";
import { countNestedSubagents, formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { TodoList } from "./TodoList";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

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
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
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
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
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
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [agentSheetOpen, setAgentSheetOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"todo" | "subagents">(() => (
    todoPhases.length > 0 ? "todo" : "subagents"
  ));

  if (todoPhases.length === 0 && subagents.length === 0) return null;

  if (isMobile) {
    const tasks = todoPhases.flatMap((phase) => phase.tasks);
    const doneTasks = tasks.filter((t) => t.status === "completed").length;
    const activeSubagent = subagents.find((s) => s.status === "started" && s.source !== "history");
    const inProgressTask = tasks.find((t) => t.status === "in_progress");

    const statusText = activeSubagent
      ? `${activeSubagent.agent}: ${activeSubagent.task ?? activeSubagent.progress?.lastIntent ?? activeSubagent.description ?? t("chatWindow.subagentState.started")}`
      : inProgressTask
        ? inProgressTask.content
        : tasks.length > 0
          ? `${doneTasks}/${tasks.length} 任务已处理`
          : `${subagents.length} 个子代理`;

    const progressBadge = tasks.length > 0
      ? `${doneTasks}/${tasks.length}`
      : `${subagents.length}`;

    return (
      <>
        <div
          className="mobile-agent-capsule"
          onClick={() => setAgentSheetOpen(true)}
          role="button"
          tabIndex={0}
          aria-label="查看任务与子代理看板"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, overflow: "hidden", flex: 1 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: activeSubagent ? "var(--accent)" : "var(--status-success)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 12, fontWeight: 550, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {statusText}
            </span>
          </div>
          <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0, display: "flex", alignItems: "center", gap: 3, fontFamily: "var(--font-mono)" }}>
            {progressBadge} ›
          </span>
        </div>

        {agentSheetOpen && (
          <>
            <div
              className="mobile-sheet-overlay"
              onClick={() => setAgentSheetOpen(false)}
              aria-hidden="true"
            />
            <div className="mobile-sheet-container" role="dialog" aria-modal="true" aria-label="Agent 任务看板">
              <div className="mobile-sheet-handle-wrap">
                <div className="mobile-sheet-handle" />
              </div>
              <div className="mobile-sheet-header">
                <div style={{ display: "flex", gap: 8 }}>
                  {todoPhases.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveTab("todo")}
                      style={{
                        background: activeTab === "todo" ? "var(--bg-hover)" : "none",
                        border: "none",
                        borderRadius: 8,
                        padding: "5px 10px",
                        fontSize: 13,
                        fontWeight: activeTab === "todo" ? 650 : 500,
                        color: activeTab === "todo" ? "var(--accent)" : "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >
                      {t("chatWindow.todoList") || "任务清单"} ({doneTasks}/{tasks.length})
                    </button>
                  )}
                  {subagents.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveTab("subagents")}
                      style={{
                        background: activeTab === "subagents" ? "var(--bg-hover)" : "none",
                        border: "none",
                        borderRadius: 8,
                        padding: "5px 10px",
                        fontSize: 13,
                        fontWeight: activeTab === "subagents" ? 650 : 500,
                        color: activeTab === "subagents" ? "var(--accent)" : "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >
                      {t("chatWindow.subagentsPanel") || "子代理矩阵"} ({subagents.length})
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="mobile-sheet-close"
                  onClick={() => setAgentSheetOpen(false)}
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="mobile-sheet-body">
                {activeTab === "todo" && (
                  <TodoList phases={todoPhases} collapsible={false} defaultExpanded />
                )}
                {activeTab === "subagents" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {subagents.map((subagent) => {
                      const stateLabel = t(SUBAGENT_STATE_KEYS[subagent.status]);
                      const label = `${subagent.agent} · ${stateLabel} · ${subagent.task ?? subagent.description ?? ""}`.replace(/\s+$/, "");
                      const live = subagent.source !== "history";
                      return (
                        <button
                          key={subagent.id}
                          type="button"
                          onClick={() => {
                            setAgentSheetOpen(false);
                            onSelectSubagent(subagent);
                          }}
                          style={{
                            width: "100%",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: 4,
                            padding: "10px 12px",
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            background: "var(--bg-panel)",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                            <SubagentStatusBadge subagent={subagent} />
                            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12, color: "var(--accent)" }}>
                              {subagent.agent}
                            </span>
                            <span style={{ fontSize: 11, color: live && subagent.status === "started" ? "var(--accent)" : "var(--text-muted)", marginLeft: "auto", textTransform: "capitalize" }}>
                              {stateLabel}
                            </span>
                          </div>
                          <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.4 }}>
                            {subagent.task ?? subagent.description ?? label}
                          </div>
                          <SubagentActivityLine subagent={subagent} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
      <TodoList phases={todoPhases} collapsible defaultExpanded={defaultExpanded} />
      <SubagentsPanel subagents={subagents} onSelectSubagent={onSelectSubagent} defaultExpanded={defaultExpanded} />
    </div>
  );
}
