"use client";

import { useI18n } from "@/lib/i18n";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { isRecord } from "@/lib/type-guards";

type TaskResultRowLike = Record<string, unknown>;

function taskRowStatus(row: TaskResultRowLike): "started" | "completed" | "failed" | "aborted" {
  if (row.aborted === true) return "aborted";
  if (typeof row.error === "string" && row.error) return "failed";
  if (typeof row.exitCode === "number") return row.exitCode === 0 ? "completed" : "failed";
  const status = row.status;
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "started";
}

function TaskResultStatusIcon({ status }: { status: "started" | "completed" | "failed" | "aborted" }) {
  return <SubagentStatusIcon status={status} />;
}

/**
 * Compact per-subagent summary rendered inside an expanded `task` tool call.
 * Feeds off the size-bounded task details allowlisted by the session reader
 * (lib/session-reader.ts stripToolResultDetails): settled results when
 * present, otherwise the mid-run progress snapshot.
 */
export function TaskResultPanel({ details }: { details: unknown }) {
  const { t, tn } = useI18n();
  if (!isRecord(details)) return null;
  const results = (Array.isArray(details.results) ? details.results : []).filter(isRecord);
  const progress = (Array.isArray(details.progress) ? details.progress : []).filter(isRecord);
  const asyncInfo = isRecord(details.async) ? details.async : null;
  if (results.length === 0 && progress.length === 0 && !asyncInfo) return null;

  // Settled results win; otherwise the mid-run progress snapshot; a bare
  // async marker (spawn recorded, no rows yet) still names the job.
  const rows = results.length > 0
    ? results
    : progress.length > 0
      ? progress
      : asyncInfo && typeof asyncInfo.jobId === "string"
        ? [{ id: asyncInfo.jobId, agent: "task", status: "started", task: asyncInfo.jobId } as TaskResultRowLike]
        : [];
  const totalTokens = rows.reduce((sum, row) => sum + (typeof row.tokens === "number" ? row.tokens : 0), 0);
  const totalCost = rows.reduce((sum, row) => sum + (typeof row.cost === "number" ? row.cost : 0), 0);
  const totalDurationMs = typeof details.totalDurationMs === "number" ? details.totalDurationMs : undefined;
  const totalTokensLabel = formatTokens(totalTokens);
  const totalParts = [
    tn("chatWindow.subagentCount", rows.length),
    totalTokensLabel ? t("chatWindow.tokensUnit", { count: totalTokensLabel }) : null,
    formatCost(totalCost),
    formatDuration(totalDurationMs),
  ].filter(Boolean);

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg-subtle)",
        padding: "8px 10px",
        display: "grid",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{t("messageView.taskSubagents")}</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontSize: 10.5 }}>
          {totalParts.join(" · ")}
        </span>
        {asyncInfo && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>⤴</span>
        )}
      </div>
      {rows.map((row, index) => {
        const id = typeof row.id === "string" ? row.id : `row-${index}`;
        const status = taskRowStatus(row);
        const task = typeof row.task === "string" && row.task ? row.task : (typeof row.assignment === "string" ? row.assignment : null);
        const rowTokens = formatTokens(typeof row.tokens === "number" ? row.tokens : undefined);
        const rowParts = [
          rowTokens ? t("chatWindow.tokensUnit", { count: rowTokens }) : null,
          formatCost(typeof row.cost === "number" ? row.cost : undefined),
          status !== "started" ? formatDuration(typeof row.durationMs === "number" ? row.durationMs : undefined) : null,
          shortModel(typeof row.resolvedModel === "string" ? row.resolvedModel : undefined),
        ].filter(Boolean);
        return (
          <div
            key={id}
            aria-label={`${typeof row.id === "string" ? `${row.id} ` : ""}(${typeof row.agent === "string" ? row.agent : "subagent"}): ${t(`chatWindow.subagentState.${status}`)}${task ? ` — ${task}` : ""}`}
            style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 11.5 }}
          >
            <TaskResultStatusIcon status={status} />
            {typeof row.id === "string" && (
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
                {row.id}
              </span>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
              {typeof row.agent === "string" ? row.agent : "subagent"}
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, color: "var(--text)" }}>
              {task ?? ""}
            </span>
            {rowParts.length > 0 && (
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                {rowParts.join(" · ")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
