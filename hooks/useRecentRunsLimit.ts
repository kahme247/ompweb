"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type RecentRunsLimitPreset = "10" | "15" | "20" | "custom";

export interface RecentRunsLimitState {
  preset: RecentRunsLimitPreset;
  limit: number;
  customValue: number;
}

export const STORAGE_KEY = "omp-recent-runs-limit";
export const CUSTOM_STORAGE_KEY = "omp-recent-runs-custom-limit";
export const DEFAULT_PRESET: RecentRunsLimitPreset = "10";
export const DEFAULT_LIMIT = 10;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;
export const RECENT_RUNS_LIMIT_CHANGE_EVENT = "omp-recent-runs-limit-change";

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notifyListeners(): void {
  listeners.forEach((cb) => cb());
}

export function clampLimit(val: number): number {
  if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val)) {
    return DEFAULT_LIMIT;
  }
  const rounded = Math.round(val);
  if (rounded < MIN_LIMIT) return MIN_LIMIT;
  if (rounded > MAX_LIMIT) return MAX_LIMIT;
  return rounded;
}

export function resolvePresetLimit(preset: RecentRunsLimitPreset, customVal: number): number {
  switch (preset) {
    case "10":
      return 10;
    case "15":
      return 15;
    case "20":
      return 20;
    case "custom":
      return clampLimit(customVal);
    default:
      return DEFAULT_LIMIT;
  }
}

const SERVER_SNAPSHOT: RecentRunsLimitState = Object.freeze({
  preset: DEFAULT_PRESET,
  limit: DEFAULT_LIMIT,
  customValue: DEFAULT_LIMIT,
});

let cachedSnapshot: RecentRunsLimitState = { ...SERVER_SNAPSHOT };

export function storedRecentRunsLimitState(): RecentRunsLimitState {
  if (typeof window === "undefined") {
    return SERVER_SNAPSHOT;
  }
  try {
    const rawPreset = window.localStorage.getItem(STORAGE_KEY);
    const preset: RecentRunsLimitPreset =
      rawPreset === "10" || rawPreset === "15" || rawPreset === "20" || rawPreset === "custom"
        ? rawPreset
        : DEFAULT_PRESET;

    const rawCustom = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    const parsedCustom = rawCustom !== null ? Number.parseInt(rawCustom, 10) : DEFAULT_LIMIT;
    const customValue = clampLimit(parsedCustom);

    const limit = resolvePresetLimit(preset, customValue);

    if (
      cachedSnapshot.preset === preset &&
      cachedSnapshot.limit === limit &&
      cachedSnapshot.customValue === customValue
    ) {
      return cachedSnapshot;
    }

    cachedSnapshot = { preset, limit, customValue };
    return cachedSnapshot;
  } catch {
    return cachedSnapshot;
  }
}

export function saveRecentRunsLimitState(
  preset?: RecentRunsLimitPreset,
  customValue?: number,
): void {
  const current = storedRecentRunsLimitState();
  const nextPreset = preset ?? current.preset;
  const nextCustom = customValue !== undefined ? clampLimit(customValue) : current.customValue;
  const nextLimit = resolvePresetLimit(nextPreset, nextCustom);

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, nextPreset);
      if (customValue !== undefined) {
        window.localStorage.setItem(CUSTOM_STORAGE_KEY, String(nextCustom));
      }
    } catch {
      // storage unavailable or quota exceeded
    }
    window.dispatchEvent(
      new CustomEvent(RECENT_RUNS_LIMIT_CHANGE_EVENT, {
        detail: { preset: nextPreset, limit: nextLimit, customValue: nextCustom },
      }),
    );
  }

  cachedSnapshot = { preset: nextPreset, limit: nextLimit, customValue: nextCustom };
  notifyListeners();
}

function getServerSnapshot(): RecentRunsLimitState {
  return SERVER_SNAPSHOT;
}

export function useRecentRunsLimit() {
  const state = useSyncExternalStore(subscribe, storedRecentRunsLimitState, getServerSnapshot);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === CUSTOM_STORAGE_KEY) {
        notifyListeners();
      }
    };

    const handleCustomEvent = () => {
      notifyListeners();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECENT_RUNS_LIMIT_CHANGE_EVENT, handleCustomEvent);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECENT_RUNS_LIMIT_CHANGE_EVENT, handleCustomEvent);
    };
  }, []);

  const setPreset = useCallback((preset: RecentRunsLimitPreset) => {
    saveRecentRunsLimitState(preset);
  }, []);

  const setCustomValue = useCallback((customVal: number) => {
    saveRecentRunsLimitState(undefined, customVal);
  }, []);

  return {
    limit: state.limit,
    preset: state.preset,
    customValue: state.customValue,
    setPreset,
    setCustomValue,
  };
}
