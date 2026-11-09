import { getExitedRpcSession, getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { outboxEntries, outboxScope, outboxSettledIds } from "@/lib/message-outbox";

/** Every answer, an offline host's 503 included, carries the session's held messages (`outbox`): a tab opening a
 * session with no omp running learns from it that there is an outbox to subscribe to. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const response = await sessionState(id);
  return Response.json({
    ...(await response.json() as object),
    outbox: outboxEntries(id),
    outboxScope: outboxScope(),
    outboxSettledIds: outboxSettledIds(id),
  }, { status: response.status });
}

async function sessionState(id: string): Promise<Response> {
  try {
    // A live process proves the session exists: omp does not create the session
    // file until the history holds an assistant message, so the path check
    // below would 404 a brand-new running session.
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      try {
        const state = await rpc.send({ type: "get_state" });
        return Response.json({ running: rpc.isRunning(), alive: true, state });
      } catch (error) {
        // omp being slow is not the run ending: answer 503 so clients retry
        // instead of treating the session as idle/recovered. This tree raises
        // `session_slow`; `session_state_timeout` is the code a wrapper that
        // outlived a `bun --hot` reload still raises (the old module instance
        // keeps its own error class), and it means the same thing to a client.
        if (error instanceof WebRpcError && (error.code === "session_slow" || error.code === "session_state_timeout")) {
          // The liveness watchdog disposes a child that stayed silent past its
          // threshold; that child is gone, so the busy answer would be a lie.
          // Its `detail: "stalled"` record answers like any other exit.
          if (!rpc.isAlive()) {
            const exited = getExitedRpcSession(id);
            return Response.json({ running: false, alive: false, ...(exited ? { exited } : {}) });
          }
          return Response.json(
            {
              error: error.message,
              code: "session_slow",
              ...error.details,
              running: rpc.isRunning(),
              alive: true,
              silentForMs: rpc.silentForMs(),
            },
            { status: 503 },
          );
        }
        if (error instanceof WebRpcError && error.code === "session_unresponsive") {
          return Response.json({ running: false, alive: false, recovered: true });
        }
        throw error;
      }
    }

    const exited = getExitedRpcSession(id);
    if (exited) return Response.json({ running: false, alive: false, exited });

    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readSessionState(id);
    if (!result.ok) return opErrorResponse(result);
    return Response.json({ ...(result.value as Record<string, unknown>), alive: false });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
