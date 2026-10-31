// Sessions and projects across hosts (spec "Routing", "Data flow"): this
// machine's lists plus each linked host's, cached per host.
// No `next/*` or `@/` imports.
import { createHash } from "node:crypto";
import { mergeProjects, type ProjectRegistryEntry } from "../project-registry";
import { isValidSessionId } from "../session-file-references-core";
import { readSessionHeader, resolveSessionPath } from "../session-reader";
import type { ManagedProject, SessionInfo } from "../types";
import { isLinkUp, type Host } from "./host";
import { getHost, listHosts, onHostHello } from "./hub";
import { localHost, resolveSpawnCwdResult } from "./local-host";

/** Same TTL as the local session-list cache. */
const LIST_TTL_MS = 30_000;

interface HostLists {
  sessions: SessionInfo[];
  fetchedAt: number;
  /** Bumped by invalidation: a load that started before it must not refresh `fetchedAt`. */
  generation: number;
  loading: { generation: number; promise: Promise<SessionInfo[]> } | null;
  /** Last registry the host returned, shown while it is unreachable. */
  projects: ProjectRegistryEntry[];
}

declare global {
  var __ompHostLists: Map<string, HostLists> | undefined;
}

// globalThis, like the hub: survives Next.js hot reload.
function hostLists(hostId: string): HostLists {
  if (!globalThis.__ompHostLists) {
    globalThis.__ompHostLists = new Map();
    // A host that links again may have changed its sessions while away.
    onHostHello((id) => invalidateHostSessionList(id));
  }
  let lists = globalThis.__ompHostLists.get(hostId);
  if (!lists) {
    lists = { sessions: [], fetchedAt: 0, generation: 0, loading: null, projects: [] };
    globalThis.__ompHostLists.set(hostId, lists);
  }
  return lists;
}

/** Linked hosts in sidebar order: by label, case-insensitive. */
function remoteHosts(): { id: string; label: string; status: string }[] {
  return listHosts().sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id));
}

/** One linked host's sessions, cached for LIST_TTL_MS. An unreachable or failing host keeps its last list. */
async function hostSessions(hostId: string, refresh = false): Promise<SessionInfo[]> {
  const lists = hostLists(hostId);
  if (!refresh && Date.now() - lists.fetchedAt < LIST_TTL_MS) return lists.sessions;
  const host = getHost(hostId);
  if (!host || !isLinkUp(host.status())) return lists.sessions;
  if (lists.loading?.generation !== lists.generation) {
    const generation = lists.generation;
    const promise: Promise<SessionInfo[]> = host.sessionOps.listSessions().then((sessions) => {
      const tagged = sessions.map((session) => ({ ...session, hostId }));
      if (lists.generation === generation) {
        lists.sessions = tagged;
        lists.fetchedAt = Date.now();
      }
      return tagged;
    }, () => lists.sessions).finally(() => {
      if (lists.loading?.promise === promise) lists.loading = null;
    });
    lists.loading = { generation, promise };
  }
  return lists.loading!.promise;
}

/** Every host's sessions, each with its `hostId`. An id on several hosts is
 * listed once: under this machine if it is here, else under the first host by label. */
export async function listSessionsAllHosts(): Promise<SessionInfo[]> {
  const hosts = remoteHosts();
  const [local, ...remote] = await Promise.all([localHost.sessionOps.listSessions(), ...hosts.map((host) => hostSessions(host.id))]);
  const merged: SessionInfo[] = local.map((session) => ({ ...session, hostId: localHost.id }));
  const seen = new Set(merged.map((session) => session.id));
  for (const sessions of remote) {
    for (const session of sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push(session);
    }
  }
  return merged;
}

async function remoteHostFor(id: string, refresh: boolean): Promise<Host | null> {
  const hosts = remoteHosts();
  const lists = await Promise.all(hosts.map((host) => hostSessions(host.id, refresh)));
  const index = lists.findIndex((sessions) => sessions.some((session) => session.id === id));
  return index === -1 ? null : getHost(hosts[index].id);
}

/** The host holding a session: this machine first, then the linked hosts' lists, refreshed once on a miss. */
export async function hostForSessionId(id: string): Promise<Host | null> {
  if (await resolveSessionPath(id)) return localHost;
  // Remote lists only hold valid ids: a malformed one never costs a round trip.
  if (!isValidSessionId(id)) return null;
  // shortcut: every miss re-asks each linked host; throttle per host if polling for gone sessions shows up.
  return (await remoteHostFor(id, false)) ?? (await remoteHostFor(id, true));
}

/** Where a session's file is and which cwd to start it in, on `host`; null when the host has no such session. */
export async function sessionSpawnTarget(
  id: string,
  host: Host,
): Promise<{ sessionFile: string; cwd: string; recordedCwd: string | undefined } | null> {
  if (host === localHost) {
    const sessionFile = await resolveSessionPath(id);
    if (!sessionFile) return null;
    const header = readSessionHeader(sessionFile);
    return { sessionFile, cwd: resolveSpawnCwdResult(header?.cwd).cwd, recordedCwd: header?.cwd };
  }
  // The host's own list entry carries its file path and recorded cwd; the
  // host resolves a missing cwd on its machine when it spawns.
  const find = async (refresh: boolean) => (await hostSessions(host.id, refresh)).find((session) => session.id === id);
  const info = (await find(false)) ?? (await find(true));
  return info ? { sessionFile: info.path, cwd: info.cwd, recordedCwd: info.cwd } : null;
}

/** Drop one linked host's cached session list; it is kept as the fallback while the host is unreachable. */
export function invalidateHostSessionList(hostId: string): void {
  const lists = globalThis.__ompHostLists?.get(hostId);
  if (!lists) return;
  lists.fetchedAt = 0;
  lists.generation += 1;
}

/** Each linked host's projects (its registry plus session-discovered ones), tagged with `hostId`. */
export async function listRemoteProjects(): Promise<ManagedProject[]> {
  const perHost = await Promise.all(remoteHosts().map(async ({ id }) => {
    const host = getHost(id);
    const lists = hostLists(id);
    if (host && isLinkUp(host.status())) {
      try {
        lists.projects = await host.sessionOps.listProjects();
      } catch {
        // Keep the last registry.
      }
    }
    const discovered = (await hostSessions(id)).map((session) => session.projectRoot ?? session.cwd).filter(Boolean);
    // Remote paths are never resolved on this machine.
    return mergeProjects({ version: 1, projects: lists.projects }, discovered, (path) => path).map((project) => ({ ...project, hostId: id }));
  }));
  return perHost.flat();
}

/** An image from the first online host whose bytes hash to `hash`. */
export async function fetchMediaFromHosts(hash: string): Promise<Uint8Array | null> {
  const online = listHosts().filter((host) => isLinkUp(host.status));
  try {
    return await Promise.any(online.map(async ({ id }) => {
      const result = await getHost(id)?.sessionOps.readMedia(hash);
      if (!result?.ok || createHash("sha256").update(result.value).digest("hex") !== hash) throw new Error("Not this image");
      return result.value;
    }));
  } catch {
    return null;
  }
}
