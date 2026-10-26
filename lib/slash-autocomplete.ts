/**
 * Pure helpers for the chat input's slash and skill autocomplete.
 * Mirrors the OMP TUI's behavior (@oh-my-pi/pi-tui/src/autocomplete.ts):
 * - Leading slash (/ at start of line/draft): full slash command lookup
 *   (built-in commands, extension commands, skills, prompts).
 * - Mid-prompt slash (/ preceded by whitespace after non-empty prompt text):
 *   mid-prompt skill lookup, filtering down to ONLY skills.
 * - URLs (e.g. https://... or word/path) do not trigger slash autocomplete.
 */

export interface SlashQueryMatch {
  /** Mode of the slash lookup */
  mode: "leading" | "mid-prompt";
  /** Character index where '/' begins in textBeforeCursor */
  start: number;
  /** Query typed after '/' (lowercase, trimmed) */
  query: string;
}

/**
 * Detect a slash command or skill lookup token immediately before the cursor.
 * The slash must be either:
 * 1. At the very start of the draft (allowing leading whitespace): mode = "leading".
 * 2. Preceded by whitespace after non-empty prompt text: mode = "mid-prompt".
 *
 * URLs (e.g. `http://`, `https://`, `file:///`, or word/word) are never matched.
 * Trailing whitespace after '/' closes the lookup (returns null).
 */
export function extractSlashQuery(textBeforeCursor: string): SlashQueryMatch | null {
  if (!textBeforeCursor) return null;

  // Check if this is a leading slash command:
  // Starts with optional whitespace, then '/', then any non-whitespace chars up to cursor.
  const leadingMatch = /^\s*\/([^\s/]*)$/.exec(textBeforeCursor);
  if (leadingMatch) {
    const slashIndex = textBeforeCursor.indexOf("/");
    return {
      mode: "leading",
      start: slashIndex,
      query: leadingMatch[1].toLowerCase(),
    };
  }

  // Check if this is a mid-prompt slash:
  // Preceded by whitespace, then '/', then any non-whitespace chars up to cursor.
  // Must have non-whitespace text before the preceding whitespace.
  const trailingMatch = /(^|\s)\/([^\s/]*)$/.exec(textBeforeCursor);
  if (trailingMatch && trailingMatch.index !== undefined) {
    const slashOffset = trailingMatch[0].indexOf("/");
    const slashIndex = trailingMatch.index + slashOffset;
    const textBeforeSlash = textBeforeCursor.slice(0, slashIndex);
    if (textBeforeSlash.trim().length > 0) {
      return {
        mode: "mid-prompt",
        start: slashIndex,
        query: trailingMatch[2].toLowerCase(),
      };
    }
  }

  return null;
}

/**
 * Format the text replacement for an accepted slash/skill command.
 * - In leading mode: inserts `/${commandName} ` at draft start.
 * - In mid-prompt mode: normalizes skill command to `/skill:${name} ` at the slash token.
 */
export function buildSlashInsertText(
  commandName: string,
  mode: "leading" | "mid-prompt",
): string {
  if (mode === "mid-prompt") {
    const cleanName = commandName.replace(/^skill:/i, "");
    return `/skill:${cleanName} `;
  }
  return `/${commandName} `;
}
