#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// Forward `ompweb ompweb-launchd [args]` → bin/omp-web-launchd.js so that
// `npx @kahme247/ompweb@latest ompweb-launchd install` works without `-p`.
if (process.argv[2] === "ompweb-launchd" || process.argv[2] === "launchd") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path");
  const { status } = spawnSync(process.execPath, [join(__dirname, "omp-web-launchd.js"), ...process.argv.slice(3)], { stdio: "inherit" });
  process.exit(status ?? 1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("node:crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./omp-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isPortAvailable } = require("./port-availability");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { terminateChildProcess, wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAccessibleAddresses, getBrowserUrl, formatAddressBanner, isLoopbackHost } = require("./network-addresses");

const UPDATE_PROTOCOL = 1;
const UPDATE_MESSAGE = "ompweb:update-control";
const UPDATE_ACK = "ompweb:update-control-ack";
const RESTART_ACK_RETRIES = 3;
const RESTART_ACK_RETRY_MS = 100;
const RESTART_GATE_START = "ompweb:restart-gate-start";

function runRestartGate(startMessageType) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn: spawnChild } = require("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os");
  let child;
  let forceTimer;
  let finished = false;
  let stopping = false;

  const exitCode = (code, signal) => {
    const signalNumber = signal ? os.constants.signals[signal] : undefined;
    return code ?? (typeof signalNumber === "number" ? 128 + signalNumber : 1);
  };
  const finish = (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    process.exitCode = exitCode(code, signal);
    if (process.connected) process.disconnect();
  };
  const killTree = (signal) => {
    if (!child) return finish(undefined, signal);
    if (process.platform === "win32") {
      const reaper = spawnChild("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const fallback = () => {
        try { child.kill(signal); } catch {}
      };
      reaper.once("error", fallback);
      reaper.once("exit", (code) => {
        if (code !== 0) fallback();
      });
      reaper.unref();
      return;
    }
    try { process.kill(-process.pid, signal); }
    catch {
      try { child.kill(signal); } catch {}
    }
  };
  const stop = (signal = "SIGTERM") => {
    if (finished || stopping) return;
    stopping = true;
    if (!child) return finish(undefined, signal);
    killTree(signal);
    forceTimer = setTimeout(() => killTree("SIGKILL"), 4_000);
    forceTimer.unref();
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.once("disconnect", () => stop());
  process.on("message", (message) => {
    if (!child) {
      if (message?.type !== startMessageType || !Array.isArray(message.args)) return;
      child = spawnChild(process.execPath, message.args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["inherit", "pipe", "inherit", "ipc"],
      });
      child.stdout.pipe(process.stdout, { end: false });
      child.on("message", (childMessage) => {
        if (!process.connected) return;
        try { process.send(childMessage, () => {}); } catch {}
      });
      child.once("error", () => finish(1));
      child.once("close", finish);
      return;
    }
    if (!child.connected) return;
    try { child.send(message, () => {}); } catch {}
  });
}
const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

function resolveNextBin(packageDirectory) {
  try {
    return require.resolve("next/dist/bin/next", { paths: [packageDirectory] });
  } catch {
    try {
      const nextPackage = require.resolve("next/package.json", { paths: [packageDirectory] });
      return path.join(path.dirname(nextPackage), "dist", "bin", "next");
    } catch {
      return path.join(packageDirectory, "node_modules", "next", "dist", "bin", "next");
    }
  }
}

const nextBin = resolveNextBin(pkgDir);

const launchOptions = parseLaunchOptions();
if (launchOptions.help || launchOptions.version) {
  process.exit(0);
}

if (launchOptions.installTray || launchOptions.uninstallTray || launchOptions.tray) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runCli } = require("./omp-web-tray");
  const trayArgs = [];
  if (launchOptions.installTray) {
    trayArgs.push("--install");
    if (launchOptions.port) trayArgs.push("-p", String(launchOptions.port));
    if (launchOptions.hostname) trayArgs.push("-H", launchOptions.hostname);
  } else if (launchOptions.uninstallTray) {
    trayArgs.push("--uninstall");
  } else if (launchOptions.tray) {
    trayArgs.push("--start");
    if (launchOptions.openBrowser) trayArgs.push("--open");
  }
  runCli(trayArgs).then(({ exitCode = 0 }) => {
    process.exit(exitCode);
  }).catch((err) => {
    console.error("Error managing tray service:", err);
    process.exit(1);
  });
  return;
}
const port = launchOptions.port;
const hostname = launchOptions.hostname;
const password = launchOptions.password;
const openBrowser = launchOptions.openBrowser;
if (password) process.env.OMP_WEB_PASSWORD = password;
const passwordEnabled = typeof password === "string" && password.length > 0;


const nextArgs = ["start", "-p", port, "-H", hostname];
const restartDescriptor = JSON.stringify({
  launcherPath: path.join(pkgDir, "bin", "omp-web.js"),
  hostname: String(hostname),
  port: String(port),
});
const browserUrl = getBrowserUrl(hostname, port);
let browserOpened = false;
let currentChild = null;
let currentGeneration = 0;
let updateControl = null;
let waitingForRestart = false;

