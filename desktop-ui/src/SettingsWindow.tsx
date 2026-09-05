import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Minus, Square, X } from "lucide-react";
import { SettingsView } from "./SettingsView";
import type { LoginProvider } from "./SettingsView";
import { useTheme } from "@/hooks/useTheme";

const appWindow = getCurrentWindow();

/** Standalone settings window: frameless chrome (Back + window controls)
 * around the shared SettingsView. Back and X both close the window. */
export function SettingsWindow() {
  useTheme();

  const close = useCallback(() => {
    void appWindow.close();
  }, []);

  return (
    <div className="desktop-app">
      <div className="desktop-main">
        <header className="desktop-titlebar" data-tauri-drag-region>
          <button className="settings-back" onClick={close}>
            <ArrowLeft size={14} aria-hidden />
            Back
          </button>
          <div className="titlebar-drag" data-tauri-drag-region />
          <div className="titlebar-controls">
            <button className="titlebar-btn" onClick={() => void appWindow.minimize()} title="Minimize">
              <Minus size={14} aria-hidden />
            </button>
            <button className="titlebar-btn" onClick={() => void appWindow.toggleMaximize()} title="Maximize">
              <Square size={11} aria-hidden />
            </button>
            <button className="titlebar-btn titlebar-close" onClick={close} title="Close">
              <X size={14} aria-hidden />
            </button>
          </div>
        </header>
        <SettingsView
          onBack={close}
          providersLoader={() =>
            invoke<{ providers?: LoginProvider[] }>("omp_providers").then((res) =>
              Array.isArray(res.providers) ? res.providers : [],
            )
          }
        />
      </div>
    </div>
  );
}
