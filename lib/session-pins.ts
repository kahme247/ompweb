import type { SessionInfo } from "./types";

// ============================================================================
// Pinned sessions — pure helpers shared by the server registry
// (lib/session-pin-registry.ts) and the sidebar.
//
// Pins are an ordered list of session ids: the first id is the top row of the
// sidebar's Pinned group, and a newly pinned session joins the end of the
// group, like pinned workspaces. Ids are omp session ids, so a pin survives a
// rename, a restart, and the session moving between workspaces.
// ============================================================================

/** Upper bound on stored pins; a hand-edited or runaway file cannot grow the
 *  sidebar (or the session-list response) without limit. */
export const MAX_SESSION_PINS = 200;

/** Parse the pin file; missing, corrupt, or foreign-shaped input yields no
 *  pins. Non-string and blank ids are dropped and duplicates collapse to their
 *  first position. */
export function parseSessionPins(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !("pins" in parsed)) return [];
  const list = parsed.pins;
  if (!Array.isArray(list)) return [];
  const pins: string[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pins.push(id);
    if (pins.length >= MAX_SESSION_PINS) break;
  }
  return pins;
}

/** The pin list after pinning (appended last; an already pinned id keeps its
 *  place) or unpinning (removed) one session. Returns the same array when
 *  nothing changes, so callers can skip a write. */
export function withSessionPinned(pins: readonly string[], id: string, pinned: boolean): readonly string[] {
  const index = pins.indexOf(id);
  if (pinned) return index === -1 ? [...pins, id] : pins;
  return index === -1 ? pins : pins.filter((pin) => pin !== id);
}

/** Undo one optimistic pin toggle: give `id` back the pinned state it had in
 *  `before`, leaving every other entry of `current` as is (other toggles may
 *  have landed meanwhile). A restored pin returns to its old place: right
 *  after the nearest pin that preceded it and is still pinned. */
export function restoreSessionPin(current: readonly string[], before: readonly string[], id: string): readonly string[] {
  const index = before.indexOf(id);
  if (index === -1) return withSessionPinned(current, id, false);
  if (current.includes(id)) return current;
  for (let previous = index - 1; previous >= 0; previous--) {
    const at = current.indexOf(before[previous]);
    if (at !== -1) return [...current.slice(0, at + 1), id, ...current.slice(at + 1)];
  }
  return [id, ...current];
}

/** Split sessions into the sidebar's Pinned group (in pin order; pins whose
 *  session is gone are skipped) and the rest (input order kept). */
export function partitionPinnedSessions(
  sessions: readonly SessionInfo[],
  pinnedIds: readonly string[],
): { pinned: SessionInfo[]; rest: SessionInfo[] } {
  if (pinnedIds.length === 0) return { pinned: [], rest: [...sessions] };
  const byId = new Map(sessions.map((session) => [session.id, session] as const));
  const pinned: SessionInfo[] = [];
  const pinnedSet = new Set<string>();
  for (const id of pinnedIds) {
    const session = byId.get(id);
    if (!session || pinnedSet.has(id)) continue;
    pinnedSet.add(id);
    pinned.push(session);
  }
  return { pinned, rest: sessions.filter((session) => !pinnedSet.has(session.id)) };
}
