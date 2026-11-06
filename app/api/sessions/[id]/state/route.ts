import { getExitedRpcSession, getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { outboxEntries, outboxScope, outboxSettledIds } from "@/lib/message-outbox";
import { resolveSessionPath } from "@/lib/session-reader";
import { detectSessionOwner } from "@/lib/session-owner";

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
        return Response.json({ running: rpc.isRunning(), alive: true, state, elsewhere: null });
      } catch (error) {
        // omp being slow is not the run ending: answer 503 so clients retry
        // instead of treating the session as idle/recovered. Both the code
        // this tree raises (`session_slow`) and 0.6.0's own
        // `session_state_timeout` mean the same thing to a client.
        if (error instanceof WebRpcError && (error.code === "session_slow" || error.code === "session_state_timeout")) {
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

    // Not ours: tell the client who is running it, if anyone. Never spawns.
    const filePath = await resolveSessionPath(id).catch(() => null);
    const elsewhere = filePath ? await detectSessionOwner(id, filePath) : null;

    const exited = getExitedRpcSession(id);
    if (exited) return Response.json({ running: false, alive: false, exited, elsewhere });

    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readSessionState(id);
    if (!result.ok) return opErrorResponse(result);
    // Another host's file is outside this machine's process scan.
    return Response.json({
      ...(result.value as Record<string, unknown>),
      alive: false,
      elsewhere: resolved.host.id === LOCAL_HOST_ID ? elsewhere : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
