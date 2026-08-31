"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Download, Info, LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/components/ui/toast";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { MarkdownBody } from "./MarkdownBody";

export type AppUpdatePhase = "idle" | "preparing" | "restarting" | "completed" | "failed";
export type AppUpdateStage = "preparing" | "stopping" | "installing" | "restarting" | "finalizing";

const APP_UPDATE_STEPS: ReadonlyArray<{ stage: AppUpdateStage; labelKey: string }> = [
  { stage: "preparing", labelKey: "appUpdateDialog.stepPrepare" },
  { stage: "stopping", labelKey: "appUpdateDialog.stepStopSessions" },
  { stage: "installing", labelKey: "appUpdateDialog.stepInstall" },
  { stage: "restarting", labelKey: "appUpdateDialog.stepRestart" },
  { stage: "finalizing", labelKey: "appUpdateDialog.stepFinish" },
];

const APP_UPDATE_STEP_BY_STAGE: Record<AppUpdateStage, number> = {
  preparing: 0,
  stopping: 1,
  installing: 2,
  restarting: 3,
  finalizing: 4,
};

export function getAppUpdateStageIndex(stage: AppUpdateStage): number {
  return APP_UPDATE_STEP_BY_STAGE[stage];
}

export function getNextAppUpdateStage(stage: AppUpdateStage): AppUpdateStage | undefined {
  const nextStep = APP_UPDATE_STEPS[getAppUpdateStageIndex(stage) + 1];
  return nextStep?.stage;
}

export function getMonotonicAppUpdateStage(
  current: AppUpdateStage | undefined,
  next: AppUpdateStage,
): AppUpdateStage {
  return current === undefined || getAppUpdateStageIndex(next) > getAppUpdateStageIndex(current)
    ? next
    : current;
}

export function getAppUpdateStepIndex(phase: AppUpdatePhase, stage?: AppUpdateStage): number {
  if (phase === "completed") return APP_UPDATE_STEPS.length;
  if (stage !== undefined) return getAppUpdateStageIndex(stage);
  if (phase === "preparing") return 0;
  return phase === "restarting" ? 1 : 0;
}
const MAX_RELEASE_NOTES_BYTES = 64 * 1024;

interface AppUpdateReleaseNotes {
  version: string;
  body: string;
  htmlUrl: string;
}

function isSafeReleaseUrl(value: string, version: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && url.pathname === `/kahme247/ompweb/releases/tag/v${version}`;
  } catch {
    return false;
  }
}

function parseReleaseNotes(value: unknown, expectedVersion: string): AppUpdateReleaseNotes | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== expectedVersion
    || typeof candidate.body !== "string"
    || candidate.body.length > MAX_RELEASE_NOTES_BYTES
    || candidate.body.trim().length === 0
    || new TextEncoder().encode(candidate.body).byteLength > MAX_RELEASE_NOTES_BYTES
    || typeof candidate.htmlUrl !== "string"
    || !isSafeReleaseUrl(candidate.htmlUrl, expectedVersion)
  ) {
    return null;
  }
  return {
    version: expectedVersion,
    body: candidate.body,
    htmlUrl: candidate.htmlUrl,
  };
}

