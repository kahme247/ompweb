import { NextResponse } from "next/server";
import { isLinkUp, type Host } from "./hosts/host";
import { getHost } from "./hosts/hub";
import { HostOpError } from "./hosts/link-protocol";
import type { OpResult } from "./hosts/session-ops";
import { hostForSessionId } from "./hosts/session-index";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { getRpcSession, WebRpcError } from "./rpc-manager";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to the host holding its file: a live session's own host first, then the
 * hosts' lists. A 404 JSON response when no host has it, 503 while this machine's sessions are unknown. */
export async function resolveSessionHostOr404(
  id: string,
): Promise<{ host: Host } | { response: NextResponse }> {
  const live = getRpcSession(id);
  if (live?.isAlive()) return { host: live.host };
  try {
    const host = await hostForSessionId(id);
    return host ? { host } : { response: NextResponse.json(SESSION_NOT_FOUND, { status: 404 }) };
  } catch (error) {
    // Nothing was sent: a command the composer holds is refused, not lost.
    if (error instanceof HostOpError && error.code === "host_offline") return { response: apiErrorResponse(new WebRpcError(error.message, "host_offline", "refused")) };
    throw error;
  }
}

/** 503 `{hostOffline: true, delivery: "refused"}` while a host's link is down; null when it takes requests. */
export function hostOfflineResponse(host: Host): NextResponse | null {
  if (isLinkUp(host.status())) return null;
  return apiErrorResponse(new WebRpcError(`${host.label} is offline`, "host_offline", "refused"));
}

/** The host a request names (`hostId`, this machine when absent): 404 when unknown, 503 while offline. */
export function resolveHostOrError(hostId: unknown): { host: Host } | { response: NextResponse } {
  const host = hostId === undefined ? getHost(LOCAL_HOST_ID) : typeof hostId === "string" ? getHost(hostId) : null;
  if (!host) return { response: NextResponse.json({ error: "Host not found", code: "host_not_found" }, { status: 404 }) };
  const offline = hostOfflineResponse(host);
  return offline ? { response: offline } : { host };
}

/** The JSON error response for a failed host op. */
export function opErrorResponse(result: Extract<OpResult<unknown>, { ok: false }>): NextResponse {
  return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
}

/** Uniform JSON error body used by most API routes. A host link failure keeps
 * its status (503 offline, 504 timeout) and code; a session whose host is
 * offline answers 503 `{hostOffline: true}`, plus its `delivery` for an agent
 * command ("unknown": the link dropped after it was sent, so it may still run). */
export function apiErrorResponse(error: unknown, status = 500): NextResponse {
  if (error instanceof HostOpError || (error instanceof WebRpcError && error.code === "host_offline")) {
    const offline = error.code === "host_offline";
    const delivery = error instanceof WebRpcError ? error.delivery : undefined;
    return NextResponse.json(
      { error: error.message, code: error.code, ...(offline ? { hostOffline: true } : {}), ...(delivery ? { delivery } : {}) },
      { status: error instanceof HostOpError ? error.status : 503 },
    );
  }
  return NextResponse.json({ error: String(error) }, { status });
}
