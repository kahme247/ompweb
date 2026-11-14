import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import packageJson from "../../package.json";
import { checkNpmUpdate, detectInstallMethod } from "../npm-update";
import { getOmpVersion } from "../omp/omp-cli";
import { createChildProcessEnvironment } from "../project-command-env";
import { isUpdateDisabled } from "../update-policy";
import { releaseRepo } from "../release-repo";
import { inspectUpgradeProcess, launchDetachedUpgrade, type UpgradeProcess } from "../upgrade-process";
import { processStartIdentity, isProcessAlive } from "../process-identity";
import { isRecord } from "../type-guards";
import type { HostSoftwareUpdate, HostUpdateBlocker, HostUpdateCompatibility, HostUpdateInfo, HostUpdateOperation, HostUpdateRequest, HostUpdateTarget } from "./update-types";
import { assertOwnedPath, ensureHostUpdateRoot, fetchHostUpdateBytes, finishHostUpdate, HOST_INSTALL_SHARED, HOST_VERSION_PATTERN, hostLaunch, hostReleaseName, hostUpdateRoot, installedHostVersionMatches, pruneHostUpdateArtifacts, readHostUpdateState, sharedHostInstallReason, writeHostUpdateJson, type HostUpdateDescriptor } from "./update-worker";

// Covers a 15 min release download (update-worker.ts DOWNLOAD_TIMEOUT_MS) plus preflight, stop and restart.
const LEASE_MS = 30 * 60 * 1000;
/** What the claim-time supervisor inspection may be reused for by status checks; a start always inspects afresh. */
const INSPECTION_TTL_MS = 60 * 1000;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let safetyGuard: (() => string | null) | null = null;
let safetyState: HostUpdateSafetyState = { drained: () => false, sessions: () => 0 };
let inspection: { key: string; at: number; value: UpgradeProcess } | undefined;
const protocolCache = new Map<string, { value: number | null; checkedAt: number }>();

/** What the daemon tells this module about its activity beyond the guard's reason: `drained` is an operator's local maintenance (never forced past); `sessions` is the running session processes an explicit force ends. */
export interface HostUpdateSafetyState {
  drained(): boolean;
  sessions(): number;
}

export class HostUpdateError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 409) { super(message); this.name = "HostUpdateError"; }
}
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `guard`: why this host's restart would interrupt work now (sessions, uploads, operations, a local drain), or null. */
export function configureHostUpdateSafety(guard: () => string | null, state?: HostUpdateSafetyState): void {
  safetyGuard = guard;
  safetyState = state ?? { drained: () => false, sessions: () => 0 };
}
export function getHostUpdateOperation(): HostUpdateOperation | null {
  const state = readHostUpdateState();
  if (!state) return null;
  if (state.operation.state === "running" && (Date.now() - state.startedAt > LEASE_MS || (Date.now() - state.startedAt > 30000 && !isProcessAlive(state.workerPid ?? state.daemonPid)))) {
    finishHostUpdate(state.operation.id, "Host update was interrupted before completion");
    return readHostUpdateState()!.operation;
  }
  return state.operation;
}

