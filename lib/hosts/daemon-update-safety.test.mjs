import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ompweb-daemon-update-safety-")));
const env = { ...process.env };
const argv = [...process.argv];
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const root = join(scratch, "agent", "omp-web", "host-update");
mkdirSync(root, { recursive: true, mode: 0o700 });
const binary = join(scratch, process.platform === "win32" ? "omp.cmd" : "omp");
const script = `if(process.argv.includes('--version')){console.log('18.0.0');process.exit(0)};if(process.argv.includes('--check')){console.log('Current version: 18.0.0');process.exit(0)};const emit=(f)=>process.stdout.write(JSON.stringify(f)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',(l)=>{const c=JSON.parse(l);if(c.t==='cmd')emit({t:'res',id:c.id,ok:true,data:{}})});setImmediate(()=>emit({t:'hello',proto:1,pid:process.pid,sessionId:require('node:crypto').randomUUID(),cwd:process.cwd()}));`;
if (process.platform === "win32") {
  writeFileSync(binary + ".cjs", script);
  writeFileSync(binary, `@"${process.execPath}" "${binary}.cjs" %*\r\n`);
} else writeFileSync(binary, `#!${process.execPath}\n${script}`, { mode: 0o755 });
process.env.OMP_WEB_OMP_BIN = binary;
delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
const { runHostDaemon } = await import("./daemon.ts");
const { localHost } = await import("./local-host.ts");
const { LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
const packageJson = (await import("../../package.json", { with: { type: "json" } })).default;
let listener;
let upSeq;
let downSeq;
let replies;
let welcomed;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req, server) { return server.upgrade(req) ? undefined : new Response("Upgrade required", { status: 426 }); },
  websocket: {
    open(ws) { listener = ws; },
    message(ws, raw) {
      for (const line of String(raw).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.type === "hello") { welcomed = true; ws.send(JSON.stringify({ type: "welcome", v: LINK_PROTOCOL_VERSION, hostId: "fixture" }) + "\n"); }
        else if (m.type === "ping") ws.send('{"type":"pong"}\n');
        else if (m.type === "res") replies.set(m.id, m);
        if (typeof m.seq === "number") { upSeq = Math.max(upSeq, m.seq); ws.send(JSON.stringify({ type: "ack", ack: upSeq }) + "\n"); }
      }
    },
  },
});
after(() => { server.stop(true); process.env = env; process.argv = argv; rmSync(scratch, { recursive: true, force: true }); });
const until = async (condition, label) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(label); await new Promise((done) => setTimeout(done, 10)); }
};
async function start(t) {
  replies = new Map(); upSeq = downSeq = 0; welcomed = false;
  const daemon = runHostDaemon({ url: `http://127.0.0.1:${server.port}`, token: "fixture", allowHttp: false });
  t.after(async () => { await daemon.stop(); rmSync(join(root, "status.json"), { force: true }); });
  await until(() => welcomed, "daemon did not link");
  // A round trip ensures the daemon processed welcome before a test replaces its update state.
  await request("invalidateSessionLists", {});
  return daemon;
}
async function request(op, args) {
  const id = "req-" + (++downSeq);
  listener.send(JSON.stringify({ type: "req", seq: downSeq, id, op, args }) + "\n");
  await until(() => replies.has(id), "daemon did not answer " + op);
  return replies.get(id);
}
const spawn = () => request("open", { sessionId: null, launch: { cwd: scratch, recordedCwd: null, sessionFile: "", advisor: false } });
const state = (id) => ({ operation: { id, target: "ompweb", version: "99.0.0", state: "running" }, daemonPid: process.pid + 100000, workerPid: process.pid, startedAt: Date.now() });

test("daemon refuses new sessions while a persisted daemon update is running", async (t) => {
  await start(t);
  writeFileSync(join(root, "status.json"), JSON.stringify(state("spawn-block")), { mode: 0o600 });
  const answer = await spawn("blocked");
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "host_updating");
});

/** An npm-installed host whose daemon update is otherwise allowed, so only the session guard can block it. */
function updatableInstall(t) {
  const install = join(scratch, "node_modules", "@kahme247", "ompweb");
  mkdirSync(join(install, "bin"), { recursive: true });
  const launcher = join(install, "bin", "omp-web-host.js");
  writeFileSync(launcher, "");
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: packageJson.version }));
  const oldPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const oldFetch = globalThis.fetch;
  process.env.OMP_WEB_PACKAGE_DIR = install;
  process.argv = [process.execPath, launcher];
  globalThis.fetch = async (url) => String(url).startsWith("https://registry.npmjs.org/")
    ? Response.json({ version: "99.0.0" }) : new Response(`export const LINK_PROTOCOL_VERSION = ${LINK_PROTOCOL_VERSION};\n`);
  t.after(() => { globalThis.fetch = oldFetch; process.argv = argv; if (oldPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR; else process.env.OMP_WEB_PACKAGE_DIR = oldPackage; });
}
const checkUpdates = () => request("checkUpdates", { compatibility: { min: LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION }, force: true });

test("an owned session makes the configured daemon restart guard block the update check", async (t) => {
  updatableInstall(t);
  await start(t);
  assert.equal((await spawn("owned")).ok, true);
  const answer = await checkUpdates();
  assert.equal(answer.ok, true);
  assert.equal(answer.result.ompweb.canUpdate, false);
  assert.match(answer.result.ompweb.blockedReason, /sessions|subagents/i);
});

