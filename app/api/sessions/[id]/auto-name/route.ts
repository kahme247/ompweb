import { NextResponse } from "next/server";
import { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { invalidateHostSessionList, sessionSpawnTarget } from "@/lib/hosts/session-index";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateSessionCaches } from "@/lib/session-reader";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";

/**
 * POST /api/sessions/[id]/auto-name
 *
 * Generates a title with omp's own title generator (the native `generate_title`
 * command, else argument-less `/rename`) through the session's omp process,
 * starting one when the session is not live. omp persists the title itself.
 * When omp cannot generate one (older omp, a run in flight, spawn failure) the
 * endpoint falls back to the existing title, else a title derived from the
 * first user message, and saves that fallback (through the live process when
 * there is one). `generated` tells the caller which path produced the title.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // This runs before the path check because omp does not create the session
    // file until the history holds an assistant message.
    let rpc = getRpcSession(id);
    if (!rpc?.isAlive?.()) {
      const resolved = await resolveSessionHostOr404(id);
      if ("response" in resolved) return resolved.response;
      try {
        const target = await sessionSpawnTarget(id, resolved.host);
        if (target) {
          rpc = (await startRpcSession(id, target.sessionFile, target.cwd, undefined, undefined, target.recordedCwd, undefined, resolved.host)).session;
        }
      } catch {
        rpc = undefined; // Fall through to the fallback title.
      }
    }

    if (rpc?.isAlive?.()) {
      try {
        const generated = sanitizeSessionTitle((await rpc.generateTitle()) ?? undefined);
        if (generated) {
          invalidateSessionCaches(rpc.sessionFile);
          return NextResponse.json({ title: generated, generated: true, usage: null });
        }
      } catch (error) {
        // A busy/restarting session reports a typed error the UI can show; any
        // other failure degrades to the fallback below.
        if (error instanceof WebRpcError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
        }
      }
    }

    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const { sessionOps } = resolved.host;

    const info = (await sessionOps.listSessions()).find((session) => session.id === id);
    const storedTitle = sanitizeSessionTitle(info?.name);
    if (storedTitle) {
      return NextResponse.json({ title: storedTitle, generated: false, usage: null });
    }

    const derived = deriveSessionTitleFromFirstMessage(info?.firstMessage);
    if (!derived) {
      return NextResponse.json(
        { error: "The session has no user messages to name", code: "session_no_messages_to_name" },
        { status: 409 },
      );
    }

    // Title generation/path resolution yielded; Edit may now own this session.
    if (getRpcSession(id)?.isEditingHistory()) {
      return NextResponse.json({ error: "Wait for the history edit to finish", code: "session_busy" }, { status: 409 });
    }

    // Save title both to disk and through the live process so it persists immediately.
    const renamed = await sessionOps.renameSessionFile(id, derived, "auto");
    if (!renamed.ok) return opErrorResponse(renamed);
    invalidateHostSessionList(resolved.host.id);
    if (rpc?.isAlive?.()) {
      try {
        await rpc.send({ type: "set_session_name", name: derived });
      } catch {
        // Saved on disk; ignore RPC sync failure.
      }
    }
    return NextResponse.json({ title: derived, generated: false, usage: null });
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
