// Real pre-cutover daemons (link protocol 10 and 11) upgrading to this checkout through this checkout's hub.
//
// Nothing of the old side is imitated. The daemon is the published source, extracted from git at a pinned commit into
// a disposable npm-layout install and started as `node bin/omp-web-host.js`; its welcome check, its `checkUpdates` /
// `updateSoftware` handlers and its updater engine (candidate protocol check, install, swap, restart, health) all run
// unchanged. Only delivery is disposable: a fetch preload answers the npm registry and the raw-GitHub link-protocol.ts
// (the worktree's real file, parsed by the OLD updater's own regex), and a fake `npm` "installs" a copy of this
// checkout as the release. The hub is the real hub behind the real /api/hosts/link route. No user service is touched.
//
// Pinned sources (both reachable from main; the test skips, naming the commit, when a shallow clone lacks it):
//   v10  546a945df0d1716a7a135d6e3221ba885b00171e  package 0.6.0, link 10. The last commit before 8ec9208d (runner
//        channels); published as prerelease 20261113T113829Z-546a945df0. v10 first appeared at a53494c4. Its updater
//        takes target "ompweb" or "omp" and has no preflight.
//   v11  3a56e79b217a3949f7180069e6769bc3fa031167  package 0.7.0, link 11: the commit tag v0.7.0 points at.
//
// Run:  bun test --timeout 240000 lib/hosts/v10-upgrade.integration.test.mjs
// Needs: full git history (`git cat-file -e <sha>`), `tar` and `git` on PATH, node >= 24 on PATH, `npm ci` done in this
// checkout (daemon dependencies are symlinked from its node_modules), a POSIX machine (Linux or macOS).
// Disposable stand-ins besides delivery: one POSIX `omp` script (OMP_WEB_OMP_BIN) that answers `--version`, `--check` and
// the session start with the runner's channel hello, so the v11 updater's real `fetch-omp` and `preflight` of the candidate
// pass without the runner binary (no `bun runner/scripts/build-binary.ts` needed) or any network.
// Not covered: compiled-binary installs, systemd/launchd-supervised hosts, Windows, a daemon with live sessions (a legacy
// link carries none; the old busy checks are its own unchanged code). The server side serves only /api/hosts/link, so the
// upgraded daemon's maintenance connection is refused there; its application link and health acknowledgement are real.
// Cleanup: each scenario kills every process whose command line names its directory (daemons, detached workers, the
// stand-in sharing the install) and the file kills the rest; the run fails if any survives. A crash of the test runner
// itself can leave detached daemons running under the system temp directory (v10-upgrade-it-*): kill them by that path.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeBinary, repo, repoVersion, spawnNodeOutsideService } from "./update-fixture.test-helper.mjs";

const LEGACY = {
  v10: { name: "v10", link: 10, version: "0.6.0", commit: "546a945df0d1716a7a135d6e3221ba885b00171e" },
  v11: { name: "v11", link: 11, version: "0.7.0", commit: "3a56e79b217a3949f7180069e6769bc3fa031167" },
};
/** The application link version this release speaks, and the only target compatibility an old updater may be given. */
const APPLICATION = 12;

const base = realpathSync(mkdtempSync(join(tmpdir(), "v10-upgrade-it-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(base, "main-agent");

const linkRoute = await import("../../app/api/hosts/link/route.ts");
const hub = await import("./hub.ts");
const { createHost } = await import("./registry.ts");
const { closeNotificationStore } = await import("../notification-store.ts");
const { CHANNEL_PROTO } = await import("./omp-socket.ts");

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Every line the hub sends each host, in order, so the old daemon's whole view of the server can be asserted.
const down = new Map();
const wrappers = new WeakMap();
/** The hub keys its state on socket identity: one stable wrapper per socket, recording what it sends. */
function wrap(ws) {
  let wrapper = wrappers.get(ws);
  if (wrapper) return wrapper;
  const send = (frame, ...rest) => {
    if (typeof frame === "string") {
      for (const line of frame.split("\n")) if (line) down.set(ws.data.hostId, [...(down.get(ws.data.hostId) ?? []), JSON.parse(line)]);
    }
    return ws.send(frame, ...rest);
  };
  wrapper = new Proxy(ws, { get: (target, name) => name === "send" ? send : typeof target[name] === "function" ? target[name].bind(target) : target[name] });
  wrappers.set(ws, wrapper);
  return wrapper;
}
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/api/hosts/link": {
      GET: (req) => linkRoute.GET(req, { upgrade: (data) => server.upgrade(req, { data }) }),
      POST: (req) => linkRoute.POST(req),
    },
  },
  websocket: {
    ...hub.hostLinkSocket,
    message: (ws, data) => hub.hostLinkSocket.message(wrap(ws), data),
    drain: (ws) => hub.hostLinkSocket.drain(wrap(ws)),
    close: (ws) => hub.hostLinkSocket.close(wrap(ws)),
  },
});

