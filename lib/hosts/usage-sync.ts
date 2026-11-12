// Usage of linked hosts: each host's daemon reads its own transcripts, main keeps a copy in usage.db so a host that
// goes offline keeps its last numbers. Pulled only on /api/usage requests. No `next/*` or `@/` imports.
import type { Database } from "bun:sqlite";
import { hostSyncTimes, isUpToDate, markHostSynced, pruneHostUsage, storedStamps, storeHostUsage } from "../usage-db";
import type { HostUsageStatus, HostUsageSyncState, UsageReadRequest } from "../usage-types";
import { isLinkUp, type Host } from "./host";
import { getHost, listHosts, onHostHello } from "./hub";
import { HostOpError } from "./link-protocol";
import { readHosts } from "./registry";

/** `ttlMs`: a host pulled this recently is not asked again; `waitMs`: how long a report waits for its pulls. */
export const usageSyncTimings = { ttlMs: 30_000, waitMs: 10_000 };

/** Most sessions and paths asked for in one `readUsageRecords`. */
const READ_BATCH = { sessions: 50, paths: 2_000 };

interface HostPulls {
  running: Promise<void> | null;
  /** When the last pull succeeded; 0 pulls again whatever the TTL. */
  pulledAt: number;
  /** How the last pull ended; `stale` before the first one. */
  outcome: "current" | "stale" | "offline" | "unsupported";
}

declare global {
  var __ompHostUsagePulls: Map<string, HostPulls> | undefined;
}

// globalThis, like the hub: survives a `bun --hot` re-evaluation.
function pullsOf(hostId: string): HostPulls {
  if (!globalThis.__ompHostUsagePulls) {
    globalThis.__ompHostUsagePulls = new Map();
    // A host that links again may have new transcripts from while it was away.
    onHostHello((id) => {
      const pulls = globalThis.__ompHostUsagePulls?.get(id);
      if (pulls) pulls.pulledAt = 0;
    });
  }
  let pulls = globalThis.__ompHostUsagePulls.get(hostId);
  if (!pulls) {
    pulls = { running: null, pulledAt: 0, outcome: "stale" };
    globalThis.__ompHostUsagePulls.set(hostId, pulls);
  }
  return pulls;
}

/** Take the next `readUsageRecords` batch off the front of `queue`; a session with too many paths is split. */
function nextBatch(queue: UsageReadRequest[]): UsageReadRequest[] {
  const batch: UsageReadRequest[] = [];
  let paths = 0;
  while (queue.length > 0 && batch.length < READ_BATCH.sessions && paths < READ_BATCH.paths) {
    const request = queue[0];
    const room = READ_BATCH.paths - paths;
    if (request.paths.length <= room) {
      queue.shift();
      batch.push(request);
      paths += request.paths.length;
    } else {
      batch.push({ session: request.session, paths: request.paths.slice(0, room) });
      queue[0] = { session: request.session, paths: request.paths.slice(room) };
      paths = READ_BATCH.paths;
    }
  }
  return batch;
}

/** Bring `db`'s copy of `host`'s usage up to date: read what is new or changed, drop what the host no longer has.
 * `refresh` reads every transcript again, so the host's current prices apply to all of them. */
