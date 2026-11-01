import { NextResponse } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { checkOmpUpdate } from "@/lib/omp/updates";
import { restartAllRpcSessions } from "@/lib/rpc-manager";
import {
  acknowledgeSelfUpdate,
  commitSelfUpdate,
  getSelfUpdateStatus,
  markSelfUpdateStopping,
  prepareSelfUpdate,
  SelfUpdateError,
  validateCommitSelfUpdate,
} from "@/lib/self-update";

export const dynamic = "force-dynamic";

const OMP_KIND = "omp" as const;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof SelfUpdateError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  }
  return NextResponse.json({ error: "The OMP update could not be started", code: "update_failed" }, { status: 500 });
}

export async function POST(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "Content-Type must be application/json", code: "unsupported_media_type" }, { status: 415 });
  }
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown> | null>(request, 4_096);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SelfUpdateError("invalid_action", "action must be check, restart, update, status, or acknowledge");
    const keys = Object.keys(body);
    if (body.action === "check") {
      return NextResponse.json(await checkOmpUpdate(body.force === true));
    }
    if (body.action === "restart" && keys.length === 1) {
      const sessionsRestarted = await restartAllRpcSessions();
      return NextResponse.json({ success: true, sessionsRestarted });
    }
    if (body.action === "update" && keys.length === 1) {
      const result = await prepareSelfUpdate(OMP_KIND);
      return NextResponse.json(result, { status: 202 });
    }
    if (body.action === "commit" && keys.length === 2 && typeof body.attemptId === "string") {
      const commitState = validateCommitSelfUpdate(body.attemptId, OMP_KIND);
      if (commitState !== "replay") {
        if (commitState === "ready") markSelfUpdateStopping(body.attemptId, OMP_KIND);
        await commitSelfUpdate(body.attemptId, OMP_KIND);
      }
      return NextResponse.json({ accepted: true, attemptId: body.attemptId }, { status: 202 });
    }
    if (body.action === "status" && keys.length === 1) {
      const selfUpdateStatus = getSelfUpdateStatus(OMP_KIND);
      return NextResponse.json(selfUpdateStatus ?? null, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "acknowledge" && keys.length === 2 && typeof body.attemptId === "string") {
      return NextResponse.json(acknowledgeSelfUpdate(body.attemptId, OMP_KIND));
    }
    throw new SelfUpdateError("invalid_action", "action must be check, restart, update, status, or acknowledge");
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message, code: "body_too_large" }, { status: 413 });
    if (error instanceof SyntaxError) return errorResponse(new SelfUpdateError("invalid_json", "Request body must be valid JSON"));
    return errorResponse(error);
  }
}
