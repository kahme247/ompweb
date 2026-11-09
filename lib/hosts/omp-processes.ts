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
 * (`sameUserProcesses(rows, null)`) and narrows by process identity instead —
 * `omp.exe`/`omp`, or a command line naming an omp entry (`isOmpProcess`), which
 * also covers a `.cmd`/node shim launcher. That is the documented
 * process-identity limit — on Windows a same-machine process named `omp` that
 * names a session counts as a possible owner whatever account started it.
 *
 * A resume argument is only evidence on an omp row: `-r` is also `grep -r` and
 * `rm -r`, and a POSIX scan lists every process of the user. The flags are the
 * ones omp documents (`--resume`, `--restore`, `-r`), including a unique id
 * prefix, which is how omp's `--resume` takes an id.
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
  /** The executable name where the OS reports one (Windows CIM `Name`); undefined from `ps`, which reports only the
   *  command line. */
  name?: string;
  /** Owning uid where the OS reports one (POSIX); undefined on Windows. */
  uid?: number;
  /** Resume arguments, computed once per scan (see `listOmpProcesses`). */
  resumeTargets?: ResumeArgument[];
}

/** How long one process scan is reused. Cheap enough to hide in a request,
 *  short enough that a stale process list cannot block for long. */
const FOREIGN_SCAN_TTL_MS = 10_000;
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
/** The shortest session-id prefix a `--resume` value may be: omp accepts a
 *  unique prefix, and four characters keep `rm -r 1111` from matching a whole
 *  batch of unrelated ids. */
const MIN_PREFIX_CHARS = 4;
/** How many argv tokens an entry-point search may walk. Real shapes are
 *  `env VAR=x nice -n 5 cmd.exe /c omp.cmd` — a handful; a hostile line of
 *  thousands of flags must not turn this into a long parse. */
const MAX_LAUNCHER_DEPTH = 8;

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
  /**
   * The absolute `ps` a POSIX scan runs. Defaults to the first of
   * `/bin/ps`/`/usr/bin/ps` that exists; `null` forces the "no absolute ps"
   * failure, so a test can exercise the POSIX parse on Windows.
   */
  psBin?: string | null;
}

export interface OmpProcessScan {
  processes: OmpProcessInfo[];
  /** False when the scan failed or timed out: "unknown", not "none". */
  ok: boolean;
  /** False when `OMP_WEB_FOREIGN_SCAN=0` switched the scan off: also "unknown". */
  enabled: boolean;
}

function foreignScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
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
    const record = row as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown; Name?: unknown };
    const pid = typeof record.ProcessId === "number" ? record.ProcessId : Number(record.ProcessId);
    const commandLine = typeof record.CommandLine === "string" ? capCommandLine(record.CommandLine) : "";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const parent = typeof record.ParentProcessId === "number" ? record.ParentProcessId : Number(record.ParentProcessId);
    const name = typeof record.Name === "string" && record.Name !== "" ? record.Name : undefined;
    processes.push({
      pid,
      ...(Number.isInteger(parent) && parent > 0 ? { ppid: parent } : {}),
      commandLine,
      ...(name === undefined ? {} : { name }),
    });
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

/** The image names that *are* omp, compared on the basename. */
const OMP_IMAGE_NAMES: Record<string, true> = {
  omp: true,
  "omp.exe": true,
  "omp.cmd": true,
  "omp.bat": true,
  "omp.js": true,
  "omp.cjs": true,
  "omp.mjs": true,
};

/** Launchers that run another program as their first non-flag argument:
 *  `cmd.exe /c omp.cmd …`, `sh -c "omp --resume x"`, `node …\cli.js …`. */
const LAUNCHER_NAMES: Record<string, true> = {
  cmd: true,
  "cmd.exe": true,
  sh: true,
  bash: true,
  dash: true,
  zsh: true,
  node: true,
  "node.exe": true,
  bun: true,
  "bun.exe": true,
};
/** Prefix commands that run another program as their first non-flag argument
 *  (`env FOO=1 omp …`, `nice -n 5 omp …`). */
const WRAPPER_NAMES: Record<string, true> = {
  env: true,
  nice: true,
  nohup: true,
  command: true,
  exec: true,
  time: true,
};

