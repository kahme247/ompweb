// useRouter and useSearchParams over the shared native history owner.
import { useMemo, useSyncExternalStore } from "react";
import {
  browserBack, browserForward, getBrowserSearch, navigateBrowser, subscribeBrowserHistory,
} from "./browser-history";

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribeBrowserHistory, getBrowserSearch);
  return useMemo(() => new URLSearchParams(search), [search]);
}

const router = {
  push: (url: string) => navigateBrowser(url, false),
  replace: (url: string) => navigateBrowser(url, true),
  back: browserBack,
  forward: browserForward,
};

export function useRouter() {
  return router;
}
