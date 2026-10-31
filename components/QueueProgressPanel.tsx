"use client";

// Composer-attached queue panel: omp's queued prompts plus the progress the
// server's ledger tracks for the current batch (lib/queue-progress.ts) —
// done items with their duration, the running item, pending items (still
// editable while omp holds them), failed and cancelled ones.

import React, { useState } from "react";
import { Ban, Check, ChevronDown, Circle, CircleAlert, Loader2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { QueuePanelItem, QueueProgressStatus } from "@/lib/queue-progress";
import { formatDuration } from "@/lib/subagent-format";
import { QueuedActionButton } from "./ChatInput-banners";

export interface QueuedEntry {
  kind: "follow-up" | "steer";
  text: string;
}

interface QueueProgressPanelProps {
  items: QueuePanelItem[];
  /** A queue mutation is awaiting omp's answer. */
  actionPending: boolean;
  canRemove: boolean;
  canPromote: boolean;
  /** Steering is refused right now (e.g. a dictation is still submitting). */
  promoteBlocked: boolean;
  onAction: (entry: QueuedEntry, action: "edit" | "steer") => void;
  onDelete: (entry: QueuedEntry) => void;
  onDismiss?: () => void;
}

const STATUS_COLORS: Record<QueueProgressStatus, string> = {
  queued: "var(--text-dim)",
  running: "var(--accent)",
  done: "var(--status-success)",
  failed: "var(--status-error)",
  cancelled: "var(--text-dim)",
};

function StatusIcon({ status, label }: { status: QueueProgressStatus; label: string }) {
  const props = { size: 12, strokeWidth: 2, "aria-hidden": true as const };
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-queue-status={status}
      style={{ display: "inline-flex", flexShrink: 0, color: STATUS_COLORS[status] }}
    >
      {status === "running" ? <Loader2 {...props} className="animate-spin" />
        : status === "done" ? <Check {...props} />
          : status === "failed" ? <CircleAlert {...props} />
            : status === "cancelled" ? <Ban {...props} />
              : <Circle {...props} size={10} />}
    </span>
  );
}

