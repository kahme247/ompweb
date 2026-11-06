// This file is copied outside the install before an update. Keep it self-contained and Node 24 compatible.
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { promisify } from "node:util";
import type { HostUpdateOperation, HostUpdateTarget } from "./update-types";

import { setTimeout as pause } from "node:timers/promises";
const exec = promisify(execFile);
const MAX_ARCHIVE = 200 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
const MAX_MEMBER = 256 * 1024 * 1024;
export const HOST_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export interface HostUpdateStoredState {
  operation: HostUpdateOperation;
  startedAt: number;
  daemonPid: number;
  workerPid?: number;
}
export interface HostUpdateDescriptor {
  id: string;
  target: HostUpdateTarget;
  version: string;
  fromVersion: string;
  installMethod: "npm" | "bun" | "binary";
  installDir: string;
  runtime: string;
  hostArgs: string[];
  cwd: string;
  daemonPid: number;
  /** The daemon's process start identity at claim time, so a recycled pid is never signalled. Not needed when a service stops it. */
  daemonIdentity?: string | null;
  managerPath?: string;
  restartOnly?: boolean;
  systemd: { unit: string; user: boolean } | null;
}

export function hostUpdateRoot(): string {
  const agent = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent");
  return join(agent, "omp-web", "host-update");
}
export function assertOwnedPath(path: string, directory = false): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
      (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Unsafe host update state ownership or permissions");
  }
}
export function ensureHostUpdateRoot(): string {
  const root = hostUpdateRoot();
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(root));
  if (parent.isSymbolicLink() || !parent.isDirectory() || (process.getuid && parent.uid !== process.getuid()) || (process.platform !== "win32" && (parent.mode & 0o022))) throw new Error("Unsafe omp-web data directory");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertOwnedPath(root, true);
  return root;
}
export function writeHostUpdateJson(path: string, value: unknown): void {
  assertOwnedPath(dirname(path), true);
  if (existsSync(path)) assertOwnedPath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
}
export function readHostUpdateState(): HostUpdateStoredState | null {
  const root = hostUpdateRoot();
  if (!existsSync(root)) return null;
  assertOwnedPath(root, true);
  const file = join(root, "status.json");
  if (!existsSync(file)) return null;
  assertOwnedPath(file);
  if (lstatSync(file).size > 65536) throw new Error("Host update status is too large");
  const state = JSON.parse(readFileSync(file, "utf8")) as HostUpdateStoredState;
  if (!state.operation || !["ompweb", "omp"].includes(state.operation.target) || !["running", "failed", "succeeded"].includes(state.operation.state) || !/^[a-zA-Z0-9-]{1,80}$/.test(state.operation.id) || !HOST_VERSION_PATTERN.test(state.operation.version) || !Number.isFinite(state.startedAt)) throw new Error("Invalid host update status");
  return state;
}
export function isHostUpdateProcessAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A value that differs between two processes that ever shared a pid (the kernel start time, not the pid): null when unknown or gone. */
export async function processStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // After the parenthesised command name: state is field 3, start time field 22.
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return /^\d+$/.test(start ?? "") ? `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}` : null;
    }
    if (process.platform === "darwin") {
      const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
      return stdout.trim() ? `darwin:${stdout.trim()}` : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { timeout: 10000, windowsHide: true });
      return /^\d+$/.test(stdout.trim()) ? `win32:${stdout.trim()}` : null;
    }
  } catch {
    // The process is gone or its start time is unreadable: no identity.
  }
  return null;
}
export function finishHostUpdate(id: string, error?: string): void {
  const state = readHostUpdateState();
  if (state?.operation.id !== id) return;
  writeHostUpdateJson(join(hostUpdateRoot(), "status.json"), { ...state, operation: { ...state.operation, state: error ? "failed" : "succeeded", ...(error ? { error: error.slice(0, 1000) } : {}) } });
  const lock = join(hostUpdateRoot(), "lock.json");
  if (existsSync(lock)) {
    assertOwnedPath(lock);
    const lease = JSON.parse(readFileSync(lock, "utf8"));
    if (lease.id === id) rmSync(lock);
  }
}

