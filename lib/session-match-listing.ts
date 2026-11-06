// Server: lists a session's search hits the way the chat shows them. Each
// message is parsed with the chat's markdown parser and hits are counted per
// rendered text node, in rendered order, which is how useChatSearchHighlights
// counts them in the DOM. That shared numbering is what lets a picked hit be
// found again in the chat.
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { containsMathSyntax, normalizeDisplayMath } from "./markdown";
import { compileSearchQuery, findSearchMatches, type CompiledSearchQuery } from "./session-search";
import { SEARCH_MATCH_PAGE_SIZE, type SessionSearchMatchPage } from "./session-search-matches";
import type { AgentMessage } from "./types";

// Short lead-in: the sidebar row is narrow and the hit must stay visible.
const SNIPPET_BEFORE = 16;
const SNIPPET_AFTER = 90;

// Same parse as lib/markdown.ts (remark-math only where the chat loads it).
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).freeze();
const mathParser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).freeze();

/** Text of the content blocks; a malformed message (no content, a bare string) must not fail the listing. */
function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text as string] : []));
}

/**
 * The markdown bodies the chat renders as message text (`[data-message-text]`):
 * one per user message (UserMessageView joins its text blocks with "\n"),
 * one per assistant text block.
 */
function messageTextBlocks(message: AgentMessage): string[] {
  if (message.role === "user") {
    const texts = textBlocks(message.content);
    return texts.length > 0 ? [texts.join("\n")] : [];
  }
  return message.role === "assistant" ? textBlocks(message.content) : [];
}

/**
 * The text nodes a markdown body renders, in rendered order: text, inline code
 * and code blocks. Markup, link targets, image alt text, raw HTML and math
 * (painted by KaTeX, skipped in the chat too) render no searchable text.
 * Footnote definitions render last, in order of first reference; unreferenced
 * ones not at all.
 */
// shortcut: block-level raw HTML renders its inner text, which is skipped here; rare in chat text.
export function renderedTextNodes(markdown: string): string[] {
  const source = normalizeDisplayMath(markdown);
  const texts: string[] = [];
  const definitions = new Map<string, Nodes>();
  const referenced: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
      texts.push(node.value);
    } else if (node.type === "footnoteDefinition") {
      definitions.set(node.identifier, node);
    } else if (node.type === "footnoteReference") {
      if (!referenced.includes(node.identifier)) referenced.push(node.identifier);
    } else if ("children" in node) {
      for (const child of node.children) walk(child);
    }
  };
  walk((containsMathSyntax(source) ? mathParser : parser).parse(source));
  // A definition can reference another footnote: the loop also visits ones appended meanwhile.
  for (const identifier of referenced) {
    const definition = definitions.get(identifier);
    if (definition && "children" in definition) for (const child of definition.children) walk(child);
  }
  return texts;
}

/** Hits of one markdown body, counted per rendered text node; offsets index the body's joined rendered text (snippet context). */
function bodyHits(markdown: string, query: CompiledSearchQuery) {
  // Parsing is the expensive part: a body with no hit in its source has none rendered.
  if (findSearchMatches(markdown, query).length === 0) return [];
  const nodes = renderedTextNodes(markdown);
  const text = nodes.join(" ");
  let base = 0;
  return nodes.flatMap((node) => {
    const spans = findSearchMatches(node, query).map((span) => ({ text, quality: span.quality, start: base + span.start, end: base + span.end }));
    base += node.length + 1;
    return spans;
  });
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
    for (const markdown of messageTextBlocks(message)) {
      for (const { text, start, end, quality } of bodyHits(markdown, query)) hits.push({ entryId, ordinal: ordinal++, quality, timestamp, text, start, end });
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
