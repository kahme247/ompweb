import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.join(import.meta.dir, "..");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a SIGHUP to the dev parent also stops the server it re-ran", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omp-web-dev-"));
  // Without OMP_WEB_PUBLIC_* in its environment, dev.ts runs itself once more with them set.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OMP_WEB_")));
  const parent = Bun.spawn([process.execPath, "server/dev.ts", "-H", "127.0.0.1", "-p", "0"], {
    cwd: repo,
    env: { ...env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"), OMP_WEB_OMP_BIN: "/nonexistent/omp", OMP_WEB_DISABLE_AUTOUPDATE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  });
  let child = 0;
  t.after(() => {
    parent.kill("SIGKILL");
    if (child && alive(child)) process.kill(child, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  // Read without cancelling: a closed pipe could kill the server on its next log line and fake a pass.
  const reader = parent.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("Ready on")) {
    const { done, value } = await reader.read();
    assert.equal(done, false, output);
    output += decoder.decode(value);
  }
  child = Number(spawnSync("pgrep", ["-P", String(parent.pid)], { encoding: "utf8" }).stdout.trim());
  assert.ok(child > 0, output);

  parent.kill("SIGHUP");
  // The parent waits for the server it re-ran, so once the parent is gone the server must be gone too.
  await parent.exited;
  assert.equal(alive(child), false, "the re-run dev server outlived its parent");
});
