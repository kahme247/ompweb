// The two next/navigation hooks AppShell uses (useRouter, useSearchParams), over the History API.
import { useMemo, useSyncExternalStore } from "react";

const EVENT = "omp:navigate";
const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener(EVENT, notify);
  };
};

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return useMemo(() => new URLSearchParams(search), [search]);
}

const navigate = (method: "pushState" | "replaceState") => (url: string) => {
  window.history[method](window.history.state, "", url);
  window.dispatchEvent(new Event(EVENT));
};
const router = {
  replace: navigate("replaceState"),
  push: navigate("pushState"),
  back: () => window.history.back(),
  refresh: () => window.location.reload(),
};

export function useRouter() {
  return router;
}