/** Pids of every process whose command line names `dir`: daemons, workers and stand-ins all run files from inside it. */
function processesUnder(dir) {
  const lines = process.platform === "linux"
    ? readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try { return [[Number(name), readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ")]]; } catch { return []; }
    })
    : spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match ? [[Number(match[1]), match[2]]] : [];
    });
  return lines.filter(([pid, command]) => pid !== process.pid && command.includes(dir)).map(([pid]) => pid);
}
async function stopAll(dir) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pid of processesUnder(dir)) { try { process.kill(pid, signal); } catch { /* already gone */ } }
    for (const deadline = Date.now() + 10_000; processesUnder(dir).length > 0 && Date.now() < deadline;) await wait(100);
  }
  assert.deepEqual(processesUnder(dir), [], "every process this test started must exit before its directory is removed");
}

after(async () => {
  await stopAll(base);
  await server.stop(true);
  closeNotificationStore();
  hub.flushLinkSamples();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true }); } catch (error) {
      if (tries === 50 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      await wait(100);
    }
  }
});

const haveCommit = (commit) => spawnSync("git", ["-C", repo, "cat-file", "-e", `${commit}^{commit}`]).status === 0;

const sources = new Map();
/** `bin`, `lib` and package.json of the pinned commit: everything `omp-web-host.js` loads. */
function legacySource(legacy) {
  if (sources.has(legacy.commit)) return sources.get(legacy.commit);
  const dir = join(base, `source-${legacy.name}`);
  mkdirSync(dir);
  const archive = `${dir}.tar`;
  // umask 0022: the updater refuses an install directory that is group-writable.
  execFileSync("git", ["-C", repo, "-c", "tar.umask=0022", "archive", "--format=tar", "-o", archive, legacy.commit, "bin", "lib", "package.json"]);
  execFileSync("tar", ["-xf", archive, "-C", dir, "--no-same-owner"]);
  // The pin must be the daemon this test claims to run.
  assert.equal(read(join(dir, "package.json")).version, legacy.version);
  assert.match(readFileSync(join(dir, "lib", "hosts", "link-protocol.ts"), "utf8"), new RegExp(`^export const LINK_PROTOCOL_VERSION = ${legacy.link};$`, "m"));
  sources.set(legacy.commit, dir);
  return dir;
}

let releaseDir;
/** This checkout as the release the fake npm delivers: what `npm install @kahme247/ompweb@<repoVersion>` would unpack. */
function release() {
  if (releaseDir) return releaseDir;
  releaseDir = join(base, "release");
  mkdirSync(releaseDir);
  cpSync(join(repo, "bin"), join(releaseDir, "bin"), { recursive: true });
  cpSync(join(repo, "lib"), join(releaseDir, "lib"), { recursive: true, filter: (src) => !/\.test(-helper)?\.(mjs|ts|tsx)$/.test(src) });
  cpSync(join(repo, "package.json"), join(releaseDir, "package.json"));
  return releaseDir;
}

const preload = join(base, "release-delivery.mjs");
// The only network the old updater sees: the npm registry's latest version and the target tag's raw link-protocol.ts.
writeFileSync(preload, `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const real = globalThis.fetch;
const dir = process.env.UPGRADE_FIXTURE_DIR;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  appendFileSync(dir + "/fetch.log", url + "\\n");
  if (url.startsWith("https://registry.npmjs.org/")) return Response.json({ version: process.env.UPGRADE_FIXTURE_VERSION });
  if (/^https:\\/\\/raw\\.githubusercontent\\.com\\/[^/]+\\/[^/]+\\/v[^/]+\\/lib\\/hosts\\/link-protocol\\.ts$/.test(url)) {
    const override = dir + "/link-protocol.override";
    return new Response(readFileSync(existsSync(override) ? override : process.env.UPGRADE_FIXTURE_PROTOCOL_SOURCE));
  }
  if (/^http:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])[:/]/.test(url)) return real(input, init);
  throw new Error("upgrade fixture: no network access to " + url);
};
`);

