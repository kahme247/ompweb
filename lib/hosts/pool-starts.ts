import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { getAgentDir } from "../omp/paths";
import { RpcCommandError } from "../omp/rpc-process";
import type { PreparedPoolProject } from "../pooled-projects";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import type { ProjectLaunchConfig } from "../types";
import type { Host } from "./host";
import { adoptedChild, getHost, getHostCapacity, getHostLinkProtocol, reconcilePooledChild } from "./hub";
import { CREATION_ID_RE, HostOpError, type HelloChannel } from "./link-protocol";
import { loadPools, selectPoolHost, type PoolHostSnapshot } from "./pools";

export interface PoolCreateInput {
  creationId: string;
  poolId: string;
  projectId: string;
  ref?: string;
  intent: Readonly<Record<string, unknown>>;
}

interface PoolCreateResult { sessionId: string; hostId: string; cwd: string; data?: unknown }
type Start = (host: Host, prepared: PreparedPoolProject, creationId: string, onStarted: (sessionId: string) => Promise<void>) => Promise<{ sessionId: string; data?: unknown }>;
type CreationState = "preparing" | "starting" | "started" | "unknown" | "refused";
type InitializationState = "pending" | "running" | "complete" | "unknown" | "failed";
interface Failure { status: number; code: string; message: string }
interface PoolStart {
  creationId: string;
  poolId: string;
  projectId: string;
  requestFingerprint: string;
  fingerprint: string;
  hostId: string;
  origin: string;
  cloneRoot: string;
  ref?: string;
  launchConfig?: ProjectLaunchConfig;
  prepared?: PreparedPoolProject;
  creation: CreationState;
  initialization: InitializationState;
  sessionId?: string;
  reserved: boolean;
  confirmedClock?: string;
  confirmedAt?: number;
  data?: unknown;
  failure?: Failure;
}
interface Journal { version: 1; starts: PoolStart[] }

const CLOCK = randomUUID();
const HASH = /^[a-f0-9]{64}$/;
const RESULT_FIELDS: Record<string, true> = { accepted: true, agentInvoked: true, success: true };
const creationStates: Record<CreationState, true> = { preparing: true, starting: true, started: true, unknown: true, refused: true };
const initializationStates: Record<InitializationState, true> = { pending: true, running: true, complete: true, unknown: true, failed: true };

declare global {
  var __ompPoolStarts: Map<string, Promise<PoolCreateResult>> | undefined;
  var __ompPoolLaunchLocks: Map<string, Promise<void>> | undefined;
}

/** Carries a retained real identity even when its first command's outcome is unknown. */
export class PoolStartError extends HostOpError {
  readonly sessionId?: string;
  readonly hostId?: string;
  readonly cwd?: string;
  readonly delivery?: "unknown";
  constructor(status: number, code: string, message: string, start?: PoolStart, uncertain = false) {
    super(status, code, message);
    this.sessionId = start?.sessionId;
    this.hostId = start?.hostId;
    this.cwd = start?.prepared?.cwd;
    if (uncertain) this.delivery = "unknown";
  }
}

function journalPath(): string { return join(getAgentDir(), "omp-web", "pool-starts.json"); }
function unavailable(): PoolStartError { return new PoolStartError(503, "pool_starts_unavailable", "The durable creation journal is unreadable; no new sessions can be admitted"); }
function conflict(): PoolStartError { return new PoolStartError(409, "creation_conflict", "This creation ID already belongs to a different session intent"); }
function unknown(start: PoolStart): PoolStartError { return new PoolStartError(503, "pool_start_unknown", "The original worker may have started this session; its outcome must be reconciled on that worker", start, true); }

