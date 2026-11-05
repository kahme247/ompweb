import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";
import { parseLocalUri } from "@/lib/local-uri";

/** GET ?uri=local://<file> — the absolute path of a file in the session's own `local://` directory, for the file
 * viewer (open_file). The owning host's daemon resolves and confines it (its machine, its platform rules); the file
 * is stat'ed, not read: 404 `file_not_found` when it is not there, so the agent hears it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const uri = new URL(request.url).searchParams.get("uri") ?? "";
  // Main checks only shared URI syntax; the owning daemon applies its platform's filename rules.
  const parsed = parseLocalUri(uri, null);
  if (!parsed.ok) return Response.json({ error: parsed.error, code: "invalid_local_uri" }, { status: 400 });
  try {
    const resolved = await resolveWorkspaceHost(undefined, id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.resolveLocalFile(resolved.sessionId ?? id, uri, resolved.sessionFile);
    if (!result.ok) return opErrorResponse(result);
    return Response.json({ path: result.value.path }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
