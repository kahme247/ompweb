// The GUI's coordinated upgrade on real compiled binaries, Linux, macOS and Windows.
//
// Real: three ompweb executables compiled from server/binary.ts (`Bun.build` compile, as scripts/build-binary.ts does),
// the web server and its GUI API (POST /api/app-update prepare/commit/acknowledge), the auto-started local host,
// the plan/approval engine, the detached server-update-worker (a copy of the binary), the candidate's `--version`,
// `fetch-omp` and `preflight`, the install-directory swap (a running .exe on Windows), the restarts and the rollback.
// Fake, and only here: (a) a build plugin that overrides ONLY the root package.json version and the link protocol
// constants of each scratch binary; (b) tests/compiled-upgrade-fixture.mjs, the entrypoint that answers the npm
// registry, raw-GitHub, release-metadata and release-asset requests from a map (OMPWEB_UPGRADE_FIXTURE) before it
// loads the real server; (c) the omp runner: tests/fixtures/multi-server-omp.mjs behind a launcher, which speaks
// the runner's channel (hello, get_state) for the host's sessions and the candidate's preflight. Set
// OMPWEB_UPGRADE_E2E_RUNNER to a built ompweb-omp for the same scenarios with the real runner and no model call.
// Each scenario copies it privately so cleanup cannot target another installation's detached brokers.
// Releases: 98.0.0 (link protocol 12) -> 98.0.1 (protocol 13: hard incompatibility, or 12: compatible).
// Scenarios: hard + active session (no-force and wrong-plan commits refused, forced commit ends the session and
// reaches the candidate server and host), compatible idle, and a candidate whose server refuses to start (rolled back).
// Not covered: service, scheduled-task and launchd supervision (a foreground install only), an update from a real GitHub release.
//
// Run:  OMPWEB_COMPILED_UPGRADE_E2E=1 bun test --timeout 900000 lib/compiled-upgrade.integration.test.mjs
// Needs: Bun (Bun.build), `tar` on Linux (bsdtar from System32 on Windows), no network. Each run compiles three ~100 MB
// binaries and uses up to ~1.5 GB of the system temp directory (HOME, agent dir, TMPDIR and ports are all scratch).
// Cleanup: every process whose command line names the scratch directory, and its descendants, is ended; the run
// fails if one survives. A crash of the runner itself can leave them: kill by the ompweb-compiled-upgrade-* path.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** True when this process runs inside a systemd service, where the update engine would take that service for the server's supervisor. */
function insideSystemdService() {
  try {
    return readFileSync("/proc/self/cgroup", "utf8").split("\n").some((line) => (line.startsWith("0::") || line.includes(":name=systemd:")) && line.split("/").at(-1)?.trim().endsWith(".service"));
  } catch { return false; }
}

const { resolveSelfUpdateTempRoot } = await import("./self-update-state.ts");
const { requestHostControl } = await import("./hosts/host-control.ts");

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
const exeName = windows ? "ompweb.exe" : "ompweb";
const releaseName = `ompweb-${windows ? "windows" : process.platform}-${process.arch}`;
const assetName = `${releaseName}${windows ? ".zip" : ".tar.gz"}`;
const OLD = "98.0.0";
const NEXT = "98.0.1";
const SESSION_ID = "98c0e5e0-0000-4000-8000-000000000001";
const INDEX_HTML = '<!doctype html><title>ompweb</title><main id="root"></main>';
const TIMEOUT = 900_000;
const UPDATE_TIMEOUT = 420_000;
const NO_SCOPE = "systemd-run cannot create the scope that keeps the scratch server outside the service running the suite";

const supported = ["linux", "darwin", "win32"].includes(process.platform) && ["x64", "arm64"].includes(process.arch) && !(windows && process.arch !== "x64");
const skip = process.env.OMPWEB_COMPILED_UPGRADE_E2E !== "1" ? "set OMPWEB_COMPILED_UPGRADE_E2E=1: it compiles three ompweb binaries and runs the real GUI upgrade"
  : typeof Bun === "undefined" ? "needs Bun.build (run it with bun test)"
  : !supported ? `not supported on ${process.platform}/${process.arch}`
  : false;
