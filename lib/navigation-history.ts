/** -1 = back, 0 = no match, 1 = forward. */
export type NavigateDirection = -1 | 0 | 1;
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
