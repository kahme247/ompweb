"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type DesktopMinimapMode = "rail" | "fab" | "off";

export interface ChatMinimapPreferenceState {
  desktopMode: DesktopMinimapMode;
  mobileFab: boolean;
}

export const STORAGE_KEY_DESKTOP = "omp-minimap-desktop";
export const STORAGE_KEY_MOBILE_FAB = "omp-minimap-mobile-fab";
export const MINIMAP_PREF_CHANGE_EVENT = "omp-minimap-pref-change";

export const DEFAULT_DESKTOP_MODE: DesktopMinimapMode = "rail";
export const DEFAULT_MOBILE_FAB = false;

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

const SERVER_SNAPSHOT: ChatMinimapPreferenceState = Object.freeze({
  desktopMode: DEFAULT_DESKTOP_MODE,
  mobileFab: DEFAULT_MOBILE_FAB,
});

let cachedSnapshot: ChatMinimapPreferenceState = { ...SERVER_SNAPSHOT };

export function storedChatMinimapPreference(): ChatMinimapPreferenceState {
  if (typeof window === "undefined") {
    return SERVER_SNAPSHOT;
  }
  try {
    const rawDesktop = window.localStorage.getItem(STORAGE_KEY_DESKTOP);
    const desktopMode: DesktopMinimapMode =
      rawDesktop === "rail" || rawDesktop === "fab" || rawDesktop === "off"
        ? rawDesktop
        : DEFAULT_DESKTOP_MODE;

    const rawMobile = window.localStorage.getItem(STORAGE_KEY_MOBILE_FAB);
    const mobileFab = rawMobile !== null ? rawMobile === "true" : DEFAULT_MOBILE_FAB;

    if (
      cachedSnapshot.desktopMode === desktopMode &&
      cachedSnapshot.mobileFab === mobileFab
    ) {
      return cachedSnapshot;
    }

    cachedSnapshot = { desktopMode, mobileFab };
    return cachedSnapshot;
  } catch {
    return cachedSnapshot;
  }
}

export function saveChatMinimapPreference(updates: {
  desktopMode?: DesktopMinimapMode;
  mobileFab?: boolean;
}): void {
  const current = storedChatMinimapPreference();
  const nextDesktop = updates.desktopMode ?? current.desktopMode;
  const nextMobile = updates.mobileFab !== undefined ? updates.mobileFab : current.mobileFab;

  if (typeof window !== "undefined") {
    try {
      if (updates.desktopMode !== undefined) {
        window.localStorage.setItem(STORAGE_KEY_DESKTOP, nextDesktop);
      }
      if (updates.mobileFab !== undefined) {
        window.localStorage.setItem(STORAGE_KEY_MOBILE_FAB, String(nextMobile));
      }
    } catch {
      // storage unavailable
    }
    window.dispatchEvent(
      new CustomEvent(MINIMAP_PREF_CHANGE_EVENT, {
        detail: { desktopMode: nextDesktop, mobileFab: nextMobile },
      }),
    );
  }

  cachedSnapshot = { desktopMode: nextDesktop, mobileFab: nextMobile };
  notifyListeners();
}

export function useChatMinimapPreference(): {
  desktopMode: DesktopMinimapMode;
  mobileFab: boolean;
  setDesktopMode: (mode: DesktopMinimapMode) => void;
  setMobileFab: (enabled: boolean) => void;
} {
  const state = useSyncExternalStore(
    subscribe,
    storedChatMinimapPreference,
    () => SERVER_SNAPSHOT,
  );

  useEffect(() => {
    const handleCustom = (e: Event) => {
      const customEvent = e as CustomEvent<{ desktopMode?: DesktopMinimapMode; mobileFab?: boolean }>;
      if (customEvent.detail) {
        cachedSnapshot = {
          desktopMode: customEvent.detail.desktopMode ?? cachedSnapshot.desktopMode,
          mobileFab: customEvent.detail.mobileFab ?? cachedSnapshot.mobileFab,
        };
        notifyListeners();
      }
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_DESKTOP || e.key === STORAGE_KEY_MOBILE_FAB) {
        notifyListeners();
      }
    };
    window.addEventListener(MINIMAP_PREF_CHANGE_EVENT, handleCustom);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(MINIMAP_PREF_CHANGE_EVENT, handleCustom);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const setDesktopMode = useCallback((mode: DesktopMinimapMode) => {
    saveChatMinimapPreference({ desktopMode: mode });
  }, []);

  const setMobileFab = useCallback((enabled: boolean) => {
    saveChatMinimapPreference({ mobileFab: enabled });
  }, []);

  return {
    desktopMode: state.desktopMode,
    mobileFab: state.mobileFab,
    setDesktopMode,
    setMobileFab,
  };
}