/** Canonical JSON includes unknown command fields, but never journals the payload itself. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new PoolStartError(400, "invalid_creation_intent", "Creation intent must contain only JSON values");
}
function fingerprint(value: unknown): string { return createHash("sha256").update("ompweb:pool-creation:v1:").update(canonical(value)).digest("hex"); }
function pathApi(path: string): typeof posix { return win32.isAbsolute(path) && !posix.isAbsolute(path) ? win32 : posix; }
function absolute(path: unknown): path is string { return typeof path === "string" && !path.includes("\0") && pathApi(path).isAbsolute(path) && pathApi(path).normalize(path) === path; }
function creationCwd(cloneRoot: string, creationId: string): string {
  const path = pathApi(cloneRoot);
  return path.join(path.dirname(cloneRoot), `.${path.basename(cloneRoot)}_worktrees`, "session", creationId);
}

function readJournal(): Journal {
  try {
    let text: string;
    try { text = readFileSync(journalPath(), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, starts: [] }; throw error; }
    const journal: unknown = JSON.parse(text);
    if (!isRecord(journal) || journal.version !== 1 || !Array.isArray(journal.starts)) throw new Error("Invalid journal");
    const ids = new Set<string>();
    for (const entry of journal.starts) {
      if (!isRecord(entry) || typeof entry.creationId !== "string" || !CREATION_ID_RE.test(entry.creationId) || ids.has(entry.creationId)
        || typeof entry.poolId !== "string" || !CREATION_ID_RE.test(entry.poolId) || typeof entry.projectId !== "string" || !CREATION_ID_RE.test(entry.projectId)
        || typeof entry.hostId !== "string" || !CREATION_ID_RE.test(entry.hostId) || typeof entry.origin !== "string" || !absolute(entry.cloneRoot)
        || typeof entry.requestFingerprint !== "string" || !HASH.test(entry.requestFingerprint) || typeof entry.fingerprint !== "string" || !HASH.test(entry.fingerprint)
        || typeof entry.creation !== "string" || !Object.hasOwn(creationStates, entry.creation) || typeof entry.initialization !== "string" || !Object.hasOwn(initializationStates, entry.initialization) || typeof entry.reserved !== "boolean"
        || (entry.ref !== undefined && typeof entry.ref !== "string") || (entry.sessionId !== undefined && (typeof entry.sessionId !== "string" || !isValidSessionId(entry.sessionId)))
        || (entry.prepared !== undefined && (!isRecord(entry.prepared) || entry.prepared.cwd !== creationCwd(entry.cloneRoot, entry.creationId) || entry.prepared.projectRoot !== entry.cloneRoot || typeof entry.prepared.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(entry.prepared.baseCommit)))
        || (entry.confirmedAt !== undefined && (typeof entry.confirmedAt !== "number" || !Number.isFinite(entry.confirmedAt) || entry.confirmedAt < 0 || typeof entry.confirmedClock !== "string"))
        || ((entry.initialization === "running" || entry.initialization === "complete") && !entry.sessionId)) throw new Error("Invalid journal entry");
      if (entry.fingerprint !== fingerprint({ creationId: entry.creationId, poolId: entry.poolId, projectId: entry.projectId, hostId: entry.hostId, requestFingerprint: entry.requestFingerprint, origin: entry.origin, cloneRoot: entry.cloneRoot, ref: entry.ref ?? null, launchConfig: entry.launchConfig ?? null })
        || (entry.data !== undefined && entry.data !== null && (!isRecord(entry.data) || Object.entries(entry.data).some(([key, value]) => !Object.hasOwn(RESULT_FIELDS, key) || typeof value !== "boolean")))
        || (entry.failure !== undefined && (!isRecord(entry.failure) || typeof entry.failure.status !== "number" || !Number.isInteger(entry.failure.status) || entry.failure.status < 400 || entry.failure.status > 599 || typeof entry.failure.code !== "string" || typeof entry.failure.message !== "string"))) throw new Error("Invalid journal metadata");
      ids.add(entry.creationId);
    }
    return journal as unknown as Journal;
  } catch { throw unavailable(); }
}

function writeJournal(journal: Journal): void {
  const file = journalPath();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(journal)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, file);
    fd = openSync(dirname(file), "r");
    fsyncSync(fd);
  } catch { throw unavailable(); }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function update(creationId: string, change: (entry: PoolStart) => void): PoolStart {
  const journal = readJournal();
  const entry = journal.starts.find((candidate) => candidate.creationId === creationId);
  if (!entry) throw unavailable();
  change(entry);
  writeJournal(journal);
  return entry;
}

function result(entry: PoolStart): PoolCreateResult {
  if (!entry.sessionId || !entry.prepared) throw unknown(entry);
  return { sessionId: entry.sessionId, hostId: entry.hostId, cwd: entry.prepared.cwd, ...(entry.data === undefined ? {} : { data: entry.data }) };
}
function bounded(value: unknown): unknown {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  // Ack metadata only: arbitrary command results can contain credentials or private transcripts.
  const metadata: Record<string, boolean> = {};
  for (const key of Object.keys(RESULT_FIELDS)) if (typeof value[key] === "boolean") metadata[key] = value[key];
  return Object.keys(metadata).length ? metadata : undefined;
}
function failure(error: unknown): Failure {
  return { status: error instanceof HostOpError ? error.status : error instanceof RpcCommandError ? 400 : 503,
    code: error instanceof HostOpError || (isRecord(error) && typeof error.code === "string") ? String(error.code) : "pool_start_failed",
    message: "The original creation failed; inspect its original worker or session before starting another" };
}
function definite(error: unknown): boolean {
  return error instanceof RpcCommandError || error instanceof HostOpError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

/** Called before generic orphan cleanup. A damaged journal throws: creation children must then be retained. */
export function pooledStartForChild(hostId: string, child: HelloChannel): { creationId: string; sessionId?: string; cwd: string } | null {
  if (!child.creationId) return null;
  const entry = readJournal().starts.find((candidate) => candidate.creationId === child.creationId);
  if (!entry || entry.hostId !== hostId || entry.prepared?.cwd !== child.cwd || entry.creation === "refused") return null;
  if (entry.sessionId && child.sessionId && entry.sessionId !== child.sessionId) throw unknown(entry);
  return { creationId: entry.creationId, sessionId: entry.sessionId, cwd: child.cwd };
}