const compiledProofRequired = process.env.OMPWEB_COMPILED_UPGRADE_E2E === "1" && Boolean(process.env.CI);
if (compiledProofRequired && skip) throw new Error(`compiled upgrade E2E is required in CI and cannot be skipped: ${skip}`);
function skipOrFail(t, reason) {
  if (compiledProofRequired) throw new Error(`compiled upgrade E2E is required in CI and cannot be skipped: ${reason}`);
  return t.skip(reason);
}
const base = skip ? "" : realpathSync.native(mkdtempSync(join(tmpdir(), "ompweb-compiled-upgrade-")));

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value));

async function removeTree(path) {
  for (let tries = 0; ; tries++) {
    try { return rmSync(path, { recursive: true, force: true }); }
    catch (error) {
      if (tries === 50 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      await sleep(100);
    }
  }
}
after(async () => { if (base) await removeTree(base); });

function alive(pid) {
  try {
    // A zombie has released its cwd and handles, even while kill(pid, 0) succeeds.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat[stat.lastIndexOf(")") + 2] === "Z") return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return false;
    throw error;
  }
}

/** Polls `check` until it returns something truthy; an error from it (a service that is restarting) means not yet. */
async function until(check, what, diag, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last = "";
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout / 1000} s waiting for ${what}${last ? ` (last error: ${last})` : ""}\n${diag()}`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------- processes

/** Every process with its parent and command line (the executable path is appended on Windows). */
async function processTable() {
  if (process.platform === "linux") {
    return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        return [{ pid: Number(name), ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]), command: readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ") }];
      } catch { return []; /* gone or unreadable */ }
    });
  }
  if (process.platform === "darwin") {
    const { stdout } = await exec("ps", ["-axww", "-o", "pid=,ppid=,command="], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    return stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
    });
  }
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return [].concat(JSON.parse(stdout)).map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: `${row.CommandLine ?? ""} ${row.ExecutablePath ?? ""}` }));
}
const mentions = (row, path) => row.command.toLowerCase().includes(path.toLowerCase());
function descendants(table, root) {
  const found = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) if (!found.has(row.pid) && (row.ppid === root || found.has(row.ppid))) { found.add(row.pid); grew = true; }
  }
  return [...found];
}

/** Ends every process that names `root` and everything below it, and fails when one survives. */
async function sweep(root) {
  const table = await processTable();
  const own = new Set(table.filter((row) => row.pid !== process.pid && row.pid !== process.ppid && mentions(row, root)).map((row) => row.pid));
  for (const pid of [...own]) for (const child of descendants(table, pid)) own.add(child);
  own.delete(process.pid);
  const signal = (name) => { for (const pid of own) { try { process.kill(pid, name); } catch { /* gone */ } } };
  signal("SIGTERM");
  for (const deadline = Date.now() + 10_000; [...own].some(alive) && Date.now() < deadline;) await sleep(100);
  signal("SIGKILL");
  for (const deadline = Date.now() + 10_000; [...own].some(alive) && Date.now() < deadline;) await sleep(100);
  assert.deepEqual([...own].filter(alive), [], "test-owned processes must exit before their directory is removed");
}

/**
 * The server as the update engine must find it: started outside any systemd service (a transient scope when this process
 * runs in one, or the engine would take that service for the supervisor) and, on Windows, typed into a plain cmd.exe
 * (inspectWindowsSupervisor accepts only an interactive shell as parent). Null when no scope can be made.
 */
async function spawnForeground(command, args, options) {
  if (windows) {
    const shell = spawn(process.env.ComSpec || "cmd.exe", [], { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    shell.stdin.end(`"${command}" ${args.map((arg) => `"${arg}"`).join(" ")} <NUL\r\nexit %errorlevel%\r\n`);
    return shell;
  }
  const stdio = ["ignore", "pipe", "pipe"];
  if (!insideSystemdService()) return spawn(command, args, { ...options, stdio });
  const scope = ["--scope", "--quiet", "--collect", "--no-ask-password"];
  const probe = await new Promise((done) => {
    const child = spawn("systemd-run", [...scope, "true"], { stdio: "ignore" });
    child.once("error", () => done(-1));
    child.once("exit", done);
  });
  return probe === 0 ? spawn("systemd-run", [...scope, command, ...args], { ...options, stdio }) : null;
}

// ---------------------------------------------------------------- the scratch binaries and releases

/** The real link-protocol.ts with both protocol constants set: what the build plugin compiles in and the fixture serves as the candidate's raw source. */
function withProtocol(source, protocol) {
  const next = source
    .replace(/^export const MIN_LINK_PROTOCOL_VERSION = \d+;/m, `export const MIN_LINK_PROTOCOL_VERSION = ${protocol};`)
    .replace(/^export const LINK_PROTOCOL_VERSION = \d+;/m, `export const LINK_PROTOCOL_VERSION = ${protocol};`);
  assert.ok(next.includes(`export const MIN_LINK_PROTOCOL_VERSION = ${protocol};`) && next.includes(`export const LINK_PROTOCOL_VERSION = ${protocol};`), "lib/hosts/link-protocol.ts no longer declares its protocol range on single lines");
  return next;
}

/** A release directory as the archive carries it: the binary, the SPA shell and the public files the server loads at start. */
function populate(binary, dir) {
  mkdirSync(join(dir, "dist"), { recursive: true });
  copyFileSync(binary, join(dir, exeName), constants.COPYFILE_FICLONE);
  chmodSync(join(dir, exeName), 0o755);
  writeFileSync(join(dir, "dist", "index.html"), INDEX_HTML);
  cpSync(join(repo, "public"), join(dir, "public"), { recursive: true });
}

async function compile(name, version, protocol) {
  const outfile = join(base, "build", name, exeName);
  mkdirSync(dirname(outfile), { recursive: true });
  const packageFile = join(repo, "package.json");
  const protocolFile = join(repo, "lib", "hosts", "link-protocol.ts");
  const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
  const result = await Bun.build({
    entrypoints: [join(repo, "tests", "compiled-upgrade-fixture.mjs")],
    // What scripts/build-binary.ts sets: without the define the bundle reads NODE_ENV as development and never starts the local host.
    compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{
      name: `ompweb-fixture-${name}`,
      setup(build) {
        build.onLoad({ filter: /package\.json$/ }, async ({ path }) => samePath(path, packageFile)
          ? { loader: "json", contents: JSON.stringify({ ...JSON.parse(await Bun.file(path).text()), version }) } : undefined);
        build.onLoad({ filter: /link-protocol\.ts$/ }, async ({ path }) => samePath(path, protocolFile)
          ? { loader: "ts", contents: withProtocol(await Bun.file(path).text(), protocol) } : undefined);
      },
    }],
    throw: false,
  });
  assert.ok(result.success, `compiling ${name} failed:\n${result.logs.map(String).join("\n")}`);
  return outfile;
}

/** A candidate: its binary, and the real archive (tar.gz, or zip on Windows) of its release directory with the digest the metadata names. */
async function release(name, protocol, linkSource) {
  const binary = await compile(name, NEXT, protocol);
  const parent = join(base, "build", `${name}-release`);
  populate(binary, join(parent, releaseName));
  const archive = join(parent, assetName);
  const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  await exec(tar, windows ? ["-a", "-cf", assetName, releaseName] : ["-czf", assetName, releaseName], { cwd: parent });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  return { archive, digest: `sha256:${hash.digest("hex")}`, linkProtocol: withProtocol(linkSource, protocol) };
}

let built;
const binaries = () => built ??= (async () => {
  const linkSource = readFileSync(join(repo, "lib", "hosts", "link-protocol.ts"), "utf8");
  const old = await compile("old", OLD, 12);
  return { old, compat: await release("compat", 12, linkSource), hard: await release("hard", 13, linkSource) };
})();

// ---------------------------------------------------------------- one scratch machine

/** The omp runner: the configured real one, or the channel stand-in behind a launcher this machine owns. */
function runnerFor(root) {
  if (process.env.OMPWEB_UPGRADE_E2E_RUNNER) {
    const privateRunner = join(root, windows ? "ompweb-omp.exe" : "ompweb-omp");
    copyFileSync(resolve(process.env.OMPWEB_UPGRADE_E2E_RUNNER), privateRunner, constants.COPYFILE_FICLONE);
    if (!windows) chmodSync(privateRunner, 0o755);
    return privateRunner;
  }
  const standIn = fileURLToPath(new URL("../tests/fixtures/multi-server-omp.mjs", import.meta.url));
  const launcher = join(root, windows ? "omp.cmd" : "omp");
  if (windows) writeFileSync(launcher, `@"${process.execPath.replaceAll("%", "%%")}" "${standIn.replaceAll("%", "%%")}" %*\r\n`);
  else writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${standIn}" "$@"\n`, { mode: 0o755 });
  return launcher;
}