/** Launchers that take a whole command string as one argument (`-c`/`/c`). */
const COMMAND_STRING_LAUNCHERS: Record<string, true> = {
  cmd: true,
  "cmd.exe": true,
  sh: true,
  bash: true,
  dash: true,
  zsh: true,
};

/** Split a command line into argv, honouring both quote styles. `ps` loses the
 *  original quoting, so this is the best available reconstruction: a quoted
 *  run stays one token, everything else splits on whitespace. */
function splitCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of capCommandLine(commandLine)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Whether `token` names an omp entry point: the image itself (`omp`,
 *  `omp.exe`, `omp.cmd`, `omp.bat`, `omp.js`) or a shim's JS entry below
 *  `@oh-my-pi`. The comparison is on the basename, so `omp-web`,
 *  `fake-omp.cmd` and `…/omp/foo` do not match. */
function isOmpEntryToken(token: string): boolean {
  const base = basenameAny(token).toLowerCase();
  if (OMP_IMAGE_NAMES[base]) return true;
  return /[\\/]@?oh-my-pi[\\/]/i.test(token);
}

/**
 * Whether the row can be an omp process at all. A resume argument is only
 * evidence when the process carrying it is omp: `-r` is also `grep -r`, `rm -r`
 * and `tar -r`, and a POSIX scan lists every process of the user.
 *
 * The entry point must be *anchored*, never "somewhere on the line". It is
 * `argv[0]`, or the first non-flag argument after a known launcher
 * (`cmd[.exe] /c …`, `sh|bash -c …`, `node|bun …`), or after a prefix command
 * (`env FOO=1 …`, `nice -n 5 …`). A token that merely appears later — a grep
 * pattern, an `--exclude-dir=omp`, a path below `…/omp/` — is an argument of
 * that program, not an omp entry, so `grep -r <id> lib/omp` cannot claim a
 * session.
 *
 * Windows additionally recognises the shim shapes (`cmd.exe /c omp.cmd …`,
 * `node …\@oh-my-pi\…\cli.js …`), which the old name filter missed.
 */
export function isOmpProcess(process: OmpProcessInfo): boolean {
  const name = process.name?.toLowerCase();
  if (name === "omp" || name === "omp.exe") return true;
  return commandLineRunsOmp(process.commandLine);
}

/** Launcher/wrapper flags that consume the *next* token as their value
 *  (`nice -n 5`, `env -u NAME`, `time -f FORMAT`), so the value is not
 *  mistaken for the program. Attached forms (`-n5`, `--adjustment=5`) are
 *  single tokens and need no entry. */
const FLAGS_WITH_VALUE: Record<string, true> = {
  "-n": true,
  "--adjustment": true,
  "-u": true,
  "--unset": true,
  "-C": true,
  "--chdir": true,
  "-S": true,
  "-f": true,
  "--format": true,
  "-o": true,
  "--output": true,
};

/** Skip the tokens a launcher/wrapper puts before the program it runs: its
 *  flags (`cmd.exe /d /s /c`, `nice -n`), the values of value-taking flags, and
 *  `env`'s `VAR=value` assignments. A POSIX absolute path is not a flag, so the
 *  cmd-style test is a bare `/x` or `/xy` only. */
function skipLaunchPrefix(argv: string[], start: number): number {
  let index = start;
  while (index < argv.length) {
    const token = argv[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) index += 1;
    else if (FLAGS_WITH_VALUE[token]) index += 2;
    else if (token.startsWith("-") || /^\/[A-Za-z]{1,2}$/.test(token)) index += 1;
    else break;
  }
  return index;
}

/** Walk `argv` from the front: an omp entry at the head, or as the program a
 *  known launcher/wrapper runs. Bounded by {@link MAX_LAUNCHER_DEPTH} per
 *  command string, and by it again across a nested `sh -c "…"`. */
