import { NextResponse } from "next/server";
import { checkOmpUpdate } from "@/lib/omp/updates";
import { restartAllRpcSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; force?: boolean };
    if (body.action === "check") return NextResponse.json(await checkOmpUpdate(body.force === true));
    if (body.action === "update") {
      return NextResponse.json({ error: "Automatic self-updating is disabled. Run 'omp update' in your terminal.", code: "update_disabled" }, { status: 400 });
    }
    if (body.action === "restart") {
      const sessionsRestarted = await restartAllRpcSessions();
      return NextResponse.json({ success: true, sessionsRestarted });
    }
    return NextResponse.json({ error: "action must be check or restart", code: "invalid_action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
