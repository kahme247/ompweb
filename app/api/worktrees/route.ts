import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(params.get("hostId") ?? undefined, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.listWorktrees(params.get("cwd") ?? "");
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (!isRecord(body) || typeof body.cwd !== "string" || typeof body.branch !== "string" || (body.hostId !== undefined && typeof body.hostId !== "string")) return Response.json({ error: "Invalid worktree request", code: "invalid_request" }, { status: 400 });
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.addWorktree(body.cwd, body.branch);
    if (!result.ok) return opErrorResponse(result);
    invalidateHostSessionList(resolved.host.id);
    return Response.json(result.value);
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (!isRecord(body) || typeof body.cwd !== "string" || typeof body.path !== "string" || (body.hostId !== undefined && typeof body.hostId !== "string") || (body.force !== undefined && typeof body.force !== "boolean")) return Response.json({ error: "Invalid worktree request", code: "invalid_request" }, { status: 400 });
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.removeWorktree(body.cwd, body.path, body.force === true);
    if (!result.ok) return Response.json({ error: result.error, code: result.code, dirty: result.code === "worktree_dirty" }, { status: result.status });
    invalidateHostSessionList(resolved.host.id);
    return Response.json({ success: true });
  } catch (error) { return apiErrorResponse(error); }
}
