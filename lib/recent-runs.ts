export interface RecentRunEntry {
  sessionId: string;
  completedAt: number;
}

export const MAX_RECENT_COMPLETED_RUNS = 10;

export function recordCompletedRun(
  current: RecentRunEntry[],
  completedId: string,
  now = Date.now(),
): RecentRunEntry[] {
  const newEntry: RecentRunEntry = { sessionId: completedId, completedAt: now };
  const filtered = current.filter((entry) => entry.sessionId !== completedId);
  return [newEntry, ...filtered].slice(0, MAX_RECENT_COMPLETED_RUNS);
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
