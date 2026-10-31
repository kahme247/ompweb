import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessions } from "@/lib/rpc-manager";
import type { SessionInfo } from "@/lib/types";

declare global {
  var __ompSessionsRouteCache: {
    sessionsRef: SessionInfo[] | null;
    sessionsSig: string | null;
    runningSig: string | null;
    bodyJson: string | null;
    etag: string | null;
  } | undefined;
}

function getRouteCache() {
  return (globalThis.__ompSessionsRouteCache ??= {
    sessionsRef: null,
    sessionsSig: null,
    runningSig: null,
    bodyJson: null,
    etag: null,
  });
}
function computeSessionsSig(sessions: SessionInfo[]): string {
  let sig = `${sessions.length}:`;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    sig += `${JSON.stringify([s.id, s.path, s.cwd, s.modified, s.messageCount, s.name, s.firstMessage, s.lastMessageAt ?? null, s.projectRoot, s.worktreeBranch ?? null, s.parentSessionId ?? null])};`;
  }
  return sig;
}


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
    const url = new URL(req.url);
    const filterId = "nextUrl" in req && req.nextUrl instanceof URL
      ? req.nextUrl.searchParams.get("id")
      : url.searchParams.get("id");

    const sessions = await listAllSessions();
    const runningSessions = getRunningRpcSessions();
    const runningSessionIds = runningSessions.map((s) => s.id);

    if (filterId) {
      const matched = sessions.filter((s) => s.id === filterId);
      const body = { sessions: matched, runningSessionIds, runningSessions };
      const bodyJson = JSON.stringify(body);
      return new NextResponse(bodyJson, {
        headers: { "Content-Type": "application/json", ...SESSION_LIST_HEADERS },
      });
    }

    const runningSig = runningSessions
      .map((s) => {
        const status = "status" in s ? s.status : "";
        const updatedAt = "updatedAt" in s ? s.updatedAt : "";
        const isCompacting = "isCompacting" in s ? s.isCompacting : "";
        return `${s.id}:${status}:${updatedAt}:${isCompacting}:${s.cwd}`;
      })
      .join(";");
    const ifNoneMatch = req.headers.get("if-none-match");

    const cache = getRouteCache();
    if (
      cache.bodyJson !== null &&
      cache.etag !== null &&
      cache.runningSig === runningSig &&
      (cache.sessionsRef === sessions || computeSessionsSig(sessions) === cache.sessionsSig)
    ) {
      cache.sessionsRef = sessions;
      if (ifNoneMatch === cache.etag) {
        return new NextResponse(null, { status: 304, headers: { ETag: cache.etag, ...SESSION_LIST_HEADERS } });
      }
      return new NextResponse(cache.bodyJson, {
        headers: { ETag: cache.etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS },
      });
    }

    const body = { sessions, runningSessionIds, runningSessions };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;

    cache.sessionsRef = sessions;
    cache.sessionsSig = computeSessionsSig(sessions);
    cache.runningSig = runningSig;
    cache.bodyJson = bodyJson;
    cache.etag = etag;

    if (ifNoneMatch === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new NextResponse(bodyJson, { headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
