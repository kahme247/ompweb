import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Real NTFS permissions throughout (read back with Get-Acl, used by real child processes). A directory is first given
// the broad inherited read a shared TEMP gives, then secured by the production code. Nothing mocks process.platform;
// on any other OS the tests skip, loudly.
const windows = process.platform === "win32";
const NOT_WINDOWS = `Windows ACL tests run only on Windows (this host is ${process.platform})`;
const moduleUrl = new URL("./upgrade-process.ts", import.meta.url).href;
const base = windows ? realpathSync.native(mkdtempSync(join(tmpdir(), "ompweb-acl-"))) : "";
const USERS = "S-1-5-32-545";
const EVERYONE = "S-1-1-0";
const SYSTEM = "S-1-5-18";
const SECRET = "fake-credential";
const aclScript = join(base, "acl.ps1");
const childScript = join(base, "credential-child.mjs");
const powershellExe = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
let upgrade;

const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const run = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 120000, windowsHide: true });
const powershell = (args) => run(powershellExe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args]);
const ps = (script) => powershell(["-EncodedCommand", Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64")]);
const isAdmin = () => ps("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)").trim() === "True";

/** Who the item lets in (explicit and inherited alike), whether it still inherits, and its owner. */
const ACL_SCRIPT = `param([string]$Path)
$ErrorActionPreference = 'Stop'
$a = Get-Acl -LiteralPath $Path
$rules = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = [string]$_.FileSystemRights; type = [string]$_.AccessControlType } })
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ protected = [bool]$a.AreAccessRulesProtected; owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value; rules = $rules })
`;
const acl = (path) => JSON.parse(powershell(["-File", aclScript, path]));
const sids = (path) => [...new Set(acl(path).rules.map((rule) => rule.sid))].sort();
const reads = (path, sid) => acl(path).rules.some((rule) => rule.sid === sid && rule.type === "Allow" && /Read/.test(rule.rights));
const grantRead = (path, sid) => run("icacls", [path, "/grant", `*${sid}:(OI)(CI)RX`]);

/** A credential written or read by a separate process, as the update helper does. */
const CHILD = `import { readFileSync, writeFileSync } from "node:fs";
const [mode, path, value] = process.argv.slice(2);
if (mode === "write") writeFileSync(path, value, { flag: "wx" }); else process.stdout.write(readFileSync(path, "utf8"));
`;

before(async () => {
  if (!windows) return;
  upgrade = await import("./upgrade-process.ts");
  writeFileSync(aclScript, ACL_SCRIPT);
  writeFileSync(childScript, CHILD);
});
after(async () => {
  if (!windows) return;
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (error) { if (tries === 100) throw error; await sleep(100); }
  }
});

async function waitFor(check, what, timeout = 60000) {
  for (const stop = Date.now() + timeout; Date.now() < stop; await sleep(200)) {
    const value = check();
    if (value) return value;
  }
  return assert.fail(`Timed out waiting for ${what}`);
}

test("a directory that inherited every user's read is restricted to this account and SYSTEM, with what it already holds and what is written later", { skip: !windows && NOT_WINDOWS, timeout: 240_000 }, async () => {
  const dir = join(base, "broad");
  mkdirSync(dir);
  for (const sid of [USERS, EVERYONE]) grantRead(dir, sid);
  const early = join(dir, "early-credential.json");
  writeFileSync(early, SECRET);
  // The control: before it is secured, everything the directory holds is readable by every user.
  for (const sid of [USERS, EVERYONE]) assert.ok(reads(early, sid), `${sid} can read a credential written into the unsecured directory`);

  await upgrade.secureUpgradeDirectory(dir);

  const expected = [...new Set([powershell(["-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"]).trim(), SYSTEM])].sort();
  assert.equal(acl(dir).protected, true, "the directory no longer inherits access");
  assert.deepEqual(sids(dir), expected);
  assert.deepEqual(sids(early), expected, "the credential written before the directory was secured lost the broad access");

  const late = join(dir, "late-credential.json");
  writeFileSync(late, SECRET, { flag: "wx" });
  const attempt = join(dir, "attempt");
  mkdirSync(attempt);
  const deep = join(attempt, "launch-env.json");
  writeFileSync(deep, SECRET, { flag: "wx" });
  const fromChild = join(dir, "child-credential.json");
  run(process.execPath, [childScript, "write", fromChild, SECRET]);
  for (const path of [late, attempt, deep, fromChild]) assert.deepEqual(sids(path), expected, `${path} inherits no broad access`);

  // This account, and the processes it starts, carry on: read, replace, rename, delete, and secure it again.
  for (const path of [early, late, deep, fromChild]) {
    assert.equal(readFileSync(path, "utf8"), SECRET);
    assert.equal(run(process.execPath, [childScript, "read", path]), SECRET);
  }
  writeFileSync(late, "replaced");
  renameSync(late, join(attempt, "moved.json"));
  rmSync(deep);
  await upgrade.secureUpgradeDirectory(dir);
  assert.deepEqual(sids(dir), expected);
  assert.equal(readFileSync(join(attempt, "moved.json"), "utf8"), "replaced");
  rmSync(dir, { recursive: true });
});

test("a directory owned by another account is refused and its access is left as it was", { skip: !windows && NOT_WINDOWS, timeout: 120_000 }, async (t) => {
  const dir = join(base, "foreign");
  mkdirSync(dir);
  const original = acl(dir);
  try { run("icacls", [dir, "/setowner", "*S-1-5-19"]); } catch (error) {
    assert.ok(!process.env.GITHUB_ACTIONS, `the hosted Windows runner must be able to give a scratch directory another owner: ${error.message}`);
    return t.skip(`this account cannot give a directory another owner: ${error.message}`);
  }
  await assert.rejects(upgrade.secureUpgradeDirectory(dir), /owned by S-1-5-19/);
  const refused = acl(dir);
  assert.equal(refused.protected, false);
  assert.deepEqual(refused.rules, original.rules);
});

test("a junction is refused and the directory it points to is left as it was", { skip: !windows && NOT_WINDOWS, timeout: 120_000 }, async () => {
  const target = join(base, "target");
  const link = join(base, "link");
  mkdirSync(target);
  run("cmd.exe", ["/d", "/c", "mklink", "/J", link, target]);
  try {
    const original = acl(target);
    await assert.rejects(upgrade.secureUpgradeDirectory(link), /link or junction/);
    assert.deepEqual(acl(target), original);
  } finally { rmdirSync(link); }
});

test("under SYSTEM, whose temporary directory is shared, only SYSTEM keeps access", { skip: !windows && NOT_WINDOWS, timeout: 300_000 }, async (t) => {
  if (!isAdmin()) {
    const reason = "running a task as SYSTEM needs an elevated administrator and this process is not one";
    assert.ok(!process.env.GITHUB_ACTIONS, `${reason}; the hosted Windows runner must provide it`);
    return t.skip(reason);
  }
  const script = join(base, "as-system.mjs");
  const result = join(base, "as-system.json");
  // Runs as SYSTEM: secures a directory in SYSTEM's own temporary directory, writes a credential, reports the permissions, removes it all.
  writeFileSync(script, `import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [moduleUrl, aclScript, powershell, out] = process.argv.slice(2);
const acl = (path) => JSON.parse(execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", aclScript, path], { encoding: "utf8", windowsHide: true }));
let report;
try {
  const { secureUpgradeDirectory } = await import(moduleUrl);
  const dir = mkdtempSync(join(tmpdir(), "ompweb-system-"));
  try {
    await secureUpgradeDirectory(dir);
    const file = join(dir, "credential.json");
    writeFileSync(file, ${JSON.stringify(SECRET)});
    report = { tmp: tmpdir(), dir: acl(dir), file: acl(file), readBack: readFileSync(file, "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
} catch (error) { report = { error: String(error?.stack ?? error) }; }
writeFileSync(out + ".tmp", JSON.stringify(report));
renameSync(out + ".tmp", out);
`);
  const name = `ompweb-acl-test-${randomUUID().slice(0, 8)}`;
  try {
    ps(`$action = New-ScheduledTaskAction -Execute ${q(process.execPath)} -Argument ${q([script, moduleUrl, aclScript, powershellExe, result].map((value) => `"${value}"`).join(" "))}
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName ${q(name)} -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName ${q(name)}`);
    const report = JSON.parse(await waitFor(() => existsSync(result) && readFileSync(result, "utf8"), "the SYSTEM task's report", 240000));
    assert.equal(report.error, undefined, report.error);
    assert.equal(report.dir.protected, true, `the directory in ${report.tmp} no longer inherits access`);
    assert.deepEqual([...new Set(report.dir.rules.map((rule) => rule.sid))], [SYSTEM]);
    assert.deepEqual([...new Set(report.file.rules.map((rule) => rule.sid))], [SYSTEM]);
    assert.equal(report.readBack, SECRET);
  } finally {
    try { ps(`Stop-ScheduledTask -TaskName ${q(name)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${q(name)} -Confirm:$false -ErrorAction SilentlyContinue`); } catch { /* not registered */ }
  }
});
