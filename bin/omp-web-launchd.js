#!/usr/bin/env node
"use strict";

// Install ompweb as a macOS launchd user agent (starts at login, restarts on crash).
//
// Usage (installed as the `ompweb-launchd` bin, or run via npx / node directly):
//   ompweb-launchd [install [package-spec]|uninstall|status]
//   npx -p @kahme247/ompweb@latest ompweb-launchd install

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const LABEL = "com.kahme247.ompweb";
const HOME = os.homedir();
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(HOME, "Library", "Logs", "ompweb");
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
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

function xmlEscape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function launchctl(args, { ignoreFailure = false } = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.error) fail(`launchctl not runnable: ${result.error.message}`);
  if (result.status !== 0 && !ignoreFailure) {
    fail(`launchctl ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

function install(pkgArg) {
  const nodeBin = process.execPath;
  const siblingNpx = path.join(path.dirname(nodeBin), "npx");
  const npxBin = isExecutableFile(siblingNpx) ? siblingNpx : (which("npx") ?? fail("npx not found on PATH"));

  const ompBin = process.env.OMP_WEB_OMP_BIN ?? which("omp");
  if (process.env.OMP_WEB_OMP_BIN) {
    try {
      fs.accessSync(process.env.OMP_WEB_OMP_BIN, fs.constants.X_OK);
    } catch {
      fail(`OMP_WEB_OMP_BIN=${process.env.OMP_WEB_OMP_BIN} is not executable`);
    }
  } else if (!ompBin) {
    console.warn("warning: omp binary not found; live-agent features will be unavailable (set OMP_WEB_OMP_BIN)");
  }

  const pkg = pkgArg ?? process.env.OMP_WEB_PKG ?? "@kahme247/ompweb@latest";
  const port = process.env.PORT ?? "30177";
  const hostname = process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  const noOpen = process.env.OMP_WEB_NO_OPEN ?? "1";
  const password = process.env.OMP_WEB_PASSWORD;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, HOME);

  const asdfBin = which("asdf");
  const svcPath = [
    ...(ompBin ? [path.dirname(ompBin)] : []),
    ...(asdfBin ? [path.dirname(asdfBin)] : []),
    path.dirname(npxBin),
    path.dirname(nodeBin),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((dir, i, all) => all.indexOf(dir) === i).join(path.delimiter);

  const env = {
    PATH: svcPath,
    PORT: port,
    OMP_WEB_HOSTNAME: hostname,
    OMP_WEB_NO_OPEN: noOpen,
    ...(password ? { OMP_WEB_PASSWORD: password } : {}),
    ...(ompBin ? { OMP_WEB_OMP_BIN: ompBin } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(npxBin)}</string>
    <string>--yes</string>
    <string>${xmlEscape(pkg)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(LOG_DIR, "ompweb.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(LOG_DIR, "ompweb.err.log"))}</string>
</dict>
</plist>
`;

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist, { mode: 0o600 });
  fs.chmodSync(PLIST, 0o600);

  launchctl(["bootout", `${DOMAIN}/${LABEL}`], { ignoreFailure: true });
  launchctl(["bootstrap", DOMAIN, PLIST]);

  console.log(`installed: ${PLIST}`);
  console.log(`package:   ${pkg} (via npx --yes)`);
  console.log(`url:       http://${hostname}:${port}`);
  console.log(`logs:      ${path.join(LOG_DIR, "ompweb.log")}`);
  if (password) console.log("note:      password is stored in plain text in the plist (mode 600)");
}

function uninstall() {
  launchctl(["bootout", `${DOMAIN}/${LABEL}`], { ignoreFailure: true });
  fs.rmSync(PLIST, { force: true });
  console.log(`uninstalled: ${LABEL}`);
}

function status() {
  const result = spawnSync("launchctl", ["print", `${DOMAIN}/${LABEL}`], { encoding: "utf8" });
  if (result.status === 0) {
    const lines = (result.stdout ?? "").split("\n").filter((line) => /\b(state|pid|last exit)\b/.test(line));
    console.log(lines.join("\n") || (result.stdout ?? "").trim());
    return;
  }
  console.log(`not loaded: ${LABEL}`);
  process.exit(1);
}

if (process.platform !== "darwin") fail("launchd services are macOS-only");

const command = process.argv[2] ?? "install";
if (command === "install") install(process.argv[3]);
else if (command === "uninstall") uninstall();
else if (command === "status") status();
else {
  console.error("usage: ompweb-launchd [install [package-spec]|uninstall|status]");
  process.exit(2);
}
