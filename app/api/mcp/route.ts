import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { deleteMcpServer, parseMcpListOutput, readDiscoveredMcpServers, readMcpConfig, readUserMcpConfig, type McpLiveServer, validateMcpServer, writeMcpServer } from "@/lib/omp/mcp-config";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { WebRpcError, getOwnChildPids, getRpcSession, isLocallyOwnedSession, isOwnCrashedSession, resolveSpawnCwdResult, startRpcSession } from "@/lib/rpc-manager";
import { detectSessionOwner } from "@/lib/session-owner";
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
  const result: McpLiveServer[] = primary.map((server) => ({ ...server, sourcePath: secondary.find((other) => other.name === server.name && other.source === server.source)?.sourcePath }));
  const seen = new Set(primary.map((server) => `${server.source}:${server.name}`));
  for (const server of secondary) {
    const key = `${server.source}:${server.name}`;
    if (!seen.has(key)) { result.push(server); seen.add(key); }
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
      ...user.servers.map(({ name, config }) => ({ name, source: "User level", sourcePath: user.path, status: config.enabled === false ? "disabled" as const : "configured" as const, type: typeof config.type === "string" ? config.type : typeof config.url === "string" ? "http" : "stdio" })),
      ...user.disabledServers.map((name) => ({ name, source: "Disabled", sourcePath: user.path, status: "disabled" as const })),
      ...Object.entries(file?.config.mcpServers ?? {}).map(([name, config]) => ({ name, source: "Project level", sourcePath: file?.path, status: config.enabled === false ? "disabled" as const : "configured" as const, type: typeof config.type === "string" ? config.type : typeof config.url === "string" ? "http" : "stdio" })),
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
    const includeLive = params.get("live") !== "0";
    // Advisor opinion for a fresh spawn only (same ?advisor=1 convention as
    // /api/agent/[id]): an alive child is reused as-is below, never replaced —
    // listing servers must stay side-effect-free.
    const advisor = params.get("advisor") === "1";
    let liveServers: McpLiveServer[] | undefined;
    let liveError: string | undefined;
    if (includeLive && sessionId) {
      try {
        let session = getRpcSession(sessionId);
        let foreignOwned = false;
        if (!session?.isAlive()) {
          const sessionFile = await resolveSessionPath(sessionId);
          if (!sessionFile) throw new Error("Session not found");
          // Same gate as POST /api/agent/[id]: listing servers must not start a
          // second writer. omp ≥ 18.5 moves a chat whose file another live
          // process owns into a copy on its first write — that spawn is exactly
          // the silent fork the ownership detection exists to prevent.
          const elsewhere = await detectSessionOwner(sessionId, sessionFile, {
            isLocal: isLocallyOwnedSession,
            ownCrashed: isOwnCrashedSession,
            excludePids: getOwnChildPids(),
          });
          if (elsewhere) {
            // Answer through the existing error path: an empty live list reads
            // as "no MCP servers" in both clients, so the ownership message is
            // what makes them fall back to the configured inventory and explain
            // the missing live status.
            foreignOwned = true;
            liveError = "This session is being run by another omp process.";
          } else {
            const header = readSessionHeader(sessionFile);
            const { cwd } = resolveSpawnCwdResult(header?.cwd);
            // Fresh spawn only (an alive child is reused above): apply the
            // caller's advisor opinion so a racing prompt doesn't inherit a
            // wrong-flag child for its whole turn.
            ({ session } = await startRpcSession(sessionId, sessionFile, cwd, undefined, advisor, header?.cwd));
          }
        }
        if (!foreignOwned) {
          if (!session) throw new Error("Session not found");
          liveServers = mergeMcpServers(parseMcpListOutput(await session.getMcpList()), inventory);
        }
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

/** Native local commands only: never a model prompt or shell command. */
export async function PATCH(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ sessionId?: unknown; action?: unknown; name?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    if (typeof body.sessionId !== "string" || !body.sessionId) throw new Error("Select a session first");
    if (body.action !== "enable" && body.action !== "disable" && body.action !== "reload") throw new Error("Invalid MCP action");
    if (body.action !== "reload" && (typeof body.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.name))) throw new Error("Invalid MCP server name");
    // Load the selected session through the same validated path as inventory.
    // Do not create a different session or apply the caller's arbitrary cwd.
    let session = getRpcSession(body.sessionId);
    if (!session?.isAlive()) {
      const sessionFile = await resolveSessionPath(body.sessionId);
      if (!sessionFile) throw new Error("Session not found");
      const header = readSessionHeader(sessionFile);
      const { cwd } = resolveSpawnCwdResult(header?.cwd);
      ({ session } = await startRpcSession(body.sessionId, sessionFile, cwd, undefined, undefined, header?.cwd));
    }
    if (session.isRunning()) return NextResponse.json({ error: "Wait for the current run to finish before changing MCP servers." }, { status: 409 });
    await session.changeMcp(body.action, typeof body.name === "string" ? body.name : undefined);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: sanitizeMcpLiveError(error) }, { status: error instanceof WebRpcError && error.code === "session_busy" ? 409 : 400 });
  }
}
