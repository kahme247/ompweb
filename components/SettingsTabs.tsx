"use client";

import { useI18n } from "@/lib/i18n";
import { Bot, Cable, Cpu, KeyRound, RefreshCw, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";

export type SettingsTab =
  | "general"
  | "safety"
  | "models"
  | "providers"
  | "intelligence"
  | "agents"
  | "extensions"
  | "mcp"
  | "skills"
  | "plugins"
  | "system";

export interface TabItem {
  id: SettingsTab;
  label: string;
  description: string;
  Icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false"; style?: CSSProperties }>;
  needsWorkspace?: boolean;
}

export const SETTINGS_CATEGORIES: TabItem[] = [
  { id: "general", label: "Interface & Behavior", description: "UI preferences, completion sound, submission mode", Icon: Settings2 },
  { id: "safety", label: "Safety & Approvals", description: "Tool safety rules, YOLO mode, terminal permissions", Icon: ShieldCheck },
  { id: "models", label: "AI Model Defaults", description: "Reasoning budget, verbosity, personality, scratchpad", Icon: Cpu },
  { id: "providers", label: "API Keys & Providers", description: "Connected OAuth accounts, API keys, and model registry", Icon: KeyRound },
  { id: "intelligence", label: "Agent & Intelligence", description: "Advisor, memory, autolearn, compaction and retry", Icon: Sparkles },
  { id: "agents", label: "Agents", description: "Task agents, model settings, and tool policy", Icon: Bot },
  { id: "mcp", label: "Extensions & Tools", description: "MCP servers, managed skills, and OMP plugins", Icon: Cable },
  { id: "system", label: "System & Updates", description: "App updates, runtime version, and active session restart", Icon: RefreshCw },
];

export const getNormalizedActive = (tab: SettingsTab): SettingsTab => {
  if (tab === "skills" || tab === "plugins" || tab === "extensions") return "mcp";
  return tab;
};

export function SettingsTabs({
  active,
  onSelect,
  workspaceReady = true,
  layout = "vertical",
}: {
  active: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  workspaceReady?: boolean;
  layout?: "horizontal" | "vertical";
}) {
  const { t } = useI18n();
  const currentActive = getNormalizedActive(active);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const enabled = SETTINGS_CATEGORIES.filter((tab) => !(tab.needsWorkspace && !workspaceReady));
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = index + 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = index - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = enabled.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const next = enabled[nextIndex] ?? enabled[index];
      if (next) {
        onSelect(next.id);
        const targetBtn = document.getElementById("settings-tab-" + next.id);
        targetBtn?.focus();
      }
    }
  };

  if (layout === "vertical") {
    return (
      <nav
        aria-label={t("settingsTabs.ariaLabel")}
        role="tablist"
        aria-orientation="vertical"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "12px 8px",
          width: 230,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-panel)",
          overflowY: "auto",
        }}
      >
        {SETTINGS_CATEGORIES.map(({ id, label, description, Icon, needsWorkspace }, index) => {
          const labelKey = `settingsTabs.${id}.label`;
          const descKey = `settingsTabs.${id}.description`;
          const trLabel = t(labelKey);
          const trDesc = t(descKey);
          const displayLabel = trLabel !== labelKey ? trLabel : label;
          const displayDescription = trDesc !== descKey ? trDesc : description;
          const selected = id === currentActive;
          const disabled = Boolean(needsWorkspace && !workspaceReady);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={selected}
              aria-controls={`settings-panel-${id}`}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onSelect(id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "9px 10px",
                border: "none",
                borderRadius: "var(--radius-control)",
                background: selected ? "var(--bg-selected)" : "transparent",
                color: selected ? "var(--text)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
                textAlign: "left",
                transition: "background var(--dur-fast), color var(--dur-fast)",
                width: "100%",
              }}
            >
              <Icon size={16} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0, color: selected ? "var(--accent)" : "currentColor" }} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 12.5, fontWeight: selected ? 600 : 500, lineHeight: 1.3, color: selected ? "var(--text)" : "inherit" }}>
                  {displayLabel}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {displayDescription}
                </div>
              </div>
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label={t("settingsTabs.ariaLabel")} role="tablist" style={{ display: "flex", gap: 3, padding: "7px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0, overflowX: "auto" }}>
      {SETTINGS_CATEGORIES.map(({ id, label, description, Icon, needsWorkspace }, index) => {
        const labelKey = `settingsTabs.${id}.label`;
        const descKey = `settingsTabs.${id}.description`;
        const trLabel = t(labelKey);
        const trDesc = t(descKey);
        const displayLabel = trLabel !== labelKey ? trLabel : label;
        const displayDescription = trDesc !== descKey ? trDesc : description;
        const selected = id === currentActive;
        const disabled = Boolean(needsWorkspace && !workspaceReady);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={selected}
            aria-controls={`settings-panel-${id}`}
            aria-label={`${displayLabel}: ${displayDescription}`}
            title={displayDescription}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            style={{ display: "inline-flex", alignItems: "flex-start", gap: 5, padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: selected ? "var(--bg-selected)" : "transparent", color: selected ? "var(--text)" : "var(--text-muted)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, fontSize: 12, whiteSpace: "nowrap", textAlign: "left", minWidth: 150 }}
          >
            <Icon size={13} aria-hidden="true" />
            <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <span style={{ fontWeight: selected ? 600 : 500 }}>{displayLabel}</span>
              <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-muted)", fontSize: 10, fontWeight: 400, lineHeight: 1.25 }}>{displayDescription}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
