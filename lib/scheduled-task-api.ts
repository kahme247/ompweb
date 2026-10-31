import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "./api-utils";
import { RequestBodyTooLargeError } from "./bounded-form-data";
import { ScheduledTaskLimitError, ScheduledTaskNotFoundError, ScheduledTaskRunningError } from "./scheduled-task-runner";
import type { ScheduledTaskFieldErrors } from "./scheduled-tasks";

/** A prompt of maxPromptLength UTF-8 characters plus the other fields. */
export const MAX_SCHEDULED_TASK_REQUEST_BYTES = 128 * 1024;

export function invalidScheduledTaskResponse(fields: ScheduledTaskFieldErrors): NextResponse {
  return NextResponse.json({ error: "Invalid scheduled task", code: "invalid_scheduled_task", fields }, { status: 400 });
}

/** 400 when the workspace directory is missing, else null. */
export function missingDirectoryResponse(cwd: string | undefined): NextResponse | null {
  if (cwd === undefined || existsSync(cwd)) return null;
  return NextResponse.json({ error: `Directory does not exist: ${cwd}`, code: "directory_not_found" }, { status: 400 });
}

export function scheduledTaskErrorResponse(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Scheduled task request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof ScheduledTaskNotFoundError) return NextResponse.json({ error: error.message, code: error.code }, { status: 404 });
  if (error instanceof ScheduledTaskLimitError || error instanceof ScheduledTaskRunningError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
  }
  return apiErrorResponse(error);
}
