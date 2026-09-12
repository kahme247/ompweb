"use client";

import { MarkdownBody } from "./MarkdownBody";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { getHubJobs, getHubJobsHeader, getHubSendSummary } from "./MessageView-tool-format";
import { isRecord } from "@/lib/type-guards";
import type { ToolResultMessage } from "@/lib/types";

/** TUI-style duration: `45s`, `31m30s`, `2h5m`. */
function formatJobDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 1000) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function hubReceipts(details: unknown): Array<{ to: string; outcome: string }> {
  if (!isRecord(details) || !Array.isArray(details.receipts)) return [];
  const out: Array<{ to: string; outcome: string }> = [];
  for (const raw of details.receipts) {
    if (!isRecord(raw) || typeof raw.to !== "string") continue;
    out.push({ to: raw.to, outcome: typeof raw.outcome === "string" ? raw.outcome : "sent" });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Semantic body for `hub` tool calls, mirroring the TUI status area:
 * outgoing steering (`op: "send"` → the `IRC → X` row) renders the steered
 * message plus delivery receipts; the job roster (`op: "jobs"` → the
 * `waiting on N jobs` row) renders the structured job list. Returns null
 * for other hub ops so the generic tool rendering stays.
 */
export function HubResultPanel({ input, result }: { input: unknown; result?: ToolResultMessage }) {
  if (!isRecord(input) || typeof input.op !== "string") return null;

  if (input.op === "send") {
    const send = getHubSendSummary(input);
    if (!send) return null;
    const receipts = hubReceipts(result?.details);
    return (
      <div
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--bg-subtle)",
          padding: "8px 10px",
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
          <span style={{ fontWeight: 600, color: "var(--text)" }}>
            {`IRC → ${send.to.join(", ")}`}
          </span>
          {receipts.length > 0 && (
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontSize: 10.5 }}>
              {receipts.map((receipt) => receipt.outcome).join(" · ")}
            </span>
          )}
        </div>
        {send.message ? (
          <MarkdownBody className="markdown-hub-message">{send.message}</MarkdownBody>
        ) : null}
      </div>
    );
  }
  if (input.op === "jobs") {
    const jobs = getHubJobs(result?.details);
    if (!jobs) return null;
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
          <span style={{ fontWeight: 600, color: "var(--text)" }}>
            {getHubJobsHeader(jobs)}
          </span>
        </div>
        {jobs.map((job) => {
          const duration = formatJobDuration(job.durationMs);
          return (
            <div
              key={job.id}
              style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 11.5 }}
            >
              <SubagentStatusIcon status={job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : "started"} />
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
                {`[${job.type}]`}
              </span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, color: "var(--text)" }}>
                {job.label}
              </span>
              {duration && (
                <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                  {duration}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return null;
}
