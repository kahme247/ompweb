"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CalendarClock, ChevronDown, ChevronRight, ExternalLink, Loader2, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Alert, Check, ConfirmDialog, Field, NumInput, TextInput } from "@/components/ui/field";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/primitives";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { formatApiError, type ApiErrorPayload } from "@/lib/i18n/api-error";
import {
  parseScheduledTaskInput,
  SCHEDULED_TASK_LIMITS,
  type ScheduledTaskFieldErrors,
  type ScheduledTaskInput,
  type ScheduledTaskListResponse,
  type ScheduledTaskRun,
  type ScheduledTaskRunStatus,
  type ScheduledTaskSessionMode,
  type ScheduleWeekday,
  type TaskSchedule,
} from "@/lib/scheduled-tasks";
import { DEFAULT_THINKING_LEVELS } from "@/lib/thinking-levels";
import type { ManagedProject } from "@/lib/types";

type ListedTask = ScheduledTaskListResponse["tasks"][number];
type Translate = (key: string, vars?: Record<string, string | number>) => string;
type TranslatePlural = (key: string, count: number, vars?: Record<string, string | number>) => string;
type ModelEntry = { id: string; name: string; provider: string };
type ErrorBody = ApiErrorPayload & { fields?: ScheduledTaskFieldErrors };

const POLL_INTERVAL_MS = 15_000;
const CUSTOM_WORKSPACE = "\u0000custom";
/** Monday-first, as the weekday checkboxes and summaries list them. */
const WEEKDAY_ORDER: readonly ScheduleWeekday[] = [1, 2, 3, 4, 5, 6, 0];

const buttonStyle: CSSProperties = { padding: "5px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 };
const primaryButtonStyle: CSSProperties = { ...buttonStyle, border: "1px solid var(--accent-strong)", background: "var(--accent-strong)", color: "var(--on-accent)" };
const linkButtonStyle: CSSProperties = { padding: 0, border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11 };
const controlStyle: CSSProperties = { width: "100%", boxSizing: "border-box", padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 };

const STATUS_COLORS: Record<ScheduledTaskRunStatus, string> = {
  running: "var(--accent)",
  completed: "var(--status-success)",
  failed: "var(--status-error)",
  skipped: "var(--text-muted)",
  interrupted: "var(--status-warning)",
};

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function weekdayName(locale: string, day: ScheduleWeekday, width: "long" | "short"): string {
  // 2023-01-01 was a Sunday, so day N of that week matches Date#getDay() === N.
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + day)));
}

/** Human summary of a schedule in the UI language; wall-clock times are the server's. */
function describeSchedule(schedule: TaskSchedule, locale: string, t: Translate, tn: TranslatePlural): string {
  if (schedule.kind === "interval") {
    const minutes = schedule.everyMinutes;
    if (minutes % 1440 === 0) return tn("scheduledTasks.summary.days", minutes / 1440);
    if (minutes % 60 === 0) return tn("scheduledTasks.summary.hours", minutes / 60);
    return tn("scheduledTasks.summary.minutes", minutes);
  }
  const time = schedule.time;
  if (schedule.kind === "daily") return t("scheduledTasks.summary.daily", { time });
  const days = schedule.days;
  if (days.length === 7) return t("scheduledTasks.summary.everyDay", { time });
  // Stored weekdays are unique and sorted ascending (parseScheduledTaskInput).
  const dayList = days.join(",");
  if (dayList === "1,2,3,4,5") return t("scheduledTasks.summary.weekdays", { time });
  if (dayList === "0,6") return t("scheduledTasks.summary.weekends", { time });
  const ordered = WEEKDAY_ORDER.filter((day) => days.includes(day));
  const width = ordered.length === 1 ? "long" : "short";
  const names = new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(ordered.map((day) => weekdayName(locale, day, width)));
  return t("scheduledTasks.summary.weekly", { days: names, time });
}

function StatusBadge({ status }: { status: ScheduledTaskRunStatus }) {
  const { t } = useI18n();
  const color = STATUS_COLORS[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 7px", borderRadius: 999, border: `1px solid color-mix(in srgb, ${color} 45%, var(--border))`, background: `color-mix(in srgb, ${color} 10%, transparent)`, color, fontSize: 10, fontWeight: 600, lineHeight: 1.6, whiteSpace: "nowrap" }}>
      {status === "running" ? <Loader2 size={10} aria-hidden="true" style={{ animation: "spin 1s linear infinite" }} /> : null}
      {t(`scheduledTasks.status.${status}`)}
    </span>
  );
}