/** An old installation started as a real server on a scratch HOME, agent directory, temp directory and port, with its own host started by the server. Null when no systemd scope can be made. */
async function deploy(t, name, { candidate, failCandidate = false }) {
  const builds = await binaries();
  const root = join(base, name);
  const home = join(root, "home");
  const agent = join(home, ".omp", "agent");
  const temp = join(root, "tmp");
  const project = join(root, "project");
  const install = join(root, "install");
  const mapPath = join(root, "fixture.json");
  const exe = join(install, exeName);
  const statusFile = join(resolveSelfUpdateTempRoot(process.platform, temp), "status.json");
  let shell;
  let url = "";
  let output = "";
  t.after(async () => {
    shell?.kill();
    try { await sweep(root); } finally { await removeTree(root); }
  });

  mkdirSync(root, { mode: 0o755 });
  chmodSync(root, 0o755);
  for (const dir of [agent, temp, project, install]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(install, 0o755);
  populate(builds.old, install);
  const sessionFile = join(agent, "sessions", "-project", `2026-01-01_${SESSION_ID}.jsonl`);
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  const next = builds[candidate];
  writeJson(mapPath, {
    latest: NEXT,
    ...(failCandidate ? { failServerStart: NEXT } : {}),
    releases: { [NEXT]: {
      linkProtocol: next.linkProtocol,
      metadata: { tag_name: `v${NEXT}`, draft: false, assets: [{ name: assetName, digest: next.digest }] },
      assets: { [assetName]: next.archive },
    } },
  });
  // Everything the server, its host, the worker and the candidate inherit (the restart environment is this one).
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, TMPDIR: temp, TEMP: temp, TMP: temp,
    OMP_WEB_OMP_BIN: runnerFor(root), OMPWEB_UPGRADE_FIXTURE: mapPath,
    OMP_MULTI_SESSION_ID: SESSION_ID, OMP_MULTI_SESSION_FILE: sessionFile, OMP_MULTI_LOG: join(root, "omp.jsonl"), OMP_MULTI_RELEASE_FILE: join(root, "release-stream"),
  };
  for (const key of ["OMP_WEB_PASSWORD", "OMP_WEB_PASSWORD_HASH", "OMP_WEB_TRUSTED_HEADER_SECRET", "OMP_WEB_TRUSTED_HEADER_SHA256", "OMP_WEB_PACKAGE_DIR", "OMP_WEB_DISABLE_AUTOUPDATE", "OMP_WEB_LAUNCHER_PID", "OMP_WEB_NODE_BIN", "OMP_WEB_PORT", "OMP_WEB_HOSTNAME", "PORT", "NODE_ENV", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"]) delete env[key];

  const diag = () => `--- server output ---\n${output.slice(-6000)}\n--- update status ---\n${existsSync(statusFile) ? readFileSync(statusFile, "utf8") : "(none)"}`;
  const readStatus = () => (existsSync(statusFile) ? read(statusFile) : null);
  const get = async (path) => (await fetch(`${url}${path}`, { signal: AbortSignal.timeout(30_000), proxy: false })).json();
  const send = async (path, body) => {
    const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000), proxy: false });
    return { status: response.status, text: await response.text() };
  };
  const post = async (body) => {
    const { status, text } = await send("/api/app-update", body);
    return { status, body: JSON.parse(text) };
  };
  const hostStatus = () => requestHostControl("status", agent);
  const localRow = async () => (await get("/api/hosts")).hosts.find((host) => host.id === "local");
  /** The host answers its control endpoint and the server lists it online, both as `version` speaking `protocol`. */
  const hostLinked = (version, protocol) => until(async () => {
    const [row, control] = [await localRow(), await hostStatus()];
    return row?.status === "online" && typeof row.apiVersion === "number" && row.ompwebVersion === version && row.hostVersion === protocol
      && control.version === version && control.protocol === protocol && control.linked ? control : null;
  }, `the local host linked as ${version} speaking protocol ${protocol}`, diag);
  const version = async (dir = install) => (await exec(join(dir, exeName), ["--version"], { env, cwd: project, timeout: 60_000 })).stdout.trim();
  const processes = async () => {
    const table = await processTable();
    const own = table.filter((row) => mentions(row, root));
    const text = (row) => row.command.replaceAll('"', "").toLowerCase();
    const key = exe.toLowerCase();
    return {
      table,
      servers: own.filter((row) => text(row).includes(key) && text(row).includes("--no-open")),
      hosts: own.filter((row) => text(row).includes(`${key} host`)),
    };
  };

  assert.equal(await version(), OLD, "the scratch binary carries the overridden package version");
  shell = await spawnForeground(exe, ["-p", "0", "-H", "127.0.0.1", "--no-open"], { cwd: project, env });
  if (!shell) return null;
  for (const pipe of [shell.stdout, shell.stderr]) pipe.on("data", (chunk) => { output += chunk; });
  url = await until(() => /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1], "the server's Ready line", diag, 60_000);
  // Nothing here starts the host: the server does, once its short grace for a supervisor passes.
  await until(async () => {
    const row = await localRow();
    return row?.status === "online" && typeof row.apiVersion === "number";
  }, "the auto-started local host to link", diag);

  return {
    root, install, exe, diag, get, send, post, hostStatus, hostLinked, version, processes, readStatus,
    output: () => output,
    /** The server answers as `expected` and, when `planState` is given, reports the attempt's plan in that state (the worker writes the plan just after the status). */
    untilServer: (expected, planState) => until(async () => {
      const info = await get("/api/app-update");
      return info.currentVersion === expected && (planState === undefined || info.upgradePlan?.state === planState) ? info : null;
    }, `the server to answer as ${expected}${planState ? ` with its plan ${planState}` : ""}`, diag, UPDATE_TIMEOUT),
    finished: (attemptId) => until(() => {
      const status = readStatus();
      return status?.attemptId === attemptId && (status.state === "succeeded" || status.state === "failed") ? status : null;
    }, "the update to finish", diag, UPDATE_TIMEOUT),
    /** Starts the scratch session through the host (no model call) and returns the pids of the omp processes below the host. */
    async openSession() {
      const { status, text } = await send(`/api/agent/${SESSION_ID}`, { type: "get_state" });
      assert.equal(status, 200, `get_state: ${text}\n${diag()}`);
      assert.equal((await get(`/api/agent/${SESSION_ID}`)).running, true);
      const { table } = await processes();
      const runners = descendants(table, (await hostStatus()).pid).filter((pid) => table.find((row) => row.pid === pid).command.includes("--headless"));
      assert.ok(runners.length > 0, "the host runs the session's omp");
      return runners;
    },
    /** prepare through the GUI API: the attempt and its plan. */
    async prepare() {
      const prepared = await post({ action: "prepare" });
      assert.equal(prepared.status, 202, `${JSON.stringify(prepared.body)}\n${diag()}`);
      assert.equal(prepared.body.targetVersion, NEXT);
      assert.equal(prepared.body.plan.blockedReason, null);
      return prepared.body;
    },
    commit: (attemptId, planId, force) => post({ action: "commit", attemptId, approval: { planId, force } }),
    /** Removes the finished attempt's state, as the dialog does. */
    async acknowledge(attemptId) {
      // The worker may still be exiting right after it wrote the result: the API refuses cleanup until it is gone.
      const reply = await until(async () => {
        const result = await post({ action: "acknowledge", attemptId });
        return result.status === 200 ? result : null;
      }, "the finished attempt to become acknowledgeable", diag, 60_000);
      assert.deepEqual(reply.body, { acknowledged: true, attemptId });
      assert.equal(readStatus(), null, "the finished attempt's state is gone");
    },
  };
}

