import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const readOrEmpty = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// Runs instrumentation.node.ts's register() in a child, then `then`. Returns
// the exit status plus the journals under the agent dir and under ~/.omp (the
// default, un-isolated location).
function runAfterRegister(then, { agentDir = "agent" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "omp-web-crash-policy-"));
  try {
    const script = `
      const { register } = await import(${JSON.stringify(join(root, "instrumentation.node.ts"))});
      await register();
      ${then}
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, agentDir),
        OMP_WEB_OMP_BIN: join(home, "missing-omp"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      journal: readOrEmpty(join(home, agentDir, "omp-web", "diagnostics.log")),
      homeJournal: readOrEmpty(join(home, ".omp", "omp-web", "diagnostics.log")),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Throws `error` uncaught after register(); status 0 = kept serving.
const throwAfterRegister = (errorExpr, options) => runAfterRegister(`
  setTimeout(() => { throw ${errorExpr}; }, 0);
  setTimeout(() => process.exit(0), 300);
`, options);

// Windows has no signals: process.kill(pid, "SIGINT") terminates the process outright (status 1), so no handler runs.
test("SIGINT and SIGTERM end the server even though modules listen for them", { skip: process.platform === "win32" && "Windows kills on SIGINT/SIGTERM without running handlers" }, () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    // The first listener stands in for a module's cleanup (lib/rpc-manager.ts),
    // which on its own cancels the default exit.
    const { status, stderr } = runAfterRegister(`
      process.once("${signal}", () => {});
      process.kill(process.pid, "${signal}");
      setTimeout(() => process.exit(0), 2000);
    `);
    assert.equal(status, code, `${signal}\n${stderr}`);
  }
});

test("a client disconnect surfacing as uncaught `aborted` is journaled without exiting", () => {
  const { status, journal, stderr } = throwAfterRegister(`Object.assign(new Error("aborted"), { code: "ECONNRESET" })`);
  assert.equal(status, 0, stderr);
  assert.match(journal, /\[client-abort\] uncaughtException Error: aborted/);
  assert.doesNotMatch(journal, /\[crash\]/);
});

test("the journal follows an isolated agent dir and keeps ~/.omp/omp-web by default", () => {
  const isolated = throwAfterRegister(`new Error("boom")`);
  assert.match(isolated.journal, /\[crash\] uncaughtException Error: boom/);
  assert.equal(isolated.homeJournal, "", "an isolated run must not write the real journal");

  const byDefault = throwAfterRegister(`new Error("boom")`, { agentDir: join(".omp", "agent") });
  assert.match(byDefault.homeJournal, /\[crash\] uncaughtException Error: boom/);
});

test("any other uncaught exception still exits with code 2", () => {
  for (const errorExpr of [
    `new Error("boom")`,
    `Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })`,
    `Object.assign(new Error("aborted by peer"), { code: "ECONNRESET" })`,
    `Object.assign(new Error("aborted"), { code: "ERR_OTHER" })`,
    `null`,
    `undefined`,
  ]) {
    const { status, journal, stderr } = throwAfterRegister(errorExpr);
    assert.equal(status, 2, `${errorExpr}\n${stderr}`);
    assert.match(journal, /\[crash\] uncaughtException/, errorExpr);
  }
});
