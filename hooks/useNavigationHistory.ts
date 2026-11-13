"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  browserBack, browserForward, getBrowserHistoryBounds, subscribeBrowserHistory,
} from "@/lib/browser-history";

export interface NavigationHistoryController {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

export function useNavigationHistory(): NavigationHistoryController {
  const bounds = useSyncExternalStore(subscribeBrowserHistory, getBrowserHistoryBounds);
  return useMemo(() => ({
    canBack: Boolean(bounds & 1),
    canForward: Boolean(bounds & 2),
    back: browserBack,
    forward: browserForward,
  }), [bounds]);
}
