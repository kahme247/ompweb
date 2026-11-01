"use client";

import { memo, useEffect, useState, type Ref, type RefObject } from "react";
import {
  AtSign,
  ChevronsDownUp,
  Copy,
  Download,
  FileX,
  Files,
  Folder,
  GitBranch,
  LocateFixed,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import { TabBar, type Tab } from "./TabBar";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { GitChangesPanel } from "./GitChangesPanel";
import { FileViewer } from "./FileViewer";
import { NotificationActions, NotificationList } from "./NotificationList";
import { useUnreadNotificationCount } from "@/lib/notification-history";
import { WorktreesPanel } from "./WorktreesPanel";
import type { WorktreeContext } from "./SessionSidebar-helpers";
import { useI18n } from "@/lib/i18n";
import { getFileName } from "@/lib/file-paths";

export type RightPanelView = "explorer" | "git" | "notifications" | "worktrees" | "file";

interface Props {
  fileTabs: Tab[];
  activeFileTabId: string | null;
  rightView: RightPanelView;
  onSelectView: (view: RightPanelView) => void;
  rightPanelOpen: boolean;
  onClose: () => void;
  rightPanelWidth: number | null;
  rightPanelResizing: boolean;
  rightPanelRef: Ref<HTMLDivElement>;
  fileExplorerRef: RefObject<FileExplorerHandle | null>;
  revealPath: string | null;
  onRevealDone: () => void;
  explorerCwd: string | null;
  /** The workspace lives on a remote host: Files, Git and Worktrees are not available there yet. */
  remoteHost: boolean;
  /** Active Git workspace's worktrees (null when it is not a Git top-level repo). */
  worktrees: WorktreeContext | null;
  explorerRefreshKey: number;
  fileSearchOpen: boolean;
  onToggleFileSearch: () => void;
  onFileSearchOpenChange: (open: boolean) => void;
  explorerUploadBusy: boolean;
  onUploadBusyChange: (busy: boolean) => void;
  explorerGitCount: number;
  explorerIsRepo: boolean;
  explorerRefreshing: boolean;
  isMobile: boolean;
  isCompactOverlay: boolean;
  onOpenFile: (filePath: string, fileName: string, sourceSessionId?: string | null) => void;
  onSelectFileTab: (id: string) => void;
  onCloseFileTab: (id: string) => void;
  onCloseOtherFileTabs: () => void;
  onCloseAllFileTabs: () => void;
  onMentionActiveFile: () => void;
  onCopyActiveFilePath: () => void;
  onDownloadActiveFile: () => void;
  onRevealActiveFile: () => void;
  onExplorerRefresh: () => void;
  onExplorerRefreshDone: () => void;
  onAtMention: (relativePath: string, isDir: boolean) => void;
  onAtMentions: (relativePaths: string[]) => void;
  onMentionLines: (relativePath: string, startLine: number, endLine: number) => void;
  onExplorerGitStatus: (changedCount: number, isRepo: boolean) => void;
  onResetRightPanelWidth: () => void;
  onRightPanelResizeStart: (e: React.MouseEvent) => void;
  onRightPanelResizeKey: (e: React.KeyboardEvent) => void;
}

// Memo boundary: AppShell re-renders on polls, timers, and session updates
// while agents run. The panel hosts the full file tree, the changes list, and
// every open viewer — reconciling all of that per update janks the chat, so
// this component only re-renders when one of its own props actually changes
// (all callbacks are useCallback-stable in AppShell for the same reason).
export const RightPanel = memo(function RightPanel({
  fileTabs,
  activeFileTabId,
  rightView,
  onSelectView,
  rightPanelOpen,
  onClose,
  rightPanelWidth,
  rightPanelResizing,
  rightPanelRef,
  fileExplorerRef,
  revealPath,
  onRevealDone,
  explorerCwd,
  remoteHost,
  worktrees,
  explorerRefreshKey,
  fileSearchOpen,
  onToggleFileSearch,
  onFileSearchOpenChange,
  explorerUploadBusy,
  onUploadBusyChange,
  explorerGitCount,
  explorerIsRepo,
  explorerRefreshing,
  isMobile,
  isCompactOverlay,
  onOpenFile,
  onSelectFileTab,
  onCloseFileTab,
  onCloseOtherFileTabs,
  onCloseAllFileTabs,
  onMentionActiveFile,
  onCopyActiveFilePath,
  onDownloadActiveFile,
  onRevealActiveFile,
  onExplorerRefresh,
  onExplorerRefreshDone,
  onAtMention,
  onAtMentions,
  onMentionLines,
  onExplorerGitStatus,
  onResetRightPanelWidth,
  onRightPanelResizeStart,
  onRightPanelResizeKey,
}: Props) {
  const { t } = useI18n();
  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const gitBadge = explorerIsRepo ? explorerGitCount : 0;
  const unreadNotifications = useUnreadNotificationCount();
  const [visitedViews, setVisitedViews] = useState<Set<RightPanelView>>(() => new Set(["explorer"]));
  useEffect(() => {
    setVisitedViews((previous) => {
      if (previous.has(rightView)) return previous;
      const next = new Set(previous);
      next.add(rightView);
      return next;
    });
  }, [rightView]);

  return (
    <>
      {/* Resize handle — desktop only, hidden while the panel is closed */}
      {!isMobile && rightPanelOpen && (
        <div
          className="right-panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("appShell.resizeFilePanel")}
          tabIndex={0}
          onMouseDown={onRightPanelResizeStart}
          onDoubleClick={onResetRightPanelWidth}
          onKeyDown={onRightPanelResizeKey}
          title={t("appShell.resizeFilePanelTitle")}
          style={{
            width: 5,
            flexShrink: 0,
            marginRight: -5,
            cursor: "col-resize",
            background: "transparent",
            zIndex: 205,
            outline: "none",
            transition: "background var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
        />
      )}
      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <aside
        id="workspace-file-panel"
        ref={rightPanelRef}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " right-panel-resizing" : ""}`}
        role={isCompactOverlay ? "dialog" : undefined}
        aria-modal={isCompactOverlay ? true : undefined}
        aria-label={t("appShell.filePanel")}
        aria-hidden={!rightPanelOpen}
        tabIndex={isCompactOverlay ? -1 : undefined}
        inert={!rightPanelOpen ? true : undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          zIndex: isCompactOverlay ? 210 : undefined,
          ...(!isMobile && rightPanelWidth !== null ? { "--right-panel-width": `${rightPanelWidth}px` } : {}),
        }}
      >
        {/* Right panel toolbar: tabs + editor integrations (chat, path, explorer) */}
        <div className="right-panel-toolbar" style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", minHeight: "var(--shell-topbar-height)", flexWrap: "wrap" }}>
          <div style={{ flex: isMobile ? "1 0 100%" : "1 1 160px", overflow: "hidden", minWidth: 0 }}>
            <TabBar
              tabs={fileTabs}
              activeTabId={rightView === "file" ? activeFileTabId ?? "" : ""}
              onSelectTab={onSelectFileTab}
              onCloseTab={onCloseFileTab}
              explorerSelected={rightView === "explorer"}
              onSelectExplorer={() => onSelectView("explorer")}
              explorerBadge={gitBadge}
              gitSelected={rightView === "git"}
              onSelectGit={() => onSelectView("git")}
              gitBadge={gitBadge}
              notificationsSelected={rightView === "notifications"}
              onSelectNotifications={isMobile ? () => onSelectView("notifications") : undefined}
              notificationsBadge={unreadNotifications}
              worktreesSelected={rightView === "worktrees"}
              onSelectWorktrees={() => onSelectView("worktrees")}
            />
          </div>
          {rightView === "explorer" ? (
            explorerCwd && (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={t("sessionSidebar.explorer")}>
              <button
                onClick={onToggleFileSearch}
                title={t("fileExplorer.searchFiles")}
                aria-label={t("fileExplorer.searchFiles")}
                aria-pressed={fileSearchOpen}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: fileSearchOpen ? "var(--bg-hover)" : "none", border: "none", borderRadius: "var(--radius-control)", color: fileSearchOpen ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Search size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sessionSidebar.uploadFilesTitle")}
                aria-label={t("sessionSidebar.uploadFiles")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: explorerUploadBusy ? "default" : "pointer", opacity: explorerUploadBusy ? 0.6 : 1 }}
                onMouseEnter={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Upload size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={() => fileExplorerRef.current?.collapseAll()}
                title={t("sessionSidebar.collapseExplorer")}
                aria-label={t("sessionSidebar.collapseExplorer")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: isMobile ? "auto" : 26, height: 26, padding: isMobile ? "0 8px" : 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
              >
                <ChevronsDownUp size={isMobile ? 16 : 13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />
                {isMobile && <span>{t("sessionSidebar.collapseExplorer")}</span>}
              </button>
              <button
                aria-label={t("sessionSidebar.refreshExplorer")}
                onClick={onExplorerRefresh}
                title={t("sessionSidebar.refreshExplorer")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: explorerRefreshing ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <RefreshCw size={13} strokeWidth={2} aria-hidden="true" className={explorerRefreshing ? "icon-spin" : undefined} />
              </button>
            </div>
            )
          ) : rightView === "git" ? (
            explorerCwd && (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={t("tabBar.git")}>
              <button
                aria-label={t("gitChanges.refreshChanges")}
                onClick={onExplorerRefresh}
                title={t("gitChanges.refreshChanges")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: explorerRefreshing ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <RefreshCw size={13} strokeWidth={2} aria-hidden="true" className={explorerRefreshing ? "icon-spin" : undefined} />
              </button>
            </div>
            )
          ) : rightView === "notifications" ? (
            <NotificationActions />
          ) : rightView === "file" && activeFileTab && (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={activeFileTab.filePath}>
              <button
                onClick={onMentionActiveFile}
                title={t("appShell.mentionFileInChat")}
                aria-label={t("appShell.mentionFileInChat")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--accent)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
              >
                <AtSign size={13} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <button
                onClick={onCopyActiveFilePath}
                title={t("appShell.copyFilePath")}
                aria-label={t("appShell.copyFilePath")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Copy size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={onRevealActiveFile}
                title={t("appShell.revealInExplorer")}
                aria-label={t("appShell.revealInExplorer")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: revealPath ? "var(--bg-hover)" : "none", border: "none", borderRadius: "var(--radius-control)", color: revealPath ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = revealPath ? "var(--accent)" : "var(--text-dim)"; e.currentTarget.style.background = revealPath ? "var(--bg-hover)" : "none"; }}
              >
                <LocateFixed size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                onClick={onDownloadActiveFile}
                title={t("fileExplorer.downloadFile")}
                aria-label={t("fileExplorer.downloadFile")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <Download size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              {fileTabs.length > 1 && (
                <button
                  onClick={onCloseOtherFileTabs}
                  title={t("appShell.closeOtherTabs")}
                  aria-label={t("appShell.closeOtherTabs")}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 26, padding: "0 7px", background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  {t("appShell.closeOthers")}
                </button>
              )}
              <button
                onClick={onCloseAllFileTabs}
                title={t("appShell.closeAllTabs")}
                aria-label={t("appShell.closeAllTabs")}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <FileX size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t("appShell.hideFilePanel")}
            aria-label={t("appShell.hideFilePanel")}
            className="shell-toolbar-btn right-panel-close-button ui-focus-ring"
          >
            <X size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {/* Explorer tab view — kept mounted so expansion survives tab switches. */}
        <div id="workspace-file-panel-explorer" role="tabpanel" aria-label={t("sessionSidebar.explorer")} style={{ display: rightView === "explorer" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {visitedViews.has("explorer") && (explorerCwd ? (
            <>
              <div
                title={explorerCwd}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  margin: "8px 8px 4px",
                  padding: "5px 8px",
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text-muted)",
                  minWidth: 0,
                  flexShrink: 0,
                }}
              >
                <Folder size={13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {getFileName(explorerCwd)}
                  </span>
                  <span style={{ display: "block", fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>
                    {explorerCwd}
                  </span>
                </span>
                {explorerIsRepo && (
                  <span
                    title={explorerGitCount > 0 ? t("sessionSidebar.explorerChanged", { count: explorerGitCount }) : t("sessionSidebar.explorerClean")}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: explorerGitCount > 0 ? "var(--status-modified)" : "var(--status-success)",
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                <FileExplorer
                  ref={fileExplorerRef}
                  cwd={explorerCwd}
                  onOpenFile={onOpenFile}
                  refreshKey={explorerRefreshKey}
                  onAtMention={onAtMention}
                  onAtMentions={onAtMentions}
                  onUploadBusyChange={onUploadBusyChange}
                  onRefreshDone={onExplorerRefreshDone}
                  fileSearchOpen={fileSearchOpen}
                  onFileSearchOpenChange={onFileSearchOpenChange}
                  activeFilePath={activeFileTab?.filePath ?? null}
                  revealPath={revealPath}
                  onRevealDone={onRevealDone}
                  onGitStatusChange={onExplorerGitStatus}
                />
              </div>
            </>
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
              <Folder size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("sessionSidebar.explorer")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t(remoteHost ? "hosts.notAvailableRemote" : "sessionSidebar.selectProjectFirst")}</div>
            </div>
          ))}
        </div>
        {/* Git changes tab view — kept mounted so selection survives tab switches. */}
        <div id="workspace-file-panel-git" role="tabpanel" aria-label={t("tabBar.git")} style={{ display: rightView === "git" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {visitedViews.has("git") && (explorerCwd ? (
            <GitChangesPanel
              cwd={explorerCwd}
              refreshKey={explorerRefreshKey}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              onRefreshDone={onExplorerRefreshDone}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
              <GitBranch size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("tabBar.git")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t(remoteHost ? "hosts.notAvailableRemote" : "sessionSidebar.selectProjectFirst")}</div>
            </div>
          ))}
        </div>
        <div id="workspace-file-panel-notifications" role="tabpanel" tabIndex={-1} aria-label={t("appShell.notifications")} className="ui-focus-ring" style={{ display: rightView === "notifications" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", outline: "none" }}>
          {isMobile && visitedViews.has("notifications") && <NotificationList />}
        </div>
        <div id="workspace-file-panel-worktrees" role="tabpanel" aria-label={t("tabBar.worktrees")} style={{ display: rightView === "worktrees" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* Keyed by repository so a draft branch or pending confirmation never carries over to another repo. */}
          {visitedViews.has("worktrees") && <WorktreesPanel key={worktrees?.projectRoot ?? ""} ctx={worktrees} remoteHost={remoteHost} />}
        </div>
        {/* Keep open viewers mounted so switching tabs preserves scroll and preview state. */}
        <div id="workspace-file-panel-file" role="tabpanel" aria-label={activeFileTab?.filePath ?? t("appShell.filePanel")} style={{ display: rightView === "file" ? "block" : "none", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {fileTabs.length > 0 ? fileTabs.map((tab) => (
            <div key={tab.id} style={{ display: tab.id === activeFileTabId ? "block" : "none", height: "100%" }}>
              <FileViewer
                filePath={tab.filePath}
                cwd={explorerCwd ?? undefined}
                sourceSessionId={tab.sourceSessionId}
                gitRefreshKey={explorerRefreshKey}
                active={tab.id === activeFileTabId && rightPanelOpen && rightView === "file"}
                onMentionLines={tab.id === activeFileTabId && rightPanelOpen && rightView === "file" ? onMentionLines : undefined}
                onOpenFile={(filePath) => onOpenFile(
                  filePath,
                  getFileName(filePath),
                  tab.sourceSessionId,
                )}
              />
            </div>
          )) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
              <Files size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("appShell.noFileOpen")}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("appShell.noFileOpenHint")}</div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
});
