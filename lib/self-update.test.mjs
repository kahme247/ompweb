import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chownSync, copyFileSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  abortPreparedSelfUpdate,
  acknowledgeSelfUpdate,
  cleanupStaleSelfUpdate,
  armSelfUpdateLauncher,
  commitSelfUpdate,
  detectGlobalInstall,
  getSelfUpdateStatus,
  markSelfUpdateStopping,
  resolveSelfUpdateTempRoot,
  validateCommitSelfUpdate,
} = jiti("./self-update.ts");
const { POST: appUpdatePost } = jiti("../app/api/app-update/route.ts");
const { cancelAppUpdateDrain } = jiti("./rpc-manager.ts");
const workerUrl = new URL("../bin/omp-web-update-worker.js", import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const workerModule = require(workerPath);
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectAfter(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}


async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await delay(25);
  }
  return false;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(25);
  }
  return !isProcessAlive(pid);
}


function extractFunctionBody(source, signature) {
  const declaration = source.indexOf(signature);
  assert.notEqual(declaration, -1, `missing function declaration: ${signature}`);
  const openingBrace = source.indexOf("{", declaration + signature.length);
  assert.notEqual(openingBrace, -1, `missing function body: ${signature}`);
  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(openingBrace + 1, index);
  }
  assert.fail(`unterminated function body: ${signature}`);
}
function withIsolatedState(run) {
  const fixture = mkdtempSync(join(tmpdir(), "ompweb-self-update-state-"));
  const names = ["TEMP", "TMP", "TMPDIR"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const cleanup = () => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    rmSync(fixture, { recursive: true, force: true });
  };
  for (const name of names) process.env[name] = fixture;
  try {
    const root = resolveSelfUpdateTempRoot();
    const paths = { root, lease: join(root, "lease.json"), status: join(root, "status.json") };
    assert.ok(paths.root.startsWith(fixture), `isolated root escaped fixture: ${paths.root}`);
    const result = run({ fixture, ...paths });
    if (result && typeof result.then === "function") return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}
async function withMockLauncher(send, run) {
  const connected = Object.getOwnPropertyDescriptor(process, "connected");
  const processSend = Object.getOwnPropertyDescriptor(process, "send");
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  Object.defineProperty(process, "send", { configurable: true, value: send });
  try {
    return await run();
  } finally {
    if (connected) Object.defineProperty(process, "connected", connected);
    else delete process.connected;
    if (processSend) Object.defineProperty(process, "send", processSend);
    else delete process.send;
  }
}

function commitRequest(attemptId) {
  return new Request("http://127.0.0.1/api/app-update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "commit", attemptId }),
  });
}

test("source and unknown installs are rejected without a manager fallback", () => {
  const result = detectGlobalInstall(process.cwd());
  assert.equal(result.supported, false);
  assert.ok(["source_install", "not_global_install"].includes(result.reason));
});

test("update attempts use the current user's temporary directory", () => {
  assert.equal(
    resolveSelfUpdateTempRoot("win32", "C:\\Temp"),
    "C:\\Temp\\ompweb-self-update",
  );
  assert.equal(resolveSelfUpdateTempRoot("linux", "/tmp", 1000), "/tmp/ompweb-self-update-1000");
  assert.equal(resolveSelfUpdateTempRoot("darwin", "/private/tmp", 501), "/private/tmp/ompweb-self-update-501");
});

test("restart descriptors keep only the fixed launcher path and endpoint", () => {
  const source = readFileSync(new URL("./self-update.ts", import.meta.url), "utf8");
  const parser = extractFunctionBody(source, "function parseDescriptor()");
  assert.match(parser, /descriptor\.launcherPath/);
  assert.match(parser, /descriptor\.hostname/);
  assert.match(parser, /descriptor\.port/);
  assert.doesNotMatch(parser, /launcherArgs/);
});

