// Pure computation of cluster membership (spec M3, M6): no disk, network or clock.
// Browser-importable: only types from ./pools (it loads node:fs), no node:* modules.
import { comparableProjectPath } from "../comparable-path";
import { cloneDirectoryName, repositoryKey } from "../git-clone";
import { LOCAL_HOST_ID } from "../project-ordering";
import type { ManagedProject } from "../types";
import type { HostPool } from "./pools";

export const CLUSTER_ID = "cluster";
export const CLUSTER_LABEL = "Cluster";
export const CLUSTER_PROJECTS_DIR = "ompweb-cluster";

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

/** A path under a host's root, in the separator that root uses (hosts may run another OS than the server). */
const under = (root: string, name: string) => `${root}${root.includes("\\") ? "\\" : "/"}${name}`;

/** Adds one host and moves its projects (spec M3). Returns new pools; never mutates its input. */
export function joinCluster(
  pools: readonly HostPool[],
  member: { hostId: string; projectsRoot: string },
  projects: readonly HostProjectFacts[],
  now: string,
  newId: () => string,
): HostPool[] {
  const current = clusterOf(pools);
  if (current?.members.some((existing) => existing.hostId === member.hostId)) {
    throw new ClusterError("already_member", `Host ${member.hostId} is already in the cluster`);
  }
  const base = current ?? { id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members: [], projects: [] };
  const next: HostPool = {
    ...base,
    members: [...base.members, { hostId: member.hostId, projectsRoot: member.projectsRoot, provisioned: true, draining: false }],
    projects: base.projects.map((project) => ({ ...project, clonePaths: { ...project.clonePaths } })),
  };
  for (const { project, origin, mainCheckout } of projects) {
    // Not isValidPoolOrigin: pools.ts loads node:fs. It adds only the padding check to repositoryKey, which already rejects https credentials.
    if (!mainCheckout || origin === null || origin !== origin.trim()) continue;
    const key = repositoryKey(origin);
    if (key === null) continue;
    let target = next.projects.find((candidate) => repositoryKey(candidate.origin) === key);
    if (target && Object.hasOwn(target.clonePaths, member.hostId)) continue; // an existing binding may already hold sessions
    if (!target) {
      target = {
        id: newId(), name: cloneDirectoryName(origin)!, origin, clonePaths: {},
        addedAt: project.addedAt ?? now, hidden: project.hidden ?? false,
        alias: project.alias, sortOrder: project.sortOrder, pinOrder: project.pinOrder, launchConfig: project.launchConfig,
      };
      next.projects.push(target);
    }
    target.clonePaths[member.hostId] = project.path;
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
  const isCreated = (path: string) => {
    const comparable = comparableProjectPath(path);
    return comparable === root || comparable.startsWith(`${root}/`);
  };
  const next: HostPool = {
    ...current,
    members: current.members.filter((member) => member !== leaving),
    projects: current.projects.map((project) => {
      const { [hostId]: path, ...others } = project.clonePaths;
      return { ...project, clonePaths: path === undefined || isCreated(path) ? { ...project.clonePaths } : others };
    }),
  };
  return [next, ...pools.slice(1)];
}
