import { execFile } from "child_process";
import { existsSync } from "fs";
import { comparableProjectPath } from "../comparable-path";
import { getWindowsExecutionEnv, resolvePowerShellBin } from "../windows-service";

/**
 * Which live omp processes exist on this machine, and which session each one was opened on.
 *
 * This runs where the children run: inside `ompweb host`. omp ≥ 18.5 keeps a
 * process-owned OS lease per session (a named mutex on Windows, an abstract
 * socket on Linux) — deliberately not a file, so omp-web cannot read it. The
 * command line is the portable, version-independent evidence instead: both
 * omp-web (`buildSessionSpawnArgs`) and the terminal (`omp --resume <id|path>`)
 * name the session they were started on, and a live process with that argument
 * holds the lease.
 *
 * Scanning spawns a process (PowerShell cold start on Windows is expensive), so
 * results are cached for `FOREIGN_SCAN_TTL_MS`, concurrent callers share one
 * in-flight scan, and a failure is reported as "unknown" (`ok: false`) rather
 * than "no processes". `OMP_WEB_FOREIGN_SCAN=0` turns the scan off
 * (`enabled: false`). Both mean a caller cannot claim that nobody runs a
 * session.
 *
 * Only processes of this daemon's own OS user are trusted on POSIX. A command
 * line is unauthenticated evidence — any local process could print
 * `--resume <id>` — so another user's process would be a free "this session
 * runs elsewhere" for as long as it lives. `ps` reports the uid and every other
 * user's row is dropped. Windows cannot read another user's process owner
 * without PROCESS_QUERY_INFORMATION, which an unelevated daemon does not have,
 * and `process.getuid` is unavailable there: the scan keeps every row
 * (`sameUserProcesses(rows, null)`) and narrows by process name instead. That is
 * the documented process-identity limit — on Windows a same-machine process
 * named `omp` that names a session counts as a possible owner whatever account
 * started it.
 *
 * The daemon's own children are excluded by pid, never by uid: `ChannelTable`
 * knows their transport pids, and a Windows `cmd.exe /c omp.cmd` wrapper puts
 * the real `omp` one hop below that pid (see `sessionIdsNamedByProcesses`).
 */

export interface OmpProcessInfo {
  pid: number;
  /** The process that started it, where the OS reports one. */
  ppid?: number;
  commandLine: string;
  /** Owning uid where the OS reports one (POSIX); undefined on Windows. */
  uid?: number;
  /** `--resume` arguments, computed once per scan (see `listOmpProcesses`). */
  resumeTargets?: string[];
}

/** How long one process scan is reused. Cheap enough to hide in a request,
 *  short enough that a stale process list cannot block for long. */
export const FOREIGN_SCAN_TTL_MS = 10_000;
/** Hard bound on one scan; a slow PowerShell must not stall an inspection. */
const FOREIGN_SCAN_TIMEOUT_MS = 1_500;

/** One command line can be ~2 MB (Linux ARG_MAX). Nothing that identifies a
 *  session lives past this prefix, and parsing must stay bounded. */
const MAX_COMMAND_LINE_CHARS = 8 * 1024;
/** Work caps per command line: a process has one `--resume`, and a session
 *  path with spaces has a handful of tokens — never thousands of prefixes. */
const MAX_RESUME_OCCURRENCES = 8;
const MAX_BARE_JOIN_TOKENS = 8;
/** How far up a ppid chain an own-child check looks. The deepest real case is
 *  `cmd.exe` → `omp` on Windows; the rest is headroom for a launcher script. */
const MAX_ANCESTOR_DEPTH = 8;

export type ProcessScanRunner = (file: string, args: string[]) => Promise<string>;

export interface OmpProcessScanOptions {
  /** Injectable process boundary (tests, hosts without PowerShell). */
  run?: ProcessScanRunner;
  platform?: NodeJS.Platform;
  now?: () => number;
  /**
   * Effective uid of this daemon process; a POSIX process of another user is
   * never trusted as a session owner. Defaults to `process.getuid()`, and
   * `null` (Windows, or an OS without uids) keeps every scanned process.
   */
  uid?: number | null;
}

export interface OmpProcessScan {
  processes: OmpProcessInfo[];
  /** False when the scan failed or timed out: "unknown", not "none". */
  ok: boolean;
  /** False when `OMP_WEB_FOREIGN_SCAN=0` switched the scan off: also "unknown". */
  enabled: boolean;
}

