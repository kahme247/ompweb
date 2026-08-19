import { NextResponse } from "next/server";
import { readSessionHeader } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, resolveSpawnCwd, WebRpcError } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { isRemoteSessionId, remoteCommand, remoteState, stopRemoteSession } from "@/lib/porbs/controller";

/** omp-web's own failures carry a stable code the client can localize; omp's
 * errors stay opaque English text. */
function commandErrorResponse(error: unknown) {
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

  if (isRemoteSessionId(id)) {
    try {
      const result = await remoteCommand(id, await req.json() as Record<string, unknown>);
      return NextResponse.json({ success: true, data: result.result });
    } catch (error) {
      return commandErrorResponse(error);
    }
  }
  try {
    const body = await req.json() as { type?: unknown; [key: string]: unknown };
    if (typeof body.type !== "string" || !body.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      return NextResponse.json({ success: true, data: result });
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const cwd = resolveSpawnCwd(readSessionHeader(filePath)?.cwd);

    const { session } = await startRpcSession(id, filePath, cwd);
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

  if (isRemoteSessionId(id)) {
    try {
      const remote = await remoteState(id);
      return remote
        ? NextResponse.json({ running: remote.session.lifecycle === "running", state: remote.state })
        : NextResponse.json({ running: false });
    } catch (error) {
      return commandErrorResponse(error);
    }
  }
  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return commandErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isRemoteSessionId(id)) return NextResponse.json({ error: "Not a remote session" }, { status: 400 });
  try {
    const data = await stopRemoteSession(id);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return commandErrorResponse(error);
  }
}
