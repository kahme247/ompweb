import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseOmpUpdateStatus, createCachedOmpUpdateCheck, OMP_UPDATE_CHECK_TTL_MS } = jiti("./updates.ts");
test("parses OMP update availability without assuming an update exists", () => {
  assert.deepEqual(parseOmpUpdateStatus("Current version: 17.2.11\nNew version available: 17.2.12"), {
    currentVersion: "17.2.11",
    availableVersion: "17.2.12",
    updateAvailable: true,
    updateCommand: "omp update",
  });
  assert.deepEqual(parseOmpUpdateStatus("Current version: 17.2.12\nOMP is up to date"), {
    currentVersion: "17.2.12",
    availableVersion: null,
    updateAvailable: false,
    updateCommand: "omp update",
  });
});

test("createCachedOmpUpdateCheck deduplicates concurrent calls and caches results within TTL", async () => {
  let runCalls = 0;
  let currentTime = 1_000_000;

  const fakeRun = async () => {
    runCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return "Current version: 17.2.11\nNew version available: 17.2.12";
  };

  const checker = createCachedOmpUpdateCheck(fakeRun, () => currentTime);

  // 1. Concurrent calls share one promise
  const [res1, res2, res3] = await Promise.all([checker(), checker(), checker()]);
  assert.equal(runCalls, 1, "Concurrent checks must only invoke run once");
  assert.equal(res1.availableVersion, "17.2.12");
  assert.equal(res2.availableVersion, "17.2.12");
  assert.equal(res3.availableVersion, "17.2.12");

  // 2. Cached within TTL
  currentTime += OMP_UPDATE_CHECK_TTL_MS - 1000;
  const resCached = await checker();
  assert.equal(runCalls, 1, "Must hit cache before TTL expiration");
  assert.equal(resCached.availableVersion, "17.2.12");

  // 3. TTL expiration causes new run
  currentTime += 2000;
  const resAfterTtl = await checker();
  assert.equal(runCalls, 2, "Must run check again after TTL expires");
  assert.equal(resAfterTtl.availableVersion, "17.2.12");

  // 4. Force bypasses completed cache
  const resForced = await checker(true);
  assert.equal(runCalls, 3, "force=true must bypass completed cache");
  assert.equal(resForced.availableVersion, "17.2.12");
});

test("createCachedOmpUpdateCheck reuses in-flight promise even when force is passed", async () => {
  let runCalls = 0;
  let resolveRun;
  const fakeRun = () => {
    runCalls += 1;
    return new Promise((resolve) => { resolveRun = resolve; });
  };

  const checker = createCachedOmpUpdateCheck(fakeRun);
  const firstPromise = checker(false);
  const secondPromise = checker(true); // force while first is still in flight

  assert.equal(runCalls, 1, "In-flight check must be reused even when force is true");
  resolveRun("Current version: 17.2.11\nOMP is up to date");
  const [res1, res2] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(res1.updateAvailable, false);
  assert.equal(res2.updateAvailable, false);
});

test("createCachedOmpUpdateCheck does not cache failures and allows retry", async () => {
  let runCalls = 0;
  let shouldFail = true;
  const fakeRun = async () => {
    runCalls += 1;
    if (shouldFail) throw new Error("Network error");
    return "Current version: 17.2.11\nNew version available: 17.2.13";
  };

  const checker = createCachedOmpUpdateCheck(fakeRun);

  await assert.rejects(checker(), /Network error/);
  assert.equal(runCalls, 1);

  shouldFail = false;
  const resRetry = await checker();
  assert.equal(runCalls, 2, "Must retry after prior failure");
  assert.equal(resRetry.availableVersion, "17.2.13");
});

// ============================================================================
// win32 cmd-wrap coverage for runOmpUpdate (third spawn site — see D5)
// ============================================================================

// moduleCache:false + tryNative:false keep t.mock.method(childProcess, ...) on
// the same CJS module instance the TypeScript import resolves (see omp-cli.test.mjs).
const mockSafeJiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

function withPlatform(t, platform) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", { value: original }));
}

function withOmpBin(t, bin) {
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
}

test("runOmpUpdate routes .cmd launchers through cmd.exe on win32", async (t) => {
  withPlatform(t, "win32");
  const dir = mkdtempSync(join(tmpdir(), "omp-update-cmd-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  withOmpBin(t, bin);
  let captured = null;
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "Current version: 18.2.7\nOMP is up to date"));
  });
  const { runOmpUpdate } = mockSafeJiti("./updates.ts");
  const output = await runOmpUpdate(["--check"]);
  assert.match(output, /Current version: 18\.2\.7/);
  assert.equal(captured.file, "cmd.exe");
  assert.deepEqual(captured.args, ["/c", bin, "update", "--check"]);
  assert.equal(captured.options.windowsHide, true);
});

test("runOmpUpdate leaves .exe binaries untouched", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-update-exe-"));
  const bin = join(dir, "omp.exe");
  writeFileSync(bin, "stub\n");
  withOmpBin(t, bin);
  let captured = null;
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "Current version: 18.2.7\nOMP is up to date"));
  });
  const { runOmpUpdate } = mockSafeJiti("./updates.ts");
  await runOmpUpdate(["--check"]);
  assert.equal(captured.file, bin);
  assert.deepEqual(captured.args, ["update", "--check"]);
});

test("runOmpUpdate never wraps .cmd on non-win32 platforms", async (t) => {
  withPlatform(t, "linux");
  const dir = mkdtempSync(join(tmpdir(), "omp-update-linux-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  withOmpBin(t, bin);
  let captured = null;
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "Current version: 18.2.7\nOMP is up to date"));
  });
  const { runOmpUpdate } = mockSafeJiti("./updates.ts");
  await runOmpUpdate(["--check"]);
  assert.equal(captured.file, bin);
  assert.deepEqual(captured.args, ["update", "--check"]);
});

test("real .cmd launcher through the real update path returns its stdout", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-update-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake-omp.cmd");
  writeFileSync(bin, [
    "@echo off",
    "echo Current version: 18.2.7",
    "echo OMP is up to date",
    "",
  ].join("\r\n"));
  withOmpBin(t, bin);
  const { runOmpUpdate, parseOmpUpdateStatus } = mockSafeJiti("./updates.ts");
  const output = await runOmpUpdate(["--check"]);
  assert.match(output, /OMP is up to date/);
  const status = parseOmpUpdateStatus(output);
  assert.equal(status.currentVersion, "18.2.7");
  assert.equal(status.updateAvailable, false);
});
