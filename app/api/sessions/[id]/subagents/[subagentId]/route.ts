import { NextResponse } from "next/server";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { isValidSubagentId } from "@/lib/hosts/session-ops";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/subagents/[subagentId]?fromByte=N
 *
 * Default: paged transcript of one subagent, read directly from the parent
 * session's sibling artifacts dir. Mirrors the RPC get_subagent_messages
 * response shape so the dialog can fall back to it when no live RPC process
 * knows the file.
 *
 * ?mode=completion: the subagent's final output (`<id>.md`), without loading
 * the transcript — works even for transcripts beyond the readable size cap.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; subagentId: string }> }
) {
  const { id, subagentId } = await params;
  try {
    if (!isValidSubagentId(subagentId)) {
      return NextResponse.json({ error: "Invalid subagent id", code: "invalid_subagent_id" }, { status: 400 });
    }
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const searchParams = new URL(req.url).searchParams;
    const fromByteRaw = searchParams.get("fromByte");
    const result = await resolved.host.sessionOps.readSubagentTranscript(
      id,
      subagentId,
      searchParams.get("mode") === "completion" ? "completion" : "page",
      fromByteRaw !== null ? Number(fromByteRaw) : 0,
    );
    return result.ok ? NextResponse.json(result.value) : opErrorResponse(result);
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
