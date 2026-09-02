"use client";

import { useState } from "react";
import { Ban, CheckCircle2, ChevronDown, Circle, CircleAlert, CircleDotDashed, ListChecks } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TodoItem, TodoPhase } from "@/lib/pi-types";

function TodoStatusIcon({ status }: { status: TodoItem["status"] }) {
  const props = { size: 14, strokeWidth: 1.8, "aria-hidden": true as const };
  if (status === "completed") return <CheckCircle2 {...props} color="var(--accent)" />;
  if (status === "in_progress") return <CircleDotDashed {...props} color="var(--accent)" />;
  if (status === "blocked") return <CircleAlert {...props} color="var(--text-muted)" />;
  if (status === "abandoned") return <Ban {...props} color="var(--text-dim)" />;
  return <Circle {...props} color="var(--text-dim)" />;
}

interface TodoListProps {
  phases?: TodoPhase[];
  /** Render as a composer-attached panel: the header row becomes a
   * collapse/expand toggle and the section margin is dropped. */
  collapsible?: boolean;
  /** Initial expansion when `collapsible` (default: collapsed). */
  defaultExpanded?: boolean;
  /** Controlled collapse state (ComposerPanels persists it in localStorage).
   * When omitted the component keeps its own uncontrolled state. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

/** Collapsed-preview window order: in_progress tasks first, then completed,
 * so a long first phase can't hide the live work behind "Show all". */
function previewTaskOrder(status: TodoItem["status"]): number {
  if (status === "in_progress") return 0;
  if (status === "completed") return 1;
  return 2;
}

export function TodoList({ phases = [], collapsible = false, defaultExpanded = false, collapsed: collapsedProp, onCollapsedChange }: TodoListProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [collapsedState, setCollapsedState] = useState(collapsible ? !defaultExpanded : false);
  const collapsed = collapsedProp ?? collapsedState;
  const setCollapsed = (value: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof value === "function" ? value(collapsed) : value;
    onCollapsedChange?.(next);
    setCollapsedState(next);
  };

  if (phases.length === 0) return null;

  const tasks = phases.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  let remainingPreviewTasks = 5;
  const displayedPhases = (expanded ? phases : phases.slice(0, 4)).map((phase) => {
    if (expanded) return phase;
    // Surface the live work: in_progress first, then completed, within the
    // same 5-task preview budget.
    const orderedTasks = [...phase.tasks].sort((a, b) => previewTaskOrder(a.status) - previewTaskOrder(b.status));
    const displayedTasks = orderedTasks.slice(0, Math.max(0, remainingPreviewTasks));
    remainingPreviewTasks -= displayedTasks.length;
    return { ...phase, tasks: displayedTasks };
  }).filter((phase) => phase.tasks.length > 0);
  const isTruncated = displayedPhases.reduce((count, phase) => count + phase.tasks.length, 0) < tasks.length;

  const headerRowClass = "flex items-center gap-2 px-3 py-2 text-xs text-text-muted";
  const headerBorderClass = collapsed ? "" : "border-b border-border";
  const progress = t("chatWindow.todoProgress", { done, total: tasks.length });

  return (
    <section
      aria-label={t("chatWindow.todoList")}
      className={`overflow-hidden border border-border bg-bg-subtle ${collapsible ? "" : "my-2"}`}
      style={{ borderRadius: "var(--radius-card)" }}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
          className={`${headerRowClass} ${headerBorderClass} w-full cursor-pointer text-left`}
          style={{ background: "none" }}
        >
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          <span className="ml-auto">{progress}</span>
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
      ) : (
        <div className={`${headerRowClass} ${headerBorderClass}`}>
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          <span className="ml-auto">{progress}</span>
        </div>
      )}
      {!collapsed && (
        <>
      {/* Capped and scrolled like the sibling subagents panel in
          ComposerPanels. Both panels are pinned above the composer, outside the
          chat scroller, so an uncapped list runs its own rows off-screen with
          nothing able to reach them — a 56-task plan was unreadable past the
          first screenful. The Show all/less footer sits outside this element so
          it stays put instead of scrolling away with the list.
          Unlike the subagents panel, whose cards are buttons and therefore
          reachable by Tab, todo rows are static text: without an explicit
          tabIndex a keyboard-only reader could not scroll this at all. Its name
          differs from the section's so a screen reader does not announce
          "Tasks" twice on the way in. */}
      <div
        className="grid gap-3 px-3 py-2.5 animate-slide-down"
        style={{ maxHeight: "min(30vh, 240px)", overflowY: "auto" }}
        role="group"
        aria-label={t("chatWindow.todoPlanScroll")}
        tabIndex={0}
      >
        {displayedPhases.map((phase, phaseIndex) => (
          <div key={phase.id ?? `${phase.name}-${phaseIndex}`} className="grid gap-1.5">
            <div className="text-[11px] font-medium text-text-muted">{phase.name}</div>
            <div className="grid gap-1.5">
              {phase.tasks.map((task, taskIndex) => (
                <div
                  key={task.id ?? `${task.content}-${taskIndex}`}
                  className="flex min-w-0 items-start gap-2 text-[13px] text-text"
                  aria-label={`${t(`chatWindow.todoStatus.${task.status}`)}: ${task.content}`}
                >
                  <span className="mt-0.5 shrink-0"><TodoStatusIcon status={task.status} /></span>
                  <span className="min-w-0">
                    <span className={task.status === "completed" || task.status === "abandoned" ? "text-text-dim line-through" : undefined}>
                      {task.content}
                    </span>
                    {task.blocker && (
                      <span className="mt-0.5 block text-[11px] text-text-muted">
                        {t("chatWindow.todoBlocker", { blocker: task.blocker })}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {(isTruncated || expanded) && (
        <button
          type="button"
          className="border-t border-border px-3 py-2 text-left text-xs text-accent hover:text-accent-hover"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("chatWindow.todoShowLess") : t("chatWindow.todoShowAll")}
        </button>
      )}
        </>
      )}
    </section>
  );
}
