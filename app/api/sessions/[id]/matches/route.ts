import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { listSessionMatches } from "@/lib/session-search-matches";
import type { SessionContext } from "@/lib/types";

const MAX_QUERY_LENGTH = 500;

// GET /api/sessions/[id]/matches?q=&offset= — one page of the query's hits in
// the session's active conversation (what the chat shows), best match first.
// shortcut: re-reads and re-ranks the whole session per page; cache per (session, query) if pages get slow.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) {
    return Response.json({ error: "Query too long", code: "query_too_long" }, { status: 400 });
  }
  const rawOffset = url.searchParams.get("offset") ?? "0";
  if (!/^\d{1,9}$/.test(rawOffset)) {
    return Response.json({ error: "Invalid offset", code: "invalid_offset" }, { status: 400 });
  }
  const offset = Number(rawOffset);
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readContext(id, undefined, {
      deferThinking: true,
      deferMedia: true,
      includePreCompaction: false,
      boundary: false,
      sync: null,
    });
    if (!result.ok) return opErrorResponse(result);
    const { context } = result.value as { context: SessionContext };
    return Response.json(listSessionMatches(context.messages, context.entryIds, q, offset), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