async function syncHostUsage(host: Host, db: Database, refresh: boolean): Promise<void> {
  const index = await host.sessionOps.listUsageTranscripts(refresh);
  if (!index.ok) throw new HostOpError(index.status, index.code, index.error);
  const { parserVersion, sessions } = index.value;
  const unlisted = storedStamps(db, host.id);
  const queue: UsageReadRequest[] = [];
  for (const { session, transcripts } of sessions) {
    const paths: string[] = [];
    for (const stamp of transcripts) {
      const upToDate = isUpToDate(unlisted.get(stamp.path), stamp, parserVersion);
      unlisted.delete(stamp.path);
      if (refresh || !upToDate) paths.push(stamp.path);
    }
    if (paths.length > 0) queue.push({ session, paths });
  }
  // The index is the host's whole inventory (it fails otherwise), so a stored transcript it leaves out is gone.
  if (unlisted.size > 0) storeHostUsage(db, host.id, parserVersion, [], [...unlisted.keys()]);

  while (queue.length > 0) {
    const batch = nextBatch(queue);
    const page = await host.sessionOps.readUsageRecords(batch);
    if (!page.ok) throw new HostOpError(page.status, page.code, page.error);
    // Only an answer about a path that was asked for counts: `delete` is true once for each.
    const open = new Set(batch.flatMap((request) => request.paths));
    const files = page.value.files.filter((file) => open.delete(file.path));
    const missing = page.value.missing.filter((path) => open.delete(path));
    // A host that settles none of a batch would be asked for it for ever.
    if (files.length === 0 && missing.length === 0) {
      throw new HostOpError(502, "host_bad_result", `${host.label} read none of the usage transcripts it was asked for`);
    }
    storeHostUsage(db, host.id, parserVersion, files, missing);
    const rest = batch
      .map(({ session, paths }) => ({ session, paths: paths.filter((path) => open.has(path)) }))
      .filter((request) => request.paths.length > 0);
    queue.unshift(...rest);
  }
  markHostSynced(db, host.id, Date.now());
}

/** Pull `host`'s usage into `db` unless it was pulled within the TTL (`refresh` pulls anyway). Never rejects: a
 * failed pull keeps the stored rows and shows in the host's sync state. */
async function pullHostUsage(host: Host, db: Database, refresh: boolean): Promise<void> {
  const pulls = pullsOf(host.id);
  while (pulls.running) await pulls.running;
  if (!isLinkUp(host.status())) return;
  if (!refresh && Date.now() - pulls.pulledAt < usageSyncTimings.ttlMs) return;
  pulls.running = syncHostUsage(host, db, refresh).then(() => {
    pulls.outcome = "current";
    pulls.pulledAt = Date.now();
  }, (error: unknown) => {
    const status = error instanceof HostOpError ? error.status : 0;
    // 501: a daemon from before the usage ops. 503: the socket is gone, which the link's status only shows later.
    pulls.outcome = status === 501 ? "unsupported" : status === 503 ? "offline" : "stale";
    pulls.pulledAt = 0;
    if (pulls.outcome === "stale") {
      console.warn(`[omp-web] could not sync usage from host ${host.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }).finally(() => {
    pulls.running = null;
  });
  await pulls.running;
}

/** The link's status as it is now comes first: a pull that succeeded says nothing about a host that has since dropped. */
function syncState(host: Host, pulls: HostPulls): HostUsageSyncState {
  const status = host.status();
  if (status === "needs-upgrade") return "unsupported";
  if (!isLinkUp(status)) return "offline";
  return pulls.running ? "syncing" : pulls.outcome;
}

/** Pull every linked host's usage, waiting at most `usageSyncTimings.waitMs` (slower pulls finish in the background),
 * and drop what is stored for hosts no longer registered. Returns the linked hosts by label. */
export async function pullAllHostUsage(db: Database, refresh: boolean): Promise<HostUsageStatus[]> {
  let registered: string[] | null = null;
  try {
    registered = readHosts().map((host) => host.id);
  } catch {
    // An unreadable registry cannot tell a revoked host from a kept one.
  }
  if (registered) {
    pruneHostUsage(db, registered);
    for (const hostId of globalThis.__ompHostUsagePulls?.keys() ?? []) {
      if (!registered.includes(hostId)) globalThis.__ompHostUsagePulls!.delete(hostId);
    }
  }

  const hosts = listHosts()
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id))
    .flatMap((row) => getHost(row.id) ?? []);
  const waited = Promise.withResolvers<void>();
  const timer = setTimeout(waited.resolve, usageSyncTimings.waitMs);
  timer.unref();
  await Promise.race([Promise.all(hosts.map((host) => pullHostUsage(host, db, refresh))), waited.promise]);
  clearTimeout(timer);

  const syncedAt = hostSyncTimes(db);
  return hosts.map((host) => ({
    hostId: host.id,
    label: host.label,
    state: syncState(host, pullsOf(host.id)),
    syncedAt: syncedAt.get(host.id) ?? null,
  }));
}
