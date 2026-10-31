import { NextResponse } from "next/server";
import { readSessionHeader } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, resolveSpawnCwdResult, WebRpcError } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";

// Commands that ride whatever child is alive and never spawn or replace one:
// keystroke predictions, and the side-question reads/cancel omp-web sends in
// the background (SSE connect, reconcile). Without a live process there is no
// ghost text, no running side question and nothing to cancel, so the reply is
// known without omp. Asking (`btw`) and opening the history start omp first.
const NO_SPAWN_REPLIES: Record<string, unknown> = {
  predict_word: { suffix: null },
  predict_word_feedback: null,
  get_btw_history: { records: [] },
  btw_cancel: { cancelled: false },
};

// Live diagnostics of a skill-resolving omp. A saved or exited session has none,
// and resuming a full child (MCP, LSP) just to answer a read-only inspection or
// flip one setting is not what the click asked for: with no live wrapper these
// answer 409 instead of starting omp, and a live idle child is never replaced
// because the advisor flag differs.
const LIVE_SESSION_ONLY = new Set(["get_skill_diagnostics", "set_skill_startup_diagnostics"]);

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
    return NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: 400 });
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
    const noSpawn = Object.hasOwn(NO_SPAWN_REPLIES, body.type);
    const liveOnly = LIVE_SESSION_ONLY.has(body.type);
    if (existing?.isAlive()) {
      if (noSpawn || liveOnly || existing.advisorSpawned === advisor || existing.isRunning() || existing.isEditingHistory()) {
        const result = await existing.send(body);
        return NextResponse.json({ success: true, data: result });
      }
      await existing.destroyAndWait();
    }
    if (noSpawn) return NextResponse.json({ success: true, data: NO_SPAWN_REPLIES[body.type] });
    if (liveOnly) {
      return NextResponse.json(
        { error: "Skill diagnostics require a running session", code: "skill_diagnostics_unavailable" },
        { status: 409 },
      );
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const header = readSessionHeader(filePath);
    const { cwd } = resolveSpawnCwdResult(header?.cwd);

    // A cold set_model must reach omp before the saved model is restored:
    // spawning with only --resume lets omp exit on an unrestorable saved
    // model before the RPC below ever runs (#277). Binding the requested
    // model at spawn time skips that restore check. Live children never
    // reach this path (they take the fast path above), and any other command
    // keeps the previous spawn behavior.
    const spawnModel =
      body.type === "set_model" &&
      typeof body.provider === "string" &&
      typeof body.modelId === "string" &&
      body.provider.trim() &&
      body.modelId.trim() &&
      !body.provider.startsWith("-") &&
      !body.modelId.startsWith("-") &&
      !/\s/.test(body.provider) &&
      !/\s/.test(body.modelId)
        ? `${body.provider}/${body.modelId}`
        : undefined;

    const { session } = await startRpcSession(id, filePath, cwd, undefined, advisor, header?.cwd, undefined, spawnModel);
    if (spawnModel) {
      // Try the normal RPC first: when it succeeds it also records the new
      // model in the session, so later spawns restore it without an override.
      // But in omp 18.12.6 set_model can fail spuriously with "Model not
      // found" for a catalog model whose provider has no credentials
      // configured, even though the spawn already bound it. In that case the
      // switch itself succeeded — verify from live state and report success
      // rather than a false failure. A mismatch (e.g. an omp without --model
      // precedence) rethrows the RPC error, so a real failure still surfaces.
      try {
        const result = await session.send(body);
        return NextResponse.json({ success: true, data: result });
      } catch (error) {
        const state = (await session.send({ type: "get_state" })) as {
          model?: { id?: unknown; provider?: unknown };
        } | null;
        if (state?.model?.provider === body.provider && state?.model?.id === body.modelId) {
          return NextResponse.json({ success: true, data: { id: body.modelId, provider: body.provider } });
        }
        throw error;
      }
    }
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
      return NextResponse.json({ running: false, alive: false });
    }
    try {
      const state = await session.send({ type: "get_state" });
      // `running` is the run, `alive` the child. A live omp that is merely idle
      // (freshly spawned, between turns) must never look like a run in flight,
      // or every client shows a working state over a chat nobody asked anything.
      // `get_state` reconciled the wrapper's flags above, so the run state is
      // authoritative here.
      return NextResponse.json({ running: session.isRunning(), alive: true, state });
    } catch (error) {
      // omp being slow is not the run ending: answer 503 so clients retry the
      // poll instead of treating the session as idle/recovered. 0.6.0's own
      // get_state timeout reports `session_state_timeout`; native clients know
      // only one "still running, retry" state, so both codes answer as
      // `session_slow`.
      if (error instanceof WebRpcError && (error.code === "session_slow" || error.code === "session_state_timeout")) {
        // A blocked child answers nothing, so this 503 is the client's only
        // chance to learn how long the run it still shows has been silent — and
        // whether that run exists at all: an idle child that is just loading a
        // large session answers `session_slow` too, and clients must be able to
        // settle on that instead of keeping the run marked until the next
        // successful poll.
        return NextResponse.json({
          error: error.message,
          code: "session_slow",
          ...error.details,
          running: session.isRunning(),
          // The timeout that answers this 503 may just have disposed a stalled
          // child; the body must not advertise a process that is gone.
          alive: session.isAlive(),
          silentForMs: session.silentForMs(),
        }, { status: 503 });
      }
      throw error;
    }
  } catch (error) {
    return commandErrorResponse(error);
  }
}