export function foreignScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMP_WEB_FOREIGN_SCAN !== "0";
}

const defaultRunner: ProcessScanRunner = (file, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    file,
    args,
    { timeout: FOREIGN_SCAN_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: getWindowsExecutionEnv() },
    (error, stdout) => {
      // A timeout leaves partial stdout unusable: report failure.
      if (error) reject(error);
      else resolve(stdout);
    },
  );
  return promise;
};

/** The scan child must run the system `ps` from a fixed absolute path, never a
 *  project-local binary: a repository could ship one named `ps`, and it would
 *  run with our env. No known absolute path means no scan at all — reported as
 *  `ok: false` ("unknown") instead of falling back to PATH. */
function resolvePosixPsBin(): string | null {
  for (const candidate of ["/bin/ps", "/usr/bin/ps"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function capCommandLine(commandLine: string): string {
  return commandLine.length > MAX_COMMAND_LINE_CHARS ? commandLine.slice(0, MAX_COMMAND_LINE_CHARS) : commandLine;
}

/** `Get-CimInstance ... | ConvertTo-Json` — one JSON object or an array. */
export function parseWindowsProcessList(raw: string): OmpProcessInfo[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: OmpProcessInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown };
    const pid = typeof record.ProcessId === "number" ? record.ProcessId : Number(record.ProcessId);
    const commandLine = typeof record.CommandLine === "string" ? capCommandLine(record.CommandLine) : "";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const parent = typeof record.ParentProcessId === "number" ? record.ParentProcessId : Number(record.ParentProcessId);
    processes.push(Number.isInteger(parent) && parent > 0 ? { pid, ppid: parent, commandLine } : { pid, commandLine });
  }
  return processes;
}

/** `ps -eo pid=,ppid=,uid=,args=` — one `pid ppid uid command line` per line. */
export function parsePosixProcessList(raw: string): OmpProcessInfo[] {
  const processes: OmpProcessInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const uid = Number(match[3]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid)) continue;
    processes.push({ pid, ppid, uid, commandLine: capCommandLine(match[4].trim()) });
  }
  return processes;
}

/** Whether a pid still exists. `EPERM` means "exists, not ours" and counts as alive. */
export type ProcessLivenessProbe = (pid: number) => boolean;

const defaultLivenessProbe: ProcessLivenessProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
};

interface OmpProcessScanState {
  cache: { at: number; platform: NodeJS.Platform; runner: ProcessScanRunner; uid: number | null; processes: OmpProcessInfo[] } | null;
  /** One scan at a time, process-wide. */
  inFlight: Promise<OmpProcessScan> | null;
  injectedRunner: ProcessScanRunner | null;
  livenessProbe: ProcessLivenessProbe | null;
}

declare global {
  var __ompProcessScanState: OmpProcessScanState | undefined;
}

/**
 * Kept on `globalThis` so `bun --hot` re-evaluation and every module that
 * imports this file share one cache, one single-flight promise and one test
 * seam — a module-local copy would let a burst of requests spawn one PowerShell
 * each, which is exactly what the single-flight promise exists to prevent.
 */
function scanState(): OmpProcessScanState {
  const state = globalThis.__ompProcessScanState ??= { cache: null, inFlight: null, injectedRunner: null, livenessProbe: null };
  // A state object created by an older module version lacks fields added later.
  state.cache ??= null;
  state.inFlight ??= null;
  state.injectedRunner ??= null;
  state.livenessProbe ??= null;
  return state;
}

/** Drop the cached scan (tests: the next call must observe the OS again). */
export function resetOmpProcessCache(): void {
  scanState().cache = null;
}

export function setOmpProcessScanRunner(runner: ProcessScanRunner | null): void {
  const state = scanState();
  state.injectedRunner = runner;
  state.cache = null;
  // An injected scan names the test's pids, which the real OS probe would
  // reject as dead: a fake process table implies fake liveness. A caller that
  // wants a specific answer passes `isProcessAlive`.
  state.livenessProbe = runner ? () => true : null;
}

/**
 * Whether this pid is still running right now. A scan is cached for
 * {@link FOREIGN_SCAN_TTL_MS}, so a process that exited inside that window is
 * still listed: an owner hit must be confirmed against the OS before it may
 * count, or a terminal `omp` closed seconds ago reads as a live writer.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return (scanState().livenessProbe ?? defaultLivenessProbe)(pid);
}

/**
 * Drop processes of other OS users: `ps -e` lists everyone, and a command line
 * of another user is no evidence that they hold this session (any local
 * process could print `--resume <id>` and block sending). A `null` uid means
 * the OS does not report one (Windows) and keeps every process.
 */
