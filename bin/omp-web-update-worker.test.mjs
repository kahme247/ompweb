import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WORKER = fileURLToPath(new URL("./omp-web-update-worker.js", import.meta.url));
const ATTEMPT = "11111111-2222-3333-4444-555555555555";

// Runs the worker for a systemd unit with stub `systemctl` and `npm` on PATH.
function runWorker(t, { npmExit = 0, startExit = 0, activeExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "update-worker-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n[ "$2" = start ] && exit ${startExit}\n[ "$2" = is-active ] && { echo failed; exit ${activeExit}; }\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, "npm"), `#!/bin/sh\necho "npm $*" >> "${log}"\nexit ${npmExit}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ attemptId: ATTEMPT, state: "running" }), { mode: 0o600 });
  writeFileSync(join(dir, `${ATTEMPT}.go`), "{}", { mode: 0o600 });
  const result = spawnSync("node", [
    WORKER,
    "--attempt", ATTEMPT,
    "--root", dir,
    "--package-dir", dir,
    "--manager", "npm",
    "--manager-path", "npm",
    "--target", "0.6.0",
    "--kind", "app",
    "--systemd-unit", "ompweb.service",
    "--systemd-user", "1",
  ], { env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` }, timeout: 20000 });
  assert.equal(result.status, 0, String(result.stderr));
  return {
    calls: readFileSync(log, "utf8").trim().split("\n"),
    status: JSON.parse(readFileSync(join(dir, "status.json"), "utf8")),
  };
}

test("a systemd update stops the unit, installs, starts it and checks it stayed up", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t);
  assert.deepEqual(calls, [
    "systemctl --user stop ompweb.service",
    "npm install -g @kahme247/ompweb@0.6.0",
    "systemctl --user start ompweb.service",
    "systemctl --user is-active ompweb.service",
  ]);
  assert.equal(status.state, "succeeded");
});

test("a failed install starts the unit again", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { npmExit: 1 });
  assert.equal(calls.at(-1), "systemctl --user start ompweb.service");
  assert.equal(status.state, "failed");
  assert.match(status.error, /package install failed/);
});

test("a unit that will not start again is reported as stopped", { skip: process.platform === "win32" }, (t) => {
  const { status } = runWorker(t, { startExit: 1 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /^ompweb\.service is still stopped: /);
});

test("a new release that does not stay up fails the update", { skip: process.platform === "win32" }, (t) => {
  const { status } = runWorker(t, { activeExit: 3 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /systemctl is-active ompweb\.service failed: failed/);
});
