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
  const child = spawn("node", [bin, "host"], {
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
  const child = spawn("node", [bin, "host", "login", "--url", "http://127.0.0.1:9"], {
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

async function hostCommand(env, ...args) {
  const child = spawn("node", [bin, "host", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr })));
  const result = await Promise.race([closed, sleep(15_000, null, { ref: false })]);
  if (!result) child.kill("SIGKILL");
  assert.ok(result, `host ${args.join(" ")} did not exit: ${stderr}`);
  return result;
}

function controlFixture(t, { url, longRoot = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "omp-web-host-control-cli-"));
  const agentDir = join(scratch, ...(longRoot ? ["long-agent-directory-".repeat(10), "agent"] : ["agent"]));
  const omp = join(scratch, "fixture-omp");
  writeFileSync(omp, `#!${process.execPath}\nconsole.log("18.0.0-cli-fixture");\n`, { mode: 0o700 });
  const env = {
    ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"),
    XDG_STATE_HOME: join(scratch, "state"), XDG_CACHE_HOME: join(scratch, "cache"),
    OMP_WEB_OMP_BIN: omp, OMP_WEB_DISABLE_AUTOUPDATE: "1",
  };
  mkdirSync(join(agentDir, "omp-web"), { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "omp-web", "host.json"), JSON.stringify({ url: url ?? "http://127.0.0.1:9", token: "private-cli-fixture-token" }), { mode: 0o600 });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  return { scratch, agentDir, env };
}

function launchHost(t, env) {
  const child = spawn("node", [bin, "host"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  t.after(async () => {
    child.kill("SIGTERM");
    const result = await Promise.race([closed, sleep(5000, "timeout", { ref: false })]);
    if (result === "timeout") child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  });
  return { child, closed, log: () => stderr };
}

async function controlReady(env) {
  const deadline = Date.now() + 15_000;
  let answer;
  do {
    answer = await hostCommand(env, "status");
    if (answer.code === 0) return JSON.parse(answer.stdout);
    await sleep(20);
  } while (Date.now() < deadline);
  assert.fail(`the real CLI endpoint did not become ready: ${answer.stderr}`);
}

const unixControl = { skip: process.platform === "win32" && "Unix worker control; Windows ordinary host tests above remain unchanged" };

test("status/drain/resume consume the real CLI daemon endpoint and SIGTERM removes it", unixControl, async (t) => {
  let hellos = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, bun) { return bun.upgrade(req) ? undefined : new Response("Upgrade required", { status: 426 }); },
    websocket: {
      message(ws, data) {
        for (const line of String(data).split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.type === "hello") {
            hellos += 1;
            ws.send(JSON.stringify({ type: "welcome", v: 9, hostId: "cli-fixture" }));
          } else if (typeof frame.seq === "number") ws.send(JSON.stringify({ type: "ack", ack: frame.seq }));
        }
      },
    },
  });
  t.after(() => server.stop(true));
  const f = controlFixture(t, { url: `http://127.0.0.1:${server.port}`, longRoot: true });
  const daemon = launchHost(t, f.env);
  const { hostControlPath } = await import("../lib/hosts/host-control.ts");
  t.after(() => rmSync(join(hostControlPath(f.agentDir), ".."), { recursive: true, force: true }));
  let status = await controlReady(f.env);
  const deadline = Date.now() + 10_000;
  while (!status.linked) {
    assert.ok(Date.now() < deadline, `daemon never welcomed: ${daemon.log()}`);
    await sleep(20);
    status = JSON.parse((await hostCommand(f.env, "status")).stdout);
  }
  assert.equal(status.pid, daemon.child.pid, "the launcher must not leave a wrapper PID");
  assert.equal(status.protocol, 9);
  assert.equal(status.drained, false);
  assert.equal(hellos, 1);
  assert.equal(JSON.stringify(status).includes("private-cli-fixture-token"), false);
  for (const [command, drained] of [["drain", true], ["status", true], ["resume", false]]) {
    const answer = await hostCommand(f.env, command);
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(JSON.parse(answer.stdout).drained, drained);
    assert.equal(JSON.parse(answer.stdout).pid, daemon.child.pid);
  }
  const duplicate = await hostCommand(f.env);
  assert.equal(duplicate.code, 1, duplicate.stderr);
  assert.match(duplicate.stderr, /already|running|occupied|in use/i);
  assert.equal(hellos, 1, "endpoint acquisition precedes dialing, so a duplicate cannot replace the original link");
  assert.equal(JSON.parse((await hostCommand(f.env, "status")).stdout).pid, daemon.child.pid);
  daemon.child.kill("SIGTERM");
  assert.equal(await daemon.closed, 0);
  assert.equal(existsSync(hostControlPath(f.agentDir)), false);
  assert.equal((await hostCommand(f.env, "status")).code, 1, "status must not start a replacement daemon");
});

