import { createHash } from "crypto";
import { ifNoneMatchSatisfied } from "@/lib/api-utils";
import { listSessionsAllHosts } from "@/lib/hosts/session-index";
import { getRunningRpcSessions } from "@/lib/rpc-manager";
import { refreshElsewhereSessions } from "@/lib/session-owner";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

export async function GET(req: Request) {
  try {
    const sessions = await listSessionsAllHosts();
    const runningSessions = getRunningRpcSessions();
    const runningSessionIds = runningSessions.map((s) => s.id);
    // Sessions a foreign omp writer holds: another omp-web instance, a terminal
    // `omp`, or a transcript that was still open a moment ago. Detected here so
    // the sidebar gets the badge with the list instead of a second round trip.
    // Liveness defaults come from this process's wrapper registry + crash map;
    // non-local candidates are skipped by the detector itself.
    const elsewhereSessions = await refreshElsewhereSessions(
      sessions.map((session) => ({
        id: session.id,
        sessionFile: session.path,
        mtimeMs: Date.parse(session.modified),
        hostId: session.hostId,
      })),
    );
    const body = { sessions, runningSessionIds, runningSessions, elsewhereSessions };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;
    if (ifNoneMatchSatisfied(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new Response(bodyJson, {
      headers: {
        ETag: etag,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(bodyJson)),
        ...SESSION_LIST_HEADERS,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
