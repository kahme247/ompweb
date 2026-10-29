// Linked-host registry for the main omp-web server. Pure Node: no Next or `@/` imports.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../omp/paths";

export interface HostRecord {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  allowAgentStart: boolean;
}

interface HostsFile {
  hosts: HostRecord[];
}

/** "This machine": the one record the web server itself creates (local-bootstrap.ts). */
export const LOCAL_HOST_ID = "local";

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Host label is required");
  return trimmed;
}

const sha256Hex = (token: string): string => createHash("sha256").update(token).digest("hex");

// Keep only usable records so one bad entry cannot break token lookup for the rest.
function parseHostRecord(raw: unknown): HostRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.tokenHash !== "string") return null;
  return {
    id: r.id,
    label: typeof r.label === "string" ? r.label : "",
    tokenHash: r.tokenHash,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    lastSeenAt: typeof r.lastSeenAt === "string" ? r.lastSeenAt : null,
    allowAgentStart: r.allowAgentStart === true,
  };
}

/** hosts.json exists but cannot be read or parsed: no token can be checked. */
export class HostRegistryUnreadableError extends Error {
  readonly name = "HostRegistryUnreadableError";
}

/** Every usable record; a missing file is an empty registry, an unreadable one throws. */
function readHosts(): HostRecord[] {
  const file = join(getAgentDir(), "omp-web", "hosts.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new HostRegistryUnreadableError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HostRegistryUnreadableError(`${file} is not valid JSON`);
  }
  const hosts = parsed && typeof parsed === "object" && "hosts" in parsed ? parsed.hosts : undefined;
  if (!Array.isArray(hosts)) throw new HostRegistryUnreadableError(`${file} has no hosts list`);
  return hosts.map(parseHostRecord).filter((h): h is HostRecord => h !== null);
}

export function loadHosts(): HostRecord[] {
  try {
    return readHosts();
  } catch {
    return [];
  }
}

function saveHosts(hosts: HostRecord[]): void {
  const file = join(getAgentDir(), "omp-web", "hosts.json");
  mkdirSync(dirname(file), { recursive: true });
  // Atomic write, owner-only: the file holds token hashes for every linked host.
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ hosts } satisfies HostsFile, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    // Best-effort cleanup if the rename never happened.
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** Register a host. The returned token is the only copy: the registry keeps its sha256. */
export function createHost(label: string): { host: HostRecord; token: string } {
  const token = randomBytes(32).toString("base64url");
  const host: HostRecord = {
    id: randomUUID(),
    label: normalizeLabel(label),
    tokenHash: sha256Hex(token),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    allowAgentStart: false,
  };
  saveHosts([...readHosts(), host]);
  return { host, token };
}

export class UnknownHostError extends Error {
  readonly name = "UnknownHostError";
  constructor() {
    super("Unknown host");
  }
}

/** `local` is created and keyed by the web server only; it cannot be renamed or revoked. */
export class ReservedHostError extends Error {
  readonly name = "ReservedHostError";
  constructor() {
    super("This machine cannot be changed");
  }
}

export function updateHost(id: string, updates: { label?: string; allowAgentStart?: boolean }): HostRecord {
  if (id === LOCAL_HOST_ID) throw new ReservedHostError();
  const hosts = readHosts();
  const host = hosts.find((h) => h.id === id);
  if (!host) throw new UnknownHostError();
  if (updates.label !== undefined) host.label = normalizeLabel(updates.label);
  if (updates.allowAgentStart !== undefined) host.allowAgentStart = updates.allowAgentStart;
  saveHosts(hosts);
  return host;
}

/** Create the `local` record, or give the existing one a new token; the old token stops matching. */
export function rotateLocalHostToken(): string {
  const hosts = readHosts();
  const existing = hosts.find((h) => h.id === LOCAL_HOST_ID);
  const token = randomBytes(32).toString("base64url");
  const record: HostRecord = {
    id: LOCAL_HOST_ID,
    label: "This machine",
    tokenHash: sha256Hex(token),
    createdAt: existing?.createdAt || new Date().toISOString(),
    lastSeenAt: existing?.lastSeenAt ?? null,
    allowAgentStart: true,
  };
  saveHosts([...hosts.filter((h) => h.id !== LOCAL_HOST_ID), record]);
  return token;
}

export function revokeHost(id: string): boolean {
  if (id === LOCAL_HOST_ID) throw new ReservedHostError();
  const hosts = readHosts();
  const remaining = hosts.filter((h) => h.id !== id);
  if (remaining.length === hosts.length) return false;
  saveHosts(remaining);
  return true;
}

/** Constant-time comparison of the presented token's sha256 against every record.
 * Throws HostRegistryUnreadableError rather than answer "no match" when the
 * registry cannot be read: a daemon told its token is unknown stops its sessions. */
export function hostForToken(token: string): HostRecord | null {
  if (typeof token !== "string") return null;
  const digest = Buffer.from(sha256Hex(token));
  for (const host of readHosts()) {
    const stored = Buffer.from(host.tokenHash);
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) return host;
  }
  return null;
}

export function touchHost(id: string, at: string): void {
  // Never rewrite a registry that cannot be read: that would drop every other host's token.
  let hosts: HostRecord[];
  try {
    hosts = readHosts();
  } catch {
    return;
  }
  const host = hosts.find((h) => h.id === id);
  if (!host) return;
  host.lastSeenAt = at;
  saveHosts(hosts);
}