/** Only actual native child identity is sufficient to account for a retained reservation after restart. */
export function confirmPooledChild(creationId: string, hostId: string, cwd: string, sessionId: string, initializing = false): PoolStart {
  if (!isValidSessionId(sessionId)) throw new PoolStartError(502, "host_bad_result", "Worker reported an invalid session identity");
  return update(creationId, (entry) => {
    if (entry.hostId !== hostId || entry.prepared?.cwd !== cwd || entry.sessionId && entry.sessionId !== sessionId) throw conflict();
    entry.sessionId = sessionId;
    entry.creation = "started";
    entry.confirmedClock = CLOCK;
    entry.confirmedAt = performance.now();
    if (initializing) entry.initialization = "running";
  });
}

async function reconcile(entry: PoolStart, host: Host): Promise<PoolStart> {
  // Dynamic to break the native rpc-manager -> hub -> pool-starts adoption cycle.
  const rpc = await import("../rpc-manager");
  let live = await rpc.getRpcCreationSession(entry.creationId);
  if (!live) {
    await reconcilePooledChild(entry.hostId, entry.creationId);
    live = await rpc.getRpcCreationSession(entry.creationId);
  }
  if (!live && entry.sessionId) {
    await adoptedChild(entry.hostId, entry.sessionId);
    const session = rpc.getRpcSession(entry.sessionId);
    if (session?.isAlive()) live = { session, realSessionId: session.sessionId };
  }
  if (live) {
    if (live.session.host.id !== entry.hostId || live.session.cwd !== entry.prepared?.cwd) throw conflict();
    confirmPooledChild(entry.creationId, entry.hostId, live.session.cwd, live.realSessionId);
  } else {
    if (host.status() !== "online" || !entry.prepared) throw unknown(entry);
    const matches = (await host.sessionOps.listSessions()).filter((session) => session.cwd === entry.prepared!.cwd);
    if (matches.length !== 1 || entry.sessionId && entry.sessionId !== matches[0].id) throw unknown(entry);
    const saved = matches[0];
    confirmPooledChild(entry.creationId, entry.hostId, entry.prepared.cwd, saved.id);
    entry = update(entry.creationId, (current) => { current.initialization = "unknown"; });
    throw unknown(entry);
  }
  return readJournal().starts.find((candidate) => candidate.creationId === entry.creationId)!;
}

