import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { deleteMcpServer, parseMcpListOutput, readDiscoveredMcpServers, readMcpConfig, readUserMcpConfig, type McpLiveServer, validateMcpServer, writeMcpServer } from "@/lib/omp/mcp-config";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { WebRpcError, getRpcSession, resolveSpawnCwdResult, startRpcSession } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { redactMcpServer } from "@/lib/omp/mcp-config";

export const dynamic = "force-dynamic";
const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
function mcpErrorResponse(error: unknown) {
  const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
  return NextResponse.json({ error: error instanceof RequestBodyTooLargeError ? "MCP request is too large" : error instanceof Error ? error.message : String(error) }, { status });
}

/** Stable client-safe message for the GET liveError field: raw child-process
 *  errors (spawn failures, stderr tails) must not reach the browser. */
function sanitizeMcpLiveError(error: unknown): string {
  if (error instanceof WebRpcError || error instanceof RpcCommandError) {
    return error.message;
  }
  console.error("[api/mcp] live server list failed:", error);
  return "Could not load live MCP server states";
}

function mergeMcpServers(primary: McpLiveServer[], secondary: McpLiveServer[]): McpLiveServer[] {
  const result = [...primary];
  const seen = new Set(primary.map((server) => `${server.source}:${server.name}`));
  for (const server of secondary) {
    const key = `${server.source}:${server.name}`;
    if (!seen.has(key)) result.push(server);
  }
  return result;
}

async function allowedCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required");
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Workspace is not allowed");
  return cwd;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const requestedCwd = params.get("cwd");
    const cwd = requestedCwd ? await allowedCwd(requestedCwd) : null;
    const file = cwd ? readMcpConfig(cwd) : null;
    const user = readUserMcpConfig();
    const inventory: McpLiveServer[] = [
      ...user.servers.map(({ name, config }) => ({ name, source: "User level", status: config.enabled === false ? "disabled" as const : "configured" as const, type: typeof config.type === "string" ? config.type : typeof config.url === "string" ? "http" : "stdio" })),
      ...user.disabledServers.map((name) => ({ name, source: "Disabled", status: "disabled" as const })),
      ...Object.entries(file?.config.mcpServers ?? {}).map(([name, config]) => ({ name, source: "Project level", status: config.enabled === false ? "disabled" as const : "configured" as const, type: typeof config.type === "string" ? config.type : typeof config.url === "string" ? "http" : "stdio" })),
      ...readDiscoveredMcpServers(cwd ?? undefined, user.disabledServers),
    ];
    // The user-level config may carry bearer tokens/API keys in `headers` and
    // credentials in `env`. The UI only renders name/status/type/enabled —
    // never serialize the raw user-level server configs to the client.
    const safeUser = {
      path: user.path,
      disabledServers: user.disabledServers,
      error: user.error,
      servers: user.servers.map(({ name, config }) => {
        const type = typeof config.type === "string" && config.type !== "stdio" ? config.type
          : typeof config.url === "string" ? "http" : "stdio";
        const command = typeof config.command === "string" ? config.command.trim() : "";
        const url = typeof config.url === "string" ? config.url.trim() : "";
        const hasCommand = command.length > 0;
        const hasUrl = url.length > 0;
        const valid = (hasCommand || hasUrl) && !(hasCommand && hasUrl) && (type === "http" || type === "sse" ? hasUrl : hasCommand);
        return {
          name,
          status: config.enabled === false ? ("disabled" as const) : ("configured" as const),
          type,
          enabled: config.enabled !== false,
          valid,
        };
      }),
    };
    const sessionId = params.get("sessionId");
    let liveServers: ReturnType<typeof parseMcpListOutput> | undefined;
    let liveError: string | undefined;
    if (sessionId) {
      try {
        let session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          const sessionFile = await resolveSessionPath(sessionId);
          if (!sessionFile) throw new Error("Session not found");
          const header = readSessionHeader(sessionFile);
          const { cwd } = resolveSpawnCwdResult(header?.cwd);
          // No advisor opinion: this spawn is a side effect of listing MCP
          // servers and must not replace a child spawned with --advisor.
          ({ session } = await startRpcSession(sessionId, sessionFile, cwd, undefined, undefined, header?.cwd));
        }
        liveServers = mergeMcpServers(parseMcpListOutput(await session.getMcpList()), inventory);
      } catch (error) {
        liveError = sanitizeMcpLiveError(error);
      }
    }
    return NextResponse.json({ root: file?.root ?? null, path: file?.path ?? null, exists: file?.exists ?? false, servers: Object.entries(file?.config.mcpServers ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => ({ name, config: redactMcpServer(config) })), user: safeUser, inventory, liveServers, liveError });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: unknown; name?: unknown; previousName?: unknown; server?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    const cwd = await allowedCwd(body.cwd);
    validateMcpServer(body.name, body.server);
    if (body.previousName !== undefined && typeof body.previousName !== "string") throw new Error("previousName must be a string");
    return NextResponse.json({ success: true, ...writeMcpServer(cwd, body.name as string, body.server, body.previousName) });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ name?: unknown; server?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    validateMcpServer(body.name, body.server);
    return NextResponse.json({ success: true, message: "MCP server configuration is valid" });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: unknown; name?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    const cwd = await allowedCwd(body.cwd);
    if (typeof body.name !== "string") throw new Error("name is required");
    return NextResponse.json({ success: true, ...deleteMcpServer(cwd, body.name) });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
