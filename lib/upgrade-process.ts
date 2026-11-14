// Copied outside the install next to the host update worker: keep it self-contained (node:* and ./process-identity only), Node 24 compatible.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { isProcessAlive, processStartIdentity } from "./process-identity";

const exec = promisify(execFile);

export interface UpgradeLaunch {
  command: string;
  args: string[];
  cwd: string;
  /** The complete environment of the launched process; the caller's own when omitted. */
  env?: NodeJS.ProcessEnv;
}

/** What starts the process again after it stops, as verified at inspection. Each snapshot is re-verified before any stop or restart. */
export type UpgradeSupervisor =
  | { kind: "foreground" }
  | { kind: "systemd"; unit: string; user: boolean; configHash: string }
  | { kind: "launchd"; label: string; domain: string; plist: string; configHash: string }
  | { kind: "restart-loop"; pid: number; identity: string; script: string; configHash: string }
  | { kind: "windows-service"; name: string; configHash: string }
  | { kind: "windows-task"; path: string; name: string; scripts: string[]; configHash: string };

/** One running instance: both null when a restarted supervisor's new process could not be told apart. */
export interface UpgradeInstance { pid: number | null; identity: string | null }

/** Plain JSON. `pid`/`identity` are the process inspected; `current` is the instance a stop acts on (restartUpgradeProcess replaces it in place). */
export interface UpgradeProcess {
  role: "server" | "host";
  platform: NodeJS.Platform;
  pid: number;
  identity: string;
  executable: string;
  args: string[];
  installDir: string;
  supervisor: UpgradeSupervisor;
  current: UpgradeInstance;
}

const STOP_TIMEOUT_MS = 10000;
const MIB = 1024 * 1024;
const UNIT_NAME = /^(?!-)[a-zA-Z0-9_.@\\:-]+\.service$/;
const LAUNCHD_LABEL = /^[A-Za-z0-9_.-]{1,200}$/;
const LOOP_KEYWORD = /(?:^|[\s;&|(])(?:while|until|for)\s/m;
const SHELL = /^(?:sh|bash|zsh|dash|ksh|fish|tcsh|csh)$/;

function fail(message: string): never { throw new Error(message); }
const messageOf = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return (typeof stderr === "string" && stderr.trim()) || (error instanceof Error ? error.message : String(error));
};
function sha256(...parts: (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) { hash.update(`${part.length}:`); hash.update(part); }
  return hash.digest("hex");
}
/** A file's digest ("missing" or a size when it is not a small regular file): a snapshot input, never a trust decision. */
function fileDigest(path: string): string {
  try {
    const info = statSync(path);
    return info.isFile() && info.size <= MIB ? sha256(readFileSync(path)) : `unreadable:${info.size}`;
  } catch { return "missing"; }
}
function inside(root: string, path: string): boolean {
  try {
    const value = relative(realpathSync(root), realpathSync(path));
    return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
  } catch { return false; }
}
/** POSIX: the file and its directory belong to root or this user and nobody else can write them. Windows: it exists. */
function assertTrustedFile(path: string, what: string): void {
  if (!existsSync(path)) fail(`${what} ${path} does not exist`);
  if (process.platform === "win32") return;
  const real = realpathSync(path);
  const file = statSync(real);
  const uid = process.getuid?.();
  const trusted = (info: Stats, sticky: boolean) => (info.uid === 0 || info.uid === uid) && ((info.mode & 0o022) === 0 || (sticky && (info.mode & 0o1000) !== 0));
  if (!file.isFile() || !trusted(file, false) || !trusted(statSync(dirname(real)), true)) fail(`${what} ${real} is not an owned file that only its owner can change`);
}

// ---------------------------------------------------------------- processes

interface ProcessInfo { pid: number; ppid: number; state: string; exe: string; args: string[]; cwd: string | null; created: string | null }

/** CommandLineToArgvW's rules: whitespace separates arguments, quotes group, backslashes escape only before a quote. */
function splitWindowsCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      let slashes = 0;
      while (line[i] === "\\") { slashes++; i++; }
      started = true;
      if (line[i] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) current += '"'; else quoted = !quoted;
      } else { current += "\\".repeat(slashes); i--; }
    } else if (ch === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(ch) && !quoted) { if (started) { args.push(current); current = ""; started = false; } }
    else { current += ch; started = true; }
  }
  if (started) args.push(current);
  return args;
}