test("symlinked update roots are rejected", (context) => {
  const fixture = mkdtempSync(join(tmpdir(), "ompweb-self-update-symlink-"));
  const names = ["TEMP", "TMP", "TMPDIR"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = fixture;
  try {
    const root = resolveSelfUpdateTempRoot();
    const target = join(fixture, "outside");
    mkdirSync(target);
    try {
      symlinkSync(target, root, "dir");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        context.skip("directory symlinks are unavailable for this user");
        return;
      }
      throw error;
    }
    assert.throws(() => cleanupStaleSelfUpdate(), (error) => error.code === "unsafe_update_state");
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("wrong-owner POSIX update roots are rejected where ownership can be changed", (context) => {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) {
    context.skip("ownership substitution requires a POSIX root test user");
    return;
  }
  withIsolatedState(({ root }) => {
    mkdirSync(root);
    chownSync(root, 1, 1);
    assert.throws(() => cleanupStaleSelfUpdate(), (error) => error.code === "unsafe_update_state");
  });
});

test("acknowledgement rejects unfinished or active attempts and deletes clean terminal state", () => {
  withIsolatedState(({ root, lease, status }) => {
    mkdirSync(root);
    const attemptId = crypto.randomUUID();
    const preparedAt = new Date().toISOString();
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt,
      cleanupReady: false,
    }));
    assert.throws(() => acknowledgeSelfUpdate(attemptId), (error) => error.code === "attempt_not_terminal");

    const terminal = {
      attemptId,
      state: "succeeded",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt,
      finishedAt: new Date().toISOString(),
    };

    writeFileSync(status, JSON.stringify({ ...terminal, cleanupReady: true, workerPid: process.pid }));
    assert.throws(() => acknowledgeSelfUpdate(attemptId), (error) => error.code === "cleanup_not_ready");

    writeFileSync(status, JSON.stringify({ ...terminal, cleanupReady: true, managerPid: process.pid }));
    assert.throws(() => acknowledgeSelfUpdate(attemptId), (error) => error.code === "cleanup_not_ready");

    writeFileSync(status, JSON.stringify({ ...terminal, cleanupReady: true }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    assert.throws(() => acknowledgeSelfUpdate(attemptId), (error) => error.code === "cleanup_not_ready");

    rmSync(lease);
    assert.deepEqual(acknowledgeSelfUpdate(attemptId), { acknowledged: true, attemptId });
    assert.equal(existsSync(status), false);
  });
});

test("stale terminal state expires but an active lease is never cleaned", () => {
  withIsolatedState(({ root, lease, status }) => {
    mkdirSync(root);
    const attemptId = crypto.randomUUID();
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const terminal = {
      attemptId,
      state: "failed",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: old,
      finishedAt: old,
      cleanupReady: true,
    };
    writeFileSync(status, JSON.stringify(terminal));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    cleanupStaleSelfUpdate();
    assert.equal(existsSync(status), true);

    rmSync(lease);
    cleanupStaleSelfUpdate();
    assert.equal(existsSync(status), false);
  });
});

test("stale cleanup retains an active expired worker and terminalizes it only after death", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    const helper = join(helperDir, "worker.js");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "preparing",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() - 1 }));

    cleanupStaleSelfUpdate();
    assert.equal(existsSync(lease), true);
    assert.equal(existsSync(helper), true);

    writeFileSync(status, JSON.stringify({
      ...JSON.parse(readFileSync(status, "utf8")),
      workerPid: 2_147_483_647,
    }));
    cleanupStaleSelfUpdate();
    const terminal = JSON.parse(readFileSync(status, "utf8"));
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.equal(existsSync(lease), false);
  });
});

test("a live recorded manager retains expired ownership after its worker dies", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    const helper = join(helperDir, "worker.js");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    const base = {
      attemptId,
      state: "running",
      stage: "installing",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      workerPid: 2_147_483_647,
    };
    writeFileSync(status, JSON.stringify({ ...base, managerPid: process.pid }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() - 1 }));

    cleanupStaleSelfUpdate();
    assert.equal(existsSync(lease), true);
    assert.throws(
      () => writeFileSync(lease, "new owner", { flag: "wx" }),
      (error) => error.code === "EEXIST",
    );

    writeFileSync(status, JSON.stringify({
      ...base,
      state: "failed",
      finishedAt: new Date().toISOString(),
      cleanupReady: false,
      startedAt: undefined,
      managerPid: process.pid,
    }));
    assert.equal(getSelfUpdateStatus()?.cleanupReady, false);
    assert.equal(existsSync(helper), true);

    writeFileSync(status, JSON.stringify({
      ...JSON.parse(readFileSync(status, "utf8")),
      managerPid: 2_147_483_647,
    }));
    assert.equal(getSelfUpdateStatus()?.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.equal(existsSync(lease), false);
  });
});

test("a pre-PID prepared attempt fails closed until its lease expires, then cleans its helper", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    const helper = join(helperDir, "worker.js");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "preparing",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
    }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));

    cleanupStaleSelfUpdate();
    assert.equal(JSON.parse(readFileSync(status, "utf8")).state, "prepared");
    assert.equal(existsSync(helper), true);
    assert.equal(existsSync(lease), true);

    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() - 1 }));
    cleanupStaleSelfUpdate();
    const terminal = JSON.parse(readFileSync(status, "utf8"));
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.equal(existsSync(lease), false);
  });
});

test("commit validation cleans a dead prepared helper and releases retry ownership", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    const helper = join(helperDir, "worker.js");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    writeFileSync(join(root, `${attemptId}.ready`), "ready");
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "stopping",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      workerPid: 2_147_483_647,
    }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));

    assert.equal(validateCommitSelfUpdate(attemptId), "replay");
    const terminal = JSON.parse(readFileSync(status, "utf8"));
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.equal(existsSync(join(root, `${attemptId}.ready`)), false);
    assert.equal(existsSync(lease), false);
    writeFileSync(lease, JSON.stringify({ attemptId: crypto.randomUUID(), expiresAt: Date.now() + 60_000 }), { flag: "wx" });
  });
});

