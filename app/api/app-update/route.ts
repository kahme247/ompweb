import { NextResponse } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { checkNpmUpdate } from "@/lib/npm-update";
import { abortPreparedSelfUpdate, acknowledgeSelfUpdate, armSelfUpdateLauncher, commitSelfUpdate, getSelfUpdateStatus, getSelfUpdateSupport, markSelfUpdateStopping, prepareSelfUpdate, SelfUpdateError, validateCommitSelfUpdate } from "@/lib/self-update";
import { beginAppUpdateDrain, cancelAppUpdateDrain, getAppUpdateDrainStatus } from "@/lib/rpc-manager";
export const dynamic = "force-dynamic";
type CommitResult = { accepted: true; attemptId: string };
declare global {
  var __ompAppUpdateCommitTransitions: Map<string, Promise<CommitResult>> | undefined;
}
const commitTransitions = globalThis.__ompAppUpdateCommitTransitions ??= new Map<string, Promise<CommitResult>>();

async function finishCommitTransition(attemptId: string): Promise<CommitResult> {
  let launcherArmed = false;
  try {
    await beginAppUpdateDrain();
    if ((getAppUpdateDrainStatus()?.total ?? 0) > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }
    await armSelfUpdateLauncher(attemptId);
    launcherArmed = true;
    const result = commitSelfUpdate(attemptId);
    const recoveryTimer = setTimeout(cancelAppUpdateDrain, 30_000);
    recoveryTimer.unref();
    return result;
  } catch (error) {
    cancelAppUpdateDrain();
    if (!launcherArmed) {
      const reason = error instanceof SelfUpdateError
        ? error.message
        : "The application update could not be committed";
      await abortPreparedSelfUpdate(attemptId, reason);
    }
    throw error;
  }
}

function commitAppUpdate(attemptId: string): Promise<CommitResult> {
  const existing = commitTransitions.get(attemptId);
  if (existing) return existing;

  const { promise, resolve, reject } = Promise.withResolvers<CommitResult>();
  commitTransitions.set(attemptId, promise);
  try {
    const commitState = validateCommitSelfUpdate(attemptId);
    if (commitState === "replay") {
      resolve({ accepted: true, attemptId });
    } else {
      if (commitState === "ready") markSelfUpdateStopping(attemptId);
      void finishCommitTransition(attemptId).then(resolve, reject);
    }
  } catch (error) {
    reject(error);
  }
  const clear = () => {
    if (commitTransitions.get(attemptId) === promise) commitTransitions.delete(attemptId);
  };
  void promise.then(clear, clear);
  return promise;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof SelfUpdateError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  }
  return NextResponse.json({ error: "The application update could not be started", code: "update_failed" }, { status: 500 });
}

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const status = await checkNpmUpdate(force);
  const support = getSelfUpdateSupport();
  const selfUpdateStatus = getSelfUpdateStatus();
  const appUpdateDrain = getAppUpdateDrainStatus();
  return NextResponse.json({
    ...status,
    selfUpdateSupported: support.supported,
    ...(selfUpdateStatus ? { selfUpdateStatus } : {}),
    ...(appUpdateDrain ? { appUpdateDrain } : {}),
  }, { headers: { "Cache-Control": "no-store" } });
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
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SelfUpdateError("invalid_action", "action must be prepare, commit, or acknowledge");
    const keys = Object.keys(body);
    if (body.action === "prepare" && keys.length === 1) {
      const result = await prepareSelfUpdate();
      return NextResponse.json(result, { status: 202 });
    }
    if (body.action === "acknowledge" && keys.length === 2 && typeof body.attemptId === "string") {
      return NextResponse.json(acknowledgeSelfUpdate(body.attemptId));
    }
    if (body.action === "commit" && keys.length === 2 && typeof body.attemptId === "string") {
      const result = await commitAppUpdate(body.attemptId);
      return NextResponse.json(result, { status: 202 });
    }
    throw new SelfUpdateError("invalid_action", "action must be prepare, commit, or acknowledge");
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message, code: "body_too_large" }, { status: 413 });
    if (error instanceof SyntaxError) return errorResponse(new SelfUpdateError("invalid_json", "Request body must be valid JSON"));
    return errorResponse(error);
  }
}
