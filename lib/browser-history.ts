const HISTORY_KEY = "__ompViewHistory";
const STORAGE_KEY = "omp-view-history";

type Entry = { id: string; position: number; guard: boolean; previous: boolean };
type ExitGuard = {
  isDirty: () => boolean;
  confirm: () => void;
  reset: () => void;
  nativeBack: () => void;
};

function entryFrom(state: unknown): Entry | undefined {
  const entry = (state as Record<string, unknown> | null)?.[HISTORY_KEY] as Entry | undefined;
  return entry && typeof entry.id === "string" && Number.isInteger(entry.position)
    && typeof entry.guard === "boolean" && entry.position >= (entry.guard ? -1 : 0) && typeof entry.previous === "boolean"
    ? entry : undefined;
}

// Only entry positions are persisted; the browser owns every URL and view.
class BrowserHistory {
  readonly listeners = new Set<() => void>();
  readonly id: string;
  readonly previous: boolean;
  position: number;
  end: number;
  search = window.location.search;
  exitGuard: ExitGuard | null = null;
  exitAllowed = false;
  pending: "step" | "confirm" | "leave" | "fallback" | "recover" | null = null;
  queued: { url: string; replace: boolean } | null = null;

  constructor() {
    const entry = entryFrom(window.history.state);
    this.id = entry?.id ?? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    this.previous = entry?.previous
      ?? ((window as Window & { navigation?: { canGoBack: boolean } }).navigation?.canGoBack
        ?? window.history.length > 1);
    this.position = entry && !entry.guard ? entry.position : 0;
    this.end = this.position;
    let exiting = false;
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
      if (stored?.id === this.id) {
        if (Number.isInteger(stored.end)) this.end = Math.max(this.position, stored.end);
        // Entries from before a reload belong to another document, so Back or
        // Leave onto the guard loads it afresh instead of firing popstate. A
        // last live in-app position tells that exit apart from Forward re-entry.
        // shortcut: a history-menu jump past the guard leaves that position set, so a later Forward onto the guard exits again; use navigation.activation once Safari and Firefox ship it.
        exiting = Boolean(entry?.guard) && Number.isInteger(stored.at) && stored.at >= 0;
      }
    } catch { /* Private browsing can disable storage. */ }
    if (!entry) {
      this.write(-1, true, false);
      this.write(0, false, true);
    }
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener("pageshow", this.onPageShow);
    if (!entry?.guard) {
      this.persist();
    } else if (exiting && this.previous) {
      // Unload already ran the draft prompt (beforeunload), or Leave authorized it.
      this.persist(-1);
      window.history.back();
    } else {
      // A direct launch has nowhere to go back to: ask an installed shell to
      // close, and restore the app view if it refuses.
      if (exiting && window.matchMedia?.("(display-mode: standalone)").matches) window.close();
      this.pending = "recover";
      window.history.forward();
    }
  }

  private write(position: number, guard: boolean, push: boolean, url = window.location.href) {
    const entry: Entry = { id: this.id, position, guard, previous: this.previous };
    window.history[push ? "pushState" : "replaceState"]({
      ...window.history.state, [HISTORY_KEY]: entry,
    }, "", url);
  }

  private persist(at = this.position) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: this.id, end: this.end, at }));
    } catch { /* History still works without reloadable forward bounds. */ }
  }

  private publish() {
    for (const notify of this.listeners) notify();
  }

  navigate(url: string, replace: boolean) {
    const href = new URL(url, window.location.href).href;
    if (this.pending) {
      this.queued = { url: href, replace };
      return;
    }
    if (href === window.location.href) return;
    const position = this.position + (replace ? 0 : 1);
    this.write(position, false, !replace, href);
    this.position = position;
    if (!replace) this.end = position;
    this.persist();
    this.search = window.location.search;
    this.exitAllowed = false;
    this.exitGuard?.reset();
    this.publish();
  }

  private finishExit() {
    if (this.previous) {
      this.persist(-1);
      window.history.back();
    } else {
      // A direct-launch root cannot go back. Restore its view before asking
      // an installed shell to close, so refusal leaves the composer intact.
      this.pending = "fallback";
      window.history.forward();
    }
  }

  private onPopState = (event: PopStateEvent) => {
    const entry = entryFrom(event.state) ?? (event.state === null && !this.pending ? this.adoptNativeEntry() : undefined);
    if (!entry || entry.id !== this.id) return;
    if (entry.guard) {
      if (this.pending === "leave") {
        this.pending = null;
        this.finishExit();
      } else if (!this.exitAllowed && this.exitGuard?.isDirty()) {
        this.pending = "confirm";
        // Reuse the forward entry: pushing here would destroy forward views
        // and can make Chromium skip this document on the next native Back.
        window.history.go(this.position + 1);
      } else {
        this.finishExit();
      }
      return;
    }
    const pending = this.pending;
    this.pending = null;
    this.position = entry.position;
    this.persist();
    this.search = window.location.search;
    if (pending === "confirm") {
      this.exitGuard?.confirm();
    } else if (pending === "fallback") {
      if (window.matchMedia?.("(display-mode: standalone)").matches) {
        window.close();
        this.exitGuard?.nativeBack();
      }
    } else {
      this.exitAllowed = false;
      this.exitGuard?.reset();
    }
    this.publish();
    const queued = this.queued;
    this.queued = null;
    if (queued) this.navigate(queued.url, queued.replace);
    releaseHistory();
  };

  // A fragment link (the skip link, a heading anchor) pushes a stateless entry
  // after the current one; give it the next position so traversal stays managed.
  // shortcut: an unmanaged entry reached by a traversal popstate this owner missed stays ignored; adopt it too if that ever happens.
  private adoptNativeEntry() {
    this.write(this.position + 1, false, false);
    this.end = this.position + 1;
    return entryFrom(window.history.state);
  }

  private onPageShow = () => {
    this.exitAllowed = false;
    this.exitGuard?.reset();
    const entry = entryFrom(window.history.state);
    if (entry?.id === this.id && entry.guard) {
      this.pending = "recover";
      window.history.forward();
    }
  };

  leave() {
    this.exitAllowed = true;
    this.pending = "leave";
    window.history.go(-this.position - 1);
  }

  dispose() {
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("pageshow", this.onPageShow);
  }
}

