import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "ompweb-preflight-test-"));
const omp = join(base, "omp");
const saved = { ...process.env };
let runPreflight;

before(async () => {
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  // resolveOmpBin caches its hit: every test rewrites this one file.
  process.env.OMP_WEB_OMP_BIN = omp;
  ({ runPreflight } = await import("./preflight.ts"));
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(base, { recursive: true, force: true });
});

/** runPreflight's exit code and what it printed. */
async function preflight(script, timeoutMs) {
  writeFileSync(omp, script);
  chmodSync(omp, 0o755);
  const lines = { out: [], err: [] };
  const { log, error } = console;
  console.log = (line) => lines.out.push(line);
  console.error = (line) => lines.err.push(line);
  try { return { code: await runPreflight(timeoutMs), ...lines }; } finally { Object.assign(console, { log, error }); }
}

test("an omp that reads stdin and never says hello fails with the binary, the reason and its stderr", { skip: process.platform === "win32" && "a POSIX shell omp" }, async () => {
  // The incident: an omp without --headless sat reading the piped stdin.
  const result = await preflight("#!/bin/sh\necho 'unknown flag --headless' >&2\nexec cat >/dev/null\n", 1000);
  assert.equal(result.code, 1);
  assert.deepEqual(result.out, []);
  assert.equal(result.err.length, 1);
  assert.match(result.err[0], new RegExp(`^preflight failed: ${omp}: no hello within 1 s: unknown flag --headless$`));
});

test("an omp that exits names its exit code", { skip: process.platform === "win32" && "a POSIX shell omp" }, async () => {
  const result = await preflight("#!/bin/sh\nexit 3\n", 5000);
  assert.equal(result.code, 1);
  assert.match(result.err[0], new RegExp(`^preflight failed: ${omp}: exited with code 3$`));
});

test("a session omp that says hello passes with its version", { skip: process.platform === "win32" && "a POSIX shell omp" }, async () => {
  const result = await preflight(`#!/bin/sh\nif [ "$1" = "--version" ]; then echo 18.99.0; exit 0; fi\ncase "$*" in *"--headless --cwd "*"--no-session"*) echo '{"t":"hello","proto":1}'; exec cat >/dev/null;; esac\nexit 9\n`, 5000);
  assert.deepEqual(result, { code: 0, out: [`preflight ok: ${omp} 18.99.0`], err: [] });
});

test("an omp on another channel protocol fails: the daemon would refuse it", { skip: process.platform === "win32" && "a POSIX shell omp" }, async () => {
  const result = await preflight(`#!/bin/sh\necho '{"t":"hello","proto":2}'\nexec cat >/dev/null\n`, 5000);
  assert.equal(result.code, 1);
  assert.match(result.err[0], new RegExp(`^preflight failed: ${omp}: speaks channel protocol 2, not 1$`));
});

test("nothing omp started outlives the check", { skip: process.platform === "win32" && "a POSIX shell omp" }, async () => {
  const pidFile = join(base, "grandchild.pid");
  // A grandchild (LSP, extension) that ignores omp's stdin closing.
  const result = await preflight(`#!/bin/sh\nif [ "$1" = "--version" ]; then echo 18.99.0; exit 0; fi\nsleep 300 &\necho $! > "${pidFile}"\necho '{"t":"hello","proto":1}'\nexec cat >/dev/null\n`, 5000);
  assert.equal(result.code, 0, result.err.join("\n"));
  const pid = Number(readFileSync(pidFile, "utf8"));
  const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
  for (let i = 0; i < 50 && !gone(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(gone(), `grandchild ${pid} survived`);
});
