// The detached worker of an application update: it replaces the installation the web server (and, when it runs from
// the same installation, this machine's host) runs from, so it runs from outside it: a copy of the compiled binary
// (`ompweb server-update-worker <descriptor>`), or a Node bundle of this file built by the server before the cutover
// (`node worker.mjs --server-update-descriptor <descriptor>`). Node-compatible: node:* and shared host modules only,
// never the Bun server or the hub. self-update.ts prepares everything the worker uses and verifies the result.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { requestHostControl, type HostControlStatus } from "./hosts/host-control";
import { assertOwnedPath, HOST_VERSION_PATTERN, hostLaunch, moveHostRelease, sharedHostInstallReason } from "./hosts/update-worker";
import { getAgentDir } from "./omp/paths";
import { isProcessAlive } from "./process-identity";
import { atomicWrite, attemptPath, isActiveLease, leasePath, markerPath, patchStatus, readStateJson, removeSecureFile, renewLease, secureRegularFile, statusPath, type SelfUpdateStage, type StoredStatus } from "./self-update-state";
import { inspectUpgradeProcess, launchDetachedUpgrade, restartUpgradeProcess, stopUpgradeProcess, type UpgradeLaunch, type UpgradeProcess } from "./upgrade-process";
import { isRecord } from "./type-guards";
import type { UpgradeParticipant, UpgradePlan } from "./upgrade-types";

const exec = promisify(execFile);

export type ServerInstallMethod = "npm" | "bun" | "binary";

/** Written by the server at commit (descriptor.json, mode 0600); everything the worker may act on. Secrets are not in it: the restart environment is launch-env.json beside it. */
export interface ServerUpdateDescriptor {
  version: 1;
  attemptId: string;
  installMethod: ServerInstallMethod;
  installDir: string;
  /** The staged and preflighted release: inside serverArtifact(installDir, "staging", attemptId). */
  release: string;
  fromVersion: string;
  targetVersion: string;
  /** Node, for the package launcher and the host's package entrypoint. */
  runtime: string;
  /** The inspected top process: the npm launcher, or the compiled server itself. `pids` are every pid of the server tree known at commit. */
  server: { process: UpgradeProcess; launch: Omit<UpgradeLaunch, "env">; pids: number[] };
  /**
   * absent: no daemon answers, so one starts from the new installation after the cutover. separate: a daemon from another
   * installation, untouched. shared: the daemon runs from this installation and is replaced in the same cutover.
   */
  localHost: { kind: "absent" | "separate" } | { kind: "shared"; process: UpgradeProcess };
  /** `--allow-http` or nothing: the arguments the shared daemon was started with. */
  hostArgs: string[];
  /** The plan participant that reports the shared local host. */
  participantId: string | null;
  /** The approval was Force and named the sessions the shared host runs: stopping it may interrupt them. */
  interruptSessions: boolean;
}

export interface ServerUpdateDeps {
  inspect: typeof inspectUpgradeProcess;
  stop: typeof stopUpgradeProcess;
  restart: typeof restartUpgradeProcess;
  launch: typeof launchDetachedUpgrade;
  hostControl: typeof requestHostControl;
  sharedInstall: typeof sharedHostInstallReason;
  /** The new server has this long to report ready after it starts. */
  bootTimeoutMs: number;
  /** The host has this long to answer its control endpoint linked, at the expected version. */
  hostTimeoutMs: number;
  pollMs: number;
  /** A ready server must still run this long afterwards. */
  settleMs: number;
}
export const defaultServerUpdateDeps: ServerUpdateDeps = {
  inspect: inspectUpgradeProcess,
  stop: stopUpgradeProcess,
  restart: restartUpgradeProcess,
  launch: launchDetachedUpgrade,
  hostControl: requestHostControl,
  sharedInstall: sharedHostInstallReason,
  bootTimeoutMs: 120_000,
  hostTimeoutMs: 90_000,
  pollMs: 250,
  settleMs: 2_000,
};

const UUID = /^[0-9a-f-]{36}$/i;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const serverBinaryName = (): string => (process.platform === "win32" ? "ompweb.exe" : "ompweb");

/** Siblings of the installation, so a rename never crosses a filesystem. Named apart from the host updater's `.ompweb-*` artifacts, which its pruning owns. */
export function serverArtifact(installDir: string, kind: "staging" | "backup" | "failed", attemptId: string): string {
  return join(dirname(installDir), `.ompweb-server-${kind}-${attemptId}`);
}