test("a session still starting also blocks the update check, and stops blocking once it fails", async (t) => {
  updatableInstall(t);
  await start(t);
  const realSpawn = localHost.spawnRpc;
  const gate = Promise.withResolvers();
  localHost.spawnRpc = async () => { await gate.promise; throw new Error("spawn failed"); };
  t.after(() => { localHost.spawnRpc = realSpawn; });
  const starting = spawn("starting");
  const held = await checkUpdates();
  assert.equal(held.result.ompweb.canUpdate, false, "a spawn not yet registered as a channel must still count");
  assert.match(held.result.ompweb.blockedReason, /sessions|subagents/i);
  gate.resolve();
  assert.equal((await starting).ok, false);
  // Only the session reason must go: a suite running inside a systemd service is still blocked by that service.
  assert.doesNotMatch((await checkUpdates()).result.ompweb.blockedReason ?? "", /sessions|subagents/i);
});

test("a daemon welcome writes the real updater health acknowledgement", async (t) => {
  const id = "welcome-health";
  const attempt = join(root, id);
  mkdirSync(attempt, { mode: 0o700 });
  writeFileSync(join(root, "status.json"), JSON.stringify(state(id)), { mode: 0o600 });
  writeFileSync(join(attempt, "descriptor.json"), JSON.stringify({ id, version: "99.0.0", fromVersion: packageJson.version }), { mode: 0o600 });
  await start(t);
  await until(() => existsSync(join(attempt, "health.json")), "welcome did not acknowledge updater health");
  const health = JSON.parse(readFileSync(join(attempt, "health.json"), "utf8"));
  assert.equal(health.id, id);
  assert.equal(health.version, packageJson.version);
  assert.equal(health.pid, process.pid);
});

test("a malformed update status does not prevent ordinary host sessions from starting", async (t) => {
  await start(t);
  writeFileSync(join(root, "status.json"), "{broken", { mode: 0o600 });
  assert.equal((await spawn("normal")).ok, true);
});

test("the daemon refuses an omp update: omp updates only with ompweb", async (t) => {
  updatableInstall(t);
  await start(t);
  const answer = await request("updateSoftware", { target: "omp", version: "99.0.0", compatibility: { min: LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION } });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "invalid_request");
  assert.equal(existsSync(join(root, "status.json")), false, "no update operation was started");
});

test("local drain refuses an accepted native check without making that check block itself", async (t) => {
  updatableInstall(t);
  const daemon = await start(t);
  const response = globalThis.fetch;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis.fetch = async (...args) => {
    if (String(args[0]).startsWith("https://registry.npmjs.org/")) {
      entered.resolve();
      await release.promise;
    }
    return response(...args);
  };
  t.after(() => { release.resolve(); globalThis.fetch = response; });
  const checking = checkUpdates();
  await entered.promise;
  try {
    assert.throws(() => daemon.control("drain"), { code: "host_busy" });
    assert.equal(daemon.control("status").drained, false);
  } finally {
    release.resolve();
  }
  const answer = await checking;
  assert.equal(answer.ok, true);
  assert.doesNotMatch(answer.result.ompweb.blockedReason ?? "", /pending|operation|drain/i, "native check does not count itself as ordinary work");
});

test("a persisted running native update blocks local drain without changing admission", async (t) => {
  const daemon = await start(t);
  writeFileSync(join(root, "status.json"), JSON.stringify(state("local-drain-block")), { mode: 0o600 });
  assert.throws(() => daemon.control("drain"), { code: "host_busy" });
  assert.equal(daemon.control("status").drained, false);
});

test("local drain also refuses a native update request before its asynchronous check is persisted", async (t) => {
  updatableInstall(t);
  const daemon = await start(t);
  const response = globalThis.fetch;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis.fetch = async (...args) => {
    if (String(args[0]).startsWith("https://registry.npmjs.org/")) {
      entered.resolve();
      await release.promise;
    }
    return response(...args);
  };
  t.after(() => { release.resolve(); globalThis.fetch = response; });
  // This candidate deliberately differs from the available 99.0.0, so no update worker can be launched.
  const updating = request("updateSoftware", { target: "ompweb", version: "98.0.0", compatibility: { min: LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION } });
  await entered.promise;
  try {
    assert.throws(() => daemon.control("drain"), { code: "host_busy" });
    assert.equal(daemon.control("status").drained, false);
  } finally {
    release.resolve();
  }
  const answer = await updating;
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "candidate_changed");
});

test("a forced update accepts new sessions while it stages and refuses them from its commit", async (t) => {
  await start(t);
  const forced = (committing) => { const value = state("forced"); return { ...value, operation: { ...value.operation, force: true, ...(committing ? { committing: true } : {}) } }; };
  writeFileSync(join(root, "status.json"), JSON.stringify(forced(false)), { mode: 0o600 });
  assert.equal((await spawn()).ok, true, "staging does not idle the host");
  writeFileSync(join(root, "status.json"), JSON.stringify(forced(true)), { mode: 0o600 });
  const refused = await spawn();
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "host_updating");
});

test("the native update request takes force only as an explicit boolean, an operation id only as a UUID and a target range only as a protocol range", async (t) => {
  updatableInstall(t);
  await start(t);
  const compatibility = { min: LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION };
  const update = { target: "ompweb", version: "99.0.0", compatibility };
  for (const extra of [{ force: "yes" }, { operationId: "not-a-uuid" }, { operationId: 7 }, { targetCompatibility: { min: 1 } }]) {
    const answer = await request("updateSoftware", { ...update, ...extra });
    assert.equal(answer.ok, false, JSON.stringify(extra));
    assert.equal(answer.error.code, "invalid_request", JSON.stringify(extra));
  }
  assert.equal((await request("checkUpdates", { compatibility, targetCompatibility: { min: 1 } })).error.code, "invalid_request");
  assert.equal(existsSync(join(root, "status.json")), false, "no update operation was started");
});
