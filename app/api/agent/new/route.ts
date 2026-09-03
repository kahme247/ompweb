import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { WebRpcError, startRpcSession } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { loadProjectRegistry } from "@/lib/project-registry";
import { comparableProjectPath } from "@/lib/comparable-path";
import { resolveProject } from "@/lib/worktree";
import { normalizeProfileName } from "@/lib/omp/paths";
/** 根据新会话 cwd 解析其工作区 profile；未配置时使用默认 profile。 */
async function profileForNewSession(cwd: string): Promise<string | undefined> {
  const project = await resolveProject(cwd);
  const projectRoot = project.projectRoot;
  const config = loadProjectRegistry().projects.find(
    (entry) => comparableProjectPath(entry.path) === comparableProjectPath(projectRoot),
  )?.launchConfig;
  return normalizeProfileName(config?.profile);
}

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof WebRpcError || error instanceof RpcCommandError) {
    return NextResponse.json(
      { error: error.message, code: error instanceof WebRpcError ? error.code : (error.code ?? "rpc_command_failed") },
      { status: 400 },
    );
  }
  return apiErrorResponse(error);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new omp session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is omp's real session id.
// Model/thinking presets are applied post-ready via RPC set_model /
// set_thinking_level (not CLI flags) so failures surface as command errors and
// the live model catalog (incl. background discovery) is consulted.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: string; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    const { cwd, ...command } = body;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}`, code: "directory_not_found" }, { status: 400 });
    }

    const { provider, modelId, toolNames, thinkingLevel, advisor, ...promptCommand } = command as {
      provider?: string;
      modelId?: string;
      toolNames?: string[];
      thinkingLevel?: string;
      advisor?: boolean;
      [key: string]: unknown;
    };
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // 使用一次性键避免并发新建请求互相合并；启动时显式传入工作区 profile。
    const tempKey = `__new__${randomUUID()}`;
    const profile = await profileForNewSession(cwd);
    const launchConfig = profile ? { profile } : undefined;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames, advisor === true, undefined, launchConfig);

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    try {
      // Apply pre-selected model before sending the prompt
      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }

      // Apply pre-selected thinking level before sending the prompt
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      // startRpcSession 已返回带 profile 命名空间的 Web 会话标识，不能再次封装。
      const sessionId = realSessionId
      if (promptCommand.type === "ensure_session") {
        return NextResponse.json({ success: true, sessionId, data: null });
      }

      const result = await session.send(promptCommand);

      return NextResponse.json({ success: true, sessionId, data: result });
    } catch (error) {
      // The child was spawned but the prompt never ran: without this cleanup a
      // failed set_model/set_thinking_level/prompt leaves an orphaned omp
      // process and a registry entry nobody will ever use.
      await session.destroyAndWait();
      throw error;
    }
  } catch (error) {
    return newSessionErrorResponse(error);
  }
}