async function run(entry: PoolStart, start: Start, authorize?: (host: Host) => Promise<boolean>): Promise<PoolCreateResult> {
  const host = getHost(entry.hostId);
  if (!host) throw unknown(entry);
  let unlock: (() => void) | undefined;
  try {
    if (entry.creation === "preparing" && authorize && !(await authorize(host))) {
      throw new HostOpError(403, "agent_start_declined", `The user declined to start a session on ${host.label}.`);
    }
    if (entry.creation === "unknown" || entry.creation === "starting" || entry.creation === "started") {
      entry = await reconcile(entry, host);
    }
    if (entry.initialization !== "pending") throw unknown(entry);
    if (!entry.prepared) {
      const prepared = await host.sessionOps.preparePoolProject({ projectId: entry.projectId, origin: entry.origin, cloneRoot: entry.cloneRoot, creationId: entry.creationId, ...(entry.ref === undefined ? {} : { ref: entry.ref }) });
      if (!prepared.ok) throw new HostOpError(prepared.status, prepared.code, prepared.error);
      if (prepared.value.projectRoot !== entry.cloneRoot || prepared.value.cwd !== creationCwd(entry.cloneRoot, entry.creationId) || !/^[a-f0-9]{40,64}$/.test(prepared.value.baseCommit)) throw new HostOpError(502, "host_bad_result", "Worker prepared an invalid project");
      entry = update(entry.creationId, (current) => { current.prepared = prepared.value; });
    }
    // The worker reads its registry at spawn: keep a project's config update and child identity in one launch turn.
    const locks = globalThis.__ompPoolLaunchLocks ??= new Map();
    const key = `${journalPath()}\0${entry.hostId}\0${entry.cloneRoot}`;
    const previous = locks.get(key);
    const gate = Promise.withResolvers<void>();
    locks.set(key, gate.promise);
    unlock = () => { gate.resolve(); if (locks.get(key) === gate.promise) locks.delete(key); };
    await previous;
    const registered = await host.sessionOps.addProject(entry.cloneRoot, entry.launchConfig);
    if (!registered.ok) throw new HostOpError(registered.status, registered.code, registered.error);
    const configured = await host.sessionOps.updateProject([{ cwd: entry.cloneRoot, launchConfig: entry.launchConfig ?? null }]);
    if (!configured.ok) throw new HostOpError(configured.status, configured.code, configured.error);
    entry = update(entry.creationId, (current) => { current.creation = "starting"; });
    const started = await start(host, entry.prepared!, entry.creationId, async (sessionId) => {
      if (!isValidSessionId(sessionId)) throw new HostOpError(502, "host_bad_result", "Worker reported an invalid session identity");
      entry = { ...entry, sessionId };
      entry = confirmPooledChild(entry.creationId, entry.hostId, entry.prepared!.cwd, sessionId, true);
      unlock?.(); unlock = undefined;
    });
    if (!entry.sessionId || started.sessionId !== entry.sessionId) throw new HostOpError(502, "host_bad_result", "Startup did not persist its real session identity");
    entry = update(entry.creationId, (current) => { current.creation = "started"; current.initialization = "complete"; current.data = bounded(started.data); delete current.failure; });
    return { ...result(entry), ...(started.data === undefined ? {} : { data: started.data }) };
  } catch (error) {
    const refused = definite(error);
    try {
      entry = update(entry.creationId, (current) => {
        if (current.sessionId) current.initialization = refused ? "failed" : "unknown";
        else if (current.creation === "preparing" || refused) { current.creation = "refused"; current.reserved = false; }
        else current.creation = "unknown";
        current.failure = failure(error);
      });
    } catch {
      throw new PoolStartError(503, "pool_starts_unavailable", "The creation outcome could not be persisted; reconcile it on its original worker", entry, !!entry.sessionId || entry.creation === "starting" || entry.creation === "unknown");
    }
    if (!refused && (entry.creation === "unknown" || entry.sessionId)) throw unknown(entry);
    const failed = entry.failure!;
    throw new PoolStartError(failed.status, failed.code, error instanceof Error ? error.message : failed.message, entry);
  } finally { unlock?.(); }
}

