import { apiErrorResponse, opErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { listArchivedSessionInfos, restoreArchivedSession, restoreFailureStatus } from "@/lib/omp/archive";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { getHost, listHosts } from "@/lib/hosts/hub";
import { isLinkUp } from "@/lib/hosts/host";
import { invalidateHostSessionList, invalidateLocalSessionLists } from "@/lib/hosts/session-index";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { pumpOutbox } from "@/lib/message-outbox";
import { invalidateSessionListCache } from "@/lib/session-reader";
import type { ArchivedSessionInfo } from "@/lib/types";
import { isValidSessionId } from "@/lib/session-file-references-core";
import { withArchiveRestoreLock, type HeldRestore } from "@/lib/archive-restore-lock";

/** A registered host is offline, so restore cannot prove the session is not active there. */
class RestoreHostOfflineError extends HostOpError {
  constructor(readonly host: string) {
    super(503, "host_offline", `${host} is offline; restoring an archive needs every registered host online to check the session is not active there`);
  }
}

/** Resolves only once the host has fenced an earlier restore of this session (it can no longer start, whenever its request
 * arrives) and reports none running: until then it may still publish the session. */
async function confirmRestoreStopped(held: HeldRestore): Promise<void> {
  const host = getHost(held.hostId);
  const sent = `sent to ${host?.label ?? `host ${held.hostId}`} (last seen alive ${new Date(held.since).toISOString()})`;
  // Fails closed, with no timeout and no clearing: unregistering a host does not stop its daemon, which may still run or be sent
  // the restore, and nothing here can ask it. The claim stays until an operator who verified the daemon is stopped removes its row.
  if (!host) {
    throw new HostOpError(409, "archive_restore_unconfirmed", `Session ${held.sessionId} cannot be restored: an earlier restore of it was ${sent}, and its outcome was never learned. That host is no longer registered, and unregistering does not stop its daemon, so the session stays blocked. There is no automatic recovery; see AGENTS.md, "Session archive is per host".`);
  }
  let reason: string | null;
  try {
    const fence = await host.sessionOps.restoreFence(held.claim);
    reason = !fence.ok ? fence.error : fence.value.running ? "it is still running" : null;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (reason) throw new HostOpError(409, "archive_restore_unconfirmed", `Session ${held.sessionId} cannot be restored yet: an earlier restore of it was ${sent} and may still be running or arrive (${reason})`);
}

async function activeSessionHosts(sessionId: string): Promise<string[]> {
  const hosts = [getHost(LOCAL_HOST_ID), ...listHosts().map((row) => getHost(row.id))];
  const ensureLinked = () => {
    for (const host of hosts) {
      // Removed mid-check: not offline, but its sessions were not read either.
      if (!host) throw new HostOpError(503, "host_sessions_unavailable", "A host was removed while checking active sessions; the archive was not restored");
      if (!isLinkUp(host.status())) throw new RestoreHostOfflineError(host.label);
    }
  };
  ensureLinked();
  const lists = await Promise.all(hosts.map(async (host) => {
    try {
      // Ordered link requests invalidate the daemon's own cache before its list runs.
      host!.invalidateSessionLists();
      return { hostId: host!.id, sessions: await host!.sessionOps.listSessions() };
    } catch {
      ensureLinked();
      throw new HostOpError(503, "host_sessions_unavailable", "Could not read every host's active sessions; the archive was not restored");
    }
  }));
  ensureLinked();
  return lists.filter(({ sessions }) => sessions.some((session) => session.id === sessionId)).map(({ hostId }) => hostId);
}

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
    if (!isValidSessionId(archive.id)) {
      return Response.json({ error: "Invalid archived session ID", code: "archive_session_invalid" }, { status: 400 });
    }
    return await withArchiveRestoreLock(archive.id, async (claim) => {
      const conflicts = await activeSessionHosts(archive.id);
      const foreign = conflicts.find((id) => id !== hostId);
      if (foreign) {
        return Response.json({
          error: `Session ${archive.id} is already active on another host (${foreign}); the archive was not restored`,
          code: "session_host_conflict",
        }, { status: 409 });
      }
      if (conflicts.length) {
        return Response.json({
          error: `Session ${archive.id} is already active on this host; the archive was not restored`,
          code: "archive_restore_failed",
        }, { status: 409 });
      }
      if (host) {
        // A daemon starts a restore only under a token it reserved, and a fence revokes it. So a request this process sends
        // late (suspended after the hold) is refused once another request took the claim over, however late it arrives.
        const reserved = await host.sessionOps.restoreReserve(claim.token);
        if (!reserved.ok) return opErrorResponse(reserved);
        // Held before the restore leaves: the claim must outlive a timeout, a lost link and this process, as the daemon keeps restoring.
        claim.hold(hostId);
        let result;
        try {
          result = await host.sessionOps.restoreArchive(body.key as string, claim.token);
        } catch (error) {
          // An answer, even a refusal, or an op that never left ends the claim. A silent host or a lost link leaves it held.
          if (error instanceof HostOpError && error.code !== "host_timeout" && error.code !== "host_offline") claim.release();
          else if (error instanceof HostOpError) throw new HostOpError(error.status, "archive_restore_unconfirmed", `${error.message}; the restore may still be running there, so this session stays blocked until ${host.label} confirms it stopped`);
          throw error;
        }
        claim.release();
        if (!result.ok) return opErrorResponse(result);
        invalidateHostSessionList(hostId);
        pumpOutbox(result.value.sessionId);
        return Response.json({ ok: true, sessionId: result.value.sessionId });
      }
      const sessionId = await restoreArchivedSession(body.key as string, undefined, undefined, claim.publish);
      invalidateSessionListCache();
      invalidateLocalSessionLists();
      // Messages held while it was archived go now (spec O6).
      pumpOutbox(sessionId);
      return Response.json({ ok: true, sessionId });
    }, confirmRestoreStopped);
  } catch (error) {
    if (error instanceof RestoreHostOfflineError) {
      return Response.json({ error: error.message, code: error.code, hostOffline: true, host: error.host }, { status: error.status });
    }
    if (error instanceof HostOpError) return apiErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: "archive_restore_failed" }, { status: restoreFailureStatus(message) });
  }
}
