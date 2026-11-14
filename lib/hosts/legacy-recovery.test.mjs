// The legacy recovery bootstrap (lib/hosts/legacy-recovery.ts). Generation and refusal tests run everywhere; the
// execution tests run the real generated bootstrap on this machine's own platform against a local server that lays a
// release out as GitHub does: POSIX uses the real sh, curl, tar, sha256sum/shasum and grep; Windows uses the real
// powershell.exe (.NET HttpClient, SHA256, ZipArchive) and a real compiled helper executable, and, when Git Bash is
// installed, also the bash transport the legacy runner uses. Nothing is mocked on the executing side.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { gzipSync } from "node:zlib";
import { releaseRepo } from "../release-repo.ts";
import { buildLegacyRecoveryBootstrap, legacyRecoveryBootstrapFor, legacyRecoveryEnvelopes, RECOVERY_CLI_MARKER_BASE64 } from "./legacy-recovery.ts";
import { LINK_LIMITS } from "./link-protocol.ts";
import { parseWire } from "./pending-requests.ts";

const REPO = releaseRepo();
const OPERATION = "0b9a7d5e-3c1f-4c9a-9d54-6a3f2a8e7c11";
const MARKER = Buffer.from(RECOVERY_CLI_MARKER_BASE64, "base64").toString();
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const ZERO = `sha256:${"0".repeat(64)}`;
const ASSET_NAMES = ["ompweb-linux-x64.tar.gz", "ompweb-linux-arm64.tar.gz", "ompweb-darwin-x64.tar.gz", "ompweb-darwin-arm64.tar.gz", "ompweb-windows-x64.zip"];
const assets = (digest = ZERO) => ASSET_NAMES.map((name, index) => ({ name, digest: digest === ZERO ? `sha256:${String(index + 1).repeat(64)}` : digest }));
const helperRelease = (patch = {}) => ({ version: "0.8.0", repo: REPO, assets: assets(), ...patch });
const request = (patch = {}) => ({ operationId: OPERATION, helper: helperRelease(), targetVersion: "0.6.0", compatibility: { min: 12, max: 12 }, platform: "linux", force: false, ...patch });
const SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;
/** The script inside `sh -c '<script>' ompweb-recovery`; with a real sh, the quoting is proven to round-trip it exactly. */
const posixScript = (command) => {
  assert.ok(command.startsWith("sh -c '") && command.endsWith("' ompweb-recovery"));
  const quoted = command.slice("sh -c ".length, -" ompweb-recovery".length);
  const script = quoted.slice(1, -1).replaceAll("'\\''", "'");
  if (SH) assert.equal(spawnSync("sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" }).stdout, script);
  return script;
};
const windowsScript = (command) => {
  assert.match(command, /-EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(command.length < 32_000, "a Windows command line is limited to 32767 characters");
  return Buffer.from(command.split("-EncodedCommand ")[1], "base64").toString("utf16le");
};

function powershellFor(script) {
  const names = process.platform === "win32" ? ["powershell.exe", "pwsh"] : ["pwsh"];
  const name = names.find((candidate) => spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"]).status === 0);
  return name ? spawnSync(name, ["-NoProfile", "-NonInteractive", "-Command", "$s=[Console]::In.ReadToEnd(); $t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }"], { input: script, encoding: "utf8" }) : null;
}

test("the bootstrap refuses every malformed or hostile input before generating a command", () => {
  const hostile = ["x; id", "$(id)", "a'b", 'a"b', "a b", "a\nb", "`id`", "../x", "é", ""];
  const helper = (patch) => ({ helper: helperRelease(patch) });
  const digests = (digest) => ({ helper: helperRelease({ assets: assets().map((asset) => ({ ...asset, digest })) }) });
  const cases = [
    ...[...hostile, "a".repeat(81), undefined, 7].map((operationId) => ({ operationId })),
    ...[...hostile, "1.2", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-a b", "1.2.3'; id; '", "1".repeat(101), undefined, 7].map((targetVersion) => ({ targetVersion })),
    ...[...hostile, "1.2", "v1.2.3", "1.2.3'; id; '", undefined, 7].map((version) => helper({ version })),
    ...["evil/ompweb", `${REPO};id`, `${REPO}'`, `../${REPO}`, `${REPO}/x`, `${REPO}\n`, "", undefined, 7].map((repo) => helper({ repo })),
    ...["v9.9.9", "latest", "20261113T113829Z-XYZ", "20261113T113829Z-546a945df0;id", "../v0.8.0", "v0.8.0/x", "", 7, null].map((tag) => helper({ tag })),
    ...[`sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, "a".repeat(64), `sha256:${"a".repeat(64)}'; id #`, "sha256:", "", 7].map(digests),
    helper({ assets: [] }),
    helper({ assets: assets().filter((asset) => !asset.name.includes("linux")) }),
    helper({ assets: [...assets(), { name: "ompweb-linux-x64.tar.gz", digest: ZERO }] }),
    helper({ assets: "ompweb-linux-x64.tar.gz" }),
    helper({ assets: [null] }),
    helper({ assets: [{ name: 7, digest: ZERO }] }),
    ...["freebsd", "linux; id", "WIN32", "windows", "", undefined, "__proto__", "toString"].map((platform) => ({ platform })),
    { platform: "win32", helper: helperRelease({ assets: assets().filter((asset) => !asset.name.endsWith(".zip")) }) },
    { platform: "darwin", helper: helperRelease({ assets: assets().filter((asset) => !asset.name.includes("darwin")) }) },
    ...[{ min: 0, max: 1 }, { min: 2, max: 1 }, { min: 1.5, max: 2 }, { min: "1", max: 2 }, { min: Number.NaN, max: 1 }, { min: 1, max: 1001 }, { min: 1, max: Infinity }, null].map((compatibility) => ({ compatibility })),
    ...["true", 1, undefined, null].map((force) => ({ force })),
    ...[null, undefined, "x", []].map((helperValue) => ({ helper: helperValue })),
  ];
  for (const patch of cases) {
    assert.throws(() => buildLegacyRecoveryBootstrap(request(patch)), /Invalid legacy recovery request/, JSON.stringify(patch));
  }
  assert.throws(() => buildLegacyRecoveryBootstrap(null), /Invalid legacy recovery request/);
  assert.throws(() => legacyRecoveryBootstrapFor(request(), "http://127.0.0.1:1/x"), /Invalid recovery download base/);
  assert.throws(() => legacyRecoveryBootstrapFor(request(), "https://github.com'; id; '"), /Invalid recovery download base/);
});

test("a helper missing its architecture's asset only fails on that architecture, naming it", () => {
  const command = buildLegacyRecoveryBootstrap(request({ helper: helperRelease({ assets: assets().filter((asset) => asset.name !== "ompweb-linux-arm64.tar.gz") }) }));
  const script = posixScript(command);
  assert.match(script, /aarch64\|arm64\) arch=arm64; want=; fail 'the pinned release has no arm64 asset' ;;/);
  assert.match(script, /x86_64\|amd64\) arch=x64; want='1{64}'; : ;;/);
});

test("a prerelease helper downloads its own tag, never the stable release of the same version", () => {
  const tag = "20261113T113829Z-546a945df0";
  const prefix = `https://github.com/${REPO}/releases/download`;
  const prerelease = request({ helper: helperRelease({ tag }) });
  assert.ok(posixScript(buildLegacyRecoveryBootstrap(prerelease)).includes(`url='${prefix}/${tag}/'"$asset"`));
  assert.ok(windowsScript(buildLegacyRecoveryBootstrap({ ...prerelease, platform: "win32" })).includes(`'${prefix}/${tag}/ompweb-windows-x64.zip'`));
  assert.ok(!posixScript(buildLegacyRecoveryBootstrap(prerelease)).includes("/v0.8.0/"));
  assert.ok(posixScript(buildLegacyRecoveryBootstrap(request())).includes(`url='${prefix}/v0.8.0/'"$asset"`));
  // A stable tag must name the helper's own version.
  assert.ok(buildLegacyRecoveryBootstrap(request({ helper: helperRelease({ tag: "v0.8.0" }) })));
});

test("the POSIX bootstrap pins one asset per architecture, streams one member and runs the fixed CLI", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const force of [false, true]) {
      const command = buildLegacyRecoveryBootstrap(request({ platform, force, compatibility: { min: 11, max: 12 } }));
      const script = posixScript(command);
      const os = platform === "darwin" ? "Darwin" : "Linux";
      assert.ok(script.includes(`[ "$(uname -s)" = '${os}' ]`));
      assert.ok(script.includes(`url='https://github.com/${REPO}/releases/download/v0.8.0/'"$asset"`));
      assert.ok(script.includes(`asset="ompweb-${platform}-$arch.tar.gz"`));
      const first = platform === "linux" ? 1 : 3;
      assert.ok(script.includes(`arch=x64; want='${String(first).repeat(64)}'`));
      assert.ok(script.includes(`arch=arm64; want='${String(first + 1).repeat(64)}'`));
      assert.ok(script.includes(`marker='${MARKER}'`));
      assert.ok(script.includes("--proto '=https' --proto-redir '=https' --tlsv1.2"));
      assert.ok(script.includes("--max-time 900 --max-filesize 536870912"));
      assert.deepEqual([...script.matchAll(/\btar\s+-\w+/g)].map((match) => match[0]), ["tar -tzf", "tar -xzOf"]);
      assert.ok(script.includes(`tar -xzOf "$work/archive" "$entry" > "$work/ompweb"`));
      assert.ok(script.includes(`'recover-host' '--operation' '${OPERATION}' '--version' '0.6.0' '--min-protocol' '11' '--max-protocol' '12'${force ? " '--force'" : " </dev/null"}`));
      assert.equal(script.includes("'--force'"), force);
      assert.doesNotMatch(script, /\beval\b|\bsource\b|\|\s*(?:ba|z)?sh\b|\btar\b[^\n]*\s-C\b|bearer|authorization|password|secret|\btoken\b/i);
      if (SH) assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
    }
  }
});

