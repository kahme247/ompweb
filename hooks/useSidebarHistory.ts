"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { hasUnsentDrafts, subscribeDrafts } from "@/lib/draft-store";

const HISTORY_KEY = "__ompSidebarHistory";
type SidebarEntry = {
  id: string;
  entry: "base" | "top";
  previous: boolean;
  sidebarOpen: boolean;
};
type HistorySnapshot = { marker: SidebarEntry; state: Record<string, unknown>; href: string };

export function useSidebarHistory({ active, ready, sidebarOpen, setSidebarOpen, url }: {
  active: boolean;
  ready: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  url: string;
}) {
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const [exitNeedsNativeBack, setExitNeedsNativeBack] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const snapshot = useRef<HistorySnapshot | null>(null);
  const pending = useRef<"collapse" | "leave" | null>(null);
  const leaveAllowed = useRef(false);
  const latest = useRef({ active, sidebarOpen, setSidebarOpen });
  latest.current = { active, sidebarOpen, setSidebarOpen };

  const subscribe = useCallback((onChange: () => void) => subscribeDrafts(() => {
    // A new edit invalidates an earlier authorization to discard, including
    // when an installed shell could not close itself after Leave.
    if (leaveAllowed.current) {
      leaveAllowed.current = false;
      setExitNeedsNativeBack(false);
    }
    onChange();
  }), []);
  const dirty = useSyncExternalStore(subscribe, hasUnsentDrafts, () => false);

  const writeEntry = useCallback((entry: SidebarEntry["entry"], open: boolean, push = false) => {
    const current = snapshot.current;
    if (!current) return;
    const marker = { ...current.marker, entry, sidebarOpen: open };
    const state = { ...current.state, [HISTORY_KEY]: marker };
    // Keep Next's router tree and unrelated history state. Sidebar traversal
    // changes neither route nor session, so Next must not restore an older URL.
    window.history[push ? "pushState" : "replaceState"](state, "", current.href);
    snapshot.current = { ...current, state, marker };
  }, []);

  const leaveFromBase = useCallback(() => {
    if (snapshot.current?.marker.previous) {
      window.history.back();
      return;
    }
    // At a direct-launch root history.back() is a no-op, unlike native Android
    // Back. Only an installed shell may be asked to close. Some shells refuse;
    // leave the guard disarmed and tell the user to use native Back once more.
    if (window.matchMedia("(display-mode: standalone)").matches) window.close();
    setExitNeedsNativeBack(true);
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const marker = event.state?.[HISTORY_KEY] as SidebarEntry | undefined;
      if (!marker || marker.id !== snapshot.current?.marker.id) return;
      // Keep owned UI traversals local. The base may predate a session pick;
      // repair its URL/tree without remounting the composer.
      event.stopImmediatePropagation();
      writeEntry(marker.entry, marker.sidebarOpen);
      if (pending.current) {
        const action = pending.current;
        pending.current = null;
        if (action === "leave") {
          leaveFromBase();
        } else if ((latest.current.active && !latest.current.sidebarOpen) || hasUnsentDrafts()) {
          writeEntry("top", latest.current.sidebarOpen, true);
        }
        return;
      }
      if (leaveAllowed.current) return;
      if (marker.entry === "top") {
        latest.current.setSidebarOpen(marker.sidebarOpen);
      } else if (latest.current.active && !latest.current.sidebarOpen) {
        latest.current.setSidebarOpen(true);
        writeEntry("base", true);
        // Reuse the same pair only while content needs an in-app exit guard.
        // pushState from the base replaces the forward entry, never appends
        // another sentinel behind it.
        if (hasUnsentDrafts()) writeEntry("top", true, true);
      } else if (hasUnsentDrafts()) {
        writeEntry("top", true, true);
        setExitConfirmationOpen(true);
      } else {
        leaveFromBase();
      }
    };
    const onPageShow = () => {
      leaveAllowed.current = false;
      setExitNeedsNativeBack(false);
      setRestoreVersion((version) => version + 1);
    };
    window.addEventListener("popstate", onPopState, true);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("popstate", onPopState, true);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [leaveFromBase, writeEntry]);

  useLayoutEffect(() => {
    if (!ready || pending.current) return;
    if (leaveAllowed.current && (!sidebarOpen || snapshot.current?.href !== window.location.href)) {
      leaveAllowed.current = false;
      setExitNeedsNativeBack(false);
    }
    const state = window.history.state ?? {};
    // router.replace can replace custom state. Retain our pair across URL
    // commits; a real reload recovers it from history.state instead.
    const marker: SidebarEntry = state[HISTORY_KEY] ?? snapshot.current?.marker ?? {
      id: crypto.randomUUID(),
      entry: "base",
      previous: (window as Window & { navigation?: { canGoBack: boolean } }).navigation?.canGoBack
        ?? window.history.length > 1,
      sidebarOpen: true,
    };
    snapshot.current = { marker, state, href: window.location.href };
    if (leaveAllowed.current) return;
    const needsTop = (active && !sidebarOpen) || dirty;
    if (needsTop && marker.entry === "base") {
      writeEntry("base", true);
      writeEntry("top", sidebarOpen, true);
    } else if (!needsTop && marker.entry === "top") {
      pending.current = "collapse";
      window.history.back();
    } else {
      writeEntry(marker.entry, sidebarOpen);
    }
  }, [active, ready, sidebarOpen, dirty, url, exitNeedsNativeBack, restoreVersion, writeEntry]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (leaveAllowed.current || !hasUnsentDrafts()) return;
      event.preventDefault();
      event.returnValue = "You have unsent drafts.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const cancelExit = useCallback(() => { setExitConfirmationOpen(false); }, []);
  const leave = useCallback(() => {
    leaveAllowed.current = true;
    setExitConfirmationOpen(false);
    pending.current = "leave";
    // The dialog is on the top entry. Consume our step, then traverse the
    // original history normally; beforeunload must not ask the same question.
    window.history.back();
  }, []);

  return { exitConfirmationOpen, exitNeedsNativeBack, cancelExit, leave };
}
