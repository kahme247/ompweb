import { randomUUID } from "node:crypto";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { comparableProjectPath } from "@/lib/comparable-path";
import { CLUSTER_ID, CLUSTER_LABEL, CLUSTER_PROJECTS_DIR, ClusterError, isClusterMember, joinCluster, leaveCluster, type HostProjectFacts } from "@/lib/hosts/cluster";
import type { Host } from "@/lib/hosts/host";
import { getHost, getHostLinkProtocol, notifyHostsChange } from "@/lib/hosts/hub";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { loadPools, poolProjectBindings, savePools, validatePools, type HostPool, type PoolMember, type PoolProject } from "@/lib/hosts/pools";
import { LOCAL_HOST_ID, loadHosts } from "@/lib/hosts/registry";
import type { OpResult } from "@/lib/hosts/session-ops";
import { hostSessions } from "@/lib/hosts/session-index";
import { abortBrokerRequests } from "@/lib/omp/auth-broker";
import { mergeProjects } from "@/lib/project-registry";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { isRecord } from "@/lib/type-guards";
import type { GitOrigin } from "@/lib/workspace-types";

type Context = { params: Promise<{ id: string }> };
/** The first link protocol whose daemons can be cluster members. */
const CLUSTER_SINCE_VERSION = 9;
/** gitOrigins' input bounds: it refuses the whole call beyond them. */
const MAX_ORIGIN_PATHS = 500;
const MAX_ORIGIN_PATH_LENGTH = 4096;
const noStore = { "cache-control": "no-store" };
const fail = (error: string, code: string, status: number) => Response.json({ error, code }, { status, headers: noStore });
const storageFailure = () => fail("The pool registry (omp-web/pools.json) cannot be read or written; fix it before changing the cluster", "pool_storage_unavailable", 503);
function errorResponse(error: unknown): Response {
  if (error instanceof HostOpError) return fail(error.message, error.code, error.status);
  if (error instanceof ClusterError) return fail(error.message, error.code, 409);
  if (error instanceof RequestBodyTooLargeError) return fail(error.message, "body_too_large", 413);
  if (error instanceof SyntaxError) return fail("Request body must be valid JSON", "invalid_json", 400);
  // A failed pools.json write: filesystem errors name their syscall.
  if (isRecord(error) && typeof error.syscall === "string") return storageFailure();
  return fail("The cluster change failed", "cluster_change_failed", 500);
}

/** The pool rules, applied to one member or one project. */
function passes(members: PoolMember[], projects: PoolProject[]): boolean {
  try {
    validatePools([{ id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members, projects }]);
    return true;
  } catch {
    return false;
  }
}

function valueOf<T>(result: OpResult<T>): T {
  if (!result.ok) throw new HostOpError(result.status, result.code, result.error);
  return result.value;
}

function requireReady(host: Host): void {
  if (host.status() !== "online") throw new HostOpError(409, "host_offline", `${host.label} is offline`);
  if ((getHostLinkProtocol(host.id) ?? 0) >= CLUSTER_SINCE_VERSION && host.supportsWorkspaceOp("gitOrigins")) return;
  throw host.id === LOCAL_HOST_ID
    ? new HostOpError(409, "host_restart_required", "Restart this machine's ompweb host daemon to join the cluster")
    : new HostOpError(409, "host_upgrade_required", `Update ompweb on ${host.label} to join the cluster`);
}