/** Installs the pinned daemon as a real npm-layout host, logs it into the hub and starts it. Null when no scope is available. */
async function startLegacy(legacy, layout) {
  const work = join(base, `${legacy.name}-${layout}`);
  const modules = join(work, "node_modules");
  const install = join(modules, "@kahme247", "ompweb");
  const home = join(work, "home");
  const agent = join(home, ".omp", "agent");
  mkdirSync(join(work, "bin"), { recursive: true });
  mkdirSync(modules, { recursive: true });
  mkdirSync(agent, { recursive: true });
  // The daemon's dependencies, resolved from the node_modules above the install as for any hoisted global install.
  for (const name of readdirSync(join(repo, "node_modules"))) {
    if (!name.startsWith(".")) symlinkSync(realpathSync(join(repo, "node_modules", name)), join(modules, name), "dir");
  }
  cpSync(legacySource(legacy), install, { recursive: true });
  for (let dir = install; dir !== dirname(work); dir = dirname(dir)) chmodSync(dir, 0o755);
  const fakeOmp = join(work, "fake-omp");
  // One stand-in for both omp roles an update touches: the version/update probes of the old daemon, and the session omp
  // that the candidate's `ompweb preflight` (run by the v11 updater before its switch) must see say hello.
  writeFileSync(fakeOmp, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 14.0.0-fake; exit 0; fi
case "$*" in *--check*) echo "Current version: 14.0.0-fake"; exit 0;; esac
case "$*" in *"--headless --cwd "*"--no-session"*) echo '{"t":"hello","proto":${CHANNEL_PROTO}}'; exec cat >/dev/null;; esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(work, "idle.js"), "setInterval(() => {}, 1000);\n");
  writeFileSync(join(work, "bin", "npm"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(work, "npm.log"))}, JSON.stringify(args) + "\\n");
if (!args.includes(${JSON.stringify(`@kahme247/ompweb@${repoVersion}`)})) process.exit(8);
fs.cpSync(${JSON.stringify(release())}, path.join(args[args.indexOf("--prefix") + 1], "node_modules", "@kahme247", "ompweb"), { recursive: true });
`, { mode: 0o700 });

  const { host, token } = createHost(`${legacy.name} ${layout}`);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, OMP_WEB_OMP_BIN: fakeOmp, OMP_WEB_PACKAGE_DIR: install,
    PATH: join(work, "bin") + delimiter + process.env.PATH,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${pathToFileURL(preload).href}`].filter(Boolean).join(" "),
    UPGRADE_FIXTURE_DIR: work, UPGRADE_FIXTURE_VERSION: repoVersion, UPGRADE_FIXTURE_PROTOCOL_SOURCE: join(repo, "lib", "hosts", "link-protocol.ts"),
  };
  delete env.OMP_WEB_DISABLE_AUTOUPDATE;
  delete env.OMP_WEB_HOST_DRAINED;
  const entry = join(install, "bin", "omp-web-host.js");
  const login = spawnSync(nodeBinary(), [entry, "login", "--url", `http://127.0.0.1:${server.port}`], { env, cwd: work, input: `${token}\n`, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);

  const child = await spawnNodeOutsideService(entry, env);
  if (!child) return null;
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  child.stderr.on("data", (data) => { log += data; });
  const lines = (name) => existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8").split("\n").filter(Boolean) : [];
  return {
    legacy, layout, work, install, child, hostId: host.id, stateRoot: join(agent, "omp-web", "host-update"),
    log: () => log,
    npmCalls: () => lines("npm.log").map((line) => JSON.parse(line)),
    fetched: () => lines("fetch.log"),
    status: () => read(join(agent, "omp-web", "host-update", "status.json")),
  };
}

