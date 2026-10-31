import { NextResponse } from "next/server";
import {
  decodeSearchCursor,
  releaseSearchSlot,
  searchSessionMessages,
  SearchCursorError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_QUERY_LENGTH,
  tryAcquireSearchSlot,
} from "@/lib/session-message-search";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function badRequest(error: string, code: string) {
  return NextResponse.json({ error, code }, { status: 400, headers: NO_STORE });
}

/**
 * GET /api/sessions/messages/search?q=&limit=&cursor=
 *
 * Read-only full-text search across the session files. The scan is bounded:
 * results are newest-first, `partial:true` plus `cursor` mean "call again for
 * the next slice". Authentication is the normal omp-web gate in `proxy.ts`,
 * because this lives under `/api/`.
 *
 * At most `SEARCH_MAX_CONCURRENT` scans run per process; further requests get
 * `429` + `Retry-After` instead of starving the event loop.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) return badRequest("Search query is required", "query_required");
  if (query.length > SEARCH_MAX_QUERY_LENGTH) {
    return badRequest(`Search query is too long (max ${SEARCH_MAX_QUERY_LENGTH})`, "query_too_long");
  }

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? SEARCH_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    return badRequest(`limit must be an integer between 1 and ${SEARCH_MAX_LIMIT}`, "invalid_limit");
  }

  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && !decodeSearchCursor(rawCursor)) {
    return badRequest("Invalid search cursor", "invalid_cursor");
  }

  if (!tryAcquireSearchSlot()) {
    return NextResponse.json(
      { error: "Too many searches in flight, retry shortly", code: "search_busy" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": "1" } },
    );
  }

  try {
    const page = await searchSessionMessages({
      query,
      limit,
      ...(rawCursor !== null ? { cursor: rawCursor } : {}),
    });
    return NextResponse.json(
      {
        query,
        results: page.results,
        partial: page.partial,
        cursor: page.cursor,
        scannedFiles: page.scannedFiles,
        scannedBytes: page.scannedBytes,
        skippedFiles: page.skippedFiles,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof SearchCursorError) {
      return badRequest(
        error.message === "cursor_query_mismatch" ? "Cursor belongs to another search" : "Invalid search cursor",
        error.message,
      );
    }
    // fs/parse failures can carry absolute paths; keep them server-side.
    console.error("[api/sessions/messages/search]", error);
    return NextResponse.json(
      { error: "Search failed", code: "internal_error" },
      { status: 500, headers: NO_STORE },
    );
  } finally {
    releaseSearchSlot();
  }
}
