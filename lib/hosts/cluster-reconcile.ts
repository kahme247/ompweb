// Server side of the cluster's one-project-per-repository rule: what a host has (its projects with their Git origins, and
// where its sessions are), and `reconcileMember` run for every member when it links, so a cluster repairs itself.
// No `next/*` or `@/` imports.
import { randomUUID } from "node:crypto";
import { comparableProjectPath } from "../comparable-path";
import { mergeProjects } from "../project-registry";
import { clusterJoinBlock, clusterOf, CLUSTER_ID, CLUSTER_LABEL, isClusterMember, reconcileMember, type HostProjectFacts } from "./cluster";
import type { Host } from "./host";
import { getHost, getHostLinkProtocol, getHostOmpVersion, listHosts, notifyHostsChange, onHostHello } from "./hub";
import { HostOpError } from "./link-protocol";
import { loadPools, savePools, validatePools, type HostPool, type PoolMember, type PoolProject } from "./pools";
import { LOCAL_HOST_ID } from "./registry";
import type { OpResult } from "./session-ops";
import type { GitOrigin } from "../workspace-types";

/** gitOrigins' input bounds: it refuses the whole call beyond them. */
const MAX_ORIGIN_PATHS = 500;
const MAX_ORIGIN_PATH_LENGTH = 4096;

function valueOf<T>(result: OpResult<T>): T {
  if (!result.ok) throw new HostOpError(result.status, result.code, result.error);
  return result.value;
}

/** The pool rules, applied to one member or one project. */
export function passes(members: PoolMember[], projects: PoolProject[]): boolean {
  try {
    validatePools([{ id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members, projects }]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host's projects in its own order (mergeProjects: the order the user sees), then its hidden registry entries, which
 * move too; and the comparableProjectPath of every session's project root. Sessions come from the host itself, never a
 * cached list: a binding is replaced only when none of them is there.
 */
export async function memberFacts(host: Host): Promise<{ projects: HostProjectFacts[]; sessionRoots: Set<string> }> {
  const registry = await host.sessionOps.listProjects();
  const discovered = (await host.sessionOps.listSessions()).map((session) => session.projectRoot ?? session.cwd);
  const sessionRoots = new Set(discovered.map(comparableProjectPath));
  // As listProjectsAllHosts: only this machine's paths resolve here.
  const projects: HostProjectFacts["project"][] = mergeProjects({ version: 1, projects: registry }, discovered, host.id === LOCAL_HOST_ID ? undefined : (path) => path);
  const seen = new Set(projects.map((project) => comparableProjectPath(project.path)));
  for (const entry of registry) {
    const key = comparableProjectPath(entry.path);
    if (!entry.hidden || seen.has(key)) continue;
    seen.add(key);
    projects.push(entry);
  }
  // Longer paths are not sent: they stay on their host.
  const sendable = projects.map((project) => project.path).filter((path) => path.length <= MAX_ORIGIN_PATH_LENGTH);
  const origins = new Map<string, GitOrigin | undefined>();
  for (let start = 0; start < sendable.length; start += MAX_ORIGIN_PATHS) {
    const paths = sendable.slice(start, start + MAX_ORIGIN_PATHS);
    const answers = valueOf(await host.workspaceOps.gitOrigins(paths)).origins;
    paths.forEach((path, i) => origins.set(path, answers[i]));
  }
  return {
    projects: projects.map((project) => ({ project, origin: origins.get(project.path)?.origin ?? null, mainCheckout: origins.get(project.path)?.mainCheckout ?? false })),
    sessionRoots,
  };
}

/** Logs what a cluster change left separate; nothing when all bound. */
export function logClusterConflicts(conflicts: readonly string[]): void {
  for (const conflict of conflicts) console.warn(`[omp-web] cluster: ${conflict}`);
}

/**
 * Binds one member's checkouts (`reconcileMember`). The host round trips come first; pools.json is then read, changed
 * and saved with no await between, so a change made meanwhile (a leave, a join, a pool edit) is kept. A host that is not
 * a member or cannot answer (offline, old daemon) is skipped; it runs again on its next hello.
 */
export async function reconcileClusterMember(hostId: string): Promise<void> {
  const host = getHost(hostId);
  if (!host || !isClusterMember(loadPools(), hostId)) return;
  if (clusterJoinBlock({ status: host.status(), protocol: getHostLinkProtocol(hostId), ompVersion: getHostOmpVersion(hostId), supports: (operation) => host.supportsWorkspaceOp(operation) }) !== null) return;
  const { projects, sessionRoots } = await memberFacts(host);
  const pools: HostPool[] = loadPools();
  const { pools: next, conflicts } = reconcileMember(pools, hostId, projects, sessionRoots, new Date().toISOString(), randomUUID, (project) => passes([], [project]));
  logClusterConflicts(conflicts);
  if (JSON.stringify(next) === JSON.stringify(pools)) return;
  savePools(next);
  notifyHostsChange();
}

const running = new Map<string, Promise<void>>();

/** One run per host at a time; a hello during a run is served by that run. */
function reconcileSoon(hostId: string): void {
  if (running.has(hostId)) return;
  const run = reconcileClusterMember(hostId)
    .catch((error: unknown) => console.warn(`[omp-web] cluster: could not reconcile host ${hostId}: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => running.delete(hostId));
  running.set(hostId, run);
}

/** instrumentation.node.ts: every member already linked now, then each member whenever it links. Returns the unsubscribe. */
export function startClusterReconcile(): () => void {
  const unsubscribe = onHostHello((hostId) => reconcileSoon(hostId));
  let pools: HostPool[] = [];
  try {
    pools = loadPools();
  } catch {
    // An unreadable pools.json: the next hello tries again.
  }
  const linked = new Set([LOCAL_HOST_ID, ...listHosts().map((host) => host.id)]);
  for (const member of clusterOf(pools)?.members ?? []) if (linked.has(member.hostId)) reconcileSoon(member.hostId);
  return unsubscribe;
}