export async function loadAppUpdateReleaseNotes(
  expectedVersion: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AppUpdateReleaseNotes | null> {
  const response = await fetcher("/api/app-update/notes", { signal });
  if (!response.ok || response.status === 204) return null;

  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
  return parseReleaseNotes(value, expectedVersion);
}

export interface AppUpdateInfo {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand?: string;
  selfUpdateSupported?: boolean;
  selfUpdateStatus?: {
    attemptId: string;
    state: string;
    fromVersion: string;
    targetVersion: string;
    preparedAt: string;
    stage?: AppUpdateStage;
    startedAt?: string;
    finishedAt?: string;
    recovered?: boolean;
    cleanupReady?: boolean;
    error?: string;
  } | null;
  appUpdateDrain?: {
    state: "waiting" | "stopping" | "stopped" | "failed";
    total: number;
    stopped: number;
    processes: Array<{
      sessionId: string;
      name?: string;
      pid?: number;
      activity: "running" | "idle";
      state: "stopping" | "stopped";
    }>;
  };
}

export function getAppUpdateVersionTransition(
  update: AppUpdateInfo | null,
  phase: AppUpdatePhase,
): { fromVersion: string; targetVersion: string } | null {
  const fromVersion = update?.selfUpdateStatus?.fromVersion ?? update?.currentVersion ?? "?";
  const targetVersion = update?.selfUpdateStatus?.targetVersion ?? update?.availableVersion;
  if (!targetVersion || (phase === "completed" && fromVersion === targetVersion)) return null;
  return { fromVersion, targetVersion };
}

interface AppUpdateDialogProps {
  open: boolean;
  update: AppUpdateInfo | null;
  phase: AppUpdatePhase;
  visibleStage?: AppUpdateStage;
  error: string | null;
  onProceed: () => void;
  onNotNow: () => void;
}

export function AppUpdateDialog({ open, update, phase, visibleStage, error, onProceed, onNotNow }: AppUpdateDialogProps) {
  const { t } = useI18n();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [releaseNotes, setReleaseNotes] = useState<AppUpdateReleaseNotes | null>(null);
  const availableVersion = update?.availableVersion;
  const shouldLoadReleaseNotes = open
    && phase === "idle"
    && update?.updateAvailable === true
    && typeof availableVersion === "string"
    && availableVersion.length > 0;
  const visibleReleaseNotes = shouldLoadReleaseNotes && releaseNotes?.version === availableVersion
    ? releaseNotes
    : null;

  useEffect(() => {
    if (!shouldLoadReleaseNotes || !availableVersion || releaseNotes?.version === availableVersion) return;

    const controller = new AbortController();
    setReleaseNotes(null);
    void loadAppUpdateReleaseNotes(availableVersion, controller.signal)
      .then((notes) => {
        if (controller.signal.aborted || notes?.version !== availableVersion) return;
        setReleaseNotes(notes);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setReleaseNotes(null);
      });

    return () => controller.abort();
  }, [availableVersion, releaseNotes?.version, shouldLoadReleaseNotes]);
  const busy = phase === "preparing" || phase === "restarting" || phase === "completed";
  const command = update?.updateCommand || "npm install -g @kahme247/ompweb";
  const completedVersion = update?.selfUpdateStatus?.targetVersion ?? update?.availableVersion ?? update?.currentVersion ?? "?";
  const versionTransition = getAppUpdateVersionTransition(update, phase);
  const effectiveStage = visibleStage ?? update?.selfUpdateStatus?.stage;
  const currentStepIndex = getAppUpdateStepIndex(phase, effectiveStage);
  const drain = update?.appUpdateDrain;
  const showDrain = effectiveStage === "stopping" && drain !== undefined && drain.processes.length > 0;
  const drainSummary = showDrain
    ? t("appUpdateDialog.drainSummary", { stopped: drain.stopped, total: drain.total })
    : null;
  const recoveryMessage = update?.selfUpdateStatus?.recovered === true
    ? t("appUpdateDialog.recoverySucceeded")
    : update?.selfUpdateStatus?.recovered === false
      ? t("appUpdateDialog.recoveryFailed")
      : null;
  const dialogTitle = phase === "failed"
    ? t("appUpdateDialog.failedTitle")
    : phase === "completed"
      ? t("appUpdateDialog.completedTitle")
      : t("appUpdateDialog.title");
  const dialogDescription = phase === "preparing"
    ? t("appUpdateDialog.preparing")
    : phase === "restarting"
      ? t("appUpdateDialog.restarting")
      : phase === "completed"
        ? t("appUpdateDialog.completed", { version: completedVersion })
        : phase === "failed"
          ? t("appUpdateDialog.failedDescription")
          : t("appUpdateDialog.description");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onNotNow(); }}>
      <DialogContent ariaLabel={dialogTitle} style={{ width: 500, maxWidth: "min(94vw, 500px)", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: "var(--radius-control)", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-subtle)", color: "var(--accent)" }}>
            {phase === "failed"
              ? <AlertTriangle size={19} aria-hidden="true" />
              : phase === "completed"
                ? <CheckCircle2 size={19} aria-hidden="true" />
                : phase === "restarting"
                  ? <LoaderCircle size={19} aria-hidden="true" style={prefersReducedMotion ? undefined : { animation: "spin 1s linear infinite" }} />
                  : <Download size={19} aria-hidden="true" />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <DialogTitle style={{ margin: 0 }}>{dialogTitle}</DialogTitle>
            <p style={{ margin: "6px 0 0", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.55 }}>
              {dialogDescription}
            </p>
          </div>
        </div>

        {versionTransition && (
          <div style={{ marginTop: 18, padding: "11px 13px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span>v{versionTransition.fromVersion}</span><span aria-hidden="true">→</span><span>v{versionTransition.targetVersion}</span>
          </div>
        )}

        {phase === "idle" && visibleReleaseNotes && (
          <details style={{ marginTop: 14, maxWidth: "100%", minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
            <summary style={{ padding: "10px 13px", cursor: "pointer", color: "var(--text)", fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>
              {t("appUpdateDialog.releaseNotesTitle", { version: visibleReleaseNotes.version })}
            </summary>
            <div style={{ borderTop: "1px solid var(--border)", padding: "12px 13px" }}>
              <div
                role="region"
                aria-label={t("appUpdateDialog.releaseNotesTitle", { version: visibleReleaseNotes.version })}
                tabIndex={0}
                style={{ maxHeight: 260, maxWidth: "100%", overflow: "auto", overflowWrap: "anywhere", color: "var(--text)", fontSize: 12, lineHeight: 1.55 }}
              >
                <MarkdownBody className="markdown-release-notes" suppressImages>{visibleReleaseNotes.body}</MarkdownBody>
              </div>
              <a href={visibleReleaseNotes.htmlUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 10, color: "var(--accent)", fontSize: 12, overflowWrap: "anywhere" }}>
                {t("appUpdateDialog.viewRelease")}
              </a>
            </div>
          </details>
        )}

        {phase !== "idle" && (
          <ol aria-label={t("appUpdateDialog.progressLabel")} aria-live="polite" style={{ margin: "16px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 7 }}>
            {APP_UPDATE_STEPS.map((step, index) => {
              const isCurrent = index === currentStepIndex;
              const isFailed = phase === "failed" && isCurrent;
              const isCompleted = index < currentStepIndex;
              const label = t(step.labelKey);
              const accessibleLabel = isFailed
                ? `${label}, ${t("appUpdateDialog.stepFailed")}`
                : isCompleted
                  ? `${label}, ${t("appUpdateDialog.stepCompleted")}`
                  : isCurrent
                    ? `${label}, ${t("appUpdateDialog.stepCurrent")}`
                    : label;
              const color = isFailed
                ? "var(--status-error)"
                : isCompleted
                  ? "var(--status-success)"
                  : isCurrent
                    ? "var(--accent)"
                    : "var(--text-muted)";

              return (
                <li
                  key={step.stage}
                  aria-current={isCurrent ? "step" : undefined}
                  aria-label={accessibleLabel}
                  style={{
                    minHeight: 34,
                    padding: "7px 9px",
                    borderRadius: "var(--radius-control)",
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    background: isCurrent ? "var(--bg-subtle)" : "transparent",
                    color,
                    fontSize: 12,
                    fontWeight: isCurrent ? 600 : 500,
                    opacity: !isCurrent && !isCompleted ? 0.65 : 1,
                  }}
                >
                  {isFailed
                    ? <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                    : isCompleted
                      ? <CheckCircle2 size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                      : isCurrent
                        ? <LoaderCircle size={16} aria-hidden="true" style={{ flexShrink: 0, ...(prefersReducedMotion ? {} : { animation: "spin 1s linear infinite" }) }} />
                        : <Circle size={16} aria-hidden="true" style={{ flexShrink: 0 }} />}
                  <span>{label}</span>
                </li>
              );
            })}
          </ol>
        )}

        {showDrain && drainSummary && (
          <section
            aria-label={drainSummary}
            style={{ marginTop: 10, padding: "10px 11px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", fontSize: 11 }}
          >
            <div role="status" aria-live="polite" style={{ color: "var(--text-muted)", fontWeight: 600 }}>
              {drainSummary}
            </div>
            <ul style={{ maxHeight: 150, overflowY: "auto", margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
              {drain.processes.map((process) => {
                const label = process.name?.trim() || process.sessionId.slice(0, 8);
                const activity = t(`appUpdateDialog.activity.${process.activity}`);
                const processState = t(`appUpdateDialog.drainState.${process.state}`);
                return (
                  <li
                    key={process.sessionId}
                    aria-label={`${label}, ${activity}, ${processState}`}
                    style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 7, color: "var(--text)" }}
                  >
                    {process.state === "stopped"
                      ? <CheckCircle2 size={14} aria-hidden="true" style={{ flexShrink: 0, color: "var(--status-success)" }} />
                      : <LoaderCircle size={14} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)", ...(prefersReducedMotion ? {} : { animation: "spin 1s linear infinite" }) }} />}
                    <span title={process.sessionId} style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>{label}</span>
                    {process.pid !== undefined && <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{t("appUpdateDialog.drainPid", { pid: process.pid })}</span>}
                    <span style={{ flexShrink: 0, color: "var(--text-muted)" }}>{activity}</span>
                    <span style={{ flexShrink: 0, color: process.state === "stopped" ? "var(--status-success)" : "var(--accent)" }}>{processState}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {phase === "idle" && (
          <div style={{ marginTop: 18, padding: "13px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", display: "grid", gap: 9, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
            {[
              t("appUpdateDialog.activeSessionsWarning"),
              t("appUpdateDialog.savedSessionsWarning"),
              t("appUpdateDialog.disconnectWarning"),
              t("appUpdateDialog.automaticRestart"),
            ].map((message) => (
              <div key={message} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                <span aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }}>•</span>
                <span>{message}</span>
              </div>
            ))}
          </div>
        )}

        {phase === "failed" && (
          <div role="alert" style={{ marginTop: 16, padding: "10px 12px", border: "1px solid var(--status-error)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", fontSize: 12, lineHeight: 1.5 }}>
            {error && <div>{error}</div>}
            {recoveryMessage && (
              <div style={{ marginTop: error ? 8 : 0, display: "flex", alignItems: "flex-start", gap: 6, color: update?.selfUpdateStatus?.recovered ? "var(--status-success)" : "var(--status-error)" }}>
                {update?.selfUpdateStatus?.recovered
                  ? <CheckCircle2 size={14} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} />
                  : <AlertTriangle size={14} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} />}
                <span>{recoveryMessage}</span>
              </div>
            )}
            <div style={{ marginTop: error || recoveryMessage ? 10 : 0 }}>{t("appUpdateDialog.failedFallback")}</div>
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", color: "var(--accent)", fontFamily: "var(--font-mono)" }}>{command}</code>
              <button type="button" onClick={() => void copyText(command).then(() => toast.success(t("appShell.commandCopied"))).catch(() => toast.error(t("appShell.commandCopyFailed")))} style={{ padding: "5px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}>
                {t("appShell.copyCommand")}
              </button>
            </div>
          </div>
        )}

        {phase === "restarting" && (
          <p role="note" style={{ margin: "16px 0 0", paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 8, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
            <Info size={14} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} /> <span>{t("appUpdateDialog.keepOpen")}</span>
          </p>
        )}

        {phase === "completed" && (
          <div role="status" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8, color: "var(--status-success)", fontSize: 12 }}>
            <CheckCircle2 size={14} aria-hidden="true" /> {t("appUpdateDialog.reloading")}
          </div>
        )}

        <div style={{ marginTop: 22, display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          {!busy && (
            <button type="button" onClick={onNotNow} style={{ padding: "7px 13px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
              {phase === "failed" ? t("appUpdateDialog.close") : t("appUpdateDialog.notNow")}
            </button>
          )}
          {phase === "idle" && (
            <button type="button" onClick={onProceed} style={{ padding: "7px 13px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", flexShrink: 0 }}>
              <Download size={13} aria-hidden="true" /> {t("appUpdateDialog.proceed")}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
