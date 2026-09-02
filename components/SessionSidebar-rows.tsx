"use client";

import { memo, useCallback, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { ManagedProject, ProjectLaunchConfig, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { comparableProjectPath } from "@/lib/comparable-path";
import { Check, ChevronDown, ChevronRight, Folder, GitBranch, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import {
  MAX_PROJECT_SESSIONS,
  displayCwd,
  formatRelativeTime,
  projectLabel,
  type SessionTreeNode,
  type WorktreeState,
} from "./SessionSidebar-helpers";
import {
  PathLabel,
  RunningSessionIndicator,
  SIDEBAR_BUTTON_TRANSITION,
  SidebarPortalMenu,
  UnreadSessionIndicator,
} from "./SessionSidebar-chrome";
interface ProjectRowProps {
  project: ManagedProject;
  isActive: boolean;
  isExpanded: boolean;
  activity: { running: number; unread: number } | undefined;
  tree: SessionTreeNode[];
  /** Sessions beyond the cap (0 when a filter is active — show all matches). */
  hiddenCount: number;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  relativeTimeNow: number;
  onActivate: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onRemoveProject: (path: string) => void;
  onEditLaunchConfig: (project: ManagedProject) => void;
  onUpdatePresentation: (path: string, updates: { alias?: string | null; sortOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }) => void;
  onDragPathChange: (path: string | null) => void;
  onDropProject: (path: string) => void;
  onMoveProject: (path: string, delta: -1 | 1) => void;
  isDragTarget: boolean;
  removeBusy: boolean;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  activeWorktreeSwitcher?: ReactNode;
  /** Active worktree/branch label shown inline beside the workspace name. */
  worktreeBranch?: string | null;
  worktreeToggleRef?: RefObject<HTMLButtonElement | null>;
  worktreeOpen?: boolean;
  onToggleWorktrees?: () => void;
  homeDir: string;
}

/** One project in the sidebar: a card row matching the session items' visual
 *  language, with the active project's worktree selector directly below and
 *  the project's session tree (capped at MAX_PROJECT_SESSIONS roots, with a
 *  show-more toggle) nested under it when expanded. */
function ProjectRow({
  project,
  isActive,
  isExpanded,
  activity,
  tree,
  hiddenCount,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  relativeTimeNow,
  onActivate,
  onToggleExpand,
  onRemoveProject,
  onEditLaunchConfig,
  onUpdatePresentation,
  onDragPathChange,
  onDropProject,
  onMoveProject,
  isDragTarget,
  removeBusy,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  activeWorktreeSwitcher,
  worktreeBranch,
  worktreeToggleRef,
  worktreeOpen,
  onToggleWorktrees,
}: ProjectRowProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const [aliasEditing, setAliasEditing] = useState(false);
  const [aliasValue, setAliasValue] = useState("");
  const aliasInputRef = useRef<HTMLInputElement>(null);
  const aliasCancelRef = useRef(false);

  const startAliasEdit = useCallback(() => {
    setAliasValue(project.alias ?? "");
    setAliasEditing(true);
    setTimeout(() => aliasInputRef.current?.select(), 0);
  }, [project.alias]);

  const commitAliasEdit = useCallback(() => {
    if (aliasCancelRef.current) {
      aliasCancelRef.current = false;
      setAliasEditing(false);
      return;
    }
    const alias = aliasValue.trim();
    setAliasEditing(false);
    if (alias === (project.alias ?? "")) return;
    void onUpdatePresentation(project.path, { alias });
  }, [aliasValue, project.alias, project.path, onUpdatePresentation]);
  const label = project.alias ?? projectLabel(project.path);
  const hasActivity = Boolean(activity && (activity.running > 0 || activity.unread > 0));
  const visibleRoots = hiddenCount > 0 && !showAllSessions
    ? tree.slice(0, MAX_PROJECT_SESSIONS)
    : tree;
  const showActions = hovered || focusWithin || actionMenuOpen;

  return (
    <section className="sidebar-project" data-active={isActive ? "true" : "false"} style={{ marginBottom: 12 }}>
      <div
        className="sidebar-project-header"
        draggable={!aliasEditing}
        onDragStart={(event) => { event.dataTransfer.setData("text/plain", project.path); event.dataTransfer.effectAllowed = "move"; onDragPathChange(project.path); }}
        onDragOver={(event) => { if (isDragTarget) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={(event) => { event.preventDefault(); onDropProject(project.path); }}
        onDragEnd={() => onDragPathChange(null)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && actionMenuOpen) {
            event.stopPropagation();
            setActionMenuOpen(false);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 30,
          margin: 0,
          padding: "0 6px 0 0",
          borderRadius: "var(--radius-control)",
          background: hovered ? "var(--bg-hover)" : "transparent",
          transition: SIDEBAR_BUTTON_TRANSITION,
          ...(isDragTarget ? { outline: "1px solid var(--accent)", outlineOffset: -1 } : {}),
        }}
      >
        {aliasEditing ? (
          <div
            className="sidebar-project-identity"
            onClick={(event) => event.stopPropagation()}
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              alignSelf: "stretch",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 4px 0 10px",
            }}
          >
            <Folder
              size={15}
              strokeWidth={1.8}
              style={{ flexShrink: 0, color: "var(--text-muted)" }}
              aria-hidden="true"
            />
            <input
              ref={aliasInputRef}
              autoFocus
              aria-label={t("projects.aliasPrompt")}
              value={aliasValue}
              onChange={(event) => setAliasValue(event.target.value)}
              onBlur={commitAliasEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitAliasEdit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  aliasCancelRef.current = true;
                  setAliasEditing(false);
                }
              }}
              style={{ flex: 1, minWidth: 0, height: 22, padding: "2px 6px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 600 }}
            />
          </div>
        ) : (
          <Tooltip
            content={(
              <span style={{ display: "grid", gap: 3, maxWidth: 360, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <strong style={{ fontFamily: "inherit", fontSize: 11 }}>目录</strong>
                <span>{project.path}</span>
                {project.launchConfig?.profile && <span>profile: {project.launchConfig.profile}</span>}
                {project.launchConfig?.advisor && <span>--advisor</span>}
                {project.launchConfig?.extraArgs?.map((arg, index) => <span key={`${arg}-${index}`}>{arg}</span>)}
              </span>
            )}
            side="right"
          >
          <button
            className="sidebar-project-identity"
            onClick={() => onActivate(project.path)}
            aria-current={isActive ? "true" : undefined}
            title={project.path}
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              alignSelf: "stretch",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 4px 0 10px",
              background: "none", border: "none",
              color: hovered ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <Folder
              size={15}
              strokeWidth={1.8}
              style={{ flexShrink: 0, color: isActive ? "var(--accent)" : hovered ? "var(--text-muted)" : "var(--text-dim)", transition: "color var(--dur-fast) var(--ease-out-warm)" }}
              aria-hidden="true"
            />
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                lineHeight: 1.25,
              }}
            >
              {label}
            </span>
          </button>
          </Tooltip>
        )}
        {worktreeBranch && worktreeToggleRef && (
          <button
            type="button"
            ref={worktreeToggleRef}
            onClick={onToggleWorktrees}
            aria-expanded={worktreeOpen}
            aria-haspopup="menu"
            title={t("sessionSidebar.switchWorktreeTo", { path: worktreeBranch })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
              minWidth: 0,
              maxWidth: 104,
              height: 24,
              padding: "0 6px",
              border: "none",
              borderRadius: "var(--radius-control)",
              background: worktreeOpen ? "var(--bg-selected)" : "none",
              color: worktreeOpen ? "var(--accent)" : hovered ? "var(--text-muted)" : "var(--text-dim)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              lineHeight: 1,
              transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
            }}
          >
            <span aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>·</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worktreeBranch}</span>
          </button>
        )}
        <div style={{ flex: 1 }} />
        {hasActivity && (
          <span
            aria-label={t("projects.activity", { running: activity?.running ?? 0, unread: activity?.unread ?? 0 })}
            title={t("projects.activity", { running: activity?.running ?? 0, unread: activity?.unread ?? 0 })}
            className="sidebar-project-activity"
            data-running={(activity?.running ?? 0) > 0 ? "true" : "false"}
            role="status"
            aria-live="polite"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 11, height: 11, margin: "0 2px 0 0", flexShrink: 0, lineHeight: 0 }}
          >
            <span
              aria-hidden="true"
              className="sidebar-project-activity-dot"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--accent)",
              }}
            />
          </span>
        )}
        <div
          style={{
            flexShrink: 0,
            visibility: showActions ? "visible" : "hidden",
          }}
        >
          <button
            type="button"
            ref={actionButtonRef}
            className="sidebar-project-action"
            onClick={() => setActionMenuOpen((open) => !open)}
            disabled={removeBusy}
            aria-label={t("commandPalette.actions")}
            title={t("commandPalette.actions")}
            aria-expanded={actionMenuOpen}
            aria-haspopup="menu"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, border: "none", borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: "var(--text-dim)", cursor: removeBusy ? "default" : "pointer", opacity: removeBusy ? 0.5 : 1, lineHeight: 0, transition: SIDEBAR_BUTTON_TRANSITION }}
          >
            <MoreHorizontal size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <SidebarPortalMenu
            anchor={actionButtonRef}
            open={actionMenuOpen}
            onClose={() => setActionMenuOpen(false)}
            placement="below"
            minWidth={136}
          >
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { startAliasEdit(); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {project.alias ? t("projects.editAlias") : t("projects.nameAlias")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { onEditLaunchConfig(project); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {project.launchConfig ? "编辑 OMP 启动参数" : "配置 OMP 启动参数"}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { setActionMenuOpen(false); void onMoveProject(project.path, -1); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.moveUp")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { setActionMenuOpen(false); void onMoveProject(project.path, 1); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.moveDown")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" disabled={removeBusy} onClick={() => { setActionMenuOpen(false); void onRemoveProject(project.path); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: removeBusy ? "default" : "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.remove", { name: label })}
            </button>
          </SidebarPortalMenu>
        </div>
        <button
          className="sidebar-project-toggle"
          onClick={() => onToggleExpand(project.path)}
          aria-label={isExpanded ? t("projects.collapseProject", { name: label }) : t("projects.expandProject", { name: label })}
          aria-expanded={isExpanded}
          title={isExpanded ? t("projects.collapseProjectTitle", { path: project.path }) : t("projects.expandProjectTitle", { path: project.path })}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 26, padding: 0, flexShrink: 0,
            background: "none", border: "none",
            color: "var(--text-dim)", cursor: "pointer", lineHeight: 0,
            borderRadius: "var(--radius-control)",
            transition: "color var(--dur-fast) var(--ease-out-warm)",
          }}
        >
          <ChevronRight
            size={13}
            strokeWidth={1.8}
            style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
            aria-hidden="true"
          />
        </button>
      </div>

      {isActive && activeWorktreeSwitcher}

      {isExpanded && (
        <div className="sidebar-project-sessions" style={{ margin: "2px 0 0" }}>
          {visibleRoots.length === 0 ? (
            <div style={{ padding: "6px 12px 8px 34px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("projects.emptyProject")}
            </div>
          ) : (
            <>
              {visibleRoots.map((node) => (
                <SessionTreeItem
                  key={node.session.id}
                  node={node}
                  selectedSessionId={selectedSessionId}
                  runningSessionIds={runningSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  relativeTimeNow={relativeTimeNow}
                  onSelectSession={onSelectSession}
                  onRenamed={onRenamed}
                  onSessionDeleted={onSessionDeleted}
                  depth={0}
                />
              ))}
              {hiddenCount > 0 && (
                <button
                  onClick={() => setShowAllSessions((v) => !v)}
                  aria-expanded={showAllSessions}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    width: "100%",
                    margin: "2px 0 0",
                    padding: "5px 8px 5px 34px",
                    background: "none",
                    border: "none",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: "var(--radius-control)",
                    transition: SIDEBAR_BUTTON_TRANSITION,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  <ChevronDown size={11} strokeWidth={1.8} style={{ flexShrink: 0, transform: showAllSessions ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} aria-hidden="true" />
                  {showAllSessions
                    ? t("projects.showLess")
                    : t("projects.showMoreSessions", { count: hiddenCount })}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
interface ProjectWorktreeSwitcherProps {
  worktreeState: WorktreeState;
  selectedCwd: string | null;
  homeDir: string;
  wtDropdownOpen: boolean;
  wtNewOpen: boolean;
  setWtNewOpen: Dispatch<SetStateAction<boolean>>;
  wtNewBranch: string;
  setWtNewBranch: Dispatch<SetStateAction<string>>;
  wtError: string | null;
  setWtError: Dispatch<SetStateAction<string | null>>;
  wtBusy: boolean;
  wtConfirmRemove: string | null;
  setWtConfirmRemove: Dispatch<SetStateAction<string | null>>;
  onSelectWorktree: (path: string) => void;
  onCreateWorktree: () => void;
  onRemoveWorktree: (path: string, force: boolean) => void;
  /** Anchor button — the inline branch label in the workspace row. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  newInputRef: RefObject<HTMLInputElement | null>;
  /** Closes the dropdown and resets its transient state. */
  onClose: () => void;
}

/** Worktree dropdown for the active project; opening it exposes all checkouts.
 *  Rendered through the portal menu so it floats above every sidebar row. */
function ProjectWorktreeSwitcher({
  worktreeState,
  selectedCwd,
  homeDir,
  wtDropdownOpen,
  wtNewOpen,
  setWtNewOpen,
  wtNewBranch,
  setWtNewBranch,
  wtError,
  setWtError,
  wtBusy,
  wtConfirmRemove,
  setWtConfirmRemove,
  onSelectWorktree,
  onCreateWorktree,
  onRemoveWorktree,
  anchorRef,
  newInputRef,
  onClose,
}: ProjectWorktreeSwitcherProps) {
  const { t } = useI18n();

  return (
    <SidebarPortalMenu
      anchor={anchorRef}
      open={wtDropdownOpen}
      onClose={onClose}
      placement="below"
      align="start"
      minWidth={240}
      style={{ overflow: "hidden" }}
    >
          <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
            {worktreeState.worktrees.map((wt) => {
              const foldedCwd = selectedCwd === null ? null : comparableProjectPath(selectedCwd);
              const isCurrent = (foldedCwd !== null && comparableProjectPath(wt.path) === foldedCwd)
                || (wt.isMain && !worktreeState.worktrees.some((w) => comparableProjectPath(w.path) === foldedCwd));
              if (wtConfirmRemove === wt.path) {
                return (
                  <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--accent) 6%, transparent)" }}>
                    <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t("sessionSidebar.uncommittedForceRemove")}
                    </span>
                    <button
                      onClick={() => onRemoveWorktree(wt.path, true)}
                      disabled={wtBusy}
                      style={{ padding: "3px 9px", background: "var(--accent-strong)", border: "none", borderRadius: "var(--radius-control)", color: "var(--on-accent)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                    >
                      {t("sessionSidebar.force")}
                    </button>
                    <button
                      onClick={() => setWtConfirmRemove(null)}
                      style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                    >
                      {t("sessionSidebar.cancel")}
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={wt.path}
                  className="wt-row"
                  style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                >
                  <button
                    onClick={() => onSelectWorktree(wt.path)}
                    aria-pressed={isCurrent}
                    title={wt.path}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "none",
                      color: isCurrent ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {isCurrent ? (
                      <Check size={10} strokeWidth={2} style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
                    ) : (
                      <span style={{ width: 10, flexShrink: 0 }} />
                    )}
                    <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                    {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sessionSidebar.mainBadge")}</span>}
                  </button>
                  {!wt.isMain && (
                    <button
                      onClick={() => onRemoveWorktree(wt.path, false)}
                      disabled={wtBusy}
                      title={t("sessionSidebar.removeWorktreeTitle", { path: wt.path })}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 34, height: 28, padding: 0, marginRight: 4,
                        background: "none", border: "none",
                        color: "var(--text-dim)", cursor: "pointer",
                        borderRadius: "var(--radius-control)", flexShrink: 0,
                        transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 8%, transparent)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                    >
                      <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {!wtNewOpen ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setWtNewOpen(true);
                setWtError(null);
                setTimeout(() => newInputRef.current?.focus(), 0);
              }}
              title={t("sessionSidebar.newWorktreeTitle")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                width: "100%",
                padding: "8px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 11,
              }}
            >
              <Plus size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
              <span>{t("sessionSidebar.newWorktree")}</span>
            </button>
          ) : (
            <div style={{ padding: "6px 8px" }}>
              <input
                ref={newInputRef}
                value={wtNewBranch}
                onChange={(e) => {
                  setWtNewBranch(e.target.value);
                  setWtError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCreateWorktree();
                  }
                  if (e.key === "Escape") {
                    setWtNewOpen(false);
                    setWtNewBranch("");
                    setWtError(null);
                  }
                }}
                placeholder={t("sessionSidebar.branchNamePlaceholder")}
                style={{
                  width: "100%",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "5px 8px",
                  border: "1px solid var(--accent)",
                  borderRadius: "var(--radius-control)",
                  outline: "none",
                  background: "var(--bg)",
                  color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                <button
                  onClick={onCreateWorktree}
                  disabled={wtBusy || !wtNewBranch.trim()}
                  style={{
                    flex: 1,
                    padding: "4px 0",
                    background: "var(--accent-strong)",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--on-accent)",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                    opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                  }}
                >
                  {wtBusy ? t("sessionSidebar.creating") : t("sessionSidebar.create")}
                </button>
                <button
                  onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                  style={{
                    flex: 1,
                    padding: "4px 0",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {t("sessionSidebar.cancel")}
                </button>
              </div>
            </div>
          )}
          {wtError && (
            <div style={{
              padding: "5px 10px 8px",
              color: "var(--accent)",
              fontSize: 11,
              lineHeight: 1.35,
              overflowWrap: "anywhere",
            }}>
              {wtError}
            </div>
          )}
    </SidebarPortalMenu>
  );
}
const SessionTreeItem = memo(function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  relativeTimeNow,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  relativeTimeNow: number;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;
  const sessionId = node.session.id;

  // Pre-compute the booleans so SessionItem only sees primitives — its memo
  // check then never re-renders unless this row's flags actually changed.
  const isSelected = sessionId === selectedSessionId;
  const isRunning = runningSessionIds.has(sessionId);
  const isUnread = unreadSessionIds.has(sessionId);

  // Stable callbacks: depend only on primitives / stable parent callbacks so
  // SessionItem's React.memo stays effective across re-renders.
  const handleClick = useCallback(() => {
    onSelectSession(node.session);
  }, [onSelectSession, node.session]);
  const handleDeleted = useCallback((id: string) => {
    onSessionDeleted?.(id);
  }, [onSessionDeleted]);
  const handleToggleCollapse = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 14 + 22,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={isSelected}
          isRunning={isRunning}
          isUnread={isUnread}
          relativeTimeNow={relativeTimeNow}
          onClick={handleClick}
          onRenamed={onRenamed}
          onDeleted={handleDeleted}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              relativeTimeNow={relativeTimeNow}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Deep-changed inputs warrant a re-render; otherwise skip.
  if (prev.node !== next.node) return false;
  if (prev.selectedSessionId !== next.selectedSessionId) {
    // Only re-render if THIS node's selection state flipped.
    const id = prev.node.session.id;
    if ((id === prev.selectedSessionId) !== (id === next.selectedSessionId)) return false;
  }
  if (prev.runningSessionIds !== next.runningSessionIds) {
    const id = prev.node.session.id;
    if (prev.runningSessionIds.has(id) !== next.runningSessionIds.has(id)) return false;
  }
  if (prev.unreadSessionIds !== next.unreadSessionIds) {
    const id = prev.node.session.id;
    if (prev.unreadSessionIds.has(id) !== next.unreadSessionIds.has(id)) return false;
  }
  if (prev.relativeTimeNow !== next.relativeTimeNow) return false;
  if (prev.onSelectSession !== next.onSelectSession
    || prev.onRenamed !== next.onRenamed
    || prev.onSessionDeleted !== next.onSessionDeleted) return false;
  return true;
});
const SessionItem = memo(function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  relativeTimeNow,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  relativeTimeNow: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t, locale } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameCancelRef = useRef(false);
 const [confirmArchive, setConfirmArchive] = useState(false);
 const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
  const relativeTime = formatRelativeTime(session.modified, locale, relativeTimeNow);
 const confirming = confirmArchive || confirmDelete;
 const showActions = hovered || focusWithin || actionMenuOpen;
  const rowBackground = confirming
    ? "color-mix(in srgb, var(--accent) 6%, transparent)"
    : isSelected
      ? "color-mix(in srgb, var(--bg-selected) 70%, transparent)"
      : hovered ? "var(--bg-hover)" : "transparent";

  const startRename = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      return;
    }
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("Session rename failed");
      onRenamed?.();
    } catch {
      // The next refresh remains authoritative if the rename fails.
    }
  }, [renameValue, session.id, session.name, onRenamed]);

 const handleArchive = useCallback(async () => {
 setConfirmArchive(false);
 setDeleting(true);
 try {
 const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
 if (!response.ok) throw new Error("Session archive failed");
 onDeleted?.(session.id);
 } catch {
 setDeleting(false);
 toast.error(t("sessionSidebar.archiveFailed"));
 }
 }, [session.id, onDeleted, t]);

  const handleDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Session deletion failed");
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
      toast.error(t("sessionSidebar.deleteFailed"));
    }
  }, [session.id, onDeleted, t]);

 const closeConfirmation = useCallback(() => {
 setConfirmArchive(false);
 setConfirmDelete(false);
 setActionMenuOpen(false);
 requestAnimationFrame(() => contentButtonRef.current?.focus());
 }, []);

  return (
    <div
 onClick={confirmArchive || confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      onKeyDown={(event) => {
        if ((confirmArchive || confirmDelete || actionMenuOpen) && event.key === "Escape") {
          event.stopPropagation();
          closeConfirmation();
        }
      }}
      style={{
        height: confirming ? 34 : 30,
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        margin: "1px 0",
        padding: `0 8px 0 ${30 + depth * 14}px`,
        position: "relative",
        overflow: "hidden",
        background: rowBackground,
        opacity: deleting ? 0.5 : 1,
        cursor: confirming || renaming ? "default" : "pointer",
        transition: "background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      {(isSelected || confirming) && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 20 + depth * 14,
            top: 0,
            bottom: 0,
            width: 2,
            borderRadius: 1,
            background: "var(--accent)",
            pointerEvents: "none",
          }}
        />
      )}
      {confirming ? (
        <>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
            {confirmArchive
              ? t("sessionSidebar.archiveConfirm", { title: title.length > 22 ? `${title.slice(0, 22)}…` : title })
              : t("sessionSidebar.deleteConfirm", { title: title.length > 22 ? `${title.slice(0, 22)}…` : title })}
          </span>
          <button onClick={(event) => { event.stopPropagation(); if (confirmArchive) void handleArchive(); else void handleDelete(); }} style={{ height: 28, padding: "0 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
            {confirmArchive ? t("sessionSidebar.archive") : t("sessionSidebar.delete")}
          </button>
          <button onClick={(event) => { event.stopPropagation(); closeConfirmation(); }} autoFocus style={{ height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
            {t("sessionSidebar.cancel")}
          </button>
        </>
      ) : renaming ? (
        <input ref={inputRef} autoFocus aria-label={t("sessionSidebar.rename")} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") { event.preventDefault(); renameCancelRef.current = true; setRenaming(false); } }} style={{ flex: 1, height: 25, padding: "3px 7px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }} />
      ) : (
        <>
          {depth > 0 && <GitBranch size={11} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />}
          <button ref={contentButtonRef} type="button" className="session-item-button" aria-current={isSelected ? "true" : undefined} onKeyDown={(event) => { if (event.key === "Delete") { event.preventDefault(); setConfirmDelete(true); } }} style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
            <span title={title} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12.5, fontWeight: isSelected ? 600 : 500, lineHeight: 1.35, letterSpacing: "-0.005em" }}>
              {title}
            </span>
          </button>
          {session.worktreeBranch && <span title={t("sessionSidebar.worktreeTitle", { path: session.cwd })} style={{ display: "flex", alignItems: "center", gap: 3, maxWidth: 56, minWidth: 0, overflow: "hidden", color: "var(--text-dim)", fontSize: 10, flexShrink: 1 }}><GitBranch size={10} strokeWidth={2.4} aria-hidden="true" /><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span></span>}
          {hasChildren && <button className="session-item-icon-button" onClick={(event) => { event.stopPropagation(); onToggleCollapse?.(); }} title={collapsed ? t("sessionSidebar.expandForks") : t("sessionSidebar.collapseForks")} aria-label={collapsed ? t("sessionSidebar.expandForks") : t("sessionSidebar.collapseForks")} aria-expanded={!collapsed} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, flexShrink: 0, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}><ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" /></button>}
          <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "flex-end", width: 64, height: 24, flexShrink: 0 }}>
              <div aria-hidden={showActions && !isRunning} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, width: "100%", whiteSpace: "nowrap", opacity: showActions && !isRunning ? 0 : 1, pointerEvents: showActions && !isRunning ? "none" : "auto", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>
                {isRunning && <RunningSessionIndicator size={12} />}
                {!isRunning && isUnread && <UnreadSessionIndicator size={11} />}
                {relativeTime && <span title={new Date(session.modified).toLocaleString(locale)} style={{ minWidth: 42, whiteSpace: "nowrap", textAlign: "right", color: isSelected ? "var(--accent)" : "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{relativeTime}</span>}
              </div>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, opacity: showActions ? 1 : 0, pointerEvents: showActions ? "auto" : "none", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>
                {isRunning && <span style={{ display: "flex", alignItems: "center", marginRight: 2 }}><RunningSessionIndicator size={12} /></span>}
                <button type="button" ref={menuButtonRef} className="session-item-icon-button" onClick={(event) => { event.stopPropagation(); setActionMenuOpen((open) => !open); }} title={t("projects.actions")} aria-label={t("projects.actions")} aria-expanded={actionMenuOpen} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, lineHeight: 0, border: "none", borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: actionMenuOpen ? "var(--text)" : "var(--text-dim)", cursor: "pointer" }}>
                  <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <SidebarPortalMenu anchor={menuButtonRef} open={actionMenuOpen} onClose={() => setActionMenuOpen(false)} placement="below" minWidth={128}>
 <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); void handleArchive(); }} disabled={hasChildren} title={hasChildren ? t("sessionSidebar.archiveLeafOnly") : t("sessionSidebar.archive")} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: hasChildren ? "var(--text-dim)" : "var(--text-muted)", cursor: hasChildren ? "not-allowed" : "pointer", textAlign: "left", fontSize: 11, opacity: hasChildren ? 0.55 : 1 }}>{t("sessionSidebar.archive")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { startRename(event); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.rename")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); void handleDelete(); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.delete")}</button>
                </SidebarPortalMenu>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
export {
  ProjectRow,
  ProjectWorktreeSwitcher,
  SessionItem,
  SessionTreeItem,
  type ProjectRowProps,
  type ProjectWorktreeSwitcherProps,
};
