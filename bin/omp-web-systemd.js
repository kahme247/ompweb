#!/usr/bin/env node
"use strict";

// Install ompweb as a Linux systemd user service.
//
// Usage:
//   ompweb-systemd [install|uninstall|start|stop|restart|status|open]
//   npx --yes --package=@kahme247/ompweb@latest ompweb-systemd install
//
// `install` creates ~/.omp/agent/web-service.env. The file is deliberately
// separate from the unit so port, hostname, password, and omp path can be
// edited without reinstalling the service.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("node:util");
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
const DEFAULT_PORT = "30177";
const DEFAULT_HOSTNAME = "127.0.0.1";

function printHelp() {
  console.log(`Usage: ompweb-systemd [command] [options]

Commands:
  install      Install the user service, create its env file, and enable it
  uninstall    Stop the service and remove the unit file
  start        Start the service
  stop         Stop the service
  restart      Restart the service
  status       Show service status (default when no command is given)
  open         Open the web service in the default browser
  help         Show this help

Options:
  -p, --port <port>       Server port (default ${DEFAULT_PORT}, env PORT)
  -H, --hostname <host>   Bind address (default ${DEFAULT_HOSTNAME}, env OMP_WEB_HOSTNAME)
      --no-autostart      Install and start, but do not enable at login
      --clean-config      Also remove web-service.env on uninstall
      --json              Output status as JSON
  -h, --help              Show this help
  -v, --version           Show version

For LAN access, install with:
  OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD=change-me ompweb-systemd install
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

function which(name, env = process.env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutableFile(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

// Read the interpreter of a launcher script (e.g. `#!/usr/bin/env bun`).
// Bun/npm global installs of omp are scripts that need their interpreter on
// PATH at service runtime; the generated unit must include its directory
// (issue #116). Returns the raw interpreter token (e.g. `bun` or
// `/opt/bun/bin/bun`), or null when the file is a native binary,
// unreadable, or has no shebang. Symlinks are resolved first: the `omp` on
// PATH is usually a link to the real launcher.
function readLauncherInterpreter(binPath) {
  let target = binPath;
  try {
    target = fs.realpathSync(binPath);
  } catch {
    // Fall through and try the path as given.
  }
  let fd;
  try {
    fd = fs.openSync(target, "r");
    const buffer = Buffer.alloc(1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0].replace(/\r$/, "");
    const match = /^#!\s*(.+?)\s*$/.exec(firstLine);
    if (!match) return null;
    const parts = match[1].split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    let command = parts[0];
    if (path.basename(command) === "env") {
      // Skip env flags (`-S`, `-i`, `--split-string`, ...); for
      // `-S "cmd args"` the command is the first word of the next token.
      const rest = parts.slice(1).filter((token) => !token.startsWith("-"));
      if (rest.length === 0) return null;
      command = rest[0];
    }
    command = command.replace(/^['"]|['"]$/g, "").split(/\s+/)[0];
    return command || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors on a best-effort probe.
      }
    }
  }
}

// Resolve the directory holding the interpreter a launcher script needs, or
// null when the binary is native / the interpreter is unknown. An absolute
// shebang path's own directory wins; otherwise the interpreter is looked up
// on the installer's PATH (split on `:` — unit files are Linux-only).
function launcherInterpreterDir(binPath, env = process.env) {
  const interpreter = readLauncherInterpreter(binPath);
  if (!interpreter) return null;
  if (path.posix.isAbsolute(interpreter) || path.win32.isAbsolute(interpreter)) {
    try {
      if (fs.statSync(interpreter).isFile()) return path.dirname(interpreter);
    } catch {
      // Fall through to a PATH lookup by command name.
    }
  }
  const onPath = which(path.basename(interpreter), env);
  return onPath ? path.dirname(onPath) : null;
}

function readPackageVersion() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Escape a value for a quoted systemd Environment="K=V" pair.
function escapeUnitValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%");
}

function environmentLine(entries) {
  return entries
    .map(([key, value]) => `"${key}=${escapeUnitValue(value)}"`)
    .join(" ");
}

function escapeUnitPath(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "%%")
    .replace(/ /g, "\\x20")
    .replace(/\t/g, "\\x09");
}

function formatExecStart(value) {
  const escaped = escapeUnitValue(value);
  return /\s/.test(String(value)) ? `"${escaped}"` : escaped;
}

