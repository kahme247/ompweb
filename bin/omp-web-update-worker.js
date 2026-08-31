#!/usr/bin/env node
"use strict";

// This file is copied outside the package and must remain dependency-free CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("node:crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net");

const PACKAGE_NAME = "@kahme247/ompweb";
const REGISTRY = "https://registry.npmjs.org";
const COMMIT_TIMEOUT_MS = 10 * 60 * 1000;
const WINDOWS_FILE_RELEASE_MS = 2_000;
const WINDOWS_BUSY_RETRIES = 3;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const TREE_TERMINATION_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15 * 1000;
const READY_TIMEOUT_MS = 90 * 1000;
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const attemptId = option("--attempt");
const root = option("--root");
const packageDir = option("--package-dir");
const manager = option("--manager");
const managerPath = option("--manager-path");
const target = option("--target");
const from = option("--from");
const launcherPid = Number(option("--launcher-pid"));
const serverPid = Number(option("--server-pid"));
let descriptor;
let managerPrefix;
try {
  descriptor = JSON.parse(option("--descriptor") || "null");
  managerPrefix = JSON.parse(option("--manager-prefix") || "[]");
} catch {
  descriptor = null;
  managerPrefix = null;
}
let retainingUnsafeOwnership = false;

function validVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function validInputs() {
  const expectedLauncher = typeof packageDir === "string" ? path.join(packageDir, "bin", "omp-web.js") : "";
  const port = Number(descriptor?.port);
  return /^[0-9a-f-]{36}$/i.test(attemptId || "")
    && typeof root === "string" && path.isAbsolute(root)
    && typeof packageDir === "string" && path.isAbsolute(packageDir)
    && (manager === "npm" || manager === "bun")
    && typeof managerPath === "string" && path.isAbsolute(managerPath)
    && Array.isArray(managerPrefix) && managerPrefix.every((value) => typeof value === "string")
    && validVersion(target) && validVersion(from)
    && Number.isInteger(launcherPid) && launcherPid > 0
    && Number.isInteger(serverPid) && serverPid > 0
    && descriptor && path.isAbsolute(descriptor.launcherPath)
    && path.resolve(descriptor.launcherPath) === path.resolve(expectedLauncher)
    && typeof descriptor.hostname === "string"
    && Number.isInteger(port) && port > 0 && port <= 65535;
}

function leaseFile() { return path.join(root, "lease.json"); }
function statusFile() { return path.join(root, "status.json"); }
function markerFile(marker) { return path.join(root, `${attemptId}.${marker}`); }
function abortFile() { return markerFile("abort.json"); }
function restartRequestFile() { return markerFile("restart-request.json"); }
function restartAckFile() { return markerFile("restart-ack.json"); }
function completeFile() { return markerFile("complete.json"); }
function completeAckFile() { return markerFile("complete-ack.json"); }
function armedFile() { return markerFile("armed.json"); }
function readPreparedAbort() {
  const abort = readStateJson(abortFile());
  if (abort?.protocol !== 1 || abort.attemptId !== attemptId || typeof abort.reason !== "string") return null;
  return { reason: safeError({ message: abort.reason }) };
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function ownedByCurrentUser(info) {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}

function secureDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info)) {
    throw new Error("unsafe update state directory");
  }
  return info;
}

function secureRegularFile(file) {
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownedByCurrentUser(info)) {
    throw new Error("unsafe update state file");
  }
  return info;
}

