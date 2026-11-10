
const STORAGE_KEY = "omp-web:last-open-by-project";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readEntries(storage: StorageLike): Record<string, string> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, id]) => typeof id === "string" && id.length > 0)) as Record<string, string>;
  } catch {
    return {};
  }
}

export function workspaceKeyOf(workspace: { cwd?: string; path?: string; projectRoot?: string; projectKey?: string; poolId?: string; projectId?: string }): string {
  if (workspace.poolId && workspace.projectId) return workspace.projectKey ?? `pool:${workspace.poolId}:${workspace.projectId}`;
  return workspace.projectKey ?? workspace.projectRoot ?? workspace.cwd ?? workspace.path ?? "";
}

export function getLastOpenSession(workspace: string, storage: StorageLike | null = browserStorage()): string | null {
  if (!storage) return null;
  return readEntries(storage)[workspace] ?? null;
}

export function setLastOpenSession(workspace: string, sessionId: string, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    const entries = readEntries(storage);
    entries[workspace] = sessionId;
    storage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Workspace restoration is a best-effort convenience.
  }
}

export function clearLastOpenSession(workspace: string, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    const entries = readEntries(storage);
    if (!(workspace in entries)) return;
    delete entries[workspace];
    if (Object.keys(entries).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Workspace restoration is a best-effort convenience.
  }
}
