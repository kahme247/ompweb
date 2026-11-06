"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Activity, Bell, Folder, GitBranch, GitFork, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getFileIcon } from "./FileIcons";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  hostId: string;
  sourceCwd: string | null;
  sourceSessionId?: string | null;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Pinned Explorer tab rendered after Notifications, before the file tabs (right-panel tab redesign). */
  explorerSelected?: boolean;
  onSelectExplorer?: () => void;
  /** Changed-file count badge on the Explorer tab. */
  explorerBadge?: number;
  /** Pinned Git changes tab rendered after Explorer (Tauri parity). */
  gitSelected?: boolean;
  onSelectGit?: () => void;
  /** Changed-file count badge on the Git tab. */
  gitBadge?: number;
  /** Pinned Notifications tab rendered first. */
  notificationsSelected?: boolean;
  onSelectNotifications?: () => void;
  /** Unread-notification count badge on the Notifications tab. */
  notificationsBadge?: number;
  /** Pinned Worktrees tab rendered after Git. */
  worktreesSelected?: boolean;
  onSelectWorktrees?: () => void;
  /** Pinned Connection tab rendered last (connection diagnostics on). */
  connectionSelected?: boolean;
  onSelectConnection?: () => void;
}
const badgeStyle = (color: string) => ({
  display: "inline-flex",
  alignItems: "center",
  minWidth: 16,
  height: 15,
  padding: "0 4px",
  borderRadius: 8,
  background: `color-mix(in srgb, ${color} 18%, transparent)`,
  color,
  fontSize: 10,
  fontWeight: 700,
});