function powershellBinary(): string {
  const path = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(path) ? path : "powershell.exe";
}
/** A PowerShell expression for `value`, immune to quoting. */
const psString = (value: string): string => `([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`;
const psStrings = (values: string[]): string => `@(${values.map(psString).join(",")})`;
const encodePowershell = (script: string): string => Buffer.from(script, "utf16le").toString("base64");
/** Runs `script` in Windows PowerShell; a failure carries its message, not CLIXML. */
async function powershell(script: string, timeout = 60000): Promise<string> {
  const wrapped = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\ntry {\n${script}\n} catch { [Console]::Error.WriteLine([string]$_.Exception.Message); exit 1 }`;
  try {
    const { stdout } = await exec(powershellBinary(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowershell(wrapped)], { timeout, windowsHide: true, maxBuffer: 16 * MIB, encoding: "utf8" });
    return stdout;
  } catch (error) { return fail(`PowerShell failed: ${messageOf(error)}`); }
}
function parseJson<T>(text: string, what: string): T {
  try { return JSON.parse(text) as T; } catch { return fail(`Unreadable ${what}: ${text.slice(0, 200)}`); }
}

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "linux") {
    const rows: ProcessInfo[] = [];
    for (const id of readdirSync("/proc")) {
      const pid = Number(id);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        const stat = readFileSync(`/proc/${id}/stat`, "utf8");
        const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const link = (name: string) => { try { return readlinkSync(`/proc/${id}/${name}`).replace(/ \(deleted\)$/, ""); } catch { return null; } };
        rows.push({ pid, ppid: Number(ppid), state, exe: link("exe") ?? "", args: readFileSync(`/proc/${id}/cmdline`, "utf8").split("\0").filter(Boolean), cwd: link("cwd"), created: null });
      } catch { /* exited while listing */ }
    }
    return rows;
  }
  if (process.platform === "win32") {
    const out = await powershell(`$rows = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine; created = $(if ($_.CreationDate) { [string]$_.CreationDate.ToUniversalTime().Ticks } else { '' }) } })\nConvertTo-Json -Compress -InputObject $rows`, 120000);
    return parseJson<{ pid: number; ppid: number; exe: string; cmd: string; created: string }[]>(out, "process list").map((row) => ({ pid: row.pid, ppid: row.ppid, state: "R", exe: row.exe, args: splitWindowsCommandLine(row.cmd), cwd: null, created: row.created || null }));
  }
  const env = { ...process.env, LC_ALL: "C" };
  const [commands, names] = await Promise.all([
    exec("ps", ["-axww", "-o", "pid=,ppid=,stat=,command="], { timeout: 10000, env, maxBuffer: 16 * MIB, encoding: "utf8" }),
    exec("ps", ["-axww", "-o", "pid=,comm="], { timeout: 10000, env, maxBuffer: 16 * MIB, encoding: "utf8" }),
  ]);
  const exes = new Map<number, string>();
  for (const line of names.stdout.split("\n")) { const match = line.match(/^\s*(\d+)\s+(.*\S)\s*$/); if (match) exes.set(Number(match[1]), match[2]); }
  const rows: ProcessInfo[] = [];
  for (const line of commands.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    // shortcut: arguments with spaces split apart (ps prints one string); only the first few are compared with paths.
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), state: match[3], exe: exes.get(Number(match[1])) ?? "", args: match[4].trim().split(/\s+/).filter(Boolean), cwd: null, created: null });
  }
  return rows;
}

/** Alive and not a zombie: a frozen loop never reaps the process it was asked to stop. */
async function isRunning(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (process.platform === "linux") {
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z"; } catch { return false; }
  }
  if (process.platform === "win32") return true;
  try {
    const { stdout } = await exec("ps", ["-o", "stat=", "-p", String(pid)], { timeout: 5000, encoding: "utf8" });
    return stdout.trim() !== "" && !stdout.trim().startsWith("Z");
  } catch { return false; }
}
async function waitStopped(pid: number, timeout = STOP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  while (await isRunning(pid)) {
    if (Date.now() > deadline) fail(`Process ${pid} did not stop within ${timeout / 1000} seconds; it was not killed`);
    await pause(100);
  }
}
async function signalProcess(pid: number, signal: NodeJS.Signals): Promise<void> {
  try { process.kill(pid, signal); } catch (error) {
    if (!(await isRunning(pid))) return; // it exited on its own
    fail(`Cannot signal process ${pid}: ${messageOf(error)}`);
  }
}

/** The process runs a host daemon (`ompweb host`, or the package's omp-web-host.js) or, for a server, anything else. */
function isHostCommand(args: string[]): boolean {
  return args.slice(0, 4).some((arg, index) => basename(arg.replaceAll("\\", "/")) === "omp-web-host.js" || (index > 0 && arg === "host"));
}
/** Its executable, or a script/argument among the first few, lies in the installation (a node/bun runtime elsewhere runs a script inside it). */
function belongsToInstall(row: ProcessInfo, installDir: string): boolean {
  if (row.exe && inside(installDir, row.exe)) return true;
  const base = row.cwd ?? installDir;
  return row.args.slice(0, 4).some((arg) => !arg.startsWith("-") && inside(installDir, isAbsolute(arg) ? arg : resolve(base, arg)));
}

/** `start` and its parents, nearest first; a parent younger than its child is a recycled pid, so the real one is gone. */
function ancestry(byPid: Map<number, ProcessInfo>, start: ProcessInfo, limit = 8): ProcessInfo[] {
  const chain = [start];
  while (chain.length < limit) {
    const child = chain[chain.length - 1];
    const parent = byPid.get(child.ppid);
    if (!parent || chain.includes(parent)) break;
    if (parent.created && child.created && BigInt(parent.created) > BigInt(child.created)) break;
    chain.push(parent);
  }
  return chain;
}
function descendants(rows: ProcessInfo[], root: number, includeRoot: boolean): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const found = includeRoot ? [root] : [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) if (child !== root && !found.includes(child)) { found.push(child); queue.push(child); }
  }
  return found;
}

/** The single new instance a supervisor started (not the one stopped), within the processes `within` allows; nulls when none or several qualify by the deadline. */
async function waitForInstance(plan: UpgradeProcess, within: (rows: ProcessInfo[]) => number[] | Promise<number[]>, timeout: number, stillSupervised?: () => Promise<void>): Promise<UpgradeInstance> {
  const deadline = Date.now() + timeout;
  for (;;) {
    await stillSupervised?.();
    const rows = await listProcesses();
    const allowed = new Set(await within(rows));
    const found: UpgradeInstance[] = [];
    for (const row of rows) {
      if (!allowed.has(row.pid) || row.state === "Z" || isHostCommand(row.args) !== (plan.role === "host") || !belongsToInstall(row, plan.installDir)) continue;
      const identity = await processStartIdentity(row.pid);
      if (identity && identity !== plan.identity && identity !== plan.current.identity) found.push({ pid: row.pid, identity });
    }
    if (found.length === 1) return found[0];
    if (Date.now() > deadline) return { pid: null, identity: null };
    await pause(500);
  }
}

// ---------------------------------------------------------------- systemd (Linux)

function parseServiceCgroup(cgroup: string): { unit: string; user: boolean } | null {
  for (const line of cgroup.split("\n")) {
    if (!line.startsWith("0::") && !line.includes(":name=systemd:")) continue;
    const segments = line.split(":").slice(2).join(":").trim().split("/");
    const unit = segments.at(-1);
    if (unit?.endsWith(".service")) return { unit, user: segments.some((segment) => /^user@\d+\.service$/.test(segment)) };
  }
  return null;
}
function cgroupService(pid: number | "self"): { unit: string; user: boolean } | null {
  try { return parseServiceCgroup(readFileSync(`/proc/${pid}/cgroup`, "utf8")); } catch { return null; }
}
async function systemctl(user: boolean, args: string[], timeout = 15000): Promise<string> {
  try {
    const { stdout } = await exec("systemctl", [...(user ? ["--user"] : []), "--no-ask-password", ...args], { timeout, maxBuffer: MIB, encoding: "utf8" });
    return stdout;
  } catch (error) { return fail(`systemctl ${args[0]} failed: ${messageOf(error)}`); }
}
const EXEC_KEYS = ["ExecStartPre", "ExecStart", "ExecStartPost", "ExecStop", "ExecStopPost"];
/** A unit's definition and live state. Exec lines keep only path/argv/ignore_errors: their pid and times change with every start. */
async function systemdUnit(unit: string, user: boolean): Promise<{ props: Record<string, string>; execs: Record<string, string[]>; hash: string }> {
  const out = await systemctl(user, ["show", `--property=${["FragmentPath", "DropInPaths", "ControlGroup", "MainPID", "ActiveState", "Transient", ...EXEC_KEYS].join(",")}`, unit]);
  const props: Record<string, string> = {};
  const execs: Record<string, string[]> = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (EXEC_KEYS.includes(key)) execs[key] = [...(execs[key] ?? []), ...[...value.matchAll(/path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=(\w+)/g)].map((match) => `${match[1]}\0${match[2]}\0${match[3]}`)];
    else props[key] = value;
  }
  if (!props.FragmentPath) fail(`Cannot read the definition of ${unit}`);
  const files = [props.FragmentPath, ...(props.DropInPaths ? props.DropInPaths.split(" ") : [])].filter(Boolean);
  return { props, execs, hash: sha256(unit, props.FragmentPath, props.DropInPaths ?? "", ...EXEC_KEYS.map((key) => (execs[key] ?? []).join("\n")), ...files.map(fileDigest)) };
}
async function inspectSystemd(me: ProcessInfo, rows: ProcessInfo[], role: UpgradeProcess["role"]): Promise<UpgradeSupervisor | null> {
  const service = cgroupService(me.pid);
  if (!service) return null;
  if (!UNIT_NAME.test(service.unit)) fail(`Unsupported systemd unit name ${service.unit}`);
  if (role === "host" && /^ompweb-api(?:[.@-]|$)/i.test(service.unit)) fail("Refusing to stop the web-server service; the host daemon needs its own service");
  const { props, execs, hash } = await systemdUnit(service.unit, service.user);
  // systemd forgets a transient (systemd-run) service once it stops, so nothing could start it again after the update.
  if (props.Transient === "yes") fail(`${service.unit} is a transient service: systemd discards its definition when it stops, so it could not be started again after the update`);
  if (props.ActiveState !== "active") fail(`${service.unit} is ${props.ActiveState}, not running`);
  // A wrapper script may be the service's main process, with the daemon beneath it: accepted, as long as that is what the service manages.
  const main = Number(props.MainPID);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!main || !ancestry(byPid, me, 16).some((row) => row.pid === main)) fail(`${service.unit}'s main process is neither this process nor one of its parents`);
  if ((execs.ExecStart ?? []).length !== 1) fail(`${service.unit} must have exactly one ExecStart command`);
  assertTrustedFile(execs.ExecStart[0].split("\0")[0], `${service.unit}'s ExecStart program`);
  return { kind: "systemd", unit: service.unit, user: service.user, configHash: hash };
}
async function verifySystemd(sup: Extract<UpgradeSupervisor, { kind: "systemd" }>): Promise<Record<string, string>> {
  const { props, hash } = await systemdUnit(sup.unit, sup.user);
  if (hash !== sup.configHash) fail(`The definition of ${sup.unit} changed since it was inspected; refusing to control it`);
  return props;
}