/** The host's projects in its own order (mergeProjects: the order the user sees), then its hidden registry entries, which move too. */
async function hostFacts(host: Host): Promise<HostProjectFacts[]> {
  const registry = await host.sessionOps.listProjects();
  const discovered = (await hostSessions(host.id)).map((session) => session.projectRoot ?? session.cwd);
  // As listProjectsAllHosts: only this machine's paths resolve here.
  const projects: HostProjectFacts["project"][] = mergeProjects({ version: 1, projects: registry }, discovered, host.id === LOCAL_HOST_ID ? undefined : (path) => path);
  const seen = new Set(projects.map((project) => comparableProjectPath(project.path)));
  for (const entry of registry) {
    const key = comparableProjectPath(entry.path);
    if (!entry.hidden || seen.has(key)) continue;
    seen.add(key);
    projects.push(entry);
  }
  // Longer paths are not sent: they stay pinned.
  const sendable = projects.map((project) => project.path).filter((path) => path.length <= MAX_ORIGIN_PATH_LENGTH);
  const origins = new Map<string, GitOrigin | undefined>();
  for (let start = 0; start < sendable.length; start += MAX_ORIGIN_PATHS) {
    const paths = sendable.slice(start, start + MAX_ORIGIN_PATHS);
    const answers = valueOf(await host.workspaceOps.gitOrigins(paths)).origins;
    paths.forEach((path, i) => origins.set(path, answers[i]));
  }
  return projects.map((project) => ({ project, origin: origins.get(project.path)?.origin ?? null, mainCheckout: origins.get(project.path)?.mainCheckout ?? false }));
}

async function localProjectsRoot(host: Host): Promise<string> {
  const { home } = valueOf(await host.workspaceOps.home());
  return `${home}${home.includes("\\") ? "\\" : "/"}${CLUSTER_PROJECTS_DIR}`;
}

export async function PUT(request: Request, { params }: Context) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return fail("Cross-origin API requests are not allowed", "cross_origin_forbidden", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return fail("Content-Type must be application/json", "unsupported_media_type", 415);
  try {
    const { id } = await params;
    // This machine is the master: it joins with the first linked host, never by request.
    const host = id === LOCAL_HOST_ID ? null : getHost(id);
    if (!host) return fail("Unknown host", "unknown_host", 404);
    const body = await parseJsonWithinLimit<unknown>(request, 8192);
    const projectsRoot = isRecord(body) && Object.keys(body).length === 1 ? body.projectsRoot : undefined;
    if (typeof projectsRoot !== "string" || !passes([{ hostId: id, projectsRoot, provisioned: true, draining: false }], [])) {
      return fail("projectsRoot must be an absolute folder path", "invalid_projects_root", 400);
    }
    let pools: HostPool[];
    try {
      pools = loadPools();
    } catch {
      return storageFailure();
    }
    const addLocal = !isClusterMember(pools, LOCAL_HOST_ID);
    const joining = addLocal ? [getHost(LOCAL_HOST_ID), host] : [host];
    joining.forEach(requireReady);
    // The host round trips come first. pools.json is then read again, joined and saved with no await between, so a change
    // made meanwhile (a leave, another join, a pool edit) is kept.
    const gathered: { member: { hostId: string; projectsRoot: string }; facts: HostProjectFacts[] }[] = [];
    for (const target of joining) {
      const root = target === host ? projectsRoot : await localProjectsRoot(target);
      gathered.push({ member: { hostId: target.id, projectsRoot: root }, facts: await hostFacts(target) });
    }
    try {
      pools = loadPools();
    } catch {
      return storageFailure();
    }
    // This machine's facts were not gathered: it was a member when the join began.
    if (!addLocal && !isClusterMember(pools, LOCAL_HOST_ID)) return fail("The cluster changed during the join; try again", "cluster_changed", 409);
    const now = new Date().toISOString();
    const valid = (project: PoolProject) => passes([], [project]);
    for (const { member, facts } of gathered) {
      // Added meanwhile by another join.
      if (member.hostId === LOCAL_HOST_ID && isClusterMember(pools, LOCAL_HOST_ID)) continue;
      // A checkout a pool already binds for this host stays with that pool.
      const bound = poolProjectBindings(pools).get(member.hostId);
      pools = joinCluster(pools, member, facts.filter(({ project }) => !bound?.has(comparableProjectPath(project.path))), now, randomUUID, valid);
    }
    savePools(pools);
    notifyHostsChange();
    return Response.json({ pools }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return fail("Cross-origin API requests are not allowed", "cross_origin_forbidden", 403);
  try {
    const { id } = await params;
    let pools: HostPool[];
    try {
      pools = loadPools();
    } catch {
      return storageFailure();
    }
    pools = leaveCluster(pools, id);
    savePools(pools);
    if (loadHosts().find((record) => record.id === id)?.shareCredentials !== true) abortBrokerRequests(id);
    notifyHostsChange();
    return Response.json({ pools }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
