// useRouter and useSearchParams (the two hooks AppShell uses), over the History API.
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

const router = {
  replace: (url: string) => {
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new Event(EVENT));
  },
};

export function useRouter() {
  return router;
}