function assertLocalHostPlan(plan, { sessions }) {
  const local = plan.hosts.find((host) => host.id === "local");
  assert.ok(local, JSON.stringify(plan));
  assert.deepEqual([local.needsUpgrade, local.recovery, local.currentVersion, local.protocolVersion, local.targetVersion, local.blockedReason], [true, "shared-local", OLD, 12, NEXT, null]);
  assert.equal(local.sessionProcesses > 0, sessions, JSON.stringify(local));
  assert.equal(plan.requiresForce, sessions);
}

/** The previous server, its host and its sessions are exactly as before: no refused request cut anything over. */
async function assertUntouched(machine, before) {
  const now = await machine.processes();
  assert.deepEqual(now.servers.map((row) => row.pid), [before.server], "the server is the same process");
  assert.equal((await machine.hostStatus()).pid, before.host, "the host is the same process");
  assert.ok(before.runners.every(alive), "the session's omp still runs");
  const info = await machine.get("/api/app-update");
  assert.equal(info.currentVersion, OLD);
  assert.equal(info.selfUpdateStatus.state, "prepared", "the refused approval left the attempt approvable");
}

// ---------------------------------------------------------------- scenarios

test("hard protocol incompatibility with an active session: only an approved Force cuts over, then the candidate server and host run", { skip, timeout: TIMEOUT }, async (t) => {
  const machine = await deploy(t, "hard", { candidate: "hard" });
  if (!machine) return skipOrFail(t, NO_SCOPE);
  await until(() => /local daemon started \(pid \d+\)/.test(machine.output()), "the server to report that it started this machine's host itself", machine.diag, 30_000);
  const oldHost = await machine.hostStatus();
  assert.deepEqual([oldHost.version, oldHost.protocol, oldHost.linked], [OLD, 12, true]);
  const running = await machine.processes();
  assert.equal(running.servers.length, 1, machine.diag());
  assert.deepEqual(running.hosts.map((row) => row.pid), [oldHost.pid], "one host");
  const before = { server: running.servers[0].pid, host: oldHost.pid, runners: await machine.openSession() };

  const info = await machine.get("/api/app-update");
  assert.deepEqual([info.selfUpdateSupported, info.installMethod, info.currentVersion, info.availableVersion, info.updateAvailable], [true, "binary", OLD, NEXT, true], JSON.stringify(info));
  const { attemptId, plan } = await machine.prepare();
  assert.deepEqual(plan.compatibility, { min: 13, max: 13 });
  assertLocalHostPlan(plan, { sessions: true });

  const noForce = await machine.commit(attemptId, plan.id, false);
  assert.deepEqual([noForce.status, noForce.body.code], [409, "force_approval_required"], JSON.stringify(noForce));
  await assertUntouched(machine, before);
  const wrongPlan = await machine.commit(attemptId, randomUUID(), true);
  assert.deepEqual([wrongPlan.status, wrongPlan.body.code], [400, "plan_mismatch"], JSON.stringify(wrongPlan));
  await assertUntouched(machine, before);

  const accepted = await machine.commit(attemptId, plan.id, true);
  assert.deepEqual([accepted.status, accepted.body], [202, { accepted: true, attemptId }]);
  const status = await machine.finished(attemptId);
  assert.equal(status.state, "succeeded", `${JSON.stringify(status)}\n${machine.diag()}`);

  const info2 = await machine.untilServer(NEXT, "succeeded");
  assert.equal(info2.updateAvailable, false);
  assert.equal(info2.selfUpdateStatus.state, "succeeded");
  assert.deepEqual([info2.upgradePlan.state, info2.upgradePlan.approved.force], ["succeeded", true]);
  const host = await machine.hostLinked(NEXT, 13);
  assert.notEqual(host.pid, before.host, "the host was replaced");
  assert.equal((await machine.get("/api/hosts")).hosts.find((row) => row.id === "local").serverVersion, 13);
  await until(() => !alive(before.server) && !alive(before.host) && !before.runners.some(alive), "the replaced server, host and the forced-out session to be gone", machine.diag, 30_000);
  const after = await machine.processes();
  assert.equal(after.servers.length, 1, "one server");
  assert.deepEqual(after.hosts.map((row) => row.pid), [host.pid], "one host");
  assert.equal(await machine.version(), NEXT);
  // The worker removes the staging tree after it reports: the installation's parent ends up holding nothing of the attempt.
  await until(() => readdirSync(machine.root).every((entry) => !entry.startsWith(".ompweb-server-")), "no backup, staging or failed tree to outlive a successful update", machine.diag, 30_000);
  await machine.acknowledge(attemptId);
});

