import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Real Windows Service Control Manager throughout: a disposable service named by this file (a tiny ServiceBase
// executable called ompweb.exe, started as `ompweb.exe host`, in a scratch installation) is inspected, stopped and
// restarted by the production code. Nothing here mocks process.platform; on any other OS the tests skip, loudly.
const windows = process.platform === "win32";
const NOT_WINDOWS = `Windows service tests run only on Windows (this host is ${process.platform})`;
const moduleUrl = new URL("./upgrade-process.ts", import.meta.url).href;
const base = windows ? realpathSync.native(mkdtempSync(join(tmpdir(), "ompweb-scm-"))) : "";
const owned = []; // every service this file created: { name, dir, exe }
let upgrade;
let admin = false;
let serviceExe;

const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const powershellExe = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function ps(script, timeout = 120000) {
  const wrapped = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`;
  return execFileSync(powershellExe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(wrapped, "utf16le").toString("base64")], { encoding: "utf8", timeout, windowsHide: true });
}

/** The smallest real Windows service: idles until stopped; optionally starts the command in ompweb.child (two lines: file, arguments) and ends that tree when it stops. */
const SERVICE_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

public class OmpwebTestService : ServiceBase {
  private Process child;
  public OmpwebTestService() { ServiceName = "ompweb-upgrade-test"; }
  protected override void OnStart(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string spec = Path.Combine(dir, "ompweb.child");
    if (!File.Exists(spec)) return;
    string[] lines = File.ReadAllLines(spec);
    ProcessStartInfo info = new ProcessStartInfo(lines[0], lines[1]);
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.WorkingDirectory = dir;
    child = Process.Start(info);
  }
  protected override void OnStop() {
    if (child == null) return;
    ProcessStartInfo kill = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"), "/PID " + child.Id + " /T /F");
    kill.UseShellExecute = false;
    kill.CreateNoWindow = true;
    Process.Start(kill).WaitForExit(10000);
  }
  public static void Main() { ServiceBase.Run(new OmpwebTestService()); }
}
`;

const isAdmin = () => ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)").trim() === "True";
const DEFAULT_SDDL = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)";
// Administrators may query, read and change the permissions of the service, but neither start nor stop it.
const NO_STOP_SDDL = "D:(A;;CCLCSWLOCRCWDSD;;;BA)(A;;CCLCSWLOCRC;;;SY)";

before(async () => {
  if (!windows) return;
  upgrade = await import("./upgrade-process.ts");
  admin = isAdmin();
  if (!admin) return;
  mkdirSync(join(base, "compile"));
  serviceExe = join(base, "compile", "service.exe");
  ps(`Add-Type -TypeDefinition ${q(SERVICE_SOURCE)} -ReferencedAssemblies 'System.ServiceProcess' -OutputAssembly ${q(serviceExe)} -OutputType ConsoleApplication`);
  assert.ok(existsSync(serviceExe), "the test service executable was built");
});

