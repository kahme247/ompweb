// The web server's side of an application update. prepare → plan (upgrade-plan.ts); commit → explicit approval, the
// release staged and preflighted, the plan's other hosts updated, then a detached worker (server-update-worker.ts)
// replaces this installation (binary, npm or bun) and the host sharing it, restarts both and proves them healthy.
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import { hostReleaseName, preflightHostRelease, stageBinary, stagePackage } from "./hosts/update-worker";
import { checkNpmUpdate, detectInstallMethod } from "./npm-update";
import { createChildProcessEnvironment } from "./project-command-env";
import { isProcessAlive } from "./process-identity";
import { releaseRepo } from "./release-repo";
import { captureLocalHost, insideInstall, reportPlan, serverArtifact, serverBinaryName, type ServerInstallMethod, type ServerUpdateDescriptor } from "./server-update-worker";
import {
  atomicWrite, attemptsDir, ensureSecureRoot, isActiveLease, LEASE_MS, leasePath, markerPath, patchStatus, readStateJson, removeSecureEmptyDirectory, removeSecureFile,
  renewLease, resolveSelfUpdateTempRoot, secureDirectory, SelfUpdateError, statusPath, type SelfUpdateStatus, type StoredStatus,
} from "./self-update-state";
import { type UpgradeLaunch, inspectUpgradeProcess, launchDetachedUpgrade, secureUpgradeDirectory } from "./upgrade-process";
import { approveUpgradePlan, getUpgradePlan, prepareUpgradePlan, removeUpgradePlan, upgradePlannedHosts } from "./upgrade-plan";
import type { UpgradeApproval, UpgradePlan } from "./upgrade-types";
import { DISABLE_AUTOUPDATE_ENV_VAR, isUpdateDisabled } from "./update-policy";
import { isRecord } from "./type-guards";

export { resolveSelfUpdateTempRoot, SelfUpdateError };
export type { SelfUpdateStage, SelfUpdateState, SelfUpdateStatus } from "./self-update-state";

const TERMINAL_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f-]{36}$/i;
const WORKER_LOST_ERROR = "The update worker stopped before the update finished";
/** Files the attempt directory may hold; anything else in it is not ours to delete. */
const ATTEMPT_FILES = ["descriptor.json", "launch-env.json", "job.json", "release.json", "worker.mjs", "worker.js", "worker.lock", "runtime", "runtime.exe"];
/** Per-attempt markers in the update root. The first two are the boot proof; the rest only older releases wrote. */
const ATTEMPT_MARKERS = ["expect.json", "boot.json", "ready", "go", "abort.json", "armed.json", "restart-request.json", "restart-ack.json", "complete.json", "complete-ack.json"];
/** The launcher's plumbing: a restarted launcher/server sets its own, and the helper never needs them. */
const PLUMBING_ENV = ["OMP_WEB_PACKAGE_DIR", "OMP_WEB_LAUNCHER_PID", "OMP_WEB_RESTART_DESCRIPTOR", "OMP_WEB_NODE_BIN"];

export interface PrepareResult {
  attemptId: string;
  targetVersion: string;
  plan: UpgradePlan;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
function assertUpdatesEnabled(): void {
  if (!isUpdateDisabled()) return;
  throw new SelfUpdateError("updates_disabled", `Updates are disabled by ${DISABLE_AUTOUPDATE_ENV_VAR}`, 403);
}
const unsupported = (reason: string): SelfUpdateError => new SelfUpdateError("self_update_unsupported", reason, 409);
/** Windows grants a directory what its parent does, whatever its mode: the state and the restart environment go in directories only this account and SYSTEM can reach. */
const securePrivateDirectory = (path: string): Promise<void> =>
  secureUpgradeDirectory(path).catch((error: unknown) => { throw new SelfUpdateError("unsafe_update_state", `The temporary update state path is unsafe: ${messageOf(error)}`, 500); });

// ---------------------------------------------------------------- the installation being updated

interface ServerInstall {
  method: ServerInstallMethod;
  installDir: string;
  /** Node, for the package launcher and host entrypoint (a compiled server needs none). */
  runtime: string;
}

function assertOwnedWritableDirectory(path: string, what: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) {
    throw unsupported(`${what} is not a directory owned by this user that nobody else can write, so it cannot be replaced safely`);
  }
  accessSync(path, constants.W_OK);
}

