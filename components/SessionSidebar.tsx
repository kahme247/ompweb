"use client";

import { memo, useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, useDeferredValue } from "react";
import type { ElsewhereSessionInfo, ExitedRpcSession, ManagedProject, ProjectLaunchConfig, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProjectLaunchConfigDialog } from "./ProjectLaunchConfigDialog";
import { ProviderUsageBar } from "./ProviderUsageBar";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import { clearLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { groupSessionsByProject, nextPinOrder, orderProjects, projectActivityCounts, type ProjectSortMode } from "@/lib/project-ordering";
import { comparableProjectPath } from "@/lib/comparable-path";
import { compileSearchQuery, FIRST_MESSAGE_WEIGHT, scoreSearchFields, searchField, TITLE_WEIGHT } from "@/lib/session-search";
import { Archive, ArrowDownUp, ArrowLeft, ArrowRight, Check, ChevronRight, FileUp, Loader2, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, X } from "lucide-react";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import { openEventStream } from "@/lib/event-stream";
import {
  loadRecentRuns,
  recordCompletedRun,
  removeActiveFromCompleted,
  saveRecentRuns,
  seedRecentRuns,
  type RecentRunEntry,
} from "@/lib/recent-runs";
import { useRecentRunsLimit } from "@/hooks/useRecentRunsLimit";
import {
  EMPTY_PROJECT_SET,
  INITIAL_RESTORE_MAX_ATTEMPTS,
  INITIAL_RESTORE_RETRY_MS,
  MAX_PROJECT_SESSIONS,
  buildSessionTree,
  loadExpandedProjects,
  loadProjectSortMode,
  loadUnreadSessionIds,
  normalizeProjectKey,
  projectLabel,
  saveExpandedProjects,
  saveProjectSortMode,
  saveUnreadSessionIds,
  type WorktreeContext,
  type WorktreeEntry,
  type WorktreeState,
} from "./SessionSidebar-helpers";
import { OmpWebTitle, SIDEBAR_BUTTON_TRANSITION, SidebarIconButton, SidebarPortalMenu } from "./SessionSidebar-chrome";
import { ProjectRow } from "./SessionSidebar-rows";

/** Deadline for one /api/sessions fetch. A wedged-but-listening server never
 * answers; without this the initial spinner would pend forever. */
const SESSIONS_FETCH_TIMEOUT_MS = 15_000;
/** Stable empty list: sort modes that ignore sessions keep their memo inputs fixed. */
const NO_SESSIONS: SessionInfo[] = [];

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
  onWorkspaceOptionsChange?: (projects: ManagedProject[], selectedProject: string | null, cwd: string | null) => void;
  /** The active Git workspace's worktrees and actions (null when the active
   *  workspace is not a Git top-level repo); rendered by the file panel. */
  onWorktreeContextChange?: (ctx: WorktreeContext | null) => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  /** Shows the provider usage bar above Settings; toggle lives in Settings. */
  usageVisible?: boolean;
  /** Opens the app settings (pinned sidebar footer row). */
  onOpenSettings?: () => void;
  /** True when an omp/ompweb update is available — shows a badge on the gear. */
  updateAvailable?: boolean;
  /** Opens the archived sessions browser. */
  onOpenArchive?: () => void;
  /** In-app back/forward over visited chat views (sidebar header buttons). */
  navigation?: {
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
    /** Platform shortcut label for the tooltip, e.g. "⌘[" / "Alt+←". */
    backShortcut: string;
    forwardShortcut: string;
  };
  /** True when settings full-page view is currently open. */
  settingsOpen?: boolean;
  /** Mobile full-screen drawer only: shows a top-left close control. */
  onClose?: () => void;
}