test("the Windows bootstrap is native PowerShell/.NET with no Unix tool, passed as one encoded command", () => {
  for (const force of [false, true]) {
    const command = buildLegacyRecoveryBootstrap(request({ platform: "win32", force, compatibility: { min: 11, max: 12 } }));
    assert.match(command, /^ps=powershell\.exe; command -v "\$ps" >\/dev\/null 2>&1 \|\| ps="\$\{SYSTEMROOT:-\/c\/Windows\}\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe"; MSYS2_ARG_CONV_EXCL='\*' "\$ps" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand /);
    assert.doesNotMatch(command.split("-EncodedCommand ")[0], /curl|tar|unzip|bearer/i);
    const script = windowsScript(command);
    assert.ok(script.includes(`'https://github.com/${REPO}/releases/download/v0.8.0/ompweb-windows-x64.zip'`));
    assert.ok(script.includes(`$want = '${"5".repeat(64)}'`));
    assert.ok(script.includes(`$entry = 'ompweb-windows-x64/ompweb.exe'`));
    assert.ok(script.includes(`$marker = '${MARKER}'`));
    for (const required of ["PROCESSOR_ARCHITEW6432", "System.Net.Http", "SHA256", "IO.Compression.ZipArchive", "-cne $entry", "ReadAsync(", "CancelAfter(900000)", "DirectorySecurity", "-ne 1"]) assert.ok(script.includes(required), required);
    assert.ok(script.includes(`@('recover-host','--operation','${OPERATION}','--version','0.6.0','--min-protocol','11','--max-protocol','12'${force ? ",'--force'" : ""})`));
    assert.doesNotMatch(script, /\bcurl\b|\btar\b|\bbash\b|\bunzip\b|Expand-Archive|Invoke-WebRequest|Invoke-Expression|\biex\b|bearer|authorization|password|secret/i);
    const parsed = powershellFor(script);
    if (parsed) assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
  }
});