function nodeRuntime(): string {
  if (process.env.OMP_WEB_NODE_BIN) return process.env.OMP_WEB_NODE_BIN;
  // `npm start` runs Bun directly: the package's launcher and host are Node scripts.
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) if (directory && existsSync(join(directory, name))) return join(directory, name);
  return process.execPath;
}

/** The installation this server runs from, when it can be replaced in place; otherwise the reason it cannot. */
export function resolveServerInstall(): ServerInstall {
  let installDir: string;
  try { installDir = realpathSync(process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd()); }
  catch { throw unsupported("The installation directory was not found"); }
  try {
    assertOwnedWritableDirectory(installDir, "The installation");
    assertOwnedWritableDirectory(dirname(installDir), "The installation's parent directory");
  } catch (error) {
    throw error instanceof SelfUpdateError ? error : unsupported(`The installation cannot be replaced: ${messageOf(error)}`);
  }
  if (typeof Bun !== "undefined" && Bun.isStandaloneExecutable) {
    try { hostReleaseName(); } catch (error) { throw unsupported(messageOf(error)); }
    let executable = "";
    try { executable = realpathSync(process.execPath); } catch { /* compared below */ }
    if (executable !== join(installDir, serverBinaryName()) || !existsSync(join(installDir, "dist", "index.html"))) {
      throw unsupported("Updates need the server to run from a complete release directory's own ompweb binary");
    }
    return { method: "binary", installDir, runtime: process.execPath };
  }
  if (basename(installDir) !== "ompweb" || basename(dirname(installDir)) !== "@kahme247" || basename(dirname(dirname(installDir))) !== "node_modules") {
    throw unsupported("Updates need the installed @kahme247/ompweb package; a source checkout is updated with git");
  }
  return { method: detectInstallMethod(installDir), installDir, runtime: nodeRuntime() };
}

export function getSelfUpdateSupport(): { supported: boolean; reason?: string; packageDir: string } {
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  if (isUpdateDisabled()) return { supported: false, reason: `Updates are disabled by ${DISABLE_AUTOUPDATE_ENV_VAR}`, packageDir };
  try {
    return { supported: true, packageDir: resolveServerInstall().installDir };
  } catch (error) {
    return { supported: false, reason: messageOf(error), packageDir };
  }
}

/** The package manager's absolute path (Windows shims are `.cmd` files, which a bare name cannot start). */
function resolveManager(method: "npm" | "bun"): string {
  const names = process.platform === "win32" ? (method === "npm" ? ["npm.cmd", "npm.exe"] : ["bun.exe"]) : [method];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) if (directory && existsSync(join(directory, name))) return resolve(join(directory, name));
  }
  throw new Error(`${method} is not available on this server's PATH`);
}

// ---------------------------------------------------------------- state files and cleanup

function removeAttemptDirectory(attemptId: string): boolean {
  const attempts = attemptsDir(false);
  if (!attempts) return true;
  const dir = join(attempts, attemptId);
  try {
    secureDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const entries = readdirSync(dir);
  if (entries.some((entry) => !ATTEMPT_FILES.includes(entry))) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update attempt contains unexpected files", 500);
  }
  for (const entry of entries) if (!removeSecureFile(join(dir, entry))) return false;
  return removeSecureEmptyDirectory(dir);
}
function removeAttemptArtifacts(attemptId: string): boolean {
  if (!UUID.test(attemptId)) return false;
  if (!removeAttemptDirectory(attemptId)) return false;
  for (const marker of ATTEMPT_MARKERS) if (!removeSecureFile(markerPath(attemptId, marker))) return false;
  removeUpgradePlan(attemptId);
  return true;
}
function pruneEmptyRoot(): void {
  const attempts = attemptsDir(false);
  if (attempts) removeSecureEmptyDirectory(attempts);
  const root = ensureSecureRoot(false);
  if (root) removeSecureEmptyDirectory(root);
}
/** An attempt that never reached the worker: nothing of it stays, and it no longer holds the lease. */
function discardAttempt(attemptId: string): void {
  removeAttemptArtifacts(attemptId);
  const lease = readStateJson<{ attemptId?: unknown }>(leasePath());
  if (lease?.attemptId === attemptId) removeSecureFile(leasePath());
  removeSecureFile(statusPath());
}
/** Staging and failed-candidate trees of attempts nobody runs any more (only ever called with no active attempt); the backup of a failed recovery is kept. */
function pruneServerArtifacts(installDir: string): void {
  for (const name of readdirSync(dirname(installDir))) {
    if (!/^\.ompweb-server-(?:staging|failed)-[0-9a-f-]{36}$/i.test(name)) continue;
    const path = join(dirname(installDir), name);
    try {
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid())) rmSync(path, { recursive: true, force: true });
    } catch { /* a locked tree (Windows) is retried at the next prepare */ }
  }
}

