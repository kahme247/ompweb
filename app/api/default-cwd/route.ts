import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";

export async function POST(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(params.get("hostId") ?? undefined, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.defaultCwd();
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) { return apiErrorResponse(error); }
}