function commandLineRunsOmp(commandLine: string, depth = 0): boolean {
  if (depth >= MAX_LAUNCHER_DEPTH) return false;
  const argv = splitCommandLine(commandLine);
  let index = 0;
  for (let step = 0; step < MAX_LAUNCHER_DEPTH; step += 1) {
    index = skipLaunchPrefix(argv, index);
    const token = argv[index];
    if (token === undefined) return false;
    index += 1;
    if (isOmpEntryToken(token)) return true;
    const base = basenameAny(token).toLowerCase();
    if (!LAUNCHER_NAMES[base] && !WRAPPER_NAMES[base]) return false;
    // `sh -c "<command string>"` / `cmd.exe /c <command string>`: the program
    // is inside the next token, which splitCommandLine already unquoted into
    // one token — so recurse on it instead of reading it as a program name.
    if (COMMAND_STRING_LAUNCHERS[base]) {
      index = skipLaunchPrefix(argv, index);
      const commandString = argv[index];
      if (commandString === undefined) return false;
      return isOmpEntryToken(commandString) || commandLineRunsOmp(commandString, depth + 1);
    }
  }
  return false;
}

async function runScan(platform: NodeJS.Platform, run: ProcessScanRunner, uid: number | null, psBin: string | null | undefined): Promise<OmpProcessInfo[]> {
  let processes: OmpProcessInfo[];
  if (platform === "win32") {
    // Ownership could be narrowed to this user with a `GetOwner` call per
    // process, but that needs PROCESS_QUERY_INFORMATION, which an unelevated
    // daemon lacks for another user's process — the query would cost a CIM
    // round trip per process and still answer "unknown". The name filter below
    // stays the cheap narrowing. `node.exe`/`cmd.exe` are listed because a
    // `.cmd` shim (which `wrapWindowsScript` supports) runs omp as a node
    // process below cmd.exe; `isOmpProcess` keeps only rows whose command line
    // names an omp entry, so the wider query costs one JSON parse, not trust.
    const command =
      "Get-CimInstance Win32_Process -Filter \"Name='omp.exe' OR Name='omp' OR Name='node.exe' OR Name='cmd.exe'\" -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    processes = parseWindowsProcessList(await run(resolvePowerShellBin(), ["-NoProfile", "-NonInteractive", "-Command", command]));
  } else {
    // No absolute `ps`: report "unknown" (the caller keeps a known owner)
    // rather than resolving some binary from PATH.
    const resolved = psBin === undefined ? resolvePosixPsBin() : psBin;
    if (!resolved) throw new Error("no absolute ps binary");
    // `-ww`: an unlimited output width. `args` is the last column, so a
    // narrow terminal (`COLUMNS` exported in a tmux pane or CI wrapper) clips
    // the `--resume` value and the row reads as naming no session — the exact
    // false `none` this scan exists to prevent. An explicit option wins over
    // the environment (procps `choose_dimensions`), so no env plumbing.
    processes = sameUserProcesses(parsePosixProcessList(await run(resolved, ["-ww", "-eo", "pid=,ppid=,uid=,args="])), uid);
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
      const processes = await runScan(platform, run, uid, options.psBin);
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
 * The flags omp documents for opening an existing session (`omp --help`):
 * `-r, --resume=<value>` and `--restore=<value>`, which resumes "as --resume
 * does, then goes on with what its last process left unfinished". `--restore`
 * is what a user reaches for after a crash — exactly when a second writer
 * appears — so it must count as a resume argument too.
 */
const RESUME_MARKERS = ["--resume", "--restore", "-r"] as const;

/** One resume argument: the value it carried. The flag itself is not kept —
 *  every caller asks only which session a row names, and the flag never
 *  changes that answer. */
export interface ResumeArgument {
  value: string;
}

/**
 * Values a resume flag may carry: the exact token, or — on POSIX, where `ps`
 * loses the quoting — the space-joined tokens that follow it. Work stays
 * bounded (`MAX_RESUME_OCCURRENCES` occurrences, `MAX_BARE_JOIN_TOKENS` joins
 * each), so a hostile command line cannot turn this into a quadratic parse.
 */
export function resumeArguments(commandLine: string): ResumeArgument[] {
  const text = capCommandLine(commandLine);
  const values: ResumeArgument[] = [];
  let occurrences = 0;
  for (const marker of RESUME_MARKERS) {
    let searchFrom = 0;
    while (occurrences < MAX_RESUME_OCCURRENCES) {
      const index = text.indexOf(marker, searchFrom);
      if (index < 0) break;
      searchFrom = index + marker.length;
      // The marker must start an argument, not sit inside another token:
      // `-r` occurs inside `--resume`/`--restore`, and `--resumeX` is a
      // different flag.
      if (index > 0 && !/\s/.test(text[index - 1])) continue;
      let cursor = index + marker.length;
      if (text[cursor] === "=") cursor += 1;
      else if (cursor < text.length && !/\s/.test(text[cursor])) {
        // `-r<id>` is omp's attached short-flag form; a long flag needs `=`
        // or whitespace, so `--resumeX` is a different flag.
        if (marker !== "-r") continue;
      } else while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (cursor >= text.length) continue;
      occurrences += 1;
      const quote = text[cursor];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, cursor + 1);
        values.push({ value: end > cursor + 1 ? text.slice(cursor + 1, end) : text.slice(cursor + 1) });
        continue;
      }
      // Unquoted: the token itself plus the joins with the tokens after it. A
      // path with spaces arrives quoted from Windows and unquoted from `ps`;
      // joining stops at the next flag.
      const tokens: string[] = [];
      while (cursor < text.length && tokens.length < MAX_BARE_JOIN_TOKENS) {
        let end = cursor;
        while (end < text.length && !/\s/.test(text[end])) end += 1;
        // A token inside a quoted command string (`sh -c "omp --resume <id>"`)
        // carries that string's closing quote; a session id or path never ends
        // in one, so it is not part of the value.
        const token = text.slice(cursor, end).replace(/["']+$/, "");
        if (token.startsWith("-")) break;
        tokens.push(token);
        values.push({ value: tokens.join(" ") });
        while (end < text.length && /\s/.test(text[end])) end += 1;
        cursor = end;
      }
    }
  }
  return values.filter((argument) => argument.value.length > 0);
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

/**
 * omp's `--resume` takes "a session (by ID prefix, path, or picker if
 * omitted)", so `omp --resume 11111111` names a session whose id starts with
 * that prefix. Only a *unique* prefix is evidence: an ambiguous one leaves omp
 * to pick, so claiming either session would be a guess. The value must look
 * like a bare id prefix (hex and dashes, no path separator) and be at least
 * {@link MIN_PREFIX_CHARS} long, or `-r /tmp/1111` would match by accident.
 */
function uniquePrefixHit(ids: ReadonlySet<string>, value: string): string | null {
  if (value.length < MIN_PREFIX_CHARS || /[\\/]/.test(value) || !/^[0-9a-f][0-9a-f-]*$/i.test(value)) return null;
  let hit: string | null = null;
  for (const id of ids) {
    if (!id.startsWith(value)) continue;
    if (hit !== null) return null; // ambiguous: omp would have to pick
    hit = id;
  }
  return hit;
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
  const ids = new Set<string>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate.id);
    ids.add(candidate.id);
    if (!candidate.sessionFile) continue;
    byPath.set(comparableProjectPath(candidate.sessionFile), candidate.id);
    byBase.set(basenameAny(candidate.sessionFile), candidate.id);
  }
  const byPid = new Map<number, OmpProcessInfo>();
  for (const process of processes) byPid.set(process.pid, process);
  const exclude = new Set(options.excludePids ?? []);
  const named = new Set<string>();
  for (const process of processes) {
    // `-r` is also `grep -r`, `rm -r` and `tar -r`, and a POSIX scan lists
    // every process of the user: only an omp row may own a session.
    if (!isOmpProcess(process)) continue;
    const values = process.resumeTargets ?? resumeArguments(process.commandLine);
    if (values.length === 0) continue;
    if (exclude.size > 0 && isOwnChild(process, byPid, exclude)) continue;
    let live: boolean | null = null;
    for (const { value } of values) {
      const pathHit = byPath.get(comparableProjectPath(value));
      const base = basenameAny(value);
      const hit = pathHit ?? byBase.get(base) ?? byId.get(sessionIdFromResumeValue(value)) ?? uniquePrefixHit(ids, value);
      if (!hit) continue;
      // Probe only on a hit (a syscall per candidate), once per process.
      live ??= options.isAlive ? options.isAlive(process.pid) : true;
      if (live) named.add(hit);
    }
  }
  return named;
}