export async function fetchHostUpdateBytes(url: string, maxBytes: number, timeout = 5000): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { "User-Agent": "ompweb-host-updater" } });
    if (!response.ok || !response.body) throw new Error(`Release request failed (${response.status})`);
    if (response.url && (!response.url.startsWith("https://") || !["raw.githubusercontent.com", "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(new URL(response.url).hostname))) throw new Error("Unexpected release download destination");
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Release response is too large");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxBytes) throw new Error("Release response is too large");
        chunks.push(item.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return Buffer.concat(chunks, size);
  } finally { clearTimeout(timer); }
}
export function hostReleaseName(platform = process.platform, arch = process.arch): string {
  if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch) || (platform === "win32" && arch !== "x64")) throw new Error(`Host updates are unsupported on ${platform}/${arch}`);
  return `ompweb-${platform === "win32" ? "windows" : platform}-${arch}`;
}
export function verifyHostReleaseDigest(bytes: Uint8Array, digest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) throw new Error("Official release asset digest mismatch or unavailable");
}
interface ArchiveMember { name: string; directory: boolean; data: Buffer }
function memberName(name: string, root: string): string {
  const normalized = name.replace(/\/$/, "");
  if (normalized.includes("\\") || normalized.includes(":") || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === ".." || part === "." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || [...part].some((char) => char.charCodeAt(0) < 32)) || (normalized !== root && !normalized.startsWith(`${root}/`))) throw new Error("Unsafe release archive member path");
  return normalized;
}
export function validateHostReleaseArchive(input: Uint8Array, root: string): ArchiveMember[] {
  const bytes = Buffer.from(input);
  const entries: ArchiveMember[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  const add = (name: string, directory: boolean, data: Buffer) => {
    name = memberName(name, root);
    if (!name || seen.has(name) || entries.length >= 20000) throw new Error("Invalid duplicate or excessive archive members");
    if (data.length > MAX_MEMBER || (expanded += data.length) > MAX_EXPANDED) throw new Error("Release member size is too large");
    seen.add(name); entries.push({ name, directory, data });
  };
  if (bytes.readUInt32LE(0) === 0x04034b50) {
    // Read central metadata first: Unix symlink attributes are not present in local headers.
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error("Invalid or multi-disk ZIP archive");
    const count = bytes.readUInt16LE(end + 10);
    let offset = bytes.readUInt32LE(end + 16);
    if (count > 20000 || offset >= end) throw new Error("Invalid ZIP member count or offset");
    for (let index = 0; index < count; index++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central member");
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
      const size = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20);
      const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16;
      const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      if ((flags & 1) || ![0, 8].includes(method) || ((mode & 0o170000) !== 0 && ![0o100000, 0o040000].includes(mode & 0o170000))) throw new Error("Unsupported ZIP member type or encryption");
      if (size > MAX_MEMBER || expanded + size > MAX_EXPANDED) throw new Error("Release member size is too large");
      const local = bytes.readUInt32LE(offset + 42);
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("Invalid ZIP local member");
      const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
      if (bytes.subarray(local + 30, local + 30 + localNameLength).toString("utf8") !== name) throw new Error("ZIP member path mismatch");
      const start = local + 30 + localNameLength + localExtraLength;
      if (start + compressed > bytes.readUInt32LE(end + 16)) throw new Error("Invalid ZIP member size");
      const packed = bytes.subarray(start, start + compressed);
      const data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: MAX_MEMBER });
      if (data.length !== size) throw new Error("ZIP member size mismatch");
      add(name, name.endsWith("/"), data);
      offset += 46 + nameLength + extraLength + commentLength;
    }
  } else {
    for (let offset = 0; offset + 512 <= bytes.length;) {
      const header = bytes.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const text = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");
      const name = text(345, 155) ? `${text(345, 155)}/${text(0, 100)}` : text(0, 100);
      memberName(name, root);
      const type = header[156];
      if (![0, 48, 53].includes(type)) throw new Error("Unsupported release member type (links are forbidden)");
      const sizeText = text(124, 12).trim();
      const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : NaN;
      if (!Number.isSafeInteger(size) || size > MAX_MEMBER || size < 0 || expanded + size > MAX_EXPANDED) throw new Error("Release member size is too large or invalid");
      const checksumText = text(148, 8).trim();
      const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
      if (!/^[0-7]+$/.test(checksumText) || parseInt(checksumText, 8) !== checksum || offset + 512 + size > bytes.length) throw new Error("Invalid release tar header or size");
      add(name, type === 53, bytes.subarray(offset + 512, offset + 512 + size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  }
  if (!entries.length) throw new Error("Empty release archive");
  return entries;
}

async function stageBinary(d: HostUpdateDescriptor, staging: string): Promise<string> {
  const name = hostReleaseName();
  const assetName = `${name}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;
  const metadata = JSON.parse((await fetchHostUpdateBytes(`https://api.github.com/repos/kahme247/ompweb/releases/tags/v${d.version}`, 2 * 1024 * 1024)).toString("utf8")) as { tag_name?: string; assets?: { name: string; digest?: string }[] };
  const asset = metadata.assets?.find((item) => item.name === assetName);
  if (metadata.tag_name !== `v${d.version}` || !asset?.digest || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error("Official release asset digest is unavailable");
  const compressed = await fetchHostUpdateBytes(`https://github.com/kahme247/ompweb/releases/download/v${d.version}/${assetName}`, MAX_ARCHIVE, 120000);
  verifyHostReleaseDigest(compressed, asset.digest);
  const archive = process.platform === "win32" ? compressed : gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED });
  const members = validateHostReleaseArchive(archive, name);
  const release = join(staging, name);
  mkdirSync(release, { mode: 0o700 });
  for (const member of members) {
    const file = join(staging, member.name);
    if (member.directory) mkdirSync(file, { recursive: true, mode: 0o755 });
    else {
      mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
      writeFileSync(file, member.data, { mode: 0o644, flag: "wx" });
    }
  }
  const binary = join(release, process.platform === "win32" ? "ompweb.exe" : "ompweb");
  chmodSync(binary, 0o755);
  if (!existsSync(join(release, "dist", "index.html")) || !existsSync(join(release, "lib", "omp", "session-edit-extension.mjs"))) throw new Error("Incomplete host binary release layout");
  if (!(await binaryReportsVersion(binary, release, d.version))) throw new Error("Downloaded host binary reports a different version");
  return release;
}
async function stagePackage(d: HostUpdateDescriptor, staging: string): Promise<string> {
  const prefix = join(staging, "fetch");
  mkdirSync(prefix, { mode: 0o700 });
  writeFileSync(join(prefix, "package.json"), '{"private":true}', { mode: 0o600 });
  const packageName = `@kahme247/ompweb@${d.version}`;
  const args = d.installMethod === "bun" ? ["add", "--cwd", prefix, "--production", "--exact", "--registry=https://registry.npmjs.org", packageName] : ["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", packageName];
  const command = d.managerPath || d.installMethod;
  const windows = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  // `/s /c` strips one outer pair of quotes; verbatim so Node does not escape the inner ones (as Node's `shell: true`).
  const line = [command, ...args].map((arg) => `"${arg.replaceAll('"', '')}"`).join(" ");
  await exec(windows ? process.env.ComSpec || "cmd.exe" : command, windows ? ["/d", "/s", "/c", `"${line}"`] : args, { timeout: 300000, maxBuffer: 1024 * 1024, env: workerEnvironment(), windowsHide: true, windowsVerbatimArguments: windows });
  const modules = join(prefix, "node_modules");
  const packageDir = join(modules, "@kahme247", "ompweb");
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (metadata.name !== "@kahme247/ompweb" || metadata.version !== d.version || !existsSync(join(packageDir, "bin", "omp-web-host.js"))) throw new Error("Installed host package does not match the requested version");
  if (lstatSync(packageDir).isSymbolicLink()) throw new Error("Unsupported linked host package layout");
  const release = join(staging, "release");
  renameSync(packageDir, release);
  renameSync(modules, join(release, "node_modules"));
  return release;
}
function workerEnvironment(additions: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...additions };
  for (const name of Object.keys(env)) if (["PORT", "NODE_ENV", "OMP_WEB_PASSWORD", "OMP_WEB_PASSWORD_HASH", "OMP_WEB_TRUSTED_HEADER_SECRET", "OMP_WEB_TRUSTED_HEADER_SHA256", "OMP_WEB_PACKAGE_DIR", "OMP_WEB_LAUNCHER_PID"].includes(name.toUpperCase()) && !(name in additions)) delete env[name];
  return env;
}