/** `path` lies inside `installDir` (resolved through links; a missing path is not inside). */
export function insideInstall(installDir: string, path: string): boolean {
  try {
    const value = relative(realpathSync(installDir), realpathSync(path));
    return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  } catch { return false; }
}
/** The daemon's executable or entrypoint is in the installation: a compiled host's own binary, or a package host's script. */
export function hostInInstall(status: Pick<HostControlStatus, "executable" | "entrypoint">, installDir: string): boolean {
  return insideInstall(installDir, status.executable) || insideInstall(installDir, status.entrypoint);
}

/** The daemon answering this user's private control endpoint, or null when none does (no socket or pipe, or a stale one). Any other failure is an error: a host that cannot be probed is never ignored. */
export async function probeLocalHost(control: typeof requestHostControl = requestHostControl): Promise<HostControlStatus | null> {
  try {
    return await control("status");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    throw error;
  }
}

/** How the host starts in this installation: the compiled `ompweb host`, or the package's host entrypoint on a Node runtime (the daemon's own, when one runs). Never from inside the installation: a cwd there blocks the next replacement on Windows. */
export function launchFor(d: Pick<ServerUpdateDescriptor, "installMethod" | "installDir" | "runtime" | "hostArgs" | "localHost">): UpgradeLaunch {
  const runtime = d.localHost.kind === "shared" ? d.localHost.process.executable : d.runtime;
  return hostLaunch({ installMethod: d.installMethod, installDir: d.installDir, runtime, hostArgs: d.hostArgs, cwd: homedir() });
}

/** The local host as the update sees it right now: what to stop, and whether it is this installation's to replace. */
export async function captureLocalHost(input: { installDir: string; installMethod: ServerInstallMethod; runtime: string; control?: typeof requestHostControl; inspect?: typeof inspectUpgradeProcess }): Promise<{ localHost: ServerUpdateDescriptor["localHost"]; hostArgs: string[] }> {
  const status = await probeLocalHost(input.control);
  if (!status) return { localHost: { kind: "absent" }, hostArgs: [] };
  if (!hostInInstall(status, input.installDir)) return { localHost: { kind: "separate" }, hostArgs: [] };
  const launch = launchFor({ installMethod: input.installMethod, installDir: input.installDir, runtime: status.executable, hostArgs: [], localHost: { kind: "absent" } });
  const inspected = await (input.inspect ?? inspectUpgradeProcess)({ pid: status.pid, installDir: input.installDir, role: "host", launch });
  // The daemon's own flags: restarting it without --allow-http would drop links it was started to keep.
  return { localHost: { kind: "shared", process: inspected }, hostArgs: inspected.args.includes("--allow-http") ? ["--allow-http"] : [] };
}

/** The installation goes to `backup` and `release` takes its place. A failure puts the installation back; one that cannot say where it is. */
export async function swapInstallDirectory(installDir: string, release: string, backup: string): Promise<void> {
  if (existsSync(backup)) throw new Error(`The backup directory ${backup} already exists`);
  await moveHostRelease(installDir, backup);
  try {
    await moveHostRelease(release, installDir);
  } catch (error) {
    try { await moveHostRelease(backup, installDir); }
    catch (restoreError) { throw new Error(`${message(error)}; the previous installation also could not be put back and remains at ${backup}: ${message(restoreError)}`); }
    throw error;
  }
}
/** The reverse of the swap: the new tree is set aside as `failed`, the previous installation returns. */
export async function restoreInstallDirectory(installDir: string, backup: string, failed: string): Promise<void> {
  if (existsSync(installDir)) await moveHostRelease(installDir, failed);
  try { await moveHostRelease(backup, installDir); }
  catch (error) { throw new Error(`${message(error)}; the previous installation remains at ${backup}`); }
}

function bad(what: string): never { throw new Error(`Invalid server update descriptor: ${what}`); }
const text = (value: unknown, what: string): string => (typeof value === "string" && value.length > 0 && value.length < 4096 && !value.includes("\0") ? value : bad(what));
const absolute = (value: unknown, what: string): string => { const path = text(value, what); return isAbsolute(path) ? path : bad(what); };