/** Notifications / Explorer / Git: fixed tabs before the file tabs. */
function PinnedTab({ id, panelId, label, title, icon, selected, badge, badgeColor, onSelect, onKeyDown }: {
  id: string;
  panelId: string;
  label: string;
  title: string;
  icon: ReactNode;
  selected: boolean;
  badge: number;
  badgeColor: string;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, id: string) => void;
}) {
  return (
    <div
      data-tab-id={id}
      className="tabbar-tab ui-focus-ring"
      onClick={onSelect}
      role="tab"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      aria-label={label}
      aria-controls={panelId}
      title={title}
      onKeyDown={(event) => onKeyDown(event, id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "var(--tab-height)",
        paddingLeft: 12,
        paddingRight: 10,
        borderRight: "1px solid var(--border)",
        background: selected ? "var(--bg)" : "var(--bg-panel)",
        cursor: "pointer",
        fontSize: "var(--text-sm)",
        color: selected ? "var(--text)" : "var(--text-muted)",
        whiteSpace: "nowrap",
        flexShrink: 0,
        userSelect: "none",
        position: "relative",
        transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
      }}
    >
      {selected && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            background: "var(--accent)",
            borderTopLeftRadius: "var(--radius-control)",
            borderTopRightRadius: "var(--radius-control)",
          }}
        />
      )}
      <span style={{ flexShrink: 0, opacity: selected ? 1 : 0.7, display: "flex", alignItems: "center", color: selected ? "var(--accent)" : undefined }}>
        {icon}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: selected ? 500 : 400 }}>
        {label}
      </span>
      {badge > 0 && (
        <span aria-hidden="true" style={badgeStyle(badgeColor)}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </div>
  );
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, explorerSelected = false, onSelectExplorer, explorerBadge = 0, gitSelected = false, onSelectGit, gitBadge = 0, notificationsSelected = false, onSelectNotifications, notificationsBadge = 0, worktreesSelected = false, onSelectWorktrees, connectionSelected = false, onSelectConnection }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const orderedTabIds = [
    ...(onSelectNotifications ? ["notifications"] : []),
    ...(onSelectExplorer ? ["explorer"] : []),
    ...(onSelectGit ? ["git"] : []),
    ...(onSelectWorktrees ? ["worktrees"] : []),
    ...(onSelectConnection ? ["connection"] : []),
    ...tabs.map((tab) => tab.id),
  ];

  const selectTabById = (id: string) => {
    if (id === "explorer") onSelectExplorer?.();
    else if (id === "git") onSelectGit?.();
    else if (id === "notifications") onSelectNotifications?.();
    else if (id === "worktrees") onSelectWorktrees?.();
    else if (id === "connection") onSelectConnection?.();
    else {
      const tab = tabs.find((item) => item.id === id);
      if (tab) onSelectTab(tab.id);
    }
  };

  const focusTabById = (id: string) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTabById(id);
      return;
    }

    const index = orderedTabIds.indexOf(id);
    if (index < 0 || orderedTabIds.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % orderedTabIds.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + orderedTabIds.length) % orderedTabIds.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = orderedTabIds.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const nextId = orderedTabIds[nextIndex];
      selectTabById(nextId);
      focusTabById(nextId);
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && tabs.some((tab) => tab.id === id)) {
      event.preventDefault();
      onCloseTab(id);
    }
  };

  // Keep the active tab visible when the bar overflows horizontally.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < listRect.left) {
      list.scrollLeft -= listRect.left - tabRect.left;
    } else if (tabRect.right > listRect.right) {
      list.scrollLeft += tabRect.right - listRect.right;
    }
  }, [activeTabId, tabs]);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t("appShell.filePanel")}
      aria-orientation="horizontal"
      className="tabbar-scroll"
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: "var(--tab-height)",
      }}
    >
      {onSelectNotifications && (
        <PinnedTab
          id="notifications"
          panelId="workspace-file-panel-notifications"
          label={t("appShell.notifications")}
          title={notificationsBadge > 0 ? t("appShell.notificationsUnreadCount", { count: notificationsBadge }) : t("appShell.notifications")}
          icon={<Bell size={13} strokeWidth={2} aria-hidden="true" />}
          selected={notificationsSelected}
          badge={notificationsBadge}
          badgeColor="var(--accent)"
          onSelect={onSelectNotifications}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectExplorer && (
        <PinnedTab
          id="explorer"
          panelId="workspace-file-panel-explorer"
          label={t("sessionSidebar.explorer")}
          title={explorerBadge > 0 ? t("sessionSidebar.explorerChanged", { count: explorerBadge }) : t("sessionSidebar.explorer")}
          icon={<Folder size={13} strokeWidth={2} aria-hidden="true" />}
          selected={explorerSelected}
          badge={explorerBadge}
          badgeColor="var(--status-modified)"
          onSelect={onSelectExplorer}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectGit && (
        <PinnedTab
          id="git"
          panelId="workspace-file-panel-git"
          label={t("tabBar.git")}
          title={gitBadge > 0 ? t("sessionSidebar.explorerChanged", { count: gitBadge }) : t("tabBar.git")}
          icon={<GitBranch size={13} strokeWidth={2} aria-hidden="true" />}
          selected={gitSelected}
          badge={gitBadge}
          badgeColor="var(--status-modified)"
          onSelect={onSelectGit}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectWorktrees && (
        <PinnedTab
          id="worktrees"
          panelId="workspace-file-panel-worktrees"
          label={t("tabBar.worktrees")}
          title={t("tabBar.worktrees")}
          icon={<GitFork size={13} strokeWidth={2} aria-hidden="true" />}
          selected={worktreesSelected}
          badge={0}
          badgeColor="var(--accent)"
          onSelect={onSelectWorktrees}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectConnection && (
        <PinnedTab
          id="connection"
          panelId="workspace-file-panel-connection"
          label={t("tabBar.connection")}
          title={t("tabBar.connection")}
          icon={<Activity size={13} strokeWidth={2} aria-hidden="true" />}
          selected={connectionSelected}
          badge={0}
          badgeColor="var(--accent)"
          onSelect={onSelectConnection}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className="tabbar-tab ui-focus-ring"
            onClick={() => onSelectTab(tab.id)}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-label={tab.filePath}
            aria-controls="workspace-file-panel-file"
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: "var(--tab-height)",
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: "var(--text-sm)",
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              position: "relative",
              transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
            }}
          >
            {isActive && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2,
                  background: "var(--accent)",
                  borderTopLeftRadius: "var(--radius-control)",
                  borderTopRightRadius: "var(--radius-control)",
                }}
              />
            )}
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={(event) => event.stopPropagation()}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "var(--icon-control-size-compact)", height: "var(--icon-control-size-compact)",
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
              }}
              title={t("tabBar.close")}
              aria-label={t("tabBar.closeTab", { label: tab.label })}
            >
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