/** A running update refuses new sessions and project preparation, except a forced one before its commit: its sessions end at the commit anyway, and refusing earlier would only idle the host while it stages. */
export function hostUpdateBlocksNewWork(operation: HostUpdateOperation | null): boolean {
  return operation?.state === "running" && !(operation.force === true && operation.committing !== true);
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

/**
 * Called when a maintenance link is welcomed. A staged candidate whose operation approved a target protocol range
 * acknowledges with a receipt even while its application protocol awaits the web server's cutover, so the server never
 * has to guess from a bare maintenance connection: the receipt carries this operation's id, the release's version, this
 * process's own start identity and protocol, and the nonce its worker recorded only after the release passed its
 * preflight. Only the target release acknowledges this way (a rolled-back daemon waits for its application link).
 */
export async function acknowledgeHostUpdateReceipt(protocol: number): Promise<void> {
  try {
    const state = readHostUpdateState();
    if (state?.operation.state !== "running" || state.operation.target !== "ompweb" || state.daemonPid === process.pid) return;
    const attempt = join(hostUpdateRoot(), state.operation.id);
    assertOwnedPath(attempt, true);
    const read = (name: string): unknown => { const path = join(attempt, name); assertOwnedPath(path); return JSON.parse(readFileSync(path, "utf8")); };
    const descriptor = read("descriptor.json") as HostUpdateDescriptor;
    if (descriptor.id !== state.operation.id || descriptor.version !== packageJson.version || !descriptor.receipt || protocol < descriptor.receipt.min || protocol > descriptor.receipt.max) return;
    const proof = read("preflight.json");
    if (!isRecord(proof) || proof.id !== descriptor.id || proof.version !== packageJson.version || typeof proof.nonce !== "string" || !proof.nonce) return;
    writeHostUpdateJson(join(attempt, "health.json"), { id: descriptor.id, version: packageJson.version, pid: process.pid, identity: await processStartIdentity(process.pid), protocol, receipt: proof.nonce });
  } catch (error) { console.error("Could not acknowledge host update receipt:", messageOf(error)); }
}

function assertCompatibility(compatibility: HostUpdateCompatibility): void {
  if (!compatibility || !Number.isSafeInteger(compatibility.min) || !Number.isSafeInteger(compatibility.max) || compatibility.min < 1 || compatibility.max < compatibility.min) throw new HostUpdateError("invalid_compatibility", "Invalid server link protocol range", 400);
}
/** The link protocol version a release declares in its source, or null when it cannot be verified. `refresh` bypasses the cache. */
export async function candidateProtocol(version: string, refresh: boolean): Promise<number | null> {
  if (!HOST_VERSION_PATTERN.test(version) || version.length > 100) return null;
  const cached = protocolCache.get(version);
  if (!refresh && cached && Date.now() - cached.checkedAt < (cached.value === null ? 30000 : 5 * 60 * 1000)) return cached.value;
  let value: number | null = null;
  try {
    const source = (await fetchHostUpdateBytes(`https://raw.githubusercontent.com/${releaseRepo()}/v${version}/lib/hosts/link-protocol.ts`, 128 * 1024)).toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
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
    if (process.pid === 1) throw new Error("A host running as a container's init process cannot be restarted in place");
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o022))) throw new Error("Host install is not an owned, writable release directory");
    if (method === "binary") {
      hostReleaseName();
      if (realpathSync(process.execPath) !== join(directory, process.platform === "win32" ? "ompweb.exe" : "ompweb") || !existsSync(join(directory, "dist", "index.html"))) throw new Error("Binary updates require a complete owned host release directory");
    } else if (basename(directory) !== "ompweb" || basename(dirname(directory)) !== "@kahme247" || basename(dirname(dirname(directory))) !== "node_modules") throw new Error("Host updates require an installed npm/bun package; source checkouts are manual-only");
    if (!safetyGuard) throw new Error("Host daemon restart safety is not configured");
    return null;
  } catch (error) { return messageOf(error); }
}

/** This daemon's verified process and supervisor, the snapshot the update's stop and restart are bound to. */
async function inspectHost(method: "npm" | "bun" | "binary", fresh: boolean): Promise<UpgradeProcess> {
  const installDir = installDirectory();
  const key = `${method}:${installDir}`;
  if (!fresh && inspection?.key === key && Date.now() - inspection.at < INSPECTION_TTL_MS) return inspection.value;
  const value = await inspectUpgradeProcess({ pid: process.pid, installDir, role: "host", launch: hostLaunch({ installMethod: method, installDir, runtime: process.execPath, hostArgs: hostArguments(method === "binary"), cwd: process.cwd() }) });
  inspection = { key, at: Date.now(), value };
  return value;
}

