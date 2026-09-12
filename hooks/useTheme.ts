"use client";

import { createElement, useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type LightTheme = "light" | "one-light" | "catppuccin-latte" | "rose-pine-dawn";
export type DarkTheme =
  | "dark"
  | "omp"
  | "dracula"
  | "harbor"
  | "one-dark-pro"
  | "rose-pine"
  | "catppuccin-mocha"
  | "gruvbox-dark"
  | "nord"
  | "tokyo-night";

export type Theme = LightTheme | DarkTheme;
export type ThemePreference = Theme | "system";

export type ThemeDefinition = {
  id: Theme;
  name: string;
  mode: "light" | "dark";
  bg: string;
  accent: string;
};

export const LIGHT_THEMES: ReadonlyArray<ThemeDefinition> = [
  { id: "light", name: "Light (default)", mode: "light", bg: "#FAF9F6", accent: "#B03E22" },
  { id: "one-light", name: "One Light", mode: "light", bg: "#FAFAFA", accent: "#2F65D9" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", mode: "light", bg: "#EFF1F5", accent: "#1E66F5" },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", mode: "light", bg: "#FAF4ED", accent: "#286983" },
];

export const DARK_THEMES: ReadonlyArray<ThemeDefinition> = [
  { id: "omp", name: "OMP Midnight", mode: "dark", bg: "#000000", accent: "#EC5BAB" },
  { id: "dark", name: "Dark", mode: "dark", bg: "#1B1916", accent: "#E07B54" },
  { id: "dracula", name: "Dracula", mode: "dark", bg: "#282A36", accent: "#FF79C6" },
  { id: "harbor", name: "Harbor", mode: "dark", bg: "#1B1B1B", accent: "#E75A50" },
  { id: "one-dark-pro", name: "One Dark Pro", mode: "dark", bg: "#282C34", accent: "#61AFEF" },
  { id: "rose-pine", name: "Rosé Pine", mode: "dark", bg: "#191724", accent: "#EBBCBA" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", mode: "dark", bg: "#1E1E2E", accent: "#CBA6F7" },
  { id: "gruvbox-dark", name: "Gruvbox Dark", mode: "dark", bg: "#282828", accent: "#FE8019" },
  { id: "nord", name: "Nord", mode: "dark", bg: "#2E3440", accent: "#88C0D0" },
  { id: "tokyo-night", name: "Tokyo Night", mode: "dark", bg: "#1A1B26", accent: "#7AA2F7" },
];

export const ALL_THEMES: ReadonlyArray<ThemeDefinition> = [...LIGHT_THEMES, ...DARK_THEMES];

export function isDarkTheme(theme: Theme): boolean {
  return theme !== "light" && theme !== "one-light" && theme !== "catppuccin-latte" && theme !== "rose-pine-dawn";
}

const VALID_PREFERENCES: Record<string, true> = {
  light: true,
  "one-light": true,
  "catppuccin-latte": true,
  "rose-pine-dawn": true,
  dark: true,
  omp: true,
  dracula: true,
  harbor: true,
  "one-dark-pro": true,
  "rose-pine": true,
  "catppuccin-mocha": true,
  "gruvbox-dark": true,
  nord: true,
  "tokyo-night": true,
  system: true,
};

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
    if (value && VALID_PREFERENCES[value]) {
      return value as ThemePreference;
    }
    return "omp";
  } catch {
    return "omp";
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark = false): Theme {
  if (preference === "omp") return "omp";
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === "light") return "dark";
  if (preference === "dark") return "omp";
  if (preference === "omp") return "system";
  if (preference === "system") return "light";
  return isDarkTheme(preference as Theme) ? "light" : "dark";
}

export function ThemeColor() {
  // React matches hoisted metadata by content during hydration. Adopt the
  // pre-paint value so it reuses this node instead of adding a fallback copy.
  const color = typeof document === "undefined"
    ? null
    : document.querySelector('meta[name="theme-color"]')?.getAttribute("content");
  return createElement("meta", { name: "theme-color", content: color || "#000000" });
}

export function applyDomTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const dark = isDarkTheme(theme);
  const cl = document.documentElement.classList;
  const toRemove: string[] = [];
  cl.forEach((cls) => {
    if (cls.startsWith("theme-")) toRemove.push(cls);
  });
  toRemove.forEach((cls) => cl.remove(cls));

  cl.toggle("dark", dark && theme !== "omp");
  cl.toggle("omp", theme === "omp");
  if (theme !== "omp") {
    cl.add(`theme-${theme}`);
  }
  document.documentElement.setAttribute("data-theme", theme);
  const color = ALL_THEMES.find((definition) => definition.id === theme)?.bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && color) meta.setAttribute("content", color);
}

function applyTheme(preference: ThemePreference): void {
  const theme = resolveTheme(preference, window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  applyDomTheme(theme);
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
  // default, and pre-paint only runs on full page loads —
  // without this, hot-reloaded windows keep stale classes until restarted.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = resolveTheme(preference, window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    applyDomTheme(current);
  }, [preference]);

  useEffect(() => {
    if (preference !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = resolveTheme("system", media.matches);
      applyDomTheme(current);
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

  return { theme, preference, isDark: isDarkTheme(theme), setTheme, toggleTheme };
}
