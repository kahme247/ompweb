#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

function printHelp() {
  console.log(`Usage: node bin/omp-web-tray.js [command] [options]
       ompweb-tray [command] [options]

Commands:
  --install, install      Install Windows System Tray shortcuts and background service
  --uninstall, uninstall  Uninstall Windows System Tray shortcuts and background service
  --start, start          Start the background system tray manager
  --stop, stop            Stop running background system tray and server processes
  --restart, restart      Restart running background system tray and server
  --status, status        Display current background service and shortcut status
  --open, open            Open the background web service in default browser

Options:
  -p, --port <port>       Server port for background service (default 30177)
  -H, --hostname <host>   Bind address (default 127.0.0.1)
  -m, --mode <mode>       Execution mode: "start" or "dev" (default "start")
      --no-autostart      Disable automatic Windows startup on logon
      --start             Start tray manager immediately after installation
      --clean-config      Also delete ~/.omp/agent/web-service.json on uninstallation
      --json              Output status as JSON
  -h, --help              Show this help
  -v, --version           Show version
`);
}

async function runCli(argv = process.argv.slice(2)) {
  const { values: cliArgs, positionals } = parseArgs({
    args: argv,
    options: {
      install:        { type: "boolean" },
      uninstall:      { type: "boolean" },
      start:          { type: "boolean" },
      stop:           { type: "boolean" },
      restart:        { type: "boolean" },
      status:         { type: "boolean" },
      open:           { type: "boolean" },
      port:           { type: "string", short: "p" },
      hostname:       { type: "string", short: "H" },
      mode:           { type: "string", short: "m" },
      "no-autostart": { type: "boolean" },
      "clean-config": { type: "boolean" },
      json:           { type: "boolean" },
      help:           { type: "boolean", short: "h" },
      version:        { type: "boolean", short: "v" },
    },
    strict: false,
    allowPositionals: true,
  });

  if (cliArgs.help || positionals.includes("help")) {
    printHelp();
    return { exitCode: 0 };
  }

  if (cliArgs.version || positionals.includes("version")) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require("../package.json");
      console.log(pkg.version ?? "0.0.0");
    } catch {
      console.log("0.0.0");
    }
    return { exitCode: 0 };
  }

  // Load windows-service lib
  // In Next.js / TypeScript codebase, lib/windows-service.ts can be loaded via jiti / ts require or relative
  let windowsService;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    windowsService = require("../lib/windows-service");
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const jiti = require("jiti")(__filename);
      windowsService = jiti("../lib/windows-service");
    } catch (e) {
      console.error("Failed to load windows-service library:", e.message);
      return { exitCode: 1, error: e };
    }
  }

  const isInstall = cliArgs.install || positionals.includes("install");
  const isUninstall = cliArgs.uninstall || positionals.includes("uninstall");
  const isStart = cliArgs.start || positionals.includes("start");
  const isStop = cliArgs.stop || positionals.includes("stop");
  const isRestart = cliArgs.restart || positionals.includes("restart");
  const isStatus = cliArgs.status || positionals.includes("status");
  const isOpen = cliArgs.open || positionals.includes("open");

  if (isInstall) {
    const installOpts = {};
    if (cliArgs.port) installOpts.port = parseInt(cliArgs.port, 10);
    if (cliArgs.hostname) installOpts.hostname = cliArgs.hostname;
    if (cliArgs.mode) installOpts.mode = cliArgs.mode;
    if (cliArgs["no-autostart"]) installOpts.autostart = false;
    if (cliArgs.start) installOpts.startImmediately = true;

    const res = await windowsService.installTrayShortcuts(installOpts);
    if (res.success) {
      console.log(res.message || "Installation successful!");
      return { exitCode: 0, result: res };
    } else {
      console.error(res.message || "Installation failed.");
      return { exitCode: 1, error: new Error(res.message) };
    }
  }
  if (isUninstall) {
    const res = await windowsService.uninstallTrayShortcuts({ cleanConfig: cliArgs["clean-config"] });
    if (res.success) {
      console.log(res.message || "Uninstallation successful!");
      return { exitCode: 0, result: res };
    } else {
      console.error(res.message || "Uninstallation failed.");
      return { exitCode: 1, error: new Error(res.message) };
    }
  }

  if (isStart) {
    console.log("Starting omp-web background system tray service...");
    const res = await windowsService.startTrayService({ openBrowser: cliArgs.open });
    if (res.success) {
      console.log("Tray service launched in background.");
      return { exitCode: 0, result: res };
    } else {
      console.error("Failed to start tray service:", res.message);
      return { exitCode: 1, error: new Error(res.message) };
    }
  }

  if (isStop) {
    console.log("Stopping omp-web background system tray service...");
    const res = await windowsService.stopTrayService();
    if (res.success) {
      console.log("Background system tray service stopped.");
      return { exitCode: 0, result: res };
    } else {
      console.error("Failed to stop tray service:", res.message);
      return { exitCode: 1, error: new Error(res.message) };
    }
  }

  if (isRestart) {
    console.log("Restarting omp-web background system tray service...");
    const res = await windowsService.restartTrayService();
    if (res.success) {
      console.log("Background system tray service restarted.");
      return { exitCode: 0, result: res };
    } else {
      console.error("Failed to restart tray service:", res.message);
      return { exitCode: 1, error: new Error(res.message) };
    }
  }

  if (isOpen) {
    const status = await windowsService.getWebServiceStatus();
    console.log(`Opening web service at ${status.serviceUrl}...`);
    let openCmd = "xdg-open";
    if (process.platform === "win32") {
      const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
      const explorerPath = path.join(sysRoot, "explorer.exe");
      openCmd = fs.existsSync(explorerPath) ? explorerPath : "explorer.exe";
    }
    const child = spawn(openCmd, [status.serviceUrl], { stdio: "ignore", detached: true });
    child.on("error", (err) => {
      console.error(`Failed to open browser: ${err.message}`);
    });
    child.unref();
    return { exitCode: 0 };
  }

  if (isStatus || (!isInstall && !isUninstall && !isStart && !isStop && !isRestart && !isOpen)) {
    const status = await windowsService.getWebServiceStatus();
    if (cliArgs.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log("=== omp-web Windows Service Status ===");
      console.log(`  Platform         : ${process.platform === "win32" ? "Windows" : process.platform}`);
      console.log(`  Version          : v${status.version}`);
      console.log(`  Installed        : ${status.isInstalled ? "Yes" : "No"}`);
      console.log(`  Running          : ${status.isRunning ? "Yes (Tray Active)" : "No (Stopped)"}`);
      console.log(`  Live URL         : ${status.serviceUrl}`);
      console.log(`  Config Mode      : ${status.mode} (Port: ${status.port}, Host: ${status.hostname})`);
      console.log(`  Start with Windows: ${status.autostart ? "Enabled" : "Disabled"}`);
      console.log(`  Desktop Shortcut : ${status.desktopShortcutExists ? "Present" : "Missing"}`);
      console.log(`  Startup Shortcut : ${status.startupShortcutExists ? "Present" : "Missing"}`);
      console.log(`  Log File         : ${status.logFile}`);
      console.log(`  Config File      : ${status.configFile}`);
    }
    return { exitCode: 0, status };
  }

  return { exitCode: 0 };
}

if (require.main === module) {
  runCli().then(({ exitCode }) => {
    if (exitCode !== undefined && exitCode !== 0) {
      process.exit(exitCode);
    }
  }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { runCli };
