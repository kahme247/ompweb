import { serveWorkspaceRequest } from "@/lib/api-utils";
import { getWorkspaceFiles, postWorkspaceFiles } from "@/lib/workspace-files";

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }>; disableIdleTimeout: () => void },
) {
  if (new URL(request.url).searchParams.has("sessionId")) {
    return serveWorkspaceRequest(request, "files", (await context.params).path, context.disableIdleTimeout);
  }
  return getWorkspaceFiles(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  if (new URL(request.url).searchParams.has("sessionId")) {
    return serveWorkspaceRequest(request, "files", (await context.params).path);
  }
  return postWorkspaceFiles(request, context);
}
