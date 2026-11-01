import { NextResponse } from "next/server";
import { apiErrorResponse, opErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { WebRpcError, startNewRpcSession } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // host_offline falls through to apiErrorResponse: 503 {hostOffline: true}.
  if ((error instanceof WebRpcError && error.code !== "host_offline") || error instanceof RpcCommandError) {
    return NextResponse.json(
      { error: error.message, code: error instanceof WebRpcError ? error.code : (error.code ?? "rpc_command_failed") },
      { status: 400 },
    );
  }
  return apiErrorResponse(error);
}
// POST /api/agent/new  body: { cwd: string; type: string; hostId?: string; message?: string; ... }
// Spawns a brand-new omp session on `hostId` (this machine when absent). Most
// calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is omp's real session id.
// Model/thinking presets are applied post-ready via RPC set_model /
// set_thinking_level (not CLI flags) so failures surface as command errors and
// the live model catalog (incl. background discovery) is consulted.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: string; hostId?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    const { cwd: requestedCwd, hostId, ...command } = body;
    const target = resolveHostOrError(hostId);
    if ("response" in target) return target.response;
    const { host } = target;

    if (!requestedCwd || typeof requestedCwd !== "string") {
      return NextResponse.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }

    const { provider, modelId, toolNames, thinkingLevel, advisor, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; advisor?: boolean; [key: string]: unknown };
    // A session id has no meaning for a fresh spawn and must never reach the
    // child RPC: a stale or forged id would address the wrong session.
    delete promptCommand.sessionId;
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // The cwd is checked on its host; the host answers with the path it will use.
    const started = await startNewRpcSession(host, requestedCwd, toolNames, advisor === true);
    if (!started.ok) return opErrorResponse(started);
    const { session, realSessionId } = started.value;

    try {
      // Apply pre-selected model before sending the prompt
      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }

      // Apply pre-selected thinking level before sending the prompt
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      if (promptCommand.type === "ensure_session") {
        return NextResponse.json({ success: true, sessionId: realSessionId, data: null });
      }

      const result = await session.send(promptCommand);

      return NextResponse.json({ success: true, sessionId: realSessionId, data: result });
    } catch (error) {
      // The child was spawned but the prompt never ran: without this cleanup a
      // failed set_model/set_thinking_level/prompt leaves an orphaned omp
      // process and a registry entry nobody will ever use.
      // The link dropped: the first command may be running there, so the
      // wrapper stays for the reconnect (and disposing it would wait for the link).
      // Its id lets the client open it instead of starting a second session.
      if (error instanceof WebRpcError && error.code === "host_offline") {
        return NextResponse.json({ error: error.message, code: error.code, hostOffline: true, delivery: error.delivery, sessionId: realSessionId }, { status: 503 });
      }
      await session.destroyAndWait();
      throw error;
    }
  } catch (error) {
    return newSessionErrorResponse(error);
  }
}