export function sameUserProcesses(processes: OmpProcessInfo[], uid: number | null): OmpProcessInfo[] {
  return uid === null ? processes : processes.filter((process) => process.uid === uid);
}

async function runScan(platform: NodeJS.Platform, run: ProcessScanRunner, uid: number | null): Promise<OmpProcessInfo[]> {
  let processes: OmpProcessInfo[];
  if (platform === "win32") {
    // Ownership could be narrowed to this user with a `GetOwner` call per
    // process, but that needs PROCESS_QUERY_INFORMATION, which an unelevated
    // daemon lacks for another user's process — the query would cost a CIM
    // round trip per process and still answer "unknown". The name filter below
    // stays the cheap narrowing: an arbitrary foreign process (a script named
    // `sleep`, say) cannot name a session this way.
    const command =
      "Get-CimInstance Win32_Process -Filter \"Name='omp.exe' OR Name='omp'\" -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
    processes = parseWindowsProcessList(await run(resolvePowerShellBin(), ["-NoProfile", "-NonInteractive", "-Command", command]));
  } else {
    const psBin = resolvePosixPsBin();
    // No absolute `ps`: report "unknown" (the caller keeps a known owner)
    // rather than resolving some binary from PATH.
    if (!psBin) throw new Error("no absolute ps binary");
    processes = sameUserProcesses(parsePosixProcessList(await run(psBin, ["-eo", "pid=,ppid=,uid=,args="])), uid);
  }
  // Parse the resume arguments once per process: one snapshot answers a whole
  // batch of session ids.
  for (const process of processes) process.resumeTargets = resumeArguments(process.commandLine);
  return processes;
}

export async function listOmpProcesses(options: OmpProcessScanOptions = {}): Promise<OmpProcessScan> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === undefined
    ? (typeof process.getuid === "function" ? process.getuid() : null)
    : options.uid;
  const now = options.now?.() ?? Date.now();
  if (!foreignScanEnabled()) return { processes: [], ok: true, enabled: false };
  const state = scanState();
  const run = options.run ?? state.injectedRunner ?? defaultRunner;
  // The runner is part of the cache key: a scan produced by another boundary
  // (a swapped test seam) must never answer for this one. The uid is too: the
  // filter runs inside the scan.
  if (state.cache && state.cache.runner === run && state.cache.platform === platform && state.cache.uid === uid && now - state.cache.at < FOREIGN_SCAN_TTL_MS) {
    return { processes: state.cache.processes, ok: true, enabled: true };
  }
  const scan = async (): Promise<OmpProcessScan> => {
    try {
      const processes = await runScan(platform, run, uid);
      state.cache = { at: now, platform, runner: run, uid, processes };
      return { processes, ok: true, enabled: true };
    } catch {
      // No process list is a soft "unknown", never a reason to claim absence —
      // and the failure is not cached, so the next caller retries instead of
      // inheriting an answer that may clear a live owner.
      return { processes: [], ok: false, enabled: true };
    }
  };
  // A per-call runner is a one-off boundary; it never joins the shared scan.
  if (options.run) return scan();
  if (state.inFlight) return state.inFlight;
  const started = scan().finally(() => {
    state.inFlight = null;
  });
  state.inFlight = started;
  return started;
}

function basenameAny(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : value;
}

/**
 * Values a `--resume` argument may carry: the exact token, or — on POSIX,
 * where `ps` loses the quoting — the space-joined tokens that follow it.
 * Work stays bounded (`MAX_BARE_JOIN_TOKENS` joins per occurrence), so a
 * hostile command line cannot turn this into a quadratic parse.
 */
