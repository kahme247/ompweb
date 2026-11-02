import { execFile, spawn } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import packageJson from "../../package.json";
import { checkNpmUpdate, detectInstallMethod, isNewerVersion } from "../npm-update";
import { checkOmpUpdate, runOmpUpdate } from "../omp/updates";
import { createChildProcessEnvironment } from "../project-command-env";
import { isUpdateDisabled } from "../update-policy";
import { parseSystemdServiceCgroup } from "../self-update";
import type { HostSoftwareUpdate, HostUpdateCompatibility, HostUpdateInfo, HostUpdateOperation, HostUpdateTarget } from "./update-types";
import { assertOwnedPath, ensureHostUpdateRoot, fetchHostUpdateBytes, finishHostUpdate, HOST_VERSION_PATTERN, hostReleaseName, hostUpdateRoot, installedHostVersionMatches, isHostUpdateProcessAlive, processStartIdentity, pruneHostUpdateArtifacts, readHostUpdateState, sharedHostInstallReason, verifyHostServiceInstall, writeHostUpdateJson, type HostUpdateDescriptor } from "./update-worker";

const exec = promisify(execFile);
const LEASE_MS = 15 * 60 * 1000;
let safetyGuard: (() => string | null) | null = null;
const protocolCache = new Map<string, { value: number | null; checkedAt: number }>();

export class HostUpdateError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 409) { super(message); this.name = "HostUpdateError"; }
}
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function configureHostUpdateSafety(guard: () => string | null): void { safetyGuard = guard; }
export function getHostUpdateOperation(): HostUpdateOperation | null {
  const state = readHostUpdateState();
  if (!state) return null;
  if (state.operation.state === "running" && (Date.now() - state.startedAt > LEASE_MS || (Date.now() - state.startedAt > 30000 && !isHostUpdateProcessAlive(state.workerPid ?? state.daemonPid)))) {
    finishHostUpdate(state.operation.id, "Host update was interrupted before completion");
    return readHostUpdateState()!.operation;
  }
  return state.operation;
}

/** Called only after the new daemon's link is welcomed. Rollback daemons also acknowledge their old version. */
export function acknowledgeHostUpdateHealth(): void {
  try {
    const state = readHostUpdateState();
    if (state?.operation.state !== "running" || state.operation.target !== "ompweb" || state.daemonPid === process.pid) return;
    const attempt = join(hostUpdateRoot(), state.operation.id);
    assertOwnedPath(attempt, true);
    const path = join(attempt, "descriptor.json");
    assertOwnedPath(path);
    const descriptor = JSON.parse(readFileSync(path, "utf8")) as HostUpdateDescriptor;
    if (descriptor.id !== state.operation.id || ![descriptor.version, descriptor.fromVersion].includes(packageJson.version)) return;
    writeHostUpdateJson(join(attempt, "health.json"), { id: state.operation.id, version: packageJson.version, pid: process.pid });
  } catch (error) { console.error("Could not acknowledge host update health:", messageOf(error)); }
}