test("an armed dead prepared helper retains ownership until launcher completion acknowledgement", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    const helper = join(helperDir, "worker.js");
    const armed = join(root, `${attemptId}.armed.json`);
    const complete = join(root, `${attemptId}.complete.json`);
    const completeAck = join(root, `${attemptId}.complete-ack.json`);
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    writeFileSync(join(root, `${attemptId}.ready`), "ready");
    writeFileSync(armed, JSON.stringify({ protocol: 1, attemptId, launcherPid: process.pid }));
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "stopping",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      workerPid: 2_147_483_647,
    }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));

    assert.equal(validateCommitSelfUpdate(attemptId), "replay");
    const terminal = JSON.parse(readFileSync(status, "utf8"));
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.cleanupReady, false);
    assert.equal(typeof terminal.startedAt, "string");
    assert.deepEqual(JSON.parse(readFileSync(complete, "utf8")), {
      protocol: 1,
      attemptId,
      state: "failed",
    });
    assert.equal(getSelfUpdateStatus()?.cleanupReady, false);
    assert.equal(existsSync(helper), true);
    assert.equal(existsSync(armed), true);
    assert.equal(existsSync(lease), true);
    assert.throws(
      () => writeFileSync(lease, "new owner", { flag: "wx" }),
      (error) => error.code === "EEXIST",
    );

    writeFileSync(completeAck, JSON.stringify({ protocol: 1, attemptId }));
    assert.equal(getSelfUpdateStatus()?.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.equal(existsSync(armed), false);
    assert.equal(existsSync(complete), false);
    assert.equal(existsSync(lease), false);
    assert.equal(existsSync(completeAck), true);
    writeFileSync(lease, JSON.stringify({ attemptId: crypto.randomUUID(), expiresAt: Date.now() + 60_000 }), { flag: "wx" });
  });
});

test("dead workers finalize only after launcher acknowledgement", () => {
  withIsolatedState(({ root, status }) => {
    const attemptId = crypto.randomUUID();
    const attemptDir = join(root, "attempts", attemptId);
    const helper = join(attemptDir, "worker.js");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "succeeded",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workerPid: 2_147_483_647,
      cleanupReady: false,
    }));

    assert.equal(getSelfUpdateStatus()?.cleanupReady, false);
    assert.equal(existsSync(helper), true);

    writeFileSync(join(root, `${attemptId}.complete-ack.json`), JSON.stringify({
      protocol: 1,
      attemptId,
    }));
    assert.equal(getSelfUpdateStatus()?.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.deepEqual(acknowledgeSelfUpdate(attemptId), { acknowledged: true, attemptId });
    assert.equal(existsSync(status), false);
  });
});

test("a dead armed launcher retains cleanup until its acknowledged restart gate exits", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const attemptDir = join(root, "attempts", attemptId);
    const helper = join(attemptDir, "worker.js");
    const armed = join(root, `${attemptId}.armed.json`);
    const restartAck = join(root, `${attemptId}.restart-ack.json`);
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    writeFileSync(armed, JSON.stringify({
      protocol: 1,
      attemptId,
      launcherPid: 2_147_483_647,
    }));
    writeFileSync(restartAck, JSON.stringify({
      protocol: 1,
      attemptId,
      generation: 1,
      pid: process.pid,
    }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "succeeded",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workerPid: 2_147_483_647,
      cleanupReady: false,
    }));

    assert.equal(getSelfUpdateStatus()?.cleanupReady, false);
    assert.equal(existsSync(helper), true);
    assert.equal(existsSync(lease), true);
    writeFileSync(restartAck, "{");
    assert.equal(getSelfUpdateStatus()?.cleanupReady, false);
    assert.equal(existsSync(lease), true);


    writeFileSync(restartAck, JSON.stringify({
      protocol: 1,
      attemptId,
      generation: 1,
      pid: 2_147_483_647,
    }));
    assert.equal(getSelfUpdateStatus()?.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.equal(existsSync(armed), false);
    assert.equal(existsSync(lease), false);
  });
});

test("a dead armed launcher without a restart acknowledgement settles cleanup", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const attemptDir = join(root, "attempts", attemptId);
    const helper = join(attemptDir, "worker.js");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(helper, "copied worker");
    writeFileSync(join(root, `${attemptId}.armed.json`), JSON.stringify({
      protocol: 1,
      attemptId,
      launcherPid: 2_147_483_647,
    }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "failed",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workerPid: 2_147_483_647,
      cleanupReady: false,
    }));

    assert.equal(getSelfUpdateStatus()?.cleanupReady, true);
    assert.equal(existsSync(helper), false);
    assert.equal(existsSync(lease), false);
  });
});

test("hardlinked helper substitution fails closed", () => {
  withIsolatedState(({ fixture, root, status }) => {
    const attemptId = crypto.randomUUID();
    const attemptDir = join(root, "attempts", attemptId);
    const outside = join(fixture, "outside-worker.js");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(outside, "outside");
    linkSync(outside, join(attemptDir, "worker.js"));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "failed",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: old,
      finishedAt: old,
      cleanupReady: false,
    }));
    assert.throws(() => cleanupStaleSelfUpdate(), (error) => error.code === "unsafe_update_state");
    assert.equal(readFileSync(outside, "utf8"), "outside");
    assert.equal(existsSync(status), true);
  });
});


test("commit rejects malformed attempts before draining sessions", () => {
  assert.throws(() => validateCommitSelfUpdate("not-an-attempt"), (error) => {
    assert.equal(error.code, "invalid_attempt");
    return true;
  });
});

test("concurrent same-process commits join one owned transition", async () => {
  await withIsolatedState(async ({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "worker.js"), "copied worker");
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "preparing",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));

    let submissions = 0;
    await withMockLauncher((message) => {
      submissions += 1;
      assert.equal(message.attemptId, attemptId);
      if (submissions === 1) {
        setTimeout(() => {
          writeFileSync(join(root, `${attemptId}.armed.json`), JSON.stringify({ protocol: 1, attemptId, launcherPid: process.pid }));
          process.emit("message", {
            type: "ompweb:update-control-ack",
            protocol: 1,
            attemptId,
            ok: true,
          });
        }, 50);
      }
      return true;
    }, async () => {
      const [first, duplicate] = await Promise.all([
        appUpdatePost(commitRequest(attemptId)),
        appUpdatePost(commitRequest(attemptId)),
      ]);
      assert.equal(first.status, 202);
      assert.equal(duplicate.status, 202);
      assert.deepEqual(await Promise.all([first.json(), duplicate.json()]), [
        { accepted: true, attemptId },
        { accepted: true, attemptId },
      ]);
    });
    assert.equal(submissions, 1);
    assert.equal(JSON.parse(readFileSync(status, "utf8")).stage, "stopping");
    assert.equal(existsSync(join(root, `${attemptId}.go`)), true);
    cancelAppUpdateDrain();
  });
});

