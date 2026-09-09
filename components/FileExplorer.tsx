"use client";

import { forwardRef, memo, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  AtSign,
  Check,
  ChevronRight,
  CircleAlert,
  CircleMinus,
  Download,
  Folder,
  FolderOpen,
  Loader2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { Tooltip } from "./ui/primitives";
import { translate, useI18n } from "@/lib/i18n";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { MAX_RESULT_LIMIT, type FileIndexEntry } from "@/lib/file-fuzzy";
import { buildSearchRows } from "@/lib/search-results";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}


interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  onRefreshDone?: () => void;
  fileSearchOpen?: boolean;
  onFileSearchOpenChange?: (open: boolean) => void;
  /** Absolute path of the file open in the right panel — rendered selected. */
  activeFilePath?: string | null;
  /** Absolute path to expand, highlight, and scroll into view (one-shot). */
  revealPath?: string | null;
  onRevealDone?: () => void;
  /** Reports the git changed-file count so the explorer header can badge it. */
  onGitStatusChange?: (changedCount: number, isRepo: boolean) => void;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
  collapseAll: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = translate("fileExplorer.loadFailed", { status: res.status });
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(translate("fileExplorer.gitStatusFailed", { status: res.status }));
  return res.json() as Promise<GitStatusResponse>;
}

export const GIT_STATUS_LABEL_KEYS: Record<GitFileStatusKind, string> = {
  modified: "fileExplorer.gitModified",
  added: "fileExplorer.gitAdded",
  deleted: "fileExplorer.gitDeleted",
  renamed: "fileExplorer.gitRenamed",
  untracked: "fileExplorer.gitUntracked",
  conflict: "fileExplorer.gitConflict",
};

export const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "var(--status-modified)",
  added: "var(--status-success)",
  deleted: "var(--status-error)",
  renamed: "var(--status-renamed)",
  untracked: "var(--status-success)",
  conflict: "var(--status-error)",
};

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error(translate("fileExplorer.uploadNetworkError")));
    xhr.onabort = () => reject(new Error(translate("fileExplorer.uploadCancelled")));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 24, height: 24, padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, border: "none",
        borderRadius: "var(--radius-control)",
        background: "none",
        color: "var(--text-dim)",
        cursor: "pointer",
        transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <X size={13} strokeWidth={2.2} aria-hidden="true" />
    </button>
  );
}

// Fixed row geometry: every tree row is exactly this tall, so the visible
// window is pure arithmetic (no measuring). The empty-directory placeholder
// shares the height — a second geometry would break the scroll math.
const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 8;

type FlatRow =
  | { kind: "node"; node: FileNode; depth: number; secondaryLabel?: string }
  | { kind: "empty"; key: string; depth: number };

function flattenVisibleRows(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  childrenByPath: Map<string, FileNode[]>,
  depth: number,
  out: FlatRow[],
): FlatRow[] {
  for (const node of nodes) {
    out.push({ kind: "node", node, depth });
    if (node.isDir && expandedPaths.has(node.fullPath)) {
      const children = childrenByPath.get(node.fullPath);
      if (children) {
        if (children.length === 0) {
          out.push({ kind: "empty", key: node.fullPath, depth: depth + 1 });
        } else {
          flattenVisibleRows(children, expandedPaths, childrenByPath, depth + 1, out);
        }
      }
    }
  }
  return out;
}

interface ExplorerRowProps {
  row: FlatRow;
  index: number;
  rowCount: number;
  cwd: string;
  open: boolean;
  loading: boolean;
  highlighted: boolean;
  isActiveFile: boolean;
  focused: boolean;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onActivate: (node: FileNode, index: number) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>, node: FileNode, index: number) => void;
  onFocusRow: (index: number) => void;
}

