// The fixed bootstrap a confirmed recovery runs on a legacy host (an old daemon whose updater refuses, wraps or cannot
// restart the install), and the historical command envelopes that carry it. The old daemon has no recovery API: its
// `open` + `stdin` ops start one omp process, and that omp's `bash` command runs `buildLegacyRecoveryBootstrap`.
// Nothing here takes a command, URL or path from a client: every interpolated value is validated first and the
// repository must be this build's own release repository. Completion is never read from the bootstrap's output: the new
// host's authenticated operation receipt is the only success signal.
import { releaseRepo } from "../release-repo";
import { isRecord } from "../type-guards";
import { HOST_VERSION_PATTERN } from "./update-worker";

/** The server's published release whose binary carries the recovery CLI (`ompweb recover-host`). `tag` names that exact
 * release when it is not the stable `v<version>` (a prerelease build of the same package version). */
export interface LegacyRecoveryRelease {
  version: string;
  repo: string;
  tag?: string;
  assets: Array<{ name: string; digest: string }>;
}

export interface LegacyRecoveryInput {
  operationId: string;
  helper: LegacyRecoveryRelease;
  /** The release the host is recovered to; independent of the helper's. */
  targetVersion: string;
  compatibility: { min: number; max: number };
  /** The host's `process.platform`: linux, darwin or win32. */
  platform: string;
  force: boolean;
}

/** What the helper binary embeds (lib/hosts/recovery.ts), encoded so this module, bundled into every release, does not:
 * a release without the recovery CLI must not match. An old ompweb given an unknown subcommand starts the web server. */
export const RECOVERY_CLI_MARKER_BASE64 = "b21wd2ViLXJlY292ZXJ5LWNsaS12MQ==";
const RECOVERY_CLI_MARKER = Buffer.from(RECOVERY_CLI_MARKER_BASE64, "base64").toString();

const GITHUB = "https://github.com";
const OPERATION_ID = /^[a-zA-Z0-9-]{1,80}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PRERELEASE_TAG = /^\d{8}T\d{6}Z-[0-9a-f]{7,40}$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/;
const DOWNLOAD_BASE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
/** Same bounds the host updater holds a release to (HOST_RELEASE_MAX_ARCHIVE/MEMBER) and its 15 minute download. */
const MAX_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_SECONDS = 15 * 60;
const PLATFORMS = {
  linux: { os: "linux", extension: ".tar.gz", architectures: ["x64", "arm64"] },
  darwin: { os: "darwin", extension: ".tar.gz", architectures: ["x64", "arm64"] },
  win32: { os: "windows", extension: ".zip", architectures: ["x64"] },
} as const;

interface Plan {
  operationId: string;
  platform: keyof typeof PLATFORMS;
  repo: string;
  tag: string;
  targetVersion: string;
  min: number;
  max: number;
  force: boolean;
  /** Pinned SHA-256 (hex) of each architecture's archive. */
  digests: Map<string, string>;
}

function refuse(message: string): never {
  throw new Error(`Invalid legacy recovery request: ${message}`);
}

function validate(input: LegacyRecoveryInput): Plan {
  if (!isRecord(input) || !isRecord(input.helper) || !isRecord(input.compatibility)) return refuse("malformed input");
  const { operationId, helper, targetVersion, compatibility, platform, force } = input;
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) refuse("operation id");
  if (typeof targetVersion !== "string" || targetVersion.length > 100 || !HOST_VERSION_PATTERN.test(targetVersion)) refuse("target version");
  if (typeof helper.version !== "string" || helper.version.length > 100 || !HOST_VERSION_PATTERN.test(helper.version)) refuse("helper version");
  if (typeof helper.repo !== "string" || !REPO.test(helper.repo) || helper.repo !== releaseRepo()) refuse("helper repository");
  const tag = helper.tag === undefined ? `v${helper.version}` : helper.tag;
  if (typeof tag !== "string" || !(tag === `v${helper.version}` || PRERELEASE_TAG.test(tag))) refuse("helper release tag");
  const { min, max } = compatibility;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 1000) refuse("protocol compatibility");
  if (typeof platform !== "string" || !Object.hasOwn(PLATFORMS, platform)) refuse("platform");
  if (typeof force !== "boolean") refuse("force flag");
  if (!Array.isArray(helper.assets) || helper.assets.some((asset) => !isRecord(asset) || typeof asset.name !== "string" || typeof asset.digest !== "string")) refuse("helper assets");
  const { os, extension, architectures } = PLATFORMS[platform as keyof typeof PLATFORMS];
  const digests = new Map<string, string>();
  for (const architecture of architectures) {
    const name = `ompweb-${os}-${architecture}${extension}`;
    const matches = helper.assets.filter((asset) => asset.name === name);
    if (matches.length > 1) refuse(`duplicate asset ${name}`);
    if (matches.length === 0) continue;
    const digest = DIGEST.exec(matches[0].digest);
    if (!digest) refuse(`digest of ${name}`);
    digests.set(architecture, digest[1]);
  }
  if (digests.size === 0) refuse(`the helper release has no ${os} asset with a digest`);
  return { operationId, platform: platform as keyof typeof PLATFORMS, repo: helper.repo, tag, targetVersion, min, max, force, digests };
}