function isTerminalStatus(status: SelfUpdateStatus | null | undefined): boolean {
  return status?.state === "succeeded" || status?.state === "failed";
}
export function cleanupStaleSelfUpdate(now = Date.now()): void {
  if (!ensureSecureRoot(false)) return;
  const status = readStateJson<StoredStatus>(statusPath());
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (lease && !isActiveLease(lease, now)) removeSecureFile(leasePath());
  if (!status || typeof status.attemptId !== "string") {
    pruneEmptyRoot();
    return;
  }
  const timestamp = Date.parse(status.finishedAt ?? status.preparedAt);
  const currentLease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (
    Number.isFinite(timestamp) &&
    now - timestamp >= TERMINAL_STATUS_TTL_MS &&
    !isActiveLease(currentLease, now) &&
    (isTerminalStatus(status) || !currentLease) &&
    !isProcessAlive(status.workerPid) &&
    !isProcessAlive(status.coordinatorPid) &&
    removeAttemptArtifacts(status.attemptId)
  ) {
    removeSecureFile(statusPath());
  }
  pruneEmptyRoot();
}

function isWorkerLost(status: StoredStatus): boolean {
  if (status.state !== "running") return false;
  // The worker never outlives its lease, and a reused pid cannot keep an expired one alive.
  if (!isActiveLease(readStateJson<{ expiresAt?: unknown }>(leasePath()))) return true;
  if (status.workerPid !== undefined) return !isProcessAlive(status.workerPid);
  // A committed host phase is resumed at boot from its private job and per-host operation ids.
  if (UUID.test(status.attemptId)
    && readStateJson<{ attemptId?: string }>(join(attemptsDir(false) ?? "", status.attemptId, "job.json"))?.attemptId === status.attemptId) return false;
  // Before the worker exists, this server's commit coordinates.
  return status.coordinatorPid !== undefined && !isProcessAlive(status.coordinatorPid);
}

export function getSelfUpdateStatus(): SelfUpdateStatus | null {
  const stored = readStateJson<StoredStatus>(statusPath());
  if (!stored || typeof stored.attemptId !== "string" || typeof stored.state !== "string") return null;
  let current: StoredStatus | null = stored;
  if (isWorkerLost(stored)) {
    // Re-read: the worker may have written its result just before it exited.
    const latest = readStateJson<StoredStatus>(statusPath());
    current = latest;
    if (latest?.attemptId === stored.attemptId && latest.state === "running") {
      const partial = latest.retainedBackup ? `; the installation may be partially replaced (the previous one is kept at ${latest.retainedBackup})` : "";
      current = { ...latest, state: "failed", error: `${WORKER_LOST_ERROR}${partial}`, finishedAt: new Date().toISOString(), cleanupReady: true };
      // A read must not fail over the write; the next poll retries it.
      try { atomicWrite(statusPath(), JSON.stringify(current)); } catch {}
    }
  }
  if (!current) return null;
  const visible: Partial<StoredStatus> = { ...current };
  delete visible.workerPid;
  delete visible.coordinatorPid;
  delete visible.retainedBackup;
  return visible as SelfUpdateStatus;
}

// ---------------------------------------------------------------- prepare

