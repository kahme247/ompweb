import { NextResponse } from "next/server";
import { archiveSessionFileWithArtifacts } from "@/lib/omp/session-files";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
} from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";

/** POST /api/sessions/[id]/archive — stop the live child, then archive the
 * native OMP JSONL and its sibling artifacts using OMP's gc layout. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    // Parent-session paths are native branch metadata. Moving only a parent
    // would leave active children pointing at a path that no longer exists,
    // flattening their tree in the sidebar. Archive leaves first instead.
    const hasChildren = (await listAllSessions()).some((session) => session.parentSessionId === id);
    if (hasChildren) {
      return NextResponse.json(
        { error: "Archive child sessions before archiving this session", code: "session_has_children" },
        { status: 409 },
      );
    }

    // OMP owns writes while a child is live; wait for its final flush before
    // moving the file so the archive contains the complete native transcript.
    await getRpcSession(id)?.destroyAndWait?.();
    const archivedPath = archiveSessionFileWithArtifacts(filePath);
    invalidateSessionPathCache(id);
    // The file is gone: full flush is correct (drops its caches + refreshes list).
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, archived: true, archivedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: "session_archive_failed" }, { status: 500 });
  }
}