export function QueueProgressPanel({
  items, actionPending, canRemove, canPromote, promoteBlocked, onAction, onDelete, onDismiss,
}: QueueProgressPanelProps) {
  const { t } = useI18n();
  const finished = items.every((item) => item.status !== "queued" && item.status !== "running");
  // The list starts collapsed and folds back into the summary once every item
  // has finished (state derived from the previous render, not an effect).
  const [view, setView] = useState({ expanded: false, finished });
  if (view.finished !== finished) setView({ expanded: finished ? false : view.expanded, finished });
  const expanded = view.expanded;
  const toggle = () => setView((current) => ({ ...current, expanded: !current.expanded }));

  const count = (status: QueueProgressStatus) => items.filter((item) => item.status === status).length;
  const failed = count("failed");
  const cancelled = count("cancelled");
  const statusLabel = (status: QueueProgressStatus) => t(`chatInput.queueStatus.${status}`);
  const current = items.find((item) => item.status === "running") ?? items.find((item) => item.status === "queued");

  const renderItem = (item: QueuePanelItem) => {
    const entry: QueuedEntry = { kind: item.queue === "steering" ? "steer" : "follow-up", text: item.text };
    const duration = item.status === "done" && item.startedAt !== undefined && item.finishedAt !== undefined
      ? formatDuration(item.finishedAt - item.startedAt)
      : null;
    const steer = entry.kind === "steer";
    return (
      <div
        key={item.id}
        data-queue-item={item.status}
        style={{
          padding: "4px 8px 4px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          background: "var(--bg-panel)",
          fontSize: 12,
        }}
      >
        <StatusIcon status={item.status} label={statusLabel(item.status)} />
        <span style={{
          flexShrink: 0,
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          padding: "1px 4px",
          borderRadius: 4,
          background: steer ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "var(--bg)",
          border: `1px solid ${steer ? "var(--accent)" : "var(--border)"}`,
          color: steer ? "var(--accent)" : "var(--text-muted)",
        }}>
          {steer ? t("chatInput.queuedSteer") : t("chatInput.queuedFollowUp")}
        </span>
        <span
          title={item.text}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: item.status === "failed" ? "var(--status-error)"
              : item.status === "queued" || item.status === "running" ? "var(--text)" : "var(--text-muted)",
            textDecoration: item.status === "cancelled" ? "line-through" : "none",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
          }}
        >
          {item.text}
        </span>
        {duration && (
          <span
            title={t("chatInput.queueDurationTitle", { duration })}
            style={{ flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5 }}
          >
            {duration}
          </span>
        )}
        {item.status === "queued" && item.actionable && (
          <>
            <QueuedActionButton disabled={actionPending || !canRemove} onClick={() => onAction(entry, "edit")} title={t("chatInput.queuedEditTitle")}>
              {t("chatInput.queuedEdit")}
            </QueuedActionButton>
            <QueuedActionButton disabled={actionPending || !canRemove} onClick={() => onDelete(entry)} title={t("chatInput.queuedDeleteTitle")}>
              {t("chatInput.queuedDelete")}
            </QueuedActionButton>
            {!steer && (
              <QueuedActionButton disabled={promoteBlocked || actionPending || !canPromote} onClick={() => onAction(entry, "steer")} title={t("chatInput.queuedSteerTitle")} accent>
                {t("chatInput.queuedSteerAction")}
              </QueuedActionButton>
            )}
          </>
        )}
      </div>
    );
  };

  const dismissButton = finished && onDismiss && (
    <button
      type="button"
      onClick={onDismiss}
      title={t("chatInput.queueDismissTitle")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: "none",
        border: "none",
        padding: "2px 6px",
        cursor: "pointer",
        color: "var(--text-dim)",
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <X size={12} strokeWidth={2} aria-hidden="true" />
      {t("chatInput.queueDismiss")}
    </button>
  );

  return (
    <div
      aria-label={t("chatInput.queuedPrompts")}
      style={{
        border: "1px solid var(--border)",
        borderBottom: "none",
        borderRadius: "var(--radius-card) var(--radius-card) 0 0",
        background: "var(--bg-panel)",
        overflow: "hidden",
      }}
    >
      {items.length === 1 ? (
        <div style={{ display: "flex", alignItems: "center", paddingRight: dismissButton ? 4 : 0 }}>
          <div style={{ flex: 1, minWidth: 0, padding: "1px 0" }}>{renderItem(items[0])}</div>
          {dismissButton}
        </div>
      ) : (
        <>
          <div style={{
            padding: "5px 8px 5px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            borderBottom: expanded ? "1px solid var(--border)" : "none",
          }}>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={expanded}
              title={expanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--text-muted)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                minWidth: 0,
                flex: 1,
                textAlign: "left",
              }}
            >
              <ChevronDown
                size={13}
                strokeWidth={2}
                style={{
                  transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform var(--dur-fast) var(--ease-out-warm)",
                  flexShrink: 0,
                }}
                aria-hidden
              />
              <span style={{ flexShrink: 0 }}>{t("chatInput.queuedPrompts")}</span>
              <span
                data-queue-progress
                style={{ flexShrink: 0, color: finished && failed === 0 ? "var(--status-success)" : "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}
              >
                {t("chatInput.queueProgress", { done: count("done"), total: items.length })}
                {failed > 0 && <span style={{ color: "var(--status-error)" }}>{` · ${t("chatInput.queueFailedCount", { count: failed })}`}</span>}
                {cancelled > 0 && ` · ${t("chatInput.queueCancelledCount", { count: cancelled })}`}
              </span>
              {!expanded && current && (
                <span style={{
                  marginLeft: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  minWidth: 0,
                  color: "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 400,
                  textTransform: "none",
                  letterSpacing: 0,
                }}>
                  <StatusIcon status={current.status} label={statusLabel(current.status)} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {current.queue === "steering" ? `[${t("chatInput.queuedSteer")}] ` : ""}{current.text}
                  </span>
                </span>
              )}
            </button>
            {dismissButton || (
              <button
                type="button"
                onClick={toggle}
                style={{
                  background: "none",
                  border: "none",
                  padding: "2px 6px",
                  cursor: "pointer",
                  color: "var(--text-dim)",
                  fontSize: 11,
                  flexShrink: 0,
                }}
              >
                {expanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
              </button>
            )}
          </div>
          {expanded && (
            <div style={{
              maxHeight: 180,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              background: "var(--bg-subtle)",
              padding: "4px 0",
            }}>
              {items.map(renderItem)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
