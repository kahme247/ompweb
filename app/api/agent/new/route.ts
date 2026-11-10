import { apiErrorResponse, opErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { WebRpcError, startNewRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { validateAgentImages } from "@/lib/image-attachments";
import { PoolStartError, startPooledSession } from "@/lib/hosts/pool-starts";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { isRecord } from "@/lib/type-guards";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof PoolStartError) {
    return Response.json({ error: error.message, code: error.code, sessionId: error.sessionId, hostId: error.hostId, cwd: error.cwd, delivery: error.delivery }, { status: error.status });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // host_offline falls through to apiErrorResponse: 503 {hostOffline: true}.
  if ((error instanceof WebRpcError && error.code !== "host_offline") || error instanceof RpcCommandError) {
    return Response.json(
      { error: error.message, code: error instanceof WebRpcError ? error.code : (error.code ?? "rpc_command_failed") },
      { status: 400 },
    );
  }
  return apiErrorResponse(error);
}
// Pooled creation carries creationId/poolId/projectId, never physical host/cwd.
// Standalone creation keeps its existing checked host-local cwd and cleanup.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: string; hostId?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    if (!isRecord(body)) return Response.json({ error: "A session request object is required", code: "invalid_request" }, { status: 400 });
    const { cwd: requestedCwd, hostId, poolId, projectId, creationId, ref, ...command } = body;
    delete command.intentHash;
    const pooled = poolId !== undefined || projectId !== undefined || creationId !== undefined || ref !== undefined;
    if (pooled && (hostId !== undefined || requestedCwd !== undefined || typeof poolId !== "string" || typeof projectId !== "string" || typeof creationId !== "string" || (ref !== undefined && typeof ref !== "string"))) {
      return Response.json({ error: "Pool creation requires creationId, poolId and projectId, without hostId or cwd", code: "invalid_pool_target" }, { status: 400 });
    }
    const { provider, modelId, toolNames, thinkingLevel, advisor, name, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; advisor?: boolean; name?: string; [key: string]: unknown };
    // A session id has no meaning for a fresh spawn and must never reach the
    // child RPC: a stale or forged id would address the wrong session.
    delete promptCommand.sessionId;
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return Response.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }
    if ([provider, modelId, thinkingLevel, name].some((value) => value !== undefined && (typeof value !== "string" || !value.trim()))
      || (toolNames !== undefined && (!Array.isArray(toolNames) || toolNames.some((value) => typeof value !== "string" || !value.trim())))
      || (advisor !== undefined && typeof advisor !== "boolean")
      || (promptCommand.message !== undefined && typeof promptCommand.message !== "string")) {
      return Response.json({ error: "Invalid session initialization fields", code: "invalid_creation_intent" }, { status: 400 });
    }
    const imageError = validateAgentImages(promptCommand.images);
    if (imageError) return Response.json({ error: imageError, code: "invalid_images" }, { status: 400 });

    const initialize = async (session: AgentSessionWrapper, preserveUnknownDelivery: boolean) => {
      if (provider && modelId) await session.send({ type: "set_model", provider, modelId }, { preserveUnknownDelivery });
      if (thinkingLevel) await session.send({ type: "set_thinking_level", level: thinkingLevel }, { preserveUnknownDelivery });
      if (name) await session.send({ type: "set_session_name", name }, { preserveUnknownDelivery });
      if (promptCommand.type === "ensure_session") return null;
      return session.send(promptCommand, { preserveUnknownDelivery });
    };

    if (pooled) {
      // The hash is derived here from every effectful field, including unknown command options.
      const intent = { ...promptCommand, provider, modelId, toolNames, thinkingLevel, advisor, name };
      const result = await startPooledSession({ creationId: creationId as string, poolId: poolId as string, projectId: projectId as string, ...(ref === undefined ? {} : { ref: ref as string }), intent }, async (host, prepared, id, onStarted) => {
        const started = await startNewRpcSession(host, prepared.cwd, toolNames, advisor === true, id);
        if (!started.ok) throw new HostOpError(started.status, started.code, started.error);
        const { session, realSessionId } = started.value;
        await onStarted(realSessionId);
        return { sessionId: realSessionId, data: await initialize(session, true) };
      });
      return Response.json({ success: true, ...result });
    }

    if (!requestedCwd || typeof requestedCwd !== "string") {
      return Response.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }
    const target = resolveHostOrError(hostId);
    if ("response" in target) return target.response;
    const started = await startNewRpcSession(target.host, requestedCwd, toolNames, advisor === true);
    if (!started.ok) return opErrorResponse(started);
    const { session, realSessionId } = started.value;
    try {
      return Response.json({ success: true, sessionId: realSessionId, data: await initialize(session, false) });
    } catch (error) {
      if (error instanceof WebRpcError && error.code === "host_offline") {
        return Response.json({ error: error.message, code: error.code, hostOffline: true, delivery: error.delivery, sessionId: realSessionId }, { status: 503 });
      }
      await session.destroyAndWait();
      throw error;
    }
  } catch (error) {
    return newSessionErrorResponse(error);
  }
}