function assertCompatibility(compatibility: HostUpdateCompatibility): void {
  if (!compatibility || !Number.isSafeInteger(compatibility.min) || !Number.isSafeInteger(compatibility.max) || compatibility.min < 1 || compatibility.max < compatibility.min) throw new HostUpdateError("invalid_compatibility", "Invalid server link protocol range", 400);
}
async function candidateProtocol(version: string, force: boolean): Promise<number | null> {
  if (!HOST_VERSION_PATTERN.test(version) || version.length > 100) return null;
  const cached = protocolCache.get(version);
  if (!force && cached && Date.now() - cached.checkedAt < (cached.value === null ? 30000 : 5 * 60 * 1000)) return cached.value;
  let value: number | null = null;
  try {
    const source = (await fetchHostUpdateBytes(`https://raw.githubusercontent.com/kahme247/ompweb/v${version}/lib/hosts/link-protocol.ts`, 128 * 1024)).toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const declarations = [...source.matchAll(/^export const LINK_PROTOCOL_VERSION\s*=\s*([1-9]\d*)\s*;\s*$/gm)];
    if (declarations.length === 1 && [...source.matchAll(/export\s+const\s+LINK_PROTOCOL_VERSION\b/g)].length === 1) {
      const parsed = Number(declarations[0][1]);
      if (Number.isSafeInteger(parsed)) value = parsed;
    }
  } catch {}
  protocolCache.set(version, { value, checkedAt: Date.now() });
  return value;
}
function installDirectory(): string {
  return resolve(process.env.OMP_WEB_PACKAGE_DIR || fileURLToPath(new URL("../../", import.meta.url)));
}
function hostArguments(binary: boolean): string[] {
  if (binary && process.argv[2] === "host") return process.argv.slice(3);
  if (!binary && ["omp-web.js", "omp-web-host.js"].includes(basename(realpathSync(process.argv[1] || "")))) {
    return process.argv[2] === "host" ? process.argv.slice(3) : process.argv.slice(2);
  }
  throw new Error("Host updates require the standalone ompweb host daemon, not the web server or a development process");
}

/**
 * A script that starts the host and starts it again when it exits (the README's Windows ompweb-host.ps1 scheduled task
 * does, after 10 seconds) would run a second daemon next to the updated one. Only a host whose parent is an interactive
 * shell or Explorer is a foreground host this update may restart; anything else is not guessed at.
 */
