"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Folder, GitBranch, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getFileIcon } from "./FileIcons";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Pinned Explorer tab rendered before the file tabs (right-panel tab redesign). */
  explorerSelected?: boolean;
  onSelectExplorer?: () => void;
  /** Changed-file count badge on the Explorer tab. */
  explorerBadge?: number;
  /** Pinned Git changes tab rendered after Explorer (Tauri parity). */
  gitSelected?: boolean;
  onSelectGit?: () => void;
  /** Changed-file count badge on the Git tab. */
  gitBadge?: number;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, explorerSelected = false, onSelectExplorer, explorerBadge = 0, gitSelected = false, onSelectGit, gitBadge = 0 }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const orderedTabIds = [
    ...(onSelectExplorer ? ["explorer"] : []),
    ...(onSelectGit ? ["git"] : []),
    ...tabs.map((tab) => tab.id),
  ];

  const selectTabById = (id: string) => {
    if (id === "explorer") onSelectExplorer?.();
    else if (id === "git") onSelectGit?.();
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

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="horizontal"
      aria-label="Open files"
      className="tabbar-scroll"
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {onSelectExplorer && (
        <div
          data-tab-id="explorer"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectExplorer}
          role="tab"
          tabIndex={explorerSelected ? 0 : -1}
          aria-selected={explorerSelected}
          aria-label={t("sessionSidebar.explorer")}
          title={explorerBadge > 0 ? t("sessionSidebar.explorerChanged", { count: explorerBadge }) : t("sessionSidebar.explorer")}
          onKeyDown={(event) => handleTabKeyDown(event, "explorer")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 36,
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: explorerSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: 12,
            color: explorerSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {explorerSelected && (
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
          <span style={{ flexShrink: 0, opacity: explorerSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: explorerSelected ? "var(--accent)" : undefined }}>
            <Folder size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: explorerSelected ? 500 : 400 }}>
            {t("sessionSidebar.explorer")}
          </span>
          {explorerBadge > 0 && (
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minWidth: 16,
                height: 15,
                padding: "0 4px",
                borderRadius: 8,
                background: "color-mix(in srgb, var(--status-modified) 18%, transparent)",
                color: "var(--status-modified)",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {explorerBadge > 99 ? "99+" : explorerBadge}
            </span>
          )}
        </div>
      )}
      {onSelectGit && (
        <div
          data-tab-id="git"
          className="tabbar-tab ui-focus-ring"
          onClick={onSelectGit}
          role="tab"
          tabIndex={gitSelected ? 0 : -1}
          aria-selected={gitSelected}
          aria-label={t("tabBar.git")}
          title={gitBadge > 0 ? t("sessionSidebar.explorerChanged", { count: gitBadge }) : t("tabBar.git")}
          onKeyDown={(event) => handleTabKeyDown(event, "git")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 36,
            paddingLeft: 12,
            paddingRight: 10,
            borderRight: "1px solid var(--border)",
            background: gitSelected ? "var(--bg)" : "var(--bg-panel)",
            cursor: "pointer",
            fontSize: 12,
            color: gitSelected ? "var(--text)" : "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            userSelect: "none",
            position: "relative",
            transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
          }}
        >
          {gitSelected && (
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
          <span style={{ flexShrink: 0, opacity: gitSelected ? 1 : 0.7, display: "flex", alignItems: "center", color: gitSelected ? "var(--accent)" : undefined }}>
            <GitBranch size={13} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: gitSelected ? 500 : 400 }}>
            {t("tabBar.git")}
          </span>
          {gitBadge > 0 && (
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minWidth: 16,
                height: 15,
                padding: "0 4px",
                borderRadius: 8,
                background: "color-mix(in srgb, var(--status-modified) 18%, transparent)",
                color: "var(--status-modified)",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              {gitBadge > 99 ? "99+" : gitBadge}
            </span>
          )}
        </div>
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
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
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
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={(event) => event.stopPropagation()}
              className="tabbar-close ui-focus-ring"
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
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
