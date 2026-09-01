import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("./omp-web-options.js");
const { runCli } = require("./omp-web-tray.js");

test("parseLaunchOptions parses --install-tray and --install-service flags", () => {
  const opts1 = parseLaunchOptions(["--install-tray"], {});
  assert.equal(opts1.installTray, true);
  assert.equal(opts1.uninstallTray, false);
  assert.equal(opts1.tray, false);

  const opts2 = parseLaunchOptions(["--install-service"], {});
  assert.equal(opts2.installTray, true);
  assert.equal(opts2.uninstallTray, false);
  assert.equal(opts2.tray, false);
});

test("parseLaunchOptions parses --uninstall-tray flag", () => {
  const opts = parseLaunchOptions(["--uninstall-tray"], {});
  assert.equal(opts.uninstallTray, true);
  assert.equal(opts.installTray, false);
  assert.equal(opts.tray, false);
});

test("parseLaunchOptions parses --tray flag", () => {
  const opts = parseLaunchOptions(["--tray"], {});
  assert.equal(opts.tray, true);
  assert.equal(opts.installTray, false);
  assert.equal(opts.uninstallTray, false);
});

test("runCli with --help returns exit code 0", async () => {
  const res = await runCli(["--help"]);
  assert.equal(res.exitCode, 0);
});

test("runCli with --version returns exit code 0", async () => {
  const res = await runCli(["--version"]);
  assert.equal(res.exitCode, 0);
});

test("runCli with --status returns status object", async () => {
  const res = await runCli(["--status"]);
  assert.equal(res.exitCode, 0);
  assert.ok(res.status);
  assert.equal(typeof res.status.port, "number");
  assert.equal(typeof res.status.isWindows, "boolean");
});
