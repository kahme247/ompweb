"use client";

import { memo, useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, useDeferredValue } from "react";
import type { ManagedProject, ProjectLaunchConfig, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProjectLaunchConfigDialog } from "./ProjectLaunchConfigDialog";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import { clearLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { groupSessionsByProject, projectActivityCounts, sortManagedProjects } from "@/lib/project-ordering";
import { comparableProjectPath } from "@/lib/comparable-path";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Archive, Check, ChevronRight, FileUp, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Upload } from "lucide-react";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import {
  EMPTY_PROJECT_SET,
  INITIAL_RESTORE_MAX_ATTEMPTS,
  INITIAL_RESTORE_RETRY_MS,
  MAX_PROJECT_SESSIONS,
  buildSessionTree,
  displayCwd,
  loadExpandedProjects,
  loadUnreadSessionIds,
  normalizeProjectKey,
  projectLabel,
  saveExpandedProjects,
  saveUnreadSessionIds,
  type WorktreeEntry,
  type WorktreeState,
} from "./SessionSidebar-helpers";
import { OmpWebTitle, SIDEBAR_BUTTON_TRANSITION, SidebarIconButton } from "./SessionSidebar-chrome";
import { ProjectRow, ProjectWorktreeSwitcher } from "./SessionSidebar-rows";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  /** The active session can exist in memory before its JSONL file is flushed. */
  optimisticSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  explorerRefreshing?: boolean;
  onExplorerRefreshDone?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Opens the app settings (pinned sidebar footer row). */
  onOpenSettings?: () => void;
  /** True when an omp/ompweb update is available — shows a badge on the gear. */
  updateAvailable?: boolean;
  /** Opens the archived sessions browser. */
  onOpenArchive?: () => void;
}












const WORKSPACE_PANEL_HEIGHT_STORAGE_KEY = "omp-web:workspace-panel-height";
const WORKSPACE_PANEL_DEFAULT_HEIGHT = 300;
const WORKSPACE_PANEL_MIN_HEIGHT = 80;
const EXPLORER_PANEL_MIN_HEIGHT = 120;

/** 读取用户上次调整的工作区列表高度；存储不可用时保持默认尺寸。 */
function loadWorkspacePanelHeight(): number {
  if (typeof window === "undefined") return WORKSPACE_PANEL_DEFAULT_HEIGHT;
  try {
    const height = Number(window.localStorage.getItem(WORKSPACE_PANEL_HEIGHT_STORAGE_KEY));
    return Number.isFinite(height) && height >= WORKSPACE_PANEL_MIN_HEIGHT
      ? Math.round(height)
      : WORKSPACE_PANEL_DEFAULT_HEIGHT;
  } catch {
    return WORKSPACE_PANEL_DEFAULT_HEIGHT;
  }
}

