// Main's side of the `sessionOwnership` host op: one canonical ownership answer, no second detector.
//
// The daemon answers for its own machine (lib/hosts/session-ownership.ts); this module only asks, pages and normalizes.
// It never scans processes or reads transcripts here: the web server does not share the daemon's PID namespace, uid or
// filesystem, and a main-side scan is exactly the false "nobody runs it" the op replaced.
//
// A failed inspection is `unknown`, never `none`. An older daemon answers 501 `unknown_op`, an offline host 503, a slow
// one 504, a malformed reply 502; a caller must be able to tell "nobody runs it" from "could not inspect", so none of
// these ever becomes a negative answer. The 501 is logged once per host, because it is a compatibility state that
// persists until the daemon is updated, not a per-request error.
import type { Host } from "./hosts/host";
import { HostOpError, LINK_LIMITS } from "./hosts/link-protocol";
import type { SessionOwnership } from "./types";

/** Hosts whose daemon answered 501 for the op: logged once, not on every refresh. */
const unsupportedLogged = new Set<string>();

/**
 * Whether a status means the *request* was wrong (a caller bug that must
 * propagate) rather than the inspection being unable to answer. One rule for
 * both wire shapes: a thrown `HostOpError` and an `OpResult` failure with the
 * same status classify identically, so a daemon 500 cannot propagate in one
 * shape and become `unknown` in the other.
 */
function callerBug(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Who holds each of `ids` on `host`, in request order. More than
 * `LINK_LIMITS.ownershipIds` ids are paged, so a large session list is fully
 * covered instead of silently truncated; a page that fails answers `unknown`
 * for its ids and does not stop the remaining pages.
 */
export async function sessionOwnershipOn(host: Host, ids: string[]): Promise<SessionOwnership[]> {
  const unique = [...new Set(ids)];
  const out: SessionOwnership[] = [];
  for (let start = 0; start < unique.length; start += LINK_LIMITS.ownershipIds) {
    const page = unique.slice(start, start + LINK_LIMITS.ownershipIds);
    try {
      const result = await host.sessionOps.sessionOwnership(page);
      if (result.ok) {
        // The host boundary already checked identity, order and length; keep the daemon's answer as is.
        out.push(...result.value);
      } else if (callerBug(result.status)) {
        throw new HostOpError(result.status, result.code, result.error);
      } else {
        out.push(...page.map((id) => ({ id, owner: "unknown" as const })));
      }
    } catch (error) {
      if (error instanceof HostOpError && callerBug(error.status)) throw error;
      if (error instanceof HostOpError && error.status === 501 && !unsupportedLogged.has(host.id)) {
        unsupportedLogged.add(host.id);
        console.warn(`[omp-web] ${host.label} does not answer sessionOwnership yet (older daemon); session ownership there is unknown until it is updated`);
      }
      out.push(...page.map((id) => ({ id, owner: "unknown" as const })));
    }
  }
  return out;
}
