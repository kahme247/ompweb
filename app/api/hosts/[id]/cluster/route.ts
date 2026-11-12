import { randomUUID } from "node:crypto";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { CLUSTER_PROJECTS_DIR, ClusterError, clusterJoinBlock, isClusterMember, joinCluster, leaveCluster, MIN_SHARED_CREDENTIALS_OMP, type HostProjectFacts } from "@/lib/hosts/cluster";
import { logClusterConflicts, memberFacts, passes } from "@/lib/hosts/cluster-reconcile";
import type { Host } from "@/lib/hosts/host";
import { clusterConfigOp, getHost, getHostLinkProtocol, getHostOmpVersion, listHosts, masterConfigVersion, notifyHostsChange } from "@/lib/hosts/hub";
import { CLUSTER_CONFIG_SINCE_VERSION, HostOpError } from "@/lib/hosts/link-protocol";
import { loadPools, savePools, type HostPool, type PoolProject } from "@/lib/hosts/pools";
import { LOCAL_HOST_ID, loadHosts } from "@/lib/hosts/registry";
import type { OpResult } from "@/lib/hosts/session-ops";
import { abortBrokerRequests } from "@/lib/omp/auth-broker";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { isRecord } from "@/lib/type-guards";

type Context = { params: Promise<{ id: string }> };
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

function valueOf<T>(result: OpResult<T>): T {
  if (!result.ok) throw new HostOpError(result.status, result.code, result.error);
  return result.value;
}

function requireReady(host: Host): void {
  const block = clusterJoinBlock({ status: host.status(), protocol: getHostLinkProtocol(host.id), ompVersion: getHostOmpVersion(host.id), supports: (operation) => host.supportsWorkspaceOp(operation) });
  if (block === null) return;
  if (block === "omp-old") throw new HostOpError(409, "host_omp_too_old", `Update omp on ${host.label} to ${MIN_SHARED_CREDENTIALS_OMP} or newer first`);
  if (block !== "upgrade") throw new HostOpError(409, "host_offline", `${host.label} is offline`);
  throw host.id === LOCAL_HOST_ID
    ? new HostOpError(409, "host_restart_required", "Restart this machine's ompweb host daemon to join the cluster")
    : new HostOpError(409, "host_upgrade_required", `Update ompweb on ${host.label} to join the cluster`);
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
    // This machine is the master: any join adds it while it is not a member; it never joins by request.
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
    // One cluster per host: its daemon would refuse this server's configuration, and every session start with it.
    const held = listHosts().find((row) => row.id === id)?.clusterConfig;
    if (held && held.version !== null && !held.owned) {
      return fail(`${host.label} runs another server's cluster configuration; it must leave that cluster first`, "host_in_other_cluster", 409);
    }
    // The host round trips come first. pools.json is then read again, joined and saved with no await between, so a change
    // made meanwhile (a leave, another join, a pool edit) is kept.
    const gathered: { member: { hostId: string; projectsRoot: string }; facts: HostProjectFacts[]; sessionRoots: Set<string> }[] = [];
    for (const target of joining) {
      const root = target === host ? projectsRoot : await localProjectsRoot(target);
      const { projects: facts, sessionRoots } = await memberFacts(target);
      gathered.push({ member: { hostId: target.id, projectsRoot: root }, facts, sessionRoots });
    }
    // The master's version comes first: nothing may wait between the save and the apply, so a leave cannot come before it.
    // A master configuration that cannot be served sends none now; the 30 s sync sends it once it can.
    const version = await masterConfigVersion().catch(() => null);
    try {
      pools = loadPools();
    } catch {
      return storageFailure();
    }
    // This machine's facts were not gathered: it was a member when the join began.
    if (!addLocal && !isClusterMember(pools, LOCAL_HOST_ID)) return fail("The cluster changed during the join; try again", "cluster_changed", 409);
    const now = new Date().toISOString();
    const valid = (project: PoolProject) => passes([], [project]);
    for (const { member, facts, sessionRoots } of gathered) {
      // Added meanwhile by another join.
      if (member.hostId === LOCAL_HOST_ID && isClusterMember(pools, LOCAL_HOST_ID)) continue;
      const change = joinCluster(pools, member, facts, sessionRoots, now, randomUUID, valid);
      logClusterConflicts(change.conflicts);
      pools = change.pools;
    }
    savePools(pools);
    notifyHostsChange();
    // The joined host only: this machine is the master. A failure shows in the state the host reports; the join stands.
    if (version !== null) await clusterConfigOp(host.id, { action: "apply", version }).catch(() => undefined);
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
    // After the save, so no apply follows it (spec K6). A host that cannot take it now (offline or timed out) gets it
    // from the sync once it reports holding this server's configuration. A daemon below protocol 10 never applied one;
    // one that held it before a downgrade reports it once it is updated, and the sync restores it then.
    let restoreError: string | undefined;
    if ((getHostLinkProtocol(id) ?? CLUSTER_CONFIG_SINCE_VERSION) >= CLUSTER_CONFIG_SINCE_VERSION) {
      try {
        const answer = await clusterConfigOp(id, { action: "restore" });
        // Still holding a version that is not this server's: one this server cannot put back (another server's, or this
        // server's recorded at an address the host still links to).
        if (answer.state.version !== null && !answer.owned) restoreError = `${getHost(id)?.label ?? id} still runs a cluster configuration this server cannot put back`;
      } catch (error) {
        restoreError = error instanceof Error ? error.message : String(error);
      }
    }
    return Response.json({ pools, ...(restoreError === undefined ? {} : { restoreError }) }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