export const SessionSidebar = memo(function SessionSidebar({ selectedSessionId, optimisticSession, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onExplorerRefresh, explorerRefreshing, onExplorerRefreshDone, onAtMention, onAtMentions, onOpenSettings, onOpenArchive, updateAvailable }: Props) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  // Managed + session-discovered projects (server-merged, hidden excluded).
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [draggedProjectPath, setDraggedProjectPath] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // Add-project picker state.
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectBusy, setAddProjectBusy] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  // Per-project expansion, persisted to localStorage (null = nothing stored).
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(() => loadExpandedProjects());
  // Project currently being removed (hide) — serializes remove requests.
  const [removeProjectPath, setRemoveProjectPath] = useState<string | null>(null);
  const [launchConfigProject, setLaunchConfigProject] = useState<ManagedProject | null>(null);
  // Worktree/branch/Git state is scoped per repository. It is cached in a
  // map keyed by the normalized repository root so switching workspaces never
  // leaks one project's branch/worktree data into another's UI (each project
  // keeps its own loaded Git state; a late async response for a previous repo
  // only updates that repo's entry, never the active one).
  const [worktreeStateByProject, setWorktreeStateByProject] = useState<Record<string, WorktreeState>>({});
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const wtToggleRef = useRef<HTMLButtonElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [workspacePanelHeight, setWorkspacePanelHeight] = useState(WORKSPACE_PANEL_DEFAULT_HEIGHT);
  const [workspacePanelResizing, setWorkspacePanelResizing] = useState(false);
  const workspacePanelRef = useRef<HTMLDivElement>(null);
  const explorerPanelRef = useRef<HTMLDivElement>(null);
  const workspaceResizeHandlersRef = useRef<{ onMove: (event: MouseEvent) => void; onUp: () => void } | null>(null);
  const pendingWorkspacePanelHeightRef = useRef(WORKSPACE_PANEL_DEFAULT_HEIGHT);
  const workspacePanelHeightMountedRef = useRef(false);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [runningSessionCwds, setRunningSessionCwds] = useState<Record<string, string>>({});
  const knownRunningCwdsRef = useRef<Map<string, string>>(new Map());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Relative session times must age while the sidebar stays open; one shared
  // minute clock avoids a timer per session row.
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  useEffect(() => {
    setWorkspacePanelHeight(loadWorkspacePanelHeight());
  }, []);

  // 拖动期间只更新 DOM，结束后才写入 React 状态和本地存储，避免高频重渲染。
  useEffect(() => {
    if (!workspacePanelHeightMountedRef.current) {
      workspacePanelHeightMountedRef.current = true;
      return;
    }
    if (workspacePanelResizing) return;
    try {
      window.localStorage.setItem(WORKSPACE_PANEL_HEIGHT_STORAGE_KEY, String(workspacePanelHeight));
    } catch {
      // 隐私模式或空间不足时，本次页面会话内的尺寸仍有效。
    }
  }, [workspacePanelHeight, workspacePanelResizing]);
  // Client-side workspace/session filtering (Workspaces header controls).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  const sessionsEtagRef = useRef<string | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  // Set once the first /api/sessions fetch settles (success OR failure) so the
  // initial-restore effect can stop waiting on a load that never yields rows.
  const initialLoadedRef = useRef(false);
  const loadSessions = useCallback(async (showLoading = false) => {
    sessionsAbortRef.current?.abort();
    const controller = new AbortController();
    sessionsAbortRef.current = controller;
    try {
      if (showLoading) setLoading(true);
      const headers: Record<string, string> = {};
      if (sessionsEtagRef.current) headers["If-None-Match"] = sessionsEtagRef.current;
      const res = await fetch("/api/sessions", { headers, signal: controller.signal });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get("ETag");
      if (etag) sessionsEtagRef.current = etag;
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; runningSessions?: Array<{ id: string; cwd: string }> };
      setAllSessions(data.sessions);
      if (data.runningSessions) {
        for (const rs of data.runningSessions) {
          if (rs.id && rs.cwd) knownRunningCwdsRef.current.set(rs.id, rs.cwd);
        }
      }
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        if (data.runningSessions) {
          const nextCwds: Record<string, string> = {};
          for (const rs of data.runningSessions) {
            if (rs.id && rs.cwd) nextCwds[rs.id] = rs.cwd;
          }
          setRunningSessionCwds(nextCwds);
        }
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(t("sessionSidebar.loadFailed", { detail: e instanceof Error ? e.message : String(e) }));
    } finally {
      initialLoadedRef.current = true;
      if (showLoading) setLoading(false);
    }
  }, [t]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const projectsLoadSeqRef = useRef(0);
  const loadProjects = useCallback(async () => {
    const seq = ++projectsLoadSeqRef.current;
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { projects?: ManagedProject[] };
      // A newer request superseded this one — drop the stale response.
      if (seq !== projectsLoadSeqRef.current) return;
      setProjects(data.projects ?? []);
      setProjectsError(null);
      projectsLoadedRef.current = true;
    } catch (e) {
      if (seq !== projectsLoadSeqRef.current) return;
      setProjectsError(t("projects.loadFailed", { detail: e instanceof Error ? e.message : String(e) }));
    }
  }, [t]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshKey]);

  useEffect(() => {
    const interval = setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Persist expansion state; null means nothing was stored yet.
  useEffect(() => {
    if (expandedProjects === null) return;
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  // Debounce refresh bursts (agent_start + session_info_update + file-appear signal can fire within 250ms)
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (pendingRefreshRef.current) return;
    pendingRefreshRef.current = setTimeout(() => {
      pendingRefreshRef.current = null;
      void loadSessions(false);
    }, 300);
  }, [loadSessions]);
  useEffect(() => () => {
    if (sessionRefreshTimerRef.current) {
      clearTimeout(sessionRefreshTimerRef.current);
      sessionRefreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Live running status and session-list invalidations arrive via SSE; the
    // sidebar never has to poll while an agent is working.
    const source = new EventSource("/api/agent/running/events");

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          runningSessionIds?: string[];
          runningSessions?: Array<{ id: string; cwd: string }>;
          refreshSessionList?: boolean;
          sessionIds?: string[];
        };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          if (data.runningSessions) {
            const nextCwds: Record<string, string> = {};
            for (const rs of data.runningSessions) {
              if (rs.id && rs.cwd) {
                knownRunningCwdsRef.current.set(rs.id, rs.cwd);
                nextCwds[rs.id] = rs.cwd;
              }
            }
            setRunningSessionCwds(nextCwds);
          }
          if (data.refreshSessionList) scheduleRefresh();
        } else if (data.type === "sessions-changed") {
          if (data.refreshSessionList) scheduleRefresh();
          publishSessionsChanged(data.sessionIds ?? []);
        }
      } catch {
        // ignore malformed frames
      }
    };

    source.onerror = () => {
      // EventSource auto-reconnects; until a fresh frame arrives, let the
      // polled /api/sessions fallback own running state again.
      sseAuthoritativeRef.current = false;
    };
    // On error EventSource auto-reconnects; keep the last known state meanwhile.
    return () => {
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
      source.close();
    };
  }, [loadSessions, scheduleRefresh]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    // A brand-new session's JSONL does not exist until the first assistant
    // turn makes progress — but its running badge must show immediately
    // via the optimistic row. Once any session completes (or a new session
    // appears on disk), reload so it replaces the optimistic placeholder
    // without waiting for another refresh trigger.
    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      loadSessions(false);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);
  /** Set once the first /api/projects fetch succeeds; guards the expansion
   *  prune against running on an empty (still-loading) project list. */
  const projectsLoadedRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available.
   *  The worktree/branch cache is keyed per repository, so this lookup is
   *  scoped: a worktree belongs to the repository whose cached GitState lists
   *  it — never to a different repository's state. */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    for (const state of Object.values(worktreeStateByProject)) {
      if (state.worktrees.some((w) => normalizeProjectKey(w.path) === normalizeProjectKey(cwd))) {
        return state.projectRoot;
      }
    }
    // Fall back to the project registry, then to session cwd→root matches, so
    // a session whose projectKey was normalized server-side still resolves to
    // the registry's case-preserved path — the caller gets a canonical value.
    const registered = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cwd));
    if (registered) return registered.path;
    const foldedCwd = comparableProjectPath(cwd);
    const match = allSessions.find((s) => comparableProjectPath(s.cwd) === foldedCwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeStateByProject, allSessions, projects]);

  // ---- Expansion (used by the sync/notify effects below, so declared first) --
  // Keys are stored in comparableProjectPath form so case-variant spellings of
  // the same Windows path map to one entry (the server lowercases projectKey
  // on win32, while project.path preserves registry casing).
  const expandProject = useCallback((path: string) => {
    const key = comparableProjectPath(path);
    setExpandedProjects((prev) => {
      if (prev?.has(key)) return prev;
      const next = new Set(prev ?? []);
      next.add(key);
      return next;
    });
  }, []);

  const collapseProject = useCallback((path: string) => {
    const key = comparableProjectPath(path);
    setExpandedProjects((prev) => {
      if (!prev?.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleProjectExpanded = useCallback((path: string) => {
    const key = comparableProjectPath(path);
    setExpandedProjects((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);


  /** Activate a project (effective cwd = its root) and expand it, without
   *  opening a session. */
  const activateProject = useCallback((path: string) => {
    provisionalSelectionRef.current = false;
    setSelectedCwd(path);
    expandProject(path);
  }, [expandProject]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back. Sessions
  // picked outside the sidebar (URL restore, command palette) also expand
  // their containing project.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
      const project = projectRootFor(selectedCwdProp);
      if (project) expandProject(project);
    }
  }, [selectedCwdProp, projectRootFor, expandProject]);

  // Load worktrees/branch data for the repository containing the current
  // effective cwd. Results are cached in worktreeStateByProject keyed by the
  // normalized repository root, so each workspace keeps its own Git context:
  //  • switching to another repo leaves this repo's cached state intact, and
  //  • a late response for the previously-selected repo writes only that
  //    repo's entry (never the active repo's, so it can't overwrite the UI).
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) return;
    let cancelled = false;
    const requestedCwd = selectedCwd;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(requestedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        if (d.error || !d.projectRoot) {
          // This cwd is not a Git repo (or the lookup failed) — the selected
          // workspace should show no branch/worktrees. Other repos' cached
          // state is left intact: a non-Git workspace never inherits another
          // repo's branch, and we never discard previously-visited repos' Git
          // state.
          return;
        }
        const projectRoot = d.projectRoot;
        const entry: WorktreeState = {
          forCwd: requestedCwd,
          projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          worktrees: d.worktrees ?? [],
        };
        setWorktreeStateByProject((prev) => {
          const key = normalizeProjectKey(projectRoot);
          const existing = prev[key];
          if (existing && normalizeProjectKey(existing.projectRoot) !== key) {
            const next = { ...prev };
            delete next[normalizeProjectKey(existing.projectRoot)];
            next[key] = entry;
            return next;
          }
          return { ...prev, [key]: entry };
        });
      })
      .catch(() => { /* leave any cached state; refetch on demand */ });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Keep a just-created session and its project visible while omp is still
  // flushing the JSONL file. The server list remains authoritative once it
  // contains the same id.
  // IMPORTANT: derive synchronously — the previous projectRootFor(cwd) needs
  // the async /api/worktrees git lookup, so the optimistic row would park in
  // cwd-bucket then jump to repo bucket. Use registered-project match first.
  const optimisticProjectRoot = (() => {
    if (!optimisticSession) return null;
    if (optimisticSession.projectRoot) return optimisticSession.projectRoot;
    if (optimisticSession.projectKey) return optimisticSession.projectKey;
    const cw = optimisticSession.cwd ?? "";
    if (!cw) return null;
    const reg = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cw));
    if (reg) return reg.path;
    return cw;
  })();
  // Stable placeholder timestamps: Date.now() inside the memo would churn every refresh and bust downstream memos.
  const placeholderTsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (optimisticSession?.id && optimisticSession.cwd) {
      knownRunningCwdsRef.current.set(optimisticSession.id, optimisticSession.cwd);
      setRunningSessionCwds((prev) => (prev[optimisticSession.id] === optimisticSession.cwd ? prev : { ...prev, [optimisticSession.id]: optimisticSession.cwd }));
    }
  }, [optimisticSession]);
  const visibleSessions = useMemo(() => {
    let base = allSessions;
    if (optimisticSession && !base.some((session) => session.id === optimisticSession.id)) {
      const stableRoot = optimisticProjectRoot ?? optimisticSession.cwd;
      const stableKey = stableRoot ? comparableProjectPath(stableRoot) : undefined;
      base = [...base, { ...optimisticSession, projectRoot: stableRoot ?? optimisticSession.cwd, ...(stableKey ? { projectKey: stableKey } : {}) }];
    }
    // A running session's JSONL may not exist yet (first turn still
    // streaming). Keep it in the list so navigating away never hides it
    // until the file lands and the next refresh replaces the placeholder.
    const known = new Set(base.map((s) => s.id));
    const placeholders: SessionInfo[] = [];
    for (const id of runningSessionIds) {
      if (known.has(id)) continue;
      let ts = placeholderTsRef.current.get(id);
      if (!ts) {
        ts = new Date().toISOString();
        placeholderTsRef.current.set(id, ts);
      }
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? knownRunningCwdsRef.current.get(id)
        ?? selectedCwd
        ?? "";
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ?? optimisticSession.projectRoot ?? optimisticSession.cwd)
        : (projectRootFor(sessionCwd) ?? sessionCwd);
      const phRoot = resolvedRoot ?? "";
      const phKey = phRoot ? comparableProjectPath(phRoot) : undefined;
      placeholders.push({
        id,
        path: "",
        cwd: sessionCwd,
        name: undefined,
        created: ts,
        modified: ts,
        messageCount: 1,
        firstMessage: "",
        projectRoot: phRoot,
        ...(phKey ? { projectKey: phKey } : {}),
      });
    }
    // Prune timestamps and known cwds for ids that are now materialized or no longer running
    if (placeholderTsRef.current.size > placeholders.length) {
      for (const key of [...placeholderTsRef.current.keys()]) {
        if (!runningSessionIds.has(key) || known.has(key)) placeholderTsRef.current.delete(key);
      }
    }
    if (knownRunningCwdsRef.current.size > runningSessionIds.size + (optimisticSession ? 1 : 0)) {
      const activeIds = new Set(runningSessionIds);
      if (optimisticSession) activeIds.add(optimisticSession.id);
      for (const key of [...knownRunningCwdsRef.current.keys()]) {
        if (!activeIds.has(key) && known.has(key)) knownRunningCwdsRef.current.delete(key);
      }
    }
    return placeholders.length ? [...base, ...placeholders] : base;
  }, [allSessions, optimisticSession, optimisticProjectRoot, runningSessionIds, runningSessionCwds, projectRootFor, selectedCwd]);
  const visibleProjects = useMemo(() => {
    let base = projects;
    const hasOpt = optimisticProjectRoot ? base.some((p) => comparableProjectPath(p.path) === comparableProjectPath(optimisticProjectRoot)) : false;
    if (optimisticProjectRoot && !hasOpt) {
      base = [...base, { path: optimisticProjectRoot }];
    }
    // Running placeholders may belong to a project not yet in the managed list
    // (new session's cwd wasn't registered as a project). Keep that workspace
    // visible so the placeholder row has a bucket to render in.
    const knownFolded = new Set(base.map((p) => comparableProjectPath(p.path)));
    for (const id of runningSessionIds) {
      if (allSessions.some((s) => s.id === id)) continue;
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? knownRunningCwdsRef.current.get(id)
        ?? selectedCwd
        ?? "";
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ?? optimisticSession.projectRoot ?? optimisticSession.cwd)
        : (projectRootFor(sessionCwd) ?? sessionCwd);
      const phPath = resolvedRoot ?? "";
      if (phPath && !knownFolded.has(comparableProjectPath(phPath))) {
        base = [...base, { path: phPath }];
        knownFolded.add(comparableProjectPath(phPath));
      }
    }
    return base;
  }, [optimisticProjectRoot, projects, runningSessionIds, runningSessionCwds, allSessions, optimisticSession, projectRootFor, selectedCwd]);

  // ---- Derived project list ---------------------------------------------------
  const selectedProject = useMemo(() => projectRootFor(selectedCwd), [projectRootFor, selectedCwd]);
  // While a fresh optimistic/placeholder is pending (JSONL not yet on disk),
  // freeze ordering so the new project row does not flicker optimistic ->
  // confirmed position. New projects are allowed to append at the end.
  const hasPendingNewSession = Boolean(optimisticSession || [...runningSessionIds].some((id) => !allSessions.some((ss) => ss.id === id)));
  const sortedProjectsBase = useMemo(() => sortManagedProjects(visibleProjects), [visibleProjects]);
  const sortedProjectsRef = useRef<ManagedProject[] | null>(null);
  const sortedProjects = useMemo(() => {
    if (hasPendingNewSession && sortedProjectsRef.current) {
      const prev = sortedProjectsRef.current;
      const prevKeys = new Set(prev.map((p) => comparableProjectPath(p.path)));
      const next = [...prev];
      for (const p of sortedProjectsBase) if (!prevKeys.has(comparableProjectPath(p.path))) next.push(p);
      return next;
    }
    sortedProjectsRef.current = sortedProjectsBase;
    return sortedProjectsBase;
  }, [sortedProjectsBase, hasPendingNewSession]);
  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sortedProjects, visibleSessions),
    [sortedProjects, visibleSessions],
  );
  const projectActivity = useMemo(
    () => projectActivityCounts(visibleSessions, runningSessionIds, unreadSessionIds),
    [visibleSessions, runningSessionIds, unreadSessionIds],
  );

  // Client-side filtering (Workspaces header: search + "running only").
  // While a filter is active, workspaces with no matching sessions are hidden
  // so the list reads as a genuine result set; at rest every workspace stays.
  // Deferred search: typing stays responsive (input updates immediately) while the heavy
  // visibleProjectEntries filter runs at lower priority. Combines with the 200ms ETag loadSessions
  // debounce already in place — keystrokes never block the main thread on large session lists.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filtersActive = searchOpen || runningOnly || deferredSearchQuery.trim().length > 0;
  const visibleProjectEntries = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    const entries: { project: ManagedProject; sessions: SessionInfo[] }[] = [];
    for (const project of sortedProjects) {
      let list = sessionsByProject.get(project.path) ?? [];
      if (runningOnly) list = list.filter((s) => runningSessionIds.has(s.id));
      if (q) {
        list = list.filter((s) => (s.name ?? "").toLowerCase().includes(q) || s.firstMessage.toLowerCase().includes(q));
      }
      // Label/alias-only matches surface as empty workspaces; without this
      // clause a custom workspace name would be unfindable by search.
      if (list.length === 0 && (runningOnly || (q && !projectLabel(project.path).toLowerCase().includes(q) && !(project.alias ?? "").toLowerCase().includes(q)))) continue;
      entries.push({ project, sessions: list });
    }
    return entries;
  }, [sortedProjects, sessionsByProject, runningOnly, deferredSearchQuery, runningSessionIds]);

  const treesByProject = useMemo(() => {
    const m = new Map<string, ReturnType<typeof buildSessionTree>>();
    for (const { project, sessions } of visibleProjectEntries) m.set(project.path, buildSessionTree(sessions));
    return m;
  }, [visibleProjectEntries]);

  // Drop persisted expansion keys whose project no longer exists (removed or
  // vanished), so the storage stays bounded to real projects. Only runs after
  // the first project fetch — an empty list mid-load must never wipe storage.
  useEffect(() => {
    if (expandedProjects === null || !projectsLoadedRef.current) return;
    const known = new Set(sortedProjects.map((p) => comparableProjectPath(p.path)));
    const stale = [...expandedProjects].filter((path) => !known.has(comparableProjectPath(path)));
    if (stale.length === 0) return;
    setExpandedProjects((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      stale.forEach((path) => next.delete(path));
      return next;
    });
  }, [expandedProjects, sortedProjects]);

  // True while the auto-selected project was chosen before projects loaded
  // (ordering incomplete); cleared by any manual activation.
  const provisionalSelectionRef = useRef(false);

  // A just-started session's JSONL is not flushed until its first turn makes
  // progress, so a URL reopened in that window has no list entry yet. Retry
  // the list a few times before declaring the restore failed.
  const restoreRetryRef = useRef(0);
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (restoreRetryTimerRef.current) {
      clearTimeout(restoreRetryTimerRef.current);
      restoreRetryTimerRef.current = null;
    }
  }, []);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (skipInitialProjectSelection) return;

    // If restoring a session, set cwd to match that session
    if (initialSessionId && !restoredRef.current) {
      // An empty list only blocks while the first load is still in flight —
      // a settled-but-empty or failed load means the target will never appear
      // (shared ?session= link, deleted session), so fall through to the
      // retry/exhaustion path below instead of returning forever.
      if (allSessions.length === 0 && !initialLoadedRef.current) return; // wait for sessions to load
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        restoreRetryRef.current = 0;
        restoredRef.current = true;
        setSelectedCwd(target.cwd);
        expandProject(comparableProjectPath(workspaceKeyOf(target)));
        onSelectSession(target, true);
        return;
      }
      if (restoreRetryRef.current < INITIAL_RESTORE_MAX_ATTEMPTS) {
        restoreRetryRef.current += 1;
        if (restoreRetryTimerRef.current) {
          clearTimeout(restoreRetryTimerRef.current);
          restoreRetryTimerRef.current = null;
        }
        restoreRetryTimerRef.current = setTimeout(() => {
          restoreRetryTimerRef.current = null;
          void loadSessions(false);
        }, INITIAL_RESTORE_RETRY_MS);
        return;
      }
      restoreRetryRef.current = 0;
      restoredRef.current = true;
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }
    // No restore target: activate the top project (most recently added) so New
    // Session and Explorer have a context. When projects have not loaded yet
    // the ordering is provisional — re-pick once they arrive, unless the user
    // already activated a project by hand.
    if (selectedCwd !== null && !provisionalSelectionRef.current) return;
    const top = sortedProjects[0];
    if (!top) return;
    setSelectedCwd(top.path);
    expandProject(top.path);
    provisionalSelectionRef.current = allSessions.length === 0;
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, sortedProjects, expandProject, loadSessions]);

  // Default expansion: when the user has never stored an expansion choice,
  // expand only the active project.
  const defaultExpandedRef = useRef(false);
  useEffect(() => {
    if (defaultExpandedRef.current) return;
    const project = selectedProject;
    if (!project) return;
    defaultExpandedRef.current = true;
    if (expandedProjects === null) expandProject(project);
  }, [selectedProject, expandedProjects, expandProject]);

  const commitAddProject = useCallback(async (candidate?: string, launchConfig?: ProjectLaunchConfig) => {
    const path = (candidate ?? "").trim();
    if (!path || addProjectBusy) return;

    setAddProjectBusy(true);
    setAddProjectError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path, launchConfig }),
      });
      const data = await res.json().catch(() => ({})) as { project?: ManagedProject; error?: string; code?: string };
      if (!res.ok || data.error || !data.project) {
        setAddProjectError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      await loadProjects();
      // Activate + expand the newly added project and close the picker.
      setSelectedCwd(data.project.path);
      expandProject(data.project.path);
      setAddProjectOpen(false);
    } catch (e) {
      setAddProjectError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddProjectBusy(false);
    }
  }, [addProjectBusy, loadProjects, expandProject]);

  /** 按当前可用高度约束工作区列表，始终给资源管理器保留可操作空间。 */
  const clampWorkspacePanelHeight = useCallback((height: number): number => {
    const workspaceHeight = workspacePanelRef.current?.getBoundingClientRect().height ?? 0;
    const explorerHeight = explorerPanelRef.current?.getBoundingClientRect().height ?? 0;
    const totalHeight = workspaceHeight + explorerHeight;
    const maxHeight = Math.max(WORKSPACE_PANEL_MIN_HEIGHT, totalHeight - EXPLORER_PANEL_MIN_HEIGHT);
    return Math.min(maxHeight, Math.max(WORKSPACE_PANEL_MIN_HEIGHT, Math.round(height)));
  }, []);

  /** 键盘调整分区大小；Enter 或空格恢复默认比例，提供鼠标拖动的等效操作。 */
  const handleWorkspaceResizeKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setWorkspacePanelHeight((height) => clampWorkspacePanelHeight(height - 20));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setWorkspacePanelHeight((height) => clampWorkspacePanelHeight(height + 20));
    } else if (event.key === "Home") {
      event.preventDefault();
      setWorkspacePanelHeight(WORKSPACE_PANEL_MIN_HEIGHT);
    } else if (event.key === "End") {
      event.preventDefault();
      setWorkspacePanelHeight((height) => clampWorkspacePanelHeight(Number.MAX_SAFE_INTEGER));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setWorkspacePanelHeight(clampWorkspacePanelHeight(WORKSPACE_PANEL_DEFAULT_HEIGHT));
    }
  }, [clampWorkspacePanelHeight]);

  /** 开始拖动分隔条，在窗口范围接收事件以支持快速越界拖动。 */
  const handleWorkspaceResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = workspacePanelRef.current?.getBoundingClientRect().height ?? workspacePanelHeight;
    setWorkspacePanelResizing(true);
    const onMove = (moveEvent: MouseEvent) => {
      const height = clampWorkspacePanelHeight(startHeight + (moveEvent.clientY - startY));
      workspacePanelRef.current?.style.setProperty("flex", `0 1 ${height}px`);
      pendingWorkspacePanelHeightRef.current = height;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      workspaceResizeHandlersRef.current = null;
      setWorkspacePanelResizing(false);
      setWorkspacePanelHeight(pendingWorkspacePanelHeightRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    pendingWorkspacePanelHeightRef.current = startHeight;
    workspaceResizeHandlersRef.current = { onMove, onUp };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [clampWorkspacePanelHeight, isMobile, workspacePanelHeight]);

  // 组件在拖动中卸载时，恢复文档状态并移除窗口事件，避免全局监听泄漏。
  useEffect(() => () => {
    const handlers = workspaceResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const handleUpdateProjectPresentation = useCallback(async (projectPath: string, updates: { alias?: string | null; sortOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }) => {
    try {
      const response = await fetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectPath, ...updates }) });
      if (!response.ok) throw new Error(t("projects.updateFailed"));
      await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [loadProjects, t]);

  /** Persist one whole-list order as a single atomic batched PATCH. */
  const persistProjectOrder = useCallback(async (next: ManagedProject[]) => {
    try {
      // One batched request: the server applies every entry in a single
      // atomic registry save, so per-project writes can't interleave and lose
      // updates. Discovered projects included here are registered server-side.
      const response = await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: next.map((project, index) => ({ cwd: project.path, sortOrder: index })) }),
      });
      if (!response.ok) throw new Error(t("projects.reorderFailed"));
      await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [loadProjects, t]);

  const handleProjectDrop = useCallback(async (targetPath: string) => {
    const sourcePath = draggedProjectPath;
    setDraggedProjectPath(null);
    if (!sourcePath || sourcePath === targetPath) return;
    const next = [...sortedProjects];
    const from = next.findIndex((project) => project.path === sourcePath);
    const to = next.findIndex((project) => project.path === targetPath);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    await persistProjectOrder(next);
  }, [draggedProjectPath, sortedProjects, persistProjectOrder]);

  /** Keyboard-accessible reorder: move one project up/down the list. */
  const handleMoveProject = useCallback(async (projectPath: string, delta: -1 | 1) => {
    const next = [...sortedProjects];
    const index = next.findIndex((project) => project.path === projectPath);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    await persistProjectOrder(next);
  }, [sortedProjects, persistProjectOrder]);

  const handleRemoveProject = useCallback(async (projectPath: string) => {
    if (removeProjectPath) return;
    setRemoveProjectPath(projectPath);
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectPath }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!res.ok || !data.success) {
        toast.error(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      // Hiding the active project leaves nothing selected; activate the next
      // most-relevant project so New Session and Explorer stay usable.
      // Compare case-folded — the selected cwd can spell the project path
      // with different casing than this row (Windows/NTFS).
      if (selectedProject !== null && comparableProjectPath(selectedProject) === comparableProjectPath(projectPath)) {
        const next = sortedProjects.find((p) => p.path !== projectPath);
        setSelectedCwd(next ? next.path : null);
      }
      collapseProject(projectPath);
      await loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoveProjectPath(null);
    }
  }, [removeProjectPath, selectedProject, sortedProjects, collapseProject, loadProjects]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    // Operate against the active repo's own cached Git state — never a
    // globally stored path, so the branch is created in the correct repo.
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!branch || wtBusy || !activeState) return;
    const root = activeState.projectRoot;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string; code?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      const newWorktreePath: string = data.path;
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree against THIS repo's cached
      // entry so projectRootFor() resolves it to the main repo before the
      // refetch lands (keeps AppShell from treating the new cwd as a different
      // project). Other repos' cached state is untouched.
      setWorktreeStateByProject((prev) => {
        const key = normalizeProjectKey(root);
        const existing = prev[key];
        if (!existing) return prev;
        const newWt: WorktreeEntry = { path: newWorktreePath, branch, isMain: false };
        return { ...prev, [key]: { ...existing, forCwd: newWorktreePath, worktrees: [...existing.worktrees, newWt] } };
      });
      setSelectedCwd(newWorktreePath);
      setWtRefreshKey((k) => k + 1);
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, selectedProject, worktreeStateByProject, loadProjects, loadSessions]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    // Remove only from the active repo's own cached Git state.
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!activeState || wtBusy) return;
    const root = activeState.projectRoot;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean; code?: string };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      setWtConfirmRemove(null);
      // Optimistically remove the deleted worktree from the active project's state
      setWorktreeStateByProject((prev) => {
        const key = normalizeProjectKey(root);
        const existing = prev[key];
        if (!existing) return prev;
        const nextWorktrees = existing.worktrees.filter((w) => comparableProjectPath(w.path) !== comparableProjectPath(path));
        return {
          ...prev,
          [key]: {
            ...existing,
            forCwd: selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path) ? root : existing.forCwd,
            worktrees: nextWorktrees,
          },
        };
      });
      if (selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path)) {
        setSelectedCwd(root);
      }
      setWtRefreshKey((k) => k + 1);
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [selectedProject, worktreeStateByProject, wtBusy, selectedCwd, loadProjects, loadSessions]);

  // Reset the worktree dropdown's transient state (used by the portaled
  // dropdown's outside-press/Escape close, the branch toggle, and worktree
  // selection).
  const closeWorktreeDropdown = useCallback(() => {
    setWtDropdownOpen(false);
    setWtNewOpen(false);
    setWtNewBranch("");
    setWtError(null);
    setWtConfirmRemove(null);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees. Selecting a session also
  // activates and expands its containing project.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    provisionalSelectionRef.current = false;
    if (s.cwd) setSelectedCwd(s.cwd);
    expandProject(comparableProjectPath(workspaceKeyOf(s)));
    onSelectSession(s);
  }, [onSelectSession, expandProject]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImportSession = useCallback(async (file: File | null) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      const content = await file.text();
      const res = await fetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!res.ok || !data.success) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(t("sessionSidebar.imported"));
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [importing, loadSessions, loadProjects, t]);

  // Sessions of every worktree in the selected project are shown together.
  // Keys are comparableProjectPath forms (see expandProject) — comparable to
  // the folded registry paths rows are checked against.
  const expandedProjectKeys = expandedProjects ?? EMPTY_PROJECT_SET;

  // The active repo's own cached Git state, selected by repository root — never
  // a single sidebar-wide variable, so it is always the state belonging to the
  // repo the user currently has active.
  const activeGitState = selectedProject
    ? worktreeStateByProject[normalizeProjectKey(selectedProject)]
    : undefined;

  /** Inline branch label ("omp-web · main") from a project's OWN cached Git
   *  state. Returns null when the project has no Git state or is not a git
   *  repo, so a non-Git / not-yet-loaded project never shows another repo's
   *  branch. */
  const worktreeBranchForProject = useCallback((projectPath: string): string | null => {
    const state = worktreeStateByProject[normalizeProjectKey(projectPath)];
    if (!state || !state.isGit || !state.isTopLevel) return null;
    const current = state.worktrees.find((w) => normalizeProjectKey(w.path) === normalizeProjectKey(selectedCwd ?? ""))
      ?? state.worktrees.find((w) => w.isMain);
    if (!current) return null;
    return current.branch ?? displayCwd(current.path, homeDir);
  }, [worktreeStateByProject, selectedCwd, homeDir]);

  const showWorktreeSwitcher = Boolean(
    activeGitState?.isGit
    && activeGitState.isTopLevel
    && selectedCwd
    && selectedProject !== null
    // Case-folded: the active project may be spelled differently than the
    // server-resolved git root (Windows/NTFS), yet still be the same repo.
    && comparableProjectPath(selectedProject) === comparableProjectPath(activeGitState.projectRoot),
  );
  const toggleWorktrees = useCallback(() => {
    // Fold through closeWorktreeDropdown so closing never leaves the previous
    // worktree's confirm/new-branch transient state behind.
    if (wtDropdownOpen) closeWorktreeDropdown();
    else setWtDropdownOpen(true);
  }, [wtDropdownOpen, closeWorktreeDropdown]);

  // Stable callbacks for the session list so memoized children don't re-render
  // on every parent state change.
  const handleSessionDeleted = useCallback((id: string) => {
    const deleted = allSessions.find((session) => session.id === id);
    if (deleted) clearLastOpenSession(workspaceKeyOf(deleted));
    onSessionDeleted?.(id);
    loadSessions();
  }, [allSessions, onSessionDeleted, loadSessions]);

  useEffect(() => {
    const selected = allSessions.find((session) => session.id === selectedSessionId);
    if (selected) setLastOpenSession(workspaceKeyOf(selected), selected.id);
  }, [allSessions, selectedSessionId]);

  // row. Non-Git projects intentionally render no Git affordance at all. The
  // switcher shows the ACTIVE repo's own worktrees/branches only.
  const activeProjectSwitcher = showWorktreeSwitcher && activeGitState ? (
    <ProjectWorktreeSwitcher
      worktreeState={activeGitState}
      selectedCwd={selectedCwd}
      homeDir={homeDir}
      wtDropdownOpen={wtDropdownOpen}
      wtNewOpen={wtNewOpen}
      setWtNewOpen={setWtNewOpen}
      wtNewBranch={wtNewBranch}
      setWtNewBranch={setWtNewBranch}
      wtError={wtError}
      setWtError={setWtError}
      wtBusy={wtBusy}
      wtConfirmRemove={wtConfirmRemove}
      setWtConfirmRemove={setWtConfirmRemove}
      onSelectWorktree={(path) => {
        setSelectedCwd(path);
        closeWorktreeDropdown();
      }}
      onCreateWorktree={handleCreateWorktree}
      onRemoveWorktree={(path, force) => void handleRemoveWorktree(path, force)}
      anchorRef={wtToggleRef}
      newInputRef={wtNewInputRef}
      onClose={closeWorktreeDropdown}
    />
  ) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {addProjectOpen && (
        <DirectoryPicker
          busy={addProjectBusy}
          error={addProjectError}
          onCancel={() => {
            setAddProjectOpen(false);
            setAddProjectError(null);
          }}
          onSelect={(path, launchConfig) => void commitAddProject(path, launchConfig)}
        />
      )}
      {launchConfigProject && (
        <ProjectLaunchConfigDialog
          projectPath={launchConfigProject.path}
          initialConfig={launchConfigProject.launchConfig}
          onClose={() => setLaunchConfigProject(null)}
          onSave={async (launchConfig) => {
            await handleUpdateProjectPresentation(launchConfigProject.path, { launchConfig });
            toast.info("工作区启动参数已保存；下次启动或重新加载 omp 会生效。");
          }}
        />
      )}
      {/* Header: branding + quiet utilities + New Session */}
      <div
        style={{
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <OmpWebTitle />
          <div style={{ display: "flex", gap: 2 }}>
            {onOpenArchive && (
              <Tooltip content={t("sessionSidebar.archiveBrowserTitle")} side="bottom">
                <SidebarIconButton
                  label={t("sessionSidebar.archiveBrowser")}
                  onClick={onOpenArchive}
                >
                  <Archive size={14} strokeWidth={1.9} aria-hidden="true" />
                </SidebarIconButton>
              </Tooltip>
            )}
            <Tooltip content={t("sessionSidebar.importTitle")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.import")}
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
              >
                <FileUp size={14} strokeWidth={1.9} aria-hidden="true" />
              </SidebarIconButton>
            </Tooltip>
            <Tooltip content={t("sessionSidebar.refresh")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.refresh")}
                active={sessionRefreshDone}
                onClick={() => {
                  loadSessions(false);
                  void loadProjects();
                }}
              >
                {sessionRefreshDone ? (
                  <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />
                )}
              </SidebarIconButton>
            </Tooltip>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".jsonl,.json,application/json,application/jsonl"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = "";
            void handleImportSession(file);
          }}
        />
        <button
          onClick={handleNewSession}
          disabled={!selectedCwd}
          className="sidebar-new-session"
          title={selectedCwd ? t("sessionSidebar.newSessionIn", { cwd: selectedCwd }) : t("sessionSidebar.selectProjectFirst")}
          style={{
            width: "100%",
            height: 38,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 9,
            color: selectedCwd ? "var(--text)" : "var(--text-dim)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            opacity: selectedCwd ? 1 : 0.65,
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => {
            if (!selectedCwd) return;
            e.currentTarget.style.background = "var(--bg-selected)";
            e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 30%, transparent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <Plus size={15} strokeWidth={2.2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
          <span>{t("sessionSidebar.new")}</span>
        </button>
      </div>

      {/* Workspaces section header: label + search / filter / add */}
      <div style={{ flexShrink: 0, padding: "4px 10px 2px", display: "flex", alignItems: "center", gap: 2 }}>
        <span
          style={{
            flex: 1,
            color: "var(--text-muted)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {t("projects.heading")}
        </span>
        <SidebarIconButton
          label={t("sessionSidebar.search")}
          title={t("sessionSidebar.searchTitle")}
          active={searchOpen}
          onClick={() => {
            const nextOpen = !searchOpen;
            setSearchOpen(nextOpen);
            if (nextOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
            else setSearchQuery("");
          }}
        >
          <Search size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("sessionSidebar.filterRunning")}
          title={t("sessionSidebar.filterRunningTitle")}
          active={runningOnly}
          onClick={() => setRunningOnly((v) => !v)}
        >
          <SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("projects.add")}
          title={t("projects.addTitle")}
          onClick={() => {
            setAddProjectOpen(true);
            setAddProjectError(null);
          }}
        >
          <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
      </div>
      {searchOpen && (
        <div style={{ padding: "0 10px 6px", flexShrink: 0 }}>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder={t("sessionSidebar.searchPlaceholder")}
            aria-label={t("sessionSidebar.search")}
            style={{
              width: "100%",
              height: 27,
              boxSizing: "border-box",
              padding: "0 9px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              outline: "none",
              color: "var(--text)",
              fontSize: 12,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
        </div>
      )}

      {/* Workspaces */}
        <div
          ref={workspacePanelRef}
          style={{
            flex: explorerOpen && (selectedCwdProp || selectedCwd) ? `0 1 ${workspacePanelHeight}px` : "1 1 auto",
            transition: workspacePanelResizing ? "none" : "flex var(--dur-med) var(--ease-out-warm)",
            overflowY: "auto",
            padding: "2px 10px 10px",
            minHeight: WORKSPACE_PANEL_MIN_HEIGHT,
          }}
        >
          {loading && (
            <div style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12 }}>
              {t("sessionSidebar.loading")}
            </div>
          )}
          {projectsError && (
            <div style={{ padding: "10px 4px", color: "var(--accent)", fontSize: 12 }}>{projectsError}</div>
          )}
          {error && (
            <div style={{ padding: "10px 4px", color: "var(--accent)", fontSize: 12 }}>{error}</div>
          )}
          {!loading && !projectsError && !error && sortedProjects.length === 0 && (
            <div style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
              {t("projects.noProjects")}
            </div>
          )}
          {!loading && !projectsError && !error && sortedProjects.length > 0 && visibleProjectEntries.length === 0 && (
            <div style={{ padding: "14px 4px", color: "var(--text-dim)", fontSize: 11.5, lineHeight: 1.5 }}>
              {t("sessionSidebar.noMatches")}
            </div>
          )}

          {visibleProjectEntries.map(({ project, sessions }) => {
            const tree = treesByProject.get(project.path) ?? buildSessionTree(sessions);
            // Sessions group under a project through the case-folded comparable
            // form (see groupSessionsByProject), so the active highlight must
            // use the same comparison: a session whose cwd/projectRoot spells
            // the project folder with different casing (Windows/NTFS) lands in
            // this row — the row must light up for it too.
            const isActive = selectedProject !== null && comparableProjectPath(selectedProject) === comparableProjectPath(project.path);
            // Each project's own branch comes from its own cached Git state —
            // a project never inherits another repo's branch. Only the active
            // repo's row owns the single switcher anchor so the dropdown opens
            // against the correct row.
            const projectBranch = worktreeBranchForProject(project.path);
            return (
              <ProjectRow
                key={project.path}
                project={project}
                isActive={isActive}
                activity={projectActivity.get(comparableProjectPath(project.path))}
                tree={tree}
                isExpanded={expandedProjectKeys.has(comparableProjectPath(project.path))}
                hiddenCount={filtersActive ? 0 : Math.max(0, tree.length - MAX_PROJECT_SESSIONS)}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                unreadSessionIds={unreadSessionIds}
                relativeTimeNow={relativeTimeNow}
                onActivate={activateProject}
                onToggleExpand={toggleProjectExpanded}
                onRemoveProject={handleRemoveProject}
                onEditLaunchConfig={setLaunchConfigProject}
                onUpdatePresentation={handleUpdateProjectPresentation}
                onDragPathChange={setDraggedProjectPath}
                onDropProject={(path) => void handleProjectDrop(path)}
                onMoveProject={(path, delta) => void handleMoveProject(path, delta)}
                isDragTarget={draggedProjectPath !== null && draggedProjectPath !== project.path}
                removeBusy={removeProjectPath === project.path}
                onSelectSession={handleSelectSessionFromList}
                onRenamed={loadSessions}
                onSessionDeleted={handleSessionDeleted}
                activeWorktreeSwitcher={isActive ? activeProjectSwitcher : null}
                worktreeBranch={projectBranch}
                worktreeToggleRef={isActive && projectBranch ? wtToggleRef : undefined}
                worktreeOpen={isActive ? wtDropdownOpen : false}
                onToggleWorktrees={isActive ? toggleWorktrees : undefined}
                homeDir={homeDir}
              />
            );
          })}
        </div>

      {explorerOpen && (selectedCwdProp || selectedCwd) && !isMobile && (
        <div
          className="sidebar-panel-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整工作区与资源管理器高度"
          aria-valuemin={WORKSPACE_PANEL_MIN_HEIGHT}
          aria-valuemax={Math.max(WORKSPACE_PANEL_MIN_HEIGHT, (workspacePanelRef.current?.getBoundingClientRect().height ?? 0) + (explorerPanelRef.current?.getBoundingClientRect().height ?? 0) - EXPLORER_PANEL_MIN_HEIGHT)}
          aria-valuenow={workspacePanelHeight}
          tabIndex={0}
          title="拖动调整工作区与资源管理器高度；双击或按 Enter 重置"
          onKeyDown={handleWorkspaceResizeKey}
          onMouseDown={handleWorkspaceResizeStart}
          onDoubleClick={() => setWorkspacePanelHeight(clampWorkspacePanelHeight(WORKSPACE_PANEL_DEFAULT_HEIGHT))}
          style={{
            height: 10,
            flexShrink: 0,
            cursor: "row-resize",
            touchAction: "none",
            position: "relative",
            outline: "none",
          }}
        >
        </div>
      )}

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          ref={explorerPanelRef}
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: explorerOpen ? EXPLORER_PANEL_MIN_HEIGHT : 0,
            overflow: "hidden",
            transition: workspacePanelResizing ? "none" : "flex var(--dur-med) var(--ease-out-warm)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <ChevronRight
                size={12}
                strokeWidth={1.8}
                style={{
                  transform: explorerOpen ? "rotate(90deg)" : "none",
                  transition: "transform var(--dur-med) var(--ease-out-warm)",
                  flexShrink: 0,
                }}
                aria-hidden="true"
              />
              {t("sessionSidebar.explorer")}
            </button>
            <div
              inert={!explorerOpen ? true : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                opacity: explorerOpen ? 1 : 0,
                pointerEvents: explorerOpen ? "auto" : "none",
                transition: "opacity var(--dur-fast) var(--ease-out-warm)",
              }}
            >
              <Tooltip content={t("fileExplorer.searchFiles")} side="top">
                <button
                  onClick={() => setFileSearchOpen((open) => !open)}
                  title={t("fileExplorer.searchFiles")}
                  aria-label={t("fileExplorer.searchFiles")}
                  aria-pressed={fileSearchOpen}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, padding: 0,
                    background: fileSearchOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    color: fileSearchOpen ? "var(--accent)" : "var(--text-dim)",
                    cursor: "pointer",
                    borderRadius: "var(--radius-control)",
                    flexShrink: 0,
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  <Search size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip content={t("sessionSidebar.uploadFilesTitle")} side="top">
                <button
                  onClick={() => fileExplorerRef.current?.openUploadPicker()}
                  disabled={explorerUploadBusy}
                  title={t("sessionSidebar.uploadFilesTitle")}
                  aria-label={t("sessionSidebar.uploadFiles")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, padding: 0,
                    background: "none",
                    border: "none",
                    color: "var(--text-dim)",
                    cursor: explorerUploadBusy ? "default" : "pointer",
                    borderRadius: "var(--radius-control)",
                    flexShrink: 0,
                    opacity: explorerUploadBusy ? 0.6 : 1,
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  <Upload size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
            <Tooltip content={t("sessionSidebar.refreshExplorer")} side="top">
              <button
                aria-label={t("sessionSidebar.refreshExplorer")}
                onClick={() => {
                  if (onExplorerRefresh) onExplorerRefresh();
                  else setExplorerKey((k) => k + 1);
                }}
                title={t("sessionSidebar.refreshExplorer")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26, padding: 0, marginRight: 6,
                  background: "none",
                  border: "none",
                  color: explorerRefreshing ? "var(--accent)" : "var(--text-dim)",
                  cursor: "pointer",
                  borderRadius: "var(--radius-control)",
                  flexShrink: 0,
                  transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                {explorerRefreshing ? (
                  <RefreshCw size={13} strokeWidth={2} aria-hidden="true" className="icon-spin" />
                ) : (
                  <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          </div>
          <div
            className={"accordion-flow " + (explorerOpen ? "is-open" : "")}
            inert={!explorerOpen ? true : undefined}
            style={{
              flex: explorerOpen ? "1 1 auto" : "0 0 0px",
              minHeight: 0,
            }}
          >
            <div className="accordion-flow-inner" style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                onRefreshDone={onExplorerRefreshDone}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          </div>
        </div>
      )}

      {/* Pinned footer: Settings */}
      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          className="sidebar-settings-row"
          onClick={onOpenSettings}
          title={t("chatInput.settings")}
          aria-label={t("chatInput.settings")}
          style={{
            width: "100%",
            height: 36,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 12px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
            <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
            {updateAvailable && (
              <span
                aria-label={t("skillsConfig.updateAvailable")}
                role="status"
                style={{ position: "absolute", top: -3, right: -4, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", border: "1px solid var(--bg-panel)" }}
              />
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 500 }}>
            {t("chatInput.settings")}
          </span>
          <ChevronRight size={13} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});