export async function prepareSelfUpdate(): Promise<PrepareResult> {
  assertUpdatesEnabled();
  const install = resolveServerInstall();
  cleanupStaleSelfUpdate(Date.now());
  await securePrivateDirectory(ensureSecureRoot(true)!);
  const existingLease = readStateJson<{ attemptId?: string; expiresAt?: number }>(leasePath());
  if (isActiveLease(existingLease)) {
    const current = readStateJson<StoredStatus>(statusPath());
    // A plan nobody approved (a closed dialog, a rejected approval) must not lock updates for the rest of its lease.
    if (!current || current.attemptId !== existingLease?.attemptId || current.state !== "prepared" || committing.has(current.attemptId)) {
      throw new SelfUpdateError("update_in_progress", "Another update is already in progress", 409);
    }
    discardAttempt(current.attemptId);
  }
  const npmStatus = await checkNpmUpdate(true);
  if (!npmStatus.updateAvailable || !npmStatus.availableVersion) {
    throw new SelfUpdateError("no_update_available", "No update available", 409);
  }
  pruneServerArtifacts(install.installDir);
  const attemptId = randomUUID();
  const preparedAt = new Date().toISOString();
  const stored: StoredStatus = { attemptId, state: "prepared", fromVersion: npmStatus.currentVersion, targetVersion: npmStatus.availableVersion, preparedAt };
  atomicWrite(leasePath(), JSON.stringify({ attemptId, expiresAt: Date.now() + LEASE_MS, preparedAt }));
  atomicWrite(statusPath(), JSON.stringify(stored));
  try {
    const plan = await prepareUpgradePlan(attemptId, stored.targetVersion, stored.fromVersion);
    return { attemptId, targetVersion: stored.targetVersion, plan };
  } catch (error) {
    discardAttempt(attemptId);
    throw error;
  }
}

// ---------------------------------------------------------------- commit

/** Attempts whose approval is being checked right now: a second POST is a replay, not a second commit. */
const committing = new Set<string>();

/** A refusal before anything changes carries its reason to the caller, and the attempt stays approvable. */
async function controllable<T>(what: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw new SelfUpdateError("not_controllable", `${what}: ${messageOf(error)}`, 409); }
}

/** The route passes the browser's JSON through: only a plan id and an explicit Force boolean are accepted. */
export function parseUpgradeApproval(value: unknown): UpgradeApproval {
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.planId !== "string" || value.planId.length === 0 || value.planId.length > 100 || typeof value.force !== "boolean") {
    throw new SelfUpdateError("invalid_approval", "The approval must name the plan and say whether Force is confirmed");
  }
  return { planId: value.planId, force: value.force };
}

/** How the server restarts: the compiled binary, the package launcher, or (`npm start`) Bun on main.ts, with the address it listens on. */
function serverRestart(install: ServerInstall): { launch: Omit<UpgradeLaunch, "env">; viaLauncher: boolean } {
  const port = process.env.OMP_WEB_PORT;
  const hostname = process.env.OMP_WEB_HOSTNAME;
  if (!port || !hostname) throw new SelfUpdateError("self_update_unsupported", "The server's listen address is unknown, so it cannot be restarted", 409);
  const listen = ["-p", port, "-H", hostname];
  if (install.method === "binary") return { launch: { command: join(install.installDir, serverBinaryName()), args: [...listen, "--no-open"], cwd: process.cwd() }, viaLauncher: false };
  if (process.env.OMP_WEB_LAUNCHER_PID) return { launch: { command: install.runtime, args: [join(install.installDir, "bin", "omp-web.js"), ...listen, "--no-open"], cwd: install.installDir }, viaLauncher: true };
  return { launch: { command: process.execPath, args: [join(install.installDir, "server", "main.ts"), ...listen], cwd: install.installDir }, viaLauncher: false };
}

/** The server's environment for its restart, with its web password hash and every setting. Written owner-only and removed by the worker; never argv. */
function restartEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !PLUMBING_ENV.includes(name.toUpperCase())) env[name] = value;
  return env;
}
/** The helper's environment: no web secrets (it runs npm, candidate preflights and a daemon), no launcher plumbing. */
function helperEnvironment(): NodeJS.ProcessEnv {
  const env = createChildProcessEnvironment();
  for (const name of Object.keys(env)) if (PLUMBING_ENV.includes(name.toUpperCase())) delete env[name];
  return env;
}

