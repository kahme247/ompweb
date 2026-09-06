import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  UNIT,
  UNIT_PATH,
  buildUnit,
  escapeUnitValue,
  resolveOmpwebBin,
  runCli,
} = require("./omp-web-systemd.js");

test("escapeUnitValue escapes backslashes, quotes, and percent specifiers", () => {
  assert.equal(escapeUnitValue("plain"), "plain");
  assert.equal(escapeUnitValue("back\\slash"), "back\\\\slash");
  assert.equal(escapeUnitValue('quo"te'), "quo\\\"te");
  assert.equal(escapeUnitValue("100%h"), "100%%h");
});

test("buildUnit renders ExecStart, EnvironmentFile, and install target", () => {
  const unit = buildUnit({
    ompwebBin: "/usr/local/bin/ompweb",
    env: {
      OMP_WEB_OMP_BIN: "/home/u/.bun/bin/omp",
    },
    home: "/home/u",
  });

  assert.match(unit, /ExecStart=\/usr\/local\/bin\/ompweb\n/);
  assert.match(unit, /WorkingDirectory=%h/);
  // Runtime config lives in the env file so edits don't need a reinstall.
  assert.match(unit, /EnvironmentFile=.*web-service\.env/);
  assert.ok(!unit.includes("PORT="));
  assert.ok(!unit.includes("OMP_WEB_PASSWORD"));
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
  // PATH prefers the omp and ompweb directories, then node and standard bins.
  assert.match(unit, /"PATH=\/home\/u\/.bun\/bin:\/usr\/local\/bin:.*\/usr\/bin:\/bin"/);
  // Only one Environment line with quoted pairs.
  const envLines = unit.split("\n").filter((line) => line.startsWith("Environment="));
  assert.equal(envLines.length, 1);
});

test("buildUnit dedupes PATH dirs without omp", () => {
  const unit = buildUnit({
    ompwebBin: "/usr/bin/ompweb",
    env: {},
    home: "/home/u",
  });
  assert.ok(!unit.includes("OMP_WEB_OMP_BIN"));
  assert.match(unit, /"PATH=\/usr\/bin:.*\/home\/u\/\.local\/bin:/);
});

test("resolveOmpwebBin honors OMP_WEB_SYSTEMD_BIN override", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ompweb-systemd-"));
  try {
    const fake = path.join(dir, "ompweb");
    writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(resolveOmpwebBin({ OMP_WEB_SYSTEMD_BIN: fake }), fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOmpwebBin rejects a non-executable override", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ompweb-systemd-"));
  try {
    const plain = path.join(dir, "ompweb");
    writeFileSync(plain, "not executable\n", { mode: 0o644 });
    assert.throws(() => resolveOmpwebBin({ OMP_WEB_SYSTEMD_BIN: plain }), /not executable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli with help returns exit code 0 and unit constants are stable", async () => {
  const res = await runCli(["--help"]);
  assert.equal(res.exitCode, 0);
  assert.equal(UNIT, "ompweb.service");
  assert.ok(UNIT_PATH.endsWith(path.join(".config", "systemd", "user", "ompweb.service")));
});

test("runCli rejects unknown commands with exit code 2", async () => {
  const res = await runCli(["bogus-command"]);
  assert.equal(res.exitCode, 2);
});
