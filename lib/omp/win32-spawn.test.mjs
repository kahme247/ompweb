import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createJiti } from "jiti";

// moduleCache:false + tryNative:false keep t.mock.method(childProcess, ...) on
// the same CJS module instance the TypeScript import resolves (see omp-cli.test.mjs).
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

/** Replace process.platform for the duration of one test (helper reads it at call time). */
function withPlatform(t, platform) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", { value: original }));
}

/** Minimal fake child matching RpcProcess's constructor wiring (repo makeTransport shape). */
function makeSpawnHarness() {
  const spawnCalls = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4321,
  });
  return {
    spawnCalls,
    spawn(file, args, opts) {
      spawnCalls.push({ file, args, opts });
      return child;
    },
  };
}

function startProcess(bin, cwd, extraArgs = []) {
  const harness = makeSpawnHarness();
  const proc = new (jiti("./rpc-process.ts").RpcProcess)({
    cwd,
    extraArgs,
    dependencies: { resolveOmpBin: () => bin, spawn: harness.spawn },
  });
  return { proc, harness };
}

const CWD = mkdtempSync(join(tmpdir(), "omp-winspawn-"));

test("RpcProcess routes .cmd launchers through cmd.exe on win32", (t) => {
  withPlatform(t, "win32");
  const { harness } = startProcess("C:\\tools\\omp-work.cmd", CWD);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].file, "cmd.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["/c", "C:\\tools\\omp-work.cmd", "--mode", "rpc-ui", "--cwd", CWD]);
});

test("RpcProcess routes .bat launchers through cmd.exe on win32", (t) => {
  withPlatform(t, "win32");
  const { harness } = startProcess("C:\\tools\\omp-work.bat", CWD);
  assert.equal(harness.spawnCalls[0].file, "cmd.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["/c", "C:\\tools\\omp-work.bat", "--mode", "rpc-ui", "--cwd", CWD]);
});

test("RpcProcess matches script extensions case-insensitively", (t) => {
  withPlatform(t, "win32");
  const { harness } = startProcess("C:\\tools\\OMP-WORK.CMD", CWD);
  assert.equal(harness.spawnCalls[0].file, "cmd.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["/c", "C:\\tools\\OMP-WORK.CMD", "--mode", "rpc-ui", "--cwd", CWD]);
});

test("RpcProcess leaves .exe binaries untouched", () => {
  const { harness } = startProcess("C:\\tools\\omp.exe", CWD);
  assert.equal(harness.spawnCalls[0].file, "C:\\tools\\omp.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["--mode", "rpc-ui", "--cwd", CWD]);
});

test("RpcProcess leaves extensionless binaries untouched", () => {
  const { harness } = startProcess("omp", CWD);
  assert.equal(harness.spawnCalls[0].file, "omp");
  assert.deepEqual(harness.spawnCalls[0].args, ["--mode", "rpc-ui", "--cwd", CWD]);
});

test("RpcProcess never wraps .cmd on non-win32 platforms", (t) => {
  withPlatform(t, "linux");
  const { harness } = startProcess("/usr/local/bin/omp-work.cmd", CWD);
  assert.equal(harness.spawnCalls[0].file, "/usr/local/bin/omp-work.cmd");
  assert.deepEqual(harness.spawnCalls[0].args, ["--mode", "rpc-ui", "--cwd", CWD]);
});

test("production launcher produces the exact Phase 5.3 spawn shape with options unchanged", (t) => {
  withPlatform(t, "win32");
  const launcher = "C:\\Users\\ChristianStarcke\\.local\\bin\\omp-work.cmd";
  const { harness } = startProcess(launcher, CWD);
  const call = harness.spawnCalls[0];
  assert.equal(call.file, "cmd.exe");
  assert.deepEqual(call.args, ["/c", launcher, "--mode", "rpc-ui", "--cwd", CWD]);
  // Everything except (file, args) must be byte-for-byte what the unwrapped
  // spawn produced before the patch.
  assert.equal(call.opts.cwd, CWD);
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.detached, false);
  assert.deepEqual(call.opts.stdio, ["pipe", "pipe", "pipe"]);
  assert.ok(call.opts.env && typeof call.opts.env === "object");
});

test("probeOmpVersion routes .cmd launchers through cmd.exe on win32", async (t) => {
  withPlatform(t, "win32");
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  let captured = null;
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  });
  const { getOmpVersion } = jiti("./omp-cli.ts");
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(captured.file, "cmd.exe");
  assert.deepEqual(captured.args, ["/c", bin, "--version"]);
  assert.equal(captured.options.windowsHide, true);
});

test("probeOmpVersion leaves .exe binaries untouched", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp.exe");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  let captured = null;
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  });
  const { getOmpVersion } = jiti("./omp-cli.ts");
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(captured.file, bin);
  assert.deepEqual(captured.args, ["--version"]);
});

test("probeOmpVersion never wraps .cmd on non-win32 platforms", async (t) => {
  withPlatform(t, "linux");
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  let captured = null;
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  });
  const { getOmpVersion } = jiti("./omp-cli.ts");
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(captured.file, bin);
  assert.deepEqual(captured.args, ["--version"]);
});

test("real .cmd launcher through the real spawn path receives spaced arguments intact", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake-omp.cmd");
  const argsFile = join(dir, "args.txt");
  // The engine stub announces readiness like omp, then records its raw argument
  // tail so the test can pin cmd.exe quoting of the spaced --cwd argument.
  writeFileSync(bin, [
    "@echo off",
    "echo {\"type\":\"ready\",\"protocolVersion\":1}",
    "> \"%~dp0args.txt\" echo %*",
    "",
  ].join("\r\n"));
  // The spawn cwd itself contains a literal space — the exact production shape
  // of a project directory passed as --cwd.
  const spacedCwd = join(dir, "temp dir x");
  mkdirSync(spacedCwd);

  const { promise: exited, resolve: resolveExit } = Promise.withResolvers();
  new (jiti("./rpc-process.ts").RpcProcess)({
    cwd: spacedCwd,
    dependencies: { resolveOmpBin: () => bin }, // real child_process.spawn — no seam
    onExit: (info) => resolveExit(info),
  });
  // The stub exits quickly; asserting the exit code and the recorded argument
  // tail (which proves stdio + cmd.exe quoting end to end) is deterministic,
  // unlike racing the ready frame against the exit event.
  const info = await exited;
  assert.equal(info.code, 0);
  const rawTail = readFileSync(argsFile, "utf8").replace(/\r\n/g, "\n").trim();
  assert.equal(rawTail, `--mode rpc-ui --cwd "${spacedCwd}"`);
});

test("real .cmd launcher through the real version probe returns its stdout", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake-omp.cmd");
  const argsFile = join(dir, "probe-args.txt");
  writeFileSync(bin, [
    "@echo off",
    "> \"%~dp0probe-args.txt\" echo %*",
    "echo omp/99.9.9-win",
    "",
  ].join("\r\n"));
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  const { getOmpVersion } = jiti("./omp-cli.ts");
  assert.equal(await getOmpVersion(), "omp/99.9.9-win");
  const rawArgs = readFileSync(argsFile, "utf8").replace(/\r\n/g, "\n").trim();
  assert.equal(rawArgs, "--version");
});