test("compatible update of an idle machine needs no Force and keeps the protocol", { skip, timeout: TIMEOUT }, async (t) => {
  const machine = await deploy(t, "compat", { candidate: "compat" });
  if (!machine) return skipOrFail(t, NO_SCOPE);
  const oldHost = await machine.hostStatus();
  assert.deepEqual([oldHost.version, oldHost.protocol], [OLD, 12]);
  const { attemptId, plan } = await machine.prepare();
  assert.deepEqual(plan.compatibility, { min: 12, max: 12 });
  assertLocalHostPlan(plan, { sessions: false });

  const accepted = await machine.commit(attemptId, plan.id, false);
  assert.deepEqual([accepted.status, accepted.body], [202, { accepted: true, attemptId }]);
  const status = await machine.finished(attemptId);
  assert.equal(status.state, "succeeded", `${JSON.stringify(status)}\n${machine.diag()}`);

  const info = await machine.untilServer(NEXT, "succeeded");
  assert.deepEqual([info.upgradePlan.state, info.upgradePlan.approved.force], ["succeeded", false]);
  const host = await machine.hostLinked(NEXT, 12);
  assert.notEqual(host.pid, oldHost.pid, "the host shares the replaced installation and was restarted from the new one");
  const after = await machine.processes();
  assert.equal(after.servers.length, 1, "one server");
  assert.deepEqual(after.hosts.map((row) => row.pid), [host.pid], "one host");
  assert.equal(await machine.version(), NEXT);
  await machine.acknowledge(attemptId);
});