interface HostRestartPlan {
  blockers: HostUpdateBlocker[];
  /** The shared installation already holds the candidate: restart the host, replace nothing. */
  restartOnly: boolean;
  process: UpgradeProcess | null;
}
/** Everything about how this host would be stopped and restarted, so the button is disabled with a reason instead of failing. Every blocker is collected: whether a force can help depends on all of them. */
async function planHostUpdate(method: "npm" | "bun" | "binary", version: string, fresh: boolean): Promise<HostRestartPlan> {
  const plan: HostRestartPlan = { blockers: [], restartOnly: false, process: null };
  const layout = installSupport(method);
  if (layout) { plan.blockers.push({ code: "unsupported_install", message: layout, forceable: false }); return plan; }
  const busy = safetyGuard!();
  if (busy) plan.blockers.push(safetyState.drained() ? { code: "host_drained", message: busy, forceable: false } : { code: "host_busy", message: busy, forceable: true });
  try { plan.process = await inspectHost(method, fresh); }
  catch (error) { plan.blockers.push({ code: "supervisor_unsupported", message: messageOf(error), forceable: false }); }
  plan.restartOnly = await installedHostVersionMatches(method, installDirectory(), version);
  if (!plan.restartOnly) {
    // This daemon's own sessions run the installed runner and end with it: only an independent process makes the install shared.
    const sharing = await sharedHostInstallReason(installDirectory(), [process.pid], [process.pid]);
    if (sharing) plan.blockers.push({ code: "shared_install", message: `Update the web server first because this installation is shared. ${sharing}`, forceable: false, ...(sharing === HOST_INSTALL_SHARED ? { coordination: "server" as const } : {}) });
  }
  return plan;
}