function updatePath(control, suffix) {
  return path.join(control.root, `${control.attemptId}.${suffix}`);
}

function ownedByCurrentUser(info) {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}

function secureDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info)) throw new Error("unsafe update control directory");
  return info;
}

function secureRegularFile(file) {
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownedByCurrentUser(info)) {
    throw new Error("unsafe update control file");
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

function readControlJson(file) {
  if (!secureRegularFile(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function removeSecureFile(file) {
  if (!secureRegularFile(file)) return true;
  fs.rmSync(file);
  return true;
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isExternalControlRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  try {
    const packageRoot = fs.realpathSync(pkgDir);
    const controlRoot = fs.realpathSync(root);
    secureDirectory(controlRoot);
    const relative = path.relative(packageRoot, controlRoot);
    return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
  } catch {
    return false;
  }
}

function acknowledgeArm(child, message, error) {
  if (!child.connected) return;
  child.send({
    type: UPDATE_ACK,
    protocol: UPDATE_PROTOCOL,
    attemptId: message.attemptId,
    ok: !error,
    ...(error ? { error } : {}),
  });
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

function hasLivePreparedOwnership(control) {
  const status = readControlJson(path.join(control.root, "status.json"));
  const lease = readControlJson(path.join(control.root, "lease.json"));
  return status?.attemptId === control.attemptId
    && (status.state === "prepared" || status.state === "running")
    && status.stage === "stopping"
    && isProcessAlive(status.workerPid)
    && lease?.attemptId === control.attemptId
    && Number.isFinite(lease.expiresAt)
    && lease.expiresAt > Date.now()
    && !secureRegularFile(updatePath(control, "abort.json"))
    && !secureRegularFile(updatePath(control, "go"));
}

function watchUpdateCompletion(control) {
  const poll = () => {
    if (updateControl !== control) return;
    let completion;
    try { completion = readControlJson(updatePath(control, "complete.json")); }
    catch {
      setTimeout(poll, 100).unref?.();
      return;
    }
    if (completion) {
      if (completion.protocol !== UPDATE_PROTOCOL || completion.attemptId !== control.attemptId) {
        setTimeout(poll, 100).unref?.();
        return;
      }
      try {
        atomicWrite(updatePath(control, "complete-ack.json"), JSON.stringify({
          protocol: UPDATE_PROTOCOL,
          attemptId: control.attemptId,
        }));
      } catch {
        setTimeout(poll, 100).unref?.();
        return;
      }
      updateControl = null;
      waitingForRestart = false;
      if (!currentChild) process.exit(1);
      return;
    }
    setTimeout(poll, 100).unref?.();
  };
  poll();
}

function handleUpdateArm(child, message) {
  if (!message || message.type !== UPDATE_MESSAGE || message.protocol !== UPDATE_PROTOCOL) return;
  if (!/^[0-9a-f-]{36}$/i.test(message.attemptId ?? "") || !isExternalControlRoot(message.root)) {
    acknowledgeArm(child, message, "invalid update control");
    return;
  }
  try {
    const control = { attemptId: message.attemptId, root: fs.realpathSync(message.root) };
    if (updateControl
      && (updateControl.attemptId !== control.attemptId || updateControl.root !== control.root)) {
      acknowledgeArm(child, message, "another update is active");
      return;
    }
    if (!hasLivePreparedOwnership(control)) {
      acknowledgeArm(child, message, "update attempt is no longer active");
      return;
    }
    if (!updateControl) {
      process.chdir(control.root);
      atomicWrite(updatePath(control, "armed.json"), JSON.stringify({
        protocol: UPDATE_PROTOCOL,
        attemptId: control.attemptId,
        launcherPid: process.pid,
      }));
      currentGeneration = 0;
      updateControl = control;
      watchUpdateCompletion(control);
    } else {
      atomicWrite(updatePath(updateControl, "armed.json"), JSON.stringify({
        protocol: UPDATE_PROTOCOL,
        attemptId: updateControl.attemptId,
        launcherPid: process.pid,
      }));
    }
  } catch {
    acknowledgeArm(child, message, "update control could not be armed");
    return;
  }
  acknowledgeArm(child, message);
}

function attachOutput(child) {
  let bannerPrinted = false;
  let readyBuffer = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    readyBuffer += text;
    if (readyBuffer.length > 500) readyBuffer = readyBuffer.slice(-500);
    if (!readyBuffer.includes("Ready")) return;
    if (!bannerPrinted) {
      bannerPrinted = true;
      const { entries, hint } = getAccessibleAddresses({ hostname, port });
      process.stdout.write(formatAddressBanner({
        version: readPackageVersion(),
        entries,
        hint,
        passwordEnabled,
        isTTY: process.stdout.isTTY,
      }));
    }
    if (openBrowser && !browserOpened) {
      browserOpened = true;
      const openCmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      const opener = spawn(openCmd, [browserUrl], { stdio: "ignore", detached: true });
      opener.on("error", (error) => console.warn(`Could not open browser automatically: ${error.message}`));
      opener.unref();
    }
  });
}

function serverEnvironment() {
  return {
    ...process.env,
    OMP_WEB_PACKAGE_DIR: pkgDir,
    OMP_WEB_LAUNCHER_PID: String(process.pid),
    OMP_WEB_PORT: port,
    OMP_WEB_HOSTNAME: hostname,
    OMP_WEB_RESTART_DESCRIPTOR: restartDescriptor,
  };
}

function trackServer(child) {
  currentChild = child;
  child.on("message", (message) => handleUpdateArm(child, message));
  child.once("error", (error) => {
    console.error(`Could not start ompweb: ${error.message}`);
    if (Number.isInteger(child.pid) && child.pid > 0) return;
    if (currentChild === child) currentChild = null;
    if (updateControl) {
      waitForRestartRequest(updateControl).catch((restartError) => {
        console.error(`Could not complete update restart: ${restartError.message}`);
      });
    }
  });
  attachOutput(child);
  wireChildProcessLifecycle(child, process, undefined, () => {
    if (!updateControl) return false;
    if (currentChild === child) currentChild = null;
    waitForRestartRequest(updateControl).catch((error) => {
      console.error(`Could not complete update restart: ${error.message}`);
    });
    return true;
  });
  return child;
}

function spawnServer() {
  return trackServer(spawn(process.execPath, [nextBin, ...nextArgs], {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit", "ipc"],
    env: serverEnvironment(),
  }));
}

function spawnRestartGate() {
  return spawn(process.execPath, [
    "-e",
    `(${runRestartGate.toString()})(${JSON.stringify(RESTART_GATE_START)})`,
  ], {
    cwd: pkgDir,
    detached: process.platform !== "win32",
    stdio: ["inherit", "pipe", "inherit", "ipc"],
    env: serverEnvironment(),
  });
}

function startRestartGate(child, args) {
  return new Promise((resolve, reject) => {
    if (!child.connected) return reject(new Error("restart gate IPC is unavailable"));
    child.send({ type: RESTART_GATE_START, args }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function acknowledgeRestartRequest(control, request, child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    if (currentChild === child) currentChild = null;
    return false;
  }
  const acknowledgement = JSON.stringify({
    protocol: UPDATE_PROTOCOL,
    attemptId: control.attemptId,
    generation: request.generation,
    pid: child.pid,
  });
  while (true) {
    for (let attempt = 1; attempt <= RESTART_ACK_RETRIES; attempt += 1) {
      try {
        atomicWrite(updatePath(control, "restart-ack.json"), acknowledgement);
        currentGeneration = request.generation;
        try { removeSecureFile(updatePath(control, "restart-request.json")); }
        catch { /* the durable acknowledgement makes the retained request harmless */ }
        return true;
      } catch {
        if (attempt < RESTART_ACK_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RESTART_ACK_RETRY_MS));
        }
      }
    }

    if (await terminateChildProcess(child)) {
      if (currentChild === child) currentChild = null;
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, RESTART_ACK_RETRY_MS));
  }
}

async function acknowledgeAndStartRestart(control, request, child, args) {
  if (!await acknowledgeRestartRequest(control, request, child)) return false;
  await startRestartGate(child, args);
  return true;
}

async function waitForRestartRequest(control) {
  if (waitingForRestart || updateControl !== control) return;
  waitingForRestart = true;
  const requestFile = updatePath(control, "restart-request.json");
  try {
    while (updateControl === control && !currentChild) {
      let request;
      try { request = readControlJson(requestFile); } catch {}
      if (request?.attemptId === control.attemptId
        && request.protocol === UPDATE_PROTOCOL
        && request.action === "start"
        && Number.isInteger(request.generation)
        && request.generation === currentGeneration + 1) {
        const child = trackServer(spawnRestartGate());
        if (await acknowledgeAndStartRestart(control, request, child, [nextBin, ...nextArgs])) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    waitingForRestart = false;
    if (updateControl === control && !currentChild) {
      setTimeout(() => {
        waitForRestartRequest(control).catch((error) => {
          console.error(`Could not complete update restart: ${error.message}`);
        });
      }, 0);
    }
  }
}

async function main() {
  if (!fs.existsSync(nextDir) || !fs.existsSync(nextBin)) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }
  if (!isLoopbackHost(hostname)) {
    if (!passwordEnabled) {
      console.error(`Refusing to listen on ${hostname} without OMP_WEB_PASSWORD (or --password). Set a strong password or bind to 127.0.0.1.`);
      process.exit(1);
    }
    console.warn(`Warning: ompweb is listening on ${hostname} over HTTP. Use HTTPS or a trusted VPN to protect the password and session cookie in transit.`);
  }

  if (!await isPortAvailable(port, hostname)) {
    console.error(`Port ${port} on ${hostname} is already in use.`);
    console.error(`If ompweb is already running, open ${browserUrl}. Otherwise, stop the process using it or run: ompweb --port ${Number(port) + 1}`);
    process.exitCode = 1;
    return;
  }
  spawnServer();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Could not start ${browserUrl}: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  acknowledgeAndStartRestart,
  acknowledgeRestartRequest,
  handleUpdateArm,
  resolveNextBin,
  spawnRestartGate,
  startRestartGate,
};
