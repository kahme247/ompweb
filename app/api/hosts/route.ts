import { NextResponse } from "next/server";
import { closeHostLink, hostsSnapshot, listHosts, notifyHostsChange } from "@/lib/hosts/hub";
import { createHost, HostRegistryUnreadableError, revokeHost, UnknownHostError, updateHost } from "@/lib/hosts/registry";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_LABEL_LENGTH = 100;
const noStore = { "cache-control": "no-store" };

const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

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

export async function GET() {
  return NextResponse.json(await hostsSnapshot(), { headers: noStore });
}

export async function POST(req: Request) {
  const body = await readBody(req);
  const label = parseLabel(body?.label);
  if (!label) return fail(`label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`, 400);
  try {
    const { host, token } = createHost(label);
    notifyHostsChange();
    return NextResponse.json(
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
  if (body.id === "local") return fail("This machine cannot be edited", 400);
  const label = parseLabel(body.label);
  if (label === null) return fail(`label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`, 400);
  const { allowAgentStart } = body;
  if (allowAgentStart !== undefined && typeof allowAgentStart !== "boolean") return fail("allowAgentStart must be a boolean", 400);
  if (label === undefined && allowAgentStart === undefined) return fail("Nothing to update", 400);
  try {
    updateHost(body.id, { label, allowAgentStart });
    notifyHostsChange();
    return NextResponse.json({ host: listHosts().find((h) => h.id === body.id) }, { headers: noStore });
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
    notifyHostsChange();
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return failFor(error);
  }
}