interface HostUpdateEvaluation {
  info: HostUpdateInfo;
  plan: HostRestartPlan | null;
  /** The candidate's application protocol is outside the current server's range but inside the approved target range. */
  awaitsServerCutover: boolean;
}
async function evaluateHostUpdate(compatibility: HostUpdateCompatibility, refresh: boolean, targetCompatibility: HostUpdateCompatibility | undefined, fresh: boolean): Promise<HostUpdateEvaluation> {
  assertCompatibility(compatibility);
  if (targetCompatibility !== undefined) assertCompatibility(targetCompatibility);
  const operation = getHostUpdateOperation();
  const disabled = isUpdateDisabled() ? "Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE" : null;
  const [npm, ompVersion] = await Promise.all([checkNpmUpdate(refresh).catch(() => null), getOmpVersion()]);
  const base: HostSoftwareUpdate = { currentVersion: null, availableVersion: null, updateAvailable: false, canUpdate: false, blockers: [], canForceUpdate: false, blockedReason: null, updateCommand: "" };
  const installMethod = typeof Bun !== "undefined" && Bun.isStandaloneExecutable ? "binary" : detectInstallMethod(installDirectory());
  const ompweb: HostUpdateInfo["ompweb"] = { ...base, ...npm, currentVersion: packageJson.version, installMethod, protocolVersion: null, activeSessions: safetyState.sessions(), updateCommand: installMethod === "binary" ? `https://github.com/${releaseRepo()}/releases/latest` : installMethod === "bun" ? "bun add -g @kahme247/ompweb" : "npm install -g @kahme247/ompweb" };
  // omp updates with ompweb (its runner ships inside each release): the row only reports the running version.
  const runtime: HostUpdateInfo["omp"] = { currentVersion: ompVersion?.replace(/^omp\//, "") ?? null };
  const blockers: HostUpdateBlocker[] = [];
  let plan: HostRestartPlan | null = null;
  let awaitsServerCutover = false;
  if (disabled) blockers.push({ code: "updates_disabled", message: disabled, forceable: false });
  else if (!npm || !npm.availableVersion || !HOST_VERSION_PATTERN.test(npm.availableVersion)) blockers.push({ code: "check_failed", message: "Could not check the host's ompweb update version", forceable: false });
  else if (npm.updateAvailable) {
    const protocol = ompweb.protocolVersion = await candidateProtocol(npm.availableVersion, refresh);
    const inside = (range: HostUpdateCompatibility) => protocol !== null && protocol >= range.min && protocol <= range.max;
    if (protocol === null) blockers.push({ code: "protocol_unverified", message: "The candidate's daemon link protocol could not be verified; update is blocked", forceable: false });
    // With an approved target, the candidate must also speak what the server will speak after its cutover.
    else if (targetCompatibility && !inside(targetCompatibility)) blockers.push({ code: "protocol_incompatible", message: `This release uses daemon protocol ${protocol}, but the approved server cutover supports ${targetCompatibility.min}–${targetCompatibility.max}`, forceable: false, coordination: "server" });
    else if (!targetCompatibility && !inside(compatibility)) blockers.push({ code: "protocol_incompatible", message: `Update the web server first: this release uses daemon protocol ${protocol}, but the server supports ${compatibility.min}–${compatibility.max}`, forceable: false, coordination: "server" });
    else {
      awaitsServerCutover = !inside(compatibility);
      if (operation?.state !== "running") {
        plan = await planHostUpdate(installMethod, npm.availableVersion, fresh);
        blockers.push(...plan.blockers);
      }
    }
  }
  if (operation?.state === "running") blockers.push({ code: "update_in_progress", message: "Another host update is in progress", forceable: false });
  ompweb.blockers = blockers;
  ompweb.blockedReason = blockers[0]?.message ?? null;
  ompweb.canUpdate = ompweb.updateAvailable && blockers.length === 0;
  ompweb.canForceUpdate = ompweb.updateAvailable && blockers.length > 0 && blockers.every((blocker) => blocker.forceable);
  if (ompweb.canForceUpdate) ompweb.forceMethod = "native";
  return { info: { ompweb, omp: runtime, operation }, plan, awaitsServerCutover };
}

/** `refresh` bypasses the registry and protocol caches (the existing meaning of the request's `force` for a check, not the update force). `targetCompatibility`: see HostUpdateRequest. */
export async function checkHostUpdates(compatibility: HostUpdateCompatibility, refresh = false, targetCompatibility?: HostUpdateCompatibility): Promise<HostUpdateInfo> {
  return (await evaluateHostUpdate(compatibility, refresh, targetCompatibility, false)).info;
}

const inProgress = () => new HostUpdateError("update_in_progress", "Another host update is in progress");
/** The lock file is the one atomic gate: `wx` creation lets exactly one concurrent start through. `installDir` is the installation whose finished attempts are pruned. */
export function claimHostUpdate(id: string, installDir = installDirectory()): string {
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
    if (isProcessAlive(held.pid) && typeof held.at === "number" && Date.now() - held.at < LEASE_MS) throw inProgress();
    rmSync(lock, { force: true });
  }
  try { pruneHostUpdateArtifacts(installDir); } catch (error) { console.error("Could not prune old host update artifacts:", messageOf(error)); }
  return root;
}
/** Releases the claim only while it is still this attempt's: an expired attempt must never erase a newer claim. */
export function releaseHostUpdateClaim(root: string, id: string): void {
  try {
    const lock = join(root, "lock.json");
    assertOwnedPath(lock);
    if (JSON.parse(readFileSync(lock, "utf8")).id === id) rmSync(lock);
  } catch { /* already released */ }
}
/** The operation id that holds the update claim now, if any. */
export function hostUpdateClaimHolder(): string | undefined {
  try {
    const lock = join(hostUpdateRoot(), "lock.json");
    assertOwnedPath(lock);
    const held: unknown = JSON.parse(readFileSync(lock, "utf8"));
    return isRecord(held) && typeof held.id === "string" ? held.id : undefined;
  } catch { return undefined; }
}

const RELATIVE_RUNTIME_IMPORT = /^(import|export)(?!\s+type\b)([^"';]*?)from\s+"(\.{1,2}\/[^"]+)";/gm;
/**
 * Copies the worker `entry` and every module it imports at runtime (relative specifiers; type-only imports are erased)
 * flat into `directory` as `.mts`, rewriting each import to the copy beside it, so the worker runs alone outside the
 * install it replaces on Node or Bun. Returns the copied entry.
 */
export function copyHostWorkerSources(entry: string, directory: string): string {
  const copies = new Map<string, string>();
  const copy = (source: string): string => {
    const known = copies.get(source);
    if (known) return known;
    const target = join(directory, source === entry ? "worker.mts" : `${basename(source, ".ts")}.mts`);
    if ([...copies.values()].includes(target)) throw new Error(`Two worker modules would both be copied as ${basename(target)}`);
    copies.set(source, target);
    const text = readFileSync(source, "utf8").replace(RELATIVE_RUNTIME_IMPORT, (_whole, keyword: string, middle: string, specifier: string) => `${keyword}${middle}from "./${basename(copy(`${resolve(dirname(source), specifier)}.ts`))}";`);
    writeFileSync(target, text, { mode: 0o600 });
    return target;
  };
  const worker = copy(entry);
  copy(resolve(dirname(entry), "../upgrade-process.ts"));
  return worker;
}

/**
 * Writes the attempt's descriptor and starts its worker outside this process's tree and supervisor (the lifecycle's
 * detached launch), returning the worker's pid when known. `compiled`: this binary, copied beside the descriptor, runs
 * `host-update-worker`; otherwise the worker script (and what it imports) is copied and run with this runtime, itself
 * copied only when it lives inside the installation being replaced. The worker outlives the swap either way.
 */
export async function launchHostUpdateWorker(root: string, descriptor: HostUpdateDescriptor, style: "compiled" | "script"): Promise<number | undefined> {
  const attempt = join(root, descriptor.id);
  mkdirSync(attempt, { mode: 0o700 });
  const descriptorPath = join(attempt, "descriptor.json");
  writeHostUpdateJson(descriptorPath, descriptor);
  let command = process.execPath;
  if (style === "compiled" || runtimeInsideInstall(process.execPath, descriptor.installDir)) {
    command = join(attempt, process.platform === "win32" ? "runtime.exe" : "runtime");
    copyFileSync(process.execPath, command, constants.COPYFILE_FICLONE);
    chmodSync(command, 0o700);
  }
  const args = style === "compiled" ? ["host-update-worker", descriptorPath] : [copyHostWorkerSources(fileURLToPath(new URL("./update-worker.ts", import.meta.url)), attempt), "--host-update-descriptor", descriptorPath];
  const pid = await launchDetachedUpgrade({ command, args, cwd: attempt, env: createChildProcessEnvironment() });
  writeHostUpdateJson(join(root, "status.json"), { ...readHostUpdateState()!, workerPid: pid });
  return pid;
}

/** The package manager a package host is updated with, found on this process's PATH. */
export function resolvePackageManager(method: "npm" | "bun"): string {
  const names = process.platform === "win32" ? method === "npm" ? ["npm.cmd", "npm.exe"] : ["bun.exe"] : [method];
  const manager = (process.env.PATH || "").split(delimiter).flatMap((directory) => names.map((name) => join(directory, name))).find((path) => existsSync(path));
  if (!manager) throw new HostUpdateError("manager_missing", `${method} is not available on this host's PATH`);
  return resolve(manager);
}

/**
 * Starts the update of this host. Without `request.force` a host with activity is refused (`host_busy`) and nothing is
 * touched. With it, only that activity is waived: the release is still staged, digest-verified and preflighted first, a
 * disabled updater, damaged or foreign installs, a shared installation, a changed process identity and an uncontrollable
 * supervisor still refuse, and only then does the worker stop the daemon, which ends its sessions (their resume manifest
 * is preserved). `operation.interruptedSessions` tells the caller how many sessions that was when accepted.
 */
export async function startHostUpdate(target: HostUpdateTarget, version: string, compatibility: HostUpdateCompatibility, request: HostUpdateRequest = {}): Promise<{ accepted: true; operation: HostUpdateOperation }> {
  assertCompatibility(compatibility);
  if (request.targetCompatibility !== undefined) assertCompatibility(request.targetCompatibility);
  if (request.force !== undefined && typeof request.force !== "boolean") throw new HostUpdateError("invalid_request", "force must be a boolean", 400);
  const force = request.force === true;
  if (target !== "ompweb") throw new HostUpdateError("invalid_target", "Invalid host software target", 400);
  if (typeof version !== "string" || version.length > 100 || !HOST_VERSION_PATTERN.test(version)) throw new HostUpdateError("invalid_version", "Invalid host update version", 400);
  if (request.operationId !== undefined && (typeof request.operationId !== "string" || !OPERATION_ID.test(request.operationId))) throw new HostUpdateError("invalid_request", "operationId must be a UUID", 400);
  // A coordinator that retries an operation gets its state back; nothing is started twice.
  const existing = request.operationId === undefined ? null : getHostUpdateOperation();
  if (existing && existing.id === request.operationId) {
    if (existing.target !== target || existing.version !== version) throw new HostUpdateError("operation_conflict", "That operation id already names a different host update");
    return { accepted: true, operation: existing };
  }
  if (isUpdateDisabled()) throw new HostUpdateError("updates_disabled", "Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE", 403);
  const id = request.operationId ?? randomUUID();
  const root = claimHostUpdate(id);
  let claimed = false;
  try {
    const { info, plan, awaitsServerCutover } = await evaluateHostUpdate(compatibility, true, request.targetCompatibility, true);
    const software = info[target];
    if (!software.updateAvailable || software.availableVersion !== version) throw new HostUpdateError("candidate_changed", "The available update candidate changed; refresh host updates");
    if (!software.canUpdate && !(force && software.canForceUpdate)) throw new HostUpdateError(software.canForceUpdate ? "host_busy" : "update_blocked", software.blockedReason || "This host update is blocked");
    const method = info.ompweb.installMethod;
    if (!plan?.process) throw new HostUpdateError("update_blocked", "This host's process could not be verified");
    if (isUpdateDisabled()) throw new HostUpdateError("updates_disabled", "Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE", 403);
    const operation: HostUpdateOperation = { id, target, version, state: "running", ...(force ? { force: true as const, interruptedSessions: safetyState.sessions() } : {}), ...(awaitsServerCutover ? { awaitingServerCutover: true as const } : {}) };
    writeHostUpdateJson(join(root, "status.json"), { operation, startedAt: Date.now(), daemonPid: process.pid });
    claimed = true;
    // The guard is read once more immediately before anything is staged or stopped. A force waives activity, never a local drain.
    const busy = safetyGuard?.() ?? (safetyGuard ? null : "Host restart safety is not configured");
    if (busy && (!force || safetyState.drained())) throw new HostUpdateError(safetyState.drained() ? "host_drained" : "host_busy", busy);
    const binary = method === "binary";
    const descriptor: HostUpdateDescriptor = { id, target, version, fromVersion: packageJson.version, installMethod: method, installDir: installDirectory(), runtime: process.execPath, hostArgs: hostArguments(binary), cwd: process.cwd(), daemonPid: process.pid, process: plan.process, releaseRepo: releaseRepo(), restartOnly: plan.restartOnly || undefined, force: force || undefined, receipt: request.targetCompatibility };
    if (!binary && !descriptor.restartOnly) descriptor.managerPath = resolvePackageManager(method as "npm" | "bun");
    await launchHostUpdateWorker(root, descriptor, binary ? "compiled" : "script");
    return { accepted: true, operation };
  } catch (error) {
    if (claimed) finishHostUpdate(id, messageOf(error));
    else releaseHostUpdateClaim(root, id);
    if (error instanceof HostUpdateError) throw error;
    throw new HostUpdateError("host_update_failed", messageOf(error), 500);
  }
}
