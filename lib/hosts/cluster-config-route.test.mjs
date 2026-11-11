import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { mock } from "bun:test";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-cluster-config-route-test-")));
const agentDir = join(scratch, "agent");
const homeDir = join(scratch, "home");
mkdirSync(agentDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", "OMP_WEB_OMP_BIN"].map((name) => [name, process.env[name]]));
// A fake omp prints plugins.json, so the plugin list is the test's to choose.
const pluginsFile = join(scratch, "plugins.json");
const fakeOmp = join(scratch, "omp");
writeFileSync(pluginsFile, '{"npm":[],"marketplace":[]}');
// Counts its runs (one byte each) in `counts`, and fails the way omp does, on stderr, when plugins.json says FAIL.
const countFile = join(scratch, "counts");
writeFileSync(
  fakeOmp,
  `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(countFile)}, "x");\nconst out = fs.readFileSync(${JSON.stringify(pluginsFile)}, "utf8");\nif (out === "FAIL") { console.error("secret omp output"); process.exit(1); }\nprocess.stdout.write(out);`,
  { mode: 0o755 },
);
Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, HOME: homeDir, USERPROFILE: homeDir, OMP_WEB_OMP_BIN: fakeOmp });
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

// Every readFileSync outside omp-web's own state files is a configuration read. Copies of the real modules: Bun patches
// the live namespaces in place, so a wrapper calling them would otherwise call itself. Bun's homedir() reads HOME only
// at startup, so it is mocked too; "fs" and "node:fs" are separate mock keys.
const realFs = { ...(await import("node:fs")) };
const realOs = { ...(await import("node:os")) };
const configReads = [];
const mockedFs = () => ({
  ...realFs,
  readFileSync(path, ...rest) {
    if (typeof path === "string" && path.startsWith(scratch) && !path.startsWith(join(agentDir, "omp-web"))) configReads.push(path);
    return realFs.readFileSync(path, ...rest);
  },
});
const mockedOs = () => ({ ...realOs, homedir: () => homeDir });
for (const name of ["fs", "node:fs"]) mock.module(name, mockedFs);
for (const name of ["os", "node:os"]) mock.module(name, mockedOs);
const manifestRoute = await import("../../app/api/hosts/cluster-config/manifest/route.ts");
const fileRoute = await import("../../app/api/hosts/cluster-config/file/[hash]/route.ts");
const { createHost, revokeHost, rotateLocalHostToken } = await import("./registry.ts");
const { savePools } = await import("./pools.ts");

const hostsFile = join(agentDir, "omp-web", "hosts.json");
const poolsFile = join(agentDir, "omp-web", "pools.json");

const authorized = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const getManifest = (token) => manifestRoute.GET(new Request("http://main.test/api/hosts/cluster-config/manifest", authorized(token)));
const getFile = (token, hash) =>
  fileRoute.GET(new Request(`http://main.test/api/hosts/cluster-config/file/${hash}`, authorized(token)), { params: Promise.resolve({ hash }) });

/** Moves the clock past the plugin list's 30 s lifetime. */
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
const expirePluginList = () => { skew += 31_000; };

function clusterMember() {
  const { host, token } = createHost("member");
  savePools([{ id: "cluster", label: "cluster", enabled: true, projects: [], members: [{ hostId: host.id, projectsRoot: "/srv/p", provisioned: true, draining: false }] }]);
  return token;
}

beforeEach(() => {
  rmSync(poolsFile, { force: true });
  for (const entry of ["AGENTS.md", "config.yml", "skills"]) rmSync(join(agentDir, entry), { recursive: true, force: true });
  rmSync(join(homeDir, ".agents"), { recursive: true, force: true });
  rmSync(join(scratch, "linked"), { recursive: true, force: true });
  writeFileSync(join(agentDir, "AGENTS.md"), "master rules\n");
  writeFileSync(join(agentDir, "config.yml"), "theme: dark\n");
  mkdirSync(join(agentDir, "skills", "s"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "s", "SKILL.md"), "skill\n");
  mkdirSync(join(homeDir, ".agents", "skills", "h"), { recursive: true });
  writeFileSync(join(homeDir, ".agents", "skills", "h", "SKILL.md"), "home skill\n");
});

