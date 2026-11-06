"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { MAX_SEARCH_MATCHES, SEARCH_MATCH_PAGE_SIZE, type SessionSearchMatch } from "@/lib/session-search-matches";

/** The hit the chat should scroll to and mark as current; a new object per click. */
export interface SearchMatchTarget {
  sessionId: string;
  entryId: string;
  ordinal: number;
}

const rowStyle = (depth: number): React.CSSProperties => ({
  display: "block",
  width: "100%",
  padding: `3px 8px 3px ${38 + depth * 14}px`,
  border: "none",
  textAlign: "left",
  fontSize: 11,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
});

/**
 * One session's hits for the sidebar search, a page at a time. Mounted per
 * (session, query): a new query remounts it with an empty list.
 */
export function SessionSearchMatches({ sessionId, query, depth, onOpen }: {
  sessionId: string;
  query: string;
  depth: number;
  onOpen: (target: SearchMatchTarget) => void;
}) {
  const { t } = useI18n();
  const [matches, setMatches] = useState<SessionSearchMatch[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (limit: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/matches?q=${encodeURIComponent(query)}&limit=${limit}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = await res.json() as { matches: SessionSearchMatch[]; total: number };
      setMatches(page.matches);
      setTotal(page.total);
    } catch {
      if (controller.signal.aborted) return;
      setFailed(true);
    }
    setLoading(false);
  }, [sessionId, query]);

  useEffect(() => {
    // Same settle time as the sidebar's transcript search: typing must not read the session per keystroke.
    const timer = setTimeout(() => void load(SEARCH_MATCH_PAGE_SIZE), 250);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [load]);

  const status = total === null && !failed
    ? t("sessionSidebar.loadingMatches")
    : total === 0 ? t("sessionSidebar.noMatchesInSession") : null;
  // "Load more" re-reads a longer ranked prefix (a running session re-ranks between requests);
  // a failed request, the first one too, is retried from the same row.
  const canLoadMore = failed || (total !== null && matches.length < total && matches.length < MAX_SEARCH_MATCHES);

  return (
    <div role="list" aria-label={t("sessionSidebar.matches")} style={{ margin: "0 0 2px" }}>
      {matches.map((match) => (
        <div role="listitem" key={`${match.entryId}:${match.ordinal}`}>
          <button
            type="button"
            className="session-search-match"
            title={`${match.before}${match.match}${match.after}`}
            onClick={() => onOpen({ sessionId, entryId: match.entryId, ordinal: match.ordinal })}
            style={{ ...rowStyle(depth), color: "var(--text-muted)", cursor: "pointer" }}
          >
            {match.before}
            <mark className="session-search-match-hit">{match.match}</mark>
            {match.after}
          </button>
        </div>
      ))}
      {canLoadMore && (
        <div role="listitem">
          <button
            type="button"
            className="session-search-match"
            disabled={loading}
            onClick={() => void load(Math.min(matches.length + SEARCH_MATCH_PAGE_SIZE, MAX_SEARCH_MATCHES))}
            style={{ ...rowStyle(depth), color: failed ? "var(--status-error)" : "var(--accent)", fontWeight: 600, cursor: loading ? "default" : "pointer" }}
          >
            {t(failed ? "sessionSidebar.matchesFailed" : "sessionSidebar.loadMoreMatches")}
          </button>
        </div>
      )}
      {status && <div role="listitem" style={{ ...rowStyle(depth), color: "var(--text-dim)" }}>{status}</div>}
    </div>
  );
}
