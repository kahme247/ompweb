// Old daemons copy only this file. Keep its startup Node-only and load lifecycle code before any swap, from private copies or the descriptor's verified installation.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGunzip, inflateRawSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { HostUpdateOperation, HostUpdateTarget } from "./update-types";
import type { UpgradeLaunch, UpgradeProcess } from "../upgrade-process";
import type * as ProcessRuntime from "../upgrade-process";
import type * as IdentityRuntime from "../process-identity";
import type * as JitiRuntime from "jiti";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setTimeout as pause } from "node:timers/promises";
const exec = promisify(execFile);
// A prerelease archive carries ompweb (~112 MB) plus its omp runner (~284 MB on linux-x64, ~172 MB gzipped), and a
// release's runner asset (lib/omp/runner-fetch.ts) is held to the member limit: sized with headroom for both.
// scripts/check-host-release-archive.ts holds every built archive to these in CI.
export const HOST_RELEASE_MAX_ARCHIVE = 512 * 1024 * 1024;
export const HOST_RELEASE_MAX_EXPANDED = 1024 * 1024 * 1024;
export const HOST_RELEASE_MAX_MEMBER = 512 * 1024 * 1024;
/** The whole release download (or npm install): 512 MiB in 15 min needs about 5 Mbit/s. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
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
  /** The daemon as inspected when claimed: its process identity and verified supervisor, persisted verbatim. stop/restart re-verify it. Absent on a descriptor an earlier engine wrote: the worker inspects the still-running daemon itself. */
  process?: UpgradeProcess;
  /** Earlier engines' proof of the daemon's identity (a recycled pid is never signalled); only read when `process` is absent. */
  daemonIdentity?: string | null;
  managerPath?: string;
  restartOnly?: boolean;
  /** Binary release source; absent only on a legacy restart-only descriptor, which downloads nothing. */
  releaseRepo?: string;
  /** Explicitly approved to end this host's activity: bypasses only the activity wait, never any release or process check. */
  force?: boolean;
  /** The protocol range the candidate must speak for a maintenance receipt to acknowledge it, while its application protocol may await the server's cutover. */
  receipt?: { min: number; max: number };
  /** Set by the recovery CLI: the old daemon was drained (idle proven) through its private control endpoint, and is resumed if this update fails before it is stopped. */
  recovery?: { drained: boolean };
}
interface WorkerRuntime {
  process: typeof ProcessRuntime;
  identity: typeof IdentityRuntime;
}

async function workerRuntime(d: HostUpdateDescriptor): Promise<WorkerRuntime> {
  // Runtime-selected: a copied worker cannot import these statically (its `../` specifiers resolve outside the attempt directory).
  const embedded = async () => ({ process: await import("../upgrade-process"), identity: await import("../process-identity") });
  // A compiled binary embeds these modules; its worker has no copies beside it.
  if (typeof Bun !== "undefined" && Bun.isStandaloneExecutable) return embedded();
  // A copied worker (Node or Bun alike) imports the private copies the engine made beside it.
  const directory = dirname(fileURLToPath(import.meta.url));
  const lifecycle = join(directory, "upgrade-process.mts");
  const identity = join(directory, "process-identity.mts");
  if (existsSync(lifecycle) && existsSync(identity)) {
    return { process: await import(pathToFileURL(lifecycle).href), identity: await import(pathToFileURL(identity).href) };
  }
  // Run from source under Bun (the web server's own runtime, tests).
  if (typeof Bun !== "undefined") return embedded();
  // A legacy restart-only updater copied no dependencies. validateDescriptor checked this owned package and its identity first.
  const { createJiti } = createRequire(join(d.installDir, "package.json"))("jiti") as typeof JitiRuntime;
  const jiti = createJiti(import.meta.url);
  return {
    process: await jiti.import<typeof ProcessRuntime>(join(d.installDir, "lib", "upgrade-process.ts")),
    identity: await jiti.import<typeof IdentityRuntime>(join(d.installDir, "lib", "process-identity.ts")),
  };
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

async function readHostUpdate(url: string, maxBytes: number, timeout: number, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { "User-Agent": "ompweb-host-updater" } });
    if (!response.ok || !response.body) throw new Error(`Release request failed (${response.status})`);
    if (response.url && (!response.url.startsWith("https://") || !["raw.githubusercontent.com", "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(new URL(response.url).hostname))) throw new Error("Unexpected release download destination");
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Release response is too large");
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxBytes) throw new Error("Release response is too large");
        onChunk(item.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  } finally { clearTimeout(timer); }
}
export async function fetchHostUpdateBytes(url: string, maxBytes: number, timeout = 5000): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  await readHostUpdate(url, maxBytes, timeout, (chunk) => { chunks.push(chunk); });
  return Buffer.concat(chunks);
}
/** Streams the response into a new `file` (never whole in memory); returns its `sha256:<hex>` digest. */
export async function downloadHostUpdateFile(url: string, file: string, maxBytes: number, timeout = DOWNLOAD_TIMEOUT_MS): Promise<string> {
  const hash = createHash("sha256");
  const fd = openSync(file, "wx", 0o600);
  try { await readHostUpdate(url, maxBytes, timeout, (chunk) => { writeSync(fd, chunk); hash.update(chunk); }); }
  finally { closeSync(fd); }
  return `sha256:${hash.digest("hex")}`;
}
export function hostReleaseName(platform = process.platform, arch = process.arch): string {
  if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch) || (platform === "win32" && arch !== "x64")) throw new Error(`Host updates are unsupported on ${platform}/${arch}`);
  return `ompweb-${platform === "win32" ? "windows" : platform}-${arch}`;
}
interface ArchiveMember { name: string; directory: boolean; size: number; write(file: string): void }
function memberName(name: string, root: string): string {
  const normalized = name.replace(/\/$/, "");
  if (normalized.includes("\\") || normalized.includes(":") || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === ".." || part === "." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || [...part].some((char) => char.charCodeAt(0) < 32)) || (normalized !== root && !normalized.startsWith(`${root}/`))) throw new Error("Unsafe release archive member path");
  return normalized;
}
/** Checks every member of a tar or ZIP (bytes, or an open file descriptor) before anything is written; each member's
 * `write` then copies (tar, stored ZIP) or inflates (deflated ZIP) only that member. */