async function waitFor(predicate, what, run, timeoutMs = 120_000) {
  for (const deadline = Date.now() + timeoutMs; ; await wait(100)) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      const status = existsSync(join(run.stateRoot, "status.json")) ? JSON.stringify(run.status()) : "none";
      assert.fail(`timed out waiting for ${what}\nupdate status: ${status}\nnpm calls: ${JSON.stringify(run.npmCalls())}\nold daemon log:\n${run.log()}`);
    }
  }
}

/** checkUpdates through the hub. The daemon's own startup upload sweep briefly reports "Wait for ..."; any other block is the answer. */
async function checkUpdates(run) {
  for (const deadline = Date.now() + 30_000; ; await wait(500)) {
    const info = await hub.getHostSoftwareUpdates(run.hostId, true);
    if (!/^Wait for/.test(info.ompweb.blockedReason ?? "") || Date.now() > deadline) return info;
  }
}

async function upgrade(run) {
  const { legacy, layout, hostId } = run;
  const row = () => hub.listHosts().find((host) => host.id === hostId);
  const sent = () => down.get(hostId) ?? [];

  // The real old daemon is welcomed with the version it said (it throws on any other) and linked for upgrading only.
  await waitFor(() => row()?.status === "needs-upgrade" && row().upgradeOnly === true && /linked to /.test(run.log()), `the ${legacy.name} daemon to be welcomed upgrade-only`, run);
  assert.equal(row().hostVersion, legacy.link);
  assert.equal(row().ompwebVersion, legacy.version);
  assert.deepEqual([...new Set(sent().filter((message) => message.type === "welcome").map((message) => message.v))], [legacy.link]);

  if (layout === "separate") {
    // A candidate on another protocol is refused by what the old updater was told, not by a fixture shortcut.
    writeFileSync(join(run.work, "link-protocol.override"), `export const LINK_PROTOCOL_VERSION = ${APPLICATION - 1};\n`);
    const wrong = await checkUpdates(run);
    assert.equal(wrong.ompweb.protocolVersion, APPLICATION - 1);
    assert.equal(wrong.ompweb.canUpdate, false);
    rmSync(join(run.work, "link-protocol.override"));
  }

  let installBefore;
  let web;
  if (layout === "shared") {
    // The web package shares this installation, and has not replaced it yet: nothing may be installed over it.
    web = spawn(nodeBinary(), [join(run.work, "idle.js"), join(run.install, "package.json")], { stdio: "ignore", cwd: run.work });
    const stale = await checkUpdates(run);
    assert.equal(stale.ompweb.canUpdate, false);
    assert.match(stale.ompweb.blockedReason, /installation is shared/);
    await assert.rejects(hub.updateHostSoftware(hostId, "ompweb", repoVersion));
    assert.deepEqual(run.npmCalls(), []);
    // `npm i -g` of the web package: the shared installation now holds the candidate while the old daemon keeps running.
    for (const name of readdirSync(run.install)) rmSync(join(run.install, name), { recursive: true, force: true });
    cpSync(release(), run.install, { recursive: true });
    chmodSync(run.install, 0o755);
    installBefore = { directory: statSync(run.install).ino, manifest: statSync(join(run.install, "package.json")) };
  }

  const info = await checkUpdates(run);
  assert.equal(info.ompweb.currentVersion, legacy.version);
  assert.equal(info.ompweb.availableVersion, repoVersion);
  assert.equal(info.ompweb.updateAvailable, true);
  assert.equal(info.ompweb.protocolVersion, APPLICATION);
  assert.equal(info.ompweb.canUpdate, true, info.ompweb.blockedReason);

  const accepted = await hub.updateHostSoftware(hostId, "ompweb", repoVersion);
  assert.deepEqual({ target: accepted.operation.target, version: accepted.operation.version }, { target: "ompweb", version: repoVersion });
  await waitFor(() => existsSync(join(run.stateRoot, "status.json")) && run.status().operation.state !== "running", "the old updater to finish", run);
  const { operation, daemonPid } = run.status();
  assert.equal(operation.state, "succeeded", operation.error);
  await waitFor(() => row()?.status === "online" && row().hostVersion === APPLICATION && row().ompwebVersion === repoVersion, "the upgraded daemon to link at the application version", run);
  assert.equal(row().upgradeOnly, undefined);
  assert.equal(hub.getHostLinkProtocol(hostId), APPLICATION);
  await waitFor(() => run.child.exitCode !== null || run.child.signalCode !== null, "the old daemon to stop", run);
  const health = read(join(run.stateRoot, operation.id, "health.json"));
  assert.equal(health.version, repoVersion);
  assert.notEqual(health.pid, daemonPid);
  assert.ok(alive(health.pid), "the new daemon keeps running");
  assert.equal(read(join(run.install, "package.json")).version, repoVersion);

  const backups = readdirSync(dirname(run.install)).filter((name) => name.startsWith(".ompweb-backup-"));
  if (layout === "separate") {
    assert.equal(run.npmCalls().length, 1);
    assert.ok(run.npmCalls()[0].includes(`@kahme247/ompweb@${repoVersion}`));
    assert.deepEqual(backups, [`.ompweb-backup-${operation.id}`]);
    assert.equal(read(join(dirname(run.install), backups[0], "package.json")).version, legacy.version);
  } else {
    // A shared install is restarted, never reinstalled: no package manager, no swap, no backup, and the other process lives.
    assert.deepEqual(run.npmCalls(), []);
    assert.deepEqual(backups, []);
    assert.equal(read(join(run.stateRoot, operation.id, "descriptor.json")).restartOnly, true);
    assert.equal(statSync(run.install).ino, installBefore.directory);
    const manifest = statSync(join(run.install, "package.json"));
    assert.deepEqual([manifest.ino, manifest.mtimeMs], [installBefore.manifest.ino, installBefore.manifest.mtimeMs]);
    assert.ok(alive(web.pid), "the process sharing the installation is untouched");
  }
  const candidateSource = new RegExp(`^https://raw\\.githubusercontent\\.com/[^/]+/[^/]+/v${repoVersion.replaceAll(".", "\\.")}/lib/hosts/link-protocol\\.ts$`);
  assert.ok(run.fetched().some((url) => candidateSource.test(url)), "the old updater read the target release's link protocol");

  // Everything the legacy connection ever received: transport and the two update requests, each with the one
  // compatibility an application-12 release may be reached through. The v12 welcome ends it.
  const frames = sent();
  const upgraded = frames.findIndex((message) => message.type === "welcome" && message.v === APPLICATION);
  assert.ok(upgraded > 0, "the upgraded daemon is welcomed at the application version");
  const legacyFrames = frames.slice(0, upgraded);
  assert.deepEqual([...new Set(legacyFrames.map((message) => message.type))].filter((type) => !["welcome", "ack", "ping", "pong", "req"].includes(type)), []);
  const requests = legacyFrames.filter((message) => message.type === "req");
  assert.deepEqual([...new Set(requests.map((message) => message.op))].sort(), ["checkUpdates", "updateSoftware"]);
  for (const request of requests) assert.deepEqual(request.args.compatibility, { min: APPLICATION, max: APPLICATION });
  assert.deepEqual(requests.filter((message) => message.op === "updateSoftware").map((message) => [message.args.target, message.args.version]), [["ompweb", repoVersion]]);
}

