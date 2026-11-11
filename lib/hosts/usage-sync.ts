// Usage of linked hosts: each host's daemon reads its own transcripts, main keeps a copy in usage.db so a host that
// goes offline keeps its last numbers. Pulled only on /api/usage requests. No `next/*` or `@/` imports.
import type { Database } from "bun:sqlite";
import { hostUsageStamps, pruneHostUsage, storeHostUsage } from "../usage-db";
import type { HostUsageStatus, HostUsageSyncState, UsageReadRequest } from "../usage-types";
import { isLinkUp, type Host } from "./host";
import { getHost, listHosts, onHostHello } from "./hub";
import { HostOpError } from "./link-protocol";
import { customLocalLabel, LOCAL_HOST_ID, readHosts } from "./registry";
import type { OpResult } from "./session-ops";

/** `ttlMs`: a host pulled this recently is not asked again; `waitMs`: how long a report waits for its pulls. */
export const usageSyncTimings = { ttlMs: 30_000, waitMs: 10_000 };

/** Most sessions and paths asked for in one `readUsageRecords`. */
const READ_BATCH = { sessions: 50, paths: 2_000 };

interface HostUsage {
  pulling: Promise<void> | null;
  pulledAt: number;
  syncedAt: number | null;
  state: HostUsageSyncState;
}

declare global {
  var __ompHostUsage: Map<string, HostUsage> | undefined;
}

// globalThis, like the hub: survives a `bun --hot` re-evaluation.
function hostUsage(hostId: string): HostUsage {
  if (!globalThis.__ompHostUsage) {
    globalThis.__ompHostUsage = new Map();
    // A host that links again may have new transcripts from while it was away.
    onHostHello((id) => {
      const usage = globalThis.__ompHostUsage?.get(id);
      if (usage) usage.pulledAt = 0;
    });
  }
  let usage = globalThis.__ompHostUsage.get(hostId);
  if (!usage) {
    usage = { pulling: null, pulledAt: 0, syncedAt: null, state: "stale" };
    globalThis.__ompHostUsage.set(hostId, usage);
  }
  return usage;
}

function opValue<T>(result: OpResult<T>): T {
  if (!result.ok) throw new HostOpError(result.status, result.code, result.error);
  return result.value;
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

/** Bring `db`'s copy of `host`'s usage up to date: read what is new or changed, drop what the host no longer lists. */
async function syncHostUsage(host: Host, db: Database, refresh: boolean): Promise<void> {
  const index = opValue(await host.sessionOps.listUsageTranscripts(refresh));
  const stored = hostUsageStamps(db, host.id);
  const listed = new Set<string>();
  const queue: UsageReadRequest[] = [];
  for (const { session, transcripts } of index.sessions) {
    const paths: string[] = [];
    for (const { path, mtimeMs, size } of transcripts) {
      listed.add(path);
      const known = stored.get(path);
      if (!known || known.mtimeMs !== mtimeMs || known.size !== size || known.parserVersion !== index.parserVersion) paths.push(path);
    }
    if (paths.length > 0) queue.push({ session, paths });
  }
  const removed = [...stored.keys()].filter((path) => !listed.has(path));
  if (removed.length > 0) storeHostUsage(db, host.id, index.parserVersion, [], removed);

  while (queue.length > 0) {
    const batch = nextBatch(queue);
    const page = opValue(await host.sessionOps.readUsageRecords(batch));
    if (page.files.length === 0 && page.missing.length === 0) {
      throw new HostOpError(502, "host_bad_result", `${host.label} read none of the usage transcripts it was asked for`);
    }
    storeHostUsage(db, host.id, index.parserVersion, page.files, page.missing);
    // Only paths of this batch it did not answer: every page shrinks the queue, whatever the host sends.
    const asked = new Set(batch.flatMap((request) => request.paths));
    for (const path of [...page.files.map((file) => file.path), ...page.missing]) asked.delete(path);
    const unread = page.unread
      .map((request) => ({ session: request.session, paths: request.paths.filter((path) => asked.delete(path)) }))
      .filter((request) => request.paths.length > 0);
    queue.unshift(...unread);
  }
}

/** Pull `hostId`'s usage into `db` unless it was pulled within the TTL (`refresh` pulls anyway). Never rejects; the
 * outcome is the host's sync state, and its stored rows are kept whatever fails. */
export async function pullHostUsage(hostId: string, db: Database, refresh: boolean): Promise<void> {
  if (hostId === LOCAL_HOST_ID) return;
  const usage = hostUsage(hostId);
  while (usage.pulling) await usage.pulling;
  if (!refresh && Date.now() - usage.pulledAt < usageSyncTimings.ttlMs) return;
  const host = getHost(hostId);
  if (!host) return;
  const status = host.status();
  if (status === "needs-upgrade") {
    usage.state = "unsupported";
    return;
  }
  if (!isLinkUp(status)) {
    usage.state = "offline";
    return;
  }
  const pull = syncHostUsage(host, db, refresh).then(() => {
    usage.state = "current";
    usage.syncedAt = usage.pulledAt = Date.now();
  }, (error: unknown) => {
    if (host.status() === "needs-upgrade" || (error instanceof HostOpError && error.status === 501)) {
      usage.state = "unsupported";
    } else if (error instanceof HostOpError && error.status === 503) {
      usage.state = "offline";
    } else {
      usage.state = "stale";
      console.warn(`[omp-web] could not sync usage from host ${host.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }).finally(() => {
    usage.pulling = null;
  });
  usage.pulling = pull;
  await pull;
}

/** Pull every linked host's usage, waiting at most `usageSyncTimings.waitMs` (slower pulls finish in the background),
 * and drop the rows of hosts no longer registered. Returns this machine, then the linked hosts by label. */
export async function pullAllHostUsage(db: Database, refresh: boolean): Promise<HostUsageStatus[]> {
  const hosts = listHosts().sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id));
  let registered: string[] | null = null;
  try {
    registered = readHosts().map((host) => host.id);
  } catch {
    // An unreadable registry cannot tell a revoked host from a kept one.
  }
  if (registered) {
    pruneHostUsage(db, registered);
    for (const hostId of globalThis.__ompHostUsage?.keys() ?? []) {
      if (!registered.includes(hostId)) globalThis.__ompHostUsage!.delete(hostId);
    }
  }

  const waited = Promise.withResolvers<void>();
  const timer = setTimeout(waited.resolve, usageSyncTimings.waitMs);
  timer.unref();
  await Promise.race([Promise.all(hosts.map((host) => pullHostUsage(host.id, db, refresh))), waited.promise]);
  clearTimeout(timer);

  return [
    { hostId: LOCAL_HOST_ID, label: customLocalLabel(), state: "current", syncedAt: null },
    ...hosts.map((host): HostUsageStatus => {
      const usage = hostUsage(host.id);
      return { hostId: host.id, label: host.label, state: usage.pulling ? "syncing" : usage.state, syncedAt: usage.syncedAt };
    }),
  ];
}
