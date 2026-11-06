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
        return Response.json({ running: true, state });
      } catch (error) {
        if (error instanceof WebRpcError && error.code === "session_unresponsive") {
          return Response.json({ running: false, recovered: true });
        }
        throw error;
      }
    }

    const exited = getExitedRpcSession(id);
    if (exited) return Response.json({ running: false, exited });

    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readSessionState(id);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
