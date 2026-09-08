import { watch, type FSWatcher } from "fs";
import { join } from "path";
import {
  getAgentDir,
  invalidateSessionEntriesCache,
  invalidateSessionListCache,
  invalidateSessionListMeta,
  listAllSessions,
  resolveSessionIdByPath,
} from "./session-reader";

// omp owns the writes to a session's JSONL. ompweb streams RPC events only for
// the sessions it spawned itself, so a session started outside the web UI — by
// `omp` in a terminal, or by a harness that launches omp — never updated while
// it was open: the file grew and nothing told the browser. This watches the
// session tree and reports which session ids changed, which the running-events
// stream forwards to the client.

type Listener = (sessionIds: string[]) => void;

const DEBOUNCE_MS = 250;

const listeners = new Set<Listener>();
let watcher: FSWatcher | null = null;
let pendingPaths = new Set<string>();
let pendingUnknown = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = 5000;

function flush(): void {
  flushTimer = null;
  const paths = [...pendingPaths];
  pendingPaths = new Set();
  const hadUnknown = pendingUnknown;
  pendingUnknown = false;
  if (paths.length === 0 && !hadUnknown) return;

  if (hadUnknown) {
    // filename was null — fs.watch coalesced the event or overflowed. We
    // don't know which file changed, so fall back to the full invalidation.
    invalidateSessionListCache();
    void rescanAndNotify();
    return;
  }

  // Known paths: refresh the list metadata (a changed file means the cached
  // list's mtimes and message counts are stale) and invalidate ONLY the
  // changed sessions' parse caches, leaving unrelated sessions cached.
  invalidateSessionListMeta();
  for (const path of paths) invalidateSessionEntriesCache(path);

  void Promise.all(paths.map((path) => resolveSessionIdByPath(path).catch(() => undefined)))
    .then((ids) => {
      const sessionIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
      if (sessionIds.length === 0) return;
      for (const listener of listeners) {
        try {
          listener(sessionIds);
        } catch {
          // a failing subscriber must not stop the others
        }
      }
    })
    .catch(() => {
      // resolution failures are not worth tearing the watcher down for
    });
}

async function rescanAndNotify(): Promise<void> {
  try {
    const sessions = await listAllSessions();
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length === 0) return;
    for (const listener of listeners) {
      try {
        listener(sessionIds);
      } catch {
        // a failing subscriber must not stop the others
      }
    }
  } catch {
    // resolution failures are not worth tearing the watcher down for
  }
}

function scheduleRetry(): void {
  if (retryTimer || listeners.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureWatcher();
  }, RETRY_MS);
}

function ensureWatcher(): void {
  if (watcher || retryTimer) return;
  const sessionsDir = join(getAgentDir(), "sessions");
  try {
    watcher = watch(sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) {
        pendingUnknown = true;
        if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      pendingPaths.add(join(sessionsDir, name));
      if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
      scheduleRetry();
    });
  } catch {
    // No sessions directory yet, or the platform refused a recursive watch.
    // Schedule a retry while subscribers remain; otherwise degrade silently.
    watcher = null;
    scheduleRetry();
  }
}

export function subscribeSessionFileChanges(listener: Listener): () => void {
  listeners.add(listener);
  ensureWatcher();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    pendingPaths = new Set();
    pendingUnknown = false;
    watcher?.close();
    watcher = null;
  };
}