test("the two historical envelopes carry one command and each dialect's parser refuses the other's line", () => {
  const command = buildLegacyRecoveryBootstrap(request());
  const [rpcLine, runnerLine] = legacyRecoveryEnvelopes(command, 7);
  const rpc = JSON.parse(rpcLine);
  const runner = JSON.parse(runnerLine);
  assert.deepEqual(rpc, { id: "7", type: "bash", command, excludeFromContext: true });
  assert.deepEqual(runner, { t: "cmd", id: 7, op: "bash", args: { command, excludeFromContext: true } });
  // A runner-form daemon's DaemonChannels.stdin parses with parseWire: no `t`, no command.
  assert.equal(parseWire(rpcLine), null);
  assert.deepEqual(parseWire(runnerLine)?.args, runner.args);
  // An RPC-form daemon's stdin (v10 prerelease 546a945df0) needs a string `type` and refuses ids it reserves with "d:".
  assert.equal(runner.type, undefined);
  assert.equal(rpc.t, undefined);
  assert.ok(typeof rpc.type === "string" && typeof rpc.id === "string" && !rpc.id.startsWith("d:"));
  for (const line of [rpcLine, runnerLine]) {
    assert.ok(!line.includes("\n"));
    assert.ok(Buffer.byteLength(line) < LINK_LIMITS.maxLineBytes);
  }
  assert.deepEqual(legacyRecoveryEnvelopes(command, 7), [rpcLine, runnerLine]);
  assert.notDeepEqual(legacyRecoveryEnvelopes(command, 8), [rpcLine, runnerLine]);
  for (const id of [0, -1, 1.5, "7", Number.NaN, undefined]) assert.throws(() => legacyRecoveryEnvelopes(command, id), /request id/);
  for (const bad of ["", undefined, 7, "x".repeat(1024 * 1024 + 1)]) assert.throws(() => legacyRecoveryEnvelopes(bad, 7), /Invalid legacy recovery command/);
});

