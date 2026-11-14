#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./node-version").exitIfUnsupportedNode();

// Forward service subcommands from the main bin. This makes both
// `npx @kahme247/ompweb@latest ompweb-launchd ...` and
// `npx @kahme247/ompweb@latest ompweb-systemd ...` work without requiring
// callers to know the path of the secondary executable.
const forwardedServiceScripts = {
  launchd: "omp-web-launchd.js",
  "ompweb-launchd": "omp-web-launchd.js",
  systemd: "omp-web-systemd.js",
  "ompweb-systemd": "omp-web-systemd.js",
};

// `ompweb hash-password` reads the password on stdin and prints the value for
// OMP_WEB_PASSWORD_HASH. Handled first so it works with no build artifacts, no
// port, and no agent directory.
if (process.argv[2] === "hash-password" || process.argv[2] === "hash_password") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runHashPasswordCommand } = require("./omp-web-hash-password");
  runHashPasswordCommand()
    .then((exitCode) => { process.exit(exitCode); })
    .catch((error) => {
      console.error(`Could not hash the password: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
} else {
  startLauncher();
}

function startLauncher() {
// `ompweb preflight` (lib/hosts/preflight.ts): what an updater runs on a candidate release; it prints "preflight ok: <omp> <version>".
if (process.argv[2] === "preflight") {
  process.env.OMP_WEB_PACKAGE_DIR ??= module.require("node:path").join(__dirname, "..");
  module.require("jiti").createJiti(__filename).import("../lib/hosts/preflight.ts").then(
    ({ runPreflight }) => runPreflight().then((code) => process.exit(code)),
    (error) => {
      console.error(`preflight failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
  return;
}
// `ompweb fetch-omp` (lib/omp/runner-fetch.ts): fetch this version's omp runner if missing; updaters run it before preflight.
if (process.argv[2] === "fetch-omp") {
  process.env.OMP_WEB_PACKAGE_DIR ??= module.require("node:path").join(__dirname, "..");
  module.require("jiti").createJiti(__filename).import("../lib/omp/runner-fetch.ts").then(
    ({ runFetchOmp }) => runFetchOmp().then((code) => process.exit(code)),
    (error) => {
      console.error(`fetch-omp failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
  return;
}
if (process.argv[2] === "recover-host") {
  process.env.OMP_WEB_PACKAGE_DIR ??= module.require("node:path").join(__dirname, "..");
  module.require("jiti").createJiti(__filename).import("../lib/hosts/recovery.ts").then(
    ({ runHostRecoveryCli }) => runHostRecoveryCli(process.argv.slice(3)).then((code) => process.exit(code)),
    (error) => {
      console.error(`Host recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
  return;
}
// `ompweb host` runs in this process: a supervisor's SIGTERM must reach the daemon, not a wrapper.
if (process.argv[2] === "host") {
  process.argv.splice(2, 1);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./omp-web-host.js");
  return;
}
const forwardedServiceScript = forwardedServiceScripts[process.argv[2]];
if (forwardedServiceScript) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path");
  const result = spawnSync(process.execPath, [join(__dirname, forwardedServiceScript), ...process.argv.slice(3)], { stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to run ${process.argv[2]}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkLaunchSecurity, parseLaunchOptions } = require("./omp-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isPortAvailable } = require("./port-availability");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAccessibleAddresses, getBrowserUrl, formatAddressBanner, openInBrowser } = require("./network-addresses");
// module.require: bin/ files add no new eslint-disable comments (see bin/bun-runtime.js).
const { resolveBunBinary } = module.require("./bun-runtime");

const pkgDir = path.join(__dirname, "..");

const launchOptions = parseLaunchOptions();
if (launchOptions.help || launchOptions.version) {
  process.exit(0);
}
if (launchOptions.error) {
  console.error(launchOptions.error);
  process.exit(2);
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
const openBrowser = launchOptions.openBrowser;
const passwordEnabled = checkLaunchSecurity(launchOptions) !== undefined;

// Resolved at every spawn, so a restart after an update finds the updated Bun.
function serverCommand() {
  return [resolveBunBinary(pkgDir), path.join(pkgDir, "server", "main.ts"), "-p", String(port), "-H", String(hostname)];
}
const browserUrl = getBrowserUrl(hostname, port);
let browserOpened = false;
function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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
      openInBrowser(browserUrl);
    }
  });
}

function serverEnvironment() {
  return {
    ...process.env,
    OMP_WEB_PACKAGE_DIR: pkgDir,
    OMP_WEB_LAUNCHER_PID: String(process.pid),
    OMP_WEB_NODE_BIN: process.execPath,
    OMP_WEB_PORT: port,
    OMP_WEB_HOSTNAME: hostname,
  };
}

function trackServer(child) {
  child.once("error", (error) => console.error(`Could not start ompweb: ${error.message}`));
  attachOutput(child);
  wireChildProcessLifecycle(child, process);
  return child;
}

function spawnServer(command) {
  return trackServer(spawn(command[0], command.slice(1), {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: serverEnvironment(),
  }));
}


async function main() {
  if (!fs.existsSync(path.join(pkgDir, "dist", "index.html")) || !fs.existsSync(path.join(pkgDir, "server", "main.ts"))) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }
  if (!await isPortAvailable(port, hostname)) {
    console.error(`Port ${port} on ${hostname} is already in use.`);
    console.error(`If ompweb is already running, open ${browserUrl}. Otherwise, stop the process using it or run: ompweb --port ${Number(port) + 1}`);
    process.exitCode = 1;
    return;
  }
  let command;
  try {
    command = serverCommand();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  spawnServer(command);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Could not start ${browserUrl}: ${error.message}`);
    process.exit(1);
  });
}

}
