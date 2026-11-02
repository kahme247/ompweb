// Occurrence-level matches inside one session, for the sidebar's expandable
// search results. Shared by the server (listing) and the client (types).
import type { AgentMessage } from "./types";
import { compileSearchQuery, findSearchMatches } from "./session-search";

export const SEARCH_MATCH_PAGE_SIZE = 10;
/** Longest prefix one request may ask for (100 "Load more" clicks). */
export const MAX_SEARCH_MATCHES = 1000;
// Short lead-in: the sidebar row is narrow and the hit must stay visible.
const SNIPPET_BEFORE = 16;
const SNIPPET_AFTER = 90;

export interface SessionSearchMatch {
  entryId: string;
  /** This hit's index among its message's hits, in text order across text blocks. */
  ordinal: number;
  quality: number;
  timestamp: number | null;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchMatchPage {
  matches: SessionSearchMatch[];
  total: number;
}

/** Text of the content blocks; a malformed message (no content, a bare string) must not fail the listing. */
function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text as string] : []));
}

/**
 * The text blocks the chat renders as message text (`[data-message-text]`):
 * one per user message (UserMessageView joins its text blocks with "\n"),
 * one per assistant text block. Hits are counted per block so an ordinal
 * never depends on a phrase spanning two blocks.
 */
function messageTextBlocks(message: AgentMessage): string[] {
  if (message.role === "user") {
    const texts = textBlocks(message.content);
    return texts.length > 0 ? [texts.join("\n")] : [];
  }
  return message.role === "assistant" ? textBlocks(message.content) : [];
}

/** The best `limit` hits: best match first, then newest message first; ties keep text order. */
export function listSessionMatches(messages: AgentMessage[], entryIds: string[], rawQuery: string, limit = SEARCH_MATCH_PAGE_SIZE): SessionSearchMatchPage {
  const query = compileSearchQuery(rawQuery);
  if (!query) return { matches: [], total: 0 };
  // Snippets are cut for the returned hits only: a short query can hit a large session 100k+ times.
  const hits: { entryId: string; ordinal: number; quality: number; timestamp: number | null; text: string; start: number; end: number }[] = [];
  messages.forEach((message, index) => {
    const entryId = entryIds[index];
    if (!entryId) return;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : null;
    let ordinal = 0;
    for (const text of messageTextBlocks(message)) {
      // GFM footnote references and definition labels render as generated text the chat skips;
      // inside code (fenced blocks, inline backticks) they stay literal text the chat shows.
      const code = [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g)].map((m) => [m.index, m.index + m[0].length]);
      const footnotes = [...text.matchAll(/\[\^[^\]\s]+\]:?/g)]
        .map((m) => [m.index, m.index + m[0].length])
        .filter(([from]) => !code.some(([codeFrom, codeTo]) => from >= codeFrom && from < codeTo));
      for (const { start, end, quality } of findSearchMatches(text, query)) {
        if (footnotes.some(([from, to]) => start < to && end > from)) continue;
        hits.push({ entryId, ordinal: ordinal++, quality, timestamp, text, start, end });
      }
    }
  });
  hits.sort((a, b) => b.quality - a.quality || (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const matches = hits.slice(0, limit).map(({ entryId, ordinal, quality, timestamp, text, start, end }) => {
    const from = Math.max(0, start - SNIPPET_BEFORE);
    const to = Math.min(text.length, end + SNIPPET_AFTER);
    return {
      entryId,
      ordinal,
      quality,
      timestamp,
      before: (from > 0 ? "…" : "") + text.slice(from, start).replace(/\s+/g, " ").trimStart(),
      match: text.slice(start, end),
      after: text.slice(end, to).replace(/\s+/g, " ").trimEnd() + (to < text.length ? "…" : ""),
    };
  });
  return { matches, total: hits.length };
}
