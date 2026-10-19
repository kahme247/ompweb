export interface RecentRunEntry {
  sessionId: string;
  completedAt: number;
}

export const MAX_RECENT_COMPLETED_RUNS = 10;
export const RECENT_RUNS_STORAGE_KEY = "ompweb.recent-completed-runs";

export function loadRecentRuns(storage?: Storage, maxLimit = 100): RecentRunEntry[] {
  try {
    const s = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!s) return [];
    const raw = s.getItem(RECENT_RUNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentRunEntry =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as RecentRunEntry).sessionId === "string" &&
          typeof (item as RecentRunEntry).completedAt === "number",
      )
      .slice(0, maxLimit);
  } catch {
    return [];
  }
}

export function saveRecentRuns(
  entries: RecentRunEntry[],
  storage?: Storage,
  maxLimit = MAX_RECENT_COMPLETED_RUNS,
): void {
  try {
    const s = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!s) return;
    s.setItem(RECENT_RUNS_STORAGE_KEY, JSON.stringify(entries.slice(0, maxLimit)));
  } catch {
    // quota exceeded or private browsing
  }
}

export function seedRecentRuns(
  allSessions: Array<{ id: string; modified: string; messageCount?: number; firstMessage?: string; name?: string }>,
  limit = MAX_RECENT_COMPLETED_RUNS,
): RecentRunEntry[] {
  return [...allSessions]
    .filter((s) => (s.firstMessage && s.firstMessage !== "(no messages)") || (s.messageCount ?? 0) > 0 || Boolean(s.name))
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
    .slice(0, limit)
    .map((s) => ({
      sessionId: s.id,
      completedAt: new Date(s.modified).getTime() || Date.now(),
    }));
}


export function recordCompletedRun(
  current: RecentRunEntry[],
  completedId: string,
  now = Date.now(),
  maxLimit = MAX_RECENT_COMPLETED_RUNS,
): RecentRunEntry[] {
  const effectiveNow = now ?? Date.now();
  const newEntry: RecentRunEntry = { sessionId: completedId, completedAt: effectiveNow };
  const filtered = current.filter((entry) => entry.sessionId !== completedId);
  return [newEntry, ...filtered].slice(0, maxLimit);
}

export function removeActiveFromCompleted(
  current: RecentRunEntry[],
  activeRunningIds: Set<string>,
): RecentRunEntry[] {
  return current.filter((entry) => !activeRunningIds.has(entry.sessionId));
}

export function extractRecentCompletedSet(entries: RecentRunEntry[]): Set<string> {
  return new Set(entries.map((entry) => entry.sessionId));
}

export function isRecentlyCompleted(entries: RecentRunEntry[], sessionId: string): boolean {
  return entries.some((entry) => entry.sessionId === sessionId);
}
