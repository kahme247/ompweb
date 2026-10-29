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

// Runs instrumentation.node.ts's register() in a child, then executes [body].
// Returns the exit status (0 = kept serving) plus the journals under the agent
// dir and under ~/.omp (the default, un-isolated location).
function runAfterRegister(body, { agentDir = "agent", keepAliveMs = 300 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "omp-web-crash-policy-"));
  try {
    const script = `
      const { createJiti } = await import("jiti");
      const jiti = createJiti(${JSON.stringify(join(root, "lib/"))}, { tsconfigPaths: true });
      const { register } = await jiti.import(${JSON.stringify(join(root, "instrumentation.node.ts"))});
      await register();
      ${body}
      setTimeout(() => process.exit(0), ${keepAliveMs});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
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

/** register(), then throw [errorExpr] uncaught. */
function throwAfterRegister(errorExpr, options = {}) {
  return runAfterRegister(`setTimeout(() => { throw ${errorExpr}; }, 0);`, options);
}

/** register(), then reject a promise nobody awaits (a fire-and-forget chain). */
function rejectAfterRegister(errorExpr, options = {}) {
  return runAfterRegister(`Promise.reject(${errorExpr});`, options);
}

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

test("any other uncaught exception still exits with code 2 and says so on stderr", () => {
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
    assert.match(stderr, /uncaught exception — exiting/, `${errorExpr} must be readable in the autostart log`);
  }
});

test("an unhandled rejection is journaled and logged, and the server keeps serving", () => {
  // A fire-and-forget chain (a background tick, an unawaited route helper)
  // rejects: nobody awaited it, so every request path is still intact and the
  // process must not die — the scheduled task does not restart a server that
  // exits on its own.
  for (const errorExpr of [`new Error("tick failed")`, `"plain string reason"`, `undefined`]) {
    const { status, journal, stderr } = rejectAfterRegister(errorExpr);
    assert.equal(status, 0, `${errorExpr} must not end the process\n${stderr}`);
    assert.match(journal, /\[rejection\] unhandledRejection/, errorExpr);
    assert.doesNotMatch(journal, /\[crash\]/, `${errorExpr} is not an uncaught exception`);
    assert.match(stderr, /unhandled rejection \(server keeps running\)/, `${errorExpr} must be readable in the autostart log`);
  }
});

test("repeated rejections are rate-limited in both sinks, with a count line for the suppressed ones", () => {
  // A tick that rejects once a second must neither bury the console nor rotate
  // real crash records out of the 1 MB journal (the size cap bounds the file,
  // not the write rate): ten records carry the full description per minute, the
  // rest arrive as one count line with the last reason when the window rolls.
  const body = `
    for (let i = 0; i < 14; i += 1) Promise.reject(new Error("tick " + i));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    Promise.reject(new Error("tick late"));
  `;
  const { status, journal, stderr } = runAfterRegister(body);
  assert.equal(status, 0, stderr);
  assert.equal(journal.match(/\[rejection\] unhandledRejection/g)?.length, 11, "ten records plus the first of the next window");
  assert.match(journal, /\[rejection\] 4 further unhandled rejection\(s\) in the last minute were not journaled individually/, "the suppressed ones are counted, not lost");
  assert.equal(stderr.match(/unhandled rejection \(server keeps running\)/g)?.length, 11, "the console copy uses the same cap");
  assert.match(stderr, /4 further unhandled rejection\(s\) in the last minute were not logged individually/, "the console says the same");
});
