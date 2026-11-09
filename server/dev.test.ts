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

// `npm run dev:lan` starts server/dev.ts with `-H 0.0.0.0`. Settings → Mobile
// app reads the bind from OMP_WEB_HOSTNAME, which startProduction writes for
// every production entry point; the dev entry point must write it too, or the
// card reports an unknown bind and offers no address at all. The assertion goes
// through the real HTTP route, so it fails if either the env write or the
// route's read regresses.
test("dev.ts publishes its bind so the Mobile app card can list addresses", { timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omp-web-dev-bind-"));
  // The OMP_WEB_PUBLIC_* values are set here so dev.ts does not re-run itself
  // with them (`bunfig.toml` inlines them at startup): the test then owns the
  // one process it started and can stop it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OMP_WEB_")));
  const parent = Bun.spawn([process.execPath, "server/dev.ts", "-H", "0.0.0.0", "-p", "0"], {
    cwd: repo,
    env: {
      ...env,
      HOME: home,
      PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
      OMP_WEB_OMP_BIN: "/nonexistent/omp",
      OMP_WEB_DISABLE_AUTOUPDATE: "1",
      OMP_WEB_PUBLIC_APP_VERSION: "0.0.0-test",
      OMP_WEB_PUBLIC_COMMIT_HASH: "",
      OMP_WEB_PUBLIC_COMMIT_DATE: "",
      OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION: "test",
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  t.after(async () => {
    parent.kill("SIGKILL");
    await parent.exited;
    rmSync(home, { recursive: true, force: true });
  });

  // Read without cancelling: a closed pipe could kill the server on its next log line and fake a pass.
  const reader = parent.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!/\[omp-web\] Ready on (http:\/\/[^\s]+)/.test(output)) {
    const { done, value } = await reader.read();
    assert.equal(done, false, output);
    output += decoder.decode(value);
  }
  // The Ready line names the bound origin; a wildcard bind is reached over loopback.
  const ready = /\[omp-web\] Ready on (\S+)/.exec(output);
  assert.ok(ready, output);
  const port = Number(new URL(ready[1]).port);
  assert.ok(port > 0, output);

  // No password is configured in this temp home, so the gate lets the request through.
  const response = await fetch(`http://127.0.0.1:${port}/api/mobile-access`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.binding.hostname, "0.0.0.0", "dev.ts must publish the bind it was started with");
  assert.equal(body.binding.exposure, "network");
  assert.equal(body.binding.port, port, "the bound port, not the request URL's");
  // The point of the card: a phone needs an address, and a wildcard bind has them.
  assert.ok(body.addresses.length > 0, `a network bind must offer an address: ${JSON.stringify(body.addresses)}`);
});