function failAttempt(attemptId: string, error: unknown, plan: "report" | "owned"): void {
  const reason = messageOf(error).slice(0, 1000);
  try { patchStatus(attemptId, { state: "failed", error: reason, finishedAt: new Date().toISOString(), cleanupReady: true, coordinatorPid: undefined }); } catch { /* the lease expiry reports a lost attempt */ }
  // Host updates keep their own, more exact plan state (partial failures need a recovery state).
  if (plan === "report") {
    const moved = getUpgradePlan(attemptId)?.hosts.some((host) => host.needsUpgrade && host.recovery !== "shared-local" && host.stage === "ready");
    reportPlan(attemptId, null, moved ? "recovery-required" : "failed", reason);
  }
}

interface CommitJob {
  attemptId: string;
  install: ServerInstall;
  fromVersion: string;
  targetVersion: string;
  server: ServerUpdateDescriptor["server"];
  localHost: ServerUpdateDescriptor["localHost"];
  hostArgs: string[];
  participantId: string | null;
  interruptSessions: boolean;
}

/** A copy of the compiled binary outside the installation, or a self-contained Node bundle of the worker: either runs after the installation it came from is replaced. */
async function workerLaunch(job: CommitJob, attemptDir: string, descriptor: string): Promise<UpgradeLaunch> {
  const { install } = job;
  const env = helperEnvironment();
  const copyRuntime = (source: string): string => {
    const target = join(attemptDir, process.platform === "win32" ? "runtime.exe" : "runtime");
    copyFileSync(source, target, constants.COPYFILE_FICLONE);
    chmodSync(target, 0o700);
    return target;
  };
  if (install.method === "binary") return { command: copyRuntime(process.execPath), args: ["server-update-worker", descriptor], cwd: attemptDir, env };
  const bundle = await Bun.build({ entrypoints: [fileURLToPath(new URL("./server-update-worker.ts", import.meta.url))], target: "node", format: "esm", outdir: attemptDir, naming: "worker.mjs" });
  if (!bundle.success) throw new Error(`Could not build the update worker: ${bundle.logs.map(String).join("; ")}`);
  // A runtime inside the package (Windows locks a running .exe) would be replaced under the worker.
  const runtime = insideInstall(install.installDir, install.runtime) ? copyRuntime(install.runtime) : install.runtime;
  return { command: runtime, args: [join(attemptDir, "worker.mjs"), "--server-update-descriptor", descriptor], cwd: attemptDir, env };
}

/** After the commit returned: stage and preflight the release, update the plan's other hosts, then hand over to the detached worker. */
async function coordinate(job: CommitJob): Promise<void> {
  const { attemptId, install, targetVersion } = job;
  const staging = serverArtifact(install.installDir, "staging", attemptId);
  let hostsPhase = false;
  const attemptDir = join(attemptsDir(true)!, attemptId);
  try {
    const saved = readStateJson<{ release?: string }>(join(attemptDir, "release.json"));
    let release: string;
    if (saved?.release && insideInstall(staging, saved.release)) {
      release = saved.release;
    } else {
      // An interrupted download cannot be reused as a verified candidate.
      if (existsSync(staging)) { assertOwnedWritableDirectory(staging, "The staged release"); rmSync(staging, { recursive: true }); }
      mkdirSync(staging, { mode: 0o700 });
      release = install.method === "binary"
        ? await stageBinary({ version: targetVersion, releaseRepo: releaseRepo() }, staging)
        : await stagePackage({ version: targetVersion, installMethod: install.method, managerPath: resolveManager(install.method) }, staging);
    }
    renewLease(attemptId);
    await preflightHostRelease({ installMethod: install.method, version: targetVersion, runtime: install.runtime }, release);
    atomicWrite(join(attemptDir, "release.json"), JSON.stringify({ release }));
    renewLease(attemptId);
    hostsPhase = true;
    // The hosts this server does not share an installation with: each answers with its own authenticated receipt.
    const hosts = await upgradePlannedHosts(attemptId);
    hostsPhase = false;
    if (hosts.state === "failed" || hosts.state === "recovery-required") throw new Error(hosts.error ?? "A host update failed");
    renewLease(attemptId);
    const descriptor: ServerUpdateDescriptor = {
      version: 1,
      attemptId,
      installMethod: install.method,
      installDir: install.installDir,
      release,
      fromVersion: job.fromVersion,
      targetVersion,
      runtime: install.runtime,
      server: job.server,
      localHost: job.localHost,
      hostArgs: job.hostArgs,
      participantId: job.participantId,
      interruptSessions: job.interruptSessions,
    };
    atomicWrite(join(attemptDir, "descriptor.json"), JSON.stringify(descriptor));
    atomicWrite(join(attemptDir, "launch-env.json"), JSON.stringify(restartEnvironment()));
    const pid = await launchDetachedUpgrade(await workerLaunch(job, attemptDir, join(attemptDir, "descriptor.json")));
    patchStatus(attemptId, { ...(pid === undefined ? {} : { workerPid: pid }), coordinatorPid: undefined });
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* the next prepare removes it */ }
    failAttempt(attemptId, error, hostsPhase ? "owned" : "report");
  }
}