// ---------------------------------------------------------------- launchd and restart loops (macOS, POSIX shells)

async function launchctl(args: string[]): Promise<string> {
  try { return (await exec("launchctl", args, { timeout: 20000, maxBuffer: 4 * MIB, encoding: "utf8" })).stdout; }
  catch (error) { return fail(`launchctl ${args[0]} failed: ${messageOf(error)}`); }
}
function launchdJob(printed: string): { plist: string; pid: number | null } {
  return { plist: printed.match(/^\s*path = (.+)$/m)?.[1]?.trim() ?? "", pid: Number(printed.match(/^\s*pid = (\d+)$/m)?.[1]) || null };
}
function launchdDomain(): string { return `gui/${process.getuid?.() ?? 0}`; }
async function inspectLaunchd(me: ProcessInfo): Promise<UpgradeSupervisor | null> {
  const label = (await launchctl(["list"])).split("\n").map((line) => line.match(/^(\d+)\s+-?\d+\s+(\S+)\s*$/)).find((match) => match && Number(match[1]) === me.pid)?.[2];
  // shortcut: a system-domain LaunchDaemon running as this user is invisible here; the host's singleton lock still refuses a second daemon.
  if (!label) return null;
  if (!LAUNCHD_LABEL.test(label)) fail(`Unsupported launchd label ${label}`);
  const domain = launchdDomain();
  const job = launchdJob(await launchctl(["print", `${domain}/${label}`]));
  if (!job.plist || job.pid !== me.pid) fail(`launchd job ${label} does not run process ${me.pid} from a property list`);
  assertTrustedFile(job.plist, "launchd property list");
  return { kind: "launchd", label, domain, plist: job.plist, configHash: sha256(label, domain, job.plist, fileDigest(job.plist)) };
}
async function verifyLaunchd(sup: Extract<UpgradeSupervisor, { kind: "launchd" }>): Promise<{ loaded: boolean; pid: number | null }> {
  if (sup.domain !== launchdDomain()) fail("The launchd job belongs to another user's domain");
  if (sha256(sup.label, sup.domain, sup.plist, fileDigest(sup.plist)) !== sup.configHash) fail(`The property list of ${sup.label} changed since it was inspected; refusing to control it`);
  try { return { loaded: true, pid: launchdJob(await launchctl(["print", `${sup.domain}/${sup.label}`])).pid }; }
  catch { return { loaded: false, pid: null }; } // `print` fails when the job is not loaded
}