/** Refuse an install shared with another daemon or web process; swapping it changes their on-disk assets too. */
export async function sharedHostInstallReason(installDir: string, ignoredPids: number[] = [process.pid]): Promise<string | null> {
  const inside = (path: string) => {
    try { const value = relative(installDir, realpathSync(path)); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); } catch { return false; }
  };
  if (process.platform === "linux") {
    for (const id of readdirSync("/proc")) {
      const pid = Number(id);
      if (!Number.isInteger(pid) || ignoredPids.includes(pid)) continue;
      try {
        const args = readFileSync(`/proc/${id}/cmdline`, "utf8").split("\0").filter(Boolean);
        // A non-dumpable process (e.g. started with capabilities) hides its cwd and exe, not its arguments: resolve
        // relative ones from the install, where a process sharing it would start.
        // shortcut: misses a sharer started from a subdirectory with relative arguments; read the cwd via ptrace if seen.
        let cwd = installDir;
        try { cwd = readlinkSync(`/proc/${id}/cwd`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error; }
        if (inside(`/proc/${id}/exe`) || args.slice(0, 4).some((arg) => !arg.startsWith("-") && inside(isAbsolute(arg) ? arg : resolve(cwd, arg)))) return "This installation is shared with another running process (possibly the web server); update it manually or use a dedicated host installation";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") {
          try { if (!process.getuid || lstatSync(`/proc/${id}`).uid === process.getuid()) return "Cannot establish that this installation is host-only; update it manually"; } catch {}
        }
      }
    }
    return null;
  }
  if (process.platform === "darwin" && process.ppid === 1) return "A launchd-managed or orphaned host must be updated manually to avoid duplicate daemon starts";
  try {
    // Cold CIM startup can exceed five seconds on contended Windows hosts.
    const { stdout } = process.platform === "win32"
      ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"], { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
      : await exec("ps", ["-axo", "pid=,command="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const rows: { pid: number; command: string; executable?: string }[] = process.platform === "win32"
      ? (JSON.parse(stdout) as { ProcessId: number; CommandLine: string; ExecutablePath: string }[]).map((row) => ({ pid: row.ProcessId, command: row.CommandLine || "", executable: row.ExecutablePath }))
      : stdout.split("\n").flatMap((line) => { const match = line.match(/^\s*(\d+)\s+(.*)$/); return match ? [{ pid: Number(match[1]), command: match[2] }] : []; });
    for (const row of rows) {
      if (ignoredPids.includes(row.pid)) continue;
      const command = process.platform === "win32" ? row.command.toLowerCase().replaceAll("\\", "/") : row.command;
      const root = process.platform === "win32" ? installDir.toLowerCase().replaceAll("\\", "/") : installDir;
      if ((row.executable && inside(row.executable)) || command.includes(`${root}/`) || row.command.split(/\s+/).some((arg) => inside(arg.replace(/^"|"$/g, "")))) return "This installation is shared with another running process (possibly the web server); update it manually or use a dedicated host installation";
    }
    return null;
  } catch { return "Cannot establish that this installation is host-only; update it manually"; }
}

export async function verifyHostServiceInstall(service: NonNullable<HostUpdateDescriptor["systemd"]>, installDir: string, binary: boolean, runtime: string): Promise<void> {
  const { stdout } = await exec("systemctl", [...(service.user ? ["--user"] : []), "show", "--property=ExecStart", "--value", service.unit], { timeout: 2000, env: workerEnvironment(), maxBuffer: 1024 * 1024 });
  const executable = stdout.match(/(?:^|\s)path=([^;]+);/)?.[1]?.trim();
  const args = stdout.match(/argv\[\]=([^;]+);/)?.[1]?.trim();
  if (!executable || !args) throw new Error("Cannot verify this host service's restart command");
  const start = realpathSync(executable);
  const launcher = join(installDir, "bin", "omp-web.js");
  const host = join(installDir, "bin", "omp-web-host.js");
  const expected = join(installDir, process.platform === "win32" ? "ompweb.exe" : "ompweb");
  const hostFlag = /(?:^|\s)host(?:\s|$)/.test(args);
  const valid = binary ? start === expected && hostFlag : ((start === launcher && hostFlag) || start === host || (start === realpathSync(runtime) && (args.includes(host) || (args.includes(launcher) && hostFlag))));
  if (!valid) throw new Error("Host service restart targets a different installation or unsupported wrapper; update it manually");
}

/** `<binary> --version` printed the exact version (a leading v is allowed). */
async function binaryReportsVersion(binary: string, packageDir: string, version: string): Promise<boolean> {
  const { stdout } = await exec(binary, ["--version"], { timeout: 10000, env: workerEnvironment({ OMP_WEB_PACKAGE_DIR: packageDir }), maxBuffer: 1024 * 1024 });
  return stdout.trim().split(/\s+/).some((token) => token.replace(/^v/, "") === version);
}
/** The installation on disk already holds `version`: what a restart-only update relies on. */
export async function installedHostVersionMatches(method: HostUpdateDescriptor["installMethod"], installDir: string, version: string): Promise<boolean> {
  try {
    if (method === "binary") return await binaryReportsVersion(join(installDir, process.platform === "win32" ? "ompweb.exe" : "ompweb"), installDir, version);
    const metadata = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8"));
    return metadata.name === "@kahme247/ompweb" && metadata.version === version;
  } catch { return false; }
}

const ATTEMPT_NAME = /^[a-zA-Z0-9-]{1,80}$/;
const ARTIFACT_NAME = /^\.ompweb-(backup|failed|staging)-([a-zA-Z0-9-]{1,80})$/;
function removeOwnedTree(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return false;
    rmSync(path, { recursive: true, force: true });
    return !existsSync(path);
  } catch { return false; } // e.g. a locked executable on Windows: the next update retries
}
/**
 * Bounds the disk an update leaves behind. Only paths an owned, trusted attempt descriptor for THIS install proves this
 * code created are touched, only as direct children of the install's parent or of the update state directory, and
 * never a symlink or a directory owned by someone else. Nothing is pruned while an update is running.
 * Retained: the newest `.ompweb-backup-<id>` (the rollback), the latest attempt's small files, `keepAttempt`'s artifacts.
 * Deleted: older backups, every other `.ompweb-failed-<id>` / `.ompweb-staging-<id>`, copied runtimes, finished attempts.
 */
