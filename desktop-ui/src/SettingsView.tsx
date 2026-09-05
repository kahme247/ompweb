import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, BarChart3, KeyRound, Palette, Puzzle, SlidersHorizontal, Wrench } from "lucide-react";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { SkillsSettings } from "./SkillsSettings";
import { NativeSettingsPanel } from "./NativeSettings";
import { formatTokens, formatCost } from "@/lib/subagent-format";
import { LOCALES, setLocale, useI18n, type Locale } from "@/lib/i18n";

type ShellSettings = { notifyOnAgentEnd: boolean; closeToTray: boolean };

export type LoginProvider = { id: string; name: string; available: boolean; authenticated: boolean };

export type UsageSnapshot = {
  tokens: number;
  cost: number;
  contextPercent: number | null;
  model: string | null;
  thinkingLevel: string | null;
};

const STORAGE_KEY = "omp-desktop-settings";
const FONT_KEY = "omp-desktop-fonts";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "skills", label: "Skills", icon: Puzzle },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "advanced", label: "Advanced", icon: Wrench },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

type FontSettings = { ui: number; code: number };

export function applyFontSettings(fonts: FontSettings): void {
  document.documentElement.style.setProperty("--desktop-font-size", `${fonts.ui}px`);
  document.documentElement.style.setProperty("--desktop-code-font-size", `${fonts.code}px`);
}