// Resolve the ompweb binary the unit will run. An explicit override wins,
// followed by the sibling of node (npm/bun global installs), then PATH.
function resolveOmpwebBin(env = process.env) {
  const override = env.OMP_WEB_SYSTEMD_BIN;
  if (override) {
    if (!isExecutableFile(override)) throw new Error(`OMP_WEB_SYSTEMD_BIN=${override} is not executable`);
    return override;
  }

  const sibling = path.join(path.dirname(process.execPath), "ompweb");
  if (isExecutableFile(sibling)) return sibling;

  const onPath = which("ompweb", env);
  if (onPath) return onPath;
  throw new Error("ompweb binary not found (next to node or on PATH); set OMP_WEB_SYSTEMD_BIN");
}
function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return String(port);
}

function validateHostname(value) {
  const hostname = String(value ?? "").trim();
  if (!hostname) throw new Error("hostname must not be empty");
  return hostname;
}

// Build the unit file text. Runtime settings belong in EnvironmentFile so the
// tray or an editor can change them without reinstalling the unit.
function buildUnit({ ompwebBin, env: extraEnv = {}, home = HOME, envPath = getServiceEnvPath(home) }) {
  const ompBin = extraEnv.OMP_WEB_OMP_BIN ?? null;
  const interpreterDir = ompBin ? launcherInterpreterDir(ompBin) : null;
  const pathDirs = [
    ...(ompBin ? [path.dirname(ompBin)] : []),
    // Launcher scripts (e.g. Bun/npm global installs of omp) run through an
    // interpreter resolved via `env`; without its directory the service
    // fails with exit 127 even though the binary itself is on PATH (#116).
    ...(interpreterDir ? [interpreterDir] : []),
    path.dirname(ompwebBin),
    path.dirname(process.execPath),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((dir, index, all) => all.indexOf(dir) === index);

  return `# Generated by ompweb-systemd — edits are overwritten on reinstall.
[Unit]
Description=ompweb web service (oh-my-pi web UI)
Documentation=https://github.com/kahme247/ompweb#readme
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=${formatExecStart(ompwebBin)}
Environment=${environmentLine([["PATH", pathDirs.join(path.delimiter)]])}
EnvironmentFile=${escapeUnitPath(envPath)}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

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

function systemdQuery(args) {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.error) fail(`systemctl not runnable: ${result.error.message}`);
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

function install(options = {}) {
  let ompwebBin;
  try {
    ompwebBin = resolveOmpwebBin();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const ompBin = process.env.OMP_WEB_OMP_BIN ?? which("omp");
  if (process.env.OMP_WEB_OMP_BIN && !isExecutableFile(process.env.OMP_WEB_OMP_BIN)) {
    fail(`OMP_WEB_OMP_BIN=${process.env.OMP_WEB_OMP_BIN} is not executable`);
  } else if (!ompBin) {
    console.warn("warning: omp binary not found; live-agent features will be unavailable (set OMP_WEB_OMP_BIN)");
  }
  // Note: the missing-interpreter check lives in runCli (before the Linux
  // gate) so it fails loudly on every platform; install() only reuses the
  // resolved ompBin for the unit + env file.

  let port;
  let hostname;
  try {
    port = validatePort(options.port ?? process.env.PORT ?? DEFAULT_PORT);
    hostname = validateHostname(options.hostname ?? process.env.OMP_WEB_HOSTNAME ?? DEFAULT_HOSTNAME);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const password = process.env.OMP_WEB_PASSWORD;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, HOME);
  const envPath = getServiceEnvPath();
  const unit = buildUnit({
    ompwebBin,
    env: ompBin ? { OMP_WEB_OMP_BIN: ompBin } : {},
    home: HOME,
    envPath,
  });

  // This is intentionally created during install. It is the source of truth
  // read by systemd on every start/restart, and is safe to edit by hand.
  writeServiceEnv({
    PORT: port,
    OMP_WEB_HOSTNAME: hostname,
    OMP_WEB_NO_OPEN: process.env.OMP_WEB_NO_OPEN ?? "1",
    ...(password ? { OMP_WEB_PASSWORD: password } : {}),
    ...(ompBin ? { OMP_WEB_OMP_BIN: ompBin } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  }, envPath);

  const wasActive = systemdQuery(["is-active", "--quiet", UNIT]).ok;
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  fs.writeFileSync(UNIT_PATH, unit, { mode: 0o600 });
  fs.chmodSync(UNIT_PATH, 0o600);

  systemctl(["daemon-reload"]);
  if (options.autostart !== false) systemctl(["enable", "--now", UNIT]);
  else systemctl(["start", UNIT], { ignoreFailure: true });
  if (wasActive) systemctl(["restart", UNIT]);

  console.log(`installed: ${UNIT_PATH}`);
  console.log(`binary:    ${ompwebBin}`);
  console.log(`config:    ${envPath} (port/hostname/password — no reinstall needed)`);
  console.log(`url:       http://${hostname}:${port}`);
  console.log(`logs:      journalctl --user -u ${UNIT_NAME} -f`);
  if (options.autostart === false) console.log("note:      service is not enabled at login (--no-autostart)");
  if (password) console.log("note:      password is stored in the env file (mode 600)");
  console.log("note:      for headless servers, run: loginctl enable-linger $USER");
}

function uninstall(options = {}) {
  systemctl(["disable", "--now", UNIT], { ignoreFailure: true });
  fs.rmSync(UNIT_PATH, { force: true });
  systemctl(["daemon-reload"], { ignoreFailure: true });
  if (options.cleanConfig) {
    const legacyConfig = path.join(HOME, ".omp", "agent", "web-service.json");
    fs.rmSync(legacyConfig, { force: true });
    console.log(`removed:   ${legacyConfig}`);
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
  const configuredPort = Number.parseInt(envConfig.PORT ?? process.env.PORT ?? DEFAULT_PORT, 10);
  const port = Number.isInteger(configuredPort) ? configuredPort : Number(DEFAULT_PORT);
  const hostname = envConfig.OMP_WEB_HOSTNAME ?? process.env.OMP_WEB_HOSTNAME ?? DEFAULT_HOSTNAME;
  return {
    isLinux: process.platform === "linux",
    unit: UNIT,
    unitPath: UNIT_PATH,
    envFile: ENV_PATH,
    isInstalled: fs.existsSync(UNIT_PATH),
    isActive: active.ok && active.stdout === "active",
    isEnabled: enabled.ok,
    pid: Number.parseInt(pid.stdout, 10) || null,
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
  console.log(`=== ompweb systemd service status (${process.platform}) ===`);
  console.log(`  Unit          : ${status.unit} (${status.isInstalled ? status.unitPath : "not installed"})`);
  console.log(`  Version       : v${readPackageVersion()}`);
  console.log(`  Active        : ${status.isActive ? `Yes (pid ${status.pid})` : "No"}`);
  console.log(`  Start at login: ${status.isEnabled ? "Enabled" : "Disabled"}`);
  console.log(`  Live URL      : ${status.serviceUrl}`);
  console.log(`  Config        : ${status.envFile}`);
  console.log(`  Logs          : ${status.logCommand}`);
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
      port: { type: "string", short: "p" },
      hostname: { type: "string", short: "H" },
      "no-autostart": { type: "boolean" },
      "clean-config": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
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

  // Validate the install inputs before the platform gate so misconfigured
  // launchers fail loudly on any platform (and stay testable on Windows).
  // Missing `omp` only warns (live-agent features retry on demand), but a
  // launcher script whose interpreter is nowhere on PATH would install a
  // unit that can only fail later with exit 127 (issue #116) — fail now.
  if (command === "install") {
    const ompBin = process.env.OMP_WEB_OMP_BIN ?? which("omp");
    if (process.env.OMP_WEB_OMP_BIN && !isExecutableFile(process.env.OMP_WEB_OMP_BIN)) {
      fail(`OMP_WEB_OMP_BIN=${process.env.OMP_WEB_OMP_BIN} is not executable`);
    } else if (ompBin && readLauncherInterpreter(ompBin) && !launcherInterpreterDir(ompBin)) {
      fail(
        `omp at ${ompBin} is a launcher script whose interpreter ` +
        `(${readLauncherInterpreter(ompBin)}) was not found on PATH; ` +
        `install that runtime (or point OMP_WEB_OMP_BIN at a standalone binary) and reinstall`,
      );
    }
  }

  if (process.platform !== "linux") {
    fail("systemd services are Linux-only (use ompweb-launchd on macOS or ompweb --install-tray on Windows)");
  }

  const installOptions = {
    port: cliArgs.port,
    hostname: cliArgs.hostname,
    autostart: !cliArgs["no-autostart"],
  };

  switch (command) {
    case "install":
      install(installOptions);
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
  runCli()
    .then(({ exitCode }) => {
      if (exitCode !== undefined && exitCode !== 0) process.exit(exitCode);
    })
    .catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  ENV_PATH,
  UNIT,
  UNIT_PATH,
  buildUnit,
  escapeUnitPath,
  escapeUnitValue,
  formatExecStart,
  launcherInterpreterDir,
  readLauncherInterpreter,
  readStatus,
  resolveOmpwebBin,
  runCli,
  validateHostname,
  validatePort,
};