function RunError({ error }: { error: string }) {
  return <div style={{ fontSize: 11, color: "var(--status-error)", lineHeight: 1.45, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{error}</div>;
}

export function ScheduledTasksConfig({ cwd, onOpenSession }: { cwd: string | null; onOpenSession?: (sessionId: string) => void }) {
  const { t, tn, locale } = useI18n();
  const [data, setData] = useState<ScheduledTaskListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [editing, setEditing] = useState<ListedTask | "new" | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ListedTask | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const aliveRef = useRef(true);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const isCurrent = () => aliveRef.current && loadGenerationRef.current === generation;
    try {
      const res = await fetch("/api/scheduled-tasks", { cache: "no-store" });
      const body = await readJson<ScheduledTaskListResponse & ErrorBody>(res);
      if (!isCurrent()) return;
      if (!res.ok || !body || !Array.isArray(body.tasks)) throw new Error(formatApiError(body, "scheduledTasks.loadFailed"));
      setData(body);
      setLoadError(null);
    } catch (error) {
      if (!isCurrent()) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    // Workspace and model choices are conveniences: the form still accepts a
    // typed path and the default model when either list cannot be read.
    void fetch("/api/projects")
      .then((res) => (res.ok ? readJson<{ projects?: ManagedProject[] }>(res) : null))
      .then((body) => { if (aliveRef.current && Array.isArray(body?.projects)) setProjects(body.projects); })
      .catch(() => {});
    void fetch("/api/models")
      .then((res) => (res.ok ? readJson<{ modelList?: ModelEntry[] }>(res) : null))
      .then((body) => { if (aliveRef.current && Array.isArray(body?.modelList)) setModels(body.modelList); })
      .catch(() => {});
  }, []);

  const timeZone = data?.timeZone ?? "";
  // Run times are instants; show them in the server's zone, as the panel
  // labels them. A zone this browser does not know falls back to its own.
  const dateTime = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
    } catch {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    }
  }, [locale, timeZone]);
  const formatInstant = useCallback((iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
  }, [dateTime]);

  const runsByTask = useMemo(() => {
    const map = new Map<string, ScheduledTaskRun[]>();
    for (const run of data?.runs ?? []) {
      const list = map.get(run.taskId);
      if (list) list.push(run);
      else map.set(run.taskId, [run]);
    }
    return map;
  }, [data?.runs]);

  const tasks = data?.tasks ?? [];

  const setEnabled = async (task: ListedTask, enabled: boolean) => {
    setBusyTaskId(task.id);
    try {
      const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      if (!res.ok) toast.error(t("scheduledTasks.toggleFailed", { name: task.name }), formatApiError(await readJson<ErrorBody>(res)));
    } catch (error) {
      toast.error(t("scheduledTasks.toggleFailed", { name: task.name }), error instanceof Error ? error.message : String(error));
    } finally {
      if (aliveRef.current) setBusyTaskId(null);
      await load();
    }
  };

  const runNow = async (task: ListedTask) => {
    setBusyTaskId(task.id);
    try {
      const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
      const body = await readJson<ErrorBody & { run?: ScheduledTaskRun }>(res);
      if (res.ok) {
        // 202 also carries runs that were skipped or failed to start.
        const run = body?.run;
        const sessionId = run?.sessionId ?? null;
        if (run?.status === "failed") {
          toast.error(t("scheduledTasks.runFailed", { name: task.name }), run.error ?? undefined);
        } else if (run?.status === "skipped") {
          toast.info(t("scheduledTasks.runSkipped", { name: task.name }), run.error ?? undefined);
        } else {
          toast.success(
            t("scheduledTasks.runStarted", { name: task.name }),
            sessionId && onOpenSession ? t("scheduledTasks.runStartedOpen") : undefined,
            sessionId && onOpenSession ? { onClick: () => onOpenSession(sessionId) } : undefined,
          );
        }
      } else if (res.status === 409 && body?.code === "scheduled_task_running") {
        toast.info(t("scheduledTasks.alreadyRunning", { name: task.name }));
      } else {
        toast.error(t("scheduledTasks.runFailed", { name: task.name }), formatApiError(body));
      }
    } catch (error) {
      toast.error(t("scheduledTasks.runFailed", { name: task.name }), error instanceof Error ? error.message : String(error));
    } finally {
      if (aliveRef.current) setBusyTaskId(null);
      await load();
    }
  };

  const confirmDelete = async () => {
    const task = pendingDelete;
    if (!task) return;
    setBusyTaskId(task.id);
    try {
      const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(t("scheduledTasks.deleted", { name: task.name }));
        if (editing !== "new" && editing?.id === task.id) setEditing(null);
      } else {
        toast.error(t("scheduledTasks.deleteFailed", { name: task.name }), formatApiError(await readJson<ErrorBody>(res)));
      }
    } catch (error) {
      toast.error(t("scheduledTasks.deleteFailed", { name: task.name }), error instanceof Error ? error.message : String(error));
    } finally {
      if (aliveRef.current) {
        setBusyTaskId(null);
        setPendingDelete(null);
      }
      await load();
    }
  };

  const toggleExpanded = (taskId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const sessionLink = (sessionId: string | null) => (
    sessionId && onOpenSession ? (
      <button type="button" className="ui-focus-ring" onClick={() => onOpenSession(sessionId)} style={linkButtonStyle}>
        <ExternalLink size={11} aria-hidden="true" /> {t("scheduledTasks.openSession")}
      </button>
    ) : null
  );

  const renderTask = (task: ListedTask) => {
    const runs = runsByTask.get(task.id) ?? [];
    const lastRun = runs[0] ?? null;
    const lastSessionId = runs.find((run) => run.sessionId)?.sessionId ?? task.lastSessionId;
    const busy = busyTaskId === task.id;
    const isExpanded = expanded.has(task.id);
    const recentId = `scheduled-task-runs-${task.id}`;
    return (
      <div key={task.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", boxShadow: "var(--shadow-card)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
          <div style={{ marginTop: -10, marginLeft: -6 }}>
            <ToggleSwitch checked={task.enabled} disabled={busy} onChange={(next) => void setEnabled(task, next)} aria-label={t("scheduledTasks.enableTask", { name: task.name })} />
          </div>
          <div style={{ flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>{task.name}</span>
              {task.running ? <StatusBadge status="running" /> : null}
              {!task.enabled ? <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)" }}>{t("scheduledTasks.paused")}</span> : null}
            </div>
            <div style={{ fontSize: 12, color: "var(--text)" }}>{describeSchedule(task.schedule, locale, t, tn)}</div>
            <div style={{ font: "11px var(--font-mono)", color: "var(--text-muted)", overflowWrap: "anywhere" }} title={task.cwd}>{task.cwd}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {t(`scheduledTasks.sessionMode.${task.sessionMode}`)}
              {task.model ? ` · ${models.find((m) => m.provider === task.model?.provider && m.id === task.model?.modelId)?.name ?? task.model.modelId}` : ""}
              {task.thinkingLevel ? ` · ${task.thinkingLevel}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="agent-config-action" onClick={() => void runNow(task)} disabled={busy || task.running} style={{ ...buttonStyle, cursor: busy || task.running ? "not-allowed" : "pointer", opacity: busy || task.running ? 0.6 : 1 }}>
              <Play size={13} aria-hidden="true" /> {t("scheduledTasks.runNow")}
            </button>
            <button type="button" className="agent-config-action" onClick={() => setEditing(task)} disabled={busy} style={buttonStyle}>
              <Pencil size={13} aria-hidden="true" /> {t("scheduledTasks.edit")}
            </button>
            <button type="button" className="agent-config-action" onClick={() => setPendingDelete(task)} disabled={busy} style={{ ...buttonStyle, color: "var(--status-error)" }}>
              <Trash2 size={13} aria-hidden="true" /> {t("scheduledTasks.delete")}
            </button>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "4px 14px", flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)" }}>
          <span>{task.enabled && task.nextRunAt ? t("scheduledTasks.nextRun", { time: formatInstant(task.nextRunAt) }) : t("scheduledTasks.noNextRun")}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {t("scheduledTasks.lastRun")}
            {lastRun ? (
              <>
                <StatusBadge status={lastRun.status} />
                <span>{formatInstant(lastRun.startedAt)}</span>
              </>
            ) : <span>{t("scheduledTasks.neverRun")}</span>}
          </span>
          {sessionLink(lastSessionId)}
        </div>
        {lastRun?.error ? <RunError error={lastRun.error} /> : null}
        <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(task.id)}>
          <CollapsibleTrigger type="button" className="ui-focus-ring" aria-controls={isExpanded ? recentId : undefined} style={{ ...linkButtonStyle, color: "var(--text-muted)" }}>
            {isExpanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {t("scheduledTasks.recentRuns", { count: runs.length })}
          </CollapsibleTrigger>
          {isExpanded ? (
            <div id={recentId} style={{ marginTop: 6, display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", overflow: "hidden" }}>
              {runs.length === 0 ? (
                <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("scheduledTasks.noRuns")}</div>
              ) : runs.map((run, index) => (
                <div key={run.id} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "7px 10px", borderTop: index === 0 ? "none" : "1px solid var(--border)", background: "var(--bg)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)" }}>
                    <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }} title={run.scheduledFor ? t("scheduledTasks.scheduledFor", { time: formatInstant(run.scheduledFor) }) : undefined}>{formatInstant(run.startedAt)}</span>
                    <span>{t(`scheduledTasks.trigger.${run.trigger}`)}</span>
                    <StatusBadge status={run.status} />
                    {sessionLink(run.sessionId)}
                  </div>
                  {run.error ? <RunError error={run.error} /> : null}
                </div>
              ))}
            </div>
          ) : null}
        </Collapsible>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {data && !data.schedulerEnabled ? <Alert variant="warning" description={t("scheduledTasks.schedulerDisabled")} /> : null}
      <Alert
        variant="info"
        title={t("scheduledTasks.noteTitle")}
        description={(
          <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
            <li>{t("scheduledTasks.noteRunning")}</li>
            <li>{t("scheduledTasks.noteCatchUp")}</li>
            <li>{t("scheduledTasks.noteOverlap")}</li>
            <li>{t("scheduledTasks.noteApprovals")}</li>
            <li>{t("scheduledTasks.noteSessions")}</li>
          </ul>
        )}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)", flexWrap: "wrap" }}>
          <CalendarClock size={14} aria-hidden="true" />
          <span>{tn("scheduledTasks.count", tasks.length)}</span>
          {timeZone ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("scheduledTasks.timeZone", { timeZone })}</span> : null}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" className="agent-config-action" onClick={() => { setLoading(true); void load(); }} disabled={loading} style={{ ...buttonStyle, cursor: loading ? "wait" : "pointer" }}>
            <RefreshCw size={13} aria-hidden="true" /> {t("scheduledTasks.reload")}
          </button>
          <button type="button" className="agent-config-action" onClick={() => setEditing("new")} disabled={editing !== null} style={{ ...primaryButtonStyle, opacity: editing !== null ? 0.65 : 1 }}>
            <Plus size={13} aria-hidden="true" /> {t("scheduledTasks.newTask")}
          </button>
        </div>
      </div>
      {loadError ? <Alert variant="error" title={t("scheduledTasks.loadFailed")} description={loadError} /> : null}
      {editing ? (
        <TaskEditor
          key={editing === "new" ? "new" : editing.id}
          task={editing === "new" ? null : editing}
          defaultCwd={cwd}
          projects={projects}
          models={models}
          timeZone={timeZone}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      ) : null}
      {tasks.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{tasks.map(renderTask)}</div>
      ) : editing === null ? (
        <div style={{ padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center", color: "var(--text-muted)", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)" }}>
          <CalendarClock size={22} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
          <div style={{ fontSize: 12 }}>{loading && !data ? t("scheduledTasks.loading") : t("scheduledTasks.emptyTitle")}</div>
          {!loading || data ? (
            <>
              <div style={{ fontSize: 11, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.5 }}>{t("scheduledTasks.emptyDesc")}</div>
              <button type="button" className="agent-config-action" onClick={() => setEditing("new")} style={{ ...primaryButtonStyle, marginTop: 6 }}>
                <Plus size={13} aria-hidden="true" /> {t("scheduledTasks.newTask")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title={t("scheduledTasks.deleteTitle")}
        description={pendingDelete ? t("scheduledTasks.deleteBody", { name: pendingDelete.name }) : undefined}
        confirmLabel={t("scheduledTasks.delete")}
        cancelLabel={t("scheduledTasks.cancel")}
        danger
        busy={pendingDelete !== null && busyTaskId === pendingDelete.id}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function modelKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

function FormSection({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <fieldset style={{ margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <legend style={{ padding: 0, marginBottom: 4, fontSize: 11, fontWeight: 500, color: error ? "var(--accent)" : "var(--text-muted)" }}>{label}</legend>
      {children}
      {error ? <span role="alert" style={{ fontSize: 12, color: "var(--status-error)", lineHeight: 1.3 }}>{error}</span> : null}
    </fieldset>
  );
}

function TaskEditor({ task, defaultCwd, projects, models, timeZone, onCancel, onSaved }: {
  task: ListedTask | null;
  defaultCwd: string | null;
  projects: ManagedProject[];
  models: ModelEntry[];
  timeZone: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const initialCwd = task?.cwd ?? defaultCwd ?? "";
  const [name, setName] = useState(task?.name ?? "");
  const [cwdChoice, setCwdChoice] = useState(initialCwd || CUSTOM_WORKSPACE);
  const [customCwd, setCustomCwd] = useState("");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [kind, setKind] = useState<TaskSchedule["kind"]>(task?.schedule.kind ?? "daily");
  const [everyMinutes, setEveryMinutes] = useState(task?.schedule.kind === "interval" ? String(task.schedule.everyMinutes) : "60");
  const [time, setTime] = useState(task && task.schedule.kind !== "interval" ? task.schedule.time : "09:00");
  const [days, setDays] = useState<ScheduleWeekday[]>(task?.schedule.kind === "weekly" ? task.schedule.days : []);
  const [sessionMode, setSessionMode] = useState<ScheduledTaskSessionMode>(task?.sessionMode ?? "new");
  const [model, setModel] = useState(task?.model ? modelKey(task.model.provider, task.model.modelId) : "");
  const [thinkingLevel, setThinkingLevel] = useState(task?.thinkingLevel ?? "");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [errors, setErrors] = useState<ScheduledTaskFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const aliveRef = useRef(true);
  // Re-arm on setup: StrictMode replays cleanup → setup on mount, and a
  // cleanup-only effect would leave the editor permanently "unmounted".
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const workspaceOptions = useMemo(() => {
    const options: Array<{ path: string; label: string }> = [];
    const seen = new Set<string>();
    const add = (path: string | null | undefined, label?: string) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      options.push({ path, label: label ? `${label} — ${path}` : path });
    };
    add(initialCwd);
    add(defaultCwd);
    for (const project of projects) add(project.path, project.alias);
    return options;
  }, [initialCwd, defaultCwd, projects]);

  const modelOptions = useMemo(() => {
    const options = models.map((entry) => ({ key: modelKey(entry.provider, entry.id), provider: entry.provider, modelId: entry.id, label: `${entry.name} · ${entry.provider}` }));
    // Keep a saved model selectable when its provider is not listed right now.
    if (task?.model && !options.some((option) => option.key === modelKey(task.model!.provider, task.model!.modelId))) {
      options.unshift({ key: modelKey(task.model.provider, task.model.modelId), provider: task.model.provider, modelId: task.model.modelId, label: `${task.model.modelId} · ${task.model.provider}` });
    }
    return options;
  }, [models, task?.model]);

  const buildInput = (): ScheduledTaskInput => {
    const schedule: TaskSchedule = kind === "interval"
      ? { kind, everyMinutes: Number(everyMinutes) }
      : kind === "daily" ? { kind, time } : { kind, days: [...days].sort((a, b) => a - b), time };
    const selectedModel = modelOptions.find((option) => option.key === model);
    return {
      name,
      cwd: cwdChoice === CUSTOM_WORKSPACE ? customCwd : cwdChoice,
      prompt,
      schedule,
      sessionMode,
      model: selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : null,
      thinkingLevel: thinkingLevel || null,
      enabled,
    };
  };

  /** Same rules as the server; localized messages for the fields a person can get wrong. */
  const localizeErrors = (fieldErrors: ScheduledTaskFieldErrors): ScheduledTaskFieldErrors => {
    const localized: ScheduledTaskFieldErrors = { ...fieldErrors };
    if (fieldErrors.name) localized.name = t("scheduledTasks.errors.name", { max: SCHEDULED_TASK_LIMITS.maxNameLength });
    if (fieldErrors.cwd) localized.cwd = t("scheduledTasks.errors.cwd");
    if (fieldErrors.prompt) localized.prompt = t("scheduledTasks.errors.prompt", { max: SCHEDULED_TASK_LIMITS.maxPromptLength });
    if (fieldErrors.schedule) {
      localized.schedule = kind === "interval"
        ? t("scheduledTasks.errors.interval", { min: SCHEDULED_TASK_LIMITS.minIntervalMinutes, max: SCHEDULED_TASK_LIMITS.maxIntervalMinutes })
        : kind === "weekly" && days.length === 0 ? t("scheduledTasks.errors.days") : t("scheduledTasks.errors.time");
    }
    return localized;
  };

  const submit = async () => {
    const input = buildInput();
    const parsed = parseScheduledTaskInput(input, false);
    if (!parsed.ok) {
      setErrors(localizeErrors(parsed.errors));
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(null);
    setSaving(true);
    try {
      const res = await fetch(task ? `/api/scheduled-tasks/${encodeURIComponent(task.id)}` : "/api/scheduled-tasks", {
        method: task ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await readJson<ErrorBody>(res);
      if (!aliveRef.current) return;
      if (res.ok) {
        toast.success(t(task ? "scheduledTasks.saved" : "scheduledTasks.created", { name: parsed.value.name }));
        onSaved();
        return;
      }
      if (body?.code === "invalid_scheduled_task" && body.fields && Object.keys(body.fields).length > 0) {
        setErrors(localizeErrors(body.fields));
      } else if (body?.code === "directory_not_found") {
        setErrors({ cwd: formatApiError(body) });
      } else {
        setFormError(formatApiError(body));
      }
    } catch (error) {
      if (aliveRef.current) setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  const toggleDay = (day: ScheduleWeekday, checked: boolean) => {
    setDays((prev) => (checked ? [...prev.filter((d) => d !== day), day] : prev.filter((d) => d !== day)));
  };

  const timeHint = timeZone ? t("scheduledTasks.form.timeHint", { timeZone }) : undefined;

  return (
    <form
      aria-label={task ? t("scheduledTasks.form.editTitle", { name: task.name }) : t("scheduledTasks.form.newTitle")}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, border: "1px solid var(--accent)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", boxShadow: "var(--shadow-card)" }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
        <CalendarClock size={14} aria-hidden="true" />
        {task ? t("scheduledTasks.form.editTitle", { name: task.name }) : t("scheduledTasks.form.newTitle")}
      </div>
      <Field label={t("scheduledTasks.form.name")} error={errors.name} required>
        <TextInput value={name} onChange={setName} placeholder={t("scheduledTasks.form.namePlaceholder")} error={errors.name} />
      </Field>
      <Field label={t("scheduledTasks.form.workspace")} error={cwdChoice === CUSTOM_WORKSPACE ? undefined : errors.cwd} hint={t("scheduledTasks.form.workspaceHint")} required>
        <select value={cwdChoice} onChange={(event) => setCwdChoice(event.target.value)} style={{ ...controlStyle, fontFamily: "var(--font-mono)" }}>
          {workspaceOptions.map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
          <option value={CUSTOM_WORKSPACE}>{t("scheduledTasks.form.workspaceOther")}</option>
        </select>
      </Field>
      {cwdChoice === CUSTOM_WORKSPACE ? (
        <Field label={t("scheduledTasks.form.workspacePath")} error={errors.cwd}>
          <TextInput value={customCwd} onChange={setCustomCwd} placeholder={t("scheduledTasks.form.workspacePathPlaceholder")} mono spellCheck={false} autoComplete="off" error={errors.cwd} />
        </Field>
      ) : null}
      <Field label={t("scheduledTasks.form.prompt")} error={errors.prompt} required>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("scheduledTasks.form.promptPlaceholder")} rows={5} aria-invalid={errors.prompt ? true : undefined} style={{ ...controlStyle, minHeight: 110, lineHeight: 1.45, resize: "vertical", fontFamily: "inherit", border: `1px solid ${errors.prompt ? "var(--status-error)" : "var(--border)"}` }} />
      </Field>
      <FormSection label={t("scheduledTasks.form.schedule")} error={errors.schedule}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Field label={t("scheduledTasks.form.repeat")} style={{ flex: "0 1 200px" }}>
            <select value={kind} onChange={(event) => setKind(event.target.value as TaskSchedule["kind"])} style={controlStyle}>
              <option value="interval">{t("scheduledTasks.form.kind.interval")}</option>
              <option value="daily">{t("scheduledTasks.form.kind.daily")}</option>
              <option value="weekly">{t("scheduledTasks.form.kind.weekly")}</option>
            </select>
          </Field>
          {kind === "interval" ? (
            <Field label={t("scheduledTasks.form.everyMinutes")} hint={t("scheduledTasks.form.everyMinutesHint", { min: SCHEDULED_TASK_LIMITS.minIntervalMinutes, max: SCHEDULED_TASK_LIMITS.maxIntervalMinutes })} style={{ flex: "1 1 200px" }}>
              <NumInput value={everyMinutes} onChange={setEveryMinutes} invalid={Boolean(errors.schedule)} />
            </Field>
          ) : (
            <Field label={t("scheduledTasks.form.time")} hint={timeHint} style={{ flex: "0 1 160px" }}>
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} style={controlStyle} />
            </Field>
          )}
        </div>
        {kind === "weekly" ? (
          <div role="group" aria-label={t("scheduledTasks.form.days")} style={{ display: "flex", gap: "6px 14px", flexWrap: "wrap" }}>
            {WEEKDAY_ORDER.map((day) => (
              <Check key={day} label={weekdayName(locale, day, "short")} checked={days.includes(day)} onChange={(checked) => toggleDay(day, checked)} />
            ))}
          </div>
        ) : null}
      </FormSection>
      <FormSection label={t("scheduledTasks.form.sessionMode")} error={errors.sessionMode}>
        {(["new", "continue"] as const).map((mode) => (
          <label key={mode} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
            <input type="radio" name="scheduled-task-session-mode" value={mode} checked={sessionMode === mode} onChange={() => setSessionMode(mode)} style={{ marginTop: 2, accentColor: "var(--accent)" }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 12, color: "var(--text)" }}>{t(`scheduledTasks.sessionMode.${mode}`)}</span>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t(`scheduledTasks.sessionMode.${mode}Desc`)}</span>
            </span>
          </label>
        ))}
      </FormSection>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label={t("scheduledTasks.form.model")} error={errors.model} style={{ flex: "2 1 240px" }}>
          <select value={model} onChange={(event) => setModel(event.target.value)} style={controlStyle}>
            <option value="">{t("scheduledTasks.form.useDefault")}</option>
            {modelOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </Field>
        <Field label={t("scheduledTasks.form.thinking")} error={errors.thinkingLevel} style={{ flex: "1 1 160px" }}>
          <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)} style={controlStyle}>
            <option value="">{t("scheduledTasks.form.useDefault")}</option>
            {DEFAULT_THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </Field>
      </div>
      <Check label={t("scheduledTasks.form.enabled")} checked={enabled} onChange={setEnabled} />
      {formError ? <Alert variant="error" description={formError} onDismiss={() => setFormError(null)} /> : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className="agent-config-action" disabled={saving} style={{ ...primaryButtonStyle, padding: "7px 14px", cursor: saving ? "wait" : "pointer", opacity: saving ? 0.65 : 1 }}>
          {task ? t("scheduledTasks.form.save") : t("scheduledTasks.form.create")}
        </button>
        <button type="button" className="agent-config-action" onClick={onCancel} disabled={saving} style={{ ...buttonStyle, padding: "7px 12px" }}>
          {t("scheduledTasks.cancel")}
        </button>
      </div>
    </form>
  );
}
