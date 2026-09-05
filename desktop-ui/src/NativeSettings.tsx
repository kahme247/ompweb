import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/components/ui/toast";

type NativeSettings = Record<string, unknown>;

type SettingDef = {
  path: string;
  label: string;
  desc: string;
  group: string;
  kind: "enum" | "bool" | "number";
  options?: readonly string[];
  numberStep?: number;
};

// Full editable surface of ~/.omp/agent/config.yml (allow-list mirrors
// lib/omp/settings-config.ts). "Default" sends null, removing the key so
// omp's built-in default applies.
const SETTINGS: SettingDef[] = [
  { path: "defaultThinkingLevel", label: "Default thinking level", desc: "Reasoning effort used when a prompt doesn't specify one", group: "Model & output", kind: "enum", options: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { path: "hideThinkingBlock", label: "Hide thinking blocks", desc: "Display only — the model still thinks", group: "Model & output", kind: "bool" },
  { path: "externalThinking", label: "External thinking", desc: "Enable providers' external reasoning streams", group: "Model & output", kind: "bool" },
  { path: "textVerbosity", label: "Text verbosity", desc: "How verbose model output should be", group: "Model & output", kind: "enum", options: ["low", "medium", "high"] },
  { path: "personality", label: "Personality", desc: "Response tone: default, friendly, pragmatic, or none", group: "Model & output", kind: "enum", options: ["default", "friendly", "pragmatic", "none"] },

  { path: "tools.approvalMode", label: "Tool approval mode", desc: "Default approval for new sessions: always-ask, write (edits ask), or yolo (approve everything)", group: "Tools & approval", kind: "enum", options: ["always-ask", "write", "yolo"] },
  { path: "tools.approval.bash", label: "Bash commands", desc: "Allow, prompt, or deny shell commands by default", group: "Tools & approval", kind: "enum", options: ["allow", "prompt", "deny"] },
  { path: "tools.approval.extension", label: "Extensions", desc: "Allow or prompt for extension tool calls", group: "Tools & approval", kind: "enum", options: ["allow", "prompt"] },

  { path: "retry.enabled", label: "Auto-retry", desc: "Retry failed model calls automatically", group: "Reliability", kind: "bool" },
  { path: "retry.maxRetries", label: "Max retries", desc: "Retry attempts before giving up", group: "Reliability", kind: "number", numberStep: 1 },
  { path: "retry.modelFallback", label: "Model fallback", desc: "Fall back to another model when retries are exhausted", group: "Reliability", kind: "bool" },

  { path: "compaction.enabled", label: "Auto-compaction", desc: "Summarize the transcript when the context window fills", group: "Compaction", kind: "bool" },
  { path: "compaction.midTurnEnabled", label: "Mid-turn compaction", desc: "Allow compaction in the middle of a running turn", group: "Compaction", kind: "bool" },
  { path: "compaction.strategy", label: "Strategy", desc: "How compaction summarizes: snapcompact, handoff, context-full, shake, or off", group: "Compaction", kind: "enum", options: ["snapcompact", "handoff", "context-full", "shake", "off"] },
  { path: "compaction.autoContinue", label: "Auto-continue", desc: "Resume the task automatically after compaction", group: "Compaction", kind: "bool" },
  { path: "compaction.keepRecentTokens", label: "Keep recent tokens", desc: "Tokens of recent transcript kept verbatim", group: "Compaction", kind: "number", numberStep: 1000 },

  { path: "memory.backend", label: "Memory backend", desc: "off, local, mnemopi, or hindsight", group: "Memory & learning", kind: "enum", options: ["off", "local", "mnemopi", "hindsight"] },
  { path: "autolearn.enabled", label: "Autolearn", desc: "Learn project conventions automatically", group: "Memory & learning", kind: "bool" },
  { path: "autolearn.autoContinue", label: "Autolearn auto-continue", desc: "Continue the task after autolearn finishes", group: "Memory & learning", kind: "bool" },
  { path: "autolearn.minToolCalls", label: "Min tool calls", desc: "Tool-call threshold before autolearn triggers", group: "Memory & learning", kind: "number", numberStep: 1 },

  { path: "mcp.enableProjectConfig", label: "Project MCP config", desc: "Load mcp.json from the project directory", group: "Integrations", kind: "bool" },
  { path: "mcp.renderMarkdownResults", label: "Render MCP markdown", desc: "Render MCP tool results as markdown", group: "Integrations", kind: "bool" },
  { path: "mcp.notifications", label: "MCP notifications", desc: "Surface MCP server notifications", group: "Integrations", kind: "bool" },
  { path: "mcp.notificationDebounceMs", label: "Notification debounce", desc: "Debounce for MCP notifications (ms)", group: "Integrations", kind: "number", numberStep: 50 },
  { path: "advisor.enabled", label: "Advisor", desc: "Enable the advisor extension", group: "Integrations", kind: "bool" },
  { path: "advisor.subagents", label: "Advisor subagents", desc: "Let the advisor spawn subagents", group: "Integrations", kind: "bool" },
];

const GROUP_ORDER = ["Model & output", "Tools & approval", "Reliability", "Compaction", "Memory & learning", "Integrations"];

function getPath(obj: NativeSettings, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function NativeSettingsPanel() {
  const [settings, setSettings] = useState<NativeSettings | null>(null);

  useEffect(() => {
    invoke<NativeSettings>("omp_get_native_settings")
      .then(setSettings)
      .catch(() => setSettings({}));
  }, []);

  const change = useCallback((def: SettingDef, raw: unknown) => {
    // "default" (empty string) clears the key so omp's default applies.
    const value = raw === "" || raw === "default" ? null : def.kind === "number" ? Number(raw) : raw;
    setSettings((prev) => {
      const next = structuredClone(prev ?? {});
      const keys = def.path.split(".");
      let current: Record<string, unknown> = next;
      for (const key of keys.slice(0, -1)) {
        if (typeof current[key] !== "object" || current[key] === null) current[key] = {};
        current = current[key] as Record<string, unknown>;
      }
      if (value === null) delete current[keys[keys.length - 1]];
      else current[keys[keys.length - 1]] = value;
      return next;
    });
    invoke("omp_set_native_setting", { path: def.path, value })
      .catch((err) => {
        toast.error(String(err));
        invoke<NativeSettings>("omp_get_native_settings")
          .then(setSettings)
          .catch(() => {});
      });
  }, []);

  if (settings === null) {
    return <div className="settings-empty">Loading omp settings…</div>;
  }

  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: SETTINGS.filter((s) => s.group === group),
  }));

  return (
    <>
      {groups.map(({ group, items }) => (
        <div key={group}>
          <div className="settings-group-label">{group}</div>
          {items.map((def) => (
            <div key={def.path} className="settings-card">
              <div className="settings-card-text">
                <div className="settings-card-title">{def.label}</div>
                <div className="settings-card-desc">
                  {def.desc}
                  <span className="settings-path">{def.path}</span>
                </div>
              </div>
              {def.kind === "enum" && (
                <select
                  className="settings-select"
                  value={(getPath(settings, def.path) as string) ?? ""}
                  onChange={(e) => change(def, e.target.value)}
                >
                  <option value="">Default</option>
                  {def.options?.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              )}
              {def.kind === "bool" && (
                <span
                  className={`settings-toggle${getPath(settings, def.path) === true ? " on" : ""}`}
                  role="switch"
                  aria-checked={getPath(settings, def.path) === true}
                  aria-label={def.label}
                  onClick={() => change(def, getPath(settings, def.path) !== true)}
                >
                  <span className="settings-toggle-knob" />
                </span>
              )}
              {def.kind === "number" && (
                <input
                  type="number"
                  className="settings-select settings-number"
                  step={def.numberStep ?? 1}
                  value={typeof getPath(settings, def.path) === "number" ? (getPath(settings, def.path) as number) : ""}
                  placeholder="Default"
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") change(def, "");
                    else if (Number.isFinite(Number(raw))) change(def, Number(raw));
                  }}
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