function atomicWrite(file, value) {
  secureDirectory(path.dirname(file));
  secureRegularFile(file);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function readStateJson(file) {
  if (!secureRegularFile(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function removeSecureFile(file) {
  if (!secureRegularFile(file)) return true;
  try {
    fs.rmSync(file);
    return true;
  } catch (error) {
    if (["EBUSY", "EPERM", "EACCES"].includes(error?.code)) return false;
    throw error;
  }
}
function removeSecureEmptyDirectory(directory) {
  try { secureDirectory(directory); }
  catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  try {
    fs.rmdirSync(directory);
    return true;
  } catch (error) {
    if (["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error?.code)) return false;
    if (isMissing(error)) return true;
    throw error;
  }
}

function ownsLease() {
  const lease = readStateJson(leaseFile());
  return lease?.attemptId === attemptId;
}

function releaseLease() {
  if (ownsLease()) return removeSecureFile(leaseFile());
  return true;
}

function updateStatus(patch) {
  const current = readStateJson(statusFile()) || {
    attemptId,
    state: "prepared",
    stage: "preparing",
    fromVersion: from,
    targetVersion: target,
    preparedAt: new Date().toISOString(),
  };
  if (current.attemptId !== attemptId) return;
  atomicWrite(statusFile(), JSON.stringify({ ...current, ...patch }));
}

function safeError(error) {
  const text = error && typeof error.message === "string" ? error.message : "Update failed";
  return text.replace(/[\r\n]/g, " ").replace(/([A-Za-z]:[\\/]|\/)[^ ]+/g, "[path]").slice(0, 240);
}

function removeHelperAttempt() {
  const attempts = path.join(root, "attempts");
  const expectedDirectory = path.join(attempts, attemptId);
  if (path.resolve(__dirname) !== path.resolve(expectedDirectory)) return false;
  secureDirectory(attempts);
  secureDirectory(expectedDirectory);
  const entries = fs.readdirSync(expectedDirectory);
  if (entries.some((entry) => entry !== "worker.js")) throw new Error("unsafe update helper directory");
  if (entries.includes("worker.js") && !removeSecureFile(__filename)) return false;
  if (!removeSecureEmptyDirectory(expectedDirectory)) return false;
  removeSecureEmptyDirectory(attempts);
  return true;
}

function removeControlFiles(includeCompletionAck) {
  const files = [
    markerFile("go"),
    abortFile(),
    markerFile("ready"),
    armedFile(),
    restartRequestFile(),
    restartAckFile(),
    completeFile(),
    ...(includeCompletionAck ? [completeAckFile()] : []),
  ];
  return files.every(removeSecureFile);
}

function managerEnvironment() {
  const allowed = {
    APPDATA: true, BUN_INSTALL: true, COMSPEC: true, HOME: true, HOMEDRIVE: true, HOMEPATH: true,
    LANG: true, LC_ALL: true, LOCALAPPDATA: true, NODE_EXTRA_CA_CERTS: true, NO_PROXY: true,
    NPM_CONFIG_PREFIX: true, PATH: true, PATHEXT: true, SSL_CERT_DIR: true, SSL_CERT_FILE: true,
    SYSTEMROOT: true, TEMP: true, TMP: true, TMPDIR: true, USERPROFILE: true, WINDIR: true,
    XDG_CACHE_HOME: true, XDG_CONFIG_HOME: true, XDG_DATA_HOME: true,
  };
  const clean = { FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed[key.toUpperCase()]) clean[key] = value;
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY"]) {
    const value = process.env[name] ?? process.env[name.toLowerCase()];
    if (!value) continue;
    try {
      const proxy = new URL(value);
      if (!proxy.username && !proxy.password) clean[name] = value;
    } catch { /* malformed proxy values are not forwarded */ }
  }
  return clean;
}

function runManagerGate(value) {
  let spec;
  try { spec = JSON.parse(value); }
  catch { process.exitCode = 1; return; }
  if (!spec || typeof spec.path !== "string" || !path.isAbsolute(spec.path)
    || !Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string")
    || !process.connected) {
    process.exitCode = 1;
    return;
  }

  let released = false;
  process.once("disconnect", () => {
    if (!released) process.exitCode = 1;
  });
  process.once("message", (message) => {
    if (message?.type !== "go") return;
    released = true;
    let child;
    try {
      child = cp.spawn(spec.path, spec.args, {
        stdio: "ignore",
        windowsHide: true,
        env: managerEnvironment(),
      });
    } catch {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
      return;
    }
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (process.connected) process.disconnect();
      if (signal) {
        try { process.kill(process.pid, signal); }
        catch { process.exitCode = 1; }
      } else {
        process.exitCode = normalizeExitCode(code) ?? 1;
      }
    };
    child.once("error", () => finish(1));
    child.once("exit", finish);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

function signalExactProcess(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isProcessAlive(pid)) return;
  try { process.kill(pid, signal); }
  catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopOriginalProcesses() {
  signalExactProcess(serverPid, "SIGTERM");
  if (!await waitForProcessExit(serverPid, STOP_TIMEOUT_MS)) {
    signalExactProcess(serverPid, "SIGKILL");
    if (!await waitForProcessExit(serverPid, 5_000)) throw new Error("the running server did not stop");
  }

}

async function terminateNewTree(pid, requireLiveProof = false) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isProcessAlive(pid)) return !requireLiveProof;
  if (process.platform === "win32") {
    const taskkillExited = await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exited);
      };
      let reaper;
      try {
        reaper = cp.spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        return finish(false);
      }
      reaper.unref();
      timer = setTimeout(() => {
        finish(false);
        try { reaper.kill("SIGKILL"); }
        catch { /* the unconfirmed taskkill child remains unsafe */ }
      }, TREE_TERMINATION_TIMEOUT_MS);
      reaper.once("error", () => finish(false));
      reaper.once("exit", (code) => finish(code === 0));
    });
    if (!taskkillExited) return false;
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch { return false; }
  }
  return waitForProcessExit(pid, TREE_TERMINATION_TIMEOUT_MS);
}

function normalizeExitCode(code) {
  if (typeof code !== "number") return null;
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

function managerExitError(code) {
  const normalized = normalizeExitCode(code);
  const message = normalized === -4082
    ? "package directory remained locked (EBUSY)"
    : `package manager exited with code ${normalized ?? "unknown"}`;
  const error = new Error(message);
  error.exitCode = normalized;
  return error;
}

function markUnsafeToRecover(error, blockingPid) {
  error.unsafeToRecover = true;
  if (Number.isInteger(blockingPid) && blockingPid > 0) error.blockingPid = blockingPid;
  return error;
}

function unsafeRecoveryError(message, blockingPid, requireTreeTermination = false) {
  const error = markUnsafeToRecover(new Error(message), blockingPid);
  if (requireTreeTermination) error.requireTreeTermination = true;
  return error;
}

function clearSettledManager(pid) {
  const status = readStateJson(statusFile());
  if (status?.attemptId === attemptId && status.managerPid === pid && !isProcessAlive(pid)) {
    updateStatus({ managerPid: undefined });
  }
}

function runManagerOnce(version) {
  const spec = `${PACKAGE_NAME}@${version}`;
  const actionArgs = manager === "bun"
    ? ["add", "-g", spec, `--registry=${REGISTRY}`]
    : ["install", "-g", spec, `--registry=${REGISTRY}`];
  const gateSpec = JSON.stringify({ path: managerPath, args: [...managerPrefix, ...actionArgs] });

  return new Promise((resolve, reject) => {
    const gate = cp.spawn(process.execPath, [__filename, "--manager-gate", gateSpec], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      env: managerEnvironment(),
      detached: true,
    });
    let settled = false;
    let timedOut = false;
    let timer;
    const finish = (error, managerSettled, clearManager = managerSettled) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let resultError = error;
      if (clearManager) {
        try { updateStatus({ managerPid: undefined }); }
        catch (statusError) { resultError ||= statusError; }
      }
      if (resultError) reject(resultError);
      else resolve();
    };
    const stopManager = (error, clearManager = true) => {
      if (timedOut || settled) return;
      timedOut = true;
      terminateNewTree(gate.pid).then(
        (terminated) => {
          if (!terminated) gate.unref();
          finish(terminated ? error : unsafeRecoveryError(safeError(error), gate.pid, true), terminated, terminated && clearManager);
        },
        () => {
          gate.unref();
          finish(unsafeRecoveryError(safeError(error), gate.pid, true), false, false);
        },
      );
    };
    gate.once("error", (error) => {
      if (!timedOut) finish(error, true);
    });
    gate.once("exit", (code) => {
      if (!timedOut) finish(code === 0 ? null : managerExitError(code), true);
    });
    if (!Number.isInteger(gate.pid)) {
      stopManager(new Error("package manager gate did not start"), false);
      return;
    }
    try {
      updateStatus({ managerPid: gate.pid });
      const status = readStateJson(statusFile());
      if (status?.attemptId !== attemptId || status.managerPid !== gate.pid) {
        throw new Error("package manager gate ownership could not be recorded");
      }
    } catch (error) {
      stopManager(error, false);
      return;
    }
    try {
      gate.send({ type: "go" }, (error) => {
        if (error) stopManager(error);
        else if (!settled) timer = setTimeout(() => stopManager(new Error("package manager timed out")), COMMAND_TIMEOUT_MS);
      });
    } catch (error) {
      stopManager(error);
    }
  });
}

