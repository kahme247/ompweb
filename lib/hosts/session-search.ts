import { compileSearchQuery } from "../session-search";
import { getHost } from "./hub";
import { HostOpError } from "./link-protocol";
import { LOCAL_HOST_ID } from "./registry";
import { listSessionsAllHosts } from "./session-index";

const SEARCH_BATCH_SIZE = 4;

/** Search only the sidebar's canonical owners; files and scoring stay on their daemons. */
export async function* searchSessionsAllHosts(rawQuery: string): AsyncGenerator<Record<string, number>> {
  if (!compileSearchQuery(rawQuery)) return;
  const byHost = new Map<string, string[]>();
  for (const session of await listSessionsAllHosts()) {
    const hostId = session.hostId ?? LOCAL_HOST_ID;
    let ids = byHost.get(hostId);
    if (!ids) byHost.set(hostId, ids = []);
    ids.push(session.id);
  }

  let firstError: Error | undefined;
  for (const [hostId, ids] of byHost) {
    try {
      const host = getHost(hostId);
      if (!host) throw new HostOpError(503, "host_offline", "Session host is unavailable");
      for (let i = 0; i < ids.length; i += SEARCH_BATCH_SIZE) {
        const result = await host.sessionOps.searchSessionBatch(rawQuery, ids.slice(i, i + SEARCH_BATCH_SIZE));
        if (!result.ok) throw new HostOpError(result.status, result.code, result.error);
        // Empty batches also yield so cancellation stops before the next daemon call.
        yield result.value;
      }
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  // Keep healthy hits, but never present an unavailable host as a completed empty scan.
  if (firstError) throw firstError;
}