function processOf(value: unknown, role: "server" | "host", what: string): UpgradeProcess {
  // The lifecycle module re-validates the snapshot against the live process before it acts on it.
  if (!isRecord(value) || value.role !== role || !Number.isSafeInteger(value.pid)) bad(what);
  return value as unknown as UpgradeProcess;
}
function ownedDirectory(path: string, what: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) throw new Error(`Unsafe ${what}: it must be an owned directory nobody else can write`);
}

/** Parses and validates a descriptor path the server wrote under this user's update root; nothing in it is trusted without these checks. */
export function readServerUpdateDescriptor(path: string): ServerUpdateDescriptor {
  if (!secureRegularFile(path)) throw new Error("The server update descriptor is missing");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || raw.version !== 1) bad("version");
  const attemptId = text(raw.attemptId, "attemptId");
  if (!UUID.test(attemptId) || resolve(path) !== join(attemptPath(attemptId), "descriptor.json")) bad("location");
  const installMethod = raw.installMethod;
  if (installMethod !== "npm" && installMethod !== "bun" && installMethod !== "binary") bad("installMethod");
  const installDir = absolute(raw.installDir, "installDir");
  const release = absolute(raw.release, "release");
  if (dirname(release) !== serverArtifact(installDir, "staging", attemptId)) bad("release");
  const fromVersion = text(raw.fromVersion, "fromVersion");
  const targetVersion = text(raw.targetVersion, "targetVersion");
  if (!HOST_VERSION_PATTERN.test(fromVersion) || !HOST_VERSION_PATTERN.test(targetVersion)) bad("version string");
  const server = raw.server;
  if (!isRecord(server) || !isRecord(server.launch) || !Array.isArray(server.launch.args) || !server.launch.args.every((arg) => typeof arg === "string") || !Array.isArray(server.pids) || !server.pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)) bad("server");
  const localHost = raw.localHost;
  if (!isRecord(localHost) || !["absent", "separate", "shared"].includes(String(localHost.kind))) bad("localHost");
  const hostArgs = raw.hostArgs;
  if (!Array.isArray(hostArgs) || hostArgs.some((arg) => arg !== "--allow-http")) bad("hostArgs");
  if (raw.participantId !== null && typeof raw.participantId !== "string") bad("participantId");
  if (typeof raw.interruptSessions !== "boolean") bad("interruptSessions");
  const descriptor: ServerUpdateDescriptor = {
    version: 1,
    attemptId,
    installMethod,
    installDir,
    release,
    fromVersion,
    targetVersion,
    runtime: absolute(raw.runtime, "runtime"),
    server: { process: processOf(server.process, "server", "server process"), launch: { command: text(server.launch.command, "server launch"), args: server.launch.args as string[], cwd: absolute(server.launch.cwd, "server launch cwd") }, pids: server.pids as number[] },
    localHost: localHost.kind === "shared" ? { kind: "shared", process: processOf(localHost.process, "host", "host process") } : { kind: localHost.kind as "absent" | "separate" },
    hostArgs: hostArgs as string[],
    participantId: raw.participantId as string | null,
    interruptSessions: raw.interruptSessions,
  };
  if (realpathSync(installDir) !== resolve(installDir)) bad("installDir is not canonical");
  ownedDirectory(installDir, "installation");
  ownedDirectory(dirname(installDir), "installation parent");
  const status = readStateJson<StoredStatus>(statusPath());
  const lease = readStateJson<{ attemptId?: string; expiresAt?: unknown }>(leasePath());
  if (status?.attemptId !== attemptId || status.state !== "running") throw new Error("The descriptor does not belong to the running update attempt");
  if (lease?.attemptId !== attemptId || !isActiveLease(lease)) throw new Error("The update attempt's lease expired");
  if (status.targetVersion !== targetVersion || status.fromVersion !== fromVersion) throw new Error("The descriptor does not match the update attempt's versions");
  return descriptor;
}

/** The environment of the restarted server (launch-env.json: the web password hash is in it, so it is owner-only and removed when the worker finishes). */
function readLaunchEnvironment(attemptId: string): NodeJS.ProcessEnv {
  const file = join(attemptPath(attemptId), "launch-env.json");
  if (!secureRegularFile(file)) throw new Error("The server restart environment is missing");
  const env: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(env) || Object.values(env).some((value) => typeof value !== "string")) throw new Error("The server restart environment is invalid");
  return env as NodeJS.ProcessEnv;
}