test("a fresh commit owner resumes persisted stopping without regressing its stage", async () => {
  await withIsolatedState(async ({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "worker.js"), "copied worker");
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "stopping",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));
    writeFileSync(join(root, `${attemptId}.armed.json`), JSON.stringify({ protocol: 1, attemptId, launcherPid: process.pid }));

    assert.equal(validateCommitSelfUpdate(attemptId), "resume");
    const response = await appUpdatePost(commitRequest(attemptId));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, attemptId });
    assert.equal(JSON.parse(readFileSync(status, "utf8")).stage, "stopping");
    assert.equal(existsSync(join(root, `${attemptId}.go`)), true);
    cancelAppUpdateDrain();
  });
});

test("status stages are allowlisted while legacy statuses remain valid", () => {
  withIsolatedState(({ root, status }) => {
    mkdirSync(root);
    const baseStatus = {
      attemptId: crypto.randomUUID(),
      state: "prepared",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
    };

    writeFileSync(status, JSON.stringify(baseStatus));
    assert.deepEqual(getSelfUpdateStatus(), baseStatus);

    for (const stage of ["preparing", "stopping", "installing", "restarting", "finalizing"]) {
      writeFileSync(status, JSON.stringify({ ...baseStatus, stage }));
      assert.equal(getSelfUpdateStatus()?.stage, stage);
    }

    writeFileSync(status, JSON.stringify({ ...baseStatus, stage: "unknown-stage" }));
    const sanitized = getSelfUpdateStatus();
    assert.equal(sanitized?.stage, undefined);
    assert.equal(Object.hasOwn(sanitized ?? {}, "stage"), false);
  });
});

test("prepared commit ownership becomes resumable while running and terminal states replay", () => {
  withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const preparedAt = new Date().toISOString();
    const helperDir = join(root, "attempts", attemptId);
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "worker.js"), "copied worker");
    const baseStatus = {
      attemptId,
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt,
      workerPid: process.pid,
    };

    writeFileSync(status, JSON.stringify({ ...baseStatus, state: "prepared", stage: "preparing" }));
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    assert.equal(validateCommitSelfUpdate(attemptId), "ready");
    markSelfUpdateStopping(attemptId);
    assert.equal(JSON.parse(readFileSync(status, "utf8")).stage, "stopping");
    assert.equal(validateCommitSelfUpdate(attemptId), "resume");

    rmSync(lease);
    writeFileSync(status, JSON.stringify({ ...baseStatus, state: "running", stage: "stopping", startedAt: preparedAt }));
    assert.equal(validateCommitSelfUpdate(attemptId), "replay");

    for (const state of ["succeeded", "failed"]) {
      writeFileSync(status, JSON.stringify({ ...baseStatus, state, finishedAt: preparedAt }));
      assert.equal(validateCommitSelfUpdate(attemptId), "replay");
    }
  });
});

test("abort refuses durable arm or go proof and go requires a durable arm", async () => {
  await withIsolatedState(({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "worker.js"), "copied worker");
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "stopping",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));

    assert.throws(() => commitSelfUpdate(attemptId), (error) => error.code === "launcher_not_armed");
    writeFileSync(join(root, `${attemptId}.armed.json`), JSON.stringify({ protocol: 1, attemptId, launcherPid: process.pid }));
    const armedAbort = assert.rejects(abortPreparedSelfUpdate(attemptId, "must not win"), (error) => error.code === "attempt_not_abortable");
    assert.equal(existsSync(join(root, `${attemptId}.abort.json`)), false);
    assert.deepEqual(commitSelfUpdate(attemptId), { accepted: true, attemptId });

    rmSync(join(root, `${attemptId}.armed.json`));
    const committedAbort = assert.rejects(abortPreparedSelfUpdate(attemptId, "must not win"), (error) => error.code === "attempt_not_abortable");
    return Promise.all([armedAbort, committedAbort]);
  });
});

test("launcher arm accepts delayed durable proof after acknowledgement failure", async () => {
  await withIsolatedState(async ({ root, lease, status }) => {
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "worker.js"), "copied worker");
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    writeFileSync(status, JSON.stringify({
      attemptId,
      state: "prepared",
      stage: "stopping",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      workerPid: process.pid,
    }));

    await withMockLauncher((message, callback) => {
      assert.equal(message.attemptId, attemptId);
      setTimeout(() => {
        writeFileSync(join(root, `${attemptId}.armed.json`), JSON.stringify({ protocol: 1, attemptId, launcherPid: process.pid }));
      }, 100);
      callback(new Error("acknowledgement channel closed"));
      return true;
    }, () => armSelfUpdateLauncher(attemptId));
    assert.equal(existsSync(join(root, `${attemptId}.armed.json`)), true);
  });
});