test("the helper's recovery CLI embeds the marker the bootstrap searches for, and this module does not", async () => {
  const { RECOVERY_CLI_MARKER } = await import("./recovery.ts");
  assert.equal(RECOVERY_CLI_MARKER, MARKER);
  assert.ok(!readFileSync(new URL("./legacy-recovery.ts", import.meta.url), "utf8").includes(MARKER));
});

// --- Native execution -------------------------------------------------------------------------------------------

const NATIVE = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
const WINDOWS = NATIVE === "windows";
const SUPPORTED = NATIVE !== undefined && ["x64", "arm64"].includes(process.arch) && !(WINDOWS && process.arch !== "x64");
const ROOT = `ompweb-${NATIVE}-${process.arch}`;
const ENTRY = `${ROOT}/${WINDOWS ? "ompweb.exe" : "ompweb"}`;
const GIT_BASH = WINDOWS ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")].find((path) => existsSync(path)) : undefined;

function tarGz(members) {
  const blocks = [];
  for (const { name, data } of members) {
    const head = Buffer.alloc(512);
    head.write(name, 0, 100);
    head.write("0000755\0", 100);
    head.write("0000000\0", 108);
    head.write("0000000\0", 116);
    head.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    head.write("00000000000\0", 136);
    head.write("        ", 148);
    head[156] = 0x30;
    head.write("ustar\x0000", 257);
    head.write(`${[...head].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of stored (uncompressed) entries named exactly as given, duplicates included. */
function zipStore(members) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of members) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);
    parts.push(local, nameBytes, data);
    offset += local.length + nameBytes.length + data.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

/** Records its arguments, one per line, in $RECOVERY_TEST_OUT and exits with $RECOVERY_TEST_EXIT. */
const posixHelper = (withMarker) => Buffer.from(`#!/bin/sh\n${withMarker ? `# ${MARKER}\n` : ""}printf '%s\\n' "$@" > "$RECOVERY_TEST_OUT"\nexit "\${RECOVERY_TEST_EXIT:-0}"\n`);

const compiledHelpers = [];
let windowsExe;
/** A real console executable built by the .NET Framework compiler PowerShell 5.1 carries; the marker is an overlay. */
function windowsHelper(withMarker) {
  if (!windowsExe) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "legacy-recovery-helper-")));
    compiledHelpers.push(dir);
    const source = join(dir, "helper.cs");
    const exe = join(dir, "helper.exe");
    writeFileSync(source, 'using System; using System.IO; public static class Helper { public static int Main(string[] args) { File.WriteAllLines(Environment.GetEnvironmentVariable("RECOVERY_TEST_OUT"), args); int code; return int.TryParse(Environment.GetEnvironmentVariable("RECOVERY_TEST_EXIT"), out code) ? code : 0; } }');
    const built = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source}')) -OutputAssembly '${exe}' -OutputType ConsoleApplication`], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    windowsExe = readFileSync(exe);
  }
  return withMarker ? Buffer.concat([windowsExe, Buffer.from(`\n${MARKER}\n`)]) : windowsExe;
}

after(() => {
  for (const dir of compiledHelpers) rmSync(dir, { recursive: true, force: true });
});

