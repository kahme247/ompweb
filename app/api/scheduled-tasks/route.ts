import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import {
  invalidScheduledTaskResponse,
  MAX_SCHEDULED_TASK_REQUEST_BYTES,
  missingDirectoryResponse,
  scheduledTaskErrorResponse,
} from "@/lib/scheduled-task-api";
import { getScheduledTaskRunner, isSchedulerEnabled } from "@/lib/scheduled-task-runner";
import { parseScheduledTaskInput } from "@/lib/scheduled-tasks";

// GET  /api/scheduled-tasks → ScheduledTaskListResponse
// POST /api/scheduled-tasks  body: ScheduledTaskInput → 201 { task }
export async function GET() {
  try {
    return NextResponse.json(getScheduledTaskRunner().list(isSchedulerEnabled()), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = parseScheduledTaskInput(await parseJsonWithinLimit<unknown>(req, MAX_SCHEDULED_TASK_REQUEST_BYTES), false);
    if (!parsed.ok) return invalidScheduledTaskResponse(parsed.errors);
    const missing = missingDirectoryResponse(parsed.value.cwd);
    if (missing) return missing;
    return NextResponse.json({ task: getScheduledTaskRunner().create(parsed.value) }, { status: 201 });
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}
