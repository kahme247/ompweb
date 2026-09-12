import { NextResponse } from "next/server";
import { loadSessionFile } from "@/lib/omp/session-files";
import { buildSessionContext, getSessionEntriesForDisplayAsync, readSessionHeader, SessionFileTooLargeError } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";

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

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

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
