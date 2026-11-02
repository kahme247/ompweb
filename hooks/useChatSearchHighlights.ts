"use client";

import { useEffect, useRef, type RefObject } from "react";
import { compileSearchQuery, findSearchMatches, type CompiledSearchQuery } from "@/lib/session-search";
import type { SearchMatchTarget } from "@/components/SessionSearchMatches";

const ALL_HITS = "omp-search";
const CURRENT_HIT = "omp-search-current";
// Typing settles before the transcript is walked again.
const PAINT_DELAY_MS = 150;
// Rendered text the server's count (lib/session-match-listing.ts) does not see: code-block
// headers (language label, Copy button), highlighted code's line-number gutter, KaTeX output
// (math is not searched), Mermaid's loading/error notes, the charts generated from tables
// (they repeat the table's labels and values) and GFM footnotes' generated numbers, back-links
// and "Footnotes" heading (their bodies stay).
const NOT_MESSAGE_TEXT = "button, .markdown-code-header, .linenumber, .katex, .mermaid-block-loading, .mermaid-block-error, [data-table-chart], [data-footnote-ref], [data-footnote-backref], [data-footnotes] > h2";

// Absent before Chrome 105 / Safari 17.2 / Firefox 140: hits are then not
// painted, but jumping to one still works.
function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;
}

/** Every hit inside one message text element, in text order (a hit's index is its server ordinal). */
// Matched per text node, like the server: a phrase split by inline formatting is found on neither side.
// shortcut: a phrase across syntax-highlighting tokens or a linked `#123`/`agent://` ref is counted
// only by the server, shifting later ordinals in that message; the jump then lands near it.
export function elementHits(element: Element, query: CompiledSearchQuery): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(NOT_MESSAGE_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const span of findSearchMatches(node.nodeValue ?? "", query)) {
      const range = document.createRange();
      range.setStart(node, span.start);
      range.setEnd(node, span.end);
      ranges.push(range);
    }
  }
  return ranges;
}

/** The target's hit, else its message (a hit rendering hides, e.g. a message too large to render). */
export function findTarget(container: Element, query: CompiledSearchQuery, target: SearchMatchTarget): { range: Range | null; element: Element | null } {
  const elements = [...container.querySelectorAll(`[data-message-text][data-entry-id="${CSS.escape(target.entryId)}"]`)];
  const hits = elements.flatMap((element) => elementHits(element, query));
  return { range: hits[target.ordinal] ?? null, element: elements[0] ?? null };
}

/**
 * Find-in-page for the sidebar search: paints every hit of `query` in the
 * rendered transcript, and scrolls to `target` (a new object per click; each
 * is used once, then `onTargetHandled` lets the owner drop it), painting it as
 * the current hit. An empty query clears everything.
 */
export function useChatSearchHighlights({ container, query: rawQuery, target, ready, entryIds, revealMessage, holdScrollPosition, onTargetHandled }: {
  container: RefObject<HTMLDivElement | null>;
  query: string;
  target: SearchMatchTarget | null;
  /** The transcript is mounted (loaded, not the empty new-chat screen). */
  ready: boolean;
  entryIds: string[];
  /** Widens the render window to include the message; false while that is pending. */
  revealMessage: (messageIndex: number) => boolean;
  /** Stops the chat from following new output back to the bottom. */
  holdScrollPosition: () => void;
  onTargetHandled?: () => void;
}) {
  // The hit last jumped to, repainted as current until the query changes.
  const currentRef = useRef<{ query: string; target: SearchMatchTarget } | null>(null);
  const handledRef = useRef<SearchMatchTarget | null>(null);

  useEffect(() => {
    const element = container.current;
    const query = compileSearchQuery(rawQuery);
    // Any query change ends the current hit, even when the same query is typed again later.
    if (currentRef.current?.query !== rawQuery) currentRef.current = null;
    const registry = highlightRegistry();
    if (!ready || !element || !query || !registry) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const paint = () => {
      timer = undefined;
      const all = new Highlight();
      for (const message of element.querySelectorAll("[data-message-text]")) for (const range of elementHits(message, query)) all.add(range);
      registry.set(ALL_HITS, all);
      const current = currentRef.current?.query === rawQuery ? currentRef.current.target : null;
      const range = current && findTarget(element, query, current).range;
      if (range) registry.set(CURRENT_HIT, new Highlight(range));
      else registry.delete(CURRENT_HIT);
    };
    // Streaming, paging and re-renders replace text nodes; repaint at most every PAINT_DELAY_MS.
    const schedule = () => {
      timer ??= setTimeout(paint, PAINT_DELAY_MS);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      registry.delete(ALL_HITS);
      registry.delete(CURRENT_HIT);
    };
  }, [container, rawQuery, ready]);

  useEffect(() => {
    const element = container.current;
    const query = compileSearchQuery(rawQuery);
    if (!target || handledRef.current === target || !ready || !element || !query) return;
    const messageIndex = entryIds.indexOf(target.entryId);
    // Loaded without the entry (another branch is shown): drop the target rather than jump later.
    if (messageIndex < 0) {
      handledRef.current = target;
      onTargetHandled?.();
      return;
    }
    // Not rendered yet: the effect re-runs once the render window includes it.
    if (!revealMessage(messageIndex)) return;
    handledRef.current = target;
    currentRef.current = { query: rawQuery, target };
    onTargetHandled?.();
    holdScrollPosition();
    const { range, element: message } = findTarget(element, query, target);
    const registry = highlightRegistry();
    if (registry && range) registry.set(CURRENT_HIT, new Highlight(range));
    else registry?.delete(CURRENT_HIT);
    // Instant: a smooth scroll would race the lazy-load sentinel the reveal just put on screen.
    // The parent first (it may sit in an inner scroller, e.g. a capped user bubble), then centre
    // the range itself: a paragraph taller than the viewport holds hits far from its centre.
    (range?.startContainer.parentElement ?? message)?.scrollIntoView({ block: "center", behavior: "instant" });
    if (range) {
      const rect = range.getBoundingClientRect();
      const view = element.getBoundingClientRect();
      element.scrollTo({ top: element.scrollTop + rect.top + rect.height / 2 - (view.top + view.height / 2), behavior: "instant" });
    }
  }, [container, rawQuery, target, ready, entryIds, revealMessage, holdScrollPosition, onTargetHandled]);
}
