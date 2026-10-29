// Sessions and projects across hosts (spec "Routing", "Data flow"): this
// machine's lists (from its daemon) plus each linked host's, cached per host.
// No `next/*` or `@/` imports.
import { createHash } from "node:crypto";
import { mergeProjects, type ProjectRegistryEntry } from "../project-registry";
import { isValidSessionId } from "../session-file-references-core";
import type { ManagedProject, SessionInfo } from "../types";
import { isLinkUp, type Host } from "./host";
import { getHost, listHosts, onHostHello } from "./hub";
import { LOCAL_HOST_ID } from "./registry";

/** Same TTL as the daemon's own session-list cache. */
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

/** Host ids in sidebar order: this machine, then linked hosts by label, case-insensitive. */
function hostIds(): string[] {
  const remote = listHosts().sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id));
  return [LOCAL_HOST_ID, ...remote.map((host) => host.id)];
}

/** One host's sessions, cached for LIST_TTL_MS. An unreachable or failing host keeps its last list. */
export async function hostSessions(hostId: string, refresh = false): Promise<SessionInfo[]> {
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
  const lists = await Promise.all(hostIds().map((id) => hostSessions(id)));
  const merged: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const sessions of lists) {
    for (const session of sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push(session);
    }
  }
  return merged;
}

async function hostWithSession(id: string, refresh: boolean): Promise<Host | null> {
  const ids = hostIds();
  const lists = await Promise.all(ids.map((hostId) => hostSessions(hostId, refresh)));
  const index = lists.findIndex((sessions) => sessions.some((session) => session.id === id));
  return index === -1 ? null : getHost(ids[index]);
}

/** The host holding a session: this machine first, then the linked hosts by label; the lists are refreshed once on a miss. */
export async function hostForSessionId(id: string): Promise<Host | null> {
  // Host lists only hold valid ids: a malformed one never costs a round trip.
  if (!isValidSessionId(id)) return null;
  // shortcut: every miss re-asks each linked host; throttle per host if polling for gone sessions shows up.
  return (await hostWithSession(id, false)) ?? (await hostWithSession(id, true));
}

/** Where a session's file is and which cwd to start it in, on `host`; null when the host has no such session. */
export async function sessionSpawnTarget(
  id: string,
  host: Host,
): Promise<{ sessionFile: string; cwd: string; recordedCwd: string | undefined } | null> {
  // The host's own list entry carries its file path and recorded cwd; the
  // host resolves a missing cwd on its machine when it spawns.
  const find = async (refresh: boolean) => (await hostSessions(host.id, refresh)).find((session) => session.id === id);
  const info = (await find(false)) ?? (await find(true));
  return info ? { sessionFile: info.path, cwd: info.cwd, recordedCwd: info.cwd } : null;
}

/** Drop one host's cached session list; it is kept as the fallback while the host is unreachable. */
export function invalidateHostSessionList(hostId: string): void {
  const lists = globalThis.__ompHostLists?.get(hostId);
  if (!lists) return;
  lists.fetchedAt = 0;
  lists.generation += 1;
}

/** This machine's session files changed outside any host op (a terminal omp, an import, an archive restore): its daemon and main drop their lists. */
export function invalidateLocalSessionLists(sessionFile?: string): void {
  getHost(LOCAL_HOST_ID).invalidateSessionLists(sessionFile);
  invalidateHostSessionList(LOCAL_HOST_ID);
}

/** Each host's projects (its registry plus session-discovered ones), this machine first, tagged with `hostId`. */
export async function listProjectsAllHosts(): Promise<ManagedProject[]> {
  const perHost = await Promise.all(hostIds().map(async (id) => {
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
    // Only this machine's paths resolve here; another host's are never resolved on this machine.
    return mergeProjects({ version: 1, projects: lists.projects }, discovered, id === LOCAL_HOST_ID ? undefined : (path) => path).map((project) => ({ ...project, hostId: id }));
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
