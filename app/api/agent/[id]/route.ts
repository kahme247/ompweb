import { NextResponse } from "next/server";
import { readSessionHeader } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, resolveSpawnCwdResult, WebRpcError } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";

/** omp-web's own failures carry a stable code the client can localize; omp's
 * errors stay opaque English text. */
function commandErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof WebRpcError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof RpcCommandError) {
    return NextResponse.json({ error: error.message, code: error.code ?? "rpc_command_failed" }, { status: 400 });
  }
  return apiErrorResponse(error);
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await parseJsonWithinLimit<{ type?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    if (typeof body.type !== "string" || !body.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // The per-chat advisor choice rides on the query string (never the RPC
    // body, which is forwarded to omp verbatim) and only matters when this
    // request spawns or replaces the session's omp process.
    const advisor = new URL(req.url).searchParams.get("advisor") === "1";

    // Fast path: already-running session. --advisor is a spawn-time flag with
    // no runtime RPC, so a toggle that now differs from the live child's spawn
    // flag must replace an idle child to take effect; busy children keep
    // running and pick the flag up at the next natural respawn.
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      if (existing.advisorSpawned === advisor || existing.isRunning()) {
        const result = await existing.send(body);
        return NextResponse.json({ success: true, data: result });
      }
      await existing.destroyAndWait();
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const header = readSessionHeader(filePath);
    const { cwd } = resolveSpawnCwdResult(header?.cwd);
    const { session } = await startRpcSession(id, filePath, cwd, undefined, advisor, header?.cwd);
    const result = await session.send(body);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return commandErrorResponse(error);
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }
    try {
      const state = await session.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    } catch (error) {
      if (error instanceof WebRpcError && error.code === "session_unresponsive") {
        return NextResponse.json({ running: false, recovered: true });
      }
      throw error;
    }
  } catch (error) {
    return commandErrorResponse(error);
  }
}
