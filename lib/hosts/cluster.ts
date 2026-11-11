// Pure computation of cluster membership (spec M3, M6): no disk, network or clock.
// Browser-importable: only types from ./pools (it loads node:fs), no node:* modules.
import { comparableProjectPath } from "../comparable-path";
import { cloneDirectoryName, repositoryKey } from "../git-clone";
import { LOCAL_HOST_ID } from "../project-ordering";
import type { ManagedProject } from "../types";
import type { HostStatus } from "./host";
import type { HostPool, PoolProject } from "./pools";

export const CLUSTER_ID = "cluster";
export const CLUSTER_LABEL = "Cluster";
export const CLUSTER_PROJECTS_DIR = "ompweb-cluster";
/** The first link protocol whose daemons can be cluster members (10: they apply the master's configuration); they also need the `gitOrigins` operation. */
export const CLUSTER_SINCE_VERSION = 10;

/**
 * Why a host cannot join the cluster now, or null: the one rule behind the join route and the Settings switch.
 * Non-online hosts retain their status as the reason; online hosts need the protocol and operation below.
 */
export function clusterJoinBlock(host: { status: HostStatus; protocol: number | null; supports: (operation: "gitOrigins") => boolean }): Exclude<HostStatus, "online"> | "upgrade" | null {
  if (host.status !== "online") return host.status;
  return (host.protocol ?? 0) >= CLUSTER_SINCE_VERSION && host.supports("gitOrigins") ? null : "upgrade";
}

export class ClusterError extends Error {
  readonly name = "ClusterError";
  constructor(readonly code: "already_member" | "not_member" | "master_cannot_leave", message: string) {
    super(message);
  }
}

/** ManagedProject has no `hidden`; the registry entry does, and hidden projects move too. */
export interface HostProjectFacts { project: ManagedProject & { hidden?: boolean }; origin: string | null; mainCheckout: boolean }

/** The interface's cluster is the first pool. */
export function clusterOf(pools: readonly HostPool[]): HostPool | undefined {
  return pools[0];
}

export function isClusterMember(pools: readonly HostPool[], hostId: string): boolean {
  return clusterOf(pools)?.members.some((member) => member.hostId === hostId) ?? false;
}

/** Whether sessions on this host run on the server's provider logins: members always, other hosts by their own flag, `local` never. */
export function sharesCredentials(record: { id: string; shareCredentials: boolean }, pools: readonly HostPool[]): boolean {
  return record.id !== LOCAL_HOST_ID && (record.shareCredentials || isClusterMember(pools, record.id));
}

/** A path under a host's root, in the separator that root uses (hosts may run another OS than the server). */
const under = (root: string, name: string) => `${root}${root.includes("\\") ? "\\" : "/"}${name}`;

/** `path` is `root` or below it; both in comparableProjectPath form. */
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Adds one host and moves its projects (spec M3). Returns new pools; never mutates its input.
 * `valid` decides, for each project a host checkout would create or bind, whether the resulting cluster project is acceptable
 * (the caller passes a check built on `validatePools`, which this module cannot import); a project that fails stays pinned
 * to its host and any existing cluster project is left unchanged, so one odd remote or launch setting cannot fail the join.
 */
export function joinCluster(
  pools: readonly HostPool[],
  member: { hostId: string; projectsRoot: string },
  projects: readonly HostProjectFacts[],
  now: string,
  newId: () => string,
  valid: (project: PoolProject) => boolean,
): HostPool[] {
  const current = clusterOf(pools);
  if (current?.members.some((existing) => existing.hostId === member.hostId)) {
    throw new ClusterError("already_member", "The host is already in the cluster");
  }
  const base = current ?? { id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members: [], projects: [] };
  const next: HostPool = {
    ...base,
    members: [...base.members, { hostId: member.hostId, projectsRoot: member.projectsRoot, provisioned: true, draining: false }],
    projects: base.projects.map((project) => ({ ...project, clonePaths: { ...project.clonePaths } })),
  };
  const root = comparableProjectPath(member.projectsRoot);
  for (const { project, origin, mainCheckout } of projects) {
    if (!mainCheckout || origin === null) continue;
    const key = repositoryKey(origin);
    if (key === null) continue;
    // Pinned when at or below projectsRoot (leaving would keep it bound) or above it (seeded clones would land inside it).
    const path = comparableProjectPath(project.path);
    if (within(path, root) || within(root, path)) continue;
    // Already bound for this host, so already in the cluster.
    if (next.projects.some((candidate) => Object.hasOwn(candidate.clonePaths, member.hostId) && comparableProjectPath(candidate.clonePaths[member.hostId]) === path)) continue;
    const existing = next.projects.find((candidate) => repositoryKey(candidate.origin) === key);
    if (existing && Object.hasOwn(existing.clonePaths, member.hostId)) continue; // an existing binding may already hold sessions
    // A visible checkout keeps a hidden cluster project visible, else the project and its sessions vanish from the sidebar.
    const result: PoolProject = existing
      ? { ...existing, hidden: existing.hidden && project.hidden === true, clonePaths: { ...existing.clonePaths, [member.hostId]: project.path } }
      : {
        // The name the host showed: its own, else its folder's (spec M3); the origin's only for a root path.
        id: newId(), name: project.name || project.path.split(/[\\/]/).filter(Boolean).pop() || cloneDirectoryName(origin)!, origin, clonePaths: { [member.hostId]: project.path },
        addedAt: project.addedAt ?? now, hidden: project.hidden ?? false,
        alias: project.alias, sortOrder: project.sortOrder, pinOrder: project.pinOrder, launchConfig: project.launchConfig,
      };
    if (!valid(result)) continue;
    if (existing) Object.assign(existing, result);
    else next.projects.push(result);
  }
  for (const project of next.projects) {
    for (const { hostId, projectsRoot } of next.members) {
      if (!Object.hasOwn(project.clonePaths, hostId)) project.clonePaths[hostId] = under(projectsRoot, project.id);
    }
  }
  return [next, ...pools.slice(1)];
}

/** Removes one host (spec M6). Returns new pools. */
export function leaveCluster(pools: readonly HostPool[], hostId: string): HostPool[] {
  if (hostId === LOCAL_HOST_ID) throw new ClusterError("master_cannot_leave", "This machine is the cluster master and cannot leave");
  const current = clusterOf(pools);
  const leaving = current?.members.find((member) => member.hostId === hostId);
  if (!current || !leaving) throw new ClusterError("not_member", `Host ${hostId} is not in the cluster`);
  const root = comparableProjectPath(leaving.projectsRoot);
  const next: HostPool = {
    ...current,
    members: current.members.filter((member) => member !== leaving),
    projects: current.projects.map((project) => {
      const { [hostId]: path, ...others } = project.clonePaths;
      return { ...project, clonePaths: path === undefined || within(comparableProjectPath(path), root) ? { ...project.clonePaths } : others };
    }),
  };
  return [next, ...pools.slice(1)];
}
