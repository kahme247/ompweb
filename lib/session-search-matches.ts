// Shared (client + server) contract of the sidebar's per-session search hits.
// The listing itself is server-only: lib/session-match-listing.ts.

export const SEARCH_MATCH_PAGE_SIZE = 10;
/** Longest prefix one request may ask for (100 "Load more" clicks). */
export const MAX_SEARCH_MATCHES = 1000;

export interface SessionSearchMatch {
  entryId: string;
  /** This hit's index among its message's hits, counted in rendered text order. */
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