function loadFontSettings(): FontSettings {
  try {
    const raw = localStorage.getItem(FONT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FontSettings>;
      const ui = typeof parsed.ui === "number" ? parsed.ui : 14;
      const code = typeof parsed.code === "number" ? parsed.code : 13;
      return { ui, code };
    }
  } catch {
    // fall through to defaults
  }
  return { ui: 14, code: 13 };
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={`settings-toggle${checked ? " on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" />
    </button>
  );
}

type SettingsViewProps = {
  onBack: () => void;
  /** Resolves the provider list; rejects when no omp session is running. */
  providersLoader: () => Promise<LoginProvider[]>;
  /** Working directory for the project skills scan. */
  cwd: string;
  /** Live usage of this window's session (null when none). */
  usage: UsageSnapshot | null;
};

export function SettingsView({ onBack, providersLoader, cwd, usage }: SettingsViewProps) {
  const { preference, setTheme } = useTheme();
  const { locale, setLocale: changeLocale } = useI18n();
  const [section, setSection] = useState<SectionId>("general");
  const [shell, setShell] = useState<ShellSettings>({ notifyOnAgentEnd: true, closeToTray: true });
  const [providers, setProviders] = useState<LoginProvider[] | null>(null);
  const [providersError, setProvidersError] = useState("");
  const [fonts, setFonts] = useState<FontSettings>(loadFontSettings);
  const [skillsError, setSkillsError] = useState("");

  const changeFonts = useCallback((next: FontSettings) => {
    setFonts(next);
    applyFontSettings(next);
    try {
      localStorage.setItem(FONT_KEY, JSON.stringify(next));
    } catch {
      // persistence is best-effort
    }
  }, []);

  useEffect(() => {
    invoke<ShellSettings>("omp_shell_settings")
      .then(setShell)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (section !== "providers") return;
    setProviders(null);
    setProvidersError("");
    providersLoader()
      .then(setProviders)
      .catch((err) => setProvidersError(String(err)));
  }, [section, providersLoader]);

  const updateShell = (key: keyof ShellSettings, value: boolean) => {
    setShell((prev) => ({ ...prev, [key]: value }));
    invoke("omp_shell_set_setting", { key, value }).catch(() => {});
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...parsed, [key]: value }));
    } catch {
      // persistence is best-effort; the Rust side holds the live value
    }
  };

  return (
    <div className="settings-view">
      <aside className="settings-nav">
        <button className="settings-back" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden />
          Back
        </button>
        <nav>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`settings-nav-item${section === id ? " active" : ""}`}
              onClick={() => setSection(id)}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings-content">
        {section === "general" && (
          <>
            <h2>General</h2>
            <div className="settings-card">
              <div className="settings-card-text">
                <div className="settings-card-title">Notify when a run finishes</div>
                <div className="settings-card-desc">
                  Show a Windows notification when the agent completes while the window is in the
                  background
                </div>
              </div>
              <Toggle
                checked={shell.notifyOnAgentEnd}
                onChange={(v) => updateShell("notifyOnAgentEnd", v)}
                label="Notify when a run finishes"
              />
            </div>
            <div className="settings-card">
              <div className="settings-card-text">
                <div className="settings-card-title">Close to tray</div>
                <div className="settings-card-desc">
                  Closing the window keeps omp sessions running in the tray; quitting happens from
                  the tray menu. Turn off to exit the app on close.
                </div>
              </div>
              <Toggle
                checked={shell.closeToTray}
                onChange={(v) => updateShell("closeToTray", v)}
                label="Close to tray"
              />
            </div>
          </>
        )}

        {section === "appearance" && (
          <>
            <h2>Appearance</h2>
            <div className="settings-card">
              <div className="settings-card-text">
                <div className="settings-card-title">Theme</div>
                <div className="settings-card-desc">Choose between system, light, or dark themes</div>
              </div>
              <div className="settings-segmented">
                {(["system", "light", "dark"] as ThemePreference[]).map((p) => (
                  <button
                    key={p}
                    className={preference === p ? "active" : ""}
                    onClick={() => setTheme(p)}
                  >
                    {p[0].toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-card">
              <div className="settings-card-text">
                <div className="settings-card-title">Language</div>
                <div className="settings-card-desc">Language used throughout the app</div>
              </div>
              <select
                className="settings-select"
                value={locale}
                onChange={(e) => changeLocale(e.target.value as Locale)}
              >
                {LOCALES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-card">
              <div className="settings-card-text">
                <div className="settings-card-title">UI font size</div>
                <div className="settings-card-desc">Text size across the interface and messages</div>
              </div>
              <select
                className="settings-select"
                value={fonts.ui}
                onChange={(e) => changeFonts({ ...fonts, ui: Number(e.target.value) })}
              >
                {[12, 13, 14, 16, 18].map((n) => (
                  <option key={n} value={n}>{n} px</option>
                ))}
              </select>
            </div>
            <div className="settings-card">
              <div className="settings-card-text">
                <div className="settings-card-title">Code font size</div>
                <div className="settings-card-desc">Text size in diffs, code blocks, and tool output</div>
              </div>
              <select
                className="settings-select"
                value={fonts.code}
                onChange={(e) => changeFonts({ ...fonts, code: Number(e.target.value) })}
              >
                {[11, 12, 13, 14, 15].map((n) => (
                  <option key={n} value={n}>{n} px</option>
                ))}
              </select>
            </div>
          </>
        )}

        {section === "skills" && (
          <>
            <h2>Skills</h2>
            {skillsError && <div className="settings-empty">{skillsError}</div>}
            <SkillsSettings cwd={cwd} onError={setSkillsError} />
          </>
        )}

        {section === "usage" && (
          <>
            <h2>Usage</h2>
            {!usage ? (
              <div className="settings-empty">
                Start a session in this window to see its token and cost usage.
              </div>
            ) : (
              <>
                <div className="usage-grid">
                  <div className="usage-stat">
                    <div className="usage-stat-value">{formatTokens(usage.tokens) ?? "0"}</div>
                    <div className="usage-stat-label">tokens this session</div>
                  </div>
                  <div className="usage-stat">
                    <div className="usage-stat-value">{formatCost(usage.cost) ?? "$0"}</div>
                    <div className="usage-stat-label">estimated cost</div>
                  </div>
                  <div className="usage-stat">
                    <div className="usage-stat-value">
                      {usage.contextPercent != null
                        ? usage.contextPercent >= 10
                          ? `${Math.round(usage.contextPercent)}%`
                          : `${usage.contextPercent.toFixed(1)}%`
                        : "—"}
                    </div>
                    <div className="usage-stat-label">context window used</div>
                  </div>
                </div>
                <div className="settings-card">
                  <div className="settings-card-text">
                    <div className="settings-card-title">Current model</div>
                    <div className="settings-card-desc">
                      {usage.model ?? "—"}
                      {usage.thinkingLevel ? ` · thinking ${usage.thinkingLevel}` : ""}
                    </div>
                  </div>
                </div>
                <div className="settings-card">
                  <div className="settings-card-text">
                    <div className="settings-card-desc">
                      Totals cover this window&apos;s session only (input + output including cache
                      reads, summed across turns). Per-message breakdowns render under each reply
                      in the transcript.
                    </div>
                  </div>
                </div>
                <UsageHistory />
              </>
            )}
          </>
        )}


        {section === "advanced" && (
          <>
            <h2>Advanced</h2>
            <NativeSettingsPanel />
          </>
        )}

        {section === "providers" && (
          <>
            <h2>Providers</h2>
            {providersError ? (
              <div className="settings-empty">
                Start a session to see which model providers are authenticated.
              </div>
            ) : providers === null ? (
              <div className="settings-empty">Loading providers…</div>
            ) : providers.length === 0 ? (
              <div className="settings-empty">No providers configured.</div>
            ) : (
              providers.map((p) => (
                <div key={p.id} className="settings-card">
                  <div className="settings-card-text">
                    <div className="settings-card-title">{p.name}</div>
                    <div className="settings-card-desc">{p.id}</div>
                  </div>
                  <span className={`settings-badge${p.authenticated ? " ok" : ""}`}>
                    {p.authenticated ? "Authenticated" : p.available ? "Not signed in" : "Unavailable"}
                  </span>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

type UsageEntry = { title?: string; cwd?: string; mtimeMs?: number; tokens: number; cost: number };

function ageLabel(ms: number | undefined): string {
  if (!ms) return "—";
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function projectName(cwd: string | undefined): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function UsageHistory() {
  const [entries, setEntries] = useState<UsageEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<UsageEntry[]>("omp_usage_history")
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (entries === null) return null;
  if (entries.length === 0) {
    return (
      <div className="settings-empty">
        No session usage recorded yet — totals appear here as you run tasks.
      </div>
    );
  }
  const totalTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);

  return (
    <div className="usage-history">
      <div className="settings-group-label">
        Recent sessions · {formatTokens(totalTokens)} tok · {formatCost(totalCost)} total
      </div>
      {entries.map((entry, i) => (
        <div key={i} className="usage-history-row">
          <span className="usage-history-title" title={entry.cwd}>
            {entry.title || projectName(entry.cwd) || "Session"}
          </span>
          <span className="usage-history-project">{projectName(entry.cwd)}</span>
          <span className="usage-history-age">{ageLabel(entry.mtimeMs)}</span>
          <span className="usage-history-tokens">{formatTokens(entry.tokens)}</span>
          <span className="usage-history-cost">{formatCost(entry.cost)}</span>
        </div>
      ))}
    </div>
  );
}