export const SessionSidebar = memo(function SessionSidebar({ selectedSessionId, optimisticSession, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onWorkspaceOptionsChange, onWorktreeContextChange, addProjectOpen, setAddProjectOpen, usageVisible = true, onOpenSettings, onOpenArchive, navigation, updateAvailable, settingsOpen = false, onClose }: Props) {


  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  // Managed + session-discovered projects (server-merged, hidden excluded).
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [draggedProjectPath, setDraggedProjectPath] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // Add-project picker state.
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
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  // Sessions another omp process holds (other omp-web instance / terminal).
  // Badge-only: they never enter runningSessionIds, so unread markers and
  // notifications keep meaning "a run THIS instance started".
  const [elsewhereSessions, setElsewhereSessions] = useState<Map<string, ElsewhereSessionInfo>>(() => new Map());
  const [runningSessionCwds, setRunningSessionCwds] = useState<Record<string, string>>({});
  const [exitedSessions, setExitedSessions] = useState<Map<string, ExitedRpcSession>>(() => new Map());
  const knownRunningCwdsRef = useRef<Map<string, string>>(new Map());
  const { limit: recentRunsLimit } = useRecentRunsLimit();
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const [recentCompletedRuns, setRecentCompletedRuns] = useState<RecentRunEntry[]>(() => loadRecentRuns());
  const effectiveRecentCompletedSet = useMemo(() => {
    const timestampMap = new Map<string, number>();

    // 1. Live and persisted recent completed runs
    for (const r of recentCompletedRuns) {
      if (!runningSessionIds.has(r.sessionId)) {
        timestampMap.set(r.sessionId, r.completedAt);
      }
    }

    // 2. On-disk active sessions (fallback & recency backfill)
    for (const s of allSessions) {
      if (runningSessionIds.has(s.id)) continue;
      const isValid = (s.firstMessage && s.firstMessage !== "(no messages)") || s.messageCount > 0 || Boolean(s.name);
      if (!isValid) continue;
      const ts = new Date(s.modified).getTime();
      const existing = timestampMap.get(s.id);
      if (existing === undefined || ts > existing) {
        timestampMap.set(s.id, ts);
      }
    }

    // Sort by latest timestamp descending, pick top dynamic limit
    const sorted = [...timestampMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, recentRunsLimit);

    return new Set(sorted.map(([id]) => id));
  }, [recentCompletedRuns, allSessions, runningSessionIds, recentRunsLimit]);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Relative session times must age while the sidebar stays open; one shared
  // minute clock avoids a timer per session row.
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  // Client-side workspace/session filtering (Workspaces header controls).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Workspace sort (per browser). Pins apply only while a sort is active.
  // The sidebar is server-rendered: start at "none" and read storage after mount.
  const [projectSortMode, setProjectSortMode] = useState<ProjectSortMode>("none");
  useEffect(() => setProjectSortMode(loadProjectSortMode()), []);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const closeSortMenu = useCallback(() => setSortMenuOpen(false), []);
  const pinsActive = projectSortMode !== "none";

  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionsEtagRef = useRef<string | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  // Set once the first /api/sessions fetch settles (success OR failure) so the
  // initial-restore effect can stop waiting on a load that never yields rows.
  const initialLoadedRef = useRef(false);
  const loadSessions = useCallback(async (showLoading = false) => {
    sessionsAbortRef.current?.abort();
    const controller = new AbortController();
    sessionsAbortRef.current = controller;
    // A wedged-but-listening server (the long-idle failure mode) accepts the
    // TCP connection and never answers: without a deadline the fetch pends
    // forever and the sidebar shows its initial spinner indefinitely. Abort
    // with a TimeoutError so the catch surfaces an error and the
    // visibility/online recovery below can retry later.
    const timeout = setTimeout(() => controller.abort(new DOMException("Session list request timed out", "TimeoutError")), SESSIONS_FETCH_TIMEOUT_MS);
    try {
      if (showLoading) setLoading(true);
      const headers: Record<string, string> = {};
      if (sessionsEtagRef.current) headers["If-None-Match"] = sessionsEtagRef.current;
      const res = await fetch("/api/sessions", { headers, signal: controller.signal });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get("ETag");
      if (etag) sessionsEtagRef.current = etag;
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; runningSessions?: Array<{ id: string; cwd: string }>; elsewhereSessions?: ElsewhereSessionInfo[] };
      setAllSessions(data.sessions);
      // Same rule as the running set below: once an SSE frame has delivered an
      // ownership snapshot, the stream owns it. A GET that was already in
      // flight can be older than that frame, and applying it would drop the
      // foreign-session badges until the next frame.
      if (!sseAuthoritativeRef.current) {
        setElsewhereSessions(new Map((data.elsewhereSessions ?? []).map((entry) => [entry.id, entry])));
      }
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
      clearTimeout(timeout);
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
  useEffect(() => {
    saveRecentRuns(recentCompletedRuns, undefined, recentRunsLimit);
  }, [recentCompletedRuns, recentRunsLimit]);

  useEffect(() => {
    if (allSessions.length === 0) return;
    setRecentCompletedRuns((prev) => {
      const seeded = seedRecentRuns(allSessions, recentRunsLimit);
      if (prev.length === 0) return seeded;
      const newestPrev = Math.max(...prev.map((p) => p.completedAt), 0);
      const newestSeeded = Math.max(...seeded.map((s) => s.completedAt), 0);
      if (newestSeeded > newestPrev) {
        return seeded;
      }
      return prev;
    });
  }, [allSessions, recentRunsLimit]);


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
    // Live running status and session-list invalidations arrive on the shared
    // event stream; the sidebar never has to poll while an agent is working.
    const source = openEventStream({ kind: "running" });

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          runningSessionIds?: string[];
          runningSessions?: Array<{ id: string; cwd: string }>;
          exitedSessions?: ExitedRpcSession[];
          elsewhereSessions?: ElsewhereSessionInfo[];
          refreshSessionList?: boolean;
          sessionIds?: string[];
        };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          setElsewhereSessions(new Map((data.elsewhereSessions ?? []).map((entry) => [entry.id, entry])));
          setExitedSessions(new Map((data.exitedSessions ?? []).map((session) => [session.id, session])));
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
      // The stream reconnects on its own; until a fresh frame arrives, let the
      // polled /api/sessions fallback own running state again.
      sseAuthoritativeRef.current = false;
    };
    return () => {
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
      source.close();
    };
  }, [loadSessions, scheduleRefresh]);
  // Long-idle recovery: while the tab is hidden the SSE connection can die
  // (laptop sleep, network change, tab freeze) and its EventSource reconnect
  // carries no list invalidation. Refresh whenever the user actually comes
  // back or the network returns, so the list is never left stale/empty.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadSessions(false);
    };
    const onOnline = () => void loadSessions(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [loadSessions]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const allCompleted = [...previous].filter((id) => !runningSessionIds.has(id));
    const completedInBackground = allCompleted.filter((id) => id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (allCompleted.length > 0 || newlyRunning.length > 0) {
      setRecentCompletedRuns((prev) => {
        let updated = prev;
        if (newlyRunning.length > 0) {
          updated = removeActiveFromCompleted(updated, runningSessionIds);
        }
        for (const id of allCompleted) {
          updated = recordCompletedRun(updated, id, undefined, recentRunsLimit);
        }
        return updated;
      });
    }

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
  }, [runningSessionIds, selectedSessionId, loadSessions, recentRunsLimit]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);


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
    // A withdrawn command must not swallow the next one: without this reset,
    // re-commanding a cwd the sidebar already synced (A -> sidebar B -> A)
    // stays stuck on B.
    if (!selectedCwdProp) {
      lastSyncedCwdPropRef.current = null;
      return;
    }
    if (selectedCwdProp !== lastSyncedCwdPropRef.current) {
      provisionalSelectionRef.current = false;
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
  const storeWorktreeState = useCallback((requestedCwd: string, d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
    if (d.error || !d.projectRoot) {
      // This cwd is not a Git repo (or the lookup failed) — the workspace
      // should show no branch/worktrees. Other repos' cached state is left
      // intact: a non-Git workspace never inherits another repo's branch, and
      // we never discard previously-visited repos' Git state.
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
  }, []);
  useLayoutEffect(() => {
    if (!selectedCwd) return;
    let cancelled = false;
    const requestedCwd = selectedCwd;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(requestedCwd)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) storeWorktreeState(requestedCwd, d); })
      .catch(() => { /* leave any cached state; refetch on demand */ });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey, storeWorktreeState]);

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
    const visibleLiveIds = new Set(runningSessionIds);
    for (const id of exitedSessions.keys()) visibleLiveIds.add(id);
    for (const id of visibleLiveIds) {
      if (known.has(id)) continue;
      let ts = placeholderTsRef.current.get(id);
      if (!ts) {
        ts = new Date().toISOString();
        placeholderTsRef.current.set(id, ts);
      }
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? exitedSessions.get(id)?.cwd
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
    // Prune timestamps and known cwds for ids that are now materialized or no longer live.
    if (placeholderTsRef.current.size > placeholders.length) {
      for (const key of [...placeholderTsRef.current.keys()]) {
        if (!visibleLiveIds.has(key) || known.has(key)) placeholderTsRef.current.delete(key);
      }
    }
    if (knownRunningCwdsRef.current.size > visibleLiveIds.size + (optimisticSession ? 1 : 0)) {
      if (optimisticSession) visibleLiveIds.add(optimisticSession.id);
      for (const key of [...knownRunningCwdsRef.current.keys()]) {
        if (!visibleLiveIds.has(key) && known.has(key)) knownRunningCwdsRef.current.delete(key);
      }
    }
    return placeholders.length ? [...base, ...placeholders] : base;
  }, [allSessions, optimisticSession, optimisticProjectRoot, runningSessionIds, runningSessionCwds, exitedSessions, projectRootFor, selectedCwd]);
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
    const visibleLiveIds = new Set(runningSessionIds);
    for (const id of exitedSessions.keys()) visibleLiveIds.add(id);
    for (const id of visibleLiveIds) {
      if (allSessions.some((s) => s.id === id)) continue;
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? exitedSessions.get(id)?.cwd
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
  }, [optimisticProjectRoot, projects, runningSessionIds, runningSessionCwds, exitedSessions, allSessions, optimisticSession, projectRootFor, selectedCwd]);

  // ---- Derived project list ---------------------------------------------------
  const selectedProject = useMemo(() => projectRootFor(selectedCwd), [projectRootFor, selectedCwd]);
  // While a fresh optimistic/placeholder is pending (JSONL not yet on disk),
  // freeze ordering so the new project row does not flicker optimistic ->
  // confirmed position. New projects are allowed to append at the end. A
  // user ordering action (sort mode, pin, manual order) ends the freeze, and
  // frozen rows still show the fresh project data.
  const hasPendingNewSession = Boolean(
    optimisticSession
    || [...runningSessionIds, ...exitedSessions.keys()].some((id) => !allSessions.some((session) => session.id === id)),
  );
  // Only "Last updated" reads sessions; other modes must not re-sort on every session refresh.
  const orderingSessions = projectSortMode === "updated" ? visibleSessions : NO_SESSIONS;
  const sortedProjectsBase = useMemo(
    () => orderProjects(visibleProjects, projectSortMode, orderingSessions, (project) => project.alias ?? projectLabel(project.path)),
    [visibleProjects, projectSortMode, orderingSessions],
  );
  const orderingKey = useMemo(
    () => [projectSortMode, ...projects.map((p) => `${p.path}\t${p.sortOrder ?? ""}\t${p.pinOrder ?? ""}`)].join("\n"),
    [projectSortMode, projects],
  );
  const sortedProjectsRef = useRef<{ key: string; list: ManagedProject[] } | null>(null);
  const sortedProjects = useMemo(() => {
    const prev = sortedProjectsRef.current;
    if (hasPendingNewSession && prev && prev.key === orderingKey) {
      const fresh = new Map(sortedProjectsBase.map((p) => [comparableProjectPath(p.path), p]));
      const next = prev.list.map((p) => fresh.get(comparableProjectPath(p.path)) ?? p);
      const prevKeys = new Set(prev.list.map((p) => comparableProjectPath(p.path)));
      for (const p of sortedProjectsBase) if (!prevKeys.has(comparableProjectPath(p.path))) next.push(p);
      return next;
    }
    return sortedProjectsBase;
  }, [sortedProjectsBase, hasPendingNewSession, orderingKey]);
  // Snapshot only committed orders; render work React discards must not leak into the freeze.
  useEffect(() => {
    const prev = sortedProjectsRef.current;
    if (!hasPendingNewSession || !prev || prev.key !== orderingKey) {
      sortedProjectsRef.current = { key: orderingKey, list: sortedProjectsBase };
    }
  }, [hasPendingNewSession, orderingKey, sortedProjectsBase]);
  useEffect(() => {
    onWorkspaceOptionsChange?.(sortedProjects, selectedProject, selectedCwd);
  }, [onWorkspaceOptionsChange, sortedProjects, selectedProject, selectedCwd]);
  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sortedProjects, visibleSessions),
    [sortedProjects, visibleSessions],
  );
  // "Running" for the sidebar = a run this instance owns (spinner, unread,
  // notifications) plus a run another omp process holds (badge/filter). The two
  // stay separate in state; only the aggregate views merge them.
  const liveOrElsewhereIds = useMemo(() => {
    if (elsewhereSessions.size === 0) return runningSessionIds;
    const next = new Set(runningSessionIds);
    for (const [id, info] of elsewhereSessions) {
      if (info.running) next.add(id);
    }
    return next;
  }, [runningSessionIds, elsewhereSessions]);
  const projectActivity = useMemo(
    () => projectActivityCounts(visibleSessions, liveOrElsewhereIds, unreadSessionIds, exitedSessions.keys()),
    [visibleSessions, liveOrElsewhereIds, unreadSessionIds, exitedSessions],
  );

  // Client-side filtering (Workspaces header: search + "running only").
  // While a filter is active, workspaces with no matching sessions are hidden
  // so the list reads as a genuine result set; at rest every workspace stays.
  // Deferred search: typing stays responsive (input updates immediately) while the heavy
  // visibleProjectEntries filter runs at lower priority. Combines with the 200ms ETag loadSessions
  // debounce already in place — keystrokes never block the main thread on large session lists.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const trimmedSearchQuery = deferredSearchQuery.trim();
  const filtersActive = searchOpen || runningOnly || trimmedSearchQuery.length > 0;
  // Transcript matches stream from the server; title matches are scored locally
  // so results appear on the first keystroke and never wait on a full scan.
  // Stop (or a new query) aborts the stream; hits found so far stay.
  const [transcriptSearch, setTranscriptSearch] = useState<{ query: string; scores: Record<string, number>; status: "running" | "done" | "stopped" } | null>(null);
  const transcriptSearchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!trimmedSearchQuery) return;
    const query = trimmedSearchQuery;
    const controller = new AbortController();
    transcriptSearchAbortRef.current = controller;
    // A newer query (or closing the search) aborts too, but is not a user Stop.
    let superseded = false;
    const timer = setTimeout(async () => {
      setTranscriptSearch({ query, scores: {}, status: "running" });
      let status: "done" | "stopped" = "stopped";
      // Each merge re-ranks every session; merge streamed batches at most every 200ms.
      let pending: Record<string, number> = {};
      let lastFlush = 0;
      const flush = () => {
        if (Object.keys(pending).length === 0) return;
        const batch = pending;
        pending = {};
        lastFlush = Date.now();
        setTranscriptSearch((prev) => (prev?.query === query ? { ...prev, scores: { ...prev.scores, ...batch } } : prev));
      };
      try {
        const res = await fetch(`/api/sessions/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            const parsed: unknown = line ? JSON.parse(line) : null;
            if (!parsed || typeof parsed !== "object" || !("scores" in parsed) || !parsed.scores || typeof parsed.scores !== "object") continue;
            for (const [id, score] of Object.entries(parsed.scores)) if (typeof score === "number") pending[id] = score;
          }
          if (Date.now() - lastFlush >= 200) flush();
        }
        status = "done";
      } catch {
        // Stopped, superseded or failed: the title matches and hits so far stay.
      }
      if (superseded) return;
      flush();
      setTranscriptSearch((prev) => (prev?.query === query ? { ...prev, status } : prev));
    }, 250);
    return () => {
      superseded = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedSearchQuery]);
  const currentTranscriptSearch = transcriptSearch?.query === trimmedSearchQuery ? transcriptSearch : null;
  const visibleProjectEntries = useMemo(() => {
    const query = compileSearchQuery(trimmedSearchQuery);
    const serverScores = currentTranscriptSearch?.scores;
    const entries: { project: ManagedProject; sessions: SessionInfo[]; scores?: Map<string, number>; rank: number }[] = [];
    for (const project of sortedProjects) {
      let list = sessionsByProject.get(project.path) ?? [];
      if (runningOnly) list = list.filter((s) => runningSessionIds.has(s.id) || effectiveRecentCompletedSet.has(s.id) || liveOrElsewhereIds.has(s.id));
      if (!query) {
        if (list.length === 0 && runningOnly) continue;
        entries.push({ project, sessions: list, rank: 0 });
        continue;
      }
      const scores = new Map<string, number>();
      for (const s of list) {
        // Server scores cover the same title fields plus the transcript; a
        // session newer than the server's answer falls back to its title.
        const score = serverScores?.[s.id]
          ?? scoreSearchFields([searchField(s.name ?? "", TITLE_WEIGHT), searchField(s.firstMessage, FIRST_MESSAGE_WEIGHT)], query);
        if (score !== null) scores.set(s.id, score);
      }
      list = list.filter((s) => scores.has(s.id));
      // Label/alias-only matches surface as empty workspaces; without this
      // a custom workspace name would be unfindable by search.
      const labelScore = scoreSearchFields([searchField(projectLabel(project.path), TITLE_WEIGHT), searchField(project.alias ?? "", TITLE_WEIGHT)], query);
      if (list.length === 0 && (runningOnly || labelScore === null)) continue;
      entries.push({ project, sessions: list, scores, rank: Math.max(labelScore ?? 0, ...scores.values()) });
    }
    // Best match first; ties keep the workspace order (stable sort).
    if (query) entries.sort((a, b) => b.rank - a.rank);
    return entries;
  }, [sortedProjects, sessionsByProject, runningOnly, trimmedSearchQuery, currentTranscriptSearch, runningSessionIds, effectiveRecentCompletedSet, liveOrElsewhereIds]);

  const treesByProject = useMemo(() => {
    const m = new Map<string, ReturnType<typeof buildSessionTree>>();
    for (const { project, sessions, scores } of visibleProjectEntries) m.set(project.path, buildSessionTree(sessions, scores));
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
  }, [addProjectBusy, loadProjects, expandProject, setAddProjectOpen]);

  const handleUpdateProjectPresentation = useCallback(async (projectPath: string, updates: { alias?: string | null; sortOrder?: number | null; pinOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }) => {
    try {
      const response = await fetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectPath, ...updates }) });
      if (!response.ok) throw new Error(t("projects.updateFailed"));
      await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [loadProjects, t]);

  /** Projects Move up/down and drag can reorder: all of them in manual mode,
   *  only the pinned ones while a sort is active (the rest follow the sort). */
  const reorderableProjects = useMemo(
    () => (pinsActive ? sortedProjects.filter((project) => project.pinOrder !== undefined) : sortedProjects),
    [pinsActive, sortedProjects],
  );

  // One ordering write (reorder or pin) at a time: each computes its payload
  // from the list on screen, which is stale until the previous write reloads it.
  const orderWriteBusyRef = useRef(false);

  /** Persist one whole-list order as a single atomic batched PATCH. */
  const persistProjectOrder = useCallback(async (next: ManagedProject[]) => {
    if (orderWriteBusyRef.current) return;
    orderWriteBusyRef.current = true;
    try {
      // One batched request: the server applies every entry in a single
      // atomic registry save, so per-project writes can't interleave and lose
      // updates. Discovered projects included here are registered server-side.
      const response = await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: next.map((project, index) => ({ cwd: project.path, ...(pinsActive ? { pinOrder: index } : { sortOrder: index }) })) }),
      });
      if (!response.ok) throw new Error(t("projects.reorderFailed"));
      await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      orderWriteBusyRef.current = false;
    }
  }, [loadProjects, pinsActive, t]);

  const handleProjectDrop = useCallback(async (targetPath: string) => {
    const sourcePath = draggedProjectPath;
    setDraggedProjectPath(null);
    if (!sourcePath || sourcePath === targetPath) return;
    const next = [...reorderableProjects];
    const from = next.findIndex((project) => project.path === sourcePath);
    const to = next.findIndex((project) => project.path === targetPath);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    await persistProjectOrder(next);
  }, [draggedProjectPath, reorderableProjects, persistProjectOrder]);

  /** Keyboard-accessible reorder: move one project up/down the list. */
  const handleMoveProject = useCallback(async (projectPath: string, delta: -1 | 1) => {
    const next = [...reorderableProjects];
    const index = next.findIndex((project) => project.path === projectPath);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    await persistProjectOrder(next);
  }, [reorderableProjects, persistProjectOrder]);

  /** Pin to the end of the pinned group, or unpin. */
  const handleTogglePin = useCallback(async (project: ManagedProject) => {
    if (orderWriteBusyRef.current) return;
    orderWriteBusyRef.current = true;
    const pinOrder = project.pinOrder !== undefined ? null : nextPinOrder(sortedProjects);
    try {
      await handleUpdateProjectPresentation(project.path, { pinOrder });
    } catch {
      // handleUpdateProjectPresentation already toasted the failure.
    } finally {
      orderWriteBusyRef.current = false;
    }
  }, [sortedProjects, handleUpdateProjectPresentation]);

  // The menu closes itself on a menu item click and returns focus to the trigger.
  const chooseProjectSortMode = useCallback((mode: ProjectSortMode) => {
    setProjectSortMode(mode);
    saveProjectSortMode(mode);
  }, []);

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

  // Create/remove operate against the active repo's own cached Git state —
  // never a globally stored path, so the branch lands in the correct repo.
  // Failures reject with a user-facing message for the Worktrees tab to show.
  const handleCreateWorktree = useCallback(async (branch: string) => {
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!activeState) return;
    const root = activeState.projectRoot;
    const res = await fetch("/api/worktrees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: root, branch }),
    });
    const data = await res.json().catch(() => ({})) as { path?: string; error?: string; code?: string };
    if (!res.ok || data.error || !data.path) {
      throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
    }
    const newWorktreePath: string = data.path;
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
  }, [selectedProject, worktreeStateByProject, loadProjects, loadSessions]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean): Promise<"removed" | "dirty"> => {
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!activeState) return "removed";
    const root = activeState.projectRoot;
    const res = await fetch("/api/worktrees", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: root, path, force }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean; code?: string };
    if (!res.ok) {
      // Dirty worktree — the caller asks the user to confirm a force removal.
      if (data.dirty && !force) return "dirty";
      throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
    }
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
    return "removed";
  }, [selectedProject, worktreeStateByProject, selectedCwd, loadProjects, loadSessions]);

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

  const showWorktreeSwitcher = Boolean(
    activeGitState?.isGit
    && activeGitState.isTopLevel
    && selectedCwd
    && selectedProject !== null
    // Case-folded: the active project may be spelled differently than the
    // server-resolved git root (Windows/NTFS), yet still be the same repo.
    && comparableProjectPath(selectedProject) === comparableProjectPath(activeGitState.projectRoot),
  );
  // The file panel's Worktrees tab renders the ACTIVE repo's own worktrees
  // only; non-Git / subdirectory workspaces get null (no Git affordance).
  const worktreeContext = useMemo<WorktreeContext | null>(() => {
    if (!showWorktreeSwitcher || !activeGitState) return null;
    const foldedCwd = comparableProjectPath(selectedCwd ?? "");
    const current = activeGitState.worktrees.find((w) => comparableProjectPath(w.path) === foldedCwd)
      ?? activeGitState.worktrees.find((w) => w.isMain);
    return {
      projectRoot: activeGitState.projectRoot,
      worktrees: activeGitState.worktrees,
      currentPath: current?.path ?? activeGitState.projectRoot,
      select: setSelectedCwd,
      create: handleCreateWorktree,
      remove: handleRemoveWorktree,
    };
  }, [showWorktreeSwitcher, activeGitState, selectedCwd, handleCreateWorktree, handleRemoveWorktree]);
  useEffect(() => {
    onWorktreeContextChange?.(worktreeContext);
  }, [onWorktreeContextChange, worktreeContext]);

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

  return (
    <div className="sidebar-shell" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
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
            toast.info(t("sessionSidebar.launchConfigSaved"));
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
          <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title={t("appShell.hideSidebar")}
                aria-label={t("appShell.hideSidebar")}
                className="shell-toolbar-btn ui-focus-ring"
              >
                <X size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <OmpWebTitle />
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            {navigation && (
              <span className="sidebar-nav-buttons">
                <Tooltip content={`${t("sessionSidebar.navigateBack")} (${navigation.backShortcut})`} side="bottom">
                  <SidebarIconButton
                    label={t("sessionSidebar.navigateBack")}
                    onClick={navigation.onBack}
                    disabled={!navigation.canBack}
                  >
                    <ArrowLeft size={15} strokeWidth={1.9} aria-hidden="true" />
                  </SidebarIconButton>
                </Tooltip>
                <Tooltip content={`${t("sessionSidebar.navigateForward")} (${navigation.forwardShortcut})`} side="bottom">
                  <SidebarIconButton
                    label={t("sessionSidebar.navigateForward")}
                    onClick={navigation.onForward}
                    disabled={!navigation.canForward}
                  >
                    <ArrowRight size={15} strokeWidth={1.9} aria-hidden="true" />
                  </SidebarIconButton>
                </Tooltip>
              </span>
            )}
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
            borderRadius: "var(--radius-control)",
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

      {/* Workspaces section header: label + search / sort / filter / add */}
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
          ref={sortButtonRef}
          label={t("projects.sort")}
          active={pinsActive || sortMenuOpen}
          menuExpanded={sortMenuOpen}
          onClick={() => setSortMenuOpen((open) => !open)}
        >
          <ArrowDownUp size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarPortalMenu anchor={sortButtonRef} open={sortMenuOpen} onClose={closeSortMenu} placement="below" minWidth={150}>
          {([
            ["none", t("projects.sortNone")],
            ["alphabetical", t("projects.sortAlphabetical")],
            ["updated", t("projects.sortUpdated")],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={projectSortMode === mode}
              className="sidebar-menu-item"
              onClick={() => chooseProjectSortMode(mode)}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}
            >
              <Check size={12} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, visibility: projectSortMode === mode ? "visible" : "hidden" }} />
              {label}
            </button>
          ))}
        </SidebarPortalMenu>
        <SidebarIconButton
          label={t("sessionSidebar.filterRunning")}
          title={t("sessionSidebar.filterRunningTitle", { count: recentRunsLimit })}
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
            className="sidebar-session-search"
            ref={searchInputRef}
            value={searchQuery}
            maxLength={500}
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
          {currentTranscriptSearch && currentTranscriptSearch.status !== "done" && (
            <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.35 }}>
              {currentTranscriptSearch.status === "running" && <Loader2 size={11} strokeWidth={2} className="animate-spin" style={{ flexShrink: 0 }} aria-hidden="true" />}
              <span style={{ flex: 1, minWidth: 0 }}>
                {t(currentTranscriptSearch.status === "running" ? "sessionSidebar.searchingTranscripts" : "sessionSidebar.searchStopped")}
              </span>
              {currentTranscriptSearch.status === "running" && (
                <button
                  type="button"
                  onClick={() => transcriptSearchAbortRef.current?.abort()}
                  style={{ flexShrink: 0, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
                >
                  {t("sessionSidebar.stopSearch")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Workspaces */}
        <div
          style={{
            flex: "1 1 auto",
            overflowY: "auto",
            padding: "2px 10px 10px",
            minHeight: 80,
          }}
        >
          {loading && (
            <div role="status" aria-live="polite" aria-label={t("sessionSidebar.loading")} style={{ display: "grid", gap: 10, padding: "10px 4px" }}>
              <div aria-hidden="true" className="skeleton" style={{ width: "78%", height: 18 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "92%", height: 30 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "86%", height: 30 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "68%", height: 30 }} />
            </div>
          )}
          {projectsError && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>
              <span>{projectsError}</span>
              <button className="load-retry-button" type="button" onClick={() => { loadSessions(false); void loadProjects(); }} style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("sessionSidebar.refresh")}</button>
            </div>
          )}
          {error && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>
              <span>{error}</span>
              <button className="load-retry-button" type="button" onClick={() => { loadSessions(false); void loadProjects(); }} style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("sessionSidebar.refresh")}</button>
            </div>
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
                runningElsewhere={elsewhereSessions}
                unreadSessionIds={unreadSessionIds}
                exitedSessions={exitedSessions}
                recentlyCompletedIds={effectiveRecentCompletedSet}
                relativeTimeNow={relativeTimeNow}
                onActivate={activateProject}
                onToggleExpand={toggleProjectExpanded}
                onRemoveProject={handleRemoveProject}
                onEditLaunchConfig={setLaunchConfigProject}
                onUpdatePresentation={handleUpdateProjectPresentation}
                onDragPathChange={setDraggedProjectPath}
                onDropProject={(path) => void handleProjectDrop(path)}
                onMoveProject={(path, delta) => void handleMoveProject(path, delta)}
                pinnable={pinsActive}
                onTogglePin={handleTogglePin}
                isDragTarget={draggedProjectPath !== null && draggedProjectPath !== project.path && (!pinsActive || project.pinOrder !== undefined)}
                removeBusy={removeProjectPath === project.path}
                onSelectSession={handleSelectSessionFromList}
                onRenamed={loadSessions}
                onSessionDeleted={handleSessionDeleted}
              />
            );
          })}
        </div>

      {/* Provider usage bar — pinned above Settings */}
      {usageVisible && <ProviderUsageBar />}
      {/* Pinned footer: Settings */}
      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          className="sidebar-settings-row"
          data-active={settingsOpen}
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
            background: settingsOpen ? "var(--bg-selected)" : "none",
            border: "none",
            color: settingsOpen ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = settingsOpen ? "var(--bg-selected)" : "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = settingsOpen ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = settingsOpen ? "var(--text)" : "var(--text-muted)"; }}
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