export function pruneHostUpdateArtifacts(installDir: string, options: { keepAttempt?: string } = {}): void {
  const root = hostUpdateRoot();
  if (!existsSync(root)) return;
  assertOwnedPath(root, true);
  const state = readHostUpdateState();
  if (state?.operation.state === "running") return;
  const target = resolve(installDir);
  const parent = dirname(target);
  if (realpathSync(parent) !== parent) return;
  const attempts = new Map<string, number>();
  for (const name of readdirSync(root)) {
    if (!ATTEMPT_NAME.test(name)) continue;
    try {
      const dir = join(root, name);
      assertOwnedPath(dir, true);
      const descriptor = join(dir, "descriptor.json");
      assertOwnedPath(descriptor);
      const evidence = JSON.parse(readFileSync(descriptor, "utf8")) as { id?: unknown; installDir?: unknown };
      if (evidence.id === name && typeof evidence.installDir === "string" && resolve(evidence.installDir) === target) attempts.set(name, lstatSync(descriptor).mtimeMs);
    } catch {
      // Not an attempt this code can prove it created.
    }
  }
  const artifacts = new Map<string, string[]>();
  for (const name of readdirSync(parent)) {
    const match = ARTIFACT_NAME.exec(name);
    if (match && attempts.has(match[2])) artifacts.set(match[2], [...(artifacts.get(match[2]) ?? []), match[1]]);
  }
  const keepBackup = [...artifacts].filter(([, kinds]) => kinds.includes("backup")).sort((a, b) => attempts.get(b[0])! - attempts.get(a[0])!)[0]?.[0];
  const leftover = new Set<string>();
  for (const [id, kinds] of artifacts) {
    if (id === options.keepAttempt) continue;
    for (const kind of kinds) {
      if (kind === "backup" && id === keepBackup) continue;
      if (!removeOwnedTree(join(parent, `.ompweb-${kind}-${id}`))) leftover.add(id);
    }
  }
  for (const id of attempts.keys()) {
    const dir = join(root, id);
    for (const heavy of ["runtime", "runtime.exe", "worker.mts"]) { try { rmSync(join(dir, heavy), { force: true }); } catch { /* locked: retried next update */ } }
    if (id !== state?.operation.id && id !== keepBackup && id !== options.keepAttempt && !leftover.has(id)) removeOwnedTree(dir);
  }
}

