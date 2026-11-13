import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { restartAllRpcSessions } from "@/lib/rpc-manager";

/** Restarts every running omp session. omp itself updates with ompweb: its release ships the runner. */
export async function POST(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return Response.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Content-Type must be application/json", code: "unsupported_media_type" }, { status: 415 });
  }
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown> | null>(request, 4_096);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.action !== "restart" || Object.keys(body).length !== 1) {
      return Response.json({ error: "action must be restart", code: "invalid_action" }, { status: 400 });
    }
    const sessionsRestarted = await restartAllRpcSessions();
    return Response.json({ success: true, sessionsRestarted });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Response.json({ error: error.message, code: "body_too_large" }, { status: 413 });
    if (error instanceof SyntaxError) return Response.json({ error: "Request body must be valid JSON", code: "invalid_json" }, { status: 400 });
    return Response.json({ error: "The OMP sessions could not be restarted", code: "restart_failed" }, { status: 500 });
  }
}
