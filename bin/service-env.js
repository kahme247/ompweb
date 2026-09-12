"use strict";

// Shared systemd EnvironmentFile helpers for the ompweb Linux service.
//
// The service reads runtime configuration from
// ~/.omp/agent/web-service.env (KEY=value, shell-style quoting) so the tray
// and CLI can change port/hostname/password without regenerating the unit.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

function getServiceEnvPath(home = os.homedir()) {
  const ompDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, home);
  if (ompDir) return path.join(ompDir, "web-service.env");
  return path.join(home, ".omp", "agent", "web-service.env");
}

// Escape a value for a double-quoted assignment (systemd env-file quoting).
function escapeEnvValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function serializeServiceEnv(entries) {
  return (
    Object.entries(entries)
      .map(([key, value]) => `${key}="${escapeEnvValue(value)}"`)
      .join("\n") + "\n"
  );
}

// Parse KEY="value" lines; tolerates comments, blanks, and unquoted values.
function parseServiceEnv(text) {
  const entries = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    if (quoted) value = value.slice(1, -1);
    entries[key] = value.replace(/\\(["\\])/g, "$1");
  }
  return entries;
}

function readServiceEnv(envPath = getServiceEnvPath()) {
  try {
    return parseServiceEnv(fs.readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

// Atomic write (temp file + rename), user-readable only: holds the password.
function writeServiceEnv(entries, envPath = getServiceEnvPath()) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const temporary = `${envPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, serializeServiceEnv(entries), { mode: 0o600 });
  fs.renameSync(temporary, envPath);
  fs.chmodSync(envPath, 0o600);
  return envPath;
}

module.exports = {
  escapeEnvValue,
  getServiceEnvPath,
  parseServiceEnv,
  readServiceEnv,
  serializeServiceEnv,
  writeServiceEnv,
};
