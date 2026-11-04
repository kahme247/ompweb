import { apiErrorResponse } from "@/lib/api-utils";
import { parseLocalUri } from "@/lib/local-uri";
import { resolveSessionLocalFile } from "@/lib/session-local-files";

/** GET ?uri=local://<file> — the absolute path of a file in the session's own `local://` directory, for the file
 * viewer (open_file). The file is stat'ed, not read: 404 `file_not_found` when it is not there, so the agent hears it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = parseLocalUri(new URL(request.url).searchParams.get("uri") ?? "");
  if (!parsed.ok) return Response.json({ error: parsed.error, code: "invalid_local_uri" }, { status: 400 });
  try {
    const result = await resolveSessionLocalFile(id, parsed.relative);
    if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
    return Response.json({ path: result.path }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
