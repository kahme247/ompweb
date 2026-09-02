"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type UiScalePreference = "compact" | "standard" | "comfortable" | "large";

export const STORAGE_KEY = "omp-ui-scale";
export const DEFAULT_UI_SCALE: UiScalePreference = "standard";
export const UI_SCALE_CHANGE_EVENT = "omp-ui-scale-change";

const VALID_UI_SCALES: ReadonlySet<string> = new Set<UiScalePreference>([
  "compact",
  "standard",
  "comfortable",
  "large",
]);

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notifyListeners(): void {
  listeners.forEach((cb) => cb());
}

export function storedUiScalePreference(): UiScalePreference {
  if (typeof window === "undefined") return DEFAULT_UI_SCALE;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && VALID_UI_SCALES.has(value) ? (value as UiScalePreference) : DEFAULT_UI_SCALE;
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

export function resolveUiScaleFactor(preference: UiScalePreference): number {
  switch (preference) {
    case "compact":
      return 0.9;
    case "standard":
      return 1.0;
    case "comfortable":
      return 1.1;
    case "large":
      return 1.2;
    default:
      return 1.0;
  }
}

export function resolveUiScalePercent(preference: UiScalePreference): number {
  switch (preference) {
    case "compact":
      return 90;
    case "standard":
      return 100;
    case "comfortable":
      return 110;
    case "large":
      return 120;
    default:
      return 100;
  }
}

export function nextUiScalePreference(current: UiScalePreference): UiScalePreference {
  switch (current) {
    case "compact":
      return "standard";
    case "standard":
      return "comfortable";
    case "comfortable":
      return "large";
    case "large":
      return "compact";
    default:
      return DEFAULT_UI_SCALE;
  }
}

export function applyUiScale(preference: UiScalePreference): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-ui-scale", preference);
  }
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Storage selection remains usable when localStorage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(UI_SCALE_CHANGE_EVENT, { detail: preference }));
  }
  notifyListeners();
}

function getServerSnapshot(): UiScalePreference {
  return DEFAULT_UI_SCALE;
}

export function useUiScale() {
  const uiScale = useSyncExternalStore(subscribe, storedUiScalePreference, getServerSnapshot);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        notifyListeners();
      }
    };

    const handleCustomEvent = () => {
      notifyListeners();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(UI_SCALE_CHANGE_EVENT, handleCustomEvent);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(UI_SCALE_CHANGE_EVENT, handleCustomEvent);
    };
  }, []);

  const setUiScale = useCallback((next: UiScalePreference) => {
    applyUiScale(next);
  }, []);

  const nextUiScale = useCallback(() => {
    applyUiScale(nextUiScalePreference(uiScale));
  }, [uiScale]);

  return {
    uiScale,
    setUiScale,
    nextUiScale,
    scaleFactor: resolveUiScaleFactor(uiScale),
    scalePercent: resolveUiScalePercent(uiScale),
  };
}