// Memoized: the parent re-renders on every scroll tick, but a row only
// re-renders when its own props change. Without this, scrolling a 30k-row
// tree reconciles the whole window per frame instead of the shifted edges.
const ExplorerRow = memo(function ExplorerRow({
  row,
  index,
  rowCount,
  cwd,
  open,
  loading,
  highlighted,
  isActiveFile,
  focused,
  gitStatusByPath,
  changedDirectoryPaths,
  onAtMention,
  onActivate,
  onKeyDown,
  onFocusRow,
}: ExplorerRowProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);

  if (row.kind === "empty") {
    return (
      <div
        style={{ paddingLeft: 8 + row.depth * 14, fontSize: 11, color: "var(--text-dim)", height: ROW_HEIGHT, display: "flex", alignItems: "center" }}
      >
        {t("fileExplorer.emptyDir")}
      </div>
    );
  }

  const { node, secondaryLabel } = row;
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const mentionLabel = t("fileExplorer.insertPathIntoChat");
  const downloadLabel = t("fileExplorer.downloadFile");

  return (
    <div
      onClick={() => onActivate(node, index)}
      onKeyDown={(e) => onKeyDown(e, node, index)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocusRow(index); }}
      role="treeitem"
      tabIndex={focused ? 0 : -1}
      data-index={index}
      data-file-path={node.fullPath}
      aria-selected={highlighted || isActiveFile}
      aria-current={isActiveFile ? "true" : undefined}
      aria-expanded={node.isDir ? open : undefined}
      aria-level={row.depth + 1}
      aria-setsize={rowCount}
      aria-posinset={index + 1}
      // Search rows repeat names such as route.ts, so the directory has to be
      // part of the accessible name, not just the dimmed text beside it.
      aria-label={node.isDir
        ? (node.name + " (folder" + (open ? ", expanded" : ", collapsed") + ")")
        : (secondaryLabel ? (node.name + " (file, " + secondaryLabel + ")") : (node.name + " (file)"))}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8 + row.depth * 14,
        paddingRight: 8,
        height: ROW_HEIGHT,
        cursor: "pointer",
        background: isActiveFile ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: "var(--radius-control)",
        userSelect: "none",
        boxShadow: focused ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent)" : isActiveFile ? "inset 2px 0 0 var(--accent)" : "none",
        outline: "none",
        transition: `background var(--dur-fast) var(--ease-out-warm)`,
      }}
    >
      {node.isDir && (
        <ChevronRight
          size={10}
          strokeWidth={2}
          color="var(--text-dim)"
          style={{
            flexShrink: 0,
            transform: open ? "rotate(90deg)" : "none",
            transition: `transform var(--dur-med) var(--ease-out-warm)`,
          }}
          aria-hidden="true"
        />
      )}
      {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: node.isDir ? "var(--text-muted)" : "var(--text-dim)" }}>
        {node.isDir ? (
          open ? <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" /> : <Folder size={14} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          getFileIcon(node.name, 14)
        )}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          // The name is the answer the user is looking for, so the directory
          // gives up width first.
          flex: secondaryLabel ? "0 0 auto" : 1,
          maxWidth: secondaryLabel ? "72%" : undefined,
        }}
        title={node.fullPath}
      >
        {node.name}
      </span>
      {secondaryLabel && (
        // Search rows are flat, so the directory is the only context a row has.
        <span
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            fontSize: 11,
            color: "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
            textAlign: "left",
          }}
          title={node.fullPath}
        >
          {secondaryLabel}
        </span>
      )}
      {highlighted && (
        <span
          title={t("fileExplorer.newlyUploaded")}
          aria-label={t("fileExplorer.newlyUploaded")}
          style={{ width: 6, height: 6, flexShrink: 0, borderRadius: "50%", background: "var(--accent)" }}
        />
      )}
      {!hovered && !node.isDir && gitStatus && (
        <span
          title={t(GIT_STATUS_LABEL_KEYS[gitStatus.status])}
          aria-label={t(GIT_STATUS_LABEL_KEYS[gitStatus.status])}
          style={{
            width: 14,
            flexShrink: 0,
            color: GIT_STATUS_COLORS[gitStatus.status],
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          {gitStatus.code}
        </span>
      )}
      {!hovered && containsGitChanges && (
        <span
          title={t("fileExplorer.containsChangedFiles")}
          aria-label={t("fileExplorer.containsChangedFiles")}
          style={{
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: "50%",
            background: "var(--status-modified)",
          }}
        />
      )}
      {loading && (
        <Loader2 size={10} strokeWidth={2} color="var(--text-dim)" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true" />
      )}
      {onAtMention && hovered && (
        <Tooltip content={mentionLabel}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            aria-label={mentionLabel}
            style={{
              position: "absolute",
              right: !node.isDir ? 28 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
            }}
          >
            <AtSign size={11} strokeWidth={2.2} aria-hidden="true" />
            {t("fileExplorer.mention")}
          </button>
        </Tooltip>
      )}
      {hovered && !node.isDir && (
        <Tooltip content={downloadLabel}>
          <a
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            aria-label={downloadLabel}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
              transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
            }}
          >
            <Download size={11} strokeWidth={2.2} aria-hidden="true" />
          </a>
        </Tooltip>
      )}
    </div>
  );
});

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  onRefreshDone,
  fileSearchOpen = false,
  onFileSearchOpenChange,
  activeFilePath = null,
  revealPath = null,
  onRevealDone,
  onGitStatusChange,
}, ref) {
  const { t, tn } = useI18n();
  // Directory listings keyed by absolute path. The tree renders from a flat
  // projection of this map, so 30k visible rows cost one array walk — never
  // 30k mounted components.
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingPathsRef = useRef<Set<string>>(new Set());
  const rootRequestRef = useRef(0);
  const expandedPathsRef = useRef<Set<string>>(new Set());
  expandedPathsRef.current = expandedPaths;
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  // Which refresh the search request has already answered; re-baselined every
  // time the panel opens.
  const consumedRefreshTokenRef = useRef<string | null>(null);
  const uploadBusy = uploadPhase !== "idle";
  const searchActive = fileSearchOpen && searchQuery.trim().length > 0;

  // Opening the panel focuses the input; closing it resets the whole search,
  // mirroring how the session search behaves.
  useEffect(() => {
    if (fileSearchOpen) {
      // Baseline for forced refreshes: only a refresh after the panel opened
      // counts. The sidebar bumps the explorer key once on mount, and nobody
      // asked for that one.
      consumedRefreshTokenRef.current = refreshToken;
      searchInputRef.current?.focus();
      return;
    }
    setSearchQuery("");
    setSearchPaths([]);
    setSearchTruncated(false);
    setSearchLoading(false);
    setSearchFailed(false);
    // refreshToken is read as the value at open time on purpose: adding it to
    // the deps would re-baseline on every refresh and swallow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSearchOpen]);

  // Debounced query against the same cached, bounded file index that backs
  // the @ mention autocomplete. No second index.
  useEffect(() => {
    if (!fileSearchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchPaths([]);
      setSearchTruncated(false);
      setSearchLoading(false);
      setSearchFailed(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchFailed(false);
    const timer = setTimeout(() => {
      // Only a real refresh bypasses the index cache; typing must not force a
      // fresh listing on every keystroke.
      const requestedToken = refreshToken;
      const forceRefresh = consumedRefreshTokenRef.current !== requestedToken;
      const params = new URLSearchParams({
        cwd,
        q: query,
        limit: String(MAX_RESULT_LIMIT),
        // The panel lists files, so directories must be dropped before the
        // limit is applied, not after.
        kind: "file",
      });
      if (forceRefresh) params.set("refresh", "1");
      fetch(`/api/file-index?${params.toString()}`, { signal: controller.signal })
        .then((res) => res.ok
          ? res.json() as Promise<{ matches?: FileIndexEntry[]; truncated?: boolean }>
          : Promise.reject(new Error(`HTTP ${res.status}`)))
        .then((data) => {
          if (controller.signal.aborted) return;
          // Acknowledge the refresh only now: a failed or aborted request must
          // leave it pending so the next one still asks for a fresh listing.
          consumedRefreshTokenRef.current = requestedToken;
          setSearchPaths((data.matches ?? []).map((m) => m.path));
          setSearchTruncated(Boolean(data.truncated));
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchPaths([]);
            setSearchTruncated(false);
            setSearchFailed(true);
          }
        })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
    // refreshToken participates so the toolbar refresh button and a finished
    // upload re-run the visible query against a freshly built listing.
  }, [cwd, fileSearchOpen, searchQuery, refreshToken]);

  // Rows stay in the order the index ranked them, so the closest name matches
  // sit at the top. Folding them into a directory tree would re-sort them
  // alphabetically and push, say, AGENTS.md below every app/api/agent/… file
  // that only matched on its parent directory.
  const searchRows = useMemo(() => buildSearchRows(searchPaths).map((row) => ({
    ...row,
    node: {
      name: row.name,
      fullPath: joinFilePath(cwd, row.path),
      isDir: false,
      size: 0,
      loaded: true,
    } satisfies FileNode,
  })), [cwd, searchPaths]);

  const searchFlatRows: FlatRow[] = useMemo(() => searchRows.map((row) => ({
    kind: "node",
    node: row.node,
    depth: 0,
    secondaryLabel: row.directory,
  })), [searchRows]);

  const roots = useMemo(() => childrenByPath.get(cwd) ?? [], [childrenByPath, cwd]);
  const rows: FlatRow[] = useMemo(() => {
    if (searchActive) return searchFlatRows;
    return flattenVisibleRows(roots, expandedPaths, childrenByPath, 0, []);
  }, [searchActive, searchFlatRows, roots, expandedPaths, childrenByPath]);
  const rowsRef = useRef<FlatRow[]>([]);
  rowsRef.current = rows;
  const focusedIndexRef = useRef(0);
  focusedIndexRef.current = focusedIndex;

  const normalizedActiveFilePath = activeFilePath ? normalizeFilePathSlashes(activeFilePath) : null;
  const totalListHeight = rows.length * ROW_HEIGHT;
  const windowStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const windowEnd = Math.min(
    rows.length,
    Math.ceil((scrollTop + (viewportHeight || ROW_HEIGHT)) / ROW_HEIGHT) + OVERSCAN_ROWS,
  );

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      if (prev.has(fullPath) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);
  // Single fetch path for every directory in the flat map. The ref guards
  // against duplicate in-flight requests; the state copy drives spinners.
  const fetchDir = useCallback((dirPath: string) => {
    if (loadingPathsRef.current.has(dirPath)) return Promise.resolve();
    loadingPathsRef.current.add(dirPath);
    setLoadingPaths((prev) => new Set(prev).add(dirPath));
    return fetchEntries(dirPath)
      .then((entries) => {
        setChildrenByPath((prev) => {
          const next = new Map(prev);
          next.set(dirPath, entries);
          return next;
        });
        if (dirPath === cwd) setError(null);
      })
      .catch((e) => {
        if (dirPath === cwd) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        loadingPathsRef.current.delete(dirPath);
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      });
  }, [cwd]);

  // Scroll the virtual window so a row is visible, then focus it. The focus
  // retries across frames: the scroll triggers an async window re-render and
  // the row element may not exist on the first frame.
  const goToRow = useCallback((index: number) => {
    const list = rowsRef.current;
    if (index < 0 || index >= list.length || list[index].kind !== "node") return;
    setFocusedIndex(index);
    const container = scrollRef.current;
    if (container) {
      const top = index * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      const nextTop = top < container.scrollTop
        ? top
        : bottom > container.scrollTop + container.clientHeight
          ? bottom - container.clientHeight
          : container.scrollTop;
      if (nextTop !== container.scrollTop) {
        container.scrollTop = nextTop;
        setScrollTop(nextTop);
      }
    }
    const attemptFocus = (triesLeft: number) => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        return;
      }
      if (triesLeft > 0) requestAnimationFrame(() => attemptFocus(triesLeft - 1));
    };
    requestAnimationFrame(() => attemptFocus(5));
  }, []);

  const handleActivateRow = useCallback((node: FileNode, index: number) => {
    setFocusedIndex(index);
    if (node.isDir) {
      setExpandedPaths((prev) => {
        if (prev.has(node.fullPath)) {
          const next = new Set(prev);
          next.delete(node.fullPath);
          return next;
        }
        return new Set(prev).add(node.fullPath);
      });
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [onOpenFile]);

  const handleRowKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, node: FileNode, index: number) => {
    if (event.target !== event.currentTarget) return;
    const list = rowsRef.current;
    const row = list[index];
    const depth = row && row.kind === "node" ? row.depth : 0;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleActivateRow(node, index);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      let next = index + delta;
      while (next >= 0 && next < list.length && list[next].kind !== "node") next += delta;
      if (next >= 0 && next < list.length) goToRow(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = list.findIndex((r) => r.kind === "node");
      if (first >= 0) goToRow(first);
    } else if (event.key === "End") {
      event.preventDefault();
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].kind === "node") {
          goToRow(i);
          break;
        }
      }
    } else if (event.key === "ArrowRight") {
      if (!node.isDir) return;
      event.preventDefault();
      if (!expandedPathsRef.current.has(node.fullPath)) {
        handleToggleExpanded(node.fullPath, true);
      } else if (index + 1 < list.length) {
        // Flat order guarantees the first child (or its empty placeholder)
        // follows its parent.
        goToRow(index + 1);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.isDir && expandedPathsRef.current.has(node.fullPath)) {
        handleToggleExpanded(node.fullPath, false);
      } else {
        // The parent row always precedes its children in flat order.
        for (let i = index - 1; i >= 0; i -= 1) {
          const candidate = list[i];
          if (candidate.kind === "node" && candidate.depth === depth - 1) {
            goToRow(i);
            break;
          }
        }
      }
    }
  }, [goToRow, handleActivateRow, handleToggleExpanded]);

  const handleTreeScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);
  }, []);

  // Track the viewport height so the window math stays correct across panel
  // resizes; rows themselves are fixed-height and never measured.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (scrollRef.current) setViewportHeight(scrollRef.current.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep keyboard focus on a real row when collapsing shrinks the list.
  useEffect(() => {
    setFocusedIndex((prev) => Math.min(prev, Math.max(0, rowsRef.current.length - 1)));
  }, [rows.length]);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(cwd, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? translate("fileExplorer.uploadFailed", { status }));
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? translate("fileExplorer.uploadCheckFailed", { status: res.status }));

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
    collapseAll() {
      setExpandedPaths(new Set());
    },
  }), [uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  // Keep the refresh-done callback in a ref so its identity cannot re-trigger
  // the fetch effect below (AppShell re-renders on every session boundary).
  const onRefreshDoneRef = useRef(onRefreshDone);
  onRefreshDoneRef.current = onRefreshDone;

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setChildrenByPath(new Map());
      loadingPathsRef.current = new Set();
      setLoadingPaths(new Set());
      setFocusedIndex(0);
      setScrollTop(0);
    }

    setLoading(cwdChanged);
    setError(null);
    // Refresh re-reads the root plus every expanded directory so renames and
    // deletions surface; the expand effect below covers newly opened ones.
    // expandedPaths is read via ref: depending on the state would re-fire
    // this effect on every expand and refetch the world each time.
    // Settle the root request explicitly: only cwd fetches drive the
    // full-list loading state and the toolbar spinner's done signal.
    const requestId = ++rootRequestRef.current;
    void fetchDir(cwd).finally(() => {
      if (rootRequestRef.current !== requestId) return;
      setLoading(false);
      onRefreshDoneRef.current?.();
    });
    if (!cwdChanged) {
      for (const path of expandedPathsRef.current) fetchDir(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, refreshKey, treeRefreshKey]);

  // Fetch any expanded directory that has no listing yet. Clicks, keyboard,
  // and reveal all funnel through expandedPaths, so this single effect covers
  // every expansion path — including levels that mount while a reveal
  // ancestor chain is still loading.
  useEffect(() => {
    for (const path of expandedPaths) {
      if (!childrenByPath.has(path)) fetchDir(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedPaths, childrenByPath, cwd]);

  const [isGitRepo, setIsGitRepo] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (cancelled) return;
        setGitFiles(status.isGitRepository ? status.files : []);
        setIsGitRepo(status.isGitRepository);
      })
      .catch(() => {
        if (cancelled) return;
        setGitFiles([]);
        setIsGitRepo(false);
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onGitStatusChange?.(gitFiles.length, isGitRepo);
  }, [gitFiles, isGitRepo, onGitStatusChange]);

  // One-shot reveal from the file panel: expand every ancestor directory of
  // the target, highlight the row, and scroll the virtual window to it. The
  // effect re-runs as ancestor listings resolve (rows identity changes), so
  // deep chains settle level by level; it gives up once every ancestor is
  // loaded but the target still isn't listed.
  useEffect(() => {
    if (!revealPath) return;
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    const normalizedTarget = normalizeFilePathSlashes(revealPath);
    if (normalizedTarget !== normalizedCwd && !normalizedTarget.startsWith(`${normalizedCwd}/`)) {
      onRevealDone?.();
      return;
    }
    const relative = normalizedTarget.slice(normalizedCwd.length + 1);
    const segments = relative.split("/").filter(Boolean);
    setExpandedPaths((prev) => {
      // Return the previous set when nothing changes: a fresh identity would
      // recompute rows, refire this effect, and loop until reveal clears.
      let changed = false;
      const next = new Set(prev);
      let prefix = normalizedCwd;
      for (let i = 0; i < segments.length - 1; i += 1) {
        prefix = `${prefix}/${segments[i]}`;
        for (const spelling of [prefix, joinFilePath(cwd, segments.slice(0, i + 1).join("/"))]) {
          if (!next.has(spelling)) {
            next.add(spelling);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
    setHighlightedPaths((prev) => {
      if (prev.has(revealPath)) return prev;
      return new Set(prev).add(revealPath);
    });
    const targetIndex = rows.findIndex(
      (row) => row.kind === "node" && normalizeFilePathSlashes(row.node.fullPath) === normalizedTarget,
    );
    if (targetIndex >= 0) {
      goToRow(targetIndex);
      onRevealDone?.();
      return;
    }
    const ancestorsLoaded = segments.slice(0, -1).every((_, level) => {
      const ancestor = joinFilePath(cwd, segments.slice(0, level + 1).join("/"));
      return childrenByPath.has(ancestor)
        || childrenByPath.has(`${normalizedCwd}/${segments.slice(0, level + 1).join("/")}`);
    });
    if (ancestorsLoaded) onRevealDone?.();
  }, [cwd, revealPath, onRevealDone, rows, childrenByPath, goToRow]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  // The tree shell always mounts (role=tree is a structural contract); only
  // the inner content swaps between state messages and the virtual window.
  // The window itself mounts ~60 rows no matter how far the user scrolls.
  const treeRows = (
    <div style={{ height: totalListHeight, position: "relative" }}>
        {rows.slice(windowStart, windowEnd).map((row, offset) => {
          const index = windowStart + offset;
          if (row.kind !== "node") {
            return (
              <div
                key={`empty:${row.key}`}
                style={{ position: "absolute", top: index * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}
              >
                <ExplorerRow
                  row={row}
                  index={index}
                  rowCount={rows.length}
                  cwd={cwd}
                  open={false}
                  loading={false}
                  highlighted={false}
                  isActiveFile={false}
                  focused={false}
                  gitStatusByPath={gitStatusByPath}
                  changedDirectoryPaths={changedDirectoryPaths}
                  onAtMention={onAtMention}
                  onActivate={handleActivateRow}
                  onKeyDown={handleRowKeyDown}
                  onFocusRow={setFocusedIndex}
                />
              </div>
            );
          }
          const { node } = row;
          return (
            <div
              key={node.fullPath}
              style={{ position: "absolute", top: index * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}
            >
              <ExplorerRow
                row={row}
                index={index}
                rowCount={rows.length}
                cwd={cwd}
                open={node.isDir && expandedPaths.has(node.fullPath)}
                loading={loadingPaths.has(node.fullPath)}
                highlighted={highlightedPaths.has(node.fullPath)}
                isActiveFile={!node.isDir && normalizedActiveFilePath === normalizeFilePathSlashes(node.fullPath)}
                focused={index === focusedIndex}
                gitStatusByPath={gitStatusByPath}
                changedDirectoryPaths={changedDirectoryPaths}
                onAtMention={onAtMention}
                onActivate={handleActivateRow}
                onKeyDown={handleRowKeyDown}
                onFocusRow={setFocusedIndex}
              />
            </div>
          );
        })}
      </div>
  );
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {/* Pinned: the result list scrolls, so an un-sticky box leaves you
          unable to edit the query that produced it. */}
      {fileSearchOpen && (
        <div style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          background: "var(--bg-panel)",
          padding: "6px 8px 4px",
        }}>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              // Arm the loading state in the same batch as the query: the
              // debounce effect only runs after paint, so the first keystroke
              // would otherwise show "No matching files" for a frame.
              setSearchQuery(e.target.value);
              setSearchLoading(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onFileSearchOpenChange?.(false);
              }
            }}
            placeholder={t("fileExplorer.searchPlaceholder")}
            aria-label={t("fileExplorer.searchFiles")}
            style={{
              width: "100%",
              height: 27,
              boxSizing: "border-box",
              padding: searchQuery ? "0 26px 0 9px" : "0 9px",
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
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                searchInputRef.current?.focus();
              }}
              title={t("fileExplorer.clearSearch")}
              aria-label={t("fileExplorer.clearSearch")}
              style={{
                position: "absolute",
                right: 12,
                top: "50%",
                transform: "translateY(calc(-50% + 1px))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                padding: 0,
                border: "none",
                borderRadius: "var(--radius-control)",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                transition: `color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)`,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <X size={11} strokeWidth={2.4} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("fileExplorer.checkingFiles") : t("fileExplorer.uploadingPercent", { percent: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <Loader2 size={13} strokeWidth={2.2} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
              ) : (
                <Upload size={13} strokeWidth={2} aria-hidden="true" />
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--accent)", transition: `width var(--dur-fast) var(--ease-out-warm)` }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, var(--status-warning) 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, var(--status-warning) 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {tn("fileExplorer.filesAlreadyExist", pendingConflict.conflicts.length, { files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "var(--status-warning)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("fileExplorer.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={{ height: 24, minHeight: 24, padding: "0 8px", border: "1px solid var(--status-error)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--status-error)", cursor: "pointer", fontSize: 11 }}>
                {t("fileExplorer.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={{ height: 24, minHeight: 24, padding: "0 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}>
                {t("fileExplorer.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 24, minHeight: 24, padding: "0 8px", border: "none", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
                {t("fileExplorer.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "var(--status-error)" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("fileExplorer.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={t("fileExplorer.uploadedCount", { count: uploadSummary.uploaded.length })} aria-label={t("fileExplorer.uploadedCount", { count: uploadSummary.uploaded.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--status-success)" }}>
                    <Check size={13} strokeWidth={2.4} aria-hidden="true" />
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={t("fileExplorer.skippedCount", { count: uploadSummary.skipped.length })} aria-label={t("fileExplorer.skippedCount", { count: uploadSummary.skipped.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <CircleMinus size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={t("fileExplorer.failedCount", { count: uploadSummary.errors.length })} aria-label={t("fileExplorer.failedCount", { count: uploadSummary.errors.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--status-error)" }}>
                    <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <Tooltip content={uploadSummary.uploaded.length === 1 ? t("fileExplorer.addUploadedFile") : t("fileExplorer.addAllUploadedFiles")}>
                  <button
                    type="button"
                    onClick={addUploadedFilesToChat}
                    aria-label={uploadSummary.uploaded.length === 1 ? t("fileExplorer.addUploadedFile") : t("fileExplorer.addAllUploadedFiles")}
                    style={{
                      height: 22, padding: "0 7px",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                      flexShrink: 0,
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)",
                      background: "var(--bg-panel)",
                      color: "var(--accent)",
                      cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                      transition: `background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)`,
                    }}
                  >
                    <AtSign size={11} strokeWidth={2.2} aria-hidden="true" />
                    {t("fileExplorer.mention")}
                  </button>
                </Tooltip>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("fileExplorer.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "var(--status-error)" }}>
                <CircleAlert size={11} strokeWidth={2} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      <div
        ref={scrollRef}
        role="tree"
        aria-label={t("sessionSidebar.explorer")}
        onScroll={handleTreeScroll}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "2px 4px", outline: "none" }}
      >
        {searchActive ? (
          searchLoading ? (
            <div role="status" style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.searching")}</div>
          ) : searchFailed ? (
            <div role="alert" style={{ padding: "8px 12px", fontSize: 11, color: "var(--status-error)" }}>{t("fileExplorer.searchFailed")}</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.noMatchingFiles")}</div>
          ) : (
            treeRows
          )
        ) : loading ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.loadingFiles")}</div>
        ) : error ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--status-error)" }}>{error}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            {t("fileExplorer.noFilesFound")}
          </div>
        ) : (
          treeRows
        )}
      </div>
      {searchActive && !searchLoading && !searchFailed && rows.length > 0 && searchTruncated && (
        // Without this the list looks complete, and a broad query in a
        // large repo silently hides everything past the cap.
        <div style={{ padding: "6px 12px 8px", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
          {t("fileExplorer.searchTruncated", { count: searchRows.length })}
        </div>
      )}
    </div>
  );
});
