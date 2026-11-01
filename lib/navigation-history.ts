/**
 * In-app view history for Navigate back / Navigate forward.
 *
 * omp-web deliberately keeps its own stack instead of the browser History
 * API: the app replaces (never pushes) `?session=` URLs, and the mobile
 * back-gesture machinery (`useSidebarHistory` + the popstate bridge) already
 * owns the real history stack. Entries are the main chat views only — a
 * session, or the new-chat composer for a cwd. In-session branches have their
 * own navigator (BranchNavigator) and never appear here.
 */

/** One visited view: a session (by id), or the new-chat composer for a cwd. */
export interface NavigationEntry {
  /** Session id, or null for the new-chat (composer) view. */
  sessionId: string | null;
  /** The view's cwd — the session's cwd, or the new-chat cwd. */
  cwd: string | null;
  /** Host of a new-chat view's cwd; absent for this machine. */
  hostId?: string;
}

export interface NavigationHistory {
  entries: NavigationEntry[];
  /** Index of the currently displayed entry inside `entries`. */
  index: number;
}

/** Match the browser's about:config history cap. Oldest entries drop first. */
export const NAVIGATION_HISTORY_MAX_ENTRIES = 50;

/** -1 = back, 0 = no match, 1 = forward. */
export type NavigateDirection = -1 | 0 | 1;

export function createNavigationHistory(): NavigationHistory {
  return { entries: [], index: -1 };
}

/**
 * Session views compare by id (a session keeps its identity while its cwd
 * metadata refreshes); new-chat views compare by host and cwd.
 */
export function navigationEntriesEqual(a: NavigationEntry, b: NavigationEntry): boolean {
  if (a.sessionId !== b.sessionId) return false;
  if (a.sessionId !== null) return true;
  return (a.cwd ?? null) === (b.cwd ?? null) && a.hostId === b.hostId;
}

export function currentNavigationEntry(history: NavigationHistory): NavigationEntry | null {
  return history.entries[history.index] ?? null;
}

/**
 * Record a visited view. Re-recording the current entry is a no-op (same
 * reference), which is what makes back/forward application self-suppressing:
 * after the index moves onto the target entry, the view-change effect
 * re-records it and pushes nothing. A genuinely new view truncates any
 * forward branch, browser-style.
 */
export function pushNavigationEntry(history: NavigationHistory, entry: NavigationEntry): NavigationHistory {
  if (history.entries.length === 0) {
    return { entries: [entry], index: 0 };
  }
  const current = history.entries[history.index];
  if (current && navigationEntriesEqual(current, entry)) return history;
  const entries = history.entries.slice(0, history.index + 1);
  entries.push(entry);
  if (entries.length > NAVIGATION_HISTORY_MAX_ENTRIES) {
    entries.splice(0, entries.length - NAVIGATION_HISTORY_MAX_ENTRIES);
  }
  return { entries, index: entries.length - 1 };
}

export function canGoNavigationBack(history: NavigationHistory): boolean {
  return history.index > 0;
}

export function canGoNavigationForward(history: NavigationHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/** The entry a step in `direction` would display, without moving. */
export function peekNavigationEntry(history: NavigationHistory, direction: -1 | 1): NavigationEntry | null {
  const next = history.index + direction;
  return next >= 0 && next < history.entries.length ? history.entries[next] : null;
}

/** Move one entry in `direction`; out-of-bounds steps return the input. */
export function stepNavigationHistory(history: NavigationHistory, direction: -1 | 1): NavigationHistory {
  const next = history.index + direction;
  if (next < 0 || next >= history.entries.length) return history;
  return { entries: history.entries, index: next };
}

/**
 * Drop one entry (e.g. its session no longer exists). Used against the
 * peeked neighbor, never the current entry: removing an entry before the
 * cursor shifts the cursor down so it keeps pointing at the same entry.
 */
export function removeNavigationEntryAt(history: NavigationHistory, index: number): NavigationHistory {
  if (index < 0 || index >= history.entries.length) return history;
  const entries = history.entries.filter((_, i) => i !== index);
  let index2 = history.index;
  if (index < history.index) index2 -= 1;
  return { entries, index: Math.min(index2, entries.length - 1) };
}

/** Minimal structural keyboard event — keeps this testable without a DOM. */
export interface NavigationShortcutEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  isComposing?: boolean;
}

/**
 * Does this keyboard event mean "navigate back" (-1) or "forward" (1)?
 *
 * macOS: ⌘[ / ⌘] — the Safari/Finder standard. Alt+Arrow stays free there
 * (it is word-wise caret movement while typing).
 * Windows/Linux: Alt+← / Alt+→ — the platform's back/forward pair in every
 * browser and Explorer. Ctrl+[ / Ctrl+] is accepted as an alias for the
 * physical gesture; on macOS Ctrl+[ is the terminal Esc and stays free.
 * The mouse back/forward buttons arrive as BrowserBack / BrowserForward on
 * every platform. Shift chords are excluded: Cmd+Shift+] switches tabs.
 */
export function navigateShortcutDirection(event: NavigationShortcutEvent, isMac: boolean): NavigateDirection {
  if (event.isComposing) return 0;
  if (event.key === "BrowserBack") return -1;
  if (event.key === "BrowserForward") return 1;
  if ((event.metaKey || (!isMac && event.ctrlKey)) && !event.altKey && !event.shiftKey) {
    if (event.key === "[") return -1;
    if (event.key === "]") return 1;
  }
  if (!isMac && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    if (event.key === "ArrowLeft") return -1;
    if (event.key === "ArrowRight") return 1;
  }
  return 0;
}

/** Best-effort platform probe; false everywhere when not in a browser. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  return /mac/i.test(navigator.platform ?? "") || /Macintosh|iPhone|iPad/i.test(ua);
}

/** Short label for tooltips and menus, e.g. "⌘[" or "Alt+←". */
export function navigateShortcutHint(direction: -1 | 1, isMac: boolean): string {
  if (direction === -1) return isMac ? "⌘[" : "Alt+←";
  return isMac ? "⌘]" : "Alt+→";
}
