import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

const { parseOmpUpdateStatus, createCachedOmpUpdateCheck, OMP_UPDATE_CHECK_TTL_MS } = await import("./updates.ts");
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

// Each test imports updates.ts fresh so it binds the mocked child_process.
let freshImport = 0;

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
    // omp-cli keeps the resolved path while it exists; ./updates.ts shares that module across fresh imports.
    rmSync(dirname(bin), { recursive: true, force: true });
  });
}

test("runOmpUpdate routes .cmd launchers through cmd.exe on win32", async (t) => {
  withPlatform(t, "win32");
  const dir = mkdtempSync(join(tmpdir(), "omp-update-cmd-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  withOmpBin(t, bin);
  let captured = null;
  await mockBuiltin(t, "node:child_process", { execFile: (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "Current version: 18.2.7\nOMP is up to date"));
  } });
  const { runOmpUpdate } = await import(`./updates.ts?fresh=${freshImport++}`);
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
  await mockBuiltin(t, "node:child_process", { execFile: (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "Current version: 18.2.7\nOMP is up to date"));
  } });
  const { runOmpUpdate } = await import(`./updates.ts?fresh=${freshImport++}`);
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
  await mockBuiltin(t, "node:child_process", { execFile: (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "Current version: 18.2.7\nOMP is up to date"));
  } });
  const { runOmpUpdate } = await import(`./updates.ts?fresh=${freshImport++}`);
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
  const { runOmpUpdate, parseOmpUpdateStatus } = await import(`./updates.ts?fresh=${freshImport++}`);
  const output = await runOmpUpdate(["--check"]);
  assert.match(output, /OMP is up to date/);
  const status = parseOmpUpdateStatus(output);
  assert.equal(status.currentVersion, "18.2.7");
  assert.equal(status.updateAvailable, false);
});

// The deadline itself, exercised at the subprocess boundary: a real launcher
// that answers after the old 15 s bound must succeed, and one that outlives the
// new 30 s bound must be terminated. `scaleOmpUpdateCheckTimeoutForTests` runs
// both against the real default deadline in a fraction of the wall time, so
// these assertions fail if the default drops back to 15 s or grows past 30 s.
const CHECK_SCALE = 1 / 20; // 30 s → 1.5 s, the old 15 s → 750 ms
const NEW_DEADLINE_MS = 30_000 * CHECK_SCALE;
const OLD_DEADLINE_MS = 15_000 * CHECK_SCALE;

/**
 * A launcher that waits `delayMs` and then answers like `omp update --check`.
 *
 * It records its own pid before waiting, so a test can prove the process is
 * really gone after the deadline instead of only that the promise rejected.
 */
function writeSlowLauncher(t, delayMs) {
  const dir = mkdtempSync(join(tmpdir(), "omp-update-slow-"));
  const script = join(dir, "slow-omp.cjs");
  const pidFile = join(dir, "slow-omp.pid");
  writeFileSync(script, [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `setTimeout(() => {`,
    `  process.stdout.write("Current version: 18.2.7\\nOMP is up to date\\n");`,
    `}, ${delayMs});`,
    "",
  ].join("\n"));
  const bin = join(dir, "slow-omp");
  if (process.platform === "win32") {
    writeFileSync(`${bin}.cmd`, `@"${process.execPath.replaceAll("%", "%%")}" "${script.replaceAll("%", "%%")}" %*\r\n`);
    withOmpBin(t, `${bin}.cmd`);
  } else {
    writeFileSync(bin, `#!${process.execPath}\n${readFileSync(script, "utf8")}`, { mode: 0o755 });
    withOmpBin(t, bin);
  }
  return { bin, pidFile };
}