async function inspectPosixSupervisor(me: ProcessInfo, rows: ProcessInfo[], installDir: string): Promise<UpgradeSupervisor> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let parent = byPid.get(me.ppid);
  if (!parent || me.ppid <= 1) {
    if (process.platform === "darwin" && me.ppid === 1) { const job = await inspectLaunchd(me); if (job) return job; }
    return { kind: "foreground" }; // reparented to init after its starter exited: nothing supervises it
  }
  // A subshell shares the loop's command line: the loop is the outermost of them.
  for (let up = byPid.get(parent.ppid); up && up.args.length > 0 && up.args.join("\0") === parent.args.join("\0"); up = byPid.get(parent.ppid)) parent = up;
  const name = basename(parent.args[0] ?? parent.exe).replace(/^-/, "");
  if (!SHELL.test(name)) {
    if (process.platform !== "darwin" || belongsToInstall(parent, installDir) || /^(?:tmux|screen|login|sshd|sudo|su)\b/.test(name)) return { kind: "foreground" };
    return fail(`This process was started by \`${parent.args.join(" ").slice(0, 120) || name}\`, which may supervise it; update it manually`);
  }
  const flags = parent.args.slice(1);
  const operand = flags.find((arg) => !arg.startsWith("-"));
  if (flags.some((flag) => /^-[a-z]*c[a-z]*$/.test(flag))) {
    if (LOOP_KEYWORD.test(operand ?? "")) fail("This process runs from a shell command that loops; update it manually or run the loop from a script file");
    return { kind: "foreground" };
  }
  if (operand === undefined) {
    if (flags.every((flag) => ["-l", "-i", "-il", "-li", "--login", "--interactive"].includes(flag))) return { kind: "foreground" };
    fail(`This process runs under a shell started with unrecognized options (${flags.join(" ")}); update it manually`);
  }
  let script: string;
  try { script = realpathSync(isAbsolute(operand) ? operand : resolve(parent.cwd ?? installDir, operand)); } catch { return fail(`Cannot read the script ${operand} that supervises this process`); }
  if (statSync(script).size > 64 * 1024 || !LOOP_KEYWORD.test(readFileSync(script, "utf8"))) return { kind: "foreground" };
  assertTrustedFile(script, "The restart-loop script");
  const identity = await processStartIdentity(parent.pid);
  if (!identity) fail(`Cannot read the identity of the restart loop (process ${parent.pid})`);
  return { kind: "restart-loop", pid: parent.pid, identity, script, configHash: fileDigest(script) };
}
async function verifyLoop(sup: Extract<UpgradeSupervisor, { kind: "restart-loop" }>): Promise<void> {
  if (!(await isRunning(sup.pid)) || (await processStartIdentity(sup.pid)) !== sup.identity) fail("The restart loop that supervises this process is no longer the process that was inspected; refusing to freeze it");
  if (fileDigest(sup.script) !== sup.configHash) fail(`The restart-loop script ${sup.script} changed since it was inspected; refusing to resume it`);
}

// ---------------------------------------------------------------- Windows services and scheduled tasks

interface WindowsTask { path: string; name: string; state: string; userId: string; actions: { execute: string; arguments: string; workingDirectory: string }[] }
interface WindowsService { name: string; pathName: string; startName: string; startMode: string; state: string; pid: number }
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const taskHash = (task: WindowsTask, scripts: string[]): string =>
  sha256(task.path, task.name, task.userId, JSON.stringify(list(task.actions).map((a) => [a.execute, a.arguments, a.workingDirectory])), ...scripts.map(fileDigest));
const serviceHash = (service: WindowsService): string => sha256(service.name, service.pathName, service.startName, service.startMode);
const TASK_FIELDS = `[pscustomobject]@{ path = [string]$t.TaskPath; name = [string]$t.TaskName; state = [string]$t.State; userId = [string]$t.Principal.UserId; actions = @($t.Actions | ForEach-Object { [pscustomobject]@{ execute = [string]$_.Execute; arguments = [string]$_.Arguments; workingDirectory = [string]$_.WorkingDirectory } }) }`;
const SERVICE_FIELDS = `[pscustomobject]@{ name = [string]$_.Name; pathName = [string]$_.PathName; startName = [string]$_.StartName; startMode = [string]$_.StartMode; state = [string]$_.State; pid = [int]$_.ProcessId }`;

