import { serveWorkspaceRequest } from "@/lib/api-utils";
import { getWorkspaceIndex } from "@/lib/workspace-files";

export async function GET(request: Request) {
  return new URL(request.url).searchParams.has("sessionId")
    ? serveWorkspaceRequest(request, "index")
    : getWorkspaceIndex(request);
}
