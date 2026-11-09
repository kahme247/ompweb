import {
  decodeSearchCursor,
  releaseSearchSlot,
  searchSessionMessages,
  SearchAbortedError,
  SearchCursorError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_QUERY_LENGTH,
  tryAcquireSearchSlot,
} from "@/lib/session-message-search";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function badRequest(error: string, code: string): Response {
  return Response.json({ error, code }, { status: 400, headers: NO_STORE });
}

/**
 * Strict decimal integer: `Number("0x10")` and `Number("1e2")` would accept
 * hex and exponent notation, which a `limit` query parameter never means.
 */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return SEARCH_DEFAULT_LIMIT;
  if (!/^\d{1,3}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * GET /api/sessions/messages/search?q=&limit=&cursor=
 *
 * Read-only full-text search across the session files **of this machine**. The
 * scan is bounded: results are newest-first, `partial:true` plus `cursor` mean
 * "call again for the next slice". Authentication is the normal omp-web gate
 * in `proxy.ts`, because this lives under `/api/`.
 *
 * `scope: "local"` is part of the answer: sessions of linked hosts are not
 * searched, and a client must not present an empty page as a global result.
 * Files above 64 MiB and lines above 1 MiB are skipped (`skippedFiles` counts
 * the former). At most `SEARCH_MAX_CONCURRENT` scans run per process; further
 * requests get `429` + `Retry-After` instead of starving the event loop, so a
 * client that paginates while another search runs can see that answer.
 *
 * A cursor belongs to the listing snapshot its first page installed. When that
 * snapshot is gone (the run was idle for five minutes, or newer runs evicted
 * it), the route answers `409 cursor_expired` rather than paging a re-walked
 * corpus that could skip or repeat hits; the client restarts the search.
 *
 * A client that disconnects aborts `req.signal`; the scan stops at the next
 * chunk boundary, the slot is released, and no response body is written.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) return badRequest("Search query is required", "query_required");
  if (query.length > SEARCH_MAX_QUERY_LENGTH) {
    return badRequest(`Search query is too long (max ${SEARCH_MAX_QUERY_LENGTH})`, "query_too_long");
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    return badRequest(`limit must be an integer between 1 and ${SEARCH_MAX_LIMIT}`, "invalid_limit");
  }

  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && !decodeSearchCursor(rawCursor)) {
    return badRequest("Invalid search cursor", "invalid_cursor");
  }

  if (!tryAcquireSearchSlot()) {
    return Response.json(
      { error: "Too many searches in flight, retry shortly", code: "search_busy" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": "1" } },
    );
  }

  try {
    const page = await searchSessionMessages({
      query,
      limit,
      signal: req.signal,
      ...(rawCursor !== null ? { cursor: rawCursor } : {}),
    });
    return Response.json({
      query,
      scope: "local",
      results: page.results,
      partial: page.partial,
      cursor: page.cursor,
      scannedFiles: page.scannedFiles,
      scannedBytes: page.scannedBytes,
      skippedFiles: page.skippedFiles,
    }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof SearchAbortedError) {
      // The client is gone; nobody reads this, but the slot must be free.
      return new Response(null, { status: 499, headers: NO_STORE });
    }
    if (error instanceof SearchCursorError) {
      // An expired snapshot is not a bad request: the cursor was valid, the
      // run just outlived its listing. 409 tells the client to start over
      // instead of "fix your cursor".
      if (error.message === "cursor_expired") {
        return Response.json(
          { error: "Search cursor expired, start the search again", code: "cursor_expired" },
          { status: 409, headers: NO_STORE },
        );
      }
      return badRequest(
        error.message === "cursor_query_mismatch" ? "Cursor belongs to another search" : "Invalid search cursor",
        error.message,
      );
    }
    // fs/parse failures can carry absolute paths; log the message only, never
    // the error object (its stack and `path` property would reach the log).
    console.error(
      "[api/sessions/messages/search] search failed:",
      error instanceof Error ? error.message : String(error),
    );
    return Response.json({ error: "Search failed", code: "internal_error" }, { status: 500, headers: NO_STORE });
  } finally {
    releaseSearchSlot();
  }
}