async function windowsTask(path: string, name: string): Promise<WindowsTask> {
  const out = await powershell(`$t = Get-ScheduledTask -TaskPath ${psString(path)} -TaskName ${psString(name)}\nConvertTo-Json -Compress -Depth 5 -InputObject (${TASK_FIELDS})`);
  return parseJson<WindowsTask>(out, "scheduled task");
}
async function windowsService(name: string): Promise<WindowsService> {
  const out = await powershell(`$s = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -eq ${psString(name)} } | ForEach-Object { ${SERVICE_FIELDS} })\nif ($s.Count -ne 1) { throw 'Service not found' }\nConvertTo-Json -Compress -InputObject $s[0]`);
  return parseJson<WindowsService>(out, "service");
}
async function inspectWindowsSupervisor(me: ProcessInfo, rows: ProcessInfo[], installDir: string): Promise<UpgradeSupervisor> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const chain = ancestry(byPid, me);
  const normal = (value: string) => value.toLowerCase().replaceAll("\\", "/");
  const scripts = [...new Set(chain.slice(1).flatMap((row) => row.args.slice(1).filter((arg) => /\.(?:ps1|cmd|bat|vbs)$/i.test(arg))))];
  const found = parseJson<{ services: WindowsService[]; tasks: WindowsTask[] }>(await powershell(
    // A scheduled task's tree hangs under the Schedule service's svchost (shared by many services): never a candidate supervisor.
    `$ids = @(${chain.filter((row) => !/(^|[\\/])svchost\.exe$/i.test(row.exe)).map((row) => row.pid).join(",")})\n$scripts = ${psStrings(scripts.map(normal))}\n` +
    `$services = @(Get-CimInstance Win32_Service | Where-Object { $_.ProcessId -and ($ids -contains [int]$_.ProcessId) } | ForEach-Object { ${SERVICE_FIELDS} })\n` +
    `$tasks = @()\nif ($scripts.Count -gt 0) { $tasks = @(Get-ScheduledTask | ForEach-Object { $t = $_; $text = ((@($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments })) -join ' ').ToLowerInvariant().Replace('\\', '/'); $hit = $false; foreach ($s in $scripts) { if ($text.Contains($s)) { $hit = $true } }; if ($hit) { ${TASK_FIELDS} } }) }\n` +
    `ConvertTo-Json -Compress -Depth 6 -InputObject ([pscustomobject]@{ services = $services; tasks = $tasks })`), "supervisor query");
  const services = list(found.services);
  const tasks = list(found.tasks);
  if (services.length > 1 || tasks.length > 1) fail("More than one Windows service or scheduled task could be supervising this process; update it manually");
  if (services.length === 1) {
    if (services[0].state !== "Running") fail(`Windows service ${services[0].name} is ${services[0].state}, not running`);
    return { kind: "windows-service", name: services[0].name, configHash: serviceHash(services[0]) };
  }
  if (tasks.length === 1) {
    if (tasks[0].state !== "Running") fail(`Scheduled task ${tasks[0].name} is ${tasks[0].state}, not running`);
    return { kind: "windows-task", path: tasks[0].path, name: tasks[0].name, scripts: scripts.map(normal), configHash: taskHash(tasks[0], scripts.map(normal)) };
  }
  if (scripts.length > 0) fail(`This process runs under ${basename(scripts[0])}, which no registered scheduled task starts; update it manually`);
  const parent = chain[1];
  if (!parent || belongsToInstall(parent, installDir)) return { kind: "foreground" }; // started by the server, or its starter has exited
  const name = basename(parent.exe || parent.args[0] || "").toLowerCase();
  const scripted = /\.(ps1|bat|cmd)\b|(^|\s)-(file|command|c|encodedcommand|ec|noexit)\b|(^|\s)\/[ck]\b/i.test(parent.args.join(" "));
  if (["powershell.exe", "pwsh.exe", "cmd.exe", "explorer.exe", "windowsterminal.exe", "conhost.exe", "openconsole.exe"].includes(name) && !scripted) return { kind: "foreground" };
  return fail(`This process was started by ${name || "an unknown process"}${scripted ? " running a script" : ""}, which may supervise it; update it manually`);
}
async function verifyWindowsTask(sup: Extract<UpgradeSupervisor, { kind: "windows-task" }>): Promise<WindowsTask> {
  const task = await windowsTask(sup.path, sup.name);
  if (taskHash(task, sup.scripts) !== sup.configHash) fail(`Scheduled task ${sup.name} changed since it was inspected; refusing to control it`);
  return task;
}
async function verifyWindowsService(sup: Extract<UpgradeSupervisor, { kind: "windows-service" }>): Promise<WindowsService> {
  const service = await windowsService(sup.name);
  if (serviceHash(service) !== sup.configHash) fail(`Windows service ${sup.name} changed since it was inspected; refusing to control it`);
  return service;
}
const taskTarget = (sup: Extract<UpgradeSupervisor, { kind: "windows-task" }>): string => `-TaskPath ${psString(sup.path)} -TaskName ${psString(sup.name)}`;

// ---------------------------------------------------------------- independent launch

function assertLaunch(launch: UpgradeLaunch): void {
  if (!launch || typeof launch.command !== "string" || !launch.command || !Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== "string") || typeof launch.cwd !== "string" || !isAbsolute(launch.cwd) || (launch.env !== undefined && (typeof launch.env !== "object" || launch.env === null))) fail("Invalid upgrade launch: command, string arguments and an absolute cwd are required");
}

/**
 * Windows: mode bits set no ACL, so what a directory inherits (every user's read in a shared TEMP) would expose the
 * credentials written into it. Refuses a path that is not a real directory (a link or junction) owned by this account
 * (its user, or its token's default owner: Administrators when elevated), then leaves access to this account and SYSTEM
 * only, inheritable and no longer inherited, which also corrects what it already holds. Resolves once that is verified.
 * Elsewhere callers create their directories 0o700 and check the owner themselves, so nothing is done.
 */