/** The staged release really is the target version and a complete tree, checked again right before anything stops. */
async function verifyStagedRelease(d: ServerUpdateDescriptor): Promise<void> {
  if (!existsSync(join(d.release, "dist", "index.html"))) throw new Error("The staged release is incomplete (no dist/index.html)");
  if (d.installMethod === "binary") {
    const binary = join(d.release, serverBinaryName());
    const { stdout } = await exec(binary, ["--version"], { timeout: 10000, env: { ...process.env, OMP_WEB_PACKAGE_DIR: d.release }, maxBuffer: 1024 * 1024, windowsHide: true });
    if (!stdout.trim().split(/\s+/).some((token) => token.replace(/^v/, "") === d.targetVersion)) throw new Error("The staged server binary reports a different version");
    return;
  }
  const metadata: unknown = JSON.parse(readFileSync(join(d.release, "package.json"), "utf8"));
  if (!isRecord(metadata) || metadata.name !== "@kahme247/ompweb" || metadata.version !== d.targetVersion || !existsSync(join(d.release, "bin", "omp-web.js")) || !existsSync(join(d.release, "server", "main.ts"))) throw new Error("The staged package does not match the requested version");
}

/** Mirrors progress into the plan the server persisted (agent/omp-web/server-upgrades/<id>/plan.json): the worker only ever sets `state`, `error` and the local participant's stage. Advisory: status.json is the durable result. */
export function reportPlan(attemptId: string, participantId: string | null, state: UpgradePlan["state"], error?: string, participant?: { stage: UpgradeParticipant["stage"]; error?: string }): void {
  try {
    const file = join(getAgentDir(), "omp-web", "server-upgrades", attemptId, "plan.json");
    assertOwnedPath(dirname(file), true);
    assertOwnedPath(file);
    const plan: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(plan) || plan.id !== attemptId) return;
    // A clean local rollback is still recovery-required once a remote host is already on the new release.
    if (state === "failed" && Array.isArray(plan.hosts) && plan.hosts.some((item: unknown) => isRecord(item) && item.needsUpgrade === true && item.recovery !== "shared-local" && item.stage === "ready")) state = "recovery-required";
    plan.state = state;
    if (error === undefined) delete plan.error; else plan.error = error;
    if (participant && participantId && Array.isArray(plan.hosts)) {
      const host = plan.hosts.find((item: unknown) => isRecord(item) && item.id === participantId);
      if (isRecord(host)) { host.stage = participant.stage; if (participant.error === undefined) delete host.error; else host.error = participant.error; }
    }
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
    try { renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
  } catch (error) {
    console.error(`Could not record the server update plan's progress: ${message(error)}`);
  }
}

