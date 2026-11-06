import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

test("hot reload of a shared worker dependency keeps the dev server listening", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omp-web-hot-"));
  const source = path.join(home, "source");
  for (const name of ["server", "app", "lib", "components", "hooks", "public", "scripts", "bin", "tsconfig.json", "bunfig.toml", "package.json", "instrumentation.node.ts", "proxy.ts"]) {
    cpSync(path.join(repo, name), path.join(source, name), { recursive: true });
  }
  symlinkSync(path.join(repo, "node_modules"), path.join(source, "node_modules"), "dir");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OMP_WEB_")));
  const parent = Bun.spawn([process.execPath, "--hot", "server/dev.ts", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: source,
    detached: true,
    env: { ...env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"), OMP_WEB_OMP_BIN: "/nonexistent/omp", OMP_WEB_DISABLE_AUTOUPDATE: "1" },
    stdout: "pipe",
    stderr: "inherit",
  });
  t.after(async () => {
    try {
      process.kill(-parent.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await parent.exited;
    rmSync(home, { recursive: true, force: true });
  });
  const reader = parent.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const ready = async () => {
    const { promise: deadline, reject } = Promise.withResolvers<never>();
    // Bound real watcher I/O; fake timers cannot drive the child process.
    const timer = setTimeout(() => reject(new Error(`Dev server did not become ready:\n${output}`)), 10_000);
    try {
      while (!output.includes("Ready on")) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) assert.fail(output);
        output += decoder.decode(value);
      }
      output = "";
    } finally {
      clearTimeout(timer);
    }
  };
  await ready();
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(origin)).status, 200);
  appendFileSync(path.join(source, "lib", "hosts", "link-protocol.ts"), '\nconsole.info("hot-reload-worker-probe");\n');
  await ready();
  assert.equal((await fetch(origin)).status, 200);
  assert.match(await (await fetch(`${origin}/event-stream-worker.js`)).text(), /hot-reload-worker-probe/);
  assert.equal(parent.exitCode, null);
});
