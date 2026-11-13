import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WORKER = fileURLToPath(new URL("./omp-web-update-worker.js", import.meta.url));
const ATTEMPT = "11111111-2222-3333-4444-555555555555";
const REPO = dirname(dirname(WORKER));
const PLATFORM = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
// A session omp that says hello as the runner does.
const RUNNER = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 18.99.0; exit 0; fi\necho '{"t":"hello","proto":1}'\nexec cat >/dev/null\n`;

/** The new release as npm installs it. "old": no preflight command, no runner; "old-runner": no preflight command but
 * a runner dependency; "ok": this checkout's real preflight with a runner dependency that says hello; "no-runner": the
 * same without the runner installed. */
function writeCandidate(dir, candidate) {
  mkdirSync(dir);
  if (candidate === "old") return;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: "0.6.0", optionalDependencies: { [`@kahme247/ompweb-omp-${PLATFORM}`]: "0.6.0" } }));
  if (candidate === "old-runner") return;
  symlinkSync(join(REPO, "bin"), join(dir, "bin"));
  symlinkSync(join(REPO, "lib"), join(dir, "lib"));
  if (candidate === "no-runner") return;
  const runner = join(dir, "node_modules", "@kahme247", `ompweb-omp-${PLATFORM}`);
  mkdirSync(runner, { recursive: true });
  writeFileSync(join(runner, "package.json"), "{}");
  writeFileSync(join(runner, "ompweb-omp"), RUNNER, { mode: 0o755 });
}

// Runs the worker for a systemd unit with stub `systemctl` and `npm` on PATH, under the launcher's OMP_WEB_PACKAGE_DIR:
// the running install, whose own runner says hello. `candidate`: see writeCandidate.
function runWorker(t, { npmExit = 0, startExit = 0, activeExit = 0, candidate = "old" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "update-worker-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n[ "$2" = start ] && exit ${startExit}\n[ "$2" = is-active ] && { echo failed; exit ${activeExit}; }\nexit 0\n`, { mode: 0o755 });
  const installed = join(dir, "running");
  mkdirSync(join(installed, "runner", "release"), { recursive: true });
  writeFileSync(join(installed, "runner", "release", `ompweb-omp-${PLATFORM}`), RUNNER, { mode: 0o755 });
  const template = join(dir, "candidate");
  writeCandidate(template, candidate);
  // The scratch install (`npm install --prefix <dir> …`) succeeds; the global one exits npmExit.
  writeFileSync(join(dir, "npm"), `#!/bin/sh\necho "npm $*" >> "${log}"\nif [ "$2" = --prefix ]; then mkdir -p "$3/node_modules/@kahme247" && ln -s "${template}" "$3/node_modules/@kahme247/ompweb"; exit 0; fi\nexit ${npmExit}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ attemptId: ATTEMPT, state: "running" }), { mode: 0o600 });
  writeFileSync(join(dir, `${ATTEMPT}.go`), "{}", { mode: 0o600 });
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, OMP_WEB_PACKAGE_DIR: installed, PI_CODING_AGENT_DIR: join(dir, "agent") };
  delete env.OMP_WEB_OMP_BIN;
  const result = spawnSync("node", [
    WORKER,
    "--attempt", ATTEMPT,
    "--root", dir,
    "--package-dir", installed,
    "--manager", "npm",
    "--manager-path", "npm",
    "--target", "0.6.0",
    "--systemd-unit", "ompweb.service",
    "--systemd-user", "1",
  ], { env, timeout: 60000 });
  assert.equal(result.status, 0, String(result.stderr));
  let complete = null;
  try { complete = JSON.parse(readFileSync(join(dir, `${ATTEMPT}.complete.json`), "utf8")); } catch {}
  return {
    calls: readFileSync(log, "utf8").trim().split("\n"),
    status: JSON.parse(readFileSync(join(dir, "status.json"), "utf8")),
    complete,
  };
}

test("a systemd update stops the unit, installs, starts it and checks it stayed up", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t);
  assert.match(calls[0], /^npm install --prefix \S+ --omit=dev --no-audit --no-fund @kahme247\/ompweb@0\.6\.0$/);
  assert.deepEqual(calls.slice(1), [
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

test("a candidate whose own omp says hello is installed", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { candidate: "ok" });
  assert.equal(calls[1], "systemctl --user stop ompweb.service");
  assert.equal(status.state, "succeeded");
});

test("a candidate missing its omp fails its preflight even though the running install has one, and never stops the running server", { skip: process.platform === "win32" }, (t) => {
  const { calls, status, complete } = runWorker(t, { candidate: "no-runner" });
  assert.ok(!calls.includes("systemctl --user stop ompweb.service"), calls.join("\n"));
  assert.ok(!calls.some((call) => call.startsWith("npm install -g")), calls.join("\n"));
  assert.equal(status.state, "failed");
  assert.equal(status.error, "the new release cannot start a session: preflight failed: ompweb-omp: not found");
  // What bin/omp-web.js watchUpdateCompletion accepts to disarm the launcher armed at commit.
  assert.equal(complete?.protocol, 1);
  assert.equal(complete?.attemptId, ATTEMPT);
});

test("a candidate with an omp but no preflight command is refused before anything stops", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { candidate: "old-runner" });
  assert.ok(!calls.includes("systemctl --user stop ompweb.service"), calls.join("\n"));
  assert.equal(status.state, "failed");
  assert.equal(status.error, "the new release has no preflight command to check its omp with");
});
