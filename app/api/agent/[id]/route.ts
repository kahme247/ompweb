import { getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { commandErrorResponse, runAgentCommand } from "@/lib/agent-command";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { requestOwner } from "@/lib/web-auth";

/** Stamp when the handler had the request and when it answered, so the browser
 * can split network time from server time. */
function timed(receivedAt: number, res: Response): Response {
  res.headers.set("x-omp-received-at", String(receivedAt));
  res.headers.set("x-omp-replied-at", String(Date.now()));
  return res;
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Once the body is in, as a socket's ack is stamped after its whole frame: proxies stream uploads through, so the
  // handler starts before a large body has arrived. A body that fails to read is stamped when it failed.
  let receivedAt: number | undefined;

  try {
    const body = await parseJsonWithinLimit<unknown>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    receivedAt = Date.now();
    // The per-chat advisor choice rides on the query string (never the RPC
    // body, which is forwarded to omp verbatim) and only matters when this
    // request spawns or replaces the session's omp process.
    const advisor = new URL(req.url).searchParams.get("advisor") === "1";
    return timed(receivedAt, await runAgentCommand(id, body, advisor, requestOwner(req)));
  } catch (error) {
    return timed(receivedAt ?? Date.now(), commandErrorResponse(error));
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Default stays the full shape; `?systemPrompt=0` drops the ~13 KB prompt
  // from the 15 s state poll. Any other value (including "1") keeps it.
  const includeSystemPrompt = new URL(req.url).searchParams.get("systemPrompt") !== "0";

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return Response.json({ running: false });
    }
    try {
      // Through the wrapper's command path, not a dedicated method: that is
      // the contract every wrapper fake implements, and `dispatchCommand`
      // already honors `systemPrompt: false`.
      const state = await session.send({
        type: "get_state",
        ...(includeSystemPrompt ? {} : { systemPrompt: false }),
      });
      return Response.json({ running: true, state });
    } catch (error) {
      if (error instanceof WebRpcError && error.code === "session_unresponsive") {
        return Response.json({ running: false, recovered: true });
      }
      throw error;
    }
  } catch (error) {
    return commandErrorResponse(error);
  }
}