class UnsafeHostRestartError extends Error {}
async function waitStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 10000;
  while (isHostUpdateProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error("Host daemon did not stop safely; refusing to kill sessions");
    await pause(100);
  }
}
async function controlService(d: HostUpdateDescriptor, action: "stop" | "start"): Promise<void> {
  if (!d.systemd) return;
  await exec("systemctl", [...(d.systemd.user ? ["--user"] : []), action, d.systemd.unit], { timeout: 15000, env: workerEnvironment(), maxBuffer: 1024 * 1024 });
}
/** The service's main process (the daemon itself: its ExecStart is verified to be the host runtime); 0 when none. */
async function servicePid(service: NonNullable<HostUpdateDescriptor["systemd"]>): Promise<number> {
  const { stdout } = await exec("systemctl", [...(service.user ? ["--user"] : []), "show", "--property=MainPID", "--value", service.unit], { timeout: 5000, env: workerEnvironment() });
  return Number(stdout.trim()) || 0;
}
async function stopDaemon(d: HostUpdateDescriptor, pid: number): Promise<void> {
  if (d.systemd) {
    await verifyHostServiceInstall(d.systemd, d.installDir, d.installMethod === "binary", d.runtime);
    if (await servicePid(d.systemd) !== pid) throw new Error("Host service main process changed during update; refusing to stop it");
    await controlService(d, "stop");
  } else if (isHostUpdateProcessAlive(pid)) {
    const current = await processStartIdentity(pid);
    if (!current || current !== d.daemonIdentity) {
      if (!isHostUpdateProcessAlive(pid)) return; // it exited while the identity was read: nothing left to stop
      throw new Error("The recorded host daemon is no longer the process with this pid (process identity mismatch); refusing to signal it");
    }
    process.kill(pid, "SIGTERM");
  }
  await waitStopped(pid);
}
async function launchDaemon(d: HostUpdateDescriptor, health: string, expected: string): Promise<number | undefined> {
  if (existsSync(health)) { assertOwnedPath(health); rmSync(health); }
  let child: ChildProcess | undefined;
  let spawnError: Error | undefined;
  if (d.systemd) await controlService(d, "start");
  else {
    const runtime = d.installMethod === "binary" ? join(d.installDir, process.platform === "win32" ? "ompweb.exe" : "ompweb") : d.runtime;
    const args = d.installMethod === "binary" ? ["host", ...d.hostArgs] : [join(d.installDir, "bin", "omp-web-host.js"), ...d.hostArgs];
    child = spawn(runtime, args, { cwd: d.cwd, detached: true, stdio: "ignore", windowsHide: true, env: workerEnvironment() });
    child.once("error", (error) => { spawnError = error; });
    child.unref();
  }
  const deadline = Date.now() + 30000;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child && child.exitCode !== null) throw new Error(`Updated host exited before health acknowledgement (${child.exitCode})`);
      if (existsSync(health)) {
        assertOwnedPath(health);
        const marker = JSON.parse(readFileSync(health, "utf8"));
        // Only the daemon launched here may vouch for this attempt, not another daemon sharing the agent directory.
        const launched = child ? child.pid : await servicePid(d.systemd!);
        if (marker.id === d.id && marker.pid === launched && isHostUpdateProcessAlive(marker.pid)) {
          if (marker.version !== expected) throw new Error(`Host acknowledged version ${marker.version}, expected ${expected}`);
          return marker.pid;
        }
      }
      await pause(100);
    }
    throw new Error("Host launch did not acknowledge healthy reconnect within 30 seconds");
  } catch (error) {
    try {
      if (d.systemd) await controlService(d, "stop");
      else if (child?.pid && isHostUpdateProcessAlive(child.pid)) { process.kill(child.pid, "SIGTERM"); await waitStopped(child.pid); }
    } catch (stopError) { throw new UnsafeHostRestartError(`Failed candidate could not be stopped; backup retained, no duplicate daemon started: ${String(stopError)}`); }
    throw error;
  }
}
function validateDescriptor(path: string): HostUpdateDescriptor {
  const root = ensureHostUpdateRoot();
  assertOwnedPath(path);
  const d = JSON.parse(readFileSync(path, "utf8")) as HostUpdateDescriptor;
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(d.id) || resolve(path) !== join(root, d.id, "descriptor.json") || !HOST_VERSION_PATTERN.test(d.version) || !HOST_VERSION_PATTERN.test(d.fromVersion) || d.target !== "ompweb" || !["npm", "bun", "binary"].includes(d.installMethod) || !isAbsolute(d.installDir) || !isAbsolute(d.runtime) || !isAbsolute(d.cwd) || !Number.isSafeInteger(d.daemonPid) || d.daemonPid <= 1 || !Array.isArray(d.hostArgs) || d.hostArgs.some((arg) => arg !== "--allow-http")) throw new Error("Invalid host update descriptor");
  if (d.restartOnly !== undefined && typeof d.restartOnly !== "boolean") throw new Error("Invalid host restart-only descriptor");
  if (!d.systemd && (typeof d.daemonIdentity !== "string" || !d.daemonIdentity || d.daemonIdentity.length > 200)) throw new Error("Invalid host update descriptor: the daemon's process identity is missing");
  assertOwnedPath(dirname(path), true);
  const state = readHostUpdateState();
  if (state?.operation.id !== d.id || state.operation.state !== "running" || state.operation.version !== d.version || state.daemonPid !== d.daemonPid) throw new Error("Host update descriptor does not own the running operation");
  if (d.systemd && (!/^[a-zA-Z0-9_.@\\:-]+\.service$/.test(d.systemd.unit) || /^ompweb-api(?:[.@-]|$)/i.test(d.systemd.unit) || typeof d.systemd.user !== "boolean")) throw new Error("Refusing to control a non-host service");
  const info = lstatSync(d.installDir);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(d.installDir) !== resolve(d.installDir) || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o022))) throw new Error("Unsupported or unsafe host installation layout");
  const parent = lstatSync(dirname(d.installDir));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid()) || (process.platform !== "win32" && (parent.mode & 0o022))) throw new Error("Unsafe host installation parent directory");
  if (d.installMethod === "binary") {
    hostReleaseName();
    if (!existsSync(join(d.installDir, process.platform === "win32" ? "ompweb.exe" : "ompweb")) || !existsSync(join(d.installDir, "dist", "index.html")) || !existsSync(join(d.installDir, "lib", "omp", "session-edit-extension.mjs"))) throw new Error("Incomplete host binary release layout");
  } else {
    if (basename(d.installDir) !== "ompweb" || basename(dirname(d.installDir)) !== "@kahme247" || basename(dirname(dirname(d.installDir))) !== "node_modules") throw new Error("Package updates require an installed npm/bun package layout");
    const current = JSON.parse(readFileSync(join(d.installDir, "package.json"), "utf8"));
    if (current.name !== "@kahme247/ompweb" || (!d.restartOnly && current.version !== d.fromVersion)) throw new Error("Host install changed since this update was requested");
  }
  return d;
}
export async function runHostUpdateWorker(path: string): Promise<number> {
  let d: HostUpdateDescriptor | undefined;
  let backup: string | undefined;
  let stopped = false;
  let swapped = false;
  let staging: string | undefined;
  let stagingCreated = false;
  try {
    d = validateDescriptor(path);
    const workerLease = join(dirname(path), "worker.lock");
    try { writeFileSync(workerLease, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return 1; throw error; }
    if (["1", "true", "yes", "on"].includes((process.env.OMP_WEB_DISABLE_AUTOUPDATE || "").trim().toLowerCase())) throw new Error("Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE");
    const restartCandidateMissing = "The shared installation no longer contains the requested ompweb version; refresh the host updates";
    if (d.restartOnly && !(await installedHostVersionMatches(d.installMethod, d.installDir, d.version))) throw new Error(restartCandidateMissing);
    const state = readHostUpdateState()!;
    writeHostUpdateJson(join(hostUpdateRoot(), "status.json"), { ...state, workerPid: process.pid });
    // Give the host op response time to reach the web server before any stop.
    await pause(500);
    let release: string | undefined;
    if (!d.restartOnly) {
      const sharing = await sharedHostInstallReason(d.installDir, [process.pid, d.daemonPid]);
      if (sharing) throw new Error(`Update the web server first because this installation is shared. ${sharing}`);
      staging = join(dirname(d.installDir), `.ompweb-staging-${d.id}`);
      mkdirSync(staging, { mode: 0o700 });
      stagingCreated = true;
      release = d.installMethod === "binary" ? await stageBinary(d, staging) : await stagePackage(d, staging);
      const sharingAfterStage = await sharedHostInstallReason(d.installDir, [process.pid, d.daemonPid]);
      if (sharingAfterStage) throw new Error(sharingAfterStage);
    }
    // The daemon blocks new children for the entire persisted running operation.
    if (readHostUpdateState()?.operation.id !== d.id || readHostUpdateState()?.operation.state !== "running") throw new Error("Host update no longer owns the operation");
    validateDescriptor(path);
    if (d.restartOnly && !(await installedHostVersionMatches(d.installMethod, d.installDir, d.version))) throw new Error(restartCandidateMissing);
    await stopDaemon(d, d.daemonPid);
    stopped = true;
    if (release) {
      backup = join(dirname(d.installDir), `.ompweb-backup-${d.id}`);
      if (existsSync(backup)) throw new Error("Host backup directory already exists");
      renameSync(d.installDir, backup);
      try { renameSync(release, d.installDir); swapped = true; } catch (error) { renameSync(backup, d.installDir); backup = undefined; throw error; }
    }
    await launchDaemon(d, join(dirname(path), "health.json"), d.version);
    finishHostUpdate(d.id);
    return 0;
  } catch (error) {
    if (!d) {
      try {
        const state = readHostUpdateState();
        if (state?.operation.state === "running" && state.operation.target === "ompweb" && resolve(path) === join(hostUpdateRoot(), state.operation.id, "descriptor.json")) finishHostUpdate(state.operation.id, error instanceof Error ? error.message : String(error));
      } catch {}
    }
    let message = error instanceof Error ? error.message : String(error);
    if (d?.restartOnly && stopped) message += "; existing shared installation retained; the previous loaded runtime cannot be restored without reinstalling";
    if (d && stopped && !d.restartOnly && !(error instanceof UnsafeHostRestartError)) {
      try {
        if (swapped && backup) {
          renameSync(d.installDir, join(dirname(d.installDir), `.ompweb-failed-${d.id}`));
          renameSync(backup, d.installDir);
        }
        await launchDaemon(d, join(dirname(path), "health.json"), d.fromVersion);
        message += "; previous host release restored";
      } catch (rollbackError) { message += `; rollback/restart failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`; }
    }
    if (d) finishHostUpdate(d.id, message);
    return 1;
  } finally {
    // Only this attempt's newly-created staging directory can be removed.
    if (stagingCreated && staging && existsSync(staging)) { assertOwnedPath(staging, true); rmSync(staging, { recursive: true, force: true }); }
    // Only this attempt's own leftovers; its failed candidate stays for diagnosis until the next update.
    try { if (d) pruneHostUpdateArtifacts(d.installDir, { keepAttempt: d.id }); } catch { /* retried at the next update */ }
  }
}

if (process.argv[2] === "--host-update-descriptor" && process.argv[3]) {
  void runHostUpdateWorker(process.argv[3]).then((code) => { process.exitCode = code; });
}
