import { apiErrorResponse, opErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { listArchivedSessionInfos, restoreArchivedSession, restoreFailureStatus } from "@/lib/omp/archive";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { getHost, listHosts } from "@/lib/hosts/hub";
import { isLinkUp } from "@/lib/hosts/host";
import { invalidateHostSessionList, invalidateLocalSessionLists, listSessionsAllHosts } from "@/lib/hosts/session-index";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { pumpOutbox } from "@/lib/message-outbox";
import { invalidateSessionListCache } from "@/lib/session-reader";
import type { ArchivedSessionInfo } from "@/lib/types";

/** Each linked host's archive; a host that is offline or cannot answer (an older daemon) is listed in `unavailableHosts`. */
async function linkedHostArchives(): Promise<{ archives: ArchivedSessionInfo[]; unavailableHosts: { id: string; label: string }[] }> {
  const results = await Promise.all(listHosts().map(async (row) => {
    const host = isLinkUp(row.status) ? getHost(row.id) : null;
    if (!host) return { archives: [], unavailable: { id: row.id, label: row.label } };
    try {
      const archives = await host.sessionOps.listArchives();
      return { archives: archives.map((archive) => ({ ...archive, hostId: row.id })), unavailable: null };
    } catch {
      return { archives: [], unavailable: { id: row.id, label: row.label } };
    }
  }));
  return {
    archives: results.flatMap((result) => result.archives),
    unavailableHosts: results.flatMap((result) => (result.unavailable ? [result.unavailable] : [])),
  };
}

export async function GET() {
  try {
    const [local, linked] = await Promise.all([
      listArchivedSessionInfos(),
      linkedHostArchives(),
    ]);
    const archives = [...local.map((archive) => ({ ...archive, hostId: LOCAL_HOST_ID })), ...linked.archives]
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    return Response.json({ archives, unavailableHosts: linked.unavailableHosts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { key?: unknown; hostId?: unknown };
    if (typeof body.key !== "string" || !body.key.trim()) {
      return Response.json({ error: "Archive key is required", code: "archive_key_required" }, { status: 400 });
    }
    if (body.hostId !== undefined && (typeof body.hostId !== "string" || !body.hostId.trim())) {
      return Response.json({ error: "Host ID must be a nonempty string", code: "invalid_host_id" }, { status: 400 });
    }
    const hostId = body.hostId === undefined ? LOCAL_HOST_ID : body.hostId as string;
    const resolved = hostId === LOCAL_HOST_ID ? null : resolveHostOrError(hostId);
    if (resolved && "response" in resolved) return resolved.response;
    const host = resolved?.host;
    const archives = host ? await host.sessionOps.listArchives() : await listArchivedSessionInfos();
    const archive = archives.find((entry) => entry.key === body.key);
    if (!archive) return Response.json({ error: "Archive not found", code: "archive_not_found" }, { status: 404 });
    const conflict = (await listSessionsAllHosts()).find((session) => session.id === archive.id && session.hostId !== hostId);
    if (conflict) {
      return Response.json({
        error: `Session ${archive.id} is already active on another host (${conflict.hostId}); the archive was not restored`,
        code: "session_host_conflict",
      }, { status: 409 });
    }
    if (host) {
      const result = await host.sessionOps.restoreArchive(body.key);
      if (!result.ok) return opErrorResponse(result);
      invalidateHostSessionList(hostId);
      pumpOutbox(result.value.sessionId);
      return Response.json({ ok: true, sessionId: result.value.sessionId });
    }
    const sessionId = restoreArchivedSession(body.key);
    invalidateSessionListCache();
    invalidateLocalSessionLists();
    // Messages held while it was archived go now (spec O6).
    pumpOutbox(sessionId);
    return Response.json({ ok: true, sessionId });
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: "archive_restore_failed" }, { status: restoreFailureStatus(message) });
  }
}
