import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Real processes throughout: a fake host (a script named like the real one, inside a scratch installation) is
// started, inspected, stopped and restarted by the production code, on whatever OS runs the suite.
const windows = process.platform === "win32";
const base = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-process-")));
const moduleUrl = new URL("./upgrade-process.ts", import.meta.url).href;
const tracked = new Set(); // every process a test started: killed when the file ends, whatever the outcome
let upgrade;

before(async () => { upgrade = await import("./upgrade-process.ts"); });
after(async () => {
  for (const pid of tracked) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  await sleep(300);
  // On Windows a process keeps its cwd and handles until it is gone: retry.
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (error) { if (tries === 50) throw error; await sleep(100); }
  }
});

/** The fake host: records its pid, environment and arguments, then idles. */
const HOST = `const fs = require("node:fs");
const [pidFile, ...rest] = process.argv.slice(2);
fs.appendFileSync(pidFile, process.pid + "\\n");
fs.writeFileSync(pidFile + ".launch", JSON.stringify({ env: process.env.UPGRADE_PROCESS_TEST ?? null, args: rest }));
setInterval(() => {}, 1000);
`;
function install(name) {
  const dir = join(base, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const host = join(dir, "bin", "omp-web-host.js");
  writeFileSync(host, HOST);
  return { dir, host, pidFile: join(dir, "pids") };
}
const pidsIn = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
async function waitFor(check, what, timeout = 30000, optional = false) {
  for (const stop = Date.now() + timeout; Date.now() < stop; await sleep(50)) {
    const value = await check();
    if (value) return value;
  }
  if (optional) return undefined;
  return assert.fail(`Timed out waiting for ${what}`);
}
const stateOf = (pid) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
/** Alive and not a zombie (a frozen loop never reaps the daemon it had killed). */
function running(pid) {
  if (windows) { try { process.kill(pid, 0); return true; } catch { return false; } }
  const state = stateOf(pid);
  return state !== "" && !state.startsWith("Z");
}
const killTree = (child) => (windows ? execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }) : process.kill(-child.pid, "SIGKILL"));
const scopeUnavailable = (message) => /systemd-run cannot create a scope/.test(String(message));

/** A host nothing supervises: started by a process that exits at once, as an update helper or a server leaves it. */
async function orphanHost(name, wrap = []) {
  const fixture = install(name);
  const spawner = join(fixture.dir, "spawner.mjs");
  writeFileSync(spawner, `import { spawn } from "node:child_process";\nconst [command, ...args] = process.argv.slice(2);\nspawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();\n`);
  execFileSync(process.execPath, [spawner, ...wrap, process.execPath, fixture.host, fixture.pidFile], { cwd: fixture.dir, windowsHide: true });
  const pid = await waitFor(() => pidsIn(fixture.pidFile).at(-1), "the host to start");
  tracked.add(pid);
  return { ...fixture, pid, launch: { command: process.execPath, args: [fixture.host, fixture.pidFile], cwd: fixture.dir } };
}
const inspect = (fixture, role = "host") => upgrade.inspectUpgradeProcess({ pid: fixture.pid, installDir: fixture.dir, role, launch: fixture.launch });