async function runManager(version) {
  for (let attempt = 1; attempt <= WINDOWS_BUSY_RETRIES; attempt += 1) {
    try {
      await runManagerOnce(version);
      return;
    } catch (error) {
      if (process.platform !== "win32" || error?.exitCode !== -4082 || attempt === WINDOWS_BUSY_RETRIES) throw error;
      await sleep(WINDOWS_FILE_RELEASE_MS);
    }
  }
}

function verifyVersion(version) {
  const manifest = readJson(path.join(packageDir, "package.json"));
  return manifest?.name === PACKAGE_NAME && manifest.version === version;
}

function probeHost(hostname) {
  if (hostname === "0.0.0.0" || hostname === "") return "127.0.0.1";
  if (hostname === "::") return "::1";
  return hostname;
}

function probePort(port, hostname) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ port: Number(port), host: probeHost(hostname) });
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function probeHttp(port, hostname) {
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      request?.destroy();
      resolve(ready);
    };
    request = http.get({
      host: probeHost(hostname),
      port: Number(port),
      path: "/login",
      headers: { connection: "close" },
    }, (response) => {
      response.resume();
      finish([200, 307, 308].includes(response.statusCode));
    });
    request.setTimeout(3_000, () => finish(false));
    request.once("error", () => finish(false));
  });
}

