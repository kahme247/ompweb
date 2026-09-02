"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type FontSizePreference = "sm" | "md" | "lg" | "xl";

export const STORAGE_KEY = "omp-font-size";
export const DEFAULT_FONT_SIZE: FontSizePreference = "md";
export const FONT_SIZE_CHANGE_EVENT = "omp-font-size-change";

const VALID_FONT_SIZES: ReadonlySet<string> = new Set<FontSizePreference>(["sm", "md", "lg", "xl"]);

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notifyListeners(): void {
  listeners.forEach((cb) => cb());
}

export function storedFontSizePreference(): FontSizePreference {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && VALID_FONT_SIZES.has(value) ? (value as FontSizePreference) : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

export function resolveFontSizePx(preference: FontSizePreference): number {
  switch (preference) {
    case "sm":
      return 13;
    case "md":
      return 14;
    case "lg":
      return 16;
    case "xl":
      return 18;
    default:
      return 14;
  }
}

export function nextFontSizePreference(current: FontSizePreference): FontSizePreference {
  switch (current) {
    case "sm":
      return "md";
    case "md":
      return "lg";
    case "lg":
      return "xl";
    case "xl":
      return "sm";
    default:
      return DEFAULT_FONT_SIZE;
  }
}

export function applyFontSize(preference: FontSizePreference): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-font-size", preference);
  }
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Storage selection remains usable when localStorage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(FONT_SIZE_CHANGE_EVENT, { detail: preference }));
  }
  notifyListeners();
}

function getServerSnapshot(): FontSizePreference {
  return DEFAULT_FONT_SIZE;
}

export function useFontSize() {
  const fontSize = useSyncExternalStore(subscribe, storedFontSizePreference, getServerSnapshot);

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
    window.addEventListener(FONT_SIZE_CHANGE_EVENT, handleCustomEvent);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(FONT_SIZE_CHANGE_EVENT, handleCustomEvent);
    };
  }, []);

  const setFontSize = useCallback((next: FontSizePreference) => {
    applyFontSize(next);
  }, []);

  const nextFontSize = useCallback(() => {
    applyFontSize(nextFontSizePreference(fontSize));
  }, [fontSize]);

  return {
    fontSize,
    setFontSize,
    nextFontSize,
    fontSizePx: resolveFontSizePx(fontSize),
  };
}
