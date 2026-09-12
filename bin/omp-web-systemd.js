#!/usr/bin/env node
"use strict";

// Install ompweb as a Linux systemd user service (starts at login, restarts on crash).
//
// Usage (installed as the `ompweb-systemd` bin, or run via node directly):
//   ompweb-systemd [install|uninstall|start|stop|restart|status]
//   npx -p @kahme247/ompweb@latest ompweb-systemd install
//
// The service runs the locally installed `ompweb` binary resolved at install
// time (sibling of the running node, else on PATH; OMP_WEB_SYSTEMD_BIN override).
//
// Configuration (read at install time, baked into the unit):
//   PORT                 Server port                                default 30177
//   OMP_WEB_HOSTNAME     Server bind host                           default 127.0.0.1
//   OMP_WEB_PASSWORD     Optional password for web login            default none (auth disabled)
//   OMP_WEB_NO_OPEN      Set to 1 to not auto-open the browser      default 1 (no auto-open)
//   OMP_WEB_OMP_BIN      Path to omp binary if not on PATH          default auto-detected
//   PI_CODING_AGENT_DIR  Custom omp agent directory                 default ~/.omp/agent
//
// Example (loopback-only; require auth + trusted HTTPS proxy/VPN for remote access):
//   OMP_WEB_PASSWORD=secret ompweb-systemd install

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getServiceEnvPath, readServiceEnv, writeServiceEnv } = require("./service-env");

const UNIT_NAME = "ompweb";
const UNIT = `${UNIT_NAME}.service`;
const HOME = os.homedir();
const UNIT_DIR = path.join(HOME, ".config", "systemd", "user");
const UNIT_PATH = path.join(UNIT_DIR, UNIT);
const ENV_PATH = getServiceEnvPath();