/** Wait until the launcher has written its pid, or give up after `timeoutMs`. */
async function readLauncherPid(pidFile, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the launcher never wrote its pid to ${pidFile}`);
}

/** True while `pid` names a live process. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else; anything else is gone.
    return error?.code === "EPERM";
  }
}

test("a cold check that answers after the old 15 s deadline still succeeds", { timeout: 20000 }, async (t) => {
  writeSlowLauncher(t, OLD_DEADLINE_MS + 250);
  const { runOmpUpdate, parseOmpUpdateStatus, scaleOmpUpdateCheckTimeoutForTests } = await import(`./updates.ts?fresh=${freshImport++}`);
  scaleOmpUpdateCheckTimeoutForTests(CHECK_SCALE);
  t.after(() => scaleOmpUpdateCheckTimeoutForTests(1));
  const started = Date.now();
  const output = await runOmpUpdate(["--check"]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed > OLD_DEADLINE_MS, `the launcher answered after the old bound (${elapsed} ms)`);
  assert.equal(parseOmpUpdateStatus(output).currentVersion, "18.2.7");
});

test("a check that outlives the 30 s deadline is terminated, not left running", { timeout: 20000 }, async (t) => {
  // The launcher must outlive the assertion window by a wide margin: if it
  // exited on its own, "gone" would prove nothing about the tree kill.
  const { pidFile } = writeSlowLauncher(t, 60_000);
  const { runOmpUpdate, scaleOmpUpdateCheckTimeoutForTests } = await import(`./updates.ts?fresh=${freshImport++}`);
  scaleOmpUpdateCheckTimeoutForTests(CHECK_SCALE);
  t.after(() => scaleOmpUpdateCheckTimeoutForTests(1));
  const started = Date.now();
  const pending = runOmpUpdate(["--check"]);
  // The launcher is a real process behind cmd.exe on Windows: record its pid
  // so the assertion is about that process, not about the promise.
  const pid = await readLauncherPid(pidFile);
  assert.ok(isProcessAlive(pid), "the launcher must be running before the deadline");
  await assert.rejects(pending, /Command failed/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= NEW_DEADLINE_MS, `it waited for the new deadline (${elapsed} ms)`);
  assert.ok(elapsed < NEW_DEADLINE_MS + 1000, `it stopped the launcher instead of waiting it out (${elapsed} ms)`);
  // The claim in the title: the slow child is not left running. Node's own
  // `timeout` only kills cmd.exe, so this fails without the tree kill.
  const gone = await waitUntilGone(pid);
  assert.ok(gone, `the launcher (pid ${pid}) must exit when the check times out`);
});

// The reaper must not depend on PATH: an omp session's sanitized environment or
// a user PATH without System32 would make a bare `taskkill` unresolvable exactly
// when a wedged check needs reaping. The deadline path is driven here with a
// fake clock, so the assertion is about the executable the reaper spawns. Runs
// on every platform: `withPlatform` simulates win32, so Linux CI covers it too.
test("the timeout tree kill reaps through the absolute System32 taskkill path", { timeout: 20000 }, async (t) => {
  withPlatform(t, "win32");
  const dir = mkdtempSync(join(tmpdir(), "omp-update-reaper-"));
  const bin = join(dir, "fake-omp.cmd");
  writeFileSync(bin, "stub\n");
  withOmpBin(t, bin);
  const spawned = [];
  let settleExec;
  const execFile = (file, args, options, callback) => {
    // Never answers on its own: the deadline is what ends this check. The
    // reaper below settles it, the way a real kill makes execFile report.
    settleExec = () => callback(new Error("killed"), "", "");
    return { pid: 4242, exitCode: null, signalCode: null, kill() {} };
  };
  const spawn = (command, args) => {
    spawned.push({ command, args });
    setTimeout(() => settleExec?.(), 0);
    return { once() {}, unref() {} };
  };
  await mockBuiltin(t, "node:child_process", { execFile, spawn });
  const { runOmpUpdate } = await import(`./updates.ts?fresh=${freshImport++}`);
  // A 0 ms deadline fires on the next timers phase; the check never answers.
  await assert.rejects(runOmpUpdate(["--check"], 0), /timed out/);
  const reaper = spawned.find((entry) => entry.args.includes("/t"));
  assert.ok(reaper, "the deadline spawned a tree reaper");
  const expected = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "taskkill.exe");
  assert.equal(reaper.command, expected, "the reaper is addressed absolutely, not through PATH");
  assert.deepEqual(reaper.args, ["/pid", "4242", "/t", "/f"]);
});

/** Poll for `pid` to disappear; the tree kill is asynchronous on Windows. */
async function waitUntilGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  return false;
}
