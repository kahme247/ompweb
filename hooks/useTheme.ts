"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system" | "omp";
export type Theme = "light" | "dark" | "omp";

const STORAGE_KEY = "omp-theme";
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function storedPreference(): ThemePreference {
  if (typeof window === "undefined") return "omp";
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "omp") return value;
    if (value === "system") {
      // One-time migration: "system" predates the omp base theme (it was the
      // old implicit default). Persist the upgrade so pre-paint agrees.
      try {
        localStorage.setItem(STORAGE_KEY, "omp");
      } catch {
        // Migration remains in-memory when storage is unavailable.
      }
      return "omp";
    }
    return "omp";
  } catch {
    return "omp";
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark = false): Theme {
  if (preference === "omp") return "omp";
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return preference === "light" ? "dark" : preference === "dark" ? "omp" : preference === "omp" ? "system" : "light";
}

function applyTheme(preference: ThemePreference): void {
  const theme = resolveTheme(preference, window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("omp", theme === "omp");
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Theme selection remains usable when storage is unavailable.
  }
  listeners.forEach((cb) => cb());
}

function getServerSnapshot(): ThemePreference {
  return "omp";
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
  // the initial client tree identical to the server's omp snapshot.
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
  // Heal the DOM class on mount: stored preferences can predate the current
  // default (migration above), and pre-paint only runs on full page loads —
  // without this, hot-reloaded windows keep stale classes until restarted.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = resolveTheme(preference, window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", current === "dark");
    document.documentElement.classList.toggle("omp", current === "omp");
  }, [preference]);

  useEffect(() => {
    if (preference !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.classList.toggle("dark", media.matches);
      document.documentElement.classList.remove("omp");
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

  return { theme, preference, isDark: theme !== "light", setTheme, toggleTheme };
}
