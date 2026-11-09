import { apiErrorResponse, hostOfflineResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import type { SessionReadValue } from "@/lib/hosts/session-ops";
import { invalidateSessionCaches } from "@/lib/session-reader";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { clearExitedRpcSession, getLiveRpcSessionIds, getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { RpcCommandError, RpcCommandTimeoutError } from "@/lib/omp/rpc-process";

/** Session-level failures a client retries instead of treating the request as
 *  applied: omp is busy, restarting or was reset, and the session keeps going.
 *  `session_slow` and `session_state_timeout` are the codes the wrapper and the
 *  `get_state` dispatch use for "the completion is unknown"; this route answers
 *  its own `RpcCommandTimeoutError` with `session_slow` below, and accepts the
 *  rest from any wrapper that raises them, so a client sees one stable name. */
const RETRIABLE_SESSION_CODES: Record<string, true> = {
  session_slow: true,
  session_state_timeout: true,
  session_restarting: true,
  session_unresponsive: true,
};

/** Stable, client-safe error body for catch-all handlers: details go to the
 *  server log only, never to the browser. */
function sessionsErrorResponse(error: unknown): Response {
  if (error instanceof WebRpcError && error.code === "session_busy") {
    return Response.json({ error: error.message, code: error.code }, { status: 409 });
  }
  // omp is busy, restarting or was reset — not gone: the session keeps running,
  // so a client retries instead of treating the rename as applied.
  if (error instanceof WebRpcError && RETRIABLE_SESSION_CODES[error.code]) {
    return Response.json({ error: error.message, code: error.code }, { status: 503 });
  }
  // A command timeout leaves the completion unknown. Nothing was written here
  // and the child still owns the file, so the client retries and re-reads the
  // title instead of assuming the rename stuck.
  if (error instanceof RpcCommandTimeoutError) {
    return Response.json(
      { error: "The session did not confirm the change in time. It keeps running — retry shortly.", code: "session_slow" },
      { status: 503 },
    );
  }
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // A host link failure keeps its status: 503 offline, 504 timeout. A live
  // wrapper whose link dropped answers 503 `{hostOffline: true}` plus its
  // `delivery` ("refused": nothing left this server).
  if (error instanceof HostOpError || (error instanceof WebRpcError && error.code === "host_offline")) return apiErrorResponse(error);
  console.error("[api/sessions]", error);
  return Response.json({ error: "Session request failed", code: "session_request_failed" }, { status: 500 });
}

/** `?meta=1` against a daemon that predates the option: it ignores `meta` and
 *  answers the full transcript. Derive the navigation shape from it — the same
 *  context supplies the branch metadata — so the client never receives the
 *  second copy. `lastMessageAt` stays absent: that daemon never scanned it. */
function navigationShape(value: SessionReadValue): SessionReadValue {
  if (!value.context) return value;
  return {
    ...value,
    info: {
      ...value.info,
      model: value.context.model,
      thinkingLevel: value.context.thinkingLevel,
    },
    context: null,
  };
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
    const meta = searchParams.get("meta") === "1";
    const includeState = searchParams.has("includeState");
    // `?includeState=alive` opts into the split liveness shape; every other
    // value (including bare `?includeState`) keeps the historical meaning.
    const stateAlive = searchParams.get("includeState") === "alive";
    const read = await resolved.host.sessionOps.readSession(id, {
      deferThinking: searchParams.has("deferThinking"),
      deferMedia: searchParams.has("deferMedia"),
      meta,
    });
    if (!read.ok) return opErrorResponse(read);
    // A daemon that predates `meta` ignores the option and answers the full
    // transcript; derive the navigation shape here so the client never gets it.
    const value = meta ? navigationShape(read.value) : read.value;

    // ?includeState=1 inlines the wrapper's live agent state (same shape as
    // GET /api/agent/[id]) so the client's post-turn refresh is one request
    // instead of two. On a get_state failure the field is omitted entirely —
    // callers treat a missing `agent` as "fetch it separately".
    //
    // The historical shape says `running: true` for any live wrapper, idle
    // included (that is what /api/agent and /state answer). The idle/running
    // split is opt-in (`?includeState=alive`), so an existing caller keeps its
    // meaning: `running` there is the child's liveness, not a turn in flight.
    let agent: { running: boolean; alive?: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        try {
          const state = await rpc.send({ type: "get_state" });
          // The child can exit between its reply and this line: its state is
          // stale then, so answer the not-live shape instead of reporting it.
          if (rpc.isAlive()) {
            agent = stateAlive
              ? { running: rpc.isRunning(), alive: true, state }
              : { running: true, state };
          } else {
            agent = stateAlive ? { running: false, alive: false } : { running: false };
          }
        } catch {
          // Leave agent unset; the session payload is still valid without it.
        }
      } else {
        agent = stateAlive ? { running: false, alive: false } : { running: false };
      }
    }

    // ?meta=1 is the navigation shape: the tree and leaf the native client
    // reads from this route, without a second transcript copy. `context` is
    // omitted entirely (not null) so clients keyed on its presence keep their
    // historical shape; the transcript comes from /api/sessions/[id]/context.
    const { context, ...navigation } = value;
    return Response.json({
      sessionId: id,
      ...navigation,
      ...(context ? { context } : {}),
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
      return Response.json({ error: "name is required", code: "session_name_required" }, { status: 400 });
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
        // The file fallback is only for "nothing was applied": omp answered
        // with a rejection (`RpcCommandError`), or the child died before
        // answering, so no live process can flush over our write. Everything
        // else keeps its own answer: a timeout leaves the completion unknown
        // while the child still owns the file, and a busy/restarting/offline
        // session is retried by the client instead of being written behind
        // omp's back (its next flush would clobber the slot).
        if (error instanceof RpcCommandError) {
          // omp rejected the command outright; fall through to the file.
        } else if (error instanceof RpcCommandTimeoutError || error instanceof WebRpcError) {
          throw error;
        } else if (rpc.isAlive?.()) {
          throw error;
        }
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
      return Response.json({ ok: true });
    }
    invalidateSessionCaches();
    return Response.json({ ok: true });
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
    const live = getRpcSession(id);
    if (!live?.hostOwnedLifecycle) await live?.destroyAndWait?.("delete", true);
    // Live children are skipped by the re-parent rewrite: their omp process
    // owns the file and would clobber it on its next flush.
    const result = await resolved.host.sessionOps.deleteSession(id, getLiveRpcSessionIds());
    if (!result.ok) return opErrorResponse(result);
    invalidateHostSessionList(resolved.host.id);
    clearExitedRpcSession(id);
    return Response.json({ ok: true, ...result.value });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}
