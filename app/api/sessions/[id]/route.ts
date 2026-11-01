import { NextResponse } from "next/server";
import { apiErrorResponse, hostOfflineResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { invalidateSessionCaches } from "@/lib/session-reader";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { clearExitedRpcSession, getLiveRpcSessionIds, getRpcSession, WebRpcError } from "@/lib/rpc-manager";

/** Stable, client-safe error body for catch-all handlers: details go to the
 *  server log only, never to the browser. */
function sessionsErrorResponse(error: unknown): NextResponse {
  if (error instanceof WebRpcError && error.code === "session_busy") {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // A host link failure keeps its status: 503 offline, 504 timeout.
  if (error instanceof HostOpError) return apiErrorResponse(error);
  console.error("[api/sessions]", error);
  return NextResponse.json({ error: "Session request failed", code: "session_request_failed" }, { status: 500 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;

    const searchParams = new URL(req.url).searchParams;
    const includeState = searchParams.has("includeState");
    const read = await resolved.host.sessionOps.readSession(id, {
      deferThinking: searchParams.has("deferThinking"),
      deferMedia: searchParams.has("deferMedia"),
    });
    if (!read.ok) return opErrorResponse(read);

    // ?includeState=1 inlines the wrapper's live agent state (same shape as
    // GET /api/agent/[id]) so the client's post-turn refresh is one request
    // instead of two. On a get_state failure the field is omitted entirely —
    // callers treat a missing `agent` as "fetch it separately".
    let agent: { running: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        try {
          agent = { running: true, state: await rpc.send({ type: "get_state" }) };
        } catch {
          // Leave agent unset; the session payload is still valid without it.
        }
      } else {
        agent = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      ...read.value,
      ...(agent ? { agent } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await parseJsonWithinLimit<{ name?: string }>(req, 64 * 1024);
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required", code: "session_name_required" }, { status: 400 });
    }
    // A running omp process owns its session file; route the rename through it
    // so the in-memory title cannot clobber ours on the next flush. This runs
    // before the path check because omp does not create the session file until
    // the history holds an assistant message.
    let renamed = false;
    const rpc = getRpcSession(id);
    if (rpc?.isAlive?.() && typeof rpc.send === "function") {
      try {
        await rpc.send({ type: "set_session_name", name: name.trim() });
        renamed = true;
      } catch (error) {
        if (error instanceof WebRpcError && error.code === "session_busy") throw error;
        // Fall back to the on-disk title slot below.
      }
    }
    if (!renamed) {
      const resolved = await resolveSessionHostOr404(id);
      if ("response" in resolved) return resolved.response;
      // Resolution awaited: an Edit may have started on the current wrapper
      // since the failed native rename. Never bypass its fence with a file write.
      if (getRpcSession(id)?.isEditingHistory()) {
        throw new WebRpcError("Wait for the history edit to finish", "session_busy");
      }
      const result = await resolved.host.sessionOps.renameSessionFile(id, name.trim());
      if (!result.ok) return opErrorResponse(result);
      invalidateHostSessionList(resolved.host.id);
      return NextResponse.json({ ok: true });
    }
    invalidateSessionCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    // Await the child's exit before unlinking: omp flushes session state on
    // shutdown and would recreate the file if it were still running.
    // Disposing a child behind a down link would wait for the link to return.
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    await getRpcSession(id)?.destroyAndWait?.();
    // Live children are skipped by the re-parent rewrite: their omp process
    // owns the file and would clobber it on its next flush.
    const result = await resolved.host.sessionOps.deleteSession(id, getLiveRpcSessionIds());
    if (!result.ok) return opErrorResponse(result);
    invalidateHostSessionList(resolved.host.id);
    clearExitedRpcSession(id);
    return NextResponse.json({ ok: true, ...result.value });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}
