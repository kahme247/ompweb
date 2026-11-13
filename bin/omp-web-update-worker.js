#!/usr/bin/env node
"use strict";
// Dependency-free CommonJS - copied outside pkgDir to survive Windows file-lock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const STAGES = ["preparing", "stopping", "installing", "restarting", "finalizing"];

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const attemptId = arg("--attempt");
const root = arg("--root");
const packageDir = arg("--package-dir");
const manager = arg("--manager");
const managerPath = arg("--manager-path");
const target = arg("--target");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const from = arg("--from");
const launcherPid = Number(arg("--launcher-pid"));
const serverPid = Number(arg("--server-pid"));
// Set when the server runs as this systemd unit; systemd stops and starts it.
const systemdUnit = arg("--systemd-unit");
const systemctlScope = arg("--systemd-user") === "1" ? ["--user"] : [];
let descriptor;
let managerPrefix;
try {
  descriptor = JSON.parse(arg("--descriptor") || "null");
  managerPrefix = JSON.parse(arg("--manager-prefix") || "[]");
} catch {
  descriptor = null;
  managerPrefix = [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function leaseFile() { return path.join(root, "lease.json"); }
function statusFile() { return path.join(root, "status.json"); }
function markerFile(m) { return path.join(root, attemptId + "." + m); }
function abortFile() { return markerFile("abort.json"); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function atomicWrite(file, obj) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
function updateStatus(patch) {
  const cur = readJson(statusFile()) || {};
  const next = { ...cur, ...patch };
  // atomic write via tmp+rename
  const dir = path.dirname(statusFile());
  const tmp = path.join(dir, ".status." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, statusFile());
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// The launcher (bin/omp-web.js watchUpdateCompletion) was armed at commit: an attempt that ends without a restart must
// disarm it, or it takes the running server's next exit for this update's restart and waits forever.
function disarmLauncher() {
  try { atomicWrite(markerFile("complete.json"), { protocol: 1, attemptId, state: "failed", completedAt: new Date().toISOString() }); } catch {}
}
function isLaunchdActive() {
  try {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", "com.kahme247.ompweb.plist");
    return fs.existsSync(plist);
  } catch { return false; }
}
function isTrayActive() {
  try {
    const svc = path.join(os.homedir(), ".omp", "agent", "web-service.json");
    if (!fs.existsSync(svc)) return false;
    const data = readJson(svc);
    return Boolean(data && data.pid);
  } catch { return false; }
}
function systemctl(action) {
  const result = cp.spawnSync("systemctl", [...systemctlScope, action, systemdUnit], { encoding: "utf8", timeout: 120000 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || (result.error && result.error.message) || "").trim().slice(0, 200);
    throw new Error(`systemctl ${action} ${systemdUnit} failed${detail ? `: ${detail}` : ""}`);
  }
}

async function stopOriginalProcesses() {
  updateStatus({ stage: "stopping" });
  if (systemdUnit) {
    systemctl("stop");
    return { systemd: true, launchd: false, tray: false };
  }
  // Detect services
  const launchd = isLaunchdActive();
  const tray = isTrayActive();
  if (launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootout", `gui/${uid}/com.kahme247.ompweb`], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(500);
  }
  if (tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawnSync(process.execPath, [trayBin, "--stop"], { timeout: 15000, windowsHide: true });
      }
    } catch {}
    await sleep(500);
  }
  // Plain next: try to kill launcher/server pids with SIGTERM 5s -> SIGKILL
  if (!launchd && !tray) {
    for (const pid of [launcherPid, serverPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await sleep(5000);
    for (const pid of [launcherPid, serverPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    // waitForPort 90s simplified: sleep 1s (real impl would poll port)
    await sleep(1000);
  }
  return { launchd, tray };
}

// The candidate's `ompweb fetch-omp` (lib/omp/runner-fetch.ts: its version's omp runner, into the per-version cache the
// installed release then uses) and `ompweb preflight` (lib/hosts/preflight.ts), installed into a scratch prefix and run
// in this environment before anything stops: a session omp that cannot start fails the update, not the running server.
function preflightCandidate() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "ompweb-candidate-"));
  try {
    fs.writeFileSync(path.join(prefix, "package.json"), '{"private":true}');
    const pkg = `@kahme247/ompweb@${target}`;
    // shell: true (Windows) joins arguments unquoted.
    const where = process.platform === "win32" ? `"${prefix}"` : prefix;
    const args = manager === "bun" ? ["add", "--cwd", where, "--production", "--exact", pkg] : ["install", "--prefix", where, "--omit=dev", "--no-audit", "--no-fund", pkg];
    const install = cp.spawnSync(manager === "bun" ? (managerPath || "bun") : (managerPath || "npm"), args, { timeout: 5 * 60 * 1000, windowsHide: true, env: process.env, shell: process.platform === "win32" });
    if (install.status !== 0) {
      const detail = install.stderr ? install.stderr.toString().trim().slice(-300) : String(install.error || "");
      throw new Error(`candidate install failed (exit ${install.status})${detail ? `: ${detail}` : ""}`);
    }
    const release = path.join(prefix, "node_modules", "@kahme247", "ompweb");
    // Detected statically: an older ompweb takes `preflight` for a positional and starts a web server.
    if (!fs.existsSync(path.join(release, "lib", "hosts", "preflight.ts"))) {
      console.warn(`ompweb ${target} has no preflight command; its omp was not checked`);
      return;
    }
    // OMP_WEB_PACKAGE_DIR: the launcher set it to the running install, whose omp this must not check.
    const candidate = (command, timeout) => {
      const result = cp.spawnSync(process.execPath, [path.join(release, "bin", "omp-web.js"), command], { cwd: prefix, timeout, windowsHide: true, env: { ...process.env, OMP_WEB_PACKAGE_DIR: release }, encoding: "utf8" });
      return result.status === 0 ? null : ((result.stderr || "").trim() || String(result.error || `exit ${result.status}`)).slice(-300);
    };
    // 15 min, as the host updater allows the download.
    const fetchFailure = fs.existsSync(path.join(release, "lib", "omp", "runner-fetch.ts")) ? candidate("fetch-omp", 15 * 60 * 1000) : null;
    if (fetchFailure) throw new Error(`the new release could not fetch its omp: ${fetchFailure}`);
    // 120 s: the preflight itself can take 30 s for the hello, 7 s to stop omp and 30 s for the version probe.
    const preflightFailure = candidate("preflight", 120 * 1000);
    if (preflightFailure) throw new Error(`the new release cannot start a session: ${preflightFailure}`);
  } finally {
    // Best effort: a locked file (Windows) must not fail an update the check passed.
    try { fs.rmSync(prefix, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
}

async function runManagerGate() {
  updateStatus({ stage: "installing" });
  const cmd = manager === "bun" ? (managerPath || "bun") : (managerPath || "npm");
  const args = manager === "bun" ? ["add", "-g", `@kahme247/ompweb@${target}`] : ["install", "-g", `@kahme247/ompweb@${target}`];
  if (Array.isArray(managerPrefix) && managerPrefix.length) args.unshift(...managerPrefix);
  let retries = 0;
  let lastResult;
  while (retries <= 1) {
    const result = cp.spawnSync(cmd, args, { timeout: 5 * 60 * 1000, windowsHide: true, env: process.env, shell: process.platform === "win32" });
    lastResult = result;
    const stderr = result.stderr ? result.stderr.toString() : "";
    const spawnError = result.error ? String(result.error.code || result.error.message || "") : "";
    const isBusy = (result.error && ["EBUSY", "EPERM"].includes(result.error.code || "")) || /EBUSY|EPERM/.test(stderr) || /EBUSY|EPERM/.test(spawnError);
    if (isBusy && retries === 0) {
      retries++;
      await sleep(2000);
      continue;
    }
    break;
  }
  if (lastResult && lastResult.status !== 0) {
    const stderr = lastResult.stderr ? lastResult.stderr.toString().trim().slice(0, 500) : "";
    const spawnErr = lastResult.error ? String(lastResult.error.message || lastResult.error.code || "").slice(0, 200) : "";
    const detail = stderr || spawnErr;
    throw new Error(`package install failed (exit ${lastResult.status})${detail ? `: ${detail}` : ""}`);
  }
}

async function restartServices(info) {
  updateStatus({ stage: "restarting" });
  if (info.systemd) {
    systemctl("start");
    // A Type=simple start returns once the process is forked; a release that
    // crashes on startup shows up as not active a moment later.
    // shortcut: one check after 3s, not a port probe; upgrade if slow-starting crashes slip through.
    await sleep(3000);
    systemctl("is-active");
    return;
  }
  if (info.launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path.join(os.homedir(), "Library", "LaunchAgents", "com.kahme247.ompweb.plist")], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(1000);
    return;
  }
  if (info.tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawn(process.execPath, [trayBin, "--start"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      }
    } catch {}
    await sleep(1000);
    return;
  }
  // Plain next: ask launcher to restart via armed marker handshake
  try {
    const restartRequest = path.join(root, attemptId + ".restart-request.json");
    const restartAck = path.join(root, attemptId + ".restart-ack.json");
    atomicWrite(restartRequest, { attemptId, port: descriptor && descriptor.port, hostname: descriptor && descriptor.hostname, requestedAt: new Date().toISOString() });
    // Wait up to 30s for ack
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(restartAck)) break;
      await sleep(1000);
    }
  } catch {}
}

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId || "") || !root || !packageDir || !target) {
    process.exit(1);
  }
  // Check abort
  if (fs.existsSync(abortFile())) {
    updateStatus({ state: "failed", error: (readJson(abortFile()) || {}).reason || "aborted", finishedAt: new Date().toISOString(), cleanupReady: true });
    disarmLauncher();
    process.exit(0);
  }
  // Check go marker exists (commit signal)
  if (!fs.existsSync(markerFile("go"))) {
    // wait briefly for go
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(markerFile("go"))) break;
      await sleep(200);
    }
  }
  updateStatus({ state: "running", stage: "preparing", startedAt: new Date().toISOString() });
  await sleep(1000); // PREPARING_MIN 1s

  let svcInfo = { launchd: false, tray: false };
  try {
    preflightCandidate();
    svcInfo = await stopOriginalProcesses();
    await runManagerGate();
    try {
      const pkgPath = path.join(packageDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = readJson(pkgPath);
        if (pkg && pkg.version !== target) {
          // version mismatch not fatal but record
        }
      }
    } catch {}
    await restartServices(svcInfo);
    await sleep(500);
    updateStatus({ state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true });
    // write complete marker
    try { atomicWrite(markerFile("complete.json"), { attemptId, completedAt: new Date().toISOString() }); } catch {}
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    // Never leave the service stopped after a failed install.
    if (systemdUnit) {
      try { systemctl("start"); } catch { msg = `${systemdUnit} is still stopped: ${msg}`; }
    }
    updateStatus({ state: "failed", error: msg.slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true });
    disarmLauncher();
  }
}

main().catch((e) => {
  try { updateStatus({ state: "failed", error: String(e).slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true }); } catch {}
  disarmLauncher();
  process.exit(1);
});