export function validateHostReleaseArchive(input: Uint8Array | number, root: string): ArchiveMember[] {
  const length = typeof input === "number" ? fstatSync(input).size : input.length;
  const read = (position: number, count: number): Buffer => {
    count = Math.max(0, Math.min(count, length - position));
    if (typeof input !== "number") return Buffer.from(input.buffer, input.byteOffset + position, count);
    const buffer = Buffer.allocUnsafe(count);
    let done = 0;
    while (done < count) {
      const n = readSync(input, buffer, done, count - done, position + done);
      if (!n) throw new Error("Release archive is truncated");
      done += n;
    }
    return buffer;
  };
  const copy = (start: number, size: number) => (file: string) => {
    const fd = openSync(file, "wx", 0o644);
    try { for (let done = 0; done < size; done += 8 * 1024 * 1024) writeSync(fd, read(start + done, Math.min(8 * 1024 * 1024, size - done))); }
    finally { closeSync(fd); }
  };
  const entries: ArchiveMember[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  const add = (name: string, directory: boolean, size: number, write: (file: string) => void) => {
    name = memberName(name, root);
    if (!name || seen.has(name) || entries.length >= 20000) throw new Error("Invalid duplicate or excessive archive members");
    if (size > HOST_RELEASE_MAX_MEMBER || (expanded += size) > HOST_RELEASE_MAX_EXPANDED) throw new Error("Release member size is too large");
    seen.add(name); entries.push({ name, directory, size, write });
  };
  if (length >= 4 && read(0, 4).readUInt32LE(0) === 0x04034b50) {
    // Read central metadata first: Unix symlink attributes are not present in local headers.
    const tailStart = Math.max(0, length - 65557);
    const tail = read(tailStart, length - tailStart);
    let end = tail.length - 22;
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error("Invalid or multi-disk ZIP archive");
    const count = tail.readUInt16LE(end + 10);
    const centralStart = tail.readUInt32LE(end + 16);
    end += tailStart;
    if (count > 20000 || centralStart >= end) throw new Error("Invalid ZIP member count or offset");
    const central = read(centralStart, end - centralStart);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central member");
      const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10);
      const size = central.readUInt32LE(offset + 24), compressed = central.readUInt32LE(offset + 20);
      const nameLength = central.readUInt16LE(offset + 28), extraLength = central.readUInt16LE(offset + 30), commentLength = central.readUInt16LE(offset + 32);
      const mode = central.readUInt32LE(offset + 38) >>> 16;
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      if ((flags & 1) || ![0, 8].includes(method) || ((mode & 0o170000) !== 0 && ![0o100000, 0o040000].includes(mode & 0o170000))) throw new Error("Unsupported ZIP member type or encryption");
      if (size > HOST_RELEASE_MAX_MEMBER || expanded + size > HOST_RELEASE_MAX_EXPANDED) throw new Error("Release member size is too large");
      const local = central.readUInt32LE(offset + 42);
      const header = read(local, 30);
      if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP local member");
      const localNameLength = header.readUInt16LE(26), localExtraLength = header.readUInt16LE(28);
      if (read(local + 30, localNameLength).toString("utf8") !== name) throw new Error("ZIP member path mismatch");
      const start = local + 30 + localNameLength + localExtraLength;
      if (start + compressed > centralStart || (method === 0 && compressed !== size)) throw new Error("Invalid ZIP member size");
      add(name, name.endsWith("/"), size, method === 0 ? copy(start, size) : (file) => {
        const data = inflateRawSync(read(start, compressed), { maxOutputLength: HOST_RELEASE_MAX_MEMBER });
        if (data.length !== size) throw new Error("ZIP member size mismatch");
        writeFileSync(file, data, { mode: 0o644, flag: "wx" });
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  } else {
    for (let offset = 0; offset + 512 <= length;) {
      const header = read(offset, 512);
      if (header.every((byte) => byte === 0)) break;
      const text = (start: number, count: number) => header.subarray(start, start + count).toString("utf8").replace(/\0[\s\S]*$/, "");
      const name = text(345, 155) ? `${text(345, 155)}/${text(0, 100)}` : text(0, 100);
      memberName(name, root);
      const type = header[156];
      if (![0, 48, 53].includes(type)) throw new Error("Unsupported release member type (links are forbidden)");
      const sizeText = text(124, 12).trim();
      const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : NaN;
      if (!Number.isSafeInteger(size) || size > HOST_RELEASE_MAX_MEMBER || size < 0 || expanded + size > HOST_RELEASE_MAX_EXPANDED) throw new Error("Release member size is too large or invalid");
      const checksumText = text(148, 8).trim();
      const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
      if (!/^[0-7]+$/.test(checksumText) || parseInt(checksumText, 8) !== checksum || offset + 512 + size > length) throw new Error("Invalid release tar header or size");
      add(name, type === 53, size, copy(offset + 512, size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  }
  if (!entries.length) throw new Error("Empty release archive");
  return entries;
}
/** Unpacks a release archive (`.tar.gz`, or `.zip`) into `staging` through the checks above, without holding it in
 * memory: a `.tar.gz` is gunzipped to a scratch tar beside it first. Returns the members (only names and sizes stay valid). */
export async function extractHostReleaseArchive(archive: string, root: string, staging: string): Promise<ArchiveMember[]> {
  let source = archive;
  if (archive.endsWith(".tar.gz")) {
    source = archive.slice(0, -3);
    let size = 0;
    await pipeline(createReadStream(archive), createGunzip(), async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        // The tar adds a header and padding per member on top of the member bytes the parser bounds.
        if ((size += chunk.length) > HOST_RELEASE_MAX_EXPANDED + 64 * 1024 * 1024) throw new Error("Release archive expands too far");
        yield chunk;
      }
    }, createWriteStream(source, { flags: "wx", mode: 0o600 }));
  }
  const fd = openSync(source, "r");
  try {
    const members = validateHostReleaseArchive(fd, root);
    for (const member of members) {
      const file = join(staging, member.name);
      if (member.directory) mkdirSync(file, { recursive: true, mode: 0o755 });
      else {
        mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
        member.write(file);
      }
    }
    return members;
  } finally {
    closeSync(fd);
    if (source !== archive) rmSync(source, { force: true });
  }
}

export interface HostReleaseSource {
  version: string;
  /** `owner/repository` of the official GitHub release. */
  releaseRepo: string;
}
/** Downloads, digest-verifies and unpacks the official binary release `source` into the owned directory `staging`; returns the staged release directory. */
export async function stageBinary(source: HostReleaseSource, staging: string): Promise<string> {
  const name = hostReleaseName();
  const assetName = `${name}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;
  const metadata = JSON.parse((await fetchHostUpdateBytes(`https://api.github.com/repos/${source.releaseRepo}/releases/tags/v${source.version}`, 2 * 1024 * 1024)).toString("utf8")) as { tag_name?: string; assets?: { name: string; digest?: string }[] };
  const asset = metadata.assets?.find((item) => item.name === assetName);
  if (metadata.tag_name !== `v${source.version}` || !asset?.digest || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error("Official release asset digest is unavailable");
  const download = join(staging, assetName);
  if (await downloadHostUpdateFile(`https://github.com/${source.releaseRepo}/releases/download/v${source.version}/${assetName}`, download, HOST_RELEASE_MAX_ARCHIVE) !== asset.digest) throw new Error("Official release asset digest mismatch or unavailable");
  const release = join(staging, name);
  mkdirSync(release, { mode: 0o700 });
  try { await extractHostReleaseArchive(download, name, staging); } finally { rmSync(download, { force: true }); }
  const binary = join(release, process.platform === "win32" ? "ompweb.exe" : "ompweb");
  if (!existsSync(join(release, "dist", "index.html"))) throw new Error("Incomplete host binary release layout");
  chmodSync(binary, 0o755);
  // Releases from before the runner became its own asset (preflightHostRelease fetches it otherwise) carry it here.
  const runner = join(release, process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp");
  if (existsSync(runner)) chmodSync(runner, 0o755);
  if (!(await binaryReportsVersion(binary, release, source.version))) throw new Error("Downloaded host binary reports a different version");
  return release;
}
export interface HostPackageSource {
  version: string;
  installMethod: "npm" | "bun";
  /** The package manager's absolute path; absent, `installMethod` is looked up on PATH. */
  managerPath?: string;
}
/** Installs the pinned package `source` with its manager into the owned directory `staging`; returns the staged release directory with its `node_modules` moved inside. */
export async function stagePackage(d: HostPackageSource, staging: string): Promise<string> {
  const prefix = join(staging, "fetch");
  mkdirSync(prefix, { mode: 0o700 });
  writeFileSync(join(prefix, "package.json"), '{"private":true}', { mode: 0o600 });
  const packageName = `@kahme247/ompweb@${d.version}`;
  const args = d.installMethod === "bun" ? ["add", "--cwd", prefix, "--production", "--exact", "--registry=https://registry.npmjs.org", packageName] : ["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", packageName];
  const command = d.managerPath || d.installMethod;
  const windows = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  // `/s /c` strips one outer pair of quotes; verbatim so Node does not escape the inner ones (as Node's `shell: true`).
  const line = [command, ...args].map((arg) => `"${arg.replaceAll('"', '')}"`).join(" ");
  await exec(windows ? process.env.ComSpec || "cmd.exe" : command, windows ? ["/d", "/s", "/c", `"${line}"`] : args, { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: workerEnvironment(), windowsHide: true, windowsVerbatimArguments: windows });
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

/** The reason sharedHostInstallReason returns for an install an independent process uses: the one that only a coordinated web-server cutover resolves (every other reason is an inventory that failed). */
export const HOST_INSTALL_SHARED = "This installation is shared with another running process (possibly the web server); update it manually or use a dedicated host installation";
/**
 * Refuse an install shared with another daemon or web process; swapping it changes their on-disk assets too.
 * `ignoredPids` are skipped. `ownedTrees` also skips every descendant of those pids: a daemon's sessions and subagents run
 * the installed runner, and stopping that daemon (never an independent process) ends them.
 */
export async function sharedHostInstallReason(installDir: string, ignoredPids: number[] = [process.pid], ownedTrees: number[] = []): Promise<string | null> {
  const shared = HOST_INSTALL_SHARED;
  const inside = (path: string) => {
    try { const value = relative(installDir, realpathSync(path)); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); } catch { return false; }
  };
  const parents = new Map<number, number>();
  const ignored = (pid: number) => {
    if (ignoredPids.includes(pid)) return true;
    for (let at = pid, hops = 0; at > 1 && hops < 256; at = parents.get(at) ?? 0, hops++) if (ownedTrees.includes(at)) return true;
    return false;
  };
  if (process.platform === "linux") {
    const pids = readdirSync("/proc").map(Number).filter((pid) => Number.isInteger(pid));
    // After the parenthesised command name: state is field 3, parent pid field 4. A process that cannot be read keeps no parent, so it is never taken for a descendant.
    for (const pid of pids) { try { parents.set(pid, Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[1])); } catch { /* gone or unreadable */ } }
    for (const pid of pids) {
      if (ignored(pid)) continue;
      const id = String(pid);
      try {
        const args = readFileSync(`/proc/${id}/cmdline`, "utf8").split("\0").filter(Boolean);
        // A non-dumpable process (e.g. started with capabilities) hides its cwd and exe, not its arguments: resolve
        // relative ones from the install, where a process sharing it would start.
        // shortcut: misses a sharer started from a subdirectory with relative arguments; read the cwd via ptrace if seen.
        let cwd = installDir;
        try { cwd = readlinkSync(`/proc/${id}/cwd`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error; }
        if (inside(`/proc/${id}/exe`) || args.slice(0, 4).some((arg) => !arg.startsWith("-") && inside(isAbsolute(arg) ? arg : resolve(cwd, arg)))) return shared;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") {
          try { if (!process.getuid || lstatSync(`/proc/${id}`).uid === process.getuid()) return "Cannot establish that this installation is host-only; update it manually"; } catch {}
        }
      }
    }
    return null;
  }
  try {
    // Cold CIM startup can exceed five seconds on contended Windows hosts.
    const { stdout } = process.platform === "win32"
      ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"], { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
      : await exec("ps", ["-axo", "pid=,ppid=,command="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const rows: { pid: number; ppid: number; command: string; executable?: string }[] = process.platform === "win32"
      ? (JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; CommandLine: string; ExecutablePath: string }[]).map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine || "", executable: row.ExecutablePath }))
      : stdout.split("\n").flatMap((line) => { const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []; });
    for (const row of rows) parents.set(row.pid, row.ppid);
    for (const row of rows) {
      if (ignored(row.pid)) continue;
      const command = process.platform === "win32" ? row.command.toLowerCase().replaceAll("\\", "/") : row.command;
      const root = process.platform === "win32" ? installDir.toLowerCase().replaceAll("\\", "/") : installDir;
      if ((row.executable && inside(row.executable)) || command.includes(`${root}/`) || row.command.split(/\s+/).some((arg) => inside(arg.replace(/^"|"$/g, "")))) return shared;
    }
    return null;
  } catch { return "Cannot establish that this installation is host-only; update it manually"; }
}

/** How a host in `installDir` is started: what the supervisor-aware restart runs, and what is inspected at claim time. */
export function hostLaunch(d: Pick<HostUpdateDescriptor, "installMethod" | "installDir" | "runtime" | "hostArgs" | "cwd">): UpgradeLaunch {
  const binary = d.installMethod === "binary";
  return {
    command: binary ? join(d.installDir, process.platform === "win32" ? "ompweb.exe" : "ompweb") : d.runtime,
    args: binary ? ["host", ...d.hostArgs] : [join(d.installDir, "bin", "omp-web-host.js"), ...d.hostArgs],
    cwd: d.cwd,
    env: workerEnvironment(),
  };
}

/** `<binary> --version` printed the exact version (a leading v is allowed). */
async function binaryReportsVersion(binary: string, packageDir: string, version: string): Promise<boolean> {
  const { stdout } = await exec(binary, ["--version"], { timeout: 10000, env: workerEnvironment({ OMP_WEB_PACKAGE_DIR: packageDir }), maxBuffer: 1024 * 1024 });
  return stdout.trim().split(/\s+/).some((token) => token.replace(/^v/, "") === version);
}
/** PREFLIGHT_MARKER (lib/hosts/preflight.ts), encoded so this module, bundled into the same binary, does not embed it. */
export const PREFLIGHT_MARKER_BASE64 = "b21wd2ViLXByZWZsaWdodC1zY3JhdGNoLQ==";
export interface HostReleasePreflightInput {
  installMethod: "npm" | "bun" | "binary";
  version: string;
  /** The JavaScript runtime that runs an npm/bun release; not used for a binary one. */
  runtime?: string;
  /** The release already runs here: a candidate that predates the preflight command is restarted unchecked instead of refused. */
  restartOnly?: boolean;
}
/** The candidate's `ompweb fetch-omp` (lib/omp/runner-fetch.ts: its omp runner from its own release, unless it has
 * one), then its `ompweb preflight` (lib/hosts/preflight.ts) in this host's environment: the session omp it resolves
 * must start and say hello before the switch. A new binary release without the preflight command is refused (it
 * would run a runner unchecked); a restart-only update of an install that predates the command restarts what already
 * runs. */
export async function preflightHostRelease(d: HostReleasePreflightInput, release: string): Promise<void> {
  const binary = d.installMethod === "binary";
  const entry = binary ? join(release, process.platform === "win32" ? "ompweb.exe" : "ompweb") : join(release, "bin", "omp-web.js");
  // Detected statically: an older ompweb takes `preflight` for a positional and starts the web server.
  if (!(binary ? readFileSync(entry).includes(Buffer.from(PREFLIGHT_MARKER_BASE64, "base64")) : existsSync(join(release, "lib", "hosts", "preflight.ts")))) {
    if (binary && !d.restartOnly) throw new Error("The new host release has no preflight command to check its omp with");
    console.warn(`ompweb ${d.version} has no preflight command; its omp was not checked`);
    return;
  }
  const command = (args: string[], timeout: number) => exec(binary ? entry : d.runtime!, binary ? args : [entry, ...args], { cwd: release, timeout, env: workerEnvironment(), maxBuffer: 1024 * 1024, windowsHide: true });
  const detail = (error: unknown) => (String((error as { stderr?: unknown }).stderr ?? "").trim() || (error instanceof Error ? error.message : String(error))).slice(-500);
  // A binary release with the preflight command and no runner beside it has `fetch-omp`; every npm one that has
  // runner-fetch.ts does (an npm package never carries the runner).
  if (binary ? !existsSync(join(release, process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp")) : existsSync(join(release, "lib", "omp", "runner-fetch.ts"))) {
    try { await command(["fetch-omp"], DOWNLOAD_TIMEOUT_MS); }
    catch (error) { throw new Error(`The new host release could not fetch its omp: ${detail(error)}`); }
  }
  try {
    // 120 s: the preflight itself can take 30 s for the hello, 7 s to stop omp and 30 s for the version probe.
    await command(["preflight"], 120000);
  } catch (error) {
    throw new Error(`The new host release cannot start a session: ${detail(error)}`);
  }
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
    for (const heavy of readdirSync(dir)) if (/^runtime(\.exe)?$|\.mts$/.test(heavy)) { try { rmSync(join(dir, heavy), { force: true }); } catch { /* locked: retried next update */ } }
    if (id !== state?.operation.id && id !== keepBackup && id !== options.keepAttempt && !leftover.has(id)) removeOwnedTree(dir);
  }
}

class UnsafeHostRestartError extends Error {}
/**
 * Stops the daemon through its inspected supervisor, which waits for it to end. A daemon ending many sessions can
 * outlast one stop's wait; only a forced update gives it more, and only while it is still the process inspected (every
 * attempt re-verifies that). An error after the daemon is gone is not one.
 */
async function stopDaemon(plan: UpgradeProcess, pid: number, force: boolean, runtime: WorkerRuntime): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await runtime.process.stopUpgradeProcess(plan); }
    catch (error) { if (!runtime.identity.isProcessAlive(pid)) return; if (!force || attempt >= 5) throw error; }
  }
}
/** After a stop, nothing may still hold the installation (an orphaned session, a scanner): the swap would fail or tear it. */
async function waitUnshared(installDir: string): Promise<void> {
  for (const deadline = Date.now() + 15000; ; await pause(500)) {
    const sharing = await sharedHostInstallReason(installDir, [process.pid]);
    if (!sharing) return;
    if (Date.now() > deadline) throw new Error(`${sharing} Stopping the host did not free it.`);
  }
}
/** Renames a release directory. Windows keeps a directory while any file in it is open (a process still exiting, a virus scan): retry briefly, then fail with the original error. */
export async function moveHostRelease(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return renameSync(from, to); }
    catch (error) {
      if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 40) throw error;
      await pause(250);
    }
  }
}
/** The daemon's verified process and supervisor: the snapshot the claim persisted or, for a descriptor an earlier engine wrote, inspected now against its recorded identity. */
async function daemonProcess(d: HostUpdateDescriptor, runtime: WorkerRuntime): Promise<UpgradeProcess> {
  if (d.process) return d.process;
  if (!runtime.identity.isProcessAlive(d.daemonPid)) throw new Error("The host daemon is no longer running, so its supervisor cannot be inspected; restart it manually");
  if (d.daemonIdentity && await runtime.identity.processStartIdentity(d.daemonPid) !== d.daemonIdentity) throw new Error("The recorded host daemon is no longer the process with this pid (process identity mismatch); refusing to signal it");
  return runtime.process.inspectUpgradeProcess({ pid: d.daemonPid, installDir: d.installDir, role: "host", launch: hostLaunch(d) });
}
/** A forced update's commit: from here the daemon accepts no new sessions (it reads this file at each start). */
function markCommitting(id: string): void {
  const state = readHostUpdateState();
  if (state?.operation.id !== id || state.operation.state !== "running") throw new Error("Host update no longer owns the operation");
  writeHostUpdateJson(join(hostUpdateRoot(), "status.json"), { ...state, operation: { ...state.operation, committing: true } });
}
/** Proof that this operation's candidate passed its preflight: a candidate echoes `nonce` in a maintenance receipt. */
function recordPreflight(d: HostUpdateDescriptor): string {
  const nonce = randomUUID();
  writeHostUpdateJson(join(hostUpdateRoot(), d.id, "preflight.json"), { id: d.id, version: d.version, nonce });
  return nonce;
}
/** Only the recovery CLI's drained old daemon (descriptor.recovery): put it back to work, because nothing was stopped. A static import cannot work: this file is copied alone outside an npm install, which never has that descriptor and has no host-control module beside it; the binary that runs a recovery bundles it. */
async function resumeDrainedDaemon(): Promise<void> {
  const { requestHostControl } = await import("./host-control");
  await requestHostControl("resume");
}
/**
 * Restarts the host through its inspected supervisor and waits for its acknowledgement. Only the instance launched here
 * may vouch. A maintenance receipt (marker.receipt) is accepted only when this operation asked for one (descriptor.receipt)
 * and it carries the preflight nonce and a protocol inside the approved range: a bare maintenance connection never counts.
 * Whatever fails, the candidate is stopped again through the same supervisor before anything is rolled back.
 */