/** The arguments of `ompweb recover-host` (runHostRecoveryCli's strict flags), identical on every platform. */
function recoverArguments(plan: Plan): string[] {
  return ["recover-host", "--operation", plan.operationId, "--version", plan.targetVersion, "--min-protocol", String(plan.min), "--max-protocol", String(plan.max), ...(plan.force ? ["--force"] : [])];
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
/** `${TMPDIR:-/tmp}`, kept out of the templates below where `${` interpolates. */
const TMP_DIR = "${TMPDIR:-/tmp}";

/**
 * POSIX shell for `sh -c`. Needs curl, tar and one of sha256sum/shasum/openssl; a missing tool fails visibly. Every
 * step is its own checked command (no pipeline whose status could be lost): download under a size limit, digest
 * against the pinned value, exactly one `<root>/ompweb` member, streamed with `tar -O` to a private scratch file (the
 * archive's paths never reach the filesystem), the recovery marker found in its bytes before it is ever run.
 */
function posixCommand(plan: Plan, base: string): string {
  const { os, extension } = PLATFORMS[plan.platform];
  const proto = base.startsWith("https:") ? "=https" : "=http";
  const branches = (names: string[], pattern: string): string => names
    .map((architecture) => {
      const digest = plan.digests.get(architecture);
      return `${pattern}) arch=${architecture}; want=${digest ? shellQuote(digest) : ""}; ${digest ? ":" : `fail 'the pinned release has no ${architecture} asset'`} ;;`;
    }).join("\n");
  const script = String.raw`set -eu
umask 077
fail() { printf 'ompweb recovery bootstrap: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = ${shellQuote(plan.platform === "darwin" ? "Darwin" : "Linux")} ] || fail 'this bootstrap was built for ${plan.platform === "darwin" ? "macOS" : "Linux"}'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
case "$(uname -m)" in
${branches(["x64"], "x86_64|amd64")}
${branches(["arm64"], "aarch64|arm64")}
*) fail "unsupported CPU architecture $(uname -m)" ;;
esac
asset="ompweb-${os}-$arch${extension}"
entry="ompweb-${os}-$arch/ompweb"
url=${shellQuote(`${base}/${plan.repo}/releases/download/${plan.tag}/`)}"$asset"
marker=${shellQuote(RECOVERY_CLI_MARKER)}
digest_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else echo 'ompweb recovery bootstrap: sha256sum, shasum or openssl is required' >&2
  fi
}
work=$(mktemp -d "${TMP_DIR}/ompweb-recovery-${plan.operationId}-XXXXXX") || fail 'cannot create a private scratch directory'
keep=
trap '[ -n "$keep" ] || rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
( ulimit -f ${MAX_BYTES / 512} && curl --fail --silent --show-error --location --proto '${proto}' --proto-redir '${proto}' --tlsv1.2 --max-redirs 5 --connect-timeout 20 --max-time ${DOWNLOAD_SECONDS} --max-filesize ${MAX_BYTES} --output "$work/archive" "$url" ) || fail 'cannot download the pinned release archive'
[ "$(digest_of "$work/archive")" = "$want" ] || fail 'release archive digest mismatch'
tar -tzf "$work/archive" > "$work/entries" || fail 'cannot list the release archive'
[ "$(grep -Fxc -- "$entry" "$work/entries" || true)" = 1 ] || fail "release archive must contain exactly one $entry"
( ulimit -f ${MAX_BYTES / 512} && tar -xzOf "$work/archive" "$entry" > "$work/ompweb" ) || fail 'cannot extract the ompweb binary'
[ -s "$work/ompweb" ] || fail 'the ompweb binary is empty'
grep -aqF -- "$marker" "$work/ompweb" || fail 'the pinned ompweb release has no recovery support'
chmod 700 "$work/ompweb"
rm -f "$work/archive" "$work/entries"
if "$work/ompweb" ${recoverArguments(plan).map(shellQuote).join(" ")} </dev/null; then keep=1; else status=$?; printf 'ompweb recovery bootstrap: recover-host exited with %s\n' "$status" >&2; exit "$status"; fi
`;
  return `sh -c ${shellQuote(script)} ompweb-recovery`;
}

/**
 * Windows PowerShell 5.1 (`powershell.exe`, .NET Framework) script, passed as -EncodedCommand so no quoting survives to
 * mangle it. Native architecture (a WOW64 or emulated shell still reports the machine's), HttpClient with a
 * cancellation deadline and size cap, SHA-256 of the file, one exact ZipArchive entry copied by stream (no path from the
 * archive is ever used), the marker searched in the bytes, then the helper. No bash, curl, tar or other Unix tool.
 */
function windowsScript(plan: Plan, base: string): string {
  const digest = plan.digests.get("x64");
  if (!digest) return refuse("the helper release has no windows asset with a digest");
  const entry = "ompweb-windows-x64/ompweb.exe";
  const argumentList = recoverArguments(plan).map(powershellQuote).join(",");
  return String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$code = 1
$dir = $null
try {
  Add-Type -AssemblyName System.Net.Http
  Add-Type -AssemblyName System.IO.Compression
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64') { throw "ompweb has no Windows $arch release" }
  $url = ${powershellQuote(`${base}/${plan.repo}/releases/download/${plan.tag}/ompweb-windows-x64.zip`)}
  $want = ${powershellQuote(digest)}
  $entry = ${powershellQuote(entry)}
  $marker = ${powershellQuote(RECOVERY_CLI_MARKER)}
  $cap = ${MAX_BYTES}
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('ompweb-recovery-' + ${powershellQuote(plan.operationId)} + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  [void][IO.Directory]::CreateDirectory($dir, $acl)
  $zip = Join-Path $dir 'release.zip'
  $buffer = New-Object byte[] 1048576
  $cts = New-Object Threading.CancellationTokenSource
  $cts.CancelAfter(${DOWNLOAD_SECONDS * 1000})
  $http = New-Object Net.Http.HttpClient
  $http.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  try {
    $response = $http.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "cannot download the pinned release archive: HTTP $([int]$response.StatusCode)" }
    $length = $response.Content.Headers.ContentLength
    if ($length -and $length -gt $cap) { throw 'the release archive is too large' }
    $in = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $out = [IO.File]::Open($zip, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $total = 0
      while (($n = $in.ReadAsync($buffer, 0, $buffer.Length, $cts.Token).GetAwaiter().GetResult()) -gt 0) {
        $total += $n
        if ($total -gt $cap) { throw 'the release archive is too large' }
        $out.Write($buffer, 0, $n)
      }
    } finally { $out.Dispose() }
  } finally { $http.Dispose() }
  $sha = [Security.Cryptography.SHA256]::Create()
  $file = [IO.File]::OpenRead($zip)
  try { $got = ([BitConverter]::ToString($sha.ComputeHash($file)) -replace '-', '').ToLowerInvariant() } finally { $file.Dispose() }
  if ($got -ne $want) { throw 'release archive digest mismatch' }
  $exe = Join-Path $dir 'ompweb.exe'
  $archive = New-Object IO.Compression.ZipArchive([IO.File]::OpenRead($zip), [IO.Compression.ZipArchiveMode]::Read)
  try {
    $hits = @($archive.Entries | Where-Object { $_.FullName -ieq $entry })
    if ($hits.Count -ne 1 -or $hits[0].FullName -cne $entry) { throw "release archive must contain exactly one $entry" }
    $src = $hits[0].Open()
    $dst = [IO.File]::Open($exe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $total = 0
      while (($n = $src.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $total += $n
        if ($total -gt $cap) { throw 'the ompweb binary is too large' }
        $dst.Write($buffer, 0, $n)
      }
    } finally { $dst.Dispose(); $src.Dispose() }
    if ($total -le 0) { throw 'the ompweb binary is empty' }
  } finally { $archive.Dispose() }
  Remove-Item -LiteralPath $zip -Force
  $latin1 = [Text.Encoding]::GetEncoding(28591)
  $found = $false
  $tail = ''
  $file = [IO.File]::OpenRead($exe)
  try {
    while (-not $found -and ($n = $file.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $text = $tail + $latin1.GetString($buffer, 0, $n)
      $found = $text.Contains($marker)
      $tail = $text.Substring([Math]::Max(0, $text.Length - $marker.Length + 1))
    }
  } finally { $file.Dispose() }
  if (-not $found) { throw 'the pinned ompweb release has no recovery support' }
  $arguments = @(${argumentList})
  & $exe @arguments
  $code = $LASTEXITCODE
  if ($code -ne 0) { [Console]::Error.WriteLine("ompweb recovery bootstrap: recover-host exited with $code") }
} catch {
  [Console]::Error.WriteLine('ompweb recovery bootstrap: ' + $_.Exception.Message)
  $code = 1
}
if ($code -ne 0 -and $dir -and (Test-Path -LiteralPath $dir)) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
exit $code
`;
}

/**
 * The command the legacy runner's native `bash` operation runs. It only invokes Windows PowerShell there: Git Bash is
 * the transport, so MSYS argument rewriting is switched off and powershell.exe falls back to its System32 path.
 */
function windowsCommand(plan: Plan, base: string): string {
  const encoded = Buffer.from(windowsScript(plan, base), "utf16le").toString("base64");
  // Well under CreateProcess's 32767 characters; a longer script would silently fail to launch.
  if (encoded.length > 24_000) throw new Error("The Windows recovery bootstrap is too long to pass as one command line");
  return `ps=powershell.exe; command -v "$ps" >/dev/null 2>&1 || ps="\${SYSTEMROOT:-/c/Windows}/System32/WindowsPowerShell/v1.0/powershell.exe"; MSYS2_ARG_CONV_EXCL='*' "$ps" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/** For tests only: the same bootstrap against a local server that lays releases out as GitHub does. Production code
 * calls `buildLegacyRecoveryBootstrap`, whose base is fixed. */
export function legacyRecoveryBootstrapFor(input: LegacyRecoveryInput, downloadBase: string): string {
  if (!DOWNLOAD_BASE.test(downloadBase)) throw new Error("Invalid recovery download base");
  const plan = validate(input);
  return plan.platform === "win32" ? windowsCommand(plan, downloadBase) : posixCommand(plan, downloadBase);
}

/** The command line for the legacy omp's `bash` command: downloads and verifies the pinned helper, checks it carries the
 * recovery CLI, runs `recover-host` with strict flags, and exits with its status. Throws on any invalid input. */
export function buildLegacyRecoveryBootstrap(input: LegacyRecoveryInput): string {
  return legacyRecoveryBootstrapFor(input, GITHUB);
}

/** The two historical stdin lines that run `command` (only ever `buildLegacyRecoveryBootstrap`'s) through the legacy
 * omp's `bash` command. Send both, in this order, on the recovery channel: each daemon dialect refuses the other's
 * line without effect, so exactly one runs it (a repeated RPC id is refused while outstanding, and the helper's
 * `--operation` makes a replay idempotent).
 *  [0] RPC form `{id:"<requestId>", type:"bash", command, excludeFromContext:true}`; its reply is `{type:"response", id:"<requestId>"}`.
 *  [1] runner form `{t:"cmd", id:<requestId>, op:"bash", args:{command, excludeFromContext:true}}`; the daemon renumbers it and
 *      maps `{t:"res"|"bash_output", id}` replies back to `requestId`.
 * `excludeFromContext` keeps the output out of the recovery session's history. No trailing newline: the daemon adds it. */
export function legacyRecoveryEnvelopes(command: string, requestId: number): string[] {
  if (typeof command !== "string" || command.length === 0 || command.length > 1024 * 1024) throw new Error("Invalid legacy recovery command");
  if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error("Invalid legacy recovery request id");
  return [
    JSON.stringify({ id: String(requestId), type: "bash", command, excludeFromContext: true }),
    JSON.stringify({ t: "cmd", id: requestId, op: "bash", args: { command, excludeFromContext: true } }),
  ];
}
