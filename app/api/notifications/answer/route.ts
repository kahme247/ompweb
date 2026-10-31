import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import type { ExtensionUiResponse, RpcAskDialogAnswer } from "@/lib/pi-types";
import { getRpcSession, isAskAnswers, WebRpcError } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** Answers are text; 64 KB leaves room for a long ask customInput without becoming a payload channel. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_CHARS = 256;

const invalid = (error: string) => NextResponse.json({ error, code: "invalid_answer_request" }, { status: 400 });

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

/**
 * Exactly one response variant, and nothing else. Shapes come from
 * ExtensionDialog; the ask payload reuses the agent route's validation.
 */
function parseResponse(value: unknown): ExtensionUiResponse | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  switch (keys[0]) {
    case "value":
      return typeof value.value === "string" ? { value: value.value } : null;
    case "confirmed":
      return typeof value.confirmed === "boolean" ? { confirmed: value.confirmed } : null;
    case "cancelled":
      return value.cancelled === true ? { cancelled: true } : null;
    case "answers":
      return isAskAnswers(value.answers) ? { answers: value.answers as RpcAskDialogAnswer[] } : null;
    default:
      return null;
  }
}

/**
 * POST /api/notifications/answer — answer a pending blocking extension dialog
 * from a notification action. Looks up the live wrapper (also through moved-
 * session aliases) and never spawns omp. Behind the normal auth gate.
 *
 * 200 {status:"answered"}      routed through extension_ui_response
 * 200 {status:"alreadySettled"} the request id is not pending
 * 200 {status:"sessionGone"}    no live wrapper for the session
 * 400 on an invalid body
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Answer is too large", code: "request_too_large" }, { status: 413 });
    }
    return invalid("Invalid JSON request body");
  }
  if (!isRecord(body) || !isId(body.sessionId) || !isId(body.requestId)) {
    return invalid("sessionId, requestId and response are required");
  }
  const response = parseResponse(body.response);
  if (!response) return invalid("response must be exactly one of value, confirmed, cancelled or answers");

  const session = getRpcSession(body.sessionId);
  if (!session || !session.isAlive()) return NextResponse.json({ status: "sessionGone" });

  try {
    return NextResponse.json({ status: session.answerExtensionUiRequest(body.requestId, response) });
  } catch (error) {
    if (error instanceof WebRpcError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    throw error;
  }
}