export function resumeArguments(commandLine: string): string[] {
  const text = capCommandLine(commandLine);
  const values: string[] = [];
  const marker = "--resume";
  let searchFrom = 0;
  let occurrences = 0;
  while (occurrences < MAX_RESUME_OCCURRENCES) {
    const index = text.indexOf(marker, searchFrom);
    if (index < 0) break;
    searchFrom = index + marker.length;
    // `--resume` must start an argument, not sit inside another token.
    if (index > 0 && !/\s/.test(text[index - 1])) continue;
    occurrences += 1;
    let cursor = index + marker.length;
    if (text[cursor] === "=") cursor += 1;
    else if (cursor < text.length && !/\s/.test(text[cursor])) continue; // `--resumeX`
    else while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (cursor >= text.length) continue;
    const quote = text[cursor];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, cursor + 1);
      values.push(end > cursor + 1 ? text.slice(cursor + 1, end) : text.slice(cursor + 1));
      continue;
    }
    // Unquoted: the token itself plus the joins with the tokens after it. A
    // path with spaces arrives quoted from Windows and unquoted from `ps`;
    // joining stops at the next flag.
    const tokens: string[] = [];
    while (cursor < text.length && tokens.length < MAX_BARE_JOIN_TOKENS) {
      let end = cursor;
      while (end < text.length && !/\s/.test(text[end])) end += 1;
      const token = text.slice(cursor, end);
      if (token.startsWith("-")) break;
      tokens.push(token);
      values.push(tokens.join(" "));
      while (end < text.length && /\s/.test(text[end])) end += 1;
      cursor = end;
    }
  }
  return values.filter((value) => value.length > 0);
}

/** The session id a `--resume` value may carry: the value itself, or the
 *  trailing `<id>` of `<id>.jsonl` / `<timestamp>_<id>.jsonl`. */
function sessionIdFromResumeValue(value: string): string {
  const base = basenameAny(value);
  if (!base.endsWith(".jsonl")) return value;
  const stem = base.slice(0, -".jsonl".length);
  const underscore = stem.lastIndexOf("_");
  return underscore >= 0 ? stem.slice(underscore + 1) : stem;
}

/** True when `process` is this daemon's own child: its pid is known, or its
 *  parent chain reaches a known pid within {@link MAX_ANCESTOR_DEPTH}. The one
 *  hop that matters in practice is the Windows `cmd.exe /c omp.cmd` wrapper,
 *  whose pid is the transport id while the real `omp` sits below it. */
function isOwnChild(process: OmpProcessInfo, byPid: Map<number, OmpProcessInfo>, exclude: Set<number>): boolean {
  if (exclude.has(process.pid)) return true;
  let parent = process.ppid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && parent !== undefined && parent > 0; depth += 1) {
    if (exclude.has(parent)) return true;
    parent = byPid.get(parent)?.ppid;
  }
  return false;
}

export interface NamedByProcessesOptions {
  /** Pids of this daemon's own children (a transport's id is its child's pid). */
  excludePids?: readonly number[];
  /** Confirm a hit against the OS: a cached scan still lists a process that
   *  exited inside its TTL. Omitted = trust the scan. */
  isAlive?: ProcessLivenessProbe;
}

/**
 * Which of `candidates` a scanned process names on its command line, in one
 * pass over the snapshot (one bounded scan answers a whole batch of ids).
 *
 * The daemon's own children are dropped first: they name the session file they
 * were started on, and they are ours, not a foreign writer. A hit is confirmed
 * with `isAlive` when the caller acts on it; a dead row is skipped and the
 * search continues, because a second, live `--resume` on the same file is the
 * real owner.
 */
export function sessionIdsNamedByProcesses(
  processes: OmpProcessInfo[],
  candidates: Iterable<{ id: string; sessionFile?: string }>,
  options: NamedByProcessesOptions = {},
): Set<string> {
  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate.id);
    if (!candidate.sessionFile) continue;
    byPath.set(comparableProjectPath(candidate.sessionFile), candidate.id);
    byBase.set(basenameAny(candidate.sessionFile), candidate.id);
  }
  const byPid = new Map<number, OmpProcessInfo>();
  for (const process of processes) byPid.set(process.pid, process);
  const exclude = new Set(options.excludePids ?? []);
  const ids = new Set<string>();
  for (const process of processes) {
    if (!process.commandLine.includes("--resume")) continue;
    if (exclude.size > 0 && isOwnChild(process, byPid, exclude)) continue;
    const values = process.resumeTargets ?? resumeArguments(process.commandLine);
    let live: boolean | null = null;
    for (const value of values) {
      const pathHit = byPath.get(comparableProjectPath(value));
      const base = basenameAny(value);
      const hit = pathHit ?? byBase.get(base) ?? byId.get(sessionIdFromResumeValue(value));
      if (!hit) continue;
      // Probe only on a hit (a syscall per candidate), once per process.
      live ??= options.isAlive ? options.isAlive(process.pid) : true;
      if (live) ids.add(hit);
    }
  }
  return ids;
}