function printHelp() {
  console.log(`Usage: ompweb-systemd [command] [options]

Commands:
  install      Install the ompweb user service and enable it (starts at login)
  uninstall    Stop the service and remove the unit file
  start        Start the service
  stop         Stop the service
  restart      Restart the service
  status       Show service status (default when no command given)
  open         Open the web service in the default browser
  help         Show this help

Options:
  -p, --port <port>       Server port baked into the unit (default 30177, env PORT)
  -H, --hostname <host>   Bind address baked into the unit (default 127.0.0.1, env OMP_WEB_HOSTNAME)
      --no-autostart      Install the unit but do not enable it at login
      --clean-config      Also delete ~/.omp/agent/web-service.json on uninstall
      --json              Output status as JSON
  -h, --help              Show this help
  -v, --version           Show version
`);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile() && fs.accessSync(candidate, fs.constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

function which(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutableFile(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function readPackageVersion() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Escape a value for a quoted systemd Environment="K=V" pair: backslash and
// double quote are escaped, % is doubled (it starts specifiers like %h).
function escapeUnitValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

function environmentLine(entries) {
  return entries.map(([key, value]) => `"${key}=${escapeUnitValue(value)}"`).join(" ");
}

// Resolve the ompweb binary the unit will run: explicit override wins, then
// the sibling of the running node (npm/bun global installs), then PATH.
// Throws when no usable binary is found; callers surface it via fail().
function resolveOmpwebBin(env = process.env) {
  const override = env.OMP_WEB_SYSTEMD_BIN;
  if (override) {
    if (!isExecutableFile(override)) throw new Error(`OMP_WEB_SYSTEMD_BIN=${override} is not executable`);
    return override;
  }
  const sibling = path.join(path.dirname(process.execPath), "ompweb");
  if (isExecutableFile(sibling)) return sibling;
  const onPath = which("ompweb");
  if (onPath) return onPath;
  throw new Error("ompweb binary not found (next to node or on PATH); set OMP_WEB_SYSTEMD_BIN");
}

// Build the unit file text. Pure so tests can assert on generation.
// Runtime configuration (port, hostname, password, ...) lives in the
// EnvironmentFile so the tray and CLI can edit it without reinstalling.
function buildUnit({ ompwebBin, env: extraEnv = {}, home = HOME }) {
  const ompBin = extraEnv.OMP_WEB_OMP_BIN ?? null;
  const pathDirs = [
    ...(ompBin ? [path.dirname(ompBin)] : []),
    path.dirname(ompwebBin),
    path.dirname(process.execPath),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((dir, i, all) => all.indexOf(dir) === i);

  return `# Generated by ompweb-systemd — edits are overwritten on reinstall.
[Unit]
Description=ompweb web service (oh-my-pi web UI)
Documentation=https://github.com/kahme247/ompweb#readme
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=${ompwebBin}
Environment=${environmentLine([["PATH", pathDirs.join(path.delimiter)]])}
EnvironmentFile=${ENV_PATH}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

// Run systemctl --user; a missing daemon or session is a hard failure unless ignored.
function systemctl(args, { ignoreFailure = false } = {}) {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.error) {
    if (ignoreFailure) return { ok: false, stdout: "", stderr: String(result.error.message) };
    fail(`systemctl not runnable: ${result.error.message}`);
  }
  const ok = result.status === 0;
  if (!ok && !ignoreFailure) {
    fail(`systemctl ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return { ok, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// systemctl --user <verb> -- <unit> exits 0/3 for active/inactive; collapse to boolean.
function systemdQuery(args) {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.error) fail(`systemctl not runnable: ${result.error.message}`);
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

function install(options = {}) {
  let ompwebBin;
  try {
    ompwebBin = resolveOmpwebBin();
  } catch (err) {
    fail(err.message);
  }

  const ompBin = process.env.OMP_WEB_OMP_BIN ?? which("omp");
  if (process.env.OMP_WEB_OMP_BIN && !isExecutableFile(process.env.OMP_WEB_OMP_BIN)) {
    fail(`OMP_WEB_OMP_BIN=${process.env.OMP_WEB_OMP_BIN} is not executable`);
  } else if (!ompBin) {
    console.warn("warning: omp binary not found; live-agent features will be unavailable (set OMP_WEB_OMP_BIN)");
  }

  const port = options.port ?? process.env.PORT ?? "30177";
  const hostname = options.hostname ?? process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  const password = process.env.OMP_WEB_PASSWORD;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, HOME);

  const unit = buildUnit({
    ompwebBin,
    env: ompBin ? { OMP_WEB_OMP_BIN: ompBin } : {},
  });

  // Runtime configuration: editable via the tray or by hand, read on every
  // service (re)start — no reinstall needed for port/hostname/password edits.
  writeServiceEnv({
    PORT: String(port),
    OMP_WEB_HOSTNAME: hostname,
    OMP_WEB_NO_OPEN: "1",
    ...(password ? { OMP_WEB_PASSWORD: password } : {}),
    ...(ompBin ? { OMP_WEB_OMP_BIN: ompBin } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  });

  const wasActive = systemdQuery(["is-active", "--quiet", UNIT]).ok;

  fs.mkdirSync(UNIT_DIR, { recursive: true });
  // Optional password lives in the unit as plain text; keep it user-readable only.
  fs.writeFileSync(UNIT_PATH, unit, { mode: 0o600 });
  fs.chmodSync(UNIT_PATH, 0o600);

  systemctl(["daemon-reload"]);
  if (options.autostart !== false) systemctl(["enable", "--now", UNIT]);
  else systemctl(["start", UNIT], { ignoreFailure: true });
  if (wasActive) systemctl(["restart", UNIT]);

  console.log(`installed: ${UNIT_PATH}`);
  console.log(`binary:    ${ompwebBin}`);
  console.log(`config:    ${ENV_PATH} (port/hostname/password — no reinstall needed)`);
  console.log(`url:       http://${hostname}:${port}`);
  console.log(`logs:      journalctl --user -u ${UNIT_NAME} -f`);
  if (options.autostart === false) console.log("note:      service is not enabled at login (--no-autostart)");
  if (password) console.log("note:      password is stored in plain text in the unit (mode 600)");
}

function uninstall(options = {}) {
  systemctl(["disable", "--now", UNIT], { ignoreFailure: true });
  fs.rmSync(UNIT_PATH, { force: true });
  systemctl(["daemon-reload"], { ignoreFailure: true });
  if (options.cleanConfig) {
    const config = path.join(HOME, ".omp", "agent", "web-service.json");
    fs.rmSync(config, { force: true });
    console.log(`removed:   ${config}`);
    fs.rmSync(ENV_PATH, { force: true });
    console.log(`removed:   ${ENV_PATH}`);
  }
  console.log(`uninstalled: ${UNIT_NAME}`);
}

function start() {
  systemctl(["start", UNIT]);
  console.log(`started: ${UNIT_NAME}`);
}

function stop() {
  systemctl(["stop", UNIT]);
  console.log(`stopped: ${UNIT_NAME}`);
}

function restart() {
  systemctl(["restart", UNIT]);
  console.log(`restarted: ${UNIT_NAME}`);
}

function readStatus() {
  const active = systemdQuery(["is-active", UNIT]);
  const enabled = systemdQuery(["is-enabled", UNIT]);
  const pid = systemdQuery(["show", "--property", "MainPID", "--value", UNIT]);
  const envConfig = readServiceEnv();
  const port = parseInt(envConfig.PORT ?? process.env.PORT ?? "30177", 10);
  const hostname = envConfig.OMP_WEB_HOSTNAME ?? process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  return {
    isLinux: process.platform === "linux",
    unit: UNIT,
    unitPath: UNIT_PATH,
    envFile: ENV_PATH,
    isInstalled: fs.existsSync(UNIT_PATH),
    isActive: active.ok && active.stdout === "active",
    isEnabled: enabled.ok,
    pid: parseInt(pid.stdout, 10) || null,
    port,
    hostname,
    serviceUrl: `http://${hostname}:${port}`,
    logCommand: `journalctl --user -u ${UNIT_NAME} -f`,
  };
}

function printStatus(asJson) {
  const status = readStatus();
  if (asJson) {
    console.log(JSON.stringify(status, null, 2));
    return status;
  }
  console.log(`=== omp-web systemd service status (${process.platform}) ===`);
  console.log(`  Unit        : ${status.unit} (${status.isInstalled ? status.unitPath : "not installed"})`);
  console.log(`  Version     : v${readPackageVersion()}`);
  console.log(`  Active      : ${status.isActive ? `Yes (pid ${status.pid})` : "No"}`);
  console.log(`  Start at login: ${status.isEnabled ? "Enabled" : "Disabled"}`);
  console.log(`  Live URL    : ${status.serviceUrl}`);
  console.log(`  Logs        : ${status.logCommand}`);
  return status;
}

function openInBrowser() {
  const status = readStatus();
  const openBin = process.env.OMP_WEB_OPEN ?? which("xdg-open") ?? "xdg-open";
  const child = spawnSync(openBin, [status.serviceUrl], { stdio: "ignore", detached: true });
  if (child.error) console.error(`Failed to open browser: ${child.error.message}`);
  else console.log(`Opening ${status.serviceUrl}...`);
}

async function runCli(argv = process.argv.slice(2)) {
  const { values: cliArgs, positionals } = parseArgs({
    args: argv,
    options: {
      port:           { type: "string", short: "p" },
      hostname:       { type: "string", short: "H" },
      "no-autostart": { type: "boolean" },
      "clean-config": { type: "boolean" },
      json:           { type: "boolean" },
      help:           { type: "boolean", short: "h" },
      version:        { type: "boolean", short: "v" },
    },
    strict: false,
    allowPositionals: true,
  });

  if (cliArgs.version || positionals.includes("version")) {
    console.log(readPackageVersion());
    return { exitCode: 0 };
  }
  if (cliArgs.help || positionals.includes("help")) {
    printHelp();
    return { exitCode: 0 };
  }

  const command = positionals[0] ?? "status";
  if (!["install", "uninstall", "start", "stop", "restart", "open", "status"].includes(command)) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    return { exitCode: 2 };
  }

  // Help, version, and unknown-command usage (above) work everywhere; the
  // commands below need systemd.
  if (process.platform !== "linux") {
    fail("systemd services are Linux-only (see ompweb-launchd for macOS, ompweb --install-tray for Windows)");
  }

  const installOpts = {
    port: cliArgs.port ? parseInt(cliArgs.port, 10) : undefined,
    hostname: cliArgs.hostname,
    autostart: !cliArgs["no-autostart"],
  };

  switch (command) {
    case "install":
      install(installOpts);
      break;
    case "uninstall":
      uninstall({ cleanConfig: cliArgs["clean-config"] });
      break;
    case "start":
      start();
      break;
    case "stop":
      stop();
      break;
    case "restart":
      restart();
      break;
    case "open":
      openInBrowser();
      break;
    case "status": {
      const status = printStatus(cliArgs.json);
      return { exitCode: 0, status };
    }
  }
  return { exitCode: 0 };
}

if (require.main === module) {
  runCli().then(({ exitCode }) => {
    if (exitCode !== undefined && exitCode !== 0) process.exit(exitCode);
  }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  UNIT,
  UNIT_PATH,
  buildUnit,
  escapeUnitValue,
  readStatus,
  resolveOmpwebBin,
  runCli,
};
