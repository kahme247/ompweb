import { NextResponse } from "next/server";
import { getRpcSession, WebRpcError } from "@/lib/rpc-manager";
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
        return NextResponse.json({ running: true, state });
      } catch (error) {
        if (error instanceof WebRpcError && error.code === "session_unresponsive") {
          return NextResponse.json({ running: false, recovered: true });
        }
        throw error;
      }
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    return NextResponse.json({ running: false });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
