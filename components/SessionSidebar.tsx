"use client";

import { memo, useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, useDeferredValue, type CSSProperties, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { clearLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { groupSessionsByProject, projectActivityCounts, sortManagedProjects } from "@/lib/project-ordering";
import { comparableProjectPath } from "@/lib/comparable-path";
import { Archive, Check, ChevronDown, ChevronRight, FileUp, Folder, GitBranch, MoreHorizontal, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import { publishSessionsChanged } from "@/lib/session-change-bus";

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

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}

/** Normalize a repository/project path for use as a Git-state map key. The
 *  same physical repo may be reached via different path spellings (forward /
 *  back slashes, drive-letter casing); folding them makes distinct spellings
 *  resolve to one shared Git context, while genuinely different repos stay
 *  separate. */
function normalizeProjectKey(value: string): string {
  // Clip trailing separators and unify separators. Fold case when the path is
  // Windows-style (drive-letter rooted or backslash-y) so Drive:\ vs C:\ and
  // path casing variants map to the same repository, while preserving
  // case-sensitivity for POSIX paths (client has no process.platform).
  const isWindowsPath = /^[a-zA-Z]:/.test(value) || value.includes("\\");
  const normalized = value.replace(/[\/]+$/, "").replace(/\\/g, "/");
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

// Bounded retry window for restoring a brand-new session from its URL before
// omp flushes the JSONL (typically appears within a second or two of the
// first prompt, so 8 × 1s covers it without hanging a dead link forever).
const INITIAL_RESTORE_RETRY_MS = 1000;
const INITIAL_RESTORE_MAX_ATTEMPTS = 8;

const UNREAD_SESSIONS_STORAGE_KEY = "omp-web:unread-session-ids";

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

const EXPANDED_PROJECTS_STORAGE_KEY = "omp-web:expanded-projects";

/** Shared empty set for the no-stored-expansion default (never mutated). */
const EMPTY_PROJECT_SET: ReadonlySet<string> = new Set();

/** Persisted expanded-project paths. Returns null when nothing was stored —
 *  the sidebar then defaults to expanding only the active project. */
function loadExpandedProjects(): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((path): path is string => typeof path === "string" && path.length > 0));
    }
    return null;
  } catch {
    return null;
  }
}

function saveExpandedProjects(paths: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/** Final folder name of a project path, portable across / and \ separators. */
function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

function formatRelativeTime(value: string, _locale: string, now: number): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

const SIDEBAR_BUTTON_TRANSITION = "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)";

/** Quiet square icon button used across the sidebar chrome (header, section
 *  headers, footer). Stays visually subdued; the accent appears on hover and
 *  when active (e.g. an applied filter). */
function SidebarIconButton({
  label,
  title,
  onClick,
  active = false,
  disabled = false,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, flexShrink: 0, lineHeight: 0,
        background: active || hovered ? "var(--bg-hover)" : "none",
        border: "none",
        borderRadius: "var(--radius-control)",
        color: active ? "var(--accent)" : hovered ? "var(--accent)" : "var(--text-dim)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: SIDEBAR_BUTTON_TRANSITION,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  );
}

const MENU_MARGIN = 5;
const MENU_VIEWPORT_PAD = 8;

/**
 * Overflow menu rendered through a portal to document.body so it always
 * floats above every sidebar row: it is never clipped by the workspace list's
 * overflow and never covered by sibling stacking contexts (each workspace
 * section isolates its own context). Positioned from the anchor button's
 * viewport rect, flips to the other side of the anchor when there is no room,
 * follows the anchor while the sidebar scrolls, and closes on outside press
 * or Escape.
 */
function SidebarPortalMenu({
  anchor,
  open,
  onClose,
  placement = "below",
  align = "end",
  minWidth = 136,
  style,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: "below" | "above";
  /** "end" right-aligns to the anchor, "start" left-aligns to it. */
  align?: "start" | "end";
  minWidth?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Refs are passed as arguments so the callback stays dependency-clean
  // (no ref.current access inside) for the React Compiler.
  const computePos = useCallback((el: HTMLElement | null, menu: HTMLDivElement | null) => {
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let top: number;
    if (placement === "above") {
      top = r.top - height - MENU_MARGIN;
      if (top < MENU_VIEWPORT_PAD) {
        top = Math.min(r.bottom + MENU_MARGIN, window.innerHeight - height - MENU_VIEWPORT_PAD);
      }
    } else {
      top = r.bottom + MENU_MARGIN;
      if (top + height > window.innerHeight - MENU_VIEWPORT_PAD) {
        top = r.top - height - MENU_MARGIN;
      }
    }
    if (top < MENU_VIEWPORT_PAD) top = MENU_VIEWPORT_PAD;
    const left = align === "start"
      ? Math.max(MENU_VIEWPORT_PAD, Math.min(r.left, window.innerWidth - width - MENU_VIEWPORT_PAD))
      : Math.max(MENU_VIEWPORT_PAD, Math.min(r.right - width, window.innerWidth - width - MENU_VIEWPORT_PAD));
    setPos({ top, left });
  }, [placement, align]);

  // Measure on open: the portal is mounted during commit, so the menu's own
  // size is available synchronously in the layout effect.
  useLayoutEffect(() => {
    if (!open) return;
    computePos(anchor.current, menuRef.current);
  }, [open, computePos, anchor]);

  // Reposition while open — the sidebar is resizable and the list scrolls.
  useEffect(() => {
    if (!open) return;
    const update = () => computePos(anchor.current, menuRef.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, computePos, anchor]);

  // Close on outside press / Escape and handle keyboard arrow navigation.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const firstBtn = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
      firstBtn?.focus();
    }, 0);
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        anchor.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
        if (buttons.length === 0) return;
        const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = e.key === "ArrowDown"
          ? (currentIndex + 1) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, anchor]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        visibility: pos ? "visible" : "hidden",
        zIndex: 1000,
        minWidth,
        padding: 4,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-panel)",
        boxShadow: "var(--shadow-pop)",
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean, reducedMotion: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running || reducedMotion) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running, reducedMotion]);

  return display;
}

function OmpWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrambleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const target = showVersion ? `v${process.env.NEXT_PUBLIC_OMP_WEB_VERSION ?? "0.0.0"}` : "omp web";
  const display = useScramble(target, scrambling, reducedMotion);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
    if (reducedMotion) return;
    setScrambling(true);
    scrambleTimerRef.current = setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, [reducedMotion]);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
  }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        fontWeight: 700, fontSize: 14, letterSpacing: "-0.01em",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
        lineHeight: 1,
      }}
      title={showVersion ? "Show ompweb name" : "Show ompweb version"}
    >
      {!scrambling && !showVersion ? (
        <>
          <span style={{ color: "var(--accent)" }}>omp</span>
          <span style={{ color: "var(--text)" }}>web</span>
        </>
      ) : (
        <span style={{ color: showVersion ? "var(--accent)" : "var(--text)" }}>{display}</span>
      )}
    </button>
  );
}
export function SessionSidebar({ selectedSessionId, optimisticSession, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onExplorerRefresh, explorerRefreshing, onExplorerRefreshDone, onAtMention, onAtMentions, onOpenSettings, onOpenArchive, updateAvailable }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  // Managed + session-discovered projects (server-merged, hidden excluded).
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // Add-project picker state.
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectBusy, setAddProjectBusy] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  // Per-project expansion, persisted to localStorage (null = nothing stored).
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(() => loadExpandedProjects());
  // Project currently being removed (hide) — serializes remove requests.
  const [removeProjectPath, setRemoveProjectPath] = useState<string | null>(null);
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
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Relative session times must age while the sidebar stays open; one shared
  // minute clock avoids a timer per session row.
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
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
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
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
      if (showLoading) setLoading(false);
    }
  }, [t]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { projects?: ManagedProject[] };
      setProjects(data.projects ?? []);
      setProjectsError(null);
      projectsLoadedRef.current = true;
    } catch (e) {
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

  useEffect(() => {
    // Live running status and session-list invalidations arrive via SSE; the
    // sidebar never has to poll while an agent is working.
    const source = new EventSource("/api/agent/running/events");

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          runningSessionIds?: string[];
          refreshSessionList?: boolean;
          sessionIds?: string[];
        };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          if (data.refreshSessionList) scheduleRefresh();
        } else if (data.type === "sessions-changed") {
          if (data.refreshSessionList) scheduleRefresh();
          publishSessionsChanged(data.sessionIds ?? []);
        }
      } catch {
        // ignore malformed frames
      }
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
    // Any path in a cached repo's worktree list belongs to that repo — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    for (const state of Object.values(worktreeStateByProject)) {
      if (state.worktrees.some((w) => normalizeProjectKey(w.path) === normalizeProjectKey(cwd))) {
        return state.projectRoot;
      }
    }
    // A registered project path is its own canonical root. The lookup goes
    // through the case-folded comparable form (Windows/NTFS is
    // case-insensitive, so a session's cwd/projectRoot can spell the same
    // folder with different casing), and the registered path itself is
    // returned so the caller gets a canonical value.
    const registered = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cwd));
    if (registered) return registered.path;
    const foldedCwd = comparableProjectPath(cwd);
    const match = allSessions.find((s) => comparableProjectPath(s.cwd) === foldedCwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeStateByProject, allSessions, projects]);

  // ---- Expansion (used by the sync/notify effects below, so declared first) --
  const expandProject = useCallback((path: string) => {
    setExpandedProjects((prev) => {
      if (prev?.has(path)) return prev;
      const next = new Set(prev ?? []);
      next.add(path);
      return next;
    });
  }, []);

  const collapseProject = useCallback((path: string) => {
    setExpandedProjects((prev) => {
      if (!prev?.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const toggleProjectExpanded = useCallback((path: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
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
      const phRoot = optimisticProjectRoot ?? selectedCwd ?? "";
      const phKey = phRoot ? comparableProjectPath(phRoot) : undefined;
      placeholders.push({
        id,
        path: "",
        cwd: selectedCwd ?? "",
        name: undefined,
        created: ts,
        modified: ts,
        messageCount: 1,
        firstMessage: "",
        projectRoot: phRoot,
        ...(phKey ? { projectKey: phKey } : {}),
      });
    }
    // Prune timestamps for ids that are now materialized or no longer running
    if (placeholderTsRef.current.size > placeholders.length) {
      for (const key of [...placeholderTsRef.current.keys()]) {
        if (!runningSessionIds.has(key) || known.has(key)) placeholderTsRef.current.delete(key);
      }
    }
    return placeholders.length ? [...base, ...placeholders] : base;
  }, [allSessions, optimisticSession, optimisticProjectRoot, runningSessionIds, selectedCwd]);
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
      const phPath = optimisticProjectRoot ?? selectedCwd ?? "";
      if (phPath && !knownFolded.has(comparableProjectPath(phPath))) {
        base = [...base, { path: phPath }];
        knownFolded.add(comparableProjectPath(phPath));
      }
    }
    return base;
  }, [optimisticProjectRoot, projects, runningSessionIds, allSessions, selectedCwd]);

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
        const labelLower = projectLabel(project.path).toLowerCase();
        list = list.filter((s) => (s.name ?? "").toLowerCase().includes(q) || s.firstMessage.toLowerCase().includes(q));
        if (list.length === 0 && !labelLower.includes(q)) continue;
      }
      if (list.length === 0 && (runningOnly || q)) continue;
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
    const known = new Set(sortedProjects.map((p) => p.path));
    const stale = [...expandedProjects].filter((path) => !known.has(path));
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
      if (allSessions.length === 0) return; // wait for sessions to load
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        restoreRetryRef.current = 0;
        restoredRef.current = true;
        setSelectedCwd(target.cwd);
        expandProject(workspaceKeyOf(target));
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

  const commitAddProject = useCallback(async (candidate?: string) => {
    const path = (candidate ?? "").trim();
    if (!path || addProjectBusy) return;

    setAddProjectBusy(true);
    setAddProjectError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
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
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, selectedProject, worktreeStateByProject]);

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
      if (selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path)) setSelectedCwd(root);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [selectedProject, worktreeStateByProject, wtBusy, selectedCwd]);

  // Reset the worktree dropdown's transient state (used by the portaled
  // dropdown's outside-press/Escape close and by the branch toggle).
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
    expandProject(workspaceKeyOf(s));
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

  // Sessions of every worktree in the selected project are shown together
  const expandedProjectPaths = expandedProjects ?? EMPTY_PROJECT_SET;

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
    setWtDropdownOpen((v) => !v);
  }, []);

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
        setWtDropdownOpen(false);
        setWtError(null);
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
          onSelect={(path) => void commitAddProject(path)}
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
          style={{
            flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto",
            transition: "flex var(--dur-med) var(--ease-out-warm)",
            overflowY: "auto",
            padding: "2px 10px 10px",
            minHeight: 80,
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
                isExpanded={expandedProjectPaths.has(project.path)}
                activity={projectActivity.get(comparableProjectPath(project.path))}
                tree={tree}
                hiddenCount={filtersActive ? 0 : Math.max(0, tree.length - MAX_PROJECT_SESSIONS)}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                unreadSessionIds={unreadSessionIds}
                relativeTimeNow={relativeTimeNow}
                onActivate={activateProject}
                onToggleExpand={toggleProjectExpanded}
                onRemoveProject={handleRemoveProject}
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

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
            transition: "flex var(--dur-med) var(--ease-out-warm)",
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
}

const MAX_PROJECT_SESSIONS = 5;

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
  const label = projectLabel(project.path);
  const hasActivity = Boolean(activity && (activity.running > 0 || activity.unread > 0));
  const visibleRoots = hiddenCount > 0 && !showAllSessions
    ? tree.slice(0, MAX_PROJECT_SESSIONS)
    : tree;
  const showActions = hovered || focusWithin || actionMenuOpen;

  return (
    <section className="sidebar-project" data-active={isActive ? "true" : "false"} style={{ marginBottom: 12 }}>
      <div
        className="sidebar-project-header"
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
        }}
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
            <button type="button" role="menuitem" className="sidebar-menu-item" disabled={removeBusy} onClick={() => { setActionMenuOpen(false); onRemoveProject(project.path); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: removeBusy ? "default" : "pointer", textAlign: "left", fontSize: 11 }}>
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
              const isCurrent = wt.path === selectedCwd || (wt.isMain && !worktreeState.worktrees.some((w) => w.path === selectedCwd));
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
function RunningSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <span
      title={t("sessionSidebar.agentRunning")}
      aria-label={t("sessionSidebar.agentRunningAria")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <span
        aria-hidden="true"
        className="sidebar-running-spinner"
        data-reduced-motion={reducedMotion ? "true" : "false"}
        style={{ width: size - 2, height: size - 2 }}
      />
    </span>
  );
}

function UnreadSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <span
      title={t("sessionSidebar.newActivity")}
      aria-label={t("sessionSidebar.newSessionActivity")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        {!reducedMotion && (
          <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
            <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
    </span>
  );
}

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
              <div aria-hidden={showActions} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, width: "100%", whiteSpace: "nowrap", opacity: showActions ? 0 : 1, pointerEvents: showActions ? "none" : "auto", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>
                {isRunning && <RunningSessionIndicator size={12} />}
                {!isRunning && isUnread && <UnreadSessionIndicator size={11} />}
                {relativeTime && <span title={new Date(session.modified).toLocaleString(locale)} style={{ minWidth: 42, whiteSpace: "nowrap", textAlign: "right", color: isSelected ? "var(--accent)" : "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{relativeTime}</span>}
              </div>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", opacity: showActions ? 1 : 0, pointerEvents: showActions ? "auto" : "none", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>
                <button type="button" ref={menuButtonRef} className="session-item-icon-button" onClick={(event) => { event.stopPropagation(); setActionMenuOpen((open) => !open); }} title={t("projects.actions")} aria-label={t("projects.actions")} aria-expanded={actionMenuOpen} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, lineHeight: 0, border: "none", borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: actionMenuOpen ? "var(--text)" : "var(--text-dim)", cursor: "pointer" }}>
                  <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <SidebarPortalMenu anchor={menuButtonRef} open={actionMenuOpen} onClose={() => setActionMenuOpen(false)} placement="above" minWidth={128}>
 <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); setConfirmArchive(true); }} disabled={hasChildren} title={hasChildren ? t("sessionSidebar.archiveLeafOnly") : t("sessionSidebar.archive")} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: hasChildren ? "var(--text-dim)" : "var(--text-muted)", cursor: hasChildren ? "not-allowed" : "pointer", textAlign: "left", fontSize: 11, opacity: hasChildren ? 0.55 : 1 }}>{t("sessionSidebar.archive")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { startRename(event); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.rename")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); setConfirmDelete(true); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.delete")}</button>
                </SidebarPortalMenu>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