export async function secureUpgradeDirectory(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  await powershell([
    `$path = ${psString(path)}`,
    "$item = Get-Item -LiteralPath $path -Force",
    "if (-not $item.PSIsContainer) { throw ('Not a directory: ' + $path) }",
    "if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw ('Refusing a link or junction: ' + $path) }",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$owner = (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value",
    "if ($owner -ne $identity.User.Value -and $owner -ne $identity.Owner.Value) { throw ('Refusing ' + $path + ': it is owned by ' + $owner + ', not by this account') }",
    "$allowed = @($identity.User.Value, 'S-1-5-18') | Select-Object -Unique",
    // A new descriptor writes the DACL alone (never the owner), and no explicit entry of the old one survives.
    "$acl = New-Object Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($sid in $allowed) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
    "[IO.Directory]::SetAccessControl($path, $acl)",
    "$after = Get-Acl -LiteralPath $path",
    "if (-not $after.AreAccessRulesProtected) { throw ('Could not stop ' + $path + ' inheriting permissions') }",
    "foreach ($rule in $after.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { if ($allowed -notcontains $rule.IdentityReference.Value) { throw ('Unexpected access to ' + $path + ' for ' + $rule.IdentityReference.Value) } }",
  ].join("\n"));
}

async function launchWindows(launch: UpgradeLaunch): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-launch-"));
  const spec = join(dir, "spec.json");
  const pidTemp = join(dir, "pid.tmp");
  const pidFile = join(dir, "pid");
  const errorFile = join(dir, "error");
  try {
    await secureUpgradeDirectory(dir);
    const env = Object.entries(launch.env ?? process.env).flatMap(([name, value]) => (value === undefined ? [] : [{ name, value }]));
    const commandLine = launch.args.map((arg) => (/^[^\s"]+$/.test(arg) ? arg : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`)).join(" ");
    writeFileSync(spec, JSON.stringify({ command: launch.command, commandLine, cwd: launch.cwd, env }), { flag: "wx", mode: 0o600 });
    // Runs inside the helper: apply the environment (Win32_Process.Create gives it a default one), start the target and report its pid.
    const helper = [
      "$ErrorActionPreference = 'Stop'",
      "try {",
      `  $spec = [IO.File]::ReadAllText(${psString(spec)}) | ConvertFrom-Json`,
      `  Remove-Item -LiteralPath ${psString(spec)} -Force`,
      "  $psi = New-Object System.Diagnostics.ProcessStartInfo",
      "  $psi.FileName = [string]$spec.command; $psi.Arguments = [string]$spec.commandLine; $psi.WorkingDirectory = [string]$spec.cwd",
      "  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true",
      "  $psi.EnvironmentVariables.Clear()",
      "  foreach ($e in @($spec.env)) { if ($e) { $psi.EnvironmentVariables[[string]$e.name] = [string]$e.value } }",
      "  $p = [System.Diagnostics.Process]::Start($psi)",
      `  [IO.File]::WriteAllText(${psString(pidTemp)}, [string]$p.Id)`,
      `  Move-Item -LiteralPath ${psString(pidTemp)} -Destination ${psString(pidFile)}`,
      "  exit 0",
      `} catch { [IO.File]::WriteAllText(${psString(errorFile)}, [string]$_.Exception.Message); exit 127 }`,
    ].join("\n");
    const helperLine = `"${powershellBinary()}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encodePowershell(helper)}`;
    // WMI creates the helper under its own provider host: outside this process's tree and any job object that would end with it.
    await powershell(`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psString(helperLine)}; CurrentDirectory = ${psString(tmpdir())} }\nif ([int]$r.ReturnValue -ne 0) { throw ('Win32_Process.Create failed with code ' + $r.ReturnValue + ' (2 = access denied, 3 = insufficient privilege, 9 = path not found)') }`, 60000);
    for (const deadline = Date.now() + 30000; Date.now() < deadline; await pause(100)) {
      if (existsSync(errorFile)) fail(`The launcher could not start ${launch.command}: ${readFileSync(errorFile, "utf8")}`);
      if (existsSync(pidFile)) return Number(readFileSync(pidFile, "utf8").trim());
    }
    return fail(`The launcher did not report the started process of ${launch.command} within 30 seconds`);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the helper holds nothing in it once it reported */ } }
}

/** Starts `launch` as its own session, outside this process's tree (and, in a systemd service, its cgroup), and returns the started process's pid. */
export async function launchDetachedUpgrade(launch: UpgradeLaunch): Promise<number | undefined> {
  assertLaunch(launch);
  if (process.platform === "win32") return launchWindows(launch);
  let { command, args } = launch;
  const env = { ...(launch.env ?? process.env) };
  const service = process.platform === "linux" ? cgroupService("self") : null;
  if (service) {
    // A helper left in the service's cgroup dies with the service it is replacing: it runs in its own transient scope.
    const scope = [...(service.user ? ["--user"] : []), "--scope", "--quiet", "--collect", "--no-ask-password"];
    if (service.user) for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) env[name] ??= process.env[name];
    try { await exec("systemd-run", [...scope, "true"], { timeout: 10000, env }); }
    catch (error) { fail(`systemd-run cannot create a scope outside ${service.unit}, so a helper would die with it: ${messageOf(error)}`); }
    args = [...scope, command, ...args];
    command = "systemd-run";
  }
  const child = spawn(command, args, { cwd: launch.cwd, env, detached: true, stdio: "ignore", windowsHide: true });
  const { promise, resolve: started, reject: failed } = Promise.withResolvers<void>();
  child.once("error", failed);
  child.once("spawn", () => started());
  await promise;
  child.unref();
  return child.pid;
}

// ---------------------------------------------------------------- public API

function assertPlan(plan: UpgradeProcess): void {
  const bad = (what: string): never => fail(`Invalid upgrade process plan: ${what}`);
  if (!plan || typeof plan !== "object") bad("not an object");
  if (plan.platform !== process.platform) bad(`inspected on ${plan.platform}, not ${process.platform}`);
  if (plan.role !== "host" && plan.role !== "server") bad("role");
  if (!Number.isSafeInteger(plan.pid) || plan.pid <= 1 || typeof plan.identity !== "string" || !plan.identity) bad("pid or identity");
  if (typeof plan.installDir !== "string" || !isAbsolute(plan.installDir)) bad("installDir");
  const current = plan.current;
  if (!current || typeof current !== "object" || (current.pid === null) !== (current.identity === null) || (current.pid !== null && (!Number.isSafeInteger(current.pid) || current.pid <= 1 || typeof current.identity !== "string"))) bad("current instance");
  if (current.pid === plan.pid && current.identity !== plan.identity) bad("current instance does not match the inspected process");
  const s = plan.supervisor;
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\0-\x1f]/.test(value);
  if (!s || typeof s !== "object") bad("supervisor");
  switch (s.kind) {
    case "foreground": break;
    case "systemd": if (!UNIT_NAME.test(s.unit) || typeof s.user !== "boolean" || !text(s.configHash)) bad("systemd supervisor"); break;
    case "launchd": if (!LAUNCHD_LABEL.test(s.label) || s.domain !== `gui/${process.getuid?.() ?? 0}` || !text(s.plist) || !isAbsolute(s.plist) || !text(s.configHash)) bad("launchd supervisor"); break;
    case "restart-loop": if (!Number.isSafeInteger(s.pid) || s.pid <= 1 || !text(s.identity) || !text(s.script) || !isAbsolute(s.script) || !text(s.configHash)) bad("restart-loop supervisor"); break;
    case "windows-service": if (!text(s.name) || !text(s.configHash)) bad("windows service supervisor"); break;
    case "windows-task": if (!text(s.path) || !text(s.name) || !Array.isArray(s.scripts) || !s.scripts.every(text) || !text(s.configHash)) bad("windows task supervisor"); break;
    default: bad("supervisor kind");
  }
}

