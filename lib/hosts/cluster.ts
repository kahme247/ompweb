// Pure computation of cluster membership (spec M3, M6): no disk, network or clock.
// Browser-importable: only types from ./pools (it loads node:fs), no node:* modules; ./link-protocol is pure.
import { comparableProjectPath } from "../comparable-path";
import { cloneDirectoryName, repositoryKey } from "../git-clone";
import { LOCAL_HOST_ID } from "../project-ordering";
import { isNewerVersion } from "../version-compare";
import type { ManagedProject } from "../types";
import type { HostStatus } from "./host";
import { CLUSTER_CONFIG_SINCE_VERSION } from "./link-protocol";
import type { HostPool, PoolProject } from "./pools";

export const CLUSTER_ID = "cluster";
export const CLUSTER_LABEL = "Cluster";
export const CLUSTER_PROJECTS_DIR = "ompweb-cluster";
/** The first link protocol whose daemons can be cluster members (they apply the master's configuration); they also need the `gitOrigins` operation. */
export const CLUSTER_SINCE_VERSION = CLUSTER_CONFIG_SINCE_VERSION;
/** The first omp that honours the broker variables; an older one could start with the host's own logins. */
export const MIN_SHARED_CREDENTIALS_OMP = "15.13.1";

/** Whether an omp (`omp --version` prints "omp/<version>") can run on shared credentials; unknown or unparsable cannot. */
export function ompSharesCredentials(version: string | null): boolean {
  const bare = version?.replace(/^omp\//, "") ?? null;
  return bare !== null && isNewerVersion(bare, "0.0.0") && !isNewerVersion(MIN_SHARED_CREDENTIALS_OMP, bare);
}

/**
 * Why a host cannot join the cluster now, or null: the one rule behind the join route and the Settings switch.
 * Non-online hosts retain their status as the reason; online hosts need the protocol and operation below ("upgrade"),
 * then an omp that takes shared credentials, which members always use ("omp-old").
 */
export function clusterJoinBlock(host: { status: HostStatus; protocol: number | null; ompVersion: string | null; supports: (operation: "gitOrigins") => boolean }): Exclude<HostStatus, "online"> | "upgrade" | "omp-old" | null {
  if (host.status !== "online") return host.status;
  if ((host.protocol ?? 0) < CLUSTER_SINCE_VERSION || !host.supports("gitOrigins")) return "upgrade";
  return ompSharesCredentials(host.ompVersion) ? null : "omp-old";
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

/**
 * Whether Settings act for the cluster, on the master's configuration (spec K7): `target`, the session or project they
 * are opened for, is the cluster's (its pool's, or one on a member's node), and `hostId`, where it runs (undefined: this
 * machine), is still a member. A session of a host that has left runs on that host's own configuration.
 */
export function isClusterTarget(target: { poolId?: string; hostId?: string } | null, hostId: string | undefined, pools: readonly HostPool[]): boolean {
  const cluster = clusterOf(pools);
  if (!target || !cluster) return false;
  const ofCluster = target.poolId ? target.poolId === cluster.id : isClusterMember(pools, target.hostId ?? LOCAL_HOST_ID);
  return ofCluster && (hostId === undefined || isClusterMember(pools, hostId));
}

/** Whether sessions on this host run on the server's provider logins: members always, other hosts by their own flag, `local` never. */
export function sharesCredentials(record: { id: string; shareCredentials: boolean }, pools: readonly HostPool[]): boolean {
  return record.id !== LOCAL_HOST_ID && (record.shareCredentials || isClusterMember(pools, record.id));
}

/** A path under a host's root, in the separator that root uses (hosts may run another OS than the server). */
const under = (root: string, name: string) => `${root}${root.includes("\\") ? "\\" : "/"}${name}`;

/** `path` is `root` or below it; both in comparableProjectPath form. */
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** What a cluster change did besides the pools: checkouts left separate, each with why, for the server log. */
export interface ClusterChange { pools: HostPool[]; conflicts: string[] }

/** What a checkout's registry entry lends a cluster project that lacks it. */
const PRESENTATION = ["alias", "sortOrder", "pinOrder"] as const;

/**
 * Adds one host and moves its projects (spec M3), by `reconcileMember`'s rules. Returns new pools; never mutates its input.
 */
export function joinCluster(
  pools: readonly HostPool[],
  member: { hostId: string; projectsRoot: string },
  projects: readonly HostProjectFacts[],
  sessionRoots: ReadonlySet<string>,
  now: string,
  newId: () => string,
  valid: (project: PoolProject) => boolean,
): ClusterChange {
  const current = clusterOf(pools);
  if (current?.members.some((existing) => existing.hostId === member.hostId)) {
    throw new ClusterError("already_member", "The host is already in the cluster");
  }
  const base = current ?? { id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members: [], projects: [] };
  const next: HostPool = { ...base, members: [...base.members, { hostId: member.hostId, projectsRoot: member.projectsRoot, provisioned: true, draining: false }] };
  return reconcileMember([next, ...pools.slice(1)], member.hostId, projects, sessionRoots, now, newId, valid);
}

/**
 * Binds a member's existing Git checkouts to the cluster project of the same repository (`repositoryKey` of the origin;
 * never the path), creating the project when none has it, then gives every member a folder for each project it has no
 * checkout of, where its first session there clones. Returns new pools; never mutates its input; idempotent.
 * `projects` are the host's registered and session-discovered projects; `sessionRoots` the comparableProjectPath of every
 * session's project root on the host. A project's binding for the host is replaced by a checkout only when no session
 * there belongs to it and it is not itself one of the host's checkouts of that repository (else two checkouts would
 * swap on every run); such a checkout stays separate and is reported. Plain folders, other worktrees, unusable origins,
 * a checkout at or above the member's projectsRoot (seeded clones would land in it) and one another pool binds stay on
 * their host. `valid` decides, for each project a checkout would create or bind, whether the result is acceptable (the
 * caller passes a check built on `validatePools`, which this module cannot import); one that fails stays on its host
 * and any existing cluster project is left unchanged, so one odd remote or launch setting cannot fail the call.
 * Binding keeps the cluster project's alias, sort and pin order, taking the checkout's only where it has none.
 */
export function reconcileMember(
  pools: readonly HostPool[],
  hostId: string,
  projects: readonly HostProjectFacts[],
  sessionRoots: ReadonlySet<string>,
  now: string,
  newId: () => string,
  valid: (project: PoolProject) => boolean,
): ClusterChange {
  const current = clusterOf(pools);
  const self = current?.members.find((member) => member.hostId === hostId);
  if (!current || !self) return { pools: [...pools], conflicts: [] };
  const next: HostPool = { ...current, projects: current.projects.map((project) => ({ ...project, clonePaths: { ...project.clonePaths } })) };
  const bound = new Set<string>();
  for (const pool of [next, ...pools.slice(1)]) {
    for (const project of pool.projects) if (Object.hasOwn(project.clonePaths, hostId)) bound.add(comparableProjectPath(project.clonePaths[hostId]));
  }
  const root = comparableProjectPath(self.projectsRoot);
  const eligible = projects.flatMap(({ project, origin, mainCheckout }) => {
    const key = mainCheckout && origin !== null ? repositoryKey(origin) : null;
    const path = comparableProjectPath(project.path);
    return key === null || within(root, path) ? [] : [{ project, origin: origin!, key, path }];
  });
  const checkouts = new Map(eligible.map(({ path, key }) => [path, key]));
  const conflicts: string[] = [];
  for (const { project, origin, key, path } of eligible) {
    if (bound.has(path)) continue;
    const existing = next.projects.find((candidate) => repositoryKey(candidate.origin) === key);
    const held = existing && Object.hasOwn(existing.clonePaths, hostId) ? comparableProjectPath(existing.clonePaths[hostId]) : null;
    if (existing && held !== null && (sessionRoots.has(held) || checkouts.get(held) === key)) {
      conflicts.push(`${hostId}: ${project.path} stays separate from cluster project ${existing.name}, bound to ${existing.clonePaths[hostId]}, which ${sessionRoots.has(held) ? "has sessions" : "is another checkout of it"}`);
      continue;
    }
    // A visible checkout keeps a hidden cluster project visible, else the project and its sessions vanish from the sidebar.
    const result: PoolProject = existing
      ? {
        ...existing, ...Object.fromEntries(PRESENTATION.filter((field) => existing[field] === undefined && project[field] !== undefined).map((field) => [field, project[field]])),
        hidden: existing.hidden && project.hidden === true, clonePaths: { ...existing.clonePaths, [hostId]: project.path },
      }
      : {
        // The name the host showed: its own, else its folder's (spec M3); the origin's only for a root path.
        id: newId(), name: project.name || project.path.split(/[\\/]/).filter(Boolean).pop() || cloneDirectoryName(origin)!, origin, clonePaths: { [hostId]: project.path },
        addedAt: project.addedAt ?? now, hidden: project.hidden ?? false,
        alias: project.alias, sortOrder: project.sortOrder, pinOrder: project.pinOrder, launchConfig: project.launchConfig,
      };
    if (!valid(result)) continue;
    if (held !== null) bound.delete(held);
    bound.add(path);
    if (existing) Object.assign(existing, result);
    else next.projects.push(result);
  }
  for (const project of next.projects) {
    for (const { hostId: memberId, projectsRoot } of next.members) {
      if (!Object.hasOwn(project.clonePaths, memberId)) project.clonePaths[memberId] = under(projectsRoot, project.id);
    }
  }
  return { pools: [next, ...pools.slice(1)], conflicts };
}

/** Removes one host (spec M6). Returns new pools. Only the folders the cluster made for it stay bound, for a later join;
 *  its own checkouts go back to it, with their sessions. */
export function leaveCluster(pools: readonly HostPool[], hostId: string): HostPool[] {
  if (hostId === LOCAL_HOST_ID) throw new ClusterError("master_cannot_leave", "This machine is the cluster master and cannot leave");
  const current = clusterOf(pools);
  const leaving = current?.members.find((member) => member.hostId === hostId);
  if (!current || !leaving) throw new ClusterError("not_member", `Host ${hostId} is not in the cluster`);
  const next: HostPool = {
    ...current,
    members: current.members.filter((member) => member !== leaving),
    projects: current.projects.map((project) => {
      const { [hostId]: path, ...others } = project.clonePaths;
      const made = path !== undefined && comparableProjectPath(path) === comparableProjectPath(under(leaving.projectsRoot, project.id));
      return { ...project, clonePaths: path === undefined || made ? { ...project.clonePaths } : others };
    }),
  };
  return [next, ...pools.slice(1)];
}
