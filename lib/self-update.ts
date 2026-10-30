import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type Stats,
} from "fs";
import { execFile, spawn } from "child_process";
import { createChildProcessEnvironment } from "./project-command-env";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { dirname, join, posix, resolve, win32 } from "path";
import { promisify } from "util";
import { checkNpmUpdate, detectInstallMethod } from "./npm-update";
import { checkOmpUpdate } from "./omp/updates";
import { DISABLE_AUTOUPDATE_ENV_VAR, isUpdateDisabled } from "./update-policy";

const LEASE_MS = 30 * 60 * 1000;
const TERMINAL_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

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
interface StoredStatus extends SelfUpdateStatus {
  workerPid?: number;
  managerPid?: number;
}
export interface PrepareResult {
  attemptId: string;
  targetVersion: string;
}
export class SelfUpdateError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
    this.name = "SelfUpdateError";
  }
}

type Kind = "app" | "omp";

function assertUpdatesEnabled(): void {
  if (!isUpdateDisabled()) return;
  throw new SelfUpdateError("updates_disabled", `Updates are disabled by ${DISABLE_AUTOUPDATE_ENV_VAR}`, 403);
}

export function resolveSelfUpdateTempRoot(
  kind: Kind = "app",
  platform: NodeJS.Platform = process.platform,
  temporary = tmpdir(),
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const suffix = platform === "win32" ? "" : `-${uid ?? "user"}`;
  const base = kind === "omp" ? "omp-self-update" : "ompweb-self-update";
  return pathApi.join(temporary, `${base}${suffix}`);
}

