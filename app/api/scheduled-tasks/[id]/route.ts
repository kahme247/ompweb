import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import {
  invalidScheduledTaskResponse,
  MAX_SCHEDULED_TASK_REQUEST_BYTES,
  missingDirectoryResponse,
  scheduledTaskErrorResponse,
} from "@/lib/scheduled-task-api";
import { getScheduledTaskRunner } from "@/lib/scheduled-task-runner";
import { parseScheduledTaskInput } from "@/lib/scheduled-tasks";

// PATCH  /api/scheduled-tasks/[id]  body: Partial<ScheduledTaskInput> → { task }
// DELETE /api/scheduled-tasks/[id] → { deleted: true }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = parseScheduledTaskInput(await parseJsonWithinLimit<unknown>(req, MAX_SCHEDULED_TASK_REQUEST_BYTES), true);
    if (!parsed.ok) return invalidScheduledTaskResponse(parsed.errors);
    const missing = missingDirectoryResponse(parsed.value.cwd);
    if (missing) return missing;
    return NextResponse.json({ task: getScheduledTaskRunner().update(id, parsed.value) });
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    getScheduledTaskRunner().remove(id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}