let owner: BrowserHistory | undefined;
const getHistory = () => (owner ??= new BrowserHistory());
function releaseHistory() {
  if (owner && !owner.listeners.size && !owner.exitGuard && !owner.pending) {
    owner.dispose();
    owner = undefined;
  }
}

export function subscribeBrowserHistory(notify: () => void) {
  const history = getHistory();
  history.listeners.add(notify);
  return () => {
    history.listeners.delete(notify);
    releaseHistory();
  };
}

export const getBrowserSearch = () => owner?.search ?? window.location.search;
export const getBrowserHistoryBounds = () => owner
  ? Number(owner.position > 0) | (Number(owner.position < owner.end) << 1) : 0;

export function navigateBrowser(url: string, replace: boolean) {
  if (!owner && new URL(url, window.location.href).href === window.location.href) return;
  getHistory().navigate(url, replace);
}
export function browserBack() {
  if (owner && owner.position > 0 && !owner.pending) {
    owner.pending = "step";
    window.history.back();
  }
}
export function browserForward() {
  if (owner && owner.position < owner.end && !owner.pending) {
    owner.pending = "step";
    window.history.forward();
  }
}

export function registerBrowserExitGuard(guard: ExitGuard) {
  const history = getHistory();
  history.exitGuard = guard;
  return () => {
    if (history.exitGuard === guard) history.exitGuard = null;
    releaseHistory();
  };
}
export const browserExitAllowed = () => owner?.exitAllowed ?? false;
export function resetBrowserExitAuthorization() {
  if (owner) owner.exitAllowed = false;
}
export function leaveBrowserHistory() {
  getHistory().leave();
}