test("CLI startup failure cleans its endpoint without dialing or needing credentials", unixControl, async (t) => {
  const f = controlFixture(t, { url: "http://not-loopback.invalid" });
  const { hostControlPath } = await import("../lib/hosts/host-control.ts");
  t.after(() => rmSync(join(hostControlPath(f.agentDir), ".."), { recursive: true, force: true }));
  const result = await hostCommand(f.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /https/i);
  assert.equal(existsSync(hostControlPath(f.agentDir)), false);
});

test("Windows: status/drain/resume reach the real daemon over its pipe; a duplicate is refused and a crash leaves no live control", { skip: process.platform !== "win32" && "Windows named-pipe CLI control" }, async (t) => {
  const f = controlFixture(t);
  const daemon = launchHost(t, f.env);
  let status = await controlReady(f.env);
  assert.equal(status.pid, daemon.child.pid);
  assert.equal(status.drained, false);
  for (const [command, drained] of [["drain", true], ["status", true], ["resume", false]]) {
    const answer = await hostCommand(f.env, command);
    assert.equal(answer.code, 0, answer.stderr);
    assert.equal(JSON.parse(answer.stdout).drained, drained);
  }
  const duplicate = await hostCommand(f.env);
  assert.equal(duplicate.code, 1, duplicate.stderr);
  assert.match(duplicate.stderr, /already running/);
  // Windows terminates without running handlers: the descriptor stays, but nothing answers on its pipe.
  daemon.child.kill();
  await daemon.closed;
  assert.equal((await hostCommand(f.env, "status")).code, 1, "status must not start a replacement daemon");
  const restarted = launchHost(t, f.env);
  status = await controlReady(f.env);
  assert.equal(status.pid, restarted.child.pid, "a stale descriptor is replaced by the next daemon");
});

test("worker maintenance startup is drained before linking and can be explicitly resumed", async (t) => {
  const f = controlFixture(t);
  const daemon = launchHost(t, { ...f.env, OMP_WEB_HOST_DRAINED: "1" });
  if (process.platform !== "win32") {
    const { hostControlPath } = await import("../lib/hosts/host-control.ts");
    t.after(() => rmSync(join(hostControlPath(f.agentDir), ".."), { recursive: true, force: true }));
  }
  const status = await controlReady(f.env);
  assert.equal(status.pid, daemon.child.pid);
  assert.equal(status.drained, true);
  const resumed = await hostCommand(f.env, "resume");
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).drained, false);
});

test("`ompweb host login --add` and logout change only the selected URL without argv tokens", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "omp-web-host-multi-login-"));
  const agentDir = join(scratch, "agent");
  const file = join(agentDir, "omp-web", "host.json");
  mkdirSync(join(agentDir, "omp-web"), { recursive: true });
  const primary = { url: "https://production.example", token: "production-secret" };
  const staging = { url: "http://127.0.0.1:40000", token: "staging-secret" };
  writeFileSync(file, JSON.stringify(primary));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const run = async (args, input = "") => {
    assert.ok(!args.includes(staging.token));
    const child = spawn("node", [bin, "host", ...args], {
      env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    let log = "";
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end(input);
    const code = await Promise.race([closed, sleep(10_000, "timeout", { ref: false })]);
    assert.equal(code, 0, log);
    assert.ok(!log.includes(staging.token));
    assert.ok(!log.includes(primary.token));
  };
  await run(["login", "--add", "--url", staging.url], `${staging.token}\n`);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...primary, links: [primary, staging] });
  await run(["logout", "--url", `${staging.url}/`]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...primary, links: [primary] });
  await run(["logout", "--url", primary.url]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...primary, links: [] });
});