test("worker passes only an allowlisted environment to package lifecycle scripts", () => {
  const secretNames = ["OMP_WEB_PASSWORD", "TEST_UPDATE_TOKEN", "DATABASE_URL", "GITHUB_PAT", "CI_JOB_JWT", "GOOGLE_APPLICATION_CREDENTIALS"];
  const originals = Object.fromEntries(secretNames.map((name) => [name, process.env[name]]));
  for (const name of secretNames) process.env[name] = `private-${name.toLowerCase()}`;
  try {
    const clean = workerModule.managerEnvironment();
    for (const name of secretNames) assert.equal(clean[name], undefined);
    assert.equal(clean.OMP_WEB_RESTART_DESCRIPTOR, undefined);
    assert.ok(clean.PATH || clean.Path);
  } finally {
    for (const name of secretNames) {
      if (originals[name] === undefined) delete process.env[name];
      else process.env[name] = originals[name];
    }
  }
});

test("worker normalizes wildcard bind addresses for local readiness probes", () => {
  assert.equal(workerModule.probeHost("0.0.0.0"), "127.0.0.1");
  assert.equal(workerModule.probeHost("::"), "::1");
  assert.equal(workerModule.probeHost("127.0.0.1"), "127.0.0.1");
});

test("worker reports Windows npm EBUSY exit codes accurately", () => {
  assert.equal(workerModule.normalizeExitCode(4294963214), -4082);
  assert.equal(workerModule.normalizeExitCode(1), 1);
  assert.equal(workerModule.normalizeExitCode(null), null);
});


