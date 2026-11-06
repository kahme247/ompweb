import { buildSessionContext } from "@/lib/session-reader";
import { apiErrorResponse, ifNoneMatchSatisfied, opErrorResponse, resolveSessionHostOr404, strongEtag } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";
import { MAX_SYNC_MESSAGES, parseHistoryCursor, selectSessionHistory, type SessionHistoryCursor, type SessionHistoryPage, type SessionSyncResponse } from "@/lib/session-sync";

/**
 * Serialize once, key the validator on those exact bytes: the ETag cannot
 * disagree with the body, and it covers everything that shapes it (branch,
 * options, live stream snapshot) without this route needing the file's
 * identity — which a remote host would not expose to this process.
 */
function jsonBodyResponse(req: Request, body: unknown, cacheControl: "no-store" | null = null): Response {
  const text = JSON.stringify(body);
  const etag = strongEtag(text);
  const headers: Record<string, string> = { ETag: etag };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  if (ifNoneMatchSatisfied(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, {
    headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)), ...headers },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // Read-only transcript mode: include entries omitted from the active agent context.
  const includePreCompaction = url.searchParams.has("includePreCompaction");
  const sync = url.searchParams.get("sync");
  const boundary = url.searchParams.get("boundary");
  if (boundary !== null) {
    if (boundary !== "1" || url.searchParams.getAll("boundary").length !== 1) {
      return Response.json({ error: "Invalid boundary mode", code: "invalid_boundary" }, { status: 400 });
    }
    if (["sync", "leafId", "includePreCompaction", "cursor", "limit"].some((option) => url.searchParams.has(option))) {
      return Response.json({ error: "Boundary mode requires the current active context", code: "invalid_boundary_options" }, { status: 400 });
    }
  }
  let cursor: SessionHistoryCursor | null = null;
  let limit = MAX_SYNC_MESSAGES;
  if (sync !== null && sync !== "1") {
    return Response.json({ error: "Invalid sync mode", code: "invalid_sync" }, { status: 400 });
  }
  if (sync === "1") {
    try {
      cursor = parseHistoryCursor(url.searchParams.get("cursor"));
    } catch {
      return Response.json({ error: "Invalid history cursor", code: "invalid_sync_cursor" }, { status: 400 });
    }
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isInteger(limit) || limit > MAX_SYNC_MESSAGES) {
        return Response.json({ error: "Invalid history page limit", code: "invalid_sync_limit" }, { status: 400 });
      }
    }
  }

  try {
    const resolved = await resolveSessionHostOr404(id);
    // A live session resolves to its host even before its file exists; the host then answers 404.
    const result = "response" in resolved ? resolved : await resolved.host.sessionOps.readContext(id, leafId, {
      deferThinking,
      deferMedia: deferToolResultImages,
      includePreCompaction,
      boundary: boundary === "1",
      sync: sync === "1" ? { cursor, limit } : null,
    });
    if ("response" in result || !result.ok) {
      // OMP may not create the file until the first assistant message is
      // committed. A live wrapper can still recover that first partial reply,
      // and its persisted boundary is empty (the next prompt must not 404).
      // Never replace previously confirmed history when its file is missing.
      const notFound = "response" in result ? result.response.status === 404 : result.status === 404;
      const session = notFound && (boundary === "1" || (sync === "1" && !cursor?.lastEntryId && leafId === undefined)) ? getRpcSession(id) : undefined;
      if (session?.isAlive() && !(await session.host.sessionFileExists(session.sessionFile))) {
        if (boundary === "1") {
          return jsonBodyResponse(req, { entryIds: [] }, "no-store");
        }
        const response: SessionSyncResponse = {
          ...selectSessionHistory(buildSessionContext([]), cursor, limit),
          sessionId: id,
          leafId: null,
          live: session.getStreamSnapshot(),
        };
        return jsonBodyResponse(req, response, "no-store");
      }
      return "response" in result ? result.response : opErrorResponse(result);
    }
    if (boundary === "1") {
      return jsonBodyResponse(req, result.value, "no-store");
    }
    if (sync === "1") {
      const page = result.value as { history: SessionHistoryPage; leafId: string | null; tipId: string | null };
      // Sample AFTER the disk read: a quiet active run still supplies its most
      // recent partial output, and events arriving during the read win.
      const session = getRpcSession(id);
      const live = session?.isAlive() && (leafId === undefined || leafId === page.tipId)
        ? session.getStreamSnapshot()
        : null;
      const response: SessionSyncResponse = { ...page.history, sessionId: id, leafId: page.leafId, live };
      return jsonBodyResponse(req, response, "no-store");
    }
    return jsonBodyResponse(req, result.value);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
