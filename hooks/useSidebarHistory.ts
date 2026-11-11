"use client";

import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { hasUnsentDrafts, subscribeDrafts } from "@/lib/draft-store";
import {
  browserExitAllowed, leaveBrowserHistory, registerBrowserExitGuard, resetBrowserExitAuthorization,
} from "@/lib/browser-history";

/** Document-exit protection only; session and sidebar navigation stay native. */
export function useSidebarHistory() {
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const [exitNeedsNativeBack, setExitNeedsNativeBack] = useState(false);
  const subscribe = useCallback((onChange: () => void) => subscribeDrafts(() => {
    // Any new edit revokes permission to discard, even if a shell refused close().
    resetBrowserExitAuthorization();
    setExitNeedsNativeBack(false);
    onChange();
  }), []);
  useSyncExternalStore(subscribe, hasUnsentDrafts, () => false);

  useLayoutEffect(() => registerBrowserExitGuard({
    isDirty: hasUnsentDrafts,
    confirm: () => setExitConfirmationOpen(true),
    reset: () => {
      setExitConfirmationOpen(false);
      setExitNeedsNativeBack(false);
    },
    nativeBack: () => setExitNeedsNativeBack(true),
  }), []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (browserExitAllowed() || !hasUnsentDrafts()) return;
      event.preventDefault();
      event.returnValue = "You have unsent drafts.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const cancelExit = useCallback(() => setExitConfirmationOpen(false), []);
  const leave = useCallback(() => {
    setExitConfirmationOpen(false);
    leaveBrowserHistory();
  }, []);
  return { exitConfirmationOpen, exitNeedsNativeBack, cancelExit, leave };
}
