import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";

export async function GET(request: Request) {
  try {
    const resolved = await resolveWorkspaceHost(new URL(request.url).searchParams.get("hostId") ?? undefined, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.home();
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) { return apiErrorResponse(error); }
}
