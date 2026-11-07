import { apiErrorResponse, hostOfflineResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { clearExitedRpcSession, getRpcSession } from "@/lib/rpc-manager";

/** POST /api/sessions/[id]/archive — stop the live child, then archive the
 * native OMP JSONL and its sibling artifacts using OMP's gc layout. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    // The archive browser (/api/sessions/archive) reads this machine's archive only: a remote session archived on
    // its host would vanish from the sidebar with no way to restore it.
    if (resolved.host.id !== LOCAL_HOST_ID) {
      return Response.json({ error: "Not available on remote hosts yet", code: "remote_unavailable" }, { status: 501 });
    }
    const { sessionOps } = resolved.host;
    // Parent-session paths are native branch metadata. Moving only a parent
    // would leave active children pointing at a path that no longer exists,
    // flattening their tree in the sidebar. Archive leaves first instead.
    const hasChildren = (await sessionOps.listSessions()).some((session) => session.parentSessionId === id);
    if (hasChildren) {
      return Response.json(
        { error: "Archive child sessions before archiving this session", code: "session_has_children" },
        { status: 409 },
      );
    }

    // OMP owns writes while a child is live; wait for its final flush before
    // moving the file so the archive contains the complete native transcript.
    // Disposing a child behind a down link would wait for the link to return.
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    const live = getRpcSession(id);
    if (!live?.hostOwnedLifecycle) await live?.destroyAndWait?.("archive", true);
    const result = await sessionOps.archiveSession(id);
    if (!result.ok) return opErrorResponse(result);
    invalidateHostSessionList(resolved.host.id);
    clearExitedRpcSession(id);
    return Response.json({ ok: true, archived: true, archivedPath: result.value.archivedPath });
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: "session_archive_failed" }, { status: 500 });
  }
}
