import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isNewerVersion, detectInstallMethod } = jiti("./npm-update.ts");

test("recognizes newer npm package versions", () => {
  assert.equal(isNewerVersion("0.2.1", "0.2.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.2.0", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.9", "0.2.0"), false);
});

test("only treats a stable build as newer than the matching prerelease", () => {
  assert.equal(isNewerVersion("0.2.0", "0.2.0-beta.1"), true);
  assert.equal(isNewerVersion("0.2.0-beta.2", "0.2.0"), false);
  assert.equal(isNewerVersion("0.4.0-beta.1", "0.3.6"), false);
  assert.equal(isNewerVersion("latest", "0.2.0"), false);
});

test("detectInstallMethod routes bun-global installs to bun", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\@kahme247\\ompweb"), "bun");
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\.bin\\omp-web.cmd"), "bun");
  // Mixed separators (Windows-style path on a POSIX host, e.g. CI) must classify identically.
  assert.equal(detectInstallMethod("C:/Users/khaled/node_modules/@kahme247/ompweb"), "bun");
});

test("detectInstallMethod falls back to npm for anything else", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\AppData\\Roaming\\npm\\node_modules\\@kahme247\\ompweb"), "npm");
  assert.equal(detectInstallMethod("C:\\Program Files\\nodejs\\node_modules\\@kahme247\\ompweb"), "npm");
  assert.equal(detectInstallMethod("D:\\OtherProjects\\omp-web"), "npm");
});
