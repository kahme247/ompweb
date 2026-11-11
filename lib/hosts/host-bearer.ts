import { hostForToken, HostRegistryUnreadableError, type HostRecord } from "./registry";

const fail = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** The host the request's `Authorization: Bearer <host token>` names, or the refusal to answer with: 401 for an unknown token, 503 for an unreadable registry. */
export function hostFromBearer(request: Request): HostRecord | Response {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  let host: HostRecord | null;
  try {
    host = token ? hostForToken(token) : null;
  } catch (error) {
    if (!(error instanceof HostRegistryUnreadableError)) throw error;
    // Never 401: a daemon told its token is unknown stops every omp child.
    return fail("The host registry cannot be read", 503);
  }
  return host ?? fail("Unknown host token", 401);
}