function listen(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = routes.get(req.url);
    res.writeHead(body ? 200 : 404, body ? { "content-length": body.length } : {});
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

function run(command, env, cwd, bash) {
  const [file, args] = bash ? [GIT_BASH, ["-c", command]]
    : WINDOWS ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", command.split("-EncodedCommand ")[1]]]
    : ["sh", ["-c", command]];
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const defaultMembers = (helper) => [
  { name: `${ROOT}/other-file`, data: Buffer.from("not the binary") },
  { name: ENTRY, data: helper(true) },
  { name: "ompweb-recovery-decoy", data: Buffer.from("extracted if the whole archive were unpacked") },
  { name: "../ompweb-recovery-escape", data: Buffer.from("extracted if archive paths were honoured") },
];

/** Runs the real generated bootstrap for this platform against a local server; returns what it did on disk. */
async function scenario(t, { platform = process.platform, members = defaultMembers, digest, serve = true, exitCode = 0, force = false, bash = false } = {}) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "legacy-recovery-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const scratch = join(tmp, "scratch");
  const cwd = join(tmp, "work", "cwd");
  const out = join(tmp, "helper-args.txt");
  mkdirSync(scratch);
  mkdirSync(cwd, { recursive: true });
  const archive = (WINDOWS ? zipStore : tarGz)(members(WINDOWS ? windowsHelper : posixHelper));
  const name = `ompweb-${platform === "win32" ? "windows" : platform}-${process.arch}${platform === "win32" ? ".zip" : ".tar.gz"}`;
  const { server, requests, base } = await listen(new Map(serve ? [[`/${REPO}/releases/download/v0.8.0/${name}`, archive]] : []));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const command = legacyRecoveryBootstrapFor(request({ platform, force, targetVersion: "0.6.0", helper: helperRelease({ assets: [{ name, digest: digest ?? sha256(archive) }] }) }), base);
  const env = {
    ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, RECOVERY_TEST_OUT: out, RECOVERY_TEST_EXIT: String(exitCode),
    NO_PROXY: "*", no_proxy: "*", HTTP_PROXY: "", http_proxy: "", ALL_PROXY: "", all_proxy: "",
  };
  const result = await run(command, env, cwd, bash);
  const prefix = `ompweb-recovery-${OPERATION}-`;
  return {
    ...result, requests, scratch: readdirSync(scratch), scratchDir: scratch, prefix, cwd, tmp,
    helperArgs: existsSync(out) ? readFileSync(out, "utf8").split(/\r?\n/).filter(Boolean) : null,
  };
}

const native = { skip: !SUPPORTED, timeout: 120_000 };

test("the native bootstrap downloads the pinned archive, streams one member and runs the fixed recovery CLI", native, async (t) => {
  for (const force of [false, true]) {
    const result = await scenario(t, { force });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.helperArgs, ["recover-host", "--operation", OPERATION, "--version", "0.6.0", "--min-protocol", "12", "--max-protocol", "12", ...(force ? ["--force"] : [])]);
    assert.deepEqual(result.requests, [`/${REPO}/releases/download/v0.8.0/ompweb-${NATIVE}-${process.arch}${WINDOWS ? ".zip" : ".tar.gz"}`]);
    // Scratch is kept on success: the detached worker runs from it. Only the one member remains, in a private directory.
    const dirs = result.scratch.filter((entry) => entry.startsWith(result.prefix));
    assert.equal(dirs.length, 1, result.scratch.join(", "));
    const files = readdirSync(join(result.scratchDir, dirs[0])).sort();
    assert.deepEqual(files, [WINDOWS ? "ompweb.exe" : "ompweb"]);
    if (!WINDOWS) assert.equal(statSync(join(result.scratchDir, dirs[0])).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(result.cwd), [], "no archive path may reach the working directory");
    assert.ok(!existsSync(join(result.tmp, "work", "ompweb-recovery-escape")));
  }
});

const failures = [
  ["a digest that does not match is refused before the archive is read", { digest: ZERO }, 1, /digest mismatch/],
  ["a helper without the recovery marker is never run", { members: (helper) => [{ name: ENTRY, data: helper(false) }] }, 1, /no recovery support/],
  ["duplicate binary entries are refused", { members: (helper) => [{ name: ENTRY, data: helper(true) }, { name: ENTRY, data: helper(true) }] }, 1, /exactly one/],
  ["a missing binary entry is refused", { members: () => [{ name: `${ROOT}/other-file`, data: Buffer.from("x") }] }, 1, /exactly one/],
  ["a failed download is reported", { serve: false }, 1, /cannot download/],
  ["the helper's own failure status is the bootstrap's", { exitCode: 7 }, 7, /recover-host exited with 7/],
];
for (const [name, options, code, stderr] of failures) {
  test(`the native bootstrap: ${name}`, native, async (t) => {
    const result = await scenario(t, options);
    assert.equal(result.code, code, result.stdout + result.stderr);
    assert.match(result.stderr, stderr);
    assert.deepEqual(result.scratch, [], "a failed bootstrap leaves no scratch behind");
    if (!/exited with/.test(result.stderr)) assert.equal(result.helperArgs, null, "the helper must not have run");
    assert.deepEqual(readdirSync(result.cwd), []);
  });
}

test("a bootstrap built for another operating system refuses to run here", { skip: !SUPPORTED || WINDOWS, timeout: 60_000 }, async (t) => {
  const result = await scenario(t, { platform: NATIVE === "linux" ? "darwin" : "linux" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /was built for/);
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.scratch, []);
});

test("the Windows bootstrap runs through Git Bash, the legacy runner's transport", { skip: !SUPPORTED || !GIT_BASH, timeout: 120_000 }, async (t) => {
  const result = await scenario(t, { bash: true });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.helperArgs?.[0], "recover-host");
});
