// Usage of linked hosts: each host's daemon reads its own transcripts, main keeps a copy in usage.db so a host that
// goes offline keeps its last numbers. Pulled only on /api/usage requests. No `next/*` or `@/` imports.
import type { Database } from "bun:sqlite";
import { hostSyncTimes, isUpToDate, markHostSynced, pruneHostUsage, storedStamps, storeHostUsage } from "../usage-db";
import type { HostUsageStatus, HostUsageSyncState, UsageReadRequest, UsageTranscriptRecords } from "../usage-types";
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
  // What the pull finds gone is dropped last: a pull that fails on the way takes nothing away.
  const gone: string[] = [];
  // A transcript too large for one answer comes in slices and is held until the last one: it is only stored whole.
  let held = null as UsageTranscriptRecords | null;
  while (queue.length > 0) {
    const batch = nextBatch(queue);
    // Continued only while it is what the batch starts with: the skip is for that path and no other.
    if (held && batch[0].paths[0] === held.path) batch[0] = { ...batch[0], skip: held.records.length };
    else held = null;
    const page = await host.sessionOps.readUsageRecords(batch);
    if (!page.ok) throw new HostOpError(page.status, page.code, page.error);
    // Only an answer about a path that was asked for counts.
    const open = new Set(batch.flatMap((request) => request.paths));
    const files: UsageTranscriptRecords[] = [];
    let sliced = 0;
    for (const file of page.value.files) {
      if (!open.has(file.path)) continue;
      const earlier: UsageTranscriptRecords | null = held?.path === file.path ? held : null;
      if (earlier && (earlier.mtimeMs !== file.mtimeMs || earlier.size !== file.size)) {
        throw new HostOpError(409, "usage_changed", `${host.label} changed a usage transcript while it was being read`);
      }
      const whole: UsageTranscriptRecords = earlier ? { ...file, records: earlier.records.concat(file.records) } : file;
      // No transcript holds more records than bytes: slices beyond that would be held without end.
      if (whole.records.length > file.size) {
        throw new HostOpError(502, "host_bad_result", `${host.label} sent more usage records than a transcript can hold`);
      }
      if (file.more) {
        held = whole;
        sliced += file.records.length;
      } else {
        if (earlier) held = null;
        open.delete(file.path);
        files.push(whole);
      }
    }
    const missing = page.value.missing.filter((path) => open.delete(path));
    if (held && !open.has(held.path)) held = null;
    // A host that settles none of a batch and sends no further slice would be asked for it for ever.
    if (files.length + missing.length + sliced === 0) {
      throw new HostOpError(502, "host_bad_result", `${host.label} read none of the usage transcripts it was asked for`);
    }
    // Stored page by page, each transcript whole: a pull that fails later leaves the rest for the next one.
    if (files.length > 0) storeHostUsage(db, host.id, parserVersion, files, []);
    gone.push(...missing);
    const rest = batch
      .map(({ session, paths }) => ({ session, paths: paths.filter((path) => open.has(path)) }))
      .filter((request) => request.paths.length > 0);
    queue.unshift(...rest);
  }
  // The index was the host's whole inventory (it fails otherwise), so a stored transcript it left out is gone too.
  gone.push(...unlisted.keys());
  if (gone.length > 0) storeHostUsage(db, host.id, parserVersion, [], gone);
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
