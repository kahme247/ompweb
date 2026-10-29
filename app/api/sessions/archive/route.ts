import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { listArchivedSessions, restoreArchivedSession } from "@/lib/omp/archive";
import { invalidateLocalSessionLists } from "@/lib/hosts/session-index";
import { invalidateSessionListCache } from "@/lib/session-reader";
import type { ArchivedSessionInfo } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const archives = await listArchivedSessions();
    const response: ArchivedSessionInfo[] = archives.map((archive) => ({
      key: archive.key,
      id: archive.id,
      cwd: archive.cwd,
      ...(archive.title ? { name: archive.title } : {}),
      created: archive.created.toISOString(),
      archivedAt: archive.archivedAt.toISOString(),
      messageCount: archive.messageCount,
      firstMessage: archive.firstMessage,
      size: archive.size,
      status: archive.status,
    }));
    return NextResponse.json({ archives: response }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { key?: unknown };
    if (typeof body.key !== "string" || !body.key.trim()) {
      return NextResponse.json({ error: "Archive key is required", code: "archive_key_required" }, { status: 400 });
    }
    const sessionId = restoreArchivedSession(body.key);
    invalidateSessionListCache();
    invalidateLocalSessionLists();
    return NextResponse.json({ ok: true, sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("Invalid archive key") || message.includes("required") ? 400 : message.includes("not found") ? 404 : message.includes("already exists") ? 409 : 500;
    return NextResponse.json({ error: message, code: "archive_restore_failed" }, { status });
  }
}