/**
 * Approves `approval.planId` and starts the update; it returns once the attempt is claimed (`accepted`). Everything
 * that can be refused before anything changes is refused here (the attempt then stays prepared and can be approved
 * again): a changed plan or candidate, missing Force, a server or local host that cannot be controlled safely. The
 * staging, the other hosts' updates and the worker run after, and their outcome is the attempt's status and plan.
 */
export async function commitSelfUpdate(attemptId: string, approval: UpgradeApproval): Promise<{ accepted: true; attemptId: string }> {
  return startSelfUpdate(attemptId, approval, false);
}

async function startSelfUpdate(attemptId: string, approval: UpgradeApproval, resuming: boolean): Promise<{ accepted: true; attemptId: string }> {
  assertUpdatesEnabled();
  const status = readStateJson<StoredStatus>(statusPath());
  if (!status || status.attemptId !== attemptId) throw new SelfUpdateError("attempt_not_found", "Update attempt not found", 404);
  if ((!resuming && status.state === "running") || committing.has(attemptId)) return { accepted: true, attemptId };
  if (status.state !== (resuming ? "running" : "prepared")) throw new SelfUpdateError("invalid_state", "Update attempt is not prepared", 409);
  const lease = readStateJson<{ attemptId?: string; expiresAt?: unknown }>(leasePath());
  if (!lease || lease.attemptId !== attemptId) throw new SelfUpdateError("lease_mismatch", "Lease mismatch", 409);
  if (!isActiveLease(lease)) throw new SelfUpdateError("lease_expired", "Update attempt expired; prepare it again", 409);
  const confirmed = parseUpgradeApproval(approval);
  committing.add(attemptId);
  try {
    const install = resolveServerInstall();
    const plan = getUpgradePlan(attemptId);
    if (!plan) throw new SelfUpdateError("plan_mismatch", "The upgrade plan is missing; prepare it again", 409);

    const { launch, viaLauncher } = serverRestart(install);
    // The launcher is what a supervisor runs; stopping it stops its server. Without one, the server is the process.
    const launcherPid = Number(process.env.OMP_WEB_LAUNCHER_PID);
    const top = viaLauncher && launcherPid === process.ppid ? launcherPid : process.pid;
    const serverProcess = await controllable("The server cannot be restarted safely", () => inspectUpgradeProcess({ pid: top, installDir: install.installDir, role: "server", launch }));
    const { localHost, hostArgs } = await controllable("This machine's host cannot be stopped safely", () => captureLocalHost({ installDir: install.installDir, installMethod: install.method, runtime: install.runtime }));
    const local = plan.hosts.find((host) => host.id === "local") ?? null;
    // The plan deferred this machine's host to the server's cutover exactly when it shares the installation.
    if (localHost.kind !== "absent" && (localHost.kind === "shared") !== (local?.recovery === "shared-local")) {
      throw new SelfUpdateError("plan_changed", "This machine's host no longer matches the approved plan; prepare the update again", 409);
    }
    if (localHost.kind === "shared" && serverProcess.supervisor.kind !== "foreground"
      && JSON.stringify(serverProcess.supervisor) === JSON.stringify(localHost.process.supervisor)) {
      throw unsupported("The server and host share one supervisor; separate their services before upgrading");
    }
    await controllable("The detached update worker cannot be started safely", () =>
      launchDetachedUpgrade({ command: process.execPath, args: ["--version"], cwd: install.installDir, env: helperEnvironment() }));
    // Stopping the shared host interrupts what it runs (the approval required Force for it); null (unknown) counts as work.
    const interruptSessions = localHost.kind === "shared" && local !== null && (local.sessionProcesses !== 0 || local.activeTurns !== 0);

    const attemptDir = join(attemptsDir(true)!, attemptId);
    mkdirSync(attemptDir, { mode: 0o700, recursive: true });
    await securePrivateDirectory(attemptDir);
    atomicWrite(join(attemptDir, "job.json"), JSON.stringify({ attemptId }));
    // Persist approval only after controllability and private-state checks pass.
    if (!resuming) await approveUpgradePlan(attemptId, confirmed);
    patchStatus(attemptId, { state: "running", stage: "preparing", startedAt: new Date().toISOString(), coordinatorPid: process.pid });
    renewLease(attemptId);
    void coordinate({
      attemptId,
      install,
      fromVersion: status.fromVersion,
      targetVersion: status.targetVersion,
      server: { process: serverProcess, launch, pids: top === process.pid ? [process.pid] : [process.pid, top] },
      localHost,
      hostArgs,
      participantId: localHost.kind === "separate" ? null : local?.id ?? null,
      interruptSessions,
    });
    return { accepted: true, attemptId };
  } finally {
    committing.delete(attemptId);
  }
}