function destroy(service) {
  try { writeFileSync(join(service.dir, "helper.stop"), ""); } catch { /* the directory is already gone */ }
  try { execFileSync("sc.exe", ["sdset", service.name, DEFAULT_SDDL], { stdio: "ignore", windowsHide: true }); } catch { /* never created, or already deleted */ }
  try { ps(`$s = Get-Service -Name ${q(service.name)} -ErrorAction SilentlyContinue\nif ($s -and $s.Status -ne 'Stopped') { Stop-Service -InputObject $s -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }`); } catch { /* a stuck service is killed below */ }
  try { execFileSync("sc.exe", ["delete", service.name], { stdio: "ignore", windowsHide: true }); } catch { /* never created, or already deleted */ }
}
after(async () => {
  if (!windows) return;
  for (const service of owned) destroy(service);
  try {
    // Only what runs from this file's own scratch directory (the service executables).
    ps(`$root = ${q(`${base.toLowerCase()}\\`)}\nGet-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  } catch { /* nothing left to stop */ }
  await sleep(500);
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (error) { if (tries === 100) throw error; await sleep(100); }
  }
});

async function waitFor(check, what, timeout = 60000) {
  for (const stop = Date.now() + timeout; Date.now() < stop; await sleep(100)) {
    const value = await check();
    if (value) return value;
  }
  return assert.fail(`Timed out waiting for ${what}`);
}
const processes = () => JSON.parse(ps(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; exe = [string]$_.ExecutablePath; created = $(if ($_.CreationDate) { [string]$_.CreationDate.ToUniversalTime().Ticks } else { '' }) } })`));
const service = (name) => JSON.parse(ps(`$s = Get-CimInstance Win32_Service -Filter ${q(`Name='${name}'`)}\nif ($s) { ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ state = [string]$s.State; pid = [int]$s.ProcessId }) } else { 'null' }`));
const instancesOf = (exe) => processes().filter((row) => row.exe && row.exe.toLowerCase() === exe.toLowerCase());

/** Skips (with the reason) only when this machine cannot create services; the hosted CI runner can, so there it fails instead. */
function canCreateServices(t) {
  if (admin) return true;
  const reason = "creating a Windows service needs an elevated administrator and this process is not one";
  assert.ok(!process.env.GITHUB_ACTIONS, `${reason}; the hosted Windows runner must provide it`);
  t.skip(reason);
  return false;
}

/** A new disposable service: ompweb.exe in its own installation directory, run as `ompweb.exe host`. */
function createService(label) {
  const dir = join(base, label);
  mkdirSync(dir);
  const exe = join(dir, "ompweb.exe");
  copyFileSync(serviceExe, exe);
  const created = { name: `ompweb-upgrade-test-${randomUUID().slice(0, 8)}`, dir, exe, launch: { command: exe, args: ["host"], cwd: dir } };
  owned.push(created);
  ps(`New-Service -Name ${q(created.name)} -BinaryPathName ${q(`"${exe}" host`)} -DisplayName ${q(created.name)} -StartupType Manual | Out-Null`);
  return created;
}
/** Starts the service and returns its single process: pid and the test's own creation-time identity. */
function startService(created) {
  ps(`Start-Service -Name ${q(created.name)}`);
  const { state, pid } = service(created.name);
  assert.equal(state, "Running");
  assert.ok(pid > 1, "the running service has a process");
  const rows = instancesOf(created.exe);
  assert.deepEqual(rows.map((row) => row.pid), [pid], "exactly the service's process runs ompweb.exe");
  return { pid, created: rows[0].created };
}
const inspect = (created, pid, role = "host") => upgrade.inspectUpgradeProcess({ pid, installDir: created.dir, role, launch: created.launch });

test("a Windows service is inspected, refused once changed, stopped and restarted as one new instance", { skip: windows ? false : NOT_WINDOWS, timeout: 300_000 }, async (t) => {
  if (!canCreateServices(t)) return;
  const svc = createService("lifecycle");
  const first = startService(svc);

  await assert.rejects(inspect(svc, first.pid, "server"), /is not the server process/);
  const plan = await inspect(svc, first.pid);
  assert.equal(plan.platform, "win32");
  assert.equal(plan.supervisor.kind, "windows-service");
  assert.equal(plan.supervisor.name, svc.name);
  assert.equal(typeof plan.supervisor.configHash, "string");
  assert.equal(plan.args.at(-1), "host");
  assert.deepEqual(plan.current, { pid: first.pid, identity: plan.identity });
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "the plan is plain JSON");

  // A service whose configuration changed after inspection is never controlled.
  ps(`Set-Service -Name ${q(svc.name)} -StartupType Automatic`);
  await assert.rejects(upgrade.stopUpgradeProcess(plan), /changed since it was inspected/);
  assert.equal(service(svc.name).state, "Running", "the refused stop left the service running");
  ps(`Set-Service -Name ${q(svc.name)} -StartupType Manual`);

  await upgrade.stopUpgradeProcess(plan);
  assert.equal(service(svc.name).state, "Stopped");
  assert.deepEqual(instancesOf(svc.exe), [], "the old process is gone");
  await upgrade.stopUpgradeProcess(plan); // already stopped: nothing to do

  const pid = await upgrade.restartUpgradeProcess(plan, svc.launch);
  assert.ok(Number.isSafeInteger(pid), "the new instance was identified");
  assert.deepEqual(service(svc.name), { state: "Running", pid });
  assert.equal(plan.pid, first.pid, "the inspected process stays recorded");
  assert.equal(plan.current.pid, pid);
  assert.notEqual(plan.current.identity, plan.identity);
  const restarted = instancesOf(svc.exe);
  assert.deepEqual(restarted.map((row) => row.pid), [pid]);
  assert.notEqual(restarted[0].created, first.created, "a different process, not the old one");
  await sleep(1000);
  assert.equal(instancesOf(svc.exe).length, 1, "no second instance appeared");
  await assert.rejects(upgrade.restartUpgradeProcess(plan, svc.launch), /still running/, "a running instance is never joined by a second one");
  assert.equal(instancesOf(svc.exe).length, 1);

  // After a restart a stop acts on the new instance.
  await upgrade.stopUpgradeProcess(plan);
  assert.equal(service(svc.name).state, "Stopped");
  assert.deepEqual(instancesOf(svc.exe), []);
});

test("without the right to stop the service the stop is refused and nothing is killed", { skip: windows ? false : NOT_WINDOWS, timeout: 300_000 }, async (t) => {
  if (!canCreateServices(t)) return;
  const svc = createService("denied");
  const first = startService(svc);
  const plan = await inspect(svc, first.pid);
  const untouched = JSON.stringify(plan);
  execFileSync("sc.exe", ["sdset", svc.name, NO_STOP_SDDL], { windowsHide: true });
  try {
    assert.deepEqual(service(svc.name), { state: "Running", pid: first.pid }, "the service can still be queried, only not stopped");
    await assert.rejects(upgrade.stopUpgradeProcess(plan), (error) => /PowerShell failed/.test(error.message) && !/Service not found|changed since it was inspected/.test(error.message));
    assert.deepEqual(service(svc.name), { state: "Running", pid: first.pid });
    assert.equal(instancesOf(svc.exe)[0].created, first.created, "the same process still runs");
    assert.equal(JSON.stringify(plan), untouched, "the plan was not touched");
  } finally {
    execFileSync("sc.exe", ["sdset", svc.name, DEFAULT_SDDL], { windowsHide: true });
  }
  await upgrade.stopUpgradeProcess(plan); // permitted again: the very same plan still works
  assert.equal(service(svc.name).state, "Stopped");
});

test("a helper launched under a service survives the service being stopped, with the caller that started it", { skip: windows ? false : NOT_WINDOWS, timeout: 300_000 }, async (t) => {
  if (!canCreateServices(t)) return;
  const svc = createService("survival");
  const helper = join(svc.dir, "helper.cjs");
  const caller = join(svc.dir, "caller.mjs");
  // The helper idles until told to stop (never longer than five minutes), so cleaning up needs no right to kill a SYSTEM process.
  writeFileSync(helper, `const fs = require("node:fs"); const path = require("node:path");\nconst dir = process.argv[2];\nfs.writeFileSync(path.join(dir, "helper.pid"), String(process.pid));\nsetInterval(() => { if (fs.existsSync(path.join(dir, "helper.stop"))) process.exit(0); }, 200);\nsetTimeout(() => process.exit(0), 300000);\n`);
  // The service starts this caller as its child (ompweb.child); the caller launches the helper and idles.
  writeFileSync(caller, `import { launchDetachedUpgrade } from ${JSON.stringify(moduleUrl)};\nimport { writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nconst dir = process.argv[2];\nlet report;\ntry { report = { caller: process.pid, helper: await launchDetachedUpgrade({ command: process.execPath, args: [${JSON.stringify(helper)}, dir], cwd: tmpdir() }) }; }\ncatch (error) { report = { error: error.message }; }\nwriteFileSync(join(dir, "report.json"), JSON.stringify(report));\nsetInterval(() => {}, 1000);\n`);
  writeFileSync(join(svc.dir, "ompweb.child"), `${process.execPath}\n"${caller}" "${svc.dir}"\n`);

  const first = startService(svc);
  const report = await waitFor(() => { try { return JSON.parse(readFileSync(join(svc.dir, "report.json"), "utf8")); } catch { return null; } }, "the caller to launch the helper");
  assert.equal(report.error, undefined, `launchDetachedUpgrade failed under the service: ${report.error}`);
  assert.equal(Number(await waitFor(() => (existsSync(join(svc.dir, "helper.pid")) ? readFileSync(join(svc.dir, "helper.pid"), "utf8") : ""), "the helper to run")), report.helper, "the pid launchDetachedUpgrade returned is the helper");

  const rows = processes();
  const row = (pid) => rows.find((r) => r.pid === pid);
  const ancestors = (pid) => {
    const chain = [];
    for (let at = row(pid); at && row(at.ppid) && BigInt(row(at.ppid).created || 0) <= BigInt(at.created || 0) && chain.length < 16; at = row(at.ppid)) chain.push(at.ppid);
    return chain;
  };
  assert.ok(ancestors(report.caller).includes(first.pid), "the caller runs under the service");
  assert.ok(!ancestors(report.helper).includes(first.pid), "the helper is outside the service's process tree");
  const helperCreated = row(report.helper).created;

  const plan = await inspect(svc, first.pid);
  assert.equal(plan.supervisor.kind, "windows-service");
  await upgrade.stopUpgradeProcess(plan);
  assert.equal(service(svc.name).state, "Stopped");
  await waitFor(() => !processes().some((r) => r.pid === report.caller && r.created === row(report.caller).created), "the caller to end with the service");
  for (let i = 0; i < 2; i++) {
    const survivor = processes().find((r) => r.pid === report.helper);
    assert.ok(survivor && survivor.created === helperCreated, "the helper outlived the service and the caller");
    await sleep(1000);
  }
});