export function windowsHostSupervisionReason(parent: { name: string; commandLine: string } | null): string | null {
  const manual = "update it manually, or stop the supervisor first: a supervisor such as the README's ompweb-host.ps1 scheduled task restarts the host after it exits and would run a second daemon next to the updated one";
  if (!parent) return `Cannot tell what started this host, so a supervisor cannot be ruled out; ${manual}`;
  const scripted = /\.(ps1|bat|cmd)\b|(^|\s)-(file|command|c|encodedcommand|ec|noexit)\b|(^|\s)\/[ck]\b/i.test(parent.commandLine);
  const interactive = ["powershell.exe", "pwsh.exe", "cmd.exe", "explorer.exe", "windowsterminal.exe", "conhost.exe", "openconsole.exe"].includes(parent.name.toLowerCase());
  if (interactive && !scripted) return null;
  return `This host was started by ${parent.name}${scripted ? " running a script" : ""}, which may supervise it; ${manual}`;
}
let windowsParentLookup: Promise<{ name: string; commandLine: string } | null> | undefined;
function windowsParent(): Promise<{ name: string; commandLine: string } | null> {
  windowsParentLookup ??= (async () => {
    try {
      // A cold CIM query can take over 10 s on a busy machine.
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`], { timeout: 20000, windowsHide: true });
      const row = JSON.parse(stdout) as { Name?: unknown; CommandLine?: unknown } | null;
      return typeof row?.Name === "string" ? { name: row.Name, commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "" } : null;
    } catch {
      // Ask again next time: a slow or failed query must not block updates until the daemon restarts.
      windowsParentLookup = undefined;
      return null;
    }
  })();
  return windowsParentLookup;
}

/**
 * macOS has no service the host can ask about, and the README runs it under a restart loop (`sh ompweb-host-run` in
 * tmux, like the Windows ps1) that would start a second daemon next to the updated one. Only a host whose parent is an
 * interactive shell running nothing but login/interactive flags is a foreground host this update may restart; a script,
 * `-c`, tmux or anything unknown is blocked, and no supervisor is coordinated with. Linux outside systemd is not
 * classified here: a supervising script on a Linux host that is not a service is not detected.
 */
export function macHostSupervisionReason(parentCommand: string | null): string | null {
  const manual = "update it manually, or stop the supervisor first: a restart loop such as the README's ompweb-host-run script starts the host again after it exits and would run a second daemon next to the updated one";
  const [program = "", ...flags] = (parentCommand ?? "").trim().split(/\s+/);
  const shell = /^(?:sh|bash|zsh|dash|ksh|fish|tcsh|csh)$/.test(basename(program.replace(/^-/, "")));
  if (shell && flags.every((flag) => ["-l", "-i", "-il", "-li", "--login", "--interactive"].includes(flag))) return null;
  return `This host was started by \`${parentCommand?.trim().slice(0, 120) || "an unknown process"}\`, which may supervise it; ${manual}`;
}
let macParentLookup: Promise<string | null> | undefined;
function macParentCommand(): Promise<string | null> {
  macParentLookup ??= (async () => {
    try {
      const { stdout } = await exec("ps", ["-o", "command=", "-p", String(process.ppid)], { timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
      return stdout.trim() || null;
    } catch { macParentLookup = undefined; return null; }
  })();
  return macParentLookup;
}
let ownIdentity: Promise<string | null> | undefined;

/** `execPath` lies physically inside `installDir` (a bundled Bun the swap replaces), as opposed to a system or Homebrew runtime. */
export function runtimeInsideInstall(execPath: string, installDir: string): boolean {
  try {
    const location = relative(realpathSync(installDir), realpathSync(execPath));
    return location !== "" && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
  } catch { return false; }
}

function installSupport(method: "npm" | "bun" | "binary"): string | null {
  try {
    const directory = installDirectory();
    if (hostArguments(method === "binary").some((arg) => arg !== "--allow-http")) throw new Error("Unsupported host daemon arguments");
    if (process.platform === "darwin" && process.ppid === 1) throw new Error("A launchd-managed or orphaned host must be updated manually to avoid duplicate daemon starts");
    if (process.pid === 1) throw new Error("A host running as a container's init process cannot be restarted in place");
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o022))) throw new Error("Host install is not an owned, writable release directory");
    if (method === "binary") {
      hostReleaseName();
      if (realpathSync(process.execPath) !== join(directory, process.platform === "win32" ? "ompweb.exe" : "ompweb") || !existsSync(join(directory, "dist", "index.html")) || !existsSync(join(directory, "lib", "omp", "session-edit-extension.mjs"))) throw new Error("Binary updates require a complete owned host release directory");
    } else if (basename(directory) !== "ompweb" || basename(dirname(directory)) !== "@kahme247" || basename(dirname(dirname(directory))) !== "node_modules") throw new Error("Host updates require an installed npm/bun package; source checkouts are manual-only");
    if (!safetyGuard) throw new Error("Host daemon restart safety is not configured");
    return safetyGuard();
  } catch (error) { return messageOf(error); }
}

async function detectHostService(method: "npm" | "bun" | "binary"): Promise<HostUpdateDescriptor["systemd"]> {
  if (process.platform !== "linux") return null;
  let service;
  try { service = parseSystemdServiceCgroup(readFileSync("/proc/self/cgroup", "utf8")); } catch { return null; }
  if (!service) return null;
  if (/^ompweb-api(?:[.@-]|$)/i.test(service.unit)) throw new Error("Refusing to stop the web-server service; the host daemon needs its own service");
  const { stdout } = await exec("systemctl", [...(service.user ? ["--user"] : []), "show", "--property=MainPID", "--value", service.unit], { timeout: 2000, encoding: "utf8", env: createChildProcessEnvironment() });
  if (Number(stdout.trim()) !== process.pid) throw new Error("Host daemon is not the service's main process; restart this service manually");
  await verifyHostServiceInstall(service, installDirectory(), method === "binary", process.execPath);
  return service;
}

interface HostRestartPlan {
  blockedReason: string | null;
  /** The shared installation already holds the candidate: restart the host, replace nothing. */
  restartOnly: boolean;
  systemd: HostUpdateDescriptor["systemd"];
  daemonIdentity: string | null;
}
/** Everything about how this host would be stopped and restarted, so the button is disabled with a reason instead of failing. */
async function planHostUpdate(method: "npm" | "bun" | "binary", version: string): Promise<HostRestartPlan> {
  const plan: HostRestartPlan = { blockedReason: null, restartOnly: false, systemd: null, daemonIdentity: null };
  const layout = installSupport(method);
  if (layout) return { ...plan, blockedReason: layout };
  try { plan.systemd = await detectHostService(method); } catch (error) { return { ...plan, blockedReason: messageOf(error) }; }
  if (!plan.systemd) {
    const supervision = process.platform === "win32" ? windowsHostSupervisionReason(await windowsParent()) : process.platform === "darwin" ? macHostSupervisionReason(await macParentCommand()) : null;
    if (supervision) return { ...plan, blockedReason: supervision };
    ownIdentity ??= processStartIdentity(process.pid);
    plan.daemonIdentity = await ownIdentity;
    if (!plan.daemonIdentity) return { ...plan, blockedReason: "This host's process identity cannot be read, so it cannot be stopped and restarted safely; update it manually" };
  }
  plan.restartOnly = await installedHostVersionMatches(method, installDirectory(), version);
  if (!plan.restartOnly) {
    const sharing = await sharedHostInstallReason(installDirectory());
    if (sharing) plan.blockedReason = `Update the web server first because this installation is shared. ${sharing}`;
  }
  return plan;
}

export async function checkHostUpdates(compatibility: HostUpdateCompatibility, force = false): Promise<HostUpdateInfo> {
  assertCompatibility(compatibility);
  const operation = getHostUpdateOperation();
  const disabled = isUpdateDisabled() ? "Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE" : null;
  const [npmResult, ompResult] = await Promise.allSettled([checkNpmUpdate(force), checkOmpUpdate(force)]);
  const base: HostSoftwareUpdate = { currentVersion: null, availableVersion: null, updateAvailable: false, canUpdate: false, blockedReason: null, updateCommand: "" };
  const npm = npmResult.status === "fulfilled" ? npmResult.value : null;
  const omp = ompResult.status === "fulfilled" ? ompResult.value : null;
  const installMethod = typeof Bun !== "undefined" && Bun.isStandaloneExecutable ? "binary" : detectInstallMethod(installDirectory());
  const ompweb: HostUpdateInfo["ompweb"] = { ...base, ...npm, currentVersion: packageJson.version, installMethod, protocolVersion: null, updateCommand: installMethod === "binary" ? "https://github.com/kahme247/ompweb/releases/latest" : installMethod === "bun" ? "bun add -g @kahme247/ompweb" : "npm install -g @kahme247/ompweb" };
  const runtime: HostUpdateInfo["omp"] = { ...base, ...omp, updateCommand: "omp update", updatesDisabled: Boolean(disabled) };
  if (disabled) ompweb.blockedReason = runtime.blockedReason = disabled;
  else {
    if (!npm || !npm.availableVersion || !HOST_VERSION_PATTERN.test(npm.availableVersion)) ompweb.blockedReason = "Could not check the host's ompweb update version";
    else if (npm.updateAvailable) {
      ompweb.protocolVersion = await candidateProtocol(npm.availableVersion, force);
      if (ompweb.protocolVersion === null) ompweb.blockedReason = "The candidate's daemon link protocol could not be verified; update is blocked";
      else if (ompweb.protocolVersion < compatibility.min || ompweb.protocolVersion > compatibility.max) ompweb.blockedReason = `Update the web server first: this release uses daemon protocol ${ompweb.protocolVersion}, but the server supports ${compatibility.min}–${compatibility.max}`;
      else if (operation?.state !== "running") ompweb.blockedReason = (await planHostUpdate(installMethod, npm.availableVersion)).blockedReason;
      ompweb.canUpdate = ompweb.blockedReason === null;
    }
    if (!omp || !omp.currentVersion || !HOST_VERSION_PATTERN.test(omp.currentVersion.replace(/^v/, "")) || (omp.updateAvailable && (!omp.availableVersion || !HOST_VERSION_PATTERN.test(omp.availableVersion)))) runtime.blockedReason = `Could not check the host's omp update${ompResult.status === "rejected" ? `: ${messageOf(ompResult.reason).slice(0, 240)}` : " version"}`;
    else runtime.canUpdate = omp.updateAvailable;
  }
  if (operation?.state === "running") {
    for (const software of [ompweb, runtime]) { software.canUpdate = false; software.blockedReason ??= "Another host update is in progress"; }
  }
  return { ompweb, omp: runtime, operation };
}

const inProgress = () => new HostUpdateError("update_in_progress", "Another host update is in progress");
/** The lock file is the one atomic gate: `wx` creation lets exactly one concurrent start through. */
function claimUpdate(id: string): string {
  const root = ensureHostUpdateRoot();
  if (getHostUpdateOperation()?.state === "running") throw inProgress();
  const lock = join(root, "lock.json");
  const lease = JSON.stringify({ id, pid: process.pid, at: Date.now() });
  for (let reclaimed = false; ; reclaimed = true) {
    try {
      writeFileSync(lock, lease, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || reclaimed) throw (error as NodeJS.ErrnoException).code === "EEXIST" ? inProgress() : error;
    }
    assertOwnedPath(lock);
    let held: { pid?: number; at?: number } = {};
    try { held = JSON.parse(readFileSync(lock, "utf8")); } catch { /* unreadable: treated as expired */ }
    if (isHostUpdateProcessAlive(held.pid) && typeof held.at === "number" && Date.now() - held.at < LEASE_MS) throw inProgress();
    rmSync(lock, { force: true });
  }
  try { pruneHostUpdateArtifacts(installDirectory()); } catch (error) { console.error("Could not prune old host update artifacts:", messageOf(error)); }
  return root;
}
/** Releases the claim only while it is still this attempt's: an expired attempt must never erase a newer claim. */
function releaseClaim(root: string, id: string): void {
  try {
    const lock = join(root, "lock.json");
    assertOwnedPath(lock);
    if (JSON.parse(readFileSync(lock, "utf8")).id === id) rmSync(lock);
  } catch { /* already released */ }
}

export async function startHostUpdate(target: HostUpdateTarget, version: string, compatibility: HostUpdateCompatibility): Promise<{ accepted: true; operation: HostUpdateOperation }> {
  assertCompatibility(compatibility);
  if (target !== "ompweb" && target !== "omp") throw new HostUpdateError("invalid_target", "Invalid host software target", 400);
  if (typeof version !== "string" || version.length > 100 || !HOST_VERSION_PATTERN.test(version)) throw new HostUpdateError("invalid_version", "Invalid host update version", 400);
  if (isUpdateDisabled()) throw new HostUpdateError("updates_disabled", "Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE", 403);
  const id = randomUUID();
  const root = claimUpdate(id);
  let claimed = false;
  try {
    const info = await checkHostUpdates(compatibility, true);
    const software = info[target];
    if (!software.updateAvailable || software.availableVersion !== version) throw new HostUpdateError("candidate_changed", "The available update candidate changed; refresh host updates");
    if (!software.canUpdate) throw new HostUpdateError("update_blocked", software.blockedReason || "This host update is blocked");
    const method = info.ompweb.installMethod;
    const plan = target === "ompweb" ? await planHostUpdate(method, version) : null;
    if (plan?.blockedReason) throw new HostUpdateError("update_blocked", plan.blockedReason);
    if (isUpdateDisabled()) throw new HostUpdateError("updates_disabled", "Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE", 403);
    const operation: HostUpdateOperation = { id, target, version, state: "running" };
    writeHostUpdateJson(join(root, "status.json"), { operation, startedAt: Date.now(), daemonPid: process.pid });
    claimed = true;
    if (target === "omp") {
      void (async () => {
        try {
          await runOmpUpdate([], 5 * 60 * 1000);
          // `omp update` installs the newest release, which may have moved past the one requested: that is a success, an older one is not.
          const reported = (await checkOmpUpdate(true)).currentVersion;
          if (!reported || (reported.replace(/^v/, "") !== version && !isNewerVersion(reported, version))) throw new Error(`omp update did not install the requested version ${version} (reported ${reported || "unknown"})`);
          finishHostUpdate(id);
        } catch (error) { finishHostUpdate(id, messageOf(error)); }
      })().catch((error) => console.error("Could not persist host runtime update status:", error));
      return { accepted: true, operation };
    }
    // The guard is read once more immediately before anything is staged or stopped.
    const busy = safetyGuard?.() ?? (safetyGuard ? null : "Host restart safety is not configured");
    if (busy) throw new HostUpdateError("host_busy", busy);
    const attempt = join(root, id);
    mkdirSync(attempt, { mode: 0o700 });
    const binary = method === "binary";
    const descriptor: HostUpdateDescriptor = { id, target, version, fromVersion: packageJson.version, installMethod: method, installDir: installDirectory(), runtime: process.execPath, hostArgs: hostArguments(binary), cwd: process.cwd(), daemonPid: process.pid, daemonIdentity: plan!.daemonIdentity, restartOnly: plan!.restartOnly || undefined, systemd: plan!.systemd };
    if (!binary && !descriptor.restartOnly) {
      const names = process.platform === "win32" ? method === "npm" ? ["npm.cmd", "npm.exe"] : ["bun.exe"] : [method];
      const manager = (process.env.PATH || "").split(delimiter).flatMap((directory) => names.map((name) => join(directory, name))).find((path) => existsSync(path));
      if (!manager) throw new HostUpdateError("manager_missing", `${method} is not available on this host's PATH`);
      descriptor.managerPath = resolve(manager);
    }
    const descriptorPath = join(attempt, "descriptor.json");
    writeHostUpdateJson(descriptorPath, descriptor);
    // The worker must outlive the swap: the compiled binary and a runtime inside the install run from a copy outside it,
    // while a system runtime (Node, Homebrew, Nix) stays where its libraries are and only the worker script is copied.
    let command = process.execPath;
    if (binary || runtimeInsideInstall(process.execPath, installDirectory())) {
      command = join(attempt, process.platform === "win32" ? "runtime.exe" : "runtime");
      copyFileSync(process.execPath, command, constants.COPYFILE_FICLONE);
      chmodSync(command, 0o700);
    }
    let args: string[];
    if (binary) args = ["host-update-worker", descriptorPath];
    else {
      const copiedWorker = join(attempt, "worker.mts");
      copyFileSync(fileURLToPath(new URL("./update-worker.ts", import.meta.url)), copiedWorker);
      chmodSync(copiedWorker, 0o600);
      args = [copiedWorker, "--host-update-descriptor", descriptorPath];
    }
    if (plan!.systemd) {
      const options = [...(plan!.systemd.user ? ["--user"] : []), "--scope", "--quiet", "--collect", "--no-ask-password"];
      await exec("systemd-run", [...options, "true"], { timeout: 2000, env: createChildProcessEnvironment() });
      args = [...options, command, ...args];
      command = "systemd-run";
    }
    const child = spawn(command, args, { detached: true, cwd: attempt, stdio: "ignore", windowsHide: true, env: createChildProcessEnvironment() });
    child.once("error", (error) => {
      try { finishHostUpdate(id, `Could not launch host update worker: ${error.message}`); }
      catch (stateError) { console.error("Could not persist host update worker launch failure:", stateError); }
    });
    child.unref();
    const current = readHostUpdateState()!;
    writeHostUpdateJson(join(root, "status.json"), { ...current, workerPid: child.pid });
    return { accepted: true, operation };
  } catch (error) {
    if (claimed) finishHostUpdate(id, messageOf(error));
    else releaseClaim(root, id);
    if (error instanceof HostUpdateError) throw error;
    throw new HostUpdateError("host_update_failed", messageOf(error), 500);
  }
}
