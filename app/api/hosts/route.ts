import { closeHostLink, hostsSnapshot, listHosts, notifyHostsChange } from "@/lib/hosts/hub";
import { loadPools, savePools, type HostPool } from "@/lib/hosts/pools";
import { createHost, HostRegistryUnreadableError, readHosts, revokeHost, UnknownHostError, updateHost } from "@/lib/hosts/registry";
import { abortBrokerRequests } from "@/lib/omp/auth-broker";
import { isRecord } from "@/lib/type-guards";

const MAX_LABEL_LENGTH = 100;
const noStore = { "cache-control": "no-store" };

const fail = (error: string, status: number) => Response.json({ error }, { status, headers: noStore });
const poolStorageFailure = () => fail("The pool registry (omp-web/pools.json) cannot be read or written; fix it before changing pools", 503);

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function failFor(error: unknown) {
  if (error instanceof HostRegistryUnreadableError) {
    return fail("The linked-hosts registry (omp-web/hosts.json) cannot be read; fix or remove it before changing hosts", 503);
  }
  if (error instanceof UnknownHostError) return fail("Unknown host", 404);
  throw error;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** `undefined` when absent, `null` when invalid. */
function parseLabel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH ? label : null;
}

/** Where a daemon should dial: the origin the browser used, through a reverse proxy if there is one. */
function requestOrigin(req: Request): string {
  const first = (name: string) => req.headers.get(name)?.split(",")[0]?.trim() || null;
  const own = new URL(req.url);
  const proto = first("x-forwarded-proto") ?? own.protocol.slice(0, -1);
  const host = first("x-forwarded-host") ?? req.headers.get("host") ?? own.host;
  try {
    const url = new URL(`${proto}://${host}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : own.origin;
  } catch {
    return own.origin;
  }
}

export function GET() {
  let pools: HostPool[];
  try {
    pools = loadPools();
  } catch {
    return poolStorageFailure();
  }
  return Response.json({ ...hostsSnapshot(), pools }, { headers: noStore });
}

export async function PUT(req: Request) {
  const body = await readBody(req);
  if (!hasOnlyKeys(body, ["pools"]) || !Array.isArray(body.pools)) return fail("pools must be an array", 400);
  const knownHosts = new Set(["local"]);
  try {
    for (const host of readHosts()) knownHosts.add(host.id);
  } catch (error) {
    return failFor(error);
  }
  for (const pool of body.pools) {
    if (!hasOnlyKeys(pool, ["id", "label", "enabled", "members", "projects"])
      || !Array.isArray(pool.members) || !Array.isArray(pool.projects)) return fail("Invalid pool configuration", 400);
    for (const member of pool.members) {
      if (!hasOnlyKeys(member, ["hostId", "projectsRoot", "provisioned", "draining"])
        || typeof member.hostId !== "string" || !knownHosts.has(member.hostId)) return fail("Invalid or unknown pool member", 400);
    }
    for (const project of pool.projects) {
      if (!hasOnlyKeys(project, ["id", "name", "origin", "defaultRef", "clonePaths", "addedAt", "hidden", "alias", "sortOrder", "pinOrder", "launchConfig"])
        || (project.launchConfig !== undefined && !hasOnlyKeys(project.launchConfig, ["profile", "advisor", "extraArgs"]))) {
        return fail("Invalid pool project configuration", 400);
      }
    }
  }
  try {
    loadPools();
  } catch {
    return poolStorageFailure();
  }
  try {
    savePools(body.pools as HostPool[]);
  } catch (error) {
    // Core validation precedes persistence; filesystem errors carry an errno code.
    if (isRecord(error) && typeof error.code === "string") return poolStorageFailure();
    return fail("Invalid pool configuration", 400);
  }
  return Response.json({ pools: body.pools }, { headers: noStore });
}

export async function POST(req: Request) {
  const body = await readBody(req);
  const label = parseLabel(body?.label);
  if (!label) return fail(`label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`, 400);
  try {
    const { host, token } = createHost(label);
    notifyHostsChange();
    return Response.json(
      {
        host: listHosts().find((h) => h.id === host.id),
        token,
        command: `ompweb host login --url ${requestOrigin(req)}`,
      },
      { headers: noStore },
    );
  } catch (error) {
    return failFor(error);
  }
}

export async function PATCH(req: Request) {
  const body = await readBody(req);
  if (!body || typeof body.id !== "string" || !body.id) return fail("id is required", 400);
  const isLocal = body.id === "local";
  if (isLocal && body.allowAgentStart !== undefined) return fail("This machine's agent-start setting cannot be changed", 400);
  if (isLocal && body.shareCredentials !== undefined) return fail("This machine's credential sharing cannot be changed", 400);
  // An empty name resets this machine to its default name.
  const label = isLocal && typeof body.label === "string" && !body.label.trim() ? "" : parseLabel(body.label);
  if (label === null) return fail(`label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`, 400);
  const { allowAgentStart, shareCredentials } = body;
  if (allowAgentStart !== undefined && typeof allowAgentStart !== "boolean") return fail("allowAgentStart must be a boolean", 400);
  if (shareCredentials !== undefined && typeof shareCredentials !== "boolean") return fail("shareCredentials must be a boolean", 400);
  if (label === undefined && allowAgentStart === undefined && shareCredentials === undefined) return fail("Nothing to update", 400);
  try {
    updateHost(body.id, { label, allowAgentStart, shareCredentials });
    if (shareCredentials === false) abortBrokerRequests(body.id);
    notifyHostsChange();
    return Response.json({ host: hostsSnapshot().hosts.find((h) => h.id === body.id) }, { headers: noStore });
  } catch (error) {
    return failFor(error);
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id is required", 400);
  if (id === "local") return fail("This machine cannot be revoked", 400);
  try {
    // Registry first: with the record gone a daemon that redials gets 401 instead of reconnecting.
    if (!revokeHost(id)) return fail("Unknown host", 404);
    closeHostLink(id);
    abortBrokerRequests(id);
    notifyHostsChange();
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return failFor(error);
  }
}
