import { NextResponse } from "next/server";
import { getExitedRpcSession, getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // A live process proves the session exists: omp does not create the session
    // file until the history holds an assistant message, so the path check
    // below would 404 a brand-new running session.
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      try {
        const state = await rpc.send({ type: "get_state" });
        // `running` = a run is in flight, `alive` = the child exists. An idle
        // child that just answered `get_state` is alive and not running; the
        // flags were reconciled by that answer, so this is authoritative.
        return NextResponse.json({ running: rpc.isRunning(), alive: true, state });
      } catch (error) {
        // omp being slow is not the run ending: answer 503 so clients retry
        // instead of treating the session as idle/recovered. Both the code
        // this tree raises (`session_slow`) and 0.6.0's own
        // `session_state_timeout` mean the same thing to a client.
        if (error instanceof WebRpcError && (error.code === "session_slow" || error.code === "session_state_timeout")) {
          // Same clock as the success body: a blocked child answers nothing,
          // so the 503 is where a client learns how long the run it still
          // shows has been silent — and whether there is a run at all.
          return NextResponse.json({
            error: error.message,
            code: "session_slow",
            ...error.details,
            running: rpc.isRunning(),
            // The timeout behind this 503 may have disposed a stalled child;
            // `alive` is the child, so read it after the catch.
            alive: rpc.isAlive(),
            silentForMs: rpc.silentForMs(),
          }, { status: 503 });
        }
        throw error;
      }
    }

    const exited = getExitedRpcSession(id);
    if (exited) return NextResponse.json({ running: false, alive: false, exited });

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    return NextResponse.json({ running: false, alive: false });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
