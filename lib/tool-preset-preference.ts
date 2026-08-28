import { isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = "omp-web:tool-preset";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPreferredToolPreset(storage: StorageLike | null = browserStorage()): ToolPreset {
  if (!storage) return "full";
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : "full";
  } catch {
    return "full";
  }
}

export function setPreferredToolPreset(preset: ToolPreset, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Preferences remain optional when storage is unavailable.
  }
}