async function launchDaemon(d: HostUpdateDescriptor, plan: UpgradeProcess, runtime: WorkerRuntime, health: string, expected: string, nonce?: string): Promise<number> {
  if (existsSync(health)) { assertOwnedPath(health); rmSync(health); }
  const deadline = Date.now() + 30000;
  try {
    const launched = (await runtime.process.restartUpgradeProcess(plan, hostLaunch(d))) ?? plan.current.pid ?? undefined;
    while (Date.now() < deadline) {
      if (existsSync(health)) {
        assertOwnedPath(health);
        const marker = JSON.parse(readFileSync(health, "utf8"));
        const vouches = launched !== undefined
          ? marker.pid === launched
          : marker.pid !== d.daemonPid && marker.pid !== process.pid && (marker.identity === undefined || marker.identity === await runtime.identity.processStartIdentity(marker.pid));
        if (marker.id === d.id && vouches && runtime.identity.isProcessAlive(marker.pid)) {
          if (marker.version !== expected) throw new Error(`Host acknowledged version ${marker.version}, expected ${expected}`);
          if (marker.receipt !== undefined && (!d.receipt || !nonce || marker.receipt !== nonce || !(marker.protocol >= d.receipt.min && marker.protocol <= d.receipt.max))) throw new Error("The host's maintenance receipt does not match this operation's release proof and approved protocol range");
          return marker.pid;
        }
      }
      if (launched !== undefined && !runtime.identity.isProcessAlive(launched)) throw new Error("Updated host exited before health acknowledgement");
      await pause(100);
    }
    throw new Error("Host launch did not acknowledge healthy reconnect within 30 seconds");
  } catch (error) {
    try { await runtime.process.stopUpgradeProcess(plan); }
    catch (stopError) { throw new UnsafeHostRestartError(`Failed candidate could not be stopped; backup retained, no duplicate daemon started: ${String(stopError)}`); }
    throw error;
  }
}
function validateDescriptor(path: string): HostUpdateDescriptor {
  const root = ensureHostUpdateRoot();
  assertOwnedPath(path);
  const d = JSON.parse(readFileSync(path, "utf8")) as HostUpdateDescriptor & { systemd?: { unit?: unknown; user?: unknown } | null };
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(d.id) || resolve(path) !== join(root, d.id, "descriptor.json") || !HOST_VERSION_PATTERN.test(d.version) || !HOST_VERSION_PATTERN.test(d.fromVersion) || d.target !== "ompweb" || !["npm", "bun", "binary"].includes(d.installMethod) || !isAbsolute(d.installDir) || !isAbsolute(d.runtime) || !isAbsolute(d.cwd) || !Number.isSafeInteger(d.daemonPid) || d.daemonPid <= 1 || !Array.isArray(d.hostArgs) || d.hostArgs.some((arg) => arg !== "--allow-http")) throw new Error("Invalid host update descriptor");
  // A v10 daemon copies this new worker after the shared web installation has already been replaced.
  if (d.releaseRepo === undefined ? d.restartOnly !== true : typeof d.releaseRepo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(d.releaseRepo)) throw new Error("Invalid host update descriptor");
  if (d.restartOnly !== undefined && typeof d.restartOnly !== "boolean") throw new Error("Invalid host restart-only descriptor");
  if (d.force !== undefined && typeof d.force !== "boolean") throw new Error("Invalid host update descriptor");
  if (d.receipt !== undefined && (!d.receipt || !Number.isSafeInteger(d.receipt.min) || !Number.isSafeInteger(d.receipt.max) || d.receipt.min < 1 || d.receipt.max < d.receipt.min)) throw new Error("Invalid host update descriptor: the approved protocol range");
  if (d.recovery !== undefined && (!d.recovery || typeof d.recovery.drained !== "boolean")) throw new Error("Invalid host update descriptor");
  // The daemon's process snapshot, or what an earlier engine recorded instead: an identity, or the service it had verified.
  if (d.process !== undefined ? typeof d.process !== "object" || d.process === null || Array.isArray(d.process) : !(d.systemd || (typeof d.daemonIdentity === "string" && d.daemonIdentity && d.daemonIdentity.length <= 200))) throw new Error("Invalid host update descriptor: the daemon's process identity is missing");
  assertOwnedPath(dirname(path), true);
  const state = readHostUpdateState();
  if (state?.operation.id !== d.id || state.operation.state !== "running" || state.operation.version !== d.version || state.daemonPid !== d.daemonPid) throw new Error("Host update descriptor does not own the running operation");
  if (d.systemd && (typeof d.systemd.unit !== "string" || !/^[a-zA-Z0-9_.@\\:-]+\.service$/.test(d.systemd.unit) || /^ompweb-api(?:[.@-]|$)/i.test(d.systemd.unit) || typeof d.systemd.user !== "boolean")) throw new Error("Refusing to control a non-host service");
  const info = lstatSync(d.installDir);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(d.installDir) !== resolve(d.installDir) || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o022))) throw new Error("Unsupported or unsafe host installation layout");
  const parent = lstatSync(dirname(d.installDir));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid()) || (process.platform !== "win32" && (parent.mode & 0o022))) throw new Error("Unsafe host installation parent directory");
  if (d.installMethod === "binary") {
    hostReleaseName();
    if (!existsSync(join(d.installDir, process.platform === "win32" ? "ompweb.exe" : "ompweb")) || !existsSync(join(d.installDir, "dist", "index.html")) || !existsSync(join(d.installDir, process.platform === "win32" ? "ompweb-omp.exe" : "ompweb-omp"))) throw new Error("Incomplete host binary release layout");
  } else {
    if (basename(d.installDir) !== "ompweb" || basename(dirname(d.installDir)) !== "@kahme247" || basename(dirname(dirname(d.installDir))) !== "node_modules") throw new Error("Package updates require an installed npm/bun package layout");
    const current = JSON.parse(readFileSync(join(d.installDir, "package.json"), "utf8"));
    if (current.name !== "@kahme247/ompweb" || (!d.restartOnly && current.version !== d.fromVersion)) throw new Error("Host install changed since this update was requested");
  }
  return d;
}
export async function runHostUpdateWorker(path: string): Promise<number> {
  let d: HostUpdateDescriptor | undefined;
  let plan: UpgradeProcess | undefined;
  let runtime: WorkerRuntime | undefined;
  let backup: string | undefined;
  let stopped = false;
  let swapped = false;
  let staging: string | undefined;
  let stagingCreated = false;
  try {
    d = validateDescriptor(path);
    runtime = await workerRuntime(d);
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
    plan = await daemonProcess(d, runtime);
    let release: string | undefined;
    if (!d.restartOnly) {
      // The daemon's own sessions and subagents run the installed runner; stopping the daemon ends them, so they are not sharers. Anything else is.
      const sharing = await sharedHostInstallReason(d.installDir, [process.pid], [d.daemonPid]);
      if (sharing) throw new Error(`Update the web server first because this installation is shared. ${sharing}`);
      staging = join(dirname(d.installDir), `.ompweb-staging-${d.id}`);
      mkdirSync(staging, { mode: 0o700 });
      stagingCreated = true;
      if (!d.releaseRepo) throw new Error("The host update has no verified release repository");
      release = d.installMethod === "binary"
        ? await stageBinary({ version: d.version, releaseRepo: d.releaseRepo }, staging)
        : await stagePackage({ version: d.version, installMethod: d.installMethod, managerPath: d.managerPath }, staging);
      const sharingAfterStage = await sharedHostInstallReason(d.installDir, [process.pid], [d.daemonPid]);
      if (sharingAfterStage) throw new Error(sharingAfterStage);
    }
    await preflightHostRelease(d, release ?? d.installDir);
    const nonce = d.receipt ? recordPreflight(d) : undefined;
    // Normally the daemon blocks new children for the entire persisted running operation; a forced one only from its commit.
    if (readHostUpdateState()?.operation.id !== d.id || readHostUpdateState()?.operation.state !== "running") throw new Error("Host update no longer owns the operation");
    validateDescriptor(path);
    if (d.restartOnly && !(await installedHostVersionMatches(d.installMethod, d.installDir, d.version))) throw new Error(restartCandidateMissing);
    if (d.force) markCommitting(d.id);
    // The supervisor stops the daemon (a forced one ends its sessions with it, after the daemon has preserved its resume manifest).
    if (runtime.identity.isProcessAlive(d.daemonPid)) {
      try { await stopDaemon(plan, d.daemonPid, d.force === true, runtime); }
      catch (error) { stopped = !runtime.identity.isProcessAlive(d.daemonPid); throw error; }
    }
    stopped = true;
    if (release) {
      await waitUnshared(d.installDir);
      backup = join(dirname(d.installDir), `.ompweb-backup-${d.id}`);
      if (existsSync(backup)) throw new Error("Host backup directory already exists");
      await moveHostRelease(d.installDir, backup);
      try { await moveHostRelease(release, d.installDir); swapped = true; } catch (error) { await moveHostRelease(backup, d.installDir); backup = undefined; throw error; }
    }
    await launchDaemon(d, plan, runtime, join(dirname(path), "health.json"), d.version, nonce);
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
    if (d?.recovery?.drained && !stopped) {
      try { await resumeDrainedDaemon(); }
      catch (resumeError) { message += `; the old host stays drained and must be resumed with \`ompweb host resume\`: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`; }
    }
    if (d?.restartOnly && stopped) message += "; existing shared installation retained; the previous loaded runtime cannot be restored without reinstalling";
    if (d && plan && runtime && stopped && !d.restartOnly && !(error instanceof UnsafeHostRestartError)) {
      try {
        if (swapped && backup) {
          await moveHostRelease(d.installDir, join(dirname(d.installDir), `.ompweb-failed-${d.id}`));
          await moveHostRelease(backup, d.installDir);
        }
        await launchDaemon(d, plan, runtime, join(dirname(path), "health.json"), d.fromVersion);
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

if (process.argv[2] === "--host-update-descriptor" && process.argv[3] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void runHostUpdateWorker(process.argv[3]).then((code) => { process.exitCode = code; });
}