/**
 * Binds `pid` to what is needed to stop and start it again: its start identity, the executable and installation it
 * runs from, and what supervises it. Anything that cannot be controlled safely (unrecognised supervisor, changed
 * ownership, ambiguity) throws instead of guessing, before anything has been stopped.
 */
export async function inspectUpgradeProcess(input: { pid: number; installDir: string; role: "server" | "host"; launch: UpgradeLaunch }): Promise<UpgradeProcess> {
  const { pid, role, launch } = input;
  if (!Number.isSafeInteger(pid) || pid <= 1) fail("Invalid process id");
  if (role !== "server" && role !== "host") fail("Invalid process role");
  if (typeof input.installDir !== "string" || !isAbsolute(input.installDir)) fail("The installation directory must be absolute");
  assertLaunch(launch);
  let installDir: string;
  try { installDir = realpathSync(input.installDir); } catch { return fail(`The installation directory ${input.installDir} does not exist`); }
  const identity = await processStartIdentity(pid);
  if (!identity) fail(`Process ${pid} is not running, or its start identity cannot be read`);
  const rows = await listProcesses();
  const me = rows.find((row) => row.pid === pid);
  if (!me || me.state === "Z") fail(`Process ${pid} is not running`);
  if (!belongsToInstall(me, installDir)) fail(`Process ${pid} does not run from ${installDir}`);
  if (isHostCommand(me.args) !== (role === "host")) fail(`Process ${pid} is not the ${role} process (${me.args.slice(0, 4).join(" ")})`);
  let supervisor: UpgradeSupervisor;
  if (process.platform === "win32") supervisor = await inspectWindowsSupervisor(me, rows, installDir);
  else supervisor = (process.platform === "linux" ? await inspectSystemd(me, rows, role) : null) ?? await inspectPosixSupervisor(me, rows, installDir);
  if (supervisor.kind === "foreground") {
    // The restart path is checked while nothing is stopped yet.
    try { if (!statSync(launch.cwd).isDirectory()) throw new Error("not a directory"); } catch { fail(`The restart working directory ${launch.cwd} is not a directory`); }
    if (isAbsolute(launch.command) && !existsSync(launch.command)) fail(`The restart command ${launch.command} does not exist`);
  }
  if ((await processStartIdentity(pid)) !== identity) fail(`Process ${pid} changed while it was being inspected`);
  let executable = me.exe || me.args[0] || "";
  try { executable = realpathSync(executable); } catch { /* keep as reported */ }
  return { role, platform: process.platform, pid, identity, executable, args: me.args, installDir, supervisor, current: { pid, identity } };
}

/** The instance a stop would act on is still running and is the very process recorded (a recycled pid is never signalled). */
async function runningInstance(plan: UpgradeProcess): Promise<number | null> {
  const { pid, identity } = plan.current;
  if (pid === null || !(await isRunning(pid))) return null;
  if ((await processStartIdentity(pid)) !== identity) {
    if (!(await isRunning(pid))) return null; // it exited while the identity was read
    fail(`Process ${pid} is no longer the process that was inspected (process identity mismatch); refusing to signal it`);
  }
  return pid;
}

/**
 * Stops the current instance through its verified supervisor (a service/task/launchd job is stopped, a restart loop is
 * frozen and the daemon ended, so nothing restarts it behind the update), or signals a foreground process directly.
 * Nothing is touched when the process or the supervisor's configuration is no longer what was inspected.
 */
export async function stopUpgradeProcess(plan: UpgradeProcess): Promise<void> {
  assertPlan(plan);
  const pid = await runningInstance(plan);
  const sup = plan.supervisor;
  switch (sup.kind) {
    case "foreground":
      if (pid !== null) { await signalProcess(pid, "SIGTERM"); await waitStopped(pid); }
      return;
    case "systemd": {
      const props = await verifySystemd(sup);
      if (pid !== null) { if (cgroupService(pid)?.unit !== sup.unit) fail(`Process ${pid} is not managed by ${sup.unit}; refusing to stop the service`); }
      else if (plan.current.pid !== null && props.ActiveState === "active" && Number(props.MainPID) !== 0) fail(`${sup.unit} now runs a different process than the one inspected; refusing to stop it`);
      await systemctl(sup.user, ["stop", sup.unit], 120000);
      if (pid !== null) await waitStopped(pid);
      return;
    }
    case "launchd": {
      const job = await verifyLaunchd(sup);
      if (pid !== null && job.pid !== pid) fail(`launchd job ${sup.label} does not run process ${pid}; refusing to stop it`);
      if (job.pid !== null && plan.current.pid !== null && job.pid !== pid) fail(`launchd job ${sup.label} now runs a different process than the one inspected; refusing to stop it`);
      if (job.loaded) await launchctl(["bootout", `${sup.domain}/${sup.label}`]);
      if (pid !== null) await waitStopped(pid);
      return;
    }
    case "restart-loop": {
      await verifyLoop(sup);
      if (pid !== null && !descendants(await listProcesses(), sup.pid, false).includes(pid)) fail(`Process ${pid} is not run by the inspected restart loop; refusing to stop it`);
      await signalProcess(sup.pid, "SIGSTOP");
      try {
        // SIGTERM would make the daemon exit 0, and the loop (README: exit 0 = stopped on purpose) would then end instead of restarting it.
        if (pid !== null) { await signalProcess(pid, "SIGKILL"); await waitStopped(pid); }
      } catch (error) { await signalProcess(sup.pid, "SIGCONT").catch(() => undefined); throw error; }
      return;
    }
    case "windows-task":
      await verifyWindowsTask(sup);
      await powershell(`Stop-ScheduledTask ${taskTarget(sup)}\n$t = $null\nfor ($i = 0; $i -lt 120; $i++) { $t = Get-ScheduledTask ${taskTarget(sup)}; if ([string]$t.State -ne 'Running') { break }; Start-Sleep -Milliseconds 500 }\nif ([string]$t.State -eq 'Running') { throw 'The scheduled task did not stop' }`, 120000);
      // Stopping the task ends its script, not necessarily the host it started.
      if (pid !== null) { await signalProcess(pid, "SIGTERM"); await waitStopped(pid); }
      return;
    case "windows-service":
      await verifyWindowsService(sup);
      await powershell(`$s = Get-Service -Name ${psString(sup.name)}\nif ($s.Status -ne 'Stopped') { Stop-Service -InputObject $s; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90)) }`, 120000);
      if (pid !== null) await waitStopped(pid);
      return;
  }
}