/** Resumes only an already approved, leased host phase; the detached cutover owns itself once it exists. */
export async function resumeCoordinatedSelfUpdate(): Promise<void> {
  const status = readStateJson<StoredStatus>(statusPath());
  if (status?.state !== "running" || status.workerPid !== undefined || isProcessAlive(status.coordinatorPid)
    || !UUID.test(status.attemptId) || !isActiveLease(readStateJson(leasePath()))) return;
  const job = readStateJson<{ attemptId?: string }>(join(attemptsDir(false) ?? "", status.attemptId, "job.json"));
  if (job?.attemptId !== status.attemptId) return;
  try {
    const plan = getUpgradePlan(status.attemptId);
    if (!plan?.approved) throw new Error("The interrupted upgrade has no stored approval");
    renewLease(status.attemptId);
    await startSelfUpdate(status.attemptId, { planId: plan.id, force: plan.approved.force }, true);
  } catch (error) {
    failAttempt(status.attemptId, error, "report");
  }
}

// ---------------------------------------------------------------- boot proof and acknowledgement

/**
 * The server calls this once it listens. While an update restarts it, this writes the proof the worker waits for: this
 * process, at this release's version, answering the nonce only the worker's expectation file holds. A no-op otherwise.
 */
export function acknowledgeSelfUpdateBoot(): void {
  try {
    if (!ensureSecureRoot(false)) return;
    const status = readStateJson<StoredStatus>(statusPath());
    if (status?.state !== "running" || !UUID.test(status.attemptId)) return;
    const expected = readStateJson<{ attemptId?: string; version?: string; nonce?: string }>(markerPath(status.attemptId, "expect.json"));
    if (expected?.attemptId !== status.attemptId || expected.version !== packageJson.version || typeof expected.nonce !== "string") return;
    atomicWrite(markerPath(status.attemptId, "boot.json"), JSON.stringify({ attemptId: status.attemptId, version: packageJson.version, nonce: expected.nonce, pid: process.pid }));
  } catch (error) {
    console.error(`Could not acknowledge the application update's restart: ${messageOf(error)}`);
  }
}

export function acknowledgeSelfUpdate(attemptId: string): { acknowledged: true; attemptId: string } {
  if (!ensureSecureRoot(false)) throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  const status = readStateJson<StoredStatus>(statusPath());
  if (status?.attemptId !== attemptId || !isTerminalStatus(status)) {
    throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  }
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (isProcessAlive(status.workerPid) || isProcessAlive(status.coordinatorPid) || (lease && lease.attemptId !== attemptId)) {
    throw new SelfUpdateError("cleanup_not_ready", "The update is still finishing cleanup", 409);
  }
  removeAttemptArtifacts(attemptId);
  if (lease?.attemptId === attemptId) removeSecureFile(leasePath());
  removeSecureFile(statusPath());
  pruneEmptyRoot();
  return { acknowledged: true, attemptId };
}
