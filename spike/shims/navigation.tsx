// Spike shim for the two next/navigation hooks AppShell uses (useRouter().replace, useSearchParams).
import { useMemo, useSyncExternalStore } from "react";

const EVENT = "spike:navigate";
const subscribe = (notify: () => void) => {
  addEventListener("popstate", notify);
  addEventListener(EVENT, notify);
  return () => {
    removeEventListener("popstate", notify);
    removeEventListener(EVENT, notify);
  };
};

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => location.search);
  return useMemo(() => new URLSearchParams(search), [search]);
}

const navigate = (method: "pushState" | "replaceState") => (url: string) => {
  history[method](history.state, "", url);
  dispatchEvent(new Event(EVENT));
};
const router = { replace: navigate("replaceState"), push: navigate("pushState"), back: () => history.back(), refresh: () => location.reload() };

export function useRouter() {
  return router;
}