/**
 * Starts the process again through the supervisor that was inspected (service start, task start, launchd bootstrap,
 * resuming the restart loop); `launch` is used only for a foreground process, which no supervisor restarts. Records
 * the new instance in `plan.current` (so a later stop acts on it) and returns its pid, or undefined when it cannot
 * be told apart from other processes.
 */
export async function restartUpgradeProcess(plan: UpgradeProcess, launch: UpgradeLaunch): Promise<number | undefined> {
  assertPlan(plan);
  assertLaunch(launch);
  if (plan.current.pid !== null && await isRunning(plan.current.pid)) fail(`Process ${plan.current.pid} is still running; stop it before restarting`);
  const sup = plan.supervisor;
  let instance: UpgradeInstance;
  switch (sup.kind) {
    case "foreground": {
      const pid = await launchDetachedUpgrade(launch);
      const identity = pid === undefined ? null : await processStartIdentity(pid);
      if (pid === undefined || !identity) fail(`The restarted process ${pid ?? ""} is not running`);
      instance = { pid, identity };
      break;
    }
    case "systemd": {
      const live = async () => {
        const state: Record<string, string> = {};
        for (const line of (await systemctl(sup.user, ["show", "--property=MainPID,ControlGroup,ActiveState", sup.unit])).split("\n")) { const at = line.indexOf("="); if (at > 0) state[line.slice(0, at)] = line.slice(at + 1); }
        return state;
      };
      await verifySystemd(sup);
      if (["active", "activating", "reloading"].includes((await live()).ActiveState)) fail(`${sup.unit} is already running; refusing to start a second instance`);
      await systemctl(sup.user, ["start", sup.unit], 120000);
      instance = await waitForInstance(plan, async (rows) => {
        const state = await live();
        const main = Number(state.MainPID);
        let members: number[] = [];
        try { members = readFileSync(join("/sys/fs/cgroup", state.ControlGroup ?? "", "cgroup.procs"), "utf8").split("\n").map(Number).filter(Boolean); } catch { /* cgroup v1: the process tree is enough */ }
        return [...members, ...(main ? descendants(rows, main, true) : [])];
      }, 30000);
      if ((await live()).ActiveState !== "active") fail(`${sup.unit} did not stay running after it was started`);
      break;
    }
    case "launchd": {
      if ((await verifyLaunchd(sup)).loaded) fail(`launchd job ${sup.label} is already loaded; refusing to start a second instance`);
      await launchctl(["bootstrap", sup.domain, sup.plist]);
      instance = { pid: null, identity: null };
      for (const deadline = Date.now() + 30000; instance.pid === null && Date.now() < deadline; await pause(500)) {
        const pid = (await verifyLaunchd(sup)).pid;
        const identity = pid ? await processStartIdentity(pid) : null;
        if (pid && identity) instance = { pid, identity };
      }
      break;
    }
    case "restart-loop": {
      await verifyLoop(sup);
      await signalProcess(sup.pid, "SIGCONT");
      instance = await waitForInstance(plan, (rows) => descendants(rows, sup.pid, false), 90000, async () => {
        if (!(await isRunning(sup.pid))) fail("The restart loop exited instead of restarting the process (the exit status of the stopped process ended the loop)");
      });
      if (instance.pid === null) fail(`The restart loop did not start a new process within 90 seconds (loop ${sup.pid} is running)`);
      break;
    }
    case "windows-task": {
      if ((await verifyWindowsTask(sup)).state === "Running") fail(`Scheduled task ${sup.name} is already running; refusing to start a second instance`);
      const since = BigInt(Date.now() - 5000) * BigInt(10000) + BigInt("621355968000000000"); // .NET ticks, as in the process list's `created`
      await powershell(`Start-ScheduledTask ${taskTarget(sup)}`);
      instance = await waitForInstance(plan, (rows) => rows.filter((row) => row.created && BigInt(row.created) >= since).map((row) => row.pid), 60000);
      break;
    }
    case "windows-service": {
      if ((await verifyWindowsService(sup)).state !== "Stopped") fail(`Windows service ${sup.name} is not stopped; refusing to start a second instance`);
      await powershell(`$s = Get-Service -Name ${psString(sup.name)}\nStart-Service -InputObject $s\n$s.WaitForStatus('Running', [TimeSpan]::FromSeconds(90))`, 120000);
      instance = await waitForInstance(plan, async (rows) => { const service = await windowsService(sup.name); return service.pid ? descendants(rows, service.pid, true) : []; }, 30000);
      break;
    }
  }
  plan.current = instance;
  return instance.pid ?? undefined;
}
