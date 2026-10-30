import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { MIN_BUN_VERSION, resolveBunBinary } = require("./bun-runtime.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bun-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o755 });
}

test("resolves the package's own Bun", () => {
  const bun = resolveBunBinary(repoRoot);
  assert.ok(statSync(bun).isFile());
  const version = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
  assert.equal(version, require("../package.json").dependencies.bun);
});

test("falls back to the platform package when the postinstall did not run", (t) => {
  const dir = tempDir(t);
  const os = isWindows ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  const exe = isWindows ? "bun.exe" : "bun";
  writeFile(path.join(dir, "node_modules/bun/package.json"), '{"name":"bun","version":"1.4.4"}');
  writeFile(path.join(dir, "node_modules/bun/bin/bun.exe"), "x".repeat(450));
  const platformDir = path.join(dir, `node_modules/@oven/bun-${os}-${arch}`);
  writeFile(path.join(platformDir, "package.json"), `{"name":"@oven/bun-${os}-${arch}","version":"1.4.4"}`);
  writeFile(path.join(platformDir, "bin", exe), "binary");
  assert.equal(resolveBunBinary(dir, { PATH: "" }), path.join(platformDir, "bin", exe));
});

test("uses bun on PATH last and refuses an old one", { skip: isWindows }, (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, "path");
  writeFile(path.join(bin, "bun"), "#!/bin/sh\necho 1.3.0\n");
  assert.throws(() => resolveBunBinary(dir, { PATH: bin }), /1\.4\.4/);
  writeFile(path.join(bin, "bun"), `#!/bin/sh\necho ${MIN_BUN_VERSION}\n`);
  assert.equal(resolveBunBinary(dir, { PATH: bin }), "bun");
});

test("no Bun anywhere", (t) => {
  assert.throws(() => resolveBunBinary(tempDir(t), { PATH: "" }), /Bun runtime not found/);
});
