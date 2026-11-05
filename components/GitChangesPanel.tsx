"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AtSign, Check, ChevronRight, ExternalLink, GitBranch, RefreshCw, Search, X } from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { DiffView } from "./FileViewer";
import { GIT_STATUS_COLORS, GIT_STATUS_LABEL_KEYS } from "./FileExplorer";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import {
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitCollapseReason, GitFileDiffResponse, GitFileStatus, GitStatusResponse } from "@/lib/git-types";

const COLLAPSE_REASON_LABEL_KEYS: Record<GitCollapseReason, string> = {
  generated: "gitChanges.reasonGenerated",
  vendored: "gitChanges.reasonVendored",
  documentation: "gitChanges.reasonDocumentation",
  "no-diff": "gitChanges.reasonNoDiff",
};

interface Props {
  cwd: string;
  hostId: string;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onRefreshDone?: () => void;
}

async function fetchStatus(cwd: string, hostId: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd, hostId });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
    throw new Error(formatApiError({ ...body, error: body.error ?? translate("gitChanges.loadFailed", { status: res.status }) }));
  }
  return res.json() as Promise<GitStatusResponse>;
}

async function fetchPatch(cwd: string, filePath: string, hostId: string): Promise<GitFileDiffResponse> {
  const params = new URLSearchParams({ cwd, path: filePath, hostId });
  const res = await fetch(`/api/git/diff?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
    throw new Error(formatApiError({ ...body, error: body.error ?? translate("gitChanges.diffLoadFailed", { status: res.status }) }));
  }
  return res.json() as Promise<GitFileDiffResponse>;
}

export function GitChangesPanel({ cwd, hostId, refreshKey, onOpenFile, onAtMention, onRefreshDone }: Props) {
  const { t, tn } = useI18n();
  const [files, setFiles] = useState<GitStatusResponse["files"]>([]);
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchSupported, setPatchSupported] = useState(true);
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [showAttributeFiles, setShowAttributeFiles] = useState(false);
  const attributeListId = useId();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const patchRequestRef = useRef(0);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;

  // Keep the refresh-done callback in a ref so its identity cannot re-trigger
  // the fetch effect below (AppShell re-renders on every session boundary).
  const onRefreshDoneRef = useRef(onRefreshDone);
  onRefreshDoneRef.current = onRefreshDone;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchStatus(cwd, hostId)
      .then((status) => {
        if (cancelled) return;
        const nextFiles = status.isGitRepository ? status.files : [];
        setFiles(nextFiles);
        setIsRepo(status.isGitRepository);
        // Keep the selection when it still exists; otherwise preview the first
        // reviewable change (not one .gitattributes marks generated/docs/-diff)
        // so the diff pane is never blank behind a file list.
        setSelectedPath((prev) =>
          prev && nextFiles.some((f) => f.filePath === prev)
            ? prev
            : (nextFiles.find((f) => !f.collapseReason) ?? nextFiles[0])?.filePath ?? null,
        );
        // Nothing else to review: open the group so the previewed file is visible.
        if (nextFiles.length > 0 && nextFiles.every((f) => f.collapseReason)) setShowAttributeFiles(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setFiles([]);
        setIsRepo(false);
        setSelectedPath(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        onRefreshDoneRef.current?.();
      });
    return () => { cancelled = true; };
  }, [cwd, hostId, refreshToken]);

  useEffect(() => {
    if (!selectedPath) {
      setPatch(null);
      setPatchSupported(true);
      setPatchError(null);
      return;
    }
    const requestId = ++patchRequestRef.current;
    setPatchLoading(true);
    setPatchError(null);
    fetchPatch(cwd, selectedPath, hostId)
      .then((diff) => {
        if (requestId !== patchRequestRef.current) return;
        setPatchSupported(diff.supported);
        setPatch(typeof diff.patch === "string" ? diff.patch : null);
      })
      .catch((e) => {
        if (requestId !== patchRequestRef.current) return;
        setPatch(null);
        setPatchSupported(true);
        setPatchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (requestId === patchRequestRef.current) setPatchLoading(false);
      });
    return () => { patchRequestRef.current = requestId + 1; };
  }, [cwd, hostId, selectedPath, refreshToken]);

  const [primaryFiles, attributeFiles] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matching = q
      ? files.filter((f) => normalizeFilePathSlashes(getRelativeFilePath(f.filePath, cwd)).toLowerCase().includes(q))
      : files;
    return [matching.filter((f) => !f.collapseReason), matching.filter((f) => f.collapseReason)];
  }, [files, filter, cwd]);

  const selectedFile = selectedPath ? files.find((f) => f.filePath === selectedPath) ?? null : null;
  const selectedRelative = selectedPath ? getRelativeFilePath(selectedPath, cwd) : "";

  const openSelected = useCallback(() => {
    if (selectedPath) onOpenFile(selectedPath, getFileName(selectedPath));
  }, [selectedPath, onOpenFile]);

  const mentionSelected = useCallback(() => {
    if (selectedPath) onAtMention?.(getRelativeFilePath(selectedPath, cwd), false);
  }, [selectedPath, cwd, onAtMention]);

  const renderRow = (file: GitFileStatus) => {
    const relative = getRelativeFilePath(file.filePath, cwd);
    const name = getFileName(relative);
    const directory = getFileDirectory(relative);
    const isSelected = file.filePath === selectedPath;
    const isHovered = file.filePath === hoveredPath;
    const reasonLabel = file.collapseReason ? t(COLLAPSE_REASON_LABEL_KEYS[file.collapseReason]) : null;
    return (
      <div
        className="git-change-row"
        key={file.filePath}
        role="option"
        tabIndex={0}
        aria-selected={isSelected}
        aria-label={`${name} (${t(GIT_STATUS_LABEL_KEYS[file.status])}${reasonLabel ? `, ${reasonLabel}` : ""})`}
        onClick={() => setSelectedPath(file.filePath)}
        onDoubleClick={() => onOpenFile(file.filePath, getFileName(file.filePath))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpenFile(file.filePath, getFileName(file.filePath));
          } else if (e.key === " ") {
            e.preventDefault();
            setSelectedPath(file.filePath);
          }
        }}
        onMouseEnter={() => setHoveredPath(file.filePath)}
        onMouseLeave={() => setHoveredPath((prev) => (prev === file.filePath ? null : prev))}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingLeft: 8,
          paddingRight: 8,
          height: 26,
          cursor: "pointer",
          background: isSelected ? "var(--bg-selected)" : isHovered ? "var(--bg-hover)" : "transparent",
          borderRadius: "var(--radius-control)",
          userSelect: "none",
          boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : "none",
          outline: "none",
        }}
      >
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
          {getFileIcon(name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: directory ? "0 1 auto" : 1,
            maxWidth: directory ? "60%" : undefined,
          }}
          title={file.filePath}
        >
          {name}
        </span>
        {directory && (
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
            title={file.filePath}
          >
            {directory}
          </span>
        )}
        {reasonLabel && (
          <span aria-hidden="true" style={{ flexShrink: 0, marginLeft: directory ? 0 : "auto", fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {reasonLabel}
          </span>
        )}
        <span
          title={t(GIT_STATUS_LABEL_KEYS[file.status])}
          aria-hidden="true"
          style={{
            width: 14,
            flexShrink: 0,
            color: GIT_STATUS_COLORS[file.status],
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          {file.code}
        </span>
        <button
          className="git-change-open-action"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile(file.filePath, getFileName(file.filePath));
          }}
          title={t("gitChanges.openFile")}
          aria-label={t("gitChanges.openFile")}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <ExternalLink size={11} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px 4px",
          flexShrink: 0,
        }}
      >
        <Search size={13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
        <input
          ref={filterInputRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setFilter("");
            }
          }}
          placeholder={t("gitChanges.filterFiles")}
          aria-label={t("gitChanges.filterFiles")}
          style={{
            flex: 1,
            minWidth: 0,
            height: 27,
            boxSizing: "border-box",
            padding: filter ? "0 8px" : "0 8px",
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
        {filter && (
          <button
            className="git-clear-filter"
            type="button"
            onClick={() => {
              setFilter("");
              filterInputRef.current?.focus();
            }}
            title={t("fileExplorer.clearSearch")}
            aria-label={t("fileExplorer.clearSearch")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "none", border: "none", borderRadius: "var(--radius-control)",
              color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <X size={12} strokeWidth={2.4} aria-hidden="true" />
          </button>
        )}
        <button
          className="git-refresh"
          type="button"
          onClick={() => setTreeRefreshKey((k) => k + 1)}
          title={t("gitChanges.refreshChanges")}
          aria-label={t("gitChanges.refreshChanges")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26, padding: 0,
            background: "none", border: "none", borderRadius: "var(--radius-control)",
            color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
        >
          <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {loading ? (
        <div role="status" aria-live="polite" style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.loadingFiles")}</div>
      ) : error ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", fontSize: 11, color: "var(--status-error)" }}>
          <span>{error}</span>
          <button
            className="load-retry-button"
            type="button"
            onClick={() => setTreeRefreshKey((key) => key + 1)}
            style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
          >
            {t("chatWindow.retry")}
          </button>
        </div>
      ) : !isRepo ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
          <GitBranch size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("gitChanges.notARepo")}</div>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("gitChanges.notARepoHint")}</div>
        </div>
      ) : files.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
          <Check size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--status-success)" }} />
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("gitChanges.noChanges")}</div>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("gitChanges.noChangesHint")}</div>
        </div>
      ) : (
        <>
          <div style={{ padding: "0 12px 4px", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
            {tn("gitChanges.filesChanged", files.length)}
          </div>
          <div style={{ flex: "0 1 auto", maxHeight: "38%", minHeight: 60, overflowY: "auto", overflowX: "hidden", padding: "0 4px", flexShrink: 1, borderBottom: "1px solid var(--border)" }}>
            {primaryFiles.length === 0 && attributeFiles.length === 0 ? (
              <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("fileExplorer.noMatchingFiles")}</div>
            ) : primaryFiles.length > 0 && (
              <div role="listbox" aria-label={t("tabBar.git")}>
                {primaryFiles.map(renderRow)}
              </div>
            )}
            {attributeFiles.length > 0 && (
              <>
                <button
                  type="button"
                  aria-expanded={showAttributeFiles}
                  aria-controls={showAttributeFiles ? attributeListId : undefined}
                  onClick={() => setShowAttributeFiles((v) => !v)}
                  title={t("gitChanges.attributeFilesHint")}
                  style={{
                    display: "flex", alignItems: "center", gap: 4, width: "100%",
                    height: 26, padding: "0 8px", marginTop: primaryFiles.length > 0 ? 2 : 0,
                    background: "none", border: "none", borderRadius: "var(--radius-control)",
                    color: "var(--text-dim)", cursor: "pointer", fontSize: 11, textAlign: "left",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                >
                  <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" style={{ flexShrink: 0, transform: showAttributeFiles ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} />
                  {tn("gitChanges.attributeFiles", attributeFiles.length)}
                </button>
                {showAttributeFiles && (
                  <div id={attributeListId} role="listbox" aria-label={tn("gitChanges.attributeFiles", attributeFiles.length)}>
                    {attributeFiles.map(renderRow)}
                  </div>
                )}
              </>
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={selectedRelative}
            >
              {selectedRelative}
            </span>
            {selectedFile && (
              <span
                title={t(GIT_STATUS_LABEL_KEYS[selectedFile.status])}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: GIT_STATUS_COLORS[selectedFile.status],
                  flexShrink: 0,
                }}
              >
                {t(GIT_STATUS_LABEL_KEYS[selectedFile.status])}
              </span>
            )}
            {onAtMention && (
              <button
                className="git-change-mention-action"
                type="button"
                onClick={mentionSelected}
                disabled={!selectedPath}
                title={t("fileExplorer.insertPathIntoChat")}
                aria-label={t("fileExplorer.insertPathIntoChat")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  height: 22, padding: "0 7px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: selectedPath ? "var(--accent)" : "var(--text-dim)",
                  cursor: selectedPath ? "pointer" : "default",
                  opacity: selectedPath ? 1 : 0.6,
                  fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
                }}
              >
                <AtSign size={11} strokeWidth={2.2} aria-hidden="true" />
                {t("fileExplorer.mention")}
              </button>
            )}
            <button
              className="git-change-footer-open"
              type="button"
              onClick={openSelected}
              disabled={!selectedPath}
              title={t("gitChanges.openFile")}
              aria-label={t("gitChanges.openFile")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 22, padding: 0,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                cursor: selectedPath ? "pointer" : "default",
                opacity: selectedPath ? 1 : 0.6,
                flexShrink: 0,
              }}
            >
              <ExternalLink size={11} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
            {patchLoading ? (
              <div role="status" aria-live="polite" style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>{t("fileViewer.loading")}</div>
            ) : patchError ? (
              <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", fontSize: 12, color: "var(--status-error)" }}>
                <span>{patchError}</span>
                <button
                  className="load-retry-button"
                  type="button"
                  onClick={() => setTreeRefreshKey((key) => key + 1)}
                  style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {t("chatWindow.retry")}
                </button>
              </div>
            ) : !patchSupported || patch === null ? (
              <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>
                {t(selectedFile?.collapseReason === "no-diff" ? "gitChanges.diffSuppressed" : "gitChanges.diffUnavailable")}
              </div>
            ) : (
              <DiffView patch={patch} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