test("a candidate whose server refuses to start is rolled back: the previous server, host and installation return", { skip, timeout: TIMEOUT }, async (t) => {
  const machine = await deploy(t, "rollback", { candidate: "compat", failCandidate: true });
  if (!machine) return skipOrFail(t, NO_SCOPE);
  const oldHost = await machine.hostStatus();
  const { attemptId, plan } = await machine.prepare();
  const accepted = await machine.commit(attemptId, plan.id, false);
  assert.deepEqual([accepted.status, accepted.body], [202, { accepted: true, attemptId }]);
  const status = await machine.finished(attemptId);
  assert.equal(status.state, "failed", machine.diag());
  assert.match(status.error, /exited before it reported ready/);
  assert.equal(status.retainedBackup, undefined, "the previous installation was restored, so no backup is left to report");

  const info = await machine.untilServer(OLD, "failed");
  assert.equal(info.selfUpdateStatus.state, "failed");
  assert.equal(info.upgradePlan.state, "failed");
  const host = await machine.hostLinked(OLD, 12);
  assert.notEqual(host.pid, oldHost.pid, "the previous host was started again from the restored installation");
  const after = await machine.processes();
  assert.equal(after.servers.length, 1, "one server");
  assert.deepEqual(after.hosts.map((row) => row.pid), [host.pid], "one host");
  assert.equal(await machine.version(), OLD);
  assert.equal(await machine.version(join(machine.root, `.ompweb-server-failed-${attemptId}`)), NEXT, "the failed candidate is kept for diagnosis");
  await machine.acknowledge(attemptId);
});