async function waitForPort(port, hostname, shouldBeOpen, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port, hostname) === shouldBeOpen) return true;
    await sleep(100);
  }
  return false;
}

let nextGeneration = 1;

async function requestLauncherStart() {
  if (!isProcessAlive(launcherPid)) throw new Error("the original ompweb launcher is no longer running");
  const generation = nextGeneration;
  if (!removeSecureFile(restartAckFile())) throw new Error("the previous restart acknowledgement could not be cleared");
  atomicWrite(restartRequestFile(), JSON.stringify({
    protocol: 1,
    attemptId,
    action: "start",
    generation,
  }));
  const deadline = Date.now() + READY_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const ack = readStateJson(restartAckFile());
      if (ack?.protocol === 1
        && ack.attemptId === attemptId
        && ack.generation === generation
        && Number.isInteger(ack.pid)
        && ack.pid > 0) {
        nextGeneration += 1;
        return { pid: ack.pid };
      }
      await sleep(100);
    }
  } catch (error) {
    throw markUnsafeToRecover(error);
  }
  throw unsafeRecoveryError("the original launcher did not restart ompweb");
}

async function waitForUnsafeRecovery(blockingPid, requireTreeTermination = false) {
  retainingUnsafeOwnership = true;
  let treeTerminationAttested = !requireTreeTermination;
  let pid = Number.isInteger(blockingPid) && blockingPid > 0 ? blockingPid : undefined;
  while (true) {
    try {
      if (!pid) {
        const launcherDead = !isProcessAlive(launcherPid);
        const restartAckPath = restartAckFile();
        const acknowledgement = readStateJson(restartAckPath);
        if (acknowledgement?.protocol === 1
          && acknowledgement.attemptId === attemptId
          && Number.isInteger(acknowledgement.pid)
          && acknowledgement.pid > 0) {
          pid = acknowledgement.pid;
        } else if (launcherDead
          && !secureRegularFile(restartAckPath)
          && !await probePort(descriptor.port, descriptor.hostname)) {
          retainingUnsafeOwnership = false;
          return;
        }
      }
      if (pid) {
        if (isProcessAlive(pid)) {
          if (!await terminateNewTree(pid, requireTreeTermination && !treeTerminationAttested)) {
            requireTreeTermination = true;
            treeTerminationAttested = false;
            await sleep(1_000);
            continue;
          }
          treeTerminationAttested = true;
        }
        if (treeTerminationAttested && !isProcessAlive(pid) && !await probePort(descriptor.port, descriptor.hostname)) {
          clearSettledManager(pid);
          retainingUnsafeOwnership = false;
          return;
        }
      }
    } catch { /* inconclusive recovery checks retain ownership and retry */ }
    await sleep(1_000);
  }
}

async function stopUnreadyChild(child, message) {
  const stopped = await terminateNewTree(child.pid);
  const closed = await waitForPort(descriptor.port, descriptor.hostname, false, 5_000);
  if (!stopped) throw unsafeRecoveryError(`${message} and could not be stopped`, child.pid, true);
  if (!closed) throw unsafeRecoveryError(`${message} and its port remained live`, child.pid);
  throw new Error(message);
}