function rootDir(kind: Kind = "app"): string {
  return resolveSelfUpdateTempRoot(kind);
}
function leasePath(kind: Kind = "app"): string {
  return join(rootDir(kind), "lease.json");
}
function statusPath(kind: Kind = "app"): string {
  return join(rootDir(kind), "status.json");
}
function markerPath(attemptId: string, marker: string, kind: Kind = "app"): string {
  return join(rootDir(kind), `${attemptId}.${marker}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}
function isBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String((error as { code: string }).code)));
}
function ownedByCurrentUser(info: Stats): boolean {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}
function secureDirectory(path: string): Stats {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info)) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update state path is unsafe", 500);
  }
  return info;
}
function secureRegularFile(path: string): Stats | null {
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
function atomicWrite(path: string, value: string): void {
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
function readStateJson<T>(path: string): T | null {
  if (!secureRegularFile(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
function ensureSecureRoot(kind: Kind, create: boolean): string | null {
  const root = rootDir(kind);
  if (!existsSync(root)) {
    if (!create) return null;
    try {
      mkdirSync(root, { mode: 0o700, recursive: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EEXIST")) throw error;
    }
  }
  secureDirectory(root);
  try {
    chmodSync(root, 0o700);
  } catch {
    // Windows
  }
  return root;
}
function attemptsDir(kind: Kind, create: boolean): string | null {
  const root = ensureSecureRoot(kind, create);
  if (!root) return null;
  const attempts = join(root, "attempts");
  if (!existsSync(attempts)) {
    if (!create) return null;
    try {
      mkdirSync(attempts, { mode: 0o700 });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EEXIST")) throw error;
    }
  }
  secureDirectory(attempts);
  return attempts;
}
function isActiveLease(lease: { expiresAt?: unknown } | null, now = Date.now()): boolean {
  if (!lease || typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt)) return false;
  // Reject absurd future timestamps (tampered lease) — allow at most LEASE_MS + 5m skew.
  if (lease.expiresAt > now + LEASE_MS + 5 * 60 * 1000) return false;
  return lease.expiresAt > now;
}
function isTerminalStatus(status: SelfUpdateStatus | null | undefined): boolean {
  return status?.state === "succeeded" || status?.state === "failed";
}
function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}
function removeSecureFile(path: string): boolean {
  if (!secureRegularFile(path)) return true;
  try {
    rmSync(path);
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
}
function removeSecureEmptyDirectory(path: string): boolean {
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
function removeAttemptDirectory(attemptId: string, kind: Kind): boolean {
  const attempts = attemptsDir(kind, false);
  if (!attempts) return true;
  const dir = join(attempts, attemptId);
  try {
    secureDirectory(dir);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  const entries = readdirSync(dir);
  if (entries.some((e) => e !== "worker.js")) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update attempt contains unexpected files", 500);
  }
  if (entries.includes("worker.js") && !removeSecureFile(join(dir, "worker.js"))) return false;
  return removeSecureEmptyDirectory(dir);
}
function removeAttemptArtifacts(attemptId: string, kind: Kind, includeCompletionAck = true): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return false;
  if (!removeAttemptDirectory(attemptId, kind)) return false;
  const suffixes = ["ready", "go", "abort.json", "armed.json", "restart-request.json", "restart-ack.json", "complete.json"];
  if (includeCompletionAck) suffixes.push("complete-ack.json");
  for (const s of suffixes) {
    if (!removeSecureFile(markerPath(attemptId, s, kind))) return false;
  }
  return true;
}
function pruneEmptyRoot(kind: Kind): void {
  const attempts = attemptsDir(kind, false);
  if (attempts) removeSecureEmptyDirectory(attempts);
  const root = ensureSecureRoot(kind, false);
  if (root) removeSecureEmptyDirectory(root);
}
export function cleanupStaleSelfUpdate(now = Date.now(), kind: Kind = "app"): void {
  if (!ensureSecureRoot(kind, false)) return;
  const status = readStateJson<StoredStatus>(statusPath(kind));
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath(kind));
  if (lease && !isActiveLease(lease, now)) {
    removeSecureFile(leasePath(kind));
  }
  if (!status || typeof status.attemptId !== "string") {
    pruneEmptyRoot(kind);
    return;
  }
  const timestamp = Date.parse(status.finishedAt ?? status.preparedAt);
  const currentLease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath(kind));
  const leaseStillActive = isActiveLease(currentLease, now);
  if (
    Number.isFinite(timestamp) &&
    now - timestamp >= TERMINAL_STATUS_TTL_MS &&
    !leaseStillActive &&
    (isTerminalStatus(status) || !currentLease) &&
    !isProcessAlive(status.workerPid) &&
    !isProcessAlive(status.managerPid) &&
    removeAttemptArtifacts(status.attemptId, kind)
  ) {
    removeSecureFile(statusPath(kind));
  }
  pruneEmptyRoot(kind);
}

const WORKER_LOST_ERROR = "The update worker stopped before the update finished";

function isWorkerLost(status: StoredStatus, kind: Kind): boolean {
  if (status.state !== "running") return false;
  // The worker never outlives its lease, and a reused pid cannot keep an expired one alive.
  if (!isActiveLease(readStateJson<{ expiresAt?: unknown }>(leasePath(kind)))) return true;
  return status.workerPid !== undefined && !isProcessAlive(status.workerPid);
}

export function getSelfUpdateStatus(kind: Kind = "app"): SelfUpdateStatus | null {
  const s = readStateJson<StoredStatus>(statusPath(kind));
  if (!s) return null;
  // minimal validation
  if (typeof s.attemptId !== "string" || typeof s.state !== "string") return null;
  if (!isWorkerLost(s, kind)) return s;
  // Re-read: the worker may have written its result just before it exited.
  const latest = readStateJson<StoredStatus>(statusPath(kind));
  if (latest?.attemptId !== s.attemptId || latest.state !== "running") return latest;
  const failed: StoredStatus = { ...latest, state: "failed", error: WORKER_LOST_ERROR, finishedAt: new Date().toISOString(), cleanupReady: true };
  // A read must not fail over the write; the next poll retries it.
  try {
    atomicWrite(statusPath(kind), JSON.stringify(failed));
  } catch {}
  return failed;
}

export interface SystemdService {
  unit: string;
  user: boolean;
}

/** The systemd service named by `/proc/<pid>/cgroup` content, or null outside one. */
export function parseSystemdServiceCgroup(cgroup: string): SystemdService | null {
  for (const line of cgroup.split("\n")) {
    if (!line.startsWith("0::") && !line.includes(":name=systemd:")) continue;
    const segments = line.split(":").slice(2).join(":").trim().split("/");
    const unit = segments.at(-1);
    if (unit?.endsWith(".service")) {
      return { unit, user: segments.some((segment) => /^user@\d+\.service$/.test(segment)) };
    }
  }
  return null;
}

function commandError(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return (typeof stderr === "string" && stderr.trim()) || (error instanceof Error ? error.message : String(error));
}

async function detectSystemdService(launcherPid: number): Promise<SystemdService | null> {
  if (process.platform !== "linux") return null;
  let service: SystemdService | null;
  try {
    service = parseSystemdServiceCgroup(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
  if (!service) return null;
  // Only the unit this launcher is the main process of: a dev server started
  // from a session inside another unit must never stop that unit.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("systemctl", [...(service.user ? ["--user"] : []), "show", "--property=MainPID", "--value", service.unit], { encoding: "utf8", timeout: 5000 }));
  } catch (error) {
    // Guessing "not systemd" would start a worker the unit's stop kills.
    throw new Error(`Cannot check systemd unit ${service.unit}: ${commandError(error)}`);
  }
  return Number(stdout.trim()) === launcherPid ? service : null;
}
export function getSelfUpdateSupport(): { supported: boolean; reason?: string; packageDir: string } {
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? resolve(join(import.meta ? dirname(new URL(import.meta.url).pathname) : process.cwd(), ".."));
  if (isUpdateDisabled()) {
    return { supported: false, reason: `Updates are disabled by ${DISABLE_AUTOUPDATE_ENV_VAR}`, packageDir };
  }
  if (Bun.isStandaloneExecutable) return { supported: false, reason: "The ompweb binary updates by download", packageDir };
  // simplified: always supported if packageDir exists
  try {
    if (!existsSync(packageDir)) return { supported: false, reason: "package dir not found", packageDir };
    return { supported: true, packageDir: resolve(packageDir) };
  } catch {
    return { supported: false, reason: "unsupported", packageDir };
  }
}

function detectManager(packageDir: string): { manager: "npm" | "bun"; managerPath: string; prefix: string[] } {
  const manager = detectInstallMethod(packageDir);
  const managerPath = manager === "bun" ? "bun" : "npm";
  return { manager, managerPath, prefix: [] };
}

export async function prepareSelfUpdate(kind: Kind = "app"): Promise<PrepareResult> {
  assertUpdatesEnabled();
  // The compiled binary has no npm install to replace and no runtime for the worker: its updates run from a terminal.
  if (Bun.isStandaloneExecutable) {
    throw new SelfUpdateError("self_update_unsupported", "In-app updates are not available in the ompweb binary: update from a terminal", 409);
  }
  cleanupStaleSelfUpdate(Date.now(), kind);
  ensureSecureRoot(kind, true);
  const leaseFile = leasePath(kind);
  const statusFile = statusPath(kind);
  const existingLease = readStateJson<{ attemptId?: string; expiresAt?: number }>(leaseFile);
  if (isActiveLease(existingLease)) {
    throw new SelfUpdateError("update_in_progress", "Another update is already in progress", 409);
  }
  let currentVersion: string;
  let targetVersion: string;
  if (kind === "omp") {
    const ompStatus = await checkOmpUpdate(true);
    if (!ompStatus.updateAvailable || !ompStatus.availableVersion) {
      throw new SelfUpdateError("no_update_available", "No OMP update available", 409);
    }
    currentVersion = ompStatus.currentVersion ?? "unknown";
    targetVersion = ompStatus.availableVersion;
  } else {
    const npmStatus = await checkNpmUpdate(true);
    if (!npmStatus.updateAvailable || !npmStatus.availableVersion) {
      throw new SelfUpdateError("no_update_available", "No update available", 409);
    }
    currentVersion = npmStatus.currentVersion;
    targetVersion = npmStatus.availableVersion;
  }
  const attemptId = randomUUID();
  const preparedAt = new Date().toISOString();
  // write lease
  const lease = { attemptId, kind, expiresAt: Date.now() + LEASE_MS, preparedAt };
  atomicWrite(leaseFile, JSON.stringify(lease));
  const stored: StoredStatus = {
    attemptId,
    state: "prepared",
    fromVersion: currentVersion,
    targetVersion,
    preparedAt,
  };
  atomicWrite(statusFile, JSON.stringify(stored));
  // copy worker
  const attempts = attemptsDir(kind, true)!;
  const attemptDir = join(attempts, attemptId);
  mkdirSync(attemptDir, { mode: 0o700, recursive: true });
  secureDirectory(attemptDir);
  const srcWorker = resolve(join(dirname(new URL(import.meta.url).pathname), "..", "bin", "omp-web-update-worker.js"));
  // fallback to CWD relative
  let workerSrc = srcWorker;
  if (!existsSync(workerSrc)) {
    workerSrc = resolve(join(process.cwd(), "bin", "omp-web-update-worker.js"));
  }
  const destWorker = join(attemptDir, "worker.js");
  if (existsSync(workerSrc)) {
    copyFileSync(workerSrc, destWorker);
    try {
      chmodSync(destWorker, 0o600);
    } catch {}
  }
  // write ready marker
  atomicWrite(markerPath(attemptId, "ready", kind), JSON.stringify({ attemptId, preparedAt }));
  return { attemptId, targetVersion };
}

export function validateCommitSelfUpdate(attemptId: string, kind: Kind = "app"): "ready" | "replay" {
  assertUpdatesEnabled();
  const status = readStateJson<StoredStatus>(statusPath(kind));
  if (!status || status.attemptId !== attemptId) throw new SelfUpdateError("attempt_not_found", "Update attempt not found", 404);
  if (status.state === "running") return "replay";
  if (status.state !== "prepared") throw new SelfUpdateError("invalid_state", "Update attempt is not prepared", 409);
  const lease = readStateJson<{ attemptId?: string; expiresAt?: unknown }>(leasePath(kind));
  if (!lease || lease.attemptId !== attemptId) throw new SelfUpdateError("lease_mismatch", "Lease mismatch", 409);
  if (!isActiveLease(lease)) throw new SelfUpdateError("lease_expired", "Update attempt expired; prepare it again", 409);
  if (!existsSync(markerPath(attemptId, "ready", kind))) throw new SelfUpdateError("not_ready", "Update attempt not ready", 409);
  return "ready";
}
export function markSelfUpdateStopping(attemptId: string, kind: Kind = "app"): void {
  const status = readStateJson<StoredStatus>(statusPath(kind));
  if (!status || status.attemptId !== attemptId) return;
  // The worker gets a full lease from here: a running attempt past it counts as lost.
  const lease = readStateJson<Record<string, unknown>>(leasePath(kind));
  // Never take over another attempt's lease.
  if (lease?.attemptId === attemptId) {
    atomicWrite(leasePath(kind), JSON.stringify({ ...lease, expiresAt: Date.now() + LEASE_MS }));
  }
  const next: StoredStatus = { ...status, state: "running", stage: "stopping", startedAt: new Date().toISOString() };
  atomicWrite(statusPath(kind), JSON.stringify(next));
}

export async function armSelfUpdateLauncher(attemptId: string, kind: Kind = "app"): Promise<void> {
  const armed = markerPath(attemptId, "armed.json", kind);
  atomicWrite(armed, JSON.stringify({ attemptId, armedAt: new Date().toISOString(), protocol: 1 }));
  // settle
  await new Promise<void>((r) => setTimeout(r, 500));
}

export async function commitSelfUpdate(attemptId: string, kind: Kind = "app"): Promise<{ accepted: true; attemptId: string }> {
  assertUpdatesEnabled();
  const status = readStateJson<StoredStatus>(statusPath(kind));
  if (!status || status.attemptId !== attemptId) throw new SelfUpdateError("attempt_not_found", "Update attempt not found", 404);
  // write go marker
  atomicWrite(markerPath(attemptId, "go", kind), JSON.stringify({ attemptId, committedAt: new Date().toISOString(), protocol: 1 }));
  // update status to running if not already
  if (status.state === "prepared") {
    const next: StoredStatus = { ...status, state: "running", stage: "preparing", startedAt: new Date().toISOString() };
    atomicWrite(statusPath(kind), JSON.stringify(next));
  }
  // spawn worker detached
  const attempts = attemptsDir(kind, false);
  const workerPath = attempts ? join(attempts, attemptId, "worker.js") : null;
  const root = rootDir(kind);
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const { manager, managerPath, prefix } = detectManager(packageDir);
  const fromVersion = status.fromVersion;
  const targetVersion = status.targetVersion;
  const launcherPid = Number(process.env.OMP_WEB_LAUNCHER_PID ?? process.pid);
  const descriptor = {
    launcherPath: join(resolve(packageDir), "bin", "omp-web.js"),
    hostname: process.env.OMP_WEB_HOSTNAME ?? process.env.HOSTNAME ?? "127.0.0.1",
    port: Number(process.env.OMP_WEB_PORT ?? process.env.PORT ?? 30178),
  };
  const args = [
    workerPath ?? "",
    "--attempt",
    attemptId,
    "--root",
    root,
    "--package-dir",
    resolve(packageDir),
    "--manager",
    manager,
    "--manager-path",
    managerPath,
    "--target",
    targetVersion,
    "--from",
    fromVersion,
    "--launcher-pid",
    String(launcherPid),
    "--server-pid",
    String(process.pid),
    JSON.stringify(descriptor),
    "--manager-prefix",
    JSON.stringify(prefix),
    "--kind",
    kind,
  ];
  try {
    const systemd = kind === "app" ? await detectSystemdService(launcherPid) : null;
    if (systemd) args.push("--systemd-unit", systemd.unit, "--systemd-user", systemd.user ? "1" : "0");
    const workerArgs = workerPath ? [workerPath, ...args] : args;
    // Windows locks a running bun.exe, and npm replaces the package's: the worker runs on the launcher's Node.
    const runtime = process.env.OMP_WEB_NODE_BIN || process.execPath;
    let command = runtime;
    let commandArgs = workerArgs;
    if (systemd) {
      // A worker left in the unit's cgroup is killed with the server it stops,
      // so it runs in its own transient scope.
      const systemdRun = [...(systemd.user ? ["--user"] : []), "--scope", "--quiet", "--collect", "--no-ask-password"];
      // The detached worker's own failure would be invisible; fail here instead
      // (e.g. a non-root system service, which polkit refuses).
      try {
        await execFileAsync("systemd-run", [...systemdRun, "true"], { encoding: "utf8", timeout: 10000 });
      } catch (error) {
        throw new Error(`systemd-run cannot start the update worker: ${commandError(error)}`);
      }
      command = "systemd-run";
      commandArgs = [...systemdRun, runtime, ...workerArgs];
    }
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // The worker and everything it runs inherit this environment, so the web
      // password hash must not be in it (issue #239).
      env: createChildProcessEnvironment(),
    });
    // A failed launch arrives as an event, after this function returned.
    child.once("error", (error) => {
      const current = readStateJson<StoredStatus>(statusPath(kind));
      if (current?.attemptId !== attemptId || current.state !== "running") return;
      try {
        atomicWrite(statusPath(kind), JSON.stringify({ ...current, state: "failed", error: error.message.slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true }));
      } catch {}
    });
    child.unref();
    // record worker pid
    const updated: StoredStatus = { ...readStateJson<StoredStatus>(statusPath(kind))!, workerPid: child.pid };
    try {
      atomicWrite(statusPath(kind), JSON.stringify(updated));
    } catch {}
  } catch (error) {
    const failed: StoredStatus = { ...status, state: "failed", error: error instanceof Error ? error.message.slice(0, 240) : String(error), finishedAt: new Date().toISOString(), cleanupReady: true };
    try {
      atomicWrite(statusPath(kind), JSON.stringify(failed));
    } catch {}
    throw new SelfUpdateError("spawn_failed", "Failed to spawn update worker", 500);
  }
  return { accepted: true, attemptId };
}

export async function abortPreparedSelfUpdate(attemptId: string, reason: string, kind: Kind = "app"): Promise<void> {
  try {
    atomicWrite(markerPath(attemptId, "abort.json", kind), JSON.stringify({ attemptId, reason, protocol: 1 }));
  } catch {}
  const status = readStateJson<StoredStatus>(statusPath(kind));
  if (status && status.attemptId === attemptId && status.state === "prepared") {
    const next: StoredStatus = { ...status, state: "failed", error: reason.slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true };
    try {
      atomicWrite(statusPath(kind), JSON.stringify(next));
    } catch {}
  }
}

export function acknowledgeSelfUpdate(attemptId: string, kind: Kind = "app"): { acknowledged: true; attemptId: string } {
  if (!ensureSecureRoot(kind, false)) throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  const status = readStateJson<StoredStatus>(statusPath(kind));
  if (status?.attemptId !== attemptId || (status.state !== "succeeded" && status.state !== "failed")) {
    throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  }
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath(kind));
  if (isProcessAlive(status.workerPid) || isProcessAlive(status.managerPid) || (lease && (lease as { attemptId?: string }).attemptId !== attemptId)) {
    throw new SelfUpdateError("cleanup_not_ready", "The update is still finishing cleanup", 409);
  }
  // remove artifacts
  removeAttemptArtifacts(attemptId, kind);
  // release lease
  if (lease && (lease as { attemptId?: string }).attemptId === attemptId) {
    removeSecureFile(leasePath(kind));
  }
  removeSecureFile(statusPath(kind));
  pruneEmptyRoot(kind);
  return { acknowledged: true, attemptId };
}
