import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type Stats,
} from "fs";
import { execFileSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { homedir, tmpdir } from "os";
import { delimiter, dirname, isAbsolute, join, normalize, posix, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { isNewerVersion } from "./npm-update";

export const SELF_UPDATE_PACKAGE = "@kahme247/ompweb";
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(SELF_UPDATE_PACKAGE)}/latest`;
const LEASE_MS = 30 * 60 * 1000;
const PREPARE_READY_MS = 5_000;
const PREPARED_ABORT_MS = 15_000;
const STATUS_MAX_ERROR = 240;
const TERMINAL_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_PROTOCOL = 1;
const UPDATE_MESSAGE = "ompweb:update-control";
const UPDATE_ACK = "ompweb:update-control-ack";
const IPC_TIMEOUT_MS = 5_000;
const ARM_MARKER_SETTLE_MS = 500;
let cachedSupport: { packageDir: string; result: InstallOwnership } | undefined;

type Manager = "npm" | "bun";
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
interface StoredSelfUpdateStatus extends SelfUpdateStatus {
  workerPid?: number;
  managerPid?: number;
}
export interface PrepareResult {
  attemptId: string;
  targetVersion: string;
}
export interface InstallOwnership {
  supported: boolean;
  reason?: string;
  packageDir: string;
  manager?: Manager;
  managerPath?: string;
  managerPrefix?: string[];
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

function rootDir(): string {
  return resolveSelfUpdateTempRoot();
}
function leasePath(): string { return join(rootDir(), "lease.json"); }
function statusPath(): string { return join(rootDir(), "status.json"); }
function markerPath(attemptId: string, marker: "ready" | "go" | "abort.json" | "armed.json"): string {
  return join(rootDir(), `${attemptId}.${marker}`);
}
function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function isBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String(error.code)));
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
  try { info = lstatSync(path); }
  catch (error) {
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
function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
function readStateJson<T>(path: string): T | null {
  if (!secureRegularFile(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function ensureSecureRoot(create: boolean): string | null {
  const root = rootDir();
  if (!existsSync(root)) {
    if (!create) return null;
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  secureDirectory(root);
  try { chmodSync(root, 0o700); } catch { /* Windows */ }
  return root;
}
function attemptsDirectory(create: boolean): string | null {
  const root = ensureSecureRoot(create);
  if (!root) return null;
  const attempts = join(root, "attempts");
  if (!existsSync(attempts)) {
    if (!create) return null;
    try { mkdirSync(attempts, { mode: 0o700 }); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  secureDirectory(attempts);
  return attempts;
}

function isTerminalStatus(status: SelfUpdateStatus | null | undefined): boolean {
  return status?.state === "succeeded" || status?.state === "failed";
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
  try { secureDirectory(path); }
  catch (error) {
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
function removeAttemptDirectory(attemptId: string): boolean {
  const attempts = attemptsDirectory(false);
  if (!attempts) return true;
  const directory = join(attempts, attemptId);
  try { secureDirectory(directory); }
  catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  const entries = readdirSync(directory);
  if (entries.some((entry) => entry !== "worker.js")) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update attempt contains unexpected files", 500);
  }
  if (entries.includes("worker.js") && !removeSecureFile(join(directory, "worker.js"))) return false;
  return removeSecureEmptyDirectory(directory);
}
function removeAttemptArtifacts(attemptId: string, includeCompletionAck = true): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return false;
  if (!removeAttemptDirectory(attemptId)) return false;
  const suffixes = ["ready", "go", "abort.json", "armed.json", "restart-request.json", "restart-ack.json", "complete.json"];
  if (includeCompletionAck) suffixes.push("complete-ack.json");
  for (const suffix of suffixes) {
    if (!removeSecureFile(join(rootDir(), `${attemptId}.${suffix}`))) return false;
  }
  return true;
}

function pruneEmptyRoot(): void {
  const attempts = attemptsDirectory(false);
  if (attempts) removeSecureEmptyDirectory(attempts);
  const root = ensureSecureRoot(false);
  if (root) removeSecureEmptyDirectory(root);
}

export function cleanupStaleSelfUpdate(now = Date.now()): void {
  if (!ensureSecureRoot(false)) return;
  let status = readStateJson<StoredSelfUpdateStatus>(statusPath());
  status = cleanupDeadPreparedAttempt(status, now) ?? status;
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  const matchingPreparedWithoutWorker = Boolean(status
    && status.state === "prepared"
    && lease?.attemptId === status.attemptId
    && !Number.isInteger(status.workerPid));
  const awaitingLauncherAck = Boolean(status
    && isTerminalStatus(status)
    && status.startedAt
    && isAttemptArmed(status.attemptId)
    && !hasLauncherOwnershipSettled(status.attemptId));
  if (lease
    && !isActiveLease(lease, now)
    && !hasMatchingRecordedLiveOwner(status, lease)
    && !matchingPreparedWithoutWorker
    && !awaitingLauncherAck) {
    removeSecureFile(leasePath());
  }
  if (!status || typeof status.attemptId !== "string") {
    pruneEmptyRoot();
    return;
  }
  const timestamp = Date.parse(status.finishedAt ?? status.preparedAt);
  const currentLease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  const leaseStillActive = isActiveLease(currentLease, now);
  if (Number.isFinite(timestamp)
    && now - timestamp >= TERMINAL_STATUS_TTL_MS
    && !leaseStillActive
    && !awaitingLauncherAck
    && (isTerminalStatus(status) || !currentLease)
    && !isProcessAlive(status.workerPid)
    && !isProcessAlive(status.managerPid)
    && removeAttemptArtifacts(status.attemptId)) {
    removeSecureFile(statusPath());
  }
  pruneEmptyRoot();
}

export function acknowledgeSelfUpdate(attemptId: string): { acknowledged: true; attemptId: string } {
  if (!ensureSecureRoot(false)) {
    throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  }
  finalizeTerminalCleanup();
  const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
  if (status?.attemptId !== attemptId || !isTerminalStatus(status)) {
    throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  }
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (status.cleanupReady !== true
    || isProcessAlive(status.workerPid)
    || isProcessAlive(status.managerPid)
    || isActiveLease(lease)
    || (lease && lease.attemptId !== attemptId)) {
    throw new SelfUpdateError("cleanup_not_ready", "The update is still finishing cleanup", 409);
  }
  if (!removeAttemptArtifacts(attemptId)
    || !releaseLease(attemptId)
    || !removeSecureFile(statusPath())) {
    throw new SelfUpdateError("cleanup_not_ready", "The update is still finishing cleanup", 409);
  }
  pruneEmptyRoot();
  return { acknowledged: true, attemptId };
}
function safeVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
}
function packageDirFromEnv(): string {
  const value = process.env.OMP_WEB_PACKAGE_DIR;
  if (!value || !isAbsolute(value)) throw new SelfUpdateError("unsupported_install", "The running app is not a supported global installation");
  return resolve(value);
}
function commandPath(command: string): string | undefined {
  const ext = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of ext) {
      const candidate = join(dir, `${command}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
function commandOutput(command: string, args: string[], prefix: string[] = []): string | null {
  try {
    return execFileSync(command, [...prefix, ...args], { encoding: "utf8", timeout: 4_000, windowsHide: true }).trim() || null;
  } catch { return null; }
}
function npmInvocation(npmPath: string): { command: string; prefix: string[] } {
  if (!npmPath.toLowerCase().endsWith(".cmd") && !npmPath.toLowerCase().endsWith(".bat")) {
    return { command: npmPath, prefix: [] };
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(npmPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  if (cli) return { command: process.execPath, prefix: [cli] };
  throw new SelfUpdateError("npm_unavailable", "The npm installation cannot be invoked safely");
}
function samePath(a: string, b: string): boolean {
  const normalizePath = (value: string) => {
    const result = normalize(value).replaceAll("\\", sep);
    return process.platform === "win32" ? result.toLowerCase().replace(/[\\/]$/, "") : result.replace(/[\\/]$/, "");
  };
  return normalizePath(a) === normalizePath(b);
}
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}
function packageCandidate(root: string): string {
  return join(root, ...SELF_UPDATE_PACKAGE.split("/"));
}
function detectManagerOwnership(packageDir: string, manager: Manager, managerPath: string): InstallOwnership | null {
  const candidates: string[] = [];
  let command = managerPath;
  let prefix: string[] = [];
  if (manager === "npm") {
    const invocation = npmInvocation(managerPath);
    command = invocation.command;
    prefix = invocation.prefix;
    const root = commandOutput(command, ["root", "-g"], prefix);
    if (root) candidates.push(packageCandidate(root));
  } else {
    const binRoot = commandOutput(command, ["pm", "bin", "-g"], prefix);
    if (binRoot) {
      const cleaned = binRoot.replace(/[\\/]$/, "");
      candidates.push(join(dirname(cleaned), "node_modules", ...SELF_UPDATE_PACKAGE.split("/")));
      candidates.push(join(dirname(cleaned), "install", "global", "node_modules", ...SELF_UPDATE_PACKAGE.split("/")));
    }
    const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
    candidates.push(join(home, "node_modules", ...SELF_UPDATE_PACKAGE.split("/")));
    candidates.push(join(home, ".bun", "install", "global", "node_modules", ...SELF_UPDATE_PACKAGE.split("/")));
  }
  const actual = canonical(packageDir);
  if (!samePath(actual, resolve(packageDir))) return null;
  if (!candidates.some((candidate) => samePath(actual, canonical(candidate)))) return null;
  const manifest = readJson<{ name?: unknown; version?: unknown }>(join(packageDir, "package.json"));
  if (manifest?.name !== SELF_UPDATE_PACKAGE || !safeVersion(manifest.version)) return null;
  return { supported: true, packageDir, manager, managerPath: command, managerPrefix: prefix };
}

/** Strictly identify a package manager's global package directory. */
export function detectGlobalInstall(packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? ""): InstallOwnership {
  if (!packageDir || !isAbsolute(packageDir)) return { supported: false, reason: "source_install", packageDir };
  const npm = commandPath("npm");
  if (npm) {
    const ownership = detectManagerOwnership(packageDir, "npm", npm);
    if (ownership) return ownership;
  }
  const bun = commandPath("bun");
  if (bun) {
    const ownership = detectManagerOwnership(packageDir, "bun", bun);
    if (ownership) return ownership;
  }
  return { supported: false, reason: "not_global_install", packageDir };
}

function parseDescriptor(): Record<string, unknown> {
  const raw = process.env.OMP_WEB_RESTART_DESCRIPTOR;
  if (!raw) throw new SelfUpdateError("restart_descriptor_missing", "The running app did not provide a restart descriptor");
  try {
    const descriptor = JSON.parse(raw) as Record<string, unknown>;
    if (typeof descriptor.launcherPath !== "string" || !isAbsolute(descriptor.launcherPath)) throw new Error();
    if (typeof descriptor.hostname !== "string" || typeof descriptor.port !== "string") throw new Error();
    return descriptor;
  } catch {
    throw new SelfUpdateError("restart_descriptor_invalid", "The running app restart configuration is invalid");
  }
}

function currentVersion(packageDir: string): string {
  const value = safeVersion(readJson<{ version?: unknown }>(join(packageDir, "package.json"))?.version);
  if (!value) throw new SelfUpdateError("invalid_install", "The installed application version is invalid");
  return value;
}
async function latestVersion(): Promise<string> {
  try {
    const response = await fetch(REGISTRY_URL, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error();
    const version = safeVersion((await response.json() as { version?: unknown }).version);
    if (!version) throw new Error();
    return version;
  } catch {
    throw new SelfUpdateError("registry_unavailable", "The package registry could not be reached", 503);
  }
}
function isActiveLease(
  lease: { attemptId?: unknown; expiresAt?: unknown } | null,
  now = Date.now(),
): lease is { attemptId: string; expiresAt: number } {
  return typeof lease?.attemptId === "string" && typeof lease.expiresAt === "number" && lease.expiresAt > now;
}
function readStatus(): SelfUpdateStatus | undefined {
  const status = readStateJson<SelfUpdateStatus & { stage?: unknown }>(statusPath());
  const states: SelfUpdateState[] = ["prepared", "running", "succeeded", "failed"];
  const stages: SelfUpdateStage[] = ["preparing", "stopping", "installing", "restarting", "finalizing"];
  if (!status
    || !/^[0-9a-f-]{36}$/i.test(status.attemptId)
    || !states.includes(status.state)) return undefined;
  const sanitized: SelfUpdateStatus = {
    attemptId: status.attemptId,
    state: status.state,
    fromVersion: safeVersion(status.fromVersion) ?? "unknown",
    targetVersion: safeVersion(status.targetVersion) ?? "unknown",
    preparedAt: typeof status.preparedAt === "string" ? status.preparedAt : "",
  };
  if (stages.includes(status.stage as SelfUpdateStage)) sanitized.stage = status.stage as SelfUpdateStage;
  if (typeof status.startedAt === "string") sanitized.startedAt = status.startedAt;
  if (typeof status.finishedAt === "string") sanitized.finishedAt = status.finishedAt;
  if (typeof status.recovered === "boolean") sanitized.recovered = status.recovered;
  if (typeof status.cleanupReady === "boolean") sanitized.cleanupReady = status.cleanupReady;
  if (typeof status.error === "string") sanitized.error = status.error.slice(0, STATUS_MAX_ERROR).replace(/[\r\n]/g, " ");
  return sanitized;
}
function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
async function waitForProcessExit(pid: unknown, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !isProcessAlive(pid);
}
function attemptHelperExists(attemptId: string): boolean {
  const attempts = attemptsDirectory(false);
  if (!attempts) return false;
  const directory = join(attempts, attemptId);
  try { secureDirectory(directory); }
  catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const entries = readdirSync(directory);
  if (entries.some((entry) => entry !== "worker.js")) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update attempt contains unexpected files", 500);
  }
  return entries.includes("worker.js") && Boolean(secureRegularFile(join(directory, "worker.js")));
}
function hasMatchingLiveHelper(
  status: StoredSelfUpdateStatus | null,
  lease: { attemptId?: unknown } | null,
): boolean {
  return Boolean(status
    && /^[0-9a-f-]{36}$/i.test(status.attemptId)
    && lease?.attemptId === status.attemptId
    && isProcessAlive(status.workerPid)
    && attemptHelperExists(status.attemptId));
}
function hasMatchingRecordedLiveOwner(
  status: StoredSelfUpdateStatus | null,
  lease: { attemptId?: unknown } | null,
): boolean {
  return Boolean(status
    && lease?.attemptId === status.attemptId
    && (isProcessAlive(status.workerPid) || isProcessAlive(status.managerPid)));
}
function cleanupDeadPreparedAttempt(
  status: StoredSelfUpdateStatus | null,
  now = Date.now(),
): StoredSelfUpdateStatus | null {
  if (!status
    || status.state !== "prepared"
    || !/^[0-9a-f-]{36}$/i.test(status.attemptId)) {
    return null;
  }
  const hasWorkerPid = Number.isInteger(status.workerPid) && Number(status.workerPid) > 0;
  if (hasWorkerPid && isProcessAlive(status.workerPid)) return null;
  if (isProcessAlive(status.managerPid)) return null;
  const armed = isAttemptArmed(status.attemptId);
  if (!hasWorkerPid) {
    const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
    if (lease?.attemptId !== status.attemptId
      || isActiveLease(lease, now)
      || armed
      || isAttemptCommitted(status.attemptId)) {
      return null;
    }
  }
  const failed: StoredSelfUpdateStatus = {
    ...status,
    state: "failed",
    ...(armed && !status.startedAt ? { startedAt: new Date(now).toISOString() } : {}),
    finishedAt: new Date(now).toISOString(),
    recovered: false,
    cleanupReady: false,
    error: "The update helper exited before the update was committed",
  };
  atomicWrite(statusPath(), JSON.stringify(failed));
  if (armed) {
    atomicWrite(join(rootDir(), `${status.attemptId}.complete.json`), JSON.stringify({
      protocol: UPDATE_PROTOCOL,
      attemptId: status.attemptId,
      state: "failed",
    }));
    return failed;
  }
  const artifactsRemoved = removeAttemptArtifacts(status.attemptId);
  const leaseReleased = releaseLease(status.attemptId);
  const terminal = { ...failed, cleanupReady: artifactsRemoved && leaseReleased } satisfies StoredSelfUpdateStatus;
  atomicWrite(statusPath(), JSON.stringify(terminal));
  return terminal;
}
function requireOwnedPreparedAttempt(attemptId: string, stage: "preparing" | "stopping"): StoredSelfUpdateStatus {
  const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (status?.attemptId === attemptId
    && status.state === "prepared"
    && status.stage === stage
    && isActiveLease(lease)
    && hasMatchingLiveHelper(status, lease)) {
    return status;
  }
  throw new SelfUpdateError("attempt_expired", "The update attempt has expired", 409);
}
function armedLauncherPid(attemptId: string): number | undefined {
  const marker = readStateJson<{ protocol?: unknown; attemptId?: unknown; launcherPid?: unknown }>(
    markerPath(attemptId, "armed.json"),
  );
  return marker?.protocol === UPDATE_PROTOCOL
    && marker.attemptId === attemptId
    && Number.isInteger(marker.launcherPid)
    && Number(marker.launcherPid) > 0
    ? Number(marker.launcherPid)
    : undefined;
}
function isAttemptArmed(attemptId: string): boolean {
  return armedLauncherPid(attemptId) !== undefined;
}
function isLauncherCompletionAcknowledged(attemptId: string): boolean {
  const ack = readStateJson<{ protocol?: unknown; attemptId?: unknown }>(join(rootDir(), `${attemptId}.complete-ack.json`));
  return ack?.protocol === UPDATE_PROTOCOL && ack.attemptId === attemptId;
}
function hasLauncherOwnershipSettled(attemptId: string): boolean {
  if (isLauncherCompletionAcknowledged(attemptId)) return true;
  const launcherPid = armedLauncherPid(attemptId);
  if (launcherPid === undefined || isProcessAlive(launcherPid)) return false;
  const ackPath = join(rootDir(), `${attemptId}.restart-ack.json`);
  const ack = readStateJson<{ protocol?: unknown; attemptId?: unknown; pid?: unknown }>(ackPath);
  if (!secureRegularFile(ackPath)) return true;
  if (ack?.protocol !== UPDATE_PROTOCOL || ack.attemptId !== attemptId) return false;
  return Number.isInteger(ack.pid) && Number(ack.pid) > 0 && !isProcessAlive(Number(ack.pid));
}
function isAttemptCommitted(attemptId: string): boolean {
  return Boolean(secureRegularFile(markerPath(attemptId, "go")));
}
function finalizeTerminalCleanup(): void {
  const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
  if (!status || !isTerminalStatus(status) || status.cleanupReady === true) return;
  if (isProcessAlive(status.workerPid) || isProcessAlive(status.managerPid)) return;
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (lease && lease.attemptId !== status.attemptId) return;
  const launcherSettled = Boolean(status.startedAt && hasLauncherOwnershipSettled(status.attemptId));
  if (isActiveLease(lease) && !launcherSettled) return;
  if (status.startedAt
    && !launcherSettled
    && (isAttemptArmed(status.attemptId) || attemptHelperExists(status.attemptId))) {
    return;
  }
  if (!removeAttemptArtifacts(status.attemptId, false)) return;
  if (!releaseLease(status.attemptId)) return;
  atomicWrite(statusPath(), JSON.stringify({ ...status, cleanupReady: true }));
}

export function getSelfUpdateStatus(): SelfUpdateStatus | undefined {
  cleanupStaleSelfUpdate();
  finalizeTerminalCleanup();
  return readStatus();
}
export function getSelfUpdateSupport(): InstallOwnership {
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? "";
  if (cachedSupport?.packageDir === packageDir) return cachedSupport.result;
  let result: InstallOwnership;
  try { result = detectGlobalInstall(packageDirFromEnv()); }
  catch (error) { result = { supported: false, reason: error instanceof SelfUpdateError ? error.code : "unsupported_install", packageDir }; }
  cachedSupport = { packageDir, result };
  return result;
}

function workerSource(): string {
  const installed = process.env.OMP_WEB_PACKAGE_DIR;
  if (installed) return join(resolve(installed), "bin", "omp-web-update-worker.js");
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omp-web-update-worker.js");
}
function copyWorker(attemptId: string): string {
  const attempts = attemptsDirectory(true);
  if (!attempts) throw new SelfUpdateError("update_state_unavailable", "The temporary update directory is unavailable", 500);
  const directory = join(attempts, attemptId);
  mkdirSync(directory, { mode: 0o700 });
  secureDirectory(directory);
  const target = join(directory, "worker.js");
  copyFileSync(workerSource(), target, constants.COPYFILE_EXCL);
  secureRegularFile(target);
  try { chmodSync(target, 0o700); } catch { /* Windows */ }
  return target;
}
function waitForReady(attemptId: string): Promise<boolean> {
  const deadline = Date.now() + PREPARE_READY_MS;
  return new Promise<boolean>((resolveReady) => {
    const poll = () => {
      if (secureRegularFile(markerPath(attemptId, "ready"))) return resolveReady(true);
      if (Date.now() >= deadline) return resolveReady(false);
      setTimeout(poll, 25).unref();
    };
    poll();
  });
}
function claimLease(attemptId: string, expiresAt: number): void {
  if (!ensureSecureRoot(true)) throw new SelfUpdateError("update_state_unavailable", "The temporary update directory is unavailable", 500);
  const payload = JSON.stringify({ attemptId, expiresAt });
  try {
    writeFileSync(leasePath(), payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const existing = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
    if (isActiveLease(existing)) throw new SelfUpdateError("update_in_progress", "An application update is already in progress", 409);
    const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
    if (hasMatchingRecordedLiveOwner(status, existing)) {
      throw new SelfUpdateError("update_in_progress", "An application update is already in progress", 409);
    }
    if (!removeSecureFile(leasePath())) throw new SelfUpdateError("update_state_busy", "The temporary update state is busy", 503);
    writeFileSync(leasePath(), payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
}
function releaseLease(attemptId: string): boolean {
  const lease = readStateJson<{ attemptId?: unknown }>(leasePath());
  if (lease?.attemptId === attemptId) return removeSecureFile(leasePath());
  return true;
}

export function validateCommitSelfUpdate(attemptId: string): "ready" | "resume" | "replay" {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) throw new SelfUpdateError("invalid_attempt", "The update attempt is invalid");
  const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
  if (status?.attemptId === attemptId) {
    if (cleanupDeadPreparedAttempt(status)) return "replay";
    if (status.state === "prepared" && status.stage === "preparing") {
      requireOwnedPreparedAttempt(attemptId, "preparing");
      return "ready";
    }
    if (status.state === "prepared" && status.stage === "stopping") {
      requireOwnedPreparedAttempt(attemptId, "stopping");
      return "resume";
    }
    if (status.state === "running" || isTerminalStatus(status)) return "replay";
  }
  throw new SelfUpdateError("attempt_expired", "The update attempt has expired", 409);
}

export function markSelfUpdateStopping(attemptId: string): void {
  const status = requireOwnedPreparedAttempt(attemptId, "preparing");
  atomicWrite(statusPath(), JSON.stringify({ ...status, stage: "stopping" } satisfies StoredSelfUpdateStatus));
}
export async function abortPreparedSelfUpdate(attemptId: string, safeReason: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) {
    throw new SelfUpdateError("invalid_attempt", "The update attempt is invalid");
  }
  if (!ensureSecureRoot(false)) {
    throw new SelfUpdateError("attempt_expired", "The update attempt has expired", 409);
  }
  const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
  const lease = readStateJson<{ attemptId?: unknown }>(leasePath());
  if (status?.attemptId !== attemptId
    || status.state !== "prepared"
    || typeof status.startedAt === "string"
    || lease?.attemptId !== attemptId
    || !hasMatchingLiveHelper(status, lease)
    || isAttemptArmed(attemptId)
    || isAttemptCommitted(attemptId)) {
    throw new SelfUpdateError("attempt_not_abortable", "The update attempt can no longer be cancelled", 409);
  }
  const reason = safeReason.replace(/[\r\n]/g, " ").slice(0, STATUS_MAX_ERROR).trim()
    || "The application update could not be committed";
  const abortPath = markerPath(attemptId, "abort.json");
  if (!secureRegularFile(abortPath)) {
    atomicWrite(abortPath, JSON.stringify({ protocol: UPDATE_PROTOCOL, attemptId, reason }));
  }

  const deadline = Date.now() + PREPARED_ABORT_MS;
  while (Date.now() < deadline) {
    const current = readStateJson<StoredSelfUpdateStatus>(statusPath());
    const workerPid = current?.attemptId === attemptId ? current.workerPid : status.workerPid;
    if (current?.attemptId === attemptId && isTerminalStatus(current) && !isProcessAlive(workerPid)) {
      releaseLease(attemptId);
      finalizeTerminalCleanup();
      return;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }

  const current = readStateJson<StoredSelfUpdateStatus>(statusPath());
  const workerPid = current?.attemptId === attemptId ? current.workerPid : status.workerPid;
  if (current?.attemptId === attemptId && !isTerminalStatus(current) && !isProcessAlive(workerPid)) {
    atomicWrite(statusPath(), JSON.stringify({
      ...current,
      state: "failed",
      finishedAt: new Date().toISOString(),
      recovered: false,
      cleanupReady: false,
      error: reason,
    } satisfies StoredSelfUpdateStatus));
    releaseLease(attemptId);
    finalizeTerminalCleanup();
    return;
  }
  throw new SelfUpdateError("abort_timeout", "The update helper did not finish cancellation", 503);
}

export async function prepareSelfUpdate(): Promise<PrepareResult> {
  cleanupStaleSelfUpdate();
  const ownership = getSelfUpdateSupport();
  if (!ownership.supported || !ownership.manager || !ownership.managerPath) throw new SelfUpdateError(ownership.reason ?? "unsupported_install", "This installation cannot be updated from Settings");
  const targetVersion = await latestVersion();
  const fromVersion = currentVersion(ownership.packageDir);
  if (!isNewerVersion(targetVersion, fromVersion)) throw new SelfUpdateError("already_current", "The application is already up to date");
  const descriptor = parseDescriptor();
  const attemptId = randomUUID();
  const now = new Date().toISOString();
  let workerPid: number | undefined;
  claimLease(attemptId, Date.now() + LEASE_MS);
  try {
    atomicWrite(statusPath(), JSON.stringify({ attemptId, state: "prepared", stage: "preparing", fromVersion, targetVersion, preparedAt: now, cleanupReady: false } satisfies StoredSelfUpdateStatus));
    const worker = copyWorker(attemptId);
    const args = [worker, "--attempt", attemptId, "--root", rootDir(), "--package-dir", ownership.packageDir, "--manager", ownership.manager, "--manager-path", ownership.managerPath, "--manager-prefix", JSON.stringify(ownership.managerPrefix ?? []), "--target", targetVersion, "--from", fromVersion, "--launcher-pid", process.env.OMP_WEB_LAUNCHER_PID ?? String(process.ppid), "--server-pid", String(process.pid), "--descriptor", JSON.stringify(descriptor)];
    const child = spawn(process.execPath, args, {
      cwd: dirname(worker),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    workerPid = child.pid;
    const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
    if (!status || status.attemptId !== attemptId || !Number.isInteger(workerPid)) {
      child.kill("SIGTERM");
      await waitForProcessExit(workerPid, PREPARE_READY_MS);
      throw new SelfUpdateError("helper_not_ready", "The update helper did not start correctly", 503);
    }
    atomicWrite(statusPath(), JSON.stringify({ ...status, workerPid }));
    child.unref();
    if (await waitForReady(attemptId)) return { attemptId, targetVersion };
    child.kill("SIGTERM");
    await waitForProcessExit(workerPid, PREPARE_READY_MS);
    throw new SelfUpdateError("helper_not_ready", "The update helper did not become ready", 503);
  } catch (error) {
    const workerAlive = isProcessAlive(workerPid);
    if (!workerAlive) releaseLease(attemptId);
    const cleanupReady = !workerAlive && removeAttemptArtifacts(attemptId);
    atomicWrite(statusPath(), JSON.stringify({
      attemptId,
      state: "failed",
      stage: "preparing",
      fromVersion,
      targetVersion,
      preparedAt: now,
      finishedAt: new Date().toISOString(),
      recovered: false,
      cleanupReady,
      ...(workerPid ? { workerPid } : {}),
      error: error instanceof SelfUpdateError ? error.message : "The update helper could not be started",
    } satisfies StoredSelfUpdateStatus));
    throw error;
  }
}

async function waitForArmedMarker(attemptId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAttemptArmed(attemptId)) return true;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return isAttemptArmed(attemptId);
}

export async function armSelfUpdateLauncher(attemptId: string): Promise<void> {
  requireOwnedPreparedAttempt(attemptId, "stopping");
  if (isAttemptArmed(attemptId)) return;
  if (!process.connected || typeof process.send !== "function") {
    throw new SelfUpdateError("launcher_unavailable", "The application launcher is not available for restart", 503);
  }
  let resolveAck!: () => void;
  let rejectAck!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
  let settled = false;
  let acknowledgementError: unknown;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (error) rejectAck(error);
    else resolveAck();
  };
  const handleMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const ack = message as { type?: unknown; protocol?: unknown; attemptId?: unknown; ok?: unknown; error?: unknown };
    if (ack.type !== UPDATE_ACK || ack.protocol !== UPDATE_PROTOCOL || ack.attemptId !== attemptId) return;
    finish(ack.ok === true ? undefined : new Error(typeof ack.error === "string" ? ack.error : "The launcher rejected the update"));
  };
  process.on("message", handleMessage);
  const timer = setTimeout(() => {
    finish(new Error("The launcher did not acknowledge the update"));
  }, IPC_TIMEOUT_MS);
  timer.unref();
  try {
    process.send({ type: UPDATE_MESSAGE, protocol: UPDATE_PROTOCOL, attemptId, root: rootDir() }, (error) => {
      if (error) finish(error);
    });
    await promise;
  } catch (error) {
    acknowledgementError = error;
  } finally {
    clearTimeout(timer);
    process.removeListener("message", handleMessage);
  }
  if (await waitForArmedMarker(attemptId, ARM_MARKER_SETTLE_MS)) return;
  throw new SelfUpdateError(
    "launcher_not_armed",
    acknowledgementError instanceof Error
      ? acknowledgementError.message
      : "The application launcher did not durably arm the update",
    503,
  );
}

export function commitSelfUpdate(attemptId: string): { accepted: true; attemptId: string } {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) throw new SelfUpdateError("invalid_attempt", "The update attempt is invalid");
  const status = readStateJson<StoredSelfUpdateStatus>(statusPath());
  if (status?.attemptId !== attemptId) {
    throw new SelfUpdateError("attempt_expired", "The update attempt has expired", 409);
  }
  if (status.state === "running" || isTerminalStatus(status)) return { accepted: true, attemptId };
  if (status.state === "prepared" && status.stage === "stopping" && isAttemptCommitted(attemptId)) {
    return { accepted: true, attemptId };
  }
  requireOwnedPreparedAttempt(attemptId, "stopping");
  if (!isAttemptArmed(attemptId)) {
    throw new SelfUpdateError("launcher_not_armed", "The application launcher is not armed for restart", 503);
  }
  atomicWrite(markerPath(attemptId, "go"), new Date().toISOString());
  return { accepted: true, attemptId };
}