async function waitForRestartedChild(child) {
  if (!await waitForPort(descriptor.port, descriptor.hostname, true)) {
    await stopUnreadyChild(child, "ompweb did not open its port");
  }
  for (let check = 0; check < 2; check += 1) {
    if (!isProcessAlive(child.pid) || !await probeHttp(descriptor.port, descriptor.hostname)) {
      await stopUnreadyChild(child, "ompweb did not pass its HTTP readiness check");
    }
    if (check === 0) await sleep(500);
  }
}

async function restoreService() {
  if (await probePort(descriptor.port, descriptor.hostname)) return { recovered: false };
  try {
    await runManager(from);
  } catch (error) {
    if (error?.unsafeToRecover) return { recovered: false, unsafeError: error };
    // Verify whatever the package manager left behind.
  }
  if (!verifyVersion(from)) return { recovered: false };
  try {
    const child = await requestLauncherStart();
    await waitForRestartedChild(child);
    return { recovered: true };
  } catch (error) {
    return error?.unsafeToRecover
      ? { recovered: false, unsafeError: error }
      : { recovered: false };
  }
}

async function waitForCompletionAck(armedLauncherPid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ack = readStateJson(completeAckFile());
    if (ack?.protocol === 1 && ack.attemptId === attemptId) return true;
    if (!isProcessAlive(armedLauncherPid)) {
      const restartAckPath = restartAckFile();
      const restartAck = readStateJson(restartAckPath);
      if (!secureRegularFile(restartAckPath)) return true;
      if (restartAck?.protocol === 1
        && restartAck.attemptId === attemptId
        && Number.isInteger(restartAck.pid)
        && restartAck.pid > 0
        && !isProcessAlive(restartAck.pid)) {
        return true;
      }
    }
    await sleep(100);
  }
  return false;
}

async function finishTerminalAttempt() {
  const terminal = readStateJson(statusFile());
  atomicWrite(completeFile(), JSON.stringify({
    protocol: 1,
    attemptId,
    state: terminal?.state ?? "failed",
  }));
  const hasArmedMarker = Boolean(secureRegularFile(armedFile()));
  const armed = readStateJson(armedFile());
  const launcherArmed = armed?.protocol === 1
    && armed.attemptId === attemptId
    && armed.launcherPid === launcherPid;
  const launcherFinished = !hasArmedMarker || (launcherArmed && await waitForCompletionAck(armed.launcherPid));
  let cleanupReady = false;
  if (launcherFinished) {
    try {
      const controlsRemoved = removeControlFiles(!launcherArmed);
      const helperRemoved = controlsRemoved && removeHelperAttempt();
      const leaseRemoved = helperRemoved && releaseLease();
      const acknowledgementRemoved = !launcherArmed || (leaseRemoved && removeSecureFile(completeAckFile()));
      cleanupReady = controlsRemoved && helperRemoved && leaseRemoved && acknowledgementRemoved;
    } catch { /* the restarted backend retries after this process exits */ }
  }
  updateStatus({ cleanupReady });
}

