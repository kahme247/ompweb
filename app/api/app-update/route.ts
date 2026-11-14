import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { checkNpmUpdate } from "@/lib/npm-update";
import {
  acknowledgeSelfUpdate,
  commitSelfUpdate,
  getSelfUpdateStatus,
  getSelfUpdateSupport,
  prepareSelfUpdate,
  SelfUpdateError,
} from "@/lib/self-update";
import { getUpgradePlan, UpgradePlanError } from "@/lib/upgrade-plan";
import type { UpgradePlan } from "@/lib/upgrade-types";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { isRecord } from "@/lib/type-guards";


function errorResponse(error: unknown): Response {
  if (error instanceof SelfUpdateError || error instanceof UpgradePlanError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  }
  if (error instanceof HostOpError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return Response.json({ error: "The application update could not be started", code: "update_failed" }, { status: 500 });
}

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const status = await checkNpmUpdate(force);
  const support = getSelfUpdateSupport();
  const selfUpdateStatus = status.updatesDisabled ? null : getSelfUpdateStatus();
  // A bad plan must not fail the poll. Status and every other error still surface.
  let upgradePlan: UpgradePlan | null | undefined;
  if (selfUpdateStatus) {
    try { upgradePlan = getUpgradePlan(selfUpdateStatus.attemptId); }
    catch { upgradePlan = undefined; }
  }
  return Response.json({
    ...status,
    selfUpdateSupported: support.supported,
    ...(selfUpdateStatus ? { selfUpdateStatus } : {}),
    ...(upgradePlan !== undefined ? { upgradePlan } : {}),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return Response.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Content-Type must be application/json", code: "unsupported_media_type" }, { status: 415 });
  }
  try {
    const body = await parseJsonWithinLimit<unknown>(request, 4_096);
    if (!isRecord(body)) throw new SelfUpdateError("invalid_action", "action must be prepare, commit, status, or acknowledge");
    const keys = Object.keys(body);
    if (body.action === "prepare" && keys.length === 1) {
      const result = await prepareSelfUpdate();
      return Response.json(result, { status: 202 });
    }
    if (body.action === "acknowledge" && keys.length === 2 && typeof body.attemptId === "string") {
      return Response.json(acknowledgeSelfUpdate(body.attemptId));
    }
    if (body.action === "commit" && keys.length === 3 && typeof body.attemptId === "string"
      && isRecord(body.approval) && Object.keys(body.approval).length === 2
      && typeof body.approval.planId === "string" && typeof body.approval.force === "boolean") {
      const result = await commitSelfUpdate(body.attemptId, { planId: body.approval.planId, force: body.approval.force });
      return Response.json(result, { status: 202 });
    }
    if (body.action === "status" && keys.length === 1) {
      const selfUpdateStatus = getSelfUpdateStatus();
      return Response.json(selfUpdateStatus ?? null, { headers: { "Cache-Control": "no-store" } });
    }
    throw new SelfUpdateError("invalid_action", "action must be prepare, commit, status, or acknowledge");
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Response.json({ error: error.message, code: "body_too_large" }, { status: 413 });
    if (error instanceof SyntaxError) return errorResponse(new SelfUpdateError("invalid_json", "Request body must be valid JSON"));
    return errorResponse(error);
  }
}
