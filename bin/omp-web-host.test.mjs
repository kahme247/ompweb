import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("./omp-web.js", import.meta.url));

// Windows has no signals: child.kill("SIGTERM") terminates the process outright, so the daemon's handler never runs.
test("SIGTERM to `ompweb host` stops the daemon itself, leaving no orphan", { skip: process.platform === "win32" && "Windows kills on SIGTERM without running handlers" }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "omp-web-host-cli-"));
  const agentDir = join(scratch, "agent");
  mkdirSync(join(agentDir, "omp-web"), { recursive: true });
  // Nothing listens on this loopback port: the daemon redials until it is stopped.
  writeFileSync(join(agentDir, "omp-web", "host.json"), JSON.stringify({ url: "http://127.0.0.1:9", token: "t" }), { mode: 0o600 });
  const child = spawn(process.execPath, [bin, "host"], {
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGKILL");
    // An orphan holding the pipes must not keep this test process alive.
    child.stdout.destroy();
    child.stderr.destroy();
    rmSync(scratch, { recursive: true, force: true });
  });
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  // `close` fires once every holder of the stdio pipes is gone, an orphaned daemon included.
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));

  const deadline = Date.now() + 15_000;
  while (!log.includes("redialing")) {
    assert.ok(Date.now() < deadline, `the daemon never dialed:\n${log}`);
    await sleep(20);
  }
  child.kill("SIGTERM");
  const stopped = await Promise.race([closed, sleep(10_000, null, { ref: false })]);
  assert.ok(stopped, `the daemon outlived SIGTERM:\n${log}`);
  assert.deepEqual(stopped, { code: 0, signal: null }, "the daemon's own stop handled the signal");
});

/** Run `ompweb host login` with `input` on stdin (left open unless `end`). */
async function login(t, input, { end = true } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "omp-web-host-login-"));
  const agentDir = join(scratch, "agent");
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const child = spawn(process.execPath, [bin, "host", "login", "--url", "http://127.0.0.1:9"], {
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  child.stdin.write(input);
  if (end) child.stdin.end();
  const code = await Promise.race([closed, sleep(10_000, "timeout", { ref: false })]);
  const file = join(agentDir, "omp-web", "host.json");
  return { code, stderr, saved: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
}

test("`ompweb host login` saves the first stdin line as the token", async (t) => {
  const { code, saved } = await login(t, " tok-123 \nignored\n");
  assert.equal(code, 0);
  assert.equal(saved?.token, "tok-123");
});

test("`ompweb host login` refuses a token line over 4096 bytes without waiting for more input", async (t) => {
  const { code, stderr, saved } = await login(t, "a".repeat(5000), { end: false });
  assert.equal(code, 1);
  assert.match(stderr, /4096 bytes/);
  assert.equal(saved, null);
});