// These two run first: the plugin list is module state, and "none ever read" only holds before the first success.
test("with no plugin list ever read, a failing omp is 409 unreadable and concurrent requests run it once", async () => {
  const token = clusterMember();
  writeFileSync(pluginsFile, "FAIL");
  writeFileSync(countFile, "");
  const responses = await Promise.all([getManifest(token), getManifest(token)]);
  for (const response of responses) {
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "unreadable");
    assert.doesNotMatch(body.error, /secret omp output/);
  }
  assert.equal(realFs.readFileSync(countFile, "utf8").length, 1);
});

test("a failure after a success keeps serving the last good plugin list", async () => {
  const token = clusterMember();
  writeFileSync(countFile, "");
  writeFileSync(pluginsFile, '{"npm":[{"name":"omp-keep","version":"1.0.0","enabled":true}],"marketplace":[]}');
  assert.deepEqual((await (await getManifest(token)).json()).plugins.map((plugin) => plugin.id), ["omp-keep"]);
  writeFileSync(pluginsFile, "FAIL");
  expirePluginList();
  const response = await getManifest(token);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).plugins.map((plugin) => plugin.id), ["omp-keep"]);
  assert.equal(realFs.readFileSync(countFile, "utf8").length, 2);
  await getManifest(token); // the failed read is not retried at once
  assert.equal(realFs.readFileSync(countFile, "utf8").length, 2);
});

test("no token and an unknown token are 401", async () => {
  for (const token of [undefined, "not-a-host-token"]) {
    for (const response of [await getManifest(token), await getFile(token, "a".repeat(64))]) assert.equal(response.status, 401);
  }
});

test("a linked host that is not a cluster member is 403", async () => {
  const { token } = createHost("outsider");
  for (const response of [await getManifest(token), await getFile(token, "a".repeat(64))]) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Not a cluster member" });
  }
});

test("the local record's token is 403 even when pools.json lists it", async () => {
  const localToken = rotateLocalHostToken();
  savePools([{ id: "cluster", label: "cluster", enabled: true, projects: [], members: [{ hostId: "local", projectsRoot: "/srv/p", provisioned: true, draining: false }] }]);
  assert.equal((await getManifest(localToken)).status, 403);
});

test("an unreadable hosts.json or pools.json is 503", async () => {
  const token = clusterMember();
  writeFileSync(poolsFile, "{not json");
  assert.equal((await getManifest(token)).status, 503);
  assert.equal((await getFile(token, "a".repeat(64))).status, 503);
  const hosts = realFs.readFileSync(hostsFile, "utf8");
  writeFileSync(hostsFile, "{not json");
  try {
    assert.equal((await getManifest(token)).status, 503);
  } finally {
    writeFileSync(hostsFile, hosts);
  }
});

test("a member gets the manifest and each listed file by hash", async () => {
  writeFileSync(pluginsFile, '{"npm":[{"name":"omp-foo","version":"1.0.0","enabled":true}],"marketplace":[]}');
  expirePluginList();
  const token = clusterMember();
  const response = await getManifest(token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const manifest = await response.json();
  assert.deepEqual(manifest.files.map((file) => `${file.root}:${file.path}`), ["agent:AGENTS.md", "agent:config.yml", "agent:skills/s/SKILL.md", "home:.agents/skills/h/SKILL.md"]);
  assert.deepEqual(manifest.plugins, [{ kind: "npm", id: "omp-foo", version: "1.0.0", enabled: true }]);
  const expected = { "AGENTS.md": "master rules\n", "skills/s/SKILL.md": "skill\n", ".agents/skills/h/SKILL.md": "home skill\n" };
  for (const file of manifest.files) {
    if (!(file.path in expected)) continue;
    const served = await getFile(token, file.hash);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "application/octet-stream");
    assert.equal(await served.text(), expected[file.path]);
  }
});

