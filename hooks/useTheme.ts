"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
type Theme = "light" | "dark";

const STORAGE_KEY = "omp-theme";
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function storedPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark = false): Theme {
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return preference === "light" ? "dark" : preference === "dark" ? "system" : "light";
}

function applyTheme(preference: ThemePreference): void {
  const dark = resolveTheme(preference, window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Theme selection remains usable when storage is unavailable.
  }
  listeners.forEach((cb) => cb());
}

function getServerSnapshot(): ThemePreference {
  return "system";
}

type ToggleOrigin = { x: number; y: number };
function motionDurationMs(variable: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (raw.endsWith("ms")) {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  }
  if (raw.endsWith("s")) {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value * 1000 : fallback;
  }
  return fallback;
}


export function useTheme() {
  const preference = useSyncExternalStore(subscribe, storedPreference, getServerSnapshot);
  // The OS preference is browser-only. Deferring it until after hydration keeps
  // the initial client tree identical to the server's system/light snapshot.
  const [hydrated, setHydrated] = useState(false);
  const [osDark, setOsDark] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  // Track the OS color scheme in state so an OS light/dark flip changes the
  // snapshot and re-renders isDark consumers, even when the stored preference
  // itself ("system") is unchanged. Registered unconditionally at subscription
  // time: consumers on an explicit light/dark preference still keep osDark
  // fresh for when they switch back to system.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setOsDark(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  const prefersDark = hydrated && osDark;
  const theme = resolveTheme(preference, prefersDark);

  // Keep the DOM class in sync on an OS flip while the user is on "system"
  // (setTheme/applyTheme own the class for explicit choices).
  useEffect(() => {
    if (preference !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.classList.toggle("dark", media.matches);
    };
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setTheme = useCallback((next: ThemePreference, origin?: ToggleOrigin) => {
    const apply = () => applyTheme(next);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";
    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(apply);
    transition.ready.then(() => {
      const styles = getComputedStyle(document.documentElement);
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] }, {
        duration: motionDurationMs("--dur-theme", 450),
        easing: styles.getPropertyValue("--ease-out-warm").trim() || "ease-out",
        pseudoElement: "::view-transition-new(root)",
      });
    }).catch(() => {});
    transition.finished?.catch(() => {});
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => setTheme(nextThemePreference(preference), origin), [preference, setTheme]);

  return { theme, preference, isDark: theme === "dark", setTheme, toggleTheme };
}
