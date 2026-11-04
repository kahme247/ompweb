/**
 * Client-side connection diagnostics preference (localStorage). Per browser,
 * like the other ompweb UI preferences in composer-prefs.ts.
 */

import { useSyncExternalStore } from "react";

const CONNECTION_DIAGNOSTICS_KEY = "omp-web:connection-diagnostics";

/** Dispatched on `window` by the setter so mounted readers update without a reload. */
export const CONNECTION_DIAGNOSTICS_EVENT = "omp-web:connection-diagnostics";
/** The choice of this page load when storage refused to keep it; null once storage holds the choice. */
let unsaved: boolean | null = null;

export function getConnectionDiagnosticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (unsaved !== null) return unsaved;
  try {
    return window.localStorage.getItem(CONNECTION_DIAGNOSTICS_KEY) === "on";
  } catch {
    // storage unavailable — diagnostics stay off
    return false;
  }
}

export function setConnectionDiagnosticsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONNECTION_DIAGNOSTICS_KEY, on ? "on" : "off");
    unsaved = null;
  } catch {
    // storage unavailable — keep the choice for this page load
    unsaved = on;
  }
  window.dispatchEvent(new Event(CONNECTION_DIAGNOSTICS_EVENT));
}

function subscribe(onChange: () => void): () => void {
  // A change in another tab arrives as a `storage` event; `key` is null after clear().
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CONNECTION_DIAGNOSTICS_KEY) onChange();
  };
  window.addEventListener(CONNECTION_DIAGNOSTICS_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CONNECTION_DIAGNOSTICS_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Whether connection diagnostics are on in this browser; follows changes made here or in other tabs. */
export function useConnectionDiagnosticsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getConnectionDiagnosticsEnabled, () => false);
}