test("a hash that is not in the manifest, or not a hash, is 404", async () => {
  const token = clusterMember();
  for (const hash of ["a".repeat(64), "../x", "a".repeat(63), "A".repeat(64), "a".repeat(65)]) assert.equal((await getFile(token, hash)).status, 404, hash);
});

test("a master file over the limit is 409 file_too_large on the manifest", async () => {
  const token = clusterMember();
  writeFileSync(join(agentDir, "AGENTS.md"), Buffer.alloc(5_242_881));
  const response = await getManifest(token);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "file_too_large");
  assert.equal(typeof body.error, "string");
});

test("a changed file gives a new version, and its old hash is 404", async () => {
  const token = clusterMember();
  const first = await (await getManifest(token)).json();
  const old = first.files.find((file) => file.path === "AGENTS.md");
  assert.equal((await getFile(token, old.hash)).status, 200);
  writeFileSync(join(agentDir, "AGENTS.md"), "master rules, edited\n");
  const second = await (await getManifest(token)).json();
  assert.notEqual(second.version, first.version);
  assert.equal((await getFile(token, old.hash)).status, 404);
  const fresh = second.files.find((file) => file.path === "AGENTS.md");
  assert.equal(await (await getFile(token, fresh.hash)).text(), "master rules, edited\n");
});

test("a file edited inside a linked directory gives a new version", async () => {
  const token = clusterMember();
  mkdirSync(join(scratch, "linked"), { recursive: true });
  writeFileSync(join(scratch, "linked", "SKILL.md"), "one\n");
  symlinkSync(join(scratch, "linked"), join(agentDir, "skills", "l"));
  const first = await (await getManifest(token)).json();
  assert.ok(first.files.some((file) => file.path === "skills/l/SKILL.md"));
  writeFileSync(join(scratch, "linked", "SKILL.md"), "two, longer\n");
  assert.notEqual((await (await getManifest(token)).json()).version, first.version);
});

test("an unchanged tree is not read again", async () => {
  const token = clusterMember();
  writeFileSync(join(agentDir, "AGENTS.md"), "something new\n"); // a change, so the first call below must build
  configReads.length = 0;
  const first = await (await getManifest(token)).json();
  assert.ok(configReads.length > 0, "the first call reads the files");
  configReads.length = 0;
  const second = await (await getManifest(token)).json();
  assert.equal(second.version, first.version);
  assert.deepEqual(configReads, []);
});

test("a file replaced by rename, with the same size and modification time, gives a new version", async () => {
  const token = clusterMember();
  const original = join(agentDir, "AGENTS.md");
  const fixed = 1_700_000_000;
  writeFileSync(original, "aaaa\n");
  utimesSync(original, fixed, fixed);
  const first = await (await getManifest(token)).json();
  const replacement = join(agentDir, "AGENTS.md.new");
  writeFileSync(replacement, "bbbb\n");
  utimesSync(replacement, fixed, fixed);
  renameSync(replacement, original);
  assert.notEqual((await (await getManifest(token)).json()).version, first.version);
});

test("a revoked host gets 401 on its next file request", async () => {
  const { host, token } = createHost("revoked");
  savePools([{ id: "cluster", label: "cluster", enabled: true, projects: [], members: [{ hostId: host.id, projectsRoot: "/srv/p", provisioned: true, draining: false }] }]);
  const { files } = await (await getManifest(token)).json();
  assert.equal((await getFile(token, files[0].hash)).status, 200);
  assert.equal(revokeHost(host.id), true);
  assert.equal((await getFile(token, files[0].hash)).status, 401);
  assert.equal((await getManifest(token)).status, 401);
});

test("a host removed from the cluster gets 403 on its next request", async () => {
  const token = clusterMember();
  const { files } = await (await getManifest(token)).json();
  assert.equal((await getFile(token, files[0].hash)).status, 200);
  rmSync(poolsFile);
  assert.equal((await getFile(token, files[0].hash)).status, 403);
  assert.equal((await getManifest(token)).status, 403);
});
