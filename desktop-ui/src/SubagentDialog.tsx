import { useEffect } from "react";
import { X } from "lucide-react";
import { formatTokens, formatCost } from "@/lib/subagent-format";
import type { SubagentActivityEvent, SubagentInfo } from "@/lib/subagent-types";

const STATUS_LABELS: Record<SubagentInfo["status"], string> = {
  started: "Running",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
};

function formatDuration(ms: number | undefined): string | null {
  if (!ms || ms <= 0) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Live subagent inspector: identity, stats, recent output, activity feed.
 *  Purely state-driven — it re-renders as progress/activity frames arrive. */
export function SubagentDialog({
  info,
  activity,
  onClose,
}: {
  info: SubagentInfo;
  activity: SubagentActivityEvent[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const p = info.progress;
  const contextPct =
    p?.contextTokens && p?.contextWindow && p.contextWindow > 0
      ? Math.round((p.contextTokens / p.contextWindow) * 100)
      : null;
  const output = [...(p?.recentOutput ?? [])].slice(-30);
  const stats: Array<[string, string | null]> = [
    ["Model", p?.resolvedModel ?? null],
    ["Tokens", formatTokens(p?.tokens)],
    ["Cost", formatCost(p?.cost)],
    ["Duration", formatDuration(p?.durationMs)],
    ["Tools", p?.toolCount != null ? String(p.toolCount) : null],
    ["Context", contextPct != null ? `${contextPct}%` : null],
  ];

  return (
    <div className="subagent-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="subagent-dialog">
        <div className="subagent-dialog-head">
          <span className={`subagent-chip ${info.status}`}>
            <span className="subagent-dot" aria-hidden />
            <span className="subagent-chip-name">{info.agent}</span>
            {STATUS_LABELS[info.status]}
          </span>
          <button className="titlebar-btn subagent-close" onClick={onClose} title="Close">
            <X size={14} aria-hidden />
          </button>
        </div>
        {(info.task ?? info.description ?? info.assignment) && (
          <div className="subagent-dialog-task">{info.task ?? info.description ?? info.assignment}</div>
        )}
        <div className="subagent-stats">
          {stats.map(([label, value]) =>
            value ? (
              <div key={label} className="subagent-stat">
                <span className="subagent-stat-label">{label}</span>
                <span className="subagent-stat-value">{value}</span>
              </div>
            ) : null,
          )}
        </div>
        {output.length > 0 && (
          <div className="subagent-output">
            <div className="context-menu-group">Recent output</div>
            <pre>{output.join("\n")}</pre>
          </div>
        )}
        {activity.length > 0 && (
          <div className="subagent-activity">
            <div className="context-menu-group">Activity</div>
            <div className="subagent-activity-list">
              {[...activity].reverse().map((entry, i) => (
                <div key={i} className="subagent-activity-row">
                  <span className={`subagent-activity-kind ${entry.kind}`}>{entry.kind === "tool" ? "→" : "·"}</span>
                  <span className="subagent-activity-label">{entry.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {output.length === 0 && activity.length === 0 && (
          <div className="context-menu-empty">No activity reported yet…</div>
        )}
      </div>
    </div>
  );
}
