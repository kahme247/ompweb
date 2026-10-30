"use strict";

// getBuiltinModule: the lint config forbids require(), and bin/ files may not add eslint-disable comments.
const { spawnSync } = process.getBuiltinModule("node:child_process");
const { existsSync, statSync } = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");

const MIN_BUN_VERSION = "1.4.4";
// The postinstall replaces bin/bun.exe (a 450-byte placeholder) with the real ~100 MB binary.
const PLACEHOLDER_LIMIT = 1024 * 1024;
const REINSTALL = "npm install -g @kahme247/ompweb";

function isRealBinary(file) {
  try {
    const stats = statSync(file);
    return stats.isFile() && stats.size > PLACEHOLDER_LIMIT;
  } catch {
    return false;
  }
}

function versionAtLeast(version, minimum) {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < b.length; i += 1) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  }
  return true;
}

/** Absolute path of the Bun that runs the server, or "bun" when only PATH has one. */
function resolveBunBinary(packageDir, env = process.env) {
  let bunDir;
  try {
    bunDir = path.dirname(require.resolve("bun/package.json", { paths: [packageDir] }));
  } catch {
    bunDir = null;
  }

  if (bunDir) {
    const own = path.join(bunDir, "bin", "bun.exe");
    if (isRealBinary(own)) return own;

    const os = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "arm64" ? "aarch64" : "x64";
    const exe = os === "windows" ? "bun.exe" : "bun";
    for (const variant of ["", "-musl", "-baseline", "-musl-baseline"]) {
      try {
        const pkg = require.resolve(`@oven/bun-${os}-${arch}${variant}/package.json`, { paths: [bunDir] });
        const binary = path.join(path.dirname(pkg), "bin", exe);
        if (existsSync(binary)) return binary;
      } catch {
        // variant not installed
      }
    }
  }

  const probe = spawnSync("bun", ["--version"], { env, encoding: "utf8" });
  const onPath = probe.status === 0 ? probe.stdout.trim() : null;
  if (onPath && versionAtLeast(onPath, MIN_BUN_VERSION)) return "bun";

  const found = onPath ? ` (bun ${onPath} on PATH is older than ${MIN_BUN_VERSION})` : "";
  throw new Error(`Bun runtime not found${found}. Reinstall ompweb with: ${REINSTALL}`);
}

module.exports = { MIN_BUN_VERSION, resolveBunBinary };

// `node bin/bun-runtime.js <args…>` runs Bun with <args> (Windows dev fallback).
if (require.main === module) {
  try {
    const result = spawnSync(resolveBunBinary(path.join(__dirname, "..")), process.argv.slice(2), { stdio: "inherit" });
    process.exit(result.status ?? 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
