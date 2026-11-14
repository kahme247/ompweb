// The server updater's durable state (status, lease, per-attempt markers), shared by the server (self-update.ts) and the
// detached worker (server-update-worker.ts). Copied outside the install inside the worker bundle: node:* only, no Bun.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

/** Covers a 15 min release download plus preflight, host updates and the restart. Every phase renews it. */
export const LEASE_MS = 30 * 60 * 1000;

export type SelfUpdateState = "prepared" | "running" | "succeeded" | "failed";
export type SelfUpdateStage = "preparing" | "stopping" | "installing" | "restarting" | "finalizing";
export interface SelfUpdateStatus {
  attemptId: string;
  state: SelfUpdateState;
  stage?: SelfUpdateStage;
  fromVersion: string;
  targetVersion: string;
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  recovered?: boolean;
  error?: string;
  cleanupReady?: boolean;
}
export interface StoredStatus extends SelfUpdateStatus {
  /** The detached worker. Absent until it records itself. */
  workerPid?: number;
  /** The server process staging the release and updating hosts before the worker exists. */
  coordinatorPid?: number;
  /** Where the previous installation waits while the worker replaces it: reported when the worker is lost mid-swap. */
  retainedBackup?: string;
}
export class SelfUpdateError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
    this.name = "SelfUpdateError";
  }
}

export function resolveSelfUpdateTempRoot(
  platform: NodeJS.Platform = process.platform,
  temporary = tmpdir(),
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const suffix = platform === "win32" ? "" : `-${uid ?? "user"}`;
  return pathApi.join(temporary, `ompweb-self-update${suffix}`);
}

export const rootDir = (): string => resolveSelfUpdateTempRoot();
export const leasePath = (): string => join(rootDir(), "lease.json");
export const statusPath = (): string => join(rootDir(), "status.json");
export const markerPath = (attemptId: string, marker: string): string => join(rootDir(), `${attemptId}.${marker}`);
export const attemptPath = (attemptId: string): string => join(rootDir(), "attempts", attemptId);

export const isMissing = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
export const isBusy = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String((error as { code: string }).code)));
const isExists = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EEXIST");

function ownedByCurrentUser(info: Stats): boolean {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}
export function secureDirectory(path: string): Stats {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info)) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update state path is unsafe", 500);
  }
  return info;
}
export function secureRegularFile(path: string): Stats | null {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownedByCurrentUser(info)) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update state contains an unsafe file", 500);
  }
  return info;
}
export function atomicWrite(path: string, value: string): void {
  secureDirectory(dirname(path));
  secureRegularFile(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
export function readStateJson<T>(path: string): T | null {
  if (!secureRegularFile(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
export function removeSecureFile(path: string): boolean {
  if (!secureRegularFile(path)) return true;
  try {
    rmSync(path);
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
}
export function removeSecureEmptyDirectory(path: string): boolean {
  try {
    secureDirectory(path);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    if (isMissing(error)) return true;
    throw error;
  }
}
function mkdirOwner(path: string, recursive = false): void {
  try {
    mkdirSync(path, { mode: 0o700, recursive });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
}
export function ensureSecureRoot(create: boolean): string | null {
  const root = rootDir();
  if (!existsSync(root)) {
    if (!create) return null;
    mkdirOwner(root, true);
  }
  secureDirectory(root);
  try {
    chmodSync(root, 0o700);
  } catch {
    // Windows
  }
  return root;
}
export function attemptsDir(create: boolean): string | null {
  const root = ensureSecureRoot(create);
  if (!root) return null;
  const attempts = join(root, "attempts");
  if (!existsSync(attempts)) {
    if (!create) return null;
    mkdirOwner(attempts);
  }
  secureDirectory(attempts);
  return attempts;
}

export function isActiveLease(lease: { expiresAt?: unknown } | null, now = Date.now()): boolean {
  if (!lease || typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt)) return false;
  // Reject absurd future timestamps (tampered lease): allow at most LEASE_MS + 5m skew.
  if (lease.expiresAt > now + LEASE_MS + 5 * 60 * 1000) return false;
  return lease.expiresAt > now;
}
/** Gives the attempt a full lease from now: a phase that is still making progress is never reported lost. Another attempt's lease is never taken over. */
export function renewLease(attemptId: string): void {
  const lease = readStateJson<Record<string, unknown>>(leasePath());
  if (lease?.attemptId === attemptId) atomicWrite(leasePath(), JSON.stringify({ ...lease, expiresAt: Date.now() + LEASE_MS }));
}
/** Merges `patch` into the stored status of `attemptId` (an `undefined` value removes a field). Null when another attempt owns the status. */
export function patchStatus(attemptId: string, patch: { [K in keyof StoredStatus]?: StoredStatus[K] | undefined }): StoredStatus | null {
  const current = readStateJson<StoredStatus>(statusPath());
  if (current?.attemptId !== attemptId) return null;
  const next: Record<string, unknown> = { ...current, ...patch };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  atomicWrite(statusPath(), JSON.stringify(next));
  return next as unknown as StoredStatus;
}