/** Runs one update attempt; the exit code. The terminal result is always in status.json (and the plan), never only in the exit code. */
export async function runServerUpdateWorker(descriptorPath: string, deps: ServerUpdateDeps = defaultServerUpdateDeps): Promise<number> {
  // The terminal that started the update may close before it ends.
  process.on("SIGHUP", () => undefined);
  let d: ServerUpdateDescriptor;
  try {
    d = readServerUpdateDescriptor(descriptorPath);
  } catch (error) {
    const id = basename(dirname(resolve(descriptorPath)));
    if (UUID.test(id)) patchStatus(id, { state: "failed", error: message(error).slice(0, 500), finishedAt: new Date().toISOString(), cleanupReady: true, coordinatorPid: undefined });
    console.error(message(error));
    return 1;
  }
  const id = d.attemptId;
  try { writeFileSync(join(attemptPath(id), "worker.lock"), String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return 1; throw error; }

  const flags = { hostDrained: false, hostStopped: false, serverStopped: false, swapped: false, restarted: false };
  const serverProcess = d.server.process;
  const hostProcess = d.localHost.kind === "shared" ? d.localHost.process : null;
  const backup = serverArtifact(d.installDir, "backup", id);
  const failed = serverArtifact(d.installDir, "failed", id);
  const staging = serverArtifact(d.installDir, "staging", id);
  const stage = (next: SelfUpdateStage): void => {
    patchStatus(id, { state: "running", stage: next, workerPid: process.pid });
    renewLease(id);
  };
  const host = (stageName: UpgradeParticipant["stage"], error?: string): void => reportPlan(id, d.participantId, "updating-server", undefined, { stage: stageName, error });

  /** Restarts the server through its supervisor and waits for the release at `version` to prove readiness (not a bare HTTP answer). */
  const startServer = async (version: string): Promise<void> => {
    const nonce = randomUUID();
    removeSecureFile(markerPath(id, "boot.json"));
    atomicWrite(markerPath(id, "expect.json"), JSON.stringify({ attemptId: id, version, nonce }));
    const started = await deps.restart(serverProcess, { ...d.server.launch, env: readLaunchEnvironment(id) });
    const deadline = Date.now() + deps.bootTimeoutMs;
    let exitedAt: number | undefined;
    for (;;) {
      const boot = readStateJson<{ attemptId?: string; nonce?: string; version?: string; pid?: number }>(markerPath(id, "boot.json"));
      if (boot?.attemptId === id && boot.nonce === nonce && boot.version === version && isProcessAlive(boot.pid)) {
        await pause(deps.settleMs);
        if (isProcessAlive(boot.pid)) return;
        throw new Error(`The server ${version} exited right after it reported ready`);
      }
      if (started !== undefined && !isProcessAlive(started)) {
        exitedAt ??= Date.now();
        if (Date.now() - exitedAt > 3000) throw new Error(`The restarted server ${version} exited before it reported ready`);
      }
      if (Date.now() > deadline) throw new Error(`The restarted server did not report ready as ${version} within ${deps.bootTimeoutMs / 1000} s`);
      await pause(deps.pollMs);
    }
  };

  /** The host answers its private control endpoint as `version`, linked, from this installation (not just any daemon: a stale or other one never counts). */
  const awaitHost = async (version: string, replaced: number | undefined): Promise<HostControlStatus> => {
    const deadline = Date.now() + deps.hostTimeoutMs;
    let last = "it did not answer";
    for (;;) {
      try {
        const status = await deps.hostControl("status");
        if (status.version === version && status.linked && status.pid !== replaced && hostInInstall(status, d.installDir)) return status;
        last = `it answered version ${status.version}${status.linked ? "" : ", not linked to a server"}${status.pid === replaced ? " from the process that was replaced" : ""}`;
      } catch (error) { last = message(error); }
      if (Date.now() > deadline) throw new Error(`The local host did not report ${version} linked within ${deps.hostTimeoutMs / 1000} s: ${last}`);
      await pause(deps.pollMs);
    }
  };

  /** The shared host is the one that was approved, and it is idle or its interruption was authorized: only then it stops. */
  const freezeHost = async (): Promise<void> => {
    const status = await probeLocalHost(deps.hostControl);
    if (!status || status.pid !== hostProcess!.pid || !hostInInstall(status, d.installDir)) throw new Error("The local host is no longer the process the update was approved for; refusing to stop it");
    try {
      await deps.hostControl("drain");
      flags.hostDrained = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "host_busy") throw error;
      if (!d.interruptSessions) throw new Error(`The local host started running work after the update was approved, and the approval did not authorize interrupting it: ${message(error)}`);
    }
  };

  /** Stops whatever host runs from the (new) installation; none is not an error. */
  const stopHostFromInstall = async (): Promise<void> => {
    const status = await probeLocalHost(deps.hostControl);
    if (!status || !hostInInstall(status, d.installDir)) return;
    await deps.stop(await deps.inspect({ pid: status.pid, installDir: d.installDir, role: "host", launch: launchFor(d) }));
  };

  const rollback = async (primary: unknown): Promise<{ message: string; recovered: boolean }> => {
    const notes: string[] = [];
    // A failed candidate that cannot be stopped blocks everything after it: moving or restarting could run two servers on one installation.
    let blocked = false;
    const step = async (failure: string, run: () => Promise<void>, blocking = false): Promise<void> => {
      try { await run(); } catch (error) { notes.push(`${failure}: ${message(error)}`); if (blocking) blocked = true; }
    };
    if (flags.restarted) {
      await step("The failed new host could not be stopped, so the previous installation was left in place", stopHostFromInstall, true);
      if (!blocked) await step("The failed new server could not be stopped, so the previous installation was left in place", () => deps.stop(serverProcess), true);
    }
    if (flags.swapped && !blocked) {
      await step("The previous installation could not be restored", () => restoreInstallDirectory(d.installDir, backup, failed).then(() => { flags.swapped = false; }), true);
    }
    if (flags.serverStopped && !blocked) await step(`The previous server ${d.fromVersion} could not be restarted`, () => startServer(d.fromVersion));
    if (flags.hostStopped && !blocked) await step("The previous local host could not be restarted", async () => {
      await deps.restart(hostProcess!, launchFor(d));
      await awaitHost(d.fromVersion, hostProcess!.pid);
    });
    else if (flags.hostDrained && !flags.hostStopped) await step("The local host could not be resumed", async () => { await deps.hostControl("resume"); });
    const touched = flags.serverStopped || flags.hostStopped || flags.swapped || flags.restarted || flags.hostDrained;
    const detail = notes.length ? `; ${notes.join("; ")}` : touched ? "; the previous release was restored" : "";
    return { message: `${message(primary)}${detail}`.slice(0, 1500), recovered: notes.length === 0 };
  };

  try {
    stage("preparing");
    reportPlan(id, d.participantId, "updating-server");
    if (["1", "true", "yes", "on"].includes((process.env.OMP_WEB_DISABLE_AUTOUPDATE || "").trim().toLowerCase())) throw new Error("Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE");
    await verifyStagedRelease(d);
    // Nothing stops while an unknown process still runs from the installation: the server's tree and the shared host (and its sessions) are expected.
    const owned = [...d.server.pids, ...(hostProcess ? [hostProcess.pid] : [])];
    const sharing = await deps.sharedInstall(d.installDir, [process.pid, ...owned], owned);
    if (sharing) throw new Error(sharing);

    stage("stopping");
    if (hostProcess) {
      host("updating");
      await freezeHost();
      // A stop that reached its wait has already signalled. Force may outlast one 10s wait; either way rollback must restart.
      let signalled = false;
      for (let attempt = 1; ; attempt++) {
        try {
          await deps.stop(hostProcess);
          flags.hostStopped = true;
          break;
        } catch (error) {
          if (!isProcessAlive(hostProcess.pid)) { flags.hostStopped = true; break; }
          if (/did not stop/.test(message(error))) signalled = true;
          if (!d.interruptSessions || attempt >= 5) {
            if (signalled) flags.hostStopped = true;
            throw error;
          }
        }
      }
    }
    await deps.stop(serverProcess);
    flags.serverStopped = true;
    const leftover = await deps.sharedInstall(d.installDir, [process.pid]);
    if (leftover) throw new Error(leftover);

    stage("installing");
    patchStatus(id, { retainedBackup: backup });
    await swapInstallDirectory(d.installDir, d.release, backup);
    flags.swapped = true;

    stage("restarting");
    flags.restarted = true;
    await startServer(d.targetVersion);
    if (hostProcess) {
      await deps.restart(hostProcess, launchFor(d));
      await awaitHost(d.targetVersion, hostProcess.pid);
    } else if (d.localHost.kind === "absent") {
      // The new server's autostart refuses while this update runs, so do not wait out its grace for a host it will not start.
      host("updating");
      if (!(await probeLocalHost(deps.hostControl))) await deps.launch(launchFor(d));
      await awaitHost(d.targetVersion, undefined);
    }

    // Healthy: the previous installation is no longer needed.
    stage("finalizing");
    try { rmSync(backup, { recursive: true, force: true, maxRetries: 3 }); patchStatus(id, { retainedBackup: undefined }); }
    catch (error) { console.error(`The previous installation at ${backup} could not be removed: ${message(error)}`); }
    patchStatus(id, { state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true, coordinatorPid: undefined });
    reportPlan(id, d.participantId, "succeeded", undefined, { stage: "ready" });
    return 0;
  } catch (error) {
    let outcome: { message: string; recovered: boolean };
    try { outcome = await rollback(error); }
    catch (rollbackError) { outcome = { message: `${message(error)}; recovery failed: ${message(rollbackError)}`, recovered: false }; }
    patchStatus(id, { state: "failed", error: outcome.message.slice(0, 1000), finishedAt: new Date().toISOString(), cleanupReady: true, coordinatorPid: undefined, ...(outcome.recovered ? { retainedBackup: undefined } : {}) });
    reportPlan(id, d.participantId, outcome.recovered ? "failed" : "recovery-required", outcome.message, d.localHost.kind === "separate" ? undefined : { stage: "failed", error: outcome.message });
    return 1;
  } finally {
    removeSecureFile(join(attemptPath(id), "launch-env.json"));
    try { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); } catch { /* the next prepare removes it */ }
  }
}

if (process.argv[2] === "--server-update-descriptor" && process.argv[3]) {
  void runServerUpdateWorker(process.argv[3]).then((code) => { process.exitCode = code; });
}