/** Reserve durably before host work; trusted authorization runs before preparation and never on completed replay. */
export function startPooledSession(input: PoolCreateInput, start: Start, authorize?: (host: Host) => Promise<boolean>): Promise<PoolCreateResult> {
  try {
    if (!isRecord(input) || typeof input.creationId !== "string" || !CREATION_ID_RE.test(input.creationId)
      || typeof input.poolId !== "string" || !CREATION_ID_RE.test(input.poolId) || typeof input.projectId !== "string" || !CREATION_ID_RE.test(input.projectId)
      || (input.ref !== undefined && (typeof input.ref !== "string" || !input.ref || input.ref.startsWith("-") || /\s/.test(input.ref))) || !isRecord(input.intent)) throw new PoolStartError(400, "invalid_creation_intent", "A safe creation ID, pool, project and JSON intent are required");
    const requestFingerprint = fingerprint({ poolId: input.poolId, projectId: input.projectId, ref: input.ref ?? null, intent: input.intent });
    const journal = readJournal();
    let entry = journal.starts.find((candidate) => candidate.creationId === input.creationId);
    const key = `${journalPath()}\0${input.creationId}`;
    const inflight = globalThis.__ompPoolStarts ??= new Map();
    if (entry) {
      if (entry.requestFingerprint !== requestFingerprint) throw conflict();
      const pending = inflight.get(key);
      if (pending) return pending;
      if (entry.initialization === "complete") return Promise.resolve(result(entry));
      if (entry.initialization === "running" || entry.initialization === "unknown") {
        if (entry.initialization === "running") entry = update(entry.creationId, (current) => { current.initialization = "unknown"; });
        throw unknown(entry);
      }
      if (entry.creation === "refused" || entry.initialization === "failed") {
        const failed = entry.failure ?? { status: 409, code: "creation_refused", message: "The original creation was refused" };
        throw new PoolStartError(failed.status, failed.code, failed.message, entry);
      }
    } else {
      const pool = loadPools().find((candidate) => candidate.id === input.poolId);
      const project = pool?.projects.find((candidate) => candidate.id === input.projectId);
      if (!pool || !project) throw new PoolStartError(404, "pool_project_not_found", "Pool project not found");
      const snapshots = new Map<string, PoolHostSnapshot>();
      for (const member of pool.members) {
        const host = getHost(member.hostId);
        if (host) snapshots.set(member.hostId, { status: host.status(), linkProtocol: getHostLinkProtocol(member.hostId) ?? 0, capacity: getHostCapacity(member.hostId) });
      }
      const pending = new Map<string, number>();
      for (const current of journal.starts) {
        const capacity = snapshots.get(current.hostId)?.capacity;
        if (current.reserved && current.sessionId && current.confirmedClock === CLOCK && capacity && current.confirmedAt !== undefined && capacity.receivedAt > current.confirmedAt) current.reserved = false;
        if (current.reserved) pending.set(current.hostId, (pending.get(current.hostId) ?? 0) + 1);
      }
      const hostId = selectPoolHost(pool, snapshots, pending, performance.now());
      if (!hostId) throw new PoolStartError(503, "pool_unavailable", "No pool worker currently has eligible capacity");
      const member = pool.members.find((candidate) => candidate.hostId === hostId)!;
      const cloneRoot = project.clonePaths[hostId] ?? pathApi(member.projectsRoot).join(member.projectsRoot, project.id);
      const ref = input.ref ?? project.defaultRef;
      entry = { creationId: input.creationId, poolId: pool.id, projectId: project.id, requestFingerprint,
        fingerprint: fingerprint({ creationId: input.creationId, poolId: pool.id, projectId: project.id, hostId, requestFingerprint, origin: project.origin, cloneRoot, ref: ref ?? null, launchConfig: project.launchConfig ?? null }),
        hostId, origin: project.origin, cloneRoot, ...(ref === undefined ? {} : { ref }), ...(project.launchConfig === undefined ? {} : { launchConfig: structuredClone(project.launchConfig) }),
        creation: "preparing", initialization: "pending", reserved: true };
      journal.starts.push(entry);
      writeJournal(journal);
    }
    // Install the promise before any callback or host operation can yield back to a duplicate caller.
    const gate = Promise.withResolvers<PoolCreateResult>();
    inflight.set(key, gate.promise);
    void run(entry, start, authorize).then(gate.resolve, gate.reject).finally(() => { if (inflight.get(key) === gate.promise) inflight.delete(key); });
    return gate.promise;
  } catch (error) { return Promise.reject(error); }
}
