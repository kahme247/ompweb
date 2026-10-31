import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { loadSessionFile } from "@/lib/omp/session-files";
import { buildSessionContext, getSessionContextBoundary, getSessionEntriesForDisplayAsync, getSessionHistoryPage, readSessionHeader, SessionFileMalformedError, SessionFileTooLargeError } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";
import { MAX_SYNC_MESSAGES, parseHistoryCursor, selectSessionHistory, type SessionHistoryCursor, type SessionSyncResponse } from "@/lib/session-sync";

/** Uniform error mapping for this route: the display read throws
 * SessionFileTooLargeError on files past the load ceiling, which must surface
 * as the same 413 the null-header path returns — not a 500 so the frontend
 * does not treat history as gone. */
function contextErrorResponse(error: unknown): NextResponse {
  if (error instanceof SessionFileTooLargeError) {
    return NextResponse.json(
      { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
      { status: 413 },
    );
  }
  if (error instanceof SessionFileMalformedError) {
    return NextResponse.json(
      { error: "Session file is missing or malformed", code: "session_file_malformed" },
      { status: 404 },
    );
  }
  return apiErrorResponse(error);
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
      return NextResponse.json({ error: "Invalid boundary mode", code: "invalid_boundary" }, { status: 400 });
    }
    if (["sync", "leafId", "includePreCompaction", "cursor", "limit"].some((option) => url.searchParams.has(option))) {
      return NextResponse.json({ error: "Boundary mode requires the current active context", code: "invalid_boundary_options" }, { status: 400 });
    }
  }
  let cursor: SessionHistoryCursor | null = null;
  let limit = MAX_SYNC_MESSAGES;
  if (sync !== null && sync !== "1") {
    return NextResponse.json({ error: "Invalid sync mode", code: "invalid_sync" }, { status: 400 });
  }
  if (sync === "1") {
    try {
      cursor = parseHistoryCursor(url.searchParams.get("cursor"));
    } catch {
      return NextResponse.json({ error: "Invalid history cursor", code: "invalid_sync_cursor" }, { status: 400 });
    }
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isInteger(limit) || limit > MAX_SYNC_MESSAGES) {
        return NextResponse.json({ error: "Invalid history page limit", code: "invalid_sync_limit" }, { status: 400 });
      }
    }
  }

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) {
      // OMP may not create the file until the first assistant message is
      // committed. A live wrapper can still recover that first partial reply,
      // and its persisted boundary is empty (the next prompt must not 404).
      // Never replace previously confirmed history when its file is missing.
      const session = boundary === "1" || (sync === "1" && !cursor?.lastEntryId && leafId === undefined) ? getRpcSession(id) : undefined;
      if (session?.isAlive() && !existsSync(session.sessionFile)) {
        if (boundary === "1") {
          return NextResponse.json({ entryIds: [] }, { headers: { "Cache-Control": "no-store" } });
        }
        const response: SessionSyncResponse = {
          ...selectSessionHistory(buildSessionContext([]), cursor, limit),
          sessionId: id,
          leafId: null,
          live: session.getStreamSnapshot(),
        };
        return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
      }
      return resolved.response;
    }
    const filePath = resolved.filePath;

    if (boundary === "1") {
      return NextResponse.json(getSessionContextBoundary(filePath), { headers: { "Cache-Control": "no-store" } });
    }
    if (sync === "1") {
      const page = await getSessionHistoryPage(filePath, cursor, limit, leafId, {
        deferThinking,
        deferToolResultImages,
        includePreCompaction,
      });
      // Sample AFTER the disk read: a quiet active run still supplies its most
      // recent partial output, and events arriving during the read win.
      const session = getRpcSession(id);
      const live = session?.isAlive() && (leafId === undefined || leafId === page.tipId)
        ? session.getStreamSnapshot()
        : null;
      const response: SessionSyncResponse = { ...page.history, sessionId: id, leafId: page.leafId, live };
      return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
    }

    const header = readSessionHeader(filePath);
    if (header === null) {
      const loaded = loadSessionFile(filePath, { resolveBlobs: false });
      if (loaded.error === "too_large") {
        return NextResponse.json(
          { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
          { status: 413 },
        );
      }
      return NextResponse.json({ error: "Session file is missing or malformed", code: "session_file_malformed" }, { status: 404 });
    }
    // Deduplicated cached read; blob resolution on per-entry deep copies.
    const entries = await getSessionEntriesForDisplayAsync(filePath, { skipToolResultImages: deferToolResultImages });
    const context = buildSessionContext(entries, leafId, {
      deferThinking,
      deferToolResultImages,
      includePreCompaction,
    });

    return NextResponse.json({ context });
  } catch (error) {
    return contextErrorResponse(error);
  }
}