test("a launched helper survives the termination of its caller, with its environment and arguments intact", { timeout: 120_000 }, async (t) => {
  const { dir, host, pidFile } = install("survival");
  const args = [host, pidFile, "two words", 'a"quote', "trailing\\slash\\"];
  const caller = join(dir, "caller.mjs");
  writeFileSync(caller, `import { launchDetachedUpgrade } from ${JSON.stringify(moduleUrl)};
try { console.log("PID " + await launchDetachedUpgrade(${JSON.stringify({ command: process.execPath, args, cwd: dir, env: { ...process.env, UPGRADE_PROCESS_TEST: "kept" } })})); }
catch (error) { console.log("ERR " + error.message); }
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [caller], { cwd: dir, detached: !windows, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  tracked.add(child.pid);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const report = await waitFor(() => output.split("\n").find((line) => /^(PID|ERR) /.test(line)), "the caller's report");
  if (report.startsWith("ERR ")) {
    killTree(child);
    if (scopeUnavailable(report)) return t.skip(report);
    return assert.fail(report);
  }
  const helper = Number(report.slice(4));
  tracked.add(helper);
  await waitFor(() => existsSync(`${pidFile}.launch`), "the helper to run");
  assert.deepEqual(JSON.parse(readFileSync(`${pidFile}.launch`, "utf8")), { env: "kept", args: args.slice(2) });
  killTree(child); // the caller and everything below it
  await waitFor(() => !running(child.pid), "the caller to end");
  await sleep(1000);
  assert.ok(running(helper), "the helper outlived its caller");
});

test("a foreground process is inspected, stopped only by its identity, and restarted from the launch command", { timeout: 120_000 }, async (t) => {
  const fixture = await orphanHost("foreground");
  const { pid, launch } = fixture;
  const plan = await inspect(fixture);
  assert.equal(plan.supervisor.kind, "foreground");
  assert.equal(plan.pid, pid);
  assert.deepEqual(plan.current, { pid, identity: plan.identity });
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "the plan is plain JSON");

  // A recycled pid (same number, different start time) is never signalled.
  await assert.rejects(upgrade.stopUpgradeProcess({ ...plan, current: { pid, identity: `${plan.identity}-recycled` } }));
  assert.ok(running(pid));

  await upgrade.stopUpgradeProcess(plan);
  assert.ok(!running(pid), "the inspected process was stopped");
  await upgrade.stopUpgradeProcess(plan); // already stopped: nothing to do

  let restarted;
  try { restarted = await upgrade.restartUpgradeProcess(plan, launch); } catch (error) {
    if (scopeUnavailable(error.message)) return t.skip(error.message);
    throw error;
  }
  tracked.add(restarted);
  assert.ok(Number.isSafeInteger(restarted) && running(restarted));
  assert.equal(plan.current.pid, restarted);
  assert.notEqual(plan.current.identity, plan.identity);
  await assert.rejects(upgrade.restartUpgradeProcess(plan, launch), /still running/, "a running instance is never joined by a second one");

  // After a restart a stop acts on the new instance, not on the long-gone original.
  await upgrade.stopUpgradeProcess(plan);
  assert.ok(!running(restarted));
});

test("inspection refuses the wrong role, installation or process, and stop refuses a plan that is not this machine's", { timeout: 120_000 }, async () => {
  const fixture = await orphanHost("refusals");
  await assert.rejects(inspect(fixture, "server"), /is not the server process/);
  const other = join(base, "other-install");
  mkdirSync(other, { recursive: true });
  await assert.rejects(upgrade.inspectUpgradeProcess({ pid: fixture.pid, installDir: other, role: "host", launch: fixture.launch }), /does not run from/);
  await assert.rejects(upgrade.inspectUpgradeProcess({ pid: 999999999, installDir: fixture.dir, role: "host", launch: fixture.launch }), /not running/);
  const plan = await inspect(fixture);
  await assert.rejects(upgrade.stopUpgradeProcess({ ...plan, platform: "plan9" }), /Invalid upgrade process plan/);
  await assert.rejects(upgrade.stopUpgradeProcess({ ...plan, supervisor: { kind: "systemd", unit: "../evil", user: false, configHash: "x" } }), /Invalid upgrade process plan/);
  await assert.rejects(upgrade.stopUpgradeProcess({ ...plan, identity: `${plan.identity}-other` }), /Invalid upgrade process plan/);
  assert.ok(running(fixture.pid), "none of the refused plans touched the process");
});

test("a shell restart loop is frozen while its daemon is replaced, then resumed to start the daemon again", { skip: windows && "POSIX shell loops only; Windows supervisors are tasks and services", timeout: 120_000 }, async () => {
  const { dir, host, pidFile } = install("loop");
  const script = join(dir, "loop.sh");
  const text = `#!/bin/sh\nwhile :; do\n  "${process.execPath}" "${host}" "${pidFile}"\n  rc=$?\n  case $rc in 0 | 1) exit $rc ;; esac\n  sleep 1\ndone\n`;
  writeFileSync(script, text, { mode: 0o700 });
  const loop = spawn("/bin/sh", [script], { cwd: dir, detached: true, stdio: "ignore" });
  tracked.add(loop.pid);
  const daemon = await waitFor(() => pidsIn(pidFile).at(-1), "the loop's daemon");
  tracked.add(daemon);
  const launch = { command: process.execPath, args: [host, pidFile], cwd: dir };
  const plan = await upgrade.inspectUpgradeProcess({ pid: daemon, installDir: dir, role: "host", launch });
  assert.equal(plan.supervisor.kind, "restart-loop");
  assert.equal(plan.supervisor.pid, loop.pid);

  // An edited loop script voids the plan: nothing is frozen or killed.
  writeFileSync(script, `${text}# edited\n`);
  await assert.rejects(upgrade.stopUpgradeProcess(plan), /changed since it was inspected/);
  assert.ok(running(daemon));
  assert.doesNotMatch(stateOf(loop.pid), /^T/);
  writeFileSync(script, text);

  await upgrade.stopUpgradeProcess(plan);
  assert.ok(!running(daemon), "the daemon was ended");
  assert.match(stateOf(loop.pid), /^T/, "the loop is frozen, so it cannot start a daemon next to the replacement");
  await sleep(1500);
  assert.equal(pidsIn(pidFile).length, 1, "a frozen loop starts nothing");

  const restarted = await upgrade.restartUpgradeProcess(plan, launch);
  tracked.add(restarted);
  assert.ok(restarted !== daemon && running(restarted), "the resumed loop started the daemon again");
  assert.doesNotMatch(stateOf(loop.pid), /^T/);
  assert.equal(plan.current.pid, restarted);

  await upgrade.stopUpgradeProcess(plan); // acts on the new daemon
  assert.ok(!running(restarted));
  assert.match(stateOf(loop.pid), /^T/);
});

/** A manager that can run a scratch unit: root's system manager, or the user's (units go to the runtime directory, never to the user's config). */
function scratchManager() {
  if (process.platform !== "linux") return null;
  const user = process.getuid() !== 0;
  if (user && !process.env.XDG_RUNTIME_DIR) return null;
  try { execFileSync("systemctl", [...(user ? ["--user"] : []), "show", "--property=Version"], { stdio: "ignore", timeout: 10000 }); } catch { return null; }
  return { user, dir: user ? join(process.env.XDG_RUNTIME_DIR, "systemd", "user") : "/run/systemd/system", ctl: (...args) => execFileSync("systemctl", [...(user ? ["--user"] : []), ...args], { encoding: "utf8", timeout: 60000 }) };
}
const manager = scratchManager();

for (const wrapped of [false, true]) {
  test(`a ${wrapped ? "wrapped" : "direct"} systemd service is stopped and started as that unit, and only while its definition is unchanged`, { skip: !manager && "no systemd manager can run a scratch unit here", timeout: 120_000 }, async (t) => {
    const { dir, host, pidFile } = install(`systemd-${wrapped}`);
    const unit = `ompweb-upgrade-test-${randomUUID().slice(0, 8)}.service`;
    const unitFile = join(manager.dir, unit);
    const wrapper = join(dir, "wrapper.sh");
    // No exec: the wrapper stays the unit's main process with the daemon beneath it.
    writeFileSync(wrapper, `#!/bin/sh\n"${process.execPath}" "${host}" "${pidFile}"\nrc=$?\nexit $rc\n`, { mode: 0o755 });
    const definition = `[Unit]\nDescription=ompweb upgrade-process test\n[Service]\nExecStart=${wrapped ? `/bin/sh ${wrapper}` : `${process.execPath} ${host} ${pidFile}`}\n`;
    const active = () => { try { return manager.ctl("is-active", unit).trim(); } catch (error) { return String(error.stdout).trim(); } };
    mkdirSync(manager.dir, { recursive: true });
    writeFileSync(unitFile, definition);
    try {
      manager.ctl("daemon-reload");
      manager.ctl("start", unit);
      const daemon = await waitFor(() => pidsIn(pidFile).at(-1), "the service's daemon");
      tracked.add(daemon);
      const launch = { command: process.execPath, args: [host, pidFile], cwd: dir };
      let plan;
      try { plan = await upgrade.inspectUpgradeProcess({ pid: daemon, installDir: dir, role: "host", launch }); } catch (error) {
        // The runtime lives in a directory other users can write: refusing it is the point, so this machine cannot run the scenario.
        if (/only its owner can change/.test(error.message)) return t.skip(error.message);
        throw error;
      }
      assert.equal(plan.supervisor.kind, "systemd");
      assert.equal(plan.supervisor.unit, unit);
      assert.equal(plan.supervisor.user, manager.user);

      writeFileSync(unitFile, `${definition}Environment=EDITED=1\n`);
      await assert.rejects(upgrade.stopUpgradeProcess(plan), /changed since it was inspected/);
      assert.ok(running(daemon) && active() === "active", "an edited definition stops nothing");
      writeFileSync(unitFile, definition);

      await upgrade.stopUpgradeProcess(plan);
      assert.ok(!running(daemon));
      assert.notEqual(active(), "active");

      const restarted = await upgrade.restartUpgradeProcess(plan, launch);
      tracked.add(restarted);
      assert.ok(restarted !== daemon && running(restarted), "the unit started the daemon again");
      assert.equal(plan.current.pid, restarted);
      assert.equal(active(), "active");

      await upgrade.stopUpgradeProcess(plan); // acts on the new instance
      assert.ok(!running(restarted));
      assert.notEqual(active(), "active");
    } finally {
      try { manager.ctl("stop", unit); } catch { /* not running */ }
      rmSync(unitFile, { force: true });
      try { manager.ctl("daemon-reload"); } catch { /* manager gone */ }
    }
  });
}

test("a transient systemd service is refused before anything stops, because systemd forgets its definition once it stops", { skip: !manager && "no systemd manager can run a scratch unit here", timeout: 120_000 }, async () => {
  const { dir, host, pidFile } = install("systemd-transient");
  const unit = `ompweb-upgrade-test-${randomUUID().slice(0, 8)}.service`;
  const active = () => { try { return manager.ctl("is-active", unit).trim(); } catch (error) { return String(error.stdout).trim(); } };
  try {
    execFileSync("systemd-run", [...(manager.user ? ["--user"] : []), "--quiet", "--collect", "--no-ask-password", `--unit=${unit}`, process.execPath, host, pidFile], { timeout: 30000 });
    const daemon = await waitFor(() => pidsIn(pidFile).at(-1), "the transient service's daemon");
    tracked.add(daemon);
    const launch = { command: process.execPath, args: [host, pidFile], cwd: dir };
    await assert.rejects(upgrade.inspectUpgradeProcess({ pid: daemon, installDir: dir, role: "host", launch }), /is a transient service/);
    assert.ok(running(daemon) && active() === "active", "the refusal leaves the service running");
  } finally {
    try { manager.ctl("stop", unit); } catch { /* not running */ }
    try { manager.ctl("reset-failed", unit); } catch { /* nothing failed */ }
  }
});

test("a host in a transient scope, where an update helper leaves it, is still inspected and stopped", { skip: !manager && "no systemd manager can run a scratch unit here", timeout: 120_000 }, async (t) => {
  const scope = [...(manager.user ? ["--user"] : []), "--scope", "--quiet", "--collect", "--no-ask-password"];
  try { execFileSync("systemd-run", [...scope, "true"], { stdio: "ignore", timeout: 10000 }); } catch (error) { return t.skip(`systemd-run cannot create a scope here: ${error.message}`); }
  const fixture = await orphanHost("systemd-scope", ["systemd-run", ...scope]);
  const plan = await inspect(fixture);
  assert.equal(plan.supervisor.kind, "foreground");
  await upgrade.stopUpgradeProcess(plan);
  assert.ok(!running(fixture.pid), "the scoped host was stopped");
});

test("a scheduled task that loops the host is stopped and started as that task", { skip: !windows && "Windows scheduled tasks exist only on Windows", timeout: 240_000 }, async (t) => {
  const { dir, host, pidFile } = install("task");
  const script = join(dir, "supervisor.ps1");
  const name = `ompweb-upgrade-test-${randomUUID().slice(0, 8)}`;
  writeFileSync(script, `while ($true) {\n  & '${process.execPath}' '${host}' '${pidFile}'\n  if ($LASTEXITCODE -eq 0) { break }\n  Start-Sleep 1\n}\n`);
  const powershell = (command) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  try {
    powershell(`$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${script}"'; $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero); Register-ScheduledTask -TaskName '${name}' -Action $action -Settings $settings -Force | Out-Null; Start-ScheduledTask -TaskName '${name}'`);
    const daemon = await waitFor(() => pidsIn(pidFile).at(-1), "the task's host", 60000, true);
    if (!daemon) return t.skip("Task Scheduler did not run the task in this session");
    tracked.add(daemon);
    const launch = { command: process.execPath, args: [host, pidFile], cwd: dir };
    const plan = await upgrade.inspectUpgradeProcess({ pid: daemon, installDir: dir, role: "host", launch });
    assert.equal(plan.supervisor.kind, "windows-task");
    assert.equal(plan.supervisor.name, name);

    await upgrade.stopUpgradeProcess(plan);
    assert.ok(!running(daemon), "the host was ended with its task");
    assert.equal(powershell(`(Get-ScheduledTask -TaskName '${name}').State`).trim(), "Ready");

    const restarted = await upgrade.restartUpgradeProcess(plan, launch);
    assert.ok(restarted, "the host the task started again was found");
    tracked.add(restarted);
    assert.ok(running(restarted));
    assert.equal(plan.current.pid, restarted);

    await upgrade.stopUpgradeProcess(plan); // acts on the new instance
    assert.ok(!running(restarted));
  } finally {
    try { powershell(`Stop-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false -ErrorAction SilentlyContinue`); } catch { /* not registered */ }
  }
});
