"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}


function printHelp() {
  console.log(`Usage: ompweb [options]

Options:
  -p, --port <port>        Server port (default 30177, env PORT)
  -H, --hostname <host>    Bind hostname (default 127.0.0.1, env OMP_WEB_HOSTNAME)
      --password <pass>    Password for the web sign-in screen (env OMP_WEB_PASSWORD)
      --no-open            Do not open the browser automatically
      --install-tray       Install Windows System Tray service & Desktop shortcuts
      --uninstall-tray     Uninstall Windows System Tray service & shortcuts
      --tray               Start background System Tray manager
  -h, --help               Show this help
      --version            Show version
Password:
  ompweb --password "a-long-random-password"
  # env-variable forms (POSIX, PowerShell, CMD handled uniformly)
  OMP_WEB_PASSWORD="secret" ompweb
  $env:OMP_WEB_PASSWORD="secret"; ompweb   # PowerShell
  set OMP_WEB_PASSWORD=secret&& ompweb     # CMD

Security: use HTTPS via a trusted reverse proxy or VPN when binding to a
non-loopback hostname, so the password and session cookie stay private.`);
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      password:  { type: "string" },
      help:      { type: "boolean", short: "h" },
      version:   { type: "boolean" },
      "no-open":         { type: "boolean" },
      "install-tray":    { type: "boolean" },
      "install-service": { type: "boolean" },
      "uninstall-tray":  { type: "boolean" },
      tray:              { type: "boolean" },
    },
    strict: false,
  });

  // --password wins over env so Windows users without POSIX inline-env syntax have a first-class option.
  const password = cliArgs.password ?? env.OMP_WEB_PASSWORD;
  if (cliArgs.version) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require("../package.json");
      console.log(pkg.version ?? "0.0.0");
    } catch { console.log("0.0.0"); }
    return {
      port: cliArgs.port ?? env.PORT ?? "30177",
      hostname: cliArgs.hostname ?? env.OMP_WEB_HOSTNAME ?? "127.0.0.1",
      password,
      openBrowser: !cliArgs["no-open"] && !isEnabled(env.OMP_WEB_NO_OPEN),
      installTray: Boolean(cliArgs["install-tray"] || cliArgs["install-service"]),
      uninstallTray: Boolean(cliArgs["uninstall-tray"]),
      tray: Boolean(cliArgs.tray),
      version: true,
    };
  }
  // Expose help flag without exiting here — caller (bin/omp-web.js) decides
  // whether to exit, keeping parseLaunchOptions testable. Print here so
  // --help works even when the caller is a test.
  if (cliArgs.help) {
    printHelp();
    return {
      port: cliArgs.port ?? env.PORT ?? "30177",
      hostname: cliArgs.hostname ?? env.OMP_WEB_HOSTNAME ?? "127.0.0.1",
      password,
      openBrowser: !cliArgs["no-open"] && !isEnabled(env.OMP_WEB_NO_OPEN),
      installTray: Boolean(cliArgs["install-tray"] || cliArgs["install-service"]),
      uninstallTray: Boolean(cliArgs["uninstall-tray"]),
      tray: Boolean(cliArgs.tray),
      help: true,
    };
  }
  return {
    port: cliArgs.port ?? env.PORT ?? "30177",
    hostname: cliArgs.hostname ?? env.OMP_WEB_HOSTNAME ?? "127.0.0.1",
    password,
    openBrowser: !cliArgs["no-open"] && !isEnabled(env.OMP_WEB_NO_OPEN),
    installTray: Boolean(cliArgs["install-tray"] || cliArgs["install-service"]),
    uninstallTray: Boolean(cliArgs["uninstall-tray"]),
    tray: Boolean(cliArgs.tray),
  };
}

module.exports = { parseLaunchOptions };
