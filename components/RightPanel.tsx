"use client";

import { memo, type RefObject } from "react";
import {
  AtSign,
  ChevronsDownUp,
  Copy,
  Download,
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
import { useI18n } from "@/lib/i18n";
import { getFileName } from "@/lib/file-paths";

export type RightPanelView = "explorer" | "git" | "file";

interface Props {
  fileTabs: Tab[];
  activeFileTabId: string | null;
  rightView: RightPanelView;
  onSelectView: (view: RightPanelView) => void;
  rightPanelOpen: boolean;
  rightPanelWidth: number | null;
  rightPanelResizing: boolean;
  rightPanelRef: RefObject<HTMLDivElement | null>;
  fileExplorerRef: RefObject<FileExplorerHandle | null>;
  revealPath: string | null;
  onRevealDone: () => void;
  explorerCwd: string | null;
  activeCwd: string | null;
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
  rightPanelWidth,
  rightPanelResizing,
  rightPanelRef,
  fileExplorerRef,
  revealPath,
  onRevealDone,
  explorerCwd,
  activeCwd,
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

  return (
    <>
      {/* Resize handle — desktop only, hidden while the panel is closed */}
      {!isMobile && rightPanelOpen && (
        <div
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
      <div
        ref={rightPanelRef}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelWidth !== null ? " right-panel-custom-width" : ""}${rightPanelResizing ? " right-panel-resizing" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          ...(!isMobile && rightPanelWidth !== null ? { "--right-panel-width": `${rightPanelWidth}px` } : {}),
        }}
      >
        {/* Right panel toolbar: tabs + editor integrations (chat, path, explorer) */}
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
          <div style={{ flex: 1, overflow: "hidden", minWidth: 0 }}>
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
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                <ChevronsDownUp size={13} strokeWidth={2} aria-hidden="true" />
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
          ) : activeFileTab && (
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
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* Explorer tab view — kept mounted so expansion survives tab switches. */}
        <div style={{ display: rightView === "explorer" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {explorerCwd ? (
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
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("sessionSidebar.selectProjectFirst")}</div>
            </div>
          )}
        </div>
        {/* Git changes tab view — kept mounted so selection survives tab switches. */}
        <div style={{ display: rightView === "git" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {explorerCwd ? (
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
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6, maxWidth: 260 }}>{t("sessionSidebar.selectProjectFirst")}</div>
            </div>
          )}
        </div>
        {/* Keep open viewers mounted so switching tabs preserves scroll and preview state. */}
        <div style={{ display: rightView === "file" ? "block" : "none", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {fileTabs.length > 0 ? fileTabs.map((tab) => (
            <div key={tab.id} style={{ display: tab.id === activeFileTabId ? "block" : "none", height: "100%" }}>
              <FileViewer
                filePath={tab.filePath}
                cwd={activeCwd ?? undefined}
                sourceSessionId={tab.sourceSessionId}
                gitRefreshKey={explorerRefreshKey}
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
      </div>
    </>
  );
});