async function run() {
  if (!validInputs()) throw new Error("invalid update helper arguments");
  secureDirectory(root);
  const expectedDirectory = path.join(root, "attempts", attemptId);
  if (path.resolve(__dirname) !== path.resolve(expectedDirectory)) throw new Error("invalid update helper location");
  secureDirectory(path.join(root, "attempts"));
  secureDirectory(expectedDirectory);
  secureRegularFile(__filename);
  process.chdir(root);
  atomicWrite(markerFile("ready"), new Date().toISOString());

  const commitDeadline = Date.now() + COMMIT_TIMEOUT_MS;
  let abort;
  while (Date.now() < commitDeadline) {
    abort = readPreparedAbort();
    if (abort || secureRegularFile(markerFile("go"))) break;
    await sleep(100);
  }
  abort ||= readPreparedAbort();
  if (abort) {
    updateStatus({
      state: "failed",
      finishedAt: new Date().toISOString(),
      recovered: false,
      cleanupReady: false,
      error: abort.reason,
    });
    await finishTerminalAttempt();
    return;
  }
  if (!secureRegularFile(markerFile("go"))) {
    if (ownsLease()) {
      updateStatus({
        state: "failed",
        finishedAt: new Date().toISOString(),
        recovered: false,
        cleanupReady: false,
        error: "Update confirmation expired",
      });
      await finishTerminalAttempt();
    }
    return;
  }

  updateStatus({ state: "running", stage: "stopping", startedAt: new Date().toISOString() });
  let updatedChild;
  let originalStopped = false;
  try {
    await stopOriginalProcesses();
    if (!await waitForPort(descriptor.port, descriptor.hostname, false, STOP_TIMEOUT_MS)) {
      throw new Error("the ompweb port remained in use after shutdown");
    }
    originalStopped = true;
    if (process.platform === "win32") await sleep(WINDOWS_FILE_RELEASE_MS);
    updateStatus({ stage: "installing" });
    await runManager(target);
    if (!verifyVersion(target)) throw new Error("installed package version could not be verified");
    updateStatus({ stage: "restarting" });
    updatedChild = await requestLauncherStart();
    await waitForRestartedChild(updatedChild);
    updateStatus({ stage: "finalizing" });
    updateStatus({ state: "succeeded", finishedAt: new Date().toISOString(), recovered: false, cleanupReady: false });
  } catch (error) {
    let safeToRecover = error?.unsafeToRecover !== true;
    let unsafeBlockingPid = Number.isInteger(error?.blockingPid) ? error.blockingPid : undefined;
    let requireTreeTermination = error?.requireTreeTermination === true;
    const originalBlockingPid = originalStopped ? undefined : serverPid;
    try {
      if (updatedChild?.pid) {
        const terminated = await terminateNewTree(updatedChild.pid, requireTreeTermination);
        if (!terminated) {
          safeToRecover = false;
          unsafeBlockingPid = updatedChild.pid;
          requireTreeTermination = true;
        } else if (error?.unsafeToRecover) {
          safeToRecover = true;
          unsafeBlockingPid = undefined;
          requireTreeTermination = false;
        }
      }
    } catch {
      safeToRecover = false;
      unsafeBlockingPid = updatedChild?.pid;
      requireTreeTermination = true;
    }
    try {
      if (!await waitForPort(descriptor.port, descriptor.hostname, false, 5_000)) {
        safeToRecover = false;
        unsafeBlockingPid ??= updatedChild?.pid ?? originalBlockingPid;
      }
    } catch {
      safeToRecover = false;
      unsafeBlockingPid ??= updatedChild?.pid ?? originalBlockingPid;
    }
    let recovered = false;
    let unsafeRecoveryFailure;
    if (safeToRecover) {
      try {
        const recovery = await restoreService();
        recovered = recovery.recovered;
        unsafeRecoveryFailure = recovery.unsafeError;
        if (unsafeRecoveryFailure) {
          safeToRecover = false;
          unsafeBlockingPid = Number.isInteger(unsafeRecoveryFailure.blockingPid)
            ? unsafeRecoveryFailure.blockingPid
            : unsafeBlockingPid;
          requireTreeTermination ||= unsafeRecoveryFailure.requireTreeTermination === true;
        }
      } catch (recoveryError) {
        safeToRecover = false;
        unsafeRecoveryFailure = recoveryError;
        unsafeBlockingPid ??= updatedChild?.pid;
        requireTreeTermination ||= recoveryError?.requireTreeTermination === true;
      }
    }
    const failure = safeToRecover
      ? error
      : new Error(`${safeError(unsafeRecoveryFailure ?? error)}; rollback was not attempted because an update process remained live`);
    const status = { state: "failed", finishedAt: new Date().toISOString(), recovered, cleanupReady: false, error: safeError(failure) };
    if (safeToRecover) {
      updateStatus(status);
    } else {
      retainingUnsafeOwnership = true;
      try {
        updateStatus(status);
      } finally {
        await waitForUnsafeRecovery(unsafeBlockingPid, requireTreeTermination);
      }
    }
  } finally {
    if (!retainingUnsafeOwnership) await finishTerminalAttempt();
  }
}

if (require.main === module) {
  const managerGate = option("--manager-gate");
  if (managerGate !== undefined) {
    runManagerGate(managerGate);
  } else {
    run().catch((error) => {
      try { updateStatus({ state: "failed", finishedAt: new Date().toISOString(), recovered: false, error: safeError(error) }); }
      catch { /* status is best-effort after an invalid launch */ }
      if (!retainingUnsafeOwnership) {
        try { releaseLease(); }
        catch { /* lease ownership check is best-effort */ }
      }
      process.exitCode = 1;
    });
  }
}

module.exports = {
  managerEnvironment,
  normalizeExitCode,
  probeHost,
  probeHttp,
  waitForPort,
};
