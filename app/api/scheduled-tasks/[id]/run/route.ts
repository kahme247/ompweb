import { NextResponse } from "next/server";
import { scheduledTaskErrorResponse } from "@/lib/scheduled-task-api";
import { getScheduledTaskRunner } from "@/lib/scheduled-task-runner";

// POST /api/scheduled-tasks/[id]/run → 202 { run }
// Returns once the run's prompt was accepted (run.sessionId is set) or the run
// was recorded as failed to start; the turn itself continues in the background.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await getScheduledTaskRunner().runNow(id);
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return scheduledTaskErrorResponse(error);
  }
}
