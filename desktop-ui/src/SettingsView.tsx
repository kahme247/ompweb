import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, KeyRound, Palette, SlidersHorizontal } from "lucide-react";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";

type ShellSettings = { notifyOnAgentEnd: boolean; closeToTray: boolean };

type LoginProvider = { id: string; name: string; available: boolean; authenticated: boolean };

const STORAGE_KEY = "omp-desktop-settings";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "providers", label: "Providers", icon: KeyRound },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

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
  rpc: <T>(command: Record<string, unknown>) => Promise<T>;
  sessionReady: boolean;
};

export function SettingsView({ onBack, rpc, sessionReady }: SettingsViewProps) {
  const { preference, setTheme } = useTheme();
  const [section, setSection] = useState<SectionId>("general");
  const [shell, setShell] = useState<ShellSettings>({ notifyOnAgentEnd: true, closeToTray: true });
  const [providers, setProviders] = useState<LoginProvider[] | null>(null);

  useEffect(() => {
    invoke<ShellSettings>("omp_shell_settings")
      .then(setShell)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (section !== "providers" || !sessionReady) return;
    rpc<{ providers?: LoginProvider[] }>({ type: "get_login_providers" })
      .then((res) => setProviders(Array.isArray(res.providers) ? res.providers : []))
      .catch(() => setProviders(null));
  }, [section, sessionReady, rpc]);

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
                <div className="settings-card-desc">Light, dark, or follow the system</div>
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
          </>
        )}

        {section === "providers" && (
          <>
            <h2>Providers</h2>
            {!sessionReady ? (
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