const skipWindows = process.platform === "win32" && "this proof needs git archive, symlinked dependencies and a POSIX process table";
const skipScope = "systemd-run cannot create the scope that keeps this test outside the service running the suite";
async function scenario(t, legacy, layout) {
  if (skipWindows) return t.skip(skipWindows);
  if (!haveCommit(legacy.commit)) return t.skip(`commit ${legacy.commit} (${legacy.name} daemon) is not in this clone; fetch full history`);
  const run = await startLegacy(legacy, layout);
  if (!run) return t.skip(skipScope);
  try { await upgrade(run); } finally { await stopAll(run.work); }
}

test("v10 daemon (546a945d) is welcomed as v10 and upgraded by its own updater to a separate v12 install", { timeout: 240_000 }, (t) => scenario(t, LEGACY.v10, "separate"));
test("v10 daemon (546a945d) on an installation the web package already replaced is restarted, not reinstalled", { timeout: 240_000 }, (t) => scenario(t, LEGACY.v10, "shared"));
test("v11 daemon (v0.7.0) is welcomed as v11 and upgraded by its own updater to a separate v12 install", { timeout: 240_000 }, (t) => scenario(t, LEGACY.v11, "separate"));
test("v11 daemon (v0.7.0) on an installation the web package already replaced is restarted, not reinstalled", { timeout: 240_000 }, (t) => scenario(t, LEGACY.v11, "shared"));