test("copied worker remains alive while prepared and uncommitted", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "ompweb-self-update-worker-"));
  const packageDir = join(fixture, "global", "node_modules", "@kahme247", "ompweb");
  const root = join(fixture, "state");
  const attemptId = crypto.randomUUID();
  const helperDir = join(root, "attempts", attemptId);
  const helper = join(helperDir, "worker.js");
  const launcherPath = join(packageDir, "bin", "omp-web.js");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(helperDir, { recursive: true });
  copyFileSync(workerPath, helper);
  writeFileSync(join(root, "lease.json"), JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
  writeFileSync(join(root, "status.json"), JSON.stringify({
    attemptId,
    state: "prepared",
    fromVersion: "0.3.6",
    targetVersion: "0.3.7",
    preparedAt: new Date().toISOString(),
  }));

  const child = spawn(process.execPath, [
    helper,
    "--attempt", attemptId,
    "--root", root,
    "--package-dir", packageDir,
    "--manager", "npm",
    "--manager-path", process.execPath,
    "--manager-prefix", "[]",
    "--target", "0.3.7",
    "--from", "0.3.6",
    "--launcher-pid", String(process.pid),
    "--server-pid", String(process.pid),
    "--descriptor", JSON.stringify({ launcherPath, hostname: "127.0.0.1", port: "30177" }),
  ], { stdio: "ignore" });

  try {
    assert.equal(await waitForFile(join(root, `${attemptId}.ready`)), true);
    await delay(300);
    assert.equal(child.exitCode, null, "the unarmed helper must stay alive until commit or expiry");
  } finally {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      });
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("manager gate exits without starting the manager when its worker dies before go", { timeout: 5_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "ompweb-manager-gate-"));
  const managerMarker = join(fixture, "manager-called");
  const managerScript = join(fixture, "manager.js");
  const gatePidFile = join(fixture, "gate-pid");
  writeFileSync(managerScript, `require("node:fs").writeFileSync(${JSON.stringify(managerMarker)}, "called");`);
  const gateArgs = [
    workerPath,
    "--manager-gate",
    JSON.stringify({ path: process.execPath, args: [managerScript] }),
  ];
  const driver = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const gate = spawn(process.execPath, ${JSON.stringify(gateArgs)}, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    require("node:fs").writeFileSync(${JSON.stringify(gatePidFile)}, String(gate.pid));
    setInterval(() => {}, 60_000);
  `], { stdio: "ignore" });
  let gatePid;
  try {
    assert.equal(await waitForFile(gatePidFile), true);
    gatePid = Number(readFileSync(gatePidFile, "utf8"));
    assert.ok(Number.isInteger(gatePid) && gatePid > 0);
    const driverExit = new Promise((resolve) => driver.once("exit", resolve));
    driver.kill("SIGKILL");
    await Promise.race([driverExit, rejectAfter(2_000, "manager gate parent did not exit")]);
    assert.equal(await waitForProcessExit(gatePid), true, "the unreleased gate must exit with its worker");
    assert.equal(existsSync(managerMarker), false, "disconnect before go must not start the manager");
  } finally {
    if (driver.exitCode === null) driver.kill("SIGKILL");
    if (gatePid && isProcessAlive(gatePid)) process.kill(gatePid, "SIGKILL");
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("expired ownership remains with the durable manager gate after worker death", { timeout: 10_000 }, async () => {
  await withIsolatedState(async ({ fixture, root, lease, status }) => {
    const packageDir = join(fixture, "global", "node_modules", "@kahme247", "ompweb");
    const helperDir = join(root, "attempts");
    const attemptId = crypto.randomUUID();
    const attemptDir = join(helperDir, attemptId);
    const helper = join(attemptDir, "worker.js");
    const launcherPath = join(packageDir, "bin", "omp-web.js");
    const managerScript = join(fixture, "manager.js");
    const managerMarker = join(fixture, "manager.json");
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    mkdirSync(attemptDir, { recursive: true });
    copyFileSync(workerPath, helper);
    writeFileSync(managerScript, `
      require("node:fs").writeFileSync(${JSON.stringify(managerMarker)}, JSON.stringify({
        pid: process.pid,
        args: process.argv.slice(2),
        secret: process.env.TEST_UPDATE_TOKEN,
      }));
      setInterval(() => {}, 60_000);
    `);
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() - 1 }));
    const prepared = {
      attemptId,
      state: "prepared",
      stage: "stopping",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      cleanupReady: false,
    };
    writeFileSync(status, JSON.stringify(prepared));

    const originalSecret = process.env.TEST_UPDATE_TOKEN;
    process.env.TEST_UPDATE_TOKEN = "must-not-reach-manager";
    let server;
    let worker;
    let gatePid;
    let managerPid;
    try {
      server = spawn(process.execPath, ["-e", `
        const server = require("node:net").createServer();
        server.listen(0, "127.0.0.1", () => process.send(server.address().port));
      `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const port = await new Promise((resolve, reject) => {
        server.once("message", resolve);
        server.once("error", reject);
      });
      worker = spawn(process.execPath, [
        helper,
        "--attempt", attemptId,
        "--root", root,
        "--package-dir", packageDir,
        "--manager", "npm",
        "--manager-path", process.execPath,
        "--manager-prefix", JSON.stringify([managerScript]),
        "--target", "0.3.7",
        "--from", "0.3.6",
        "--launcher-pid", String(process.pid),
        "--server-pid", String(server.pid),
        "--descriptor", JSON.stringify({ launcherPath, hostname: "127.0.0.1", port: String(port) }),
      ], { stdio: "ignore" });
      writeFileSync(status, JSON.stringify({ ...prepared, workerPid: worker.pid }));
      assert.equal(await waitForFile(join(root, `${attemptId}.ready`)), true);
      writeFileSync(join(root, `${attemptId}.go`), new Date().toISOString());
      assert.equal(await waitForFile(managerMarker, 5_000), true, "manager did not start after go");

      const managerCall = JSON.parse(readFileSync(managerMarker, "utf8"));
      managerPid = managerCall.pid;
      assert.deepEqual(managerCall.args, [
        "install",
        "-g",
        "@kahme247/ompweb@0.3.7",
        "--registry=https://registry.npmjs.org",
      ]);
      assert.equal("secret" in managerCall, false, "the manager must inherit only the sanitized gate environment");
      const installing = JSON.parse(readFileSync(status, "utf8"));
      gatePid = installing.managerPid;
      assert.ok(Number.isInteger(gatePid) && gatePid > 0);
      assert.notEqual(gatePid, managerPid, "status must own the wrapper, not only its current child");

      const workerExit = new Promise((resolve) => worker.once("exit", resolve));
      worker.kill("SIGKILL");
      await Promise.race([workerExit, rejectAfter(2_000, "update worker did not exit")]);
      assert.equal(isProcessAlive(gatePid), true, "released gate must outlive its worker");
      assert.equal(isProcessAlive(managerPid), true, "manager must remain owned by the live gate");

      cleanupStaleSelfUpdate();
      assert.equal(existsSync(lease), true, "expired lease must remain while its recorded gate is live");
      assert.equal(JSON.parse(readFileSync(status, "utf8")).managerPid, gatePid);

      process.kill(managerPid, "SIGKILL");
      assert.equal(await waitForProcessExit(managerPid), true);
      assert.equal(await waitForProcessExit(gatePid), true, "gate must forward manager settlement");
      cleanupStaleSelfUpdate();
      assert.equal(existsSync(lease), false, "ownership may release only after the wrapper tree settles");
    } finally {
      if (originalSecret === undefined) delete process.env.TEST_UPDATE_TOKEN;
      else process.env.TEST_UPDATE_TOKEN = originalSecret;
      if (managerPid && isProcessAlive(managerPid)) process.kill(managerPid, "SIGKILL");
      if (gatePid && isProcessAlive(gatePid)) process.kill(gatePid, "SIGKILL");
      if (worker?.exitCode === null) worker.kill("SIGKILL");
      if (server?.exitCode === null) server.kill("SIGKILL");
    }
  });
});
test("a commit with no durable arm proof aborts its helper and releases retry ownership", { timeout: 10_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "ompweb-self-update-abort-"));
  const names = ["TEMP", "TMP", "TMPDIR"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = fixture;
  const packageDir = join(fixture, "global", "node_modules", "@kahme247", "ompweb");
  const installProbe = join(fixture, "install-called");
  let worker;
  let server;
  try {
    const root = resolveSelfUpdateTempRoot();
    const lease = join(root, "lease.json");
    const status = join(root, "status.json");
    const attemptId = crypto.randomUUID();
    const helperDir = join(root, "attempts", attemptId);
    const helper = join(helperDir, "worker.js");
    const launcherPath = join(packageDir, "bin", "omp-web.js");
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    mkdirSync(helperDir, { recursive: true });
    copyFileSync(workerPath, helper);
    writeFileSync(lease, JSON.stringify({ attemptId, expiresAt: Date.now() + 60_000 }));
    const prepared = {
      attemptId,
      state: "prepared",
      stage: "stopping",
      fromVersion: "0.3.6",
      targetVersion: "0.3.7",
      preparedAt: new Date().toISOString(),
      cleanupReady: false,
    };
    writeFileSync(status, JSON.stringify(prepared));

    server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
    worker = spawn(process.execPath, [
      helper,
      "--attempt", attemptId,
      "--root", root,
      "--package-dir", packageDir,
      "--manager", "npm",
      "--manager-path", process.execPath,
      "--manager-prefix", "[]",
      "--target", "0.3.7",
      "--from", "0.3.6",
      "--launcher-pid", String(process.pid),
      "--server-pid", String(server.pid),
      "--descriptor", JSON.stringify({ launcherPath, hostname: "127.0.0.1", port: "30177" }),
    ], { stdio: "ignore" });
    writeFileSync(status, JSON.stringify({ ...prepared, workerPid: worker.pid }));
    assert.equal(await waitForFile(join(root, `${attemptId}.ready`)), true);
    const workerExited = new Promise((resolveWorkerExit) => worker.once("exit", resolveWorkerExit));

    const response = await withMockLauncher((message, callback) => {
      assert.equal(message.attemptId, attemptId);
      callback(new Error("launcher acknowledgement missing"));
      return true;
    }, () => appUpdatePost(commitRequest(attemptId)));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "launcher acknowledgement missing",
      code: "launcher_not_armed",
    });
    await Promise.race([workerExited, rejectAfter(2_000, "aborted worker did not exit")]);

    const terminal = JSON.parse(readFileSync(status, "utf8"));
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.error, "launcher acknowledgement missing");
    assert.equal(terminal.startedAt, undefined);
    assert.equal(terminal.recovered, false);
    assert.equal(existsSync(installProbe), false, "abort must not invoke the package manager");
    assert.doesNotThrow(() => process.kill(server.pid, 0), "abort must not stop the running server");
    assert.equal(existsSync(helper), false, "normal terminal cleanup removes the copied helper");
    assert.equal(existsSync(lease), false, "normal terminal cleanup releases the lease");
    writeFileSync(lease, JSON.stringify({ attemptId: crypto.randomUUID(), expiresAt: Date.now() + 60_000 }), { flag: "wx" });
  } finally {
    if (worker?.exitCode === null) worker.kill("SIGKILL");
    if (server?.exitCode === null) server.kill("SIGKILL");
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});


test("original shutdown never uses recursive tree termination", () => {
  const worker = readFileSync(workerPath, "utf8");
  const orchestrator = readFileSync(new URL("./self-update.ts", import.meta.url), "utf8");
  assert.match(orchestrator, /cwd: dirname\(worker\)/);
  const stopBlock = /async function stopOriginalProcesses\(\) \{([\s\S]*?)\n\}/.exec(worker)?.[1] ?? "";
  const launcher = readFileSync(new URL("../bin/omp-web.js", import.meta.url), "utf8");
  assert.match(launcher, /launcherPath: path\.join\(pkgDir, "bin", "omp-web\.js"\)/);
  assert.doesNotMatch(launcher, /launcherPath: path\.resolve\(process\.argv\[1\]\)/);
  assert.ok(stopBlock.includes("signalExactProcess(serverPid"));
  assert.doesNotMatch(stopBlock, /taskkill|terminateNewTree/);
  assert.match(worker, /const PACKAGE_NAME = "@kahme247\/ompweb"/);
  assert.match(worker, /--registry=/);
  assert.match(worker, /WINDOWS_FILE_RELEASE_MS/);
  assert.match(worker, /error\?\.exitCode !== -4082/);
  assert.doesNotMatch(worker, /wscript|powershell|shell:\s*true/i);
  assert.match(launcher, /ompweb:update-control/);
  assert.match(launcher, /stdio: \["inherit", "pipe", "inherit", "ipc"\]/);
});

test("worker stages match reached lifecycle boundaries and survive terminal writes", () => {
  const worker = readFileSync(workerPath, "utf8");
  const backend = readFileSync(new URL("./self-update.ts", import.meta.url), "utf8");
  const lifecycle = extractFunctionBody(worker, "async function run()");
  const stopping = lifecycle.indexOf('updateStatus({ state: "running", stage: "stopping"');
  const shutdown = lifecycle.indexOf("await stopOriginalProcesses()");
  const portClosed = lifecycle.indexOf("if (!await waitForPort(descriptor.port, descriptor.hostname, false");
  const installing = lifecycle.indexOf('updateStatus({ stage: "installing" })');
  const install = lifecycle.indexOf("await runManager(target)");
  const verify = lifecycle.indexOf("if (!verifyVersion(target))");
  const restarting = lifecycle.indexOf('updateStatus({ stage: "restarting" })');
  const restartRequested = lifecycle.indexOf("updatedChild = await requestLauncherStart()");
  const restartReady = lifecycle.indexOf("await waitForRestartedChild(updatedChild)");
  const finalizing = lifecycle.indexOf('updateStatus({ stage: "finalizing" })');
  const succeeded = lifecycle.indexOf('updateStatus({ state: "succeeded"');

  assert.match(backend, /state: "prepared", stage: "preparing"/);
  assert.ok(stopping >= 0 && stopping < shutdown);
  assert.ok(shutdown < portClosed && portClosed < installing && installing < install);
  assert.ok(install < verify && verify < restarting && restarting < restartRequested);
  assert.ok(restartRequested < restartReady && restartReady < finalizing && finalizing < succeeded);
  assert.match(lifecycle, /updateStatus\(\{ stage: "installing" \}\);\s+await runManager\(target\)/);
  assert.match(lifecycle, /updateStatus\(\{ stage: "restarting" \}\);\s+updatedChild = await requestLauncherStart\(\);\s+await waitForRestartedChild\(updatedChild\)/);
  assert.match(lifecycle, /await waitForRestartedChild\(updatedChild\);\s+updateStatus\(\{ stage: "finalizing" \}\);\s+updateStatus\(\{ state: "succeeded"/);

  const failedWrites = [...worker.matchAll(/updateStatus\(\{\s*state: "failed"[\s\S]*?\}\);/g)];
  assert.ok(failedWrites.length >= 2);
  for (const [write] of failedWrites) assert.doesNotMatch(write, /\bstage:/);
  const retainedFailure = /const status = \{ state: "failed"[\s\S]*?\};/.exec(lifecycle)?.[0] ?? "";
  assert.match(retainedFailure, /state: "failed"/);
  assert.doesNotMatch(retainedFailure, /\bstage:/);
});

test("terminal cleanup ordering is worker-owned and acknowledgement-gated", () => {
  const worker = readFileSync(workerPath, "utf8");
  const launcher = readFileSync(new URL("../bin/omp-web.js", import.meta.url), "utf8");
  const backend = readFileSync(new URL("./self-update.ts", import.meta.url), "utf8");
  const finalizer = worker.slice(
    worker.indexOf("async function finishTerminalAttempt"),
    worker.indexOf("async function run()"),
  );
  const complete = finalizer.indexOf("atomicWrite(completeFile()");
  const launcherAck = finalizer.indexOf("await waitForCompletionAck(", complete);
  const helperCleanup = finalizer.indexOf("removeHelperAttempt()", launcherAck);
  const leaseCleanup = finalizer.indexOf("releaseLease()", helperCleanup);
  const cleanupReady = finalizer.indexOf("updateStatus({ cleanupReady })", leaseCleanup);
  assert.ok(complete >= 0 && complete < launcherAck);
  assert.ok(launcherAck < helperCleanup);
  assert.ok(helperCleanup < leaseCleanup);
  assert.ok(leaseCleanup < cleanupReady);
  assert.equal((worker.match(/await finishTerminalAttempt\(\)/g) ?? []).length, 3);
  assert.match(finalizer, /const leaseRemoved = helperRemoved && releaseLease\(\)/);

  const completionWatcher = /function watchUpdateCompletion\(control\) \{([\s\S]*?)\n\}/.exec(launcher)?.[1] ?? "";
  assert.match(completionWatcher, /atomicWrite\(updatePath\(control, "complete-ack\.json"\)/);
  assert.doesNotMatch(completionWatcher, /lease\.json|status\.json|removeSecureFile|cleanupExpiredUpdate/);
  const armHandler = launcher.slice(
    launcher.indexOf("function handleUpdateArm"),
    launcher.indexOf("function attachOutput"),
  );
  assert.match(armHandler, /hasLivePreparedOwnership\(control\)/);
  assert.match(armHandler, /launcherPid: process\.pid/);
  assert.doesNotMatch(launcher, /TERMINAL_STATUS_TTL_MS|cleanupExpiredUpdate|scheduleExpiredUpdateCleanup|removeExpiredAttempt/);
  const armOwnership = extractFunctionBody(launcher, "function hasLivePreparedOwnership(control)");
  assert.match(armOwnership, /status\.state === "prepared"/);
  assert.match(armOwnership, /status\.stage === "stopping"/);
  assert.match(armOwnership, /isProcessAlive\(status\.workerPid\)/);
  assert.match(armOwnership, /lease\.expiresAt > Date\.now\(\)/);
  assert.match(armOwnership, /"abort\.json"/);
  assert.match(armOwnership, /"go"/);

  const managerRun = extractFunctionBody(worker, "function runManagerOnce(version)");
  assert.match(managerRun, /updateStatus\(\{ managerPid: gate\.pid \}\)/);
  assert.ok(managerRun.indexOf("updateStatus({ managerPid: gate.pid })") < managerRun.indexOf('gate.send({ type: "go" }'));
  assert.ok(managerRun.indexOf("timedOut = true") < managerRun.indexOf("terminateNewTree(gate.pid)"));
  assert.match(managerRun, /gate\.once\("exit"[\s\S]*if \(!timedOut\)/);
  const leaseClaim = extractFunctionBody(backend, "function claimLease(attemptId: string, expiresAt: number)");
  assert.match(leaseClaim, /hasMatchingRecordedLiveOwner\(status, existing\)/);

  const fallback = extractFunctionBody(backend, "function finalizeTerminalCleanup()");
  assert.match(fallback, /isProcessAlive\(status\.workerPid\).*isProcessAlive\(status\.managerPid\)/s);
  assert.ok(fallback.indexOf("removeAttemptArtifacts") < fallback.indexOf("cleanupReady: true"));
  assert.match(backend, /const LEASE_MS = 30 \* 60 \* 1000/);
  assert.match(worker, /const COMMIT_TIMEOUT_MS = 10 \* 60 \* 1000/);
  assert.doesNotMatch(backend, /Promise\.withResolvers/);
  assert.match(worker, /if \(!secureRegularFile\(restartAckPath\)\) return true/);
  assert.match(worker, /&& !isProcessAlive\(restartAck\.pid\)/);
});
