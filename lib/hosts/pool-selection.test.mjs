import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { loadPools, savePools, selectPoolHost } from "./pools.ts";

const scratch = mkdtempSync(join(tmpdir(), "omp-web-pools-test-"));
const environmentKeys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
// Isolate every path override before the first call that discovers agent state.
for (const key of environmentKeys) delete process.env[key];
process.env.HOME = join(scratch, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.XDG_CONFIG_HOME = join(scratch, "config");
process.env.XDG_DATA_HOME = join(scratch, "data");

const configDirectory = join(process.env.PI_CODING_AGENT_DIR, "omp-web");
const configFile = join(configDirectory, "pools.json");
after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => rmSync(configDirectory, { recursive: true, force: true }));

const GiB = 1024 ** 3;
const now = 100_000;
const member = (hostId, overrides = {}) => ({ hostId, projectsRoot: `/srv/${hostId}/projects`, provisioned: true, draining: false, ...overrides });
const pool = (members = [member("host-a"), member("host-b")], overrides = {}) => ({ id: "workers", label: "Workers", enabled: true, members, projects: [], ...overrides });
const snapshot = (sample = {}, overrides = {}) => ({
  status: "online",
  linkProtocol: 8,
  configCurrent: true,
  capacity: {
    sample: { effectiveCpus: 4, load1: 0, busyFraction: 0, stealFraction: 0, availableMemoryBytes: 8 * GiB, activeSessions: 0, ...sample },
    receivedAt: now,
  },
  ...overrides,
});
const snapshots = (a = snapshot(), b = snapshot()) => new Map([["host-a", a], ["host-b", b]]);
const choose = (configured, reports, pending = new Map()) => selectPoolHost(configured, reports, pending, now);

for (const { name, a, b, pending, want } of [
  { name: "normalizes load by effective CPUs", a: { effectiveCpus: 2, load1: 2 }, b: { effectiveCpus: 4, load1: 3 }, want: "host-b" },
  { name: "adds busy and steal fractions", a: { busyFraction: 0.4, stealFraction: 0.3 }, b: { busyFraction: 0.6, stealFraction: 0.05 }, want: "host-b" },
  { name: "normalizes active turns by effective CPUs", a: { effectiveCpus: 2, activeSessions: 2 }, b: { effectiveCpus: 4, activeSessions: 3 }, want: "host-b" },
  { name: "includes pending starts in the active-turn term", a: { activeSessions: 2 }, b: { activeSessions: 3 }, pending: [["host-a", 2]], want: "host-b" },
  { name: "uses the maximum term rather than their sum", a: { load1: 2.4, busyFraction: 0.1 }, b: { load1: 2, busyFraction: 0.5, activeSessions: 2 }, want: "host-b" },
  { name: "does not count the proposed start in ranking", a: { effectiveCpus: 1 }, b: { effectiveCpus: 4, load1: 0.25 }, want: "host-a" },
  { name: "does not round distinct ranks into a tie", a: { busyFraction: 0.5000000001 }, b: { busyFraction: 0.5 }, want: "host-b" },
]) {
  test(`ranking ${name}`, () => {
    assert.equal(choose(pool(), snapshots(snapshot(a), snapshot(b)), new Map(pending)), want);
  });
}

test("equal ranks prefer more available memory before host ID", () => {
  assert.equal(choose(pool(), snapshots(snapshot({ availableMemoryBytes: 6 * GiB }), snapshot())), "host-b");
});

test("equal ranks and memory prefer host ID ascending regardless of member or snapshot order", () => {
  const reversedPool = pool([member("host-b"), member("host-a")]);
  const reversedReports = new Map([["host-b", snapshot()], ["host-a", snapshot()]]);
  assert.equal(choose(reversedPool, reversedReports), "host-a");
});

for (const [age, want] of [[15_000, "host-a"], [15_001, null]]) {
  test(`capacity age ${age} ms ${want ? "is eligible" : "is stale"}`, () => {
    const report = snapshot({}, { capacity: { ...snapshot().capacity, receivedAt: now - age } });
    assert.equal(choose(pool([member("host-a")]), new Map([["host-a", report]])), want);
  });
}

for (const [pendingStarts, memory, want] of [
  [0, 3 * GiB, "host-a"],
  [0, 3 * GiB - 1, null],
  [2, 5 * GiB, "host-a"],
  [2, 5 * GiB - 1, null],
]) {
  test(`memory admission with ${pendingStarts} pending starts and ${memory} bytes`, () => {
    assert.equal(choose(pool([member("host-a")]), new Map([["host-a", snapshot({ availableMemoryBytes: memory })]]), new Map([["host-a", pendingStarts]])), want);
  });
}

test("pending starts on another host do not consume this host's memory", () => {
  assert.equal(choose(pool([member("host-a")]), new Map([["host-a", snapshot({ availableMemoryBytes: 3 * GiB })]]), new Map([["host-b", 100]])), "host-a");
});

for (const [name, report] of [
  ["unknown host", undefined],
  ["offline host", snapshot({}, { status: "offline" })],
  ["upgrade-required host", snapshot({}, { status: "needs-upgrade" })],
  ["host without omp", snapshot({}, { status: "omp-missing" })],
  ["missing capacity", snapshot({}, { capacity: null })],
]) {
  test(`${name} is excluded even when it would outrank the eligible member`, () => {
    const reports = new Map([["host-b", snapshot({ load1: 4 })]]);
    if (report !== undefined) reports.set("host-a", report);
    assert.equal(choose(pool(), reports), "host-b");
  });
}

test("a member that is not on the master's configuration is skipped whatever its load", () => {
  assert.equal(choose(pool(), snapshots(snapshot({}, { configCurrent: false }), snapshot({ load1: 4 }))), "host-b");
  assert.equal(choose(pool(), snapshots(snapshot({}, { configCurrent: false }), snapshot({}, { configCurrent: false }))), null);
});

for (const [name, overrides] of [["unprovisioned", { provisioned: false }], ["draining", { draining: true }]]) {
  test(`${name} member is excluded despite fresh online capacity`, () => {
    assert.equal(choose(pool([member("host-a", overrides), member("host-b")]), snapshots(snapshot(), snapshot({ load1: 4 }))), "host-b");
  });
}

test("disabled pools never select a host", () => {
  assert.equal(choose(pool(undefined, { enabled: false }), snapshots()), null);
});

test("healthy unlisted hosts never join a pool or become a fallback", () => {
  const configured = pool([member("host-a")]);
  const reports = new Map([
    ["host-a", snapshot({ load1: 4 })],
    ["newly-linked", snapshot()],
    ["local", snapshot()],
    ["proxmox-4", snapshot()],
    ["proxmox-5", snapshot()],
  ]);
  assert.equal(choose(configured, reports), "host-a");
  reports.delete("host-a");
  assert.equal(choose(configured, reports), null);
  assert.equal(choose(pool([]), reports), null);
  assert.deepEqual(configured.members.map(({ hostId }) => hostId), ["host-a"]);
});

for (const [field, value] of [
  ["effectiveCpus", 0], ["effectiveCpus", -1], ["effectiveCpus", NaN], ["effectiveCpus", Infinity],
  ["load1", -1], ["load1", NaN], ["load1", Infinity],
  ["busyFraction", -0.1], ["busyFraction", NaN],
  ["stealFraction", -0.1], ["stealFraction", Infinity],
  ["availableMemoryBytes", -1], ["availableMemoryBytes", Infinity],
  ["activeSessions", -1], ["activeSessions", NaN],
]) {
  test(`invalid capacity ${field}=${value} cannot select a host`, () => {
    assert.equal(choose(pool([member("host-a")]), new Map([["host-a", snapshot({ [field]: value })]])), null);
  });
}

const configuredPool = () => pool([member("host-a")], {
  projects: [{
    id: "project-a", name: "Same display name", origin: "https://github.com/example/one.git", defaultRef: "main",
    clonePaths: { "host-a": "/srv/host-a/projects/existing-checkout" },
    addedAt: "2026-11-10T00:00:00.000Z", hidden: false, alias: "Alias", sortOrder: 2, pinOrder: 1,
    launchConfig: { profile: "work", advisor: true, extraArgs: ["--model", "test-model"] },
  }, {
    id: "project-b", name: "Same display name", origin: "git@github.com:example/two.git",
    clonePaths: { "host-a": "/srv/host-a/projects/project-b" }, addedAt: "2026-11-09T00:00:00.000Z", hidden: true,
  }],
});
const writeConfig = (value) => {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, typeof value === "string" ? value : JSON.stringify(value));
};

test("missing configuration is empty and does not create a default pool", () => {
  assert.deepEqual(loadPools(), []);
  assert.equal(existsSync(configFile), false);
});

test("worker paths use the worker's path rules, whatever OS this server runs on", () => {
  const windows = configuredPool();
  windows.members[0].projectsRoot = "D:\\work";
  windows.projects[0].clonePaths["host-a"] = "D:\\work\\existing-checkout";
  for (const configured of [[configuredPool()], [windows]]) {
    savePools(configured);
    assert.deepEqual(loadPools(), configured);
  }
  for (const root of ["D:\\", "D:work", "D:\\work\\..\\other", "/srv/../etc", "/"]) {
    const bad = configuredPool();
    bad.members[0].projectsRoot = root;
    assert.throws(() => savePools([bad]), /Invalid pool member configuration/, root);
  }
});

test("pools round-trip explicit membership, distinct project IDs, metadata and literal registered clone paths", () => {
  const configured = [configuredPool()];
  savePools(configured);
  assert.deepEqual(loadPools(), configured);
  const persisted = JSON.parse(readFileSync(configFile, "utf8"));
  assert.deepEqual(persisted.pools, configured);
  assert.deepEqual(readdirSync(configDirectory), ["pools.json"]);
  if (process.platform !== "win32") assert.equal(statSync(configFile).mode & 0o777, 0o600);
});

test("saving a replacement removes members without auto-joining known snapshots", () => {
  savePools([pool()]);
  savePools([pool([member("host-b")])]);
  const loaded = loadPools();
  assert.deepEqual(loaded[0].members.map(({ hostId }) => hostId), ["host-b"]);
  assert.equal(choose(loaded[0], snapshots(snapshot(), snapshot({ load1: 4 }))), "host-b");
  savePools([]);
  assert.deepEqual(loadPools(), []);
});

for (const text of ["{not json", "null", "{}", '{"pools":[]}']) {
  test(`corrupt or unversioned configuration fails closed: ${text}`, () => {
    writeConfig(text);
    assert.throws(() => loadPools());
    assert.equal(readFileSync(configFile, "utf8"), text);
  });
}

test("an unsupported stored version fails closed rather than silently losing pools", () => {
  savePools([configuredPool()]);
  const persisted = JSON.parse(readFileSync(configFile, "utf8"));
  persisted.version = "unsupported-future-version";
  writeConfig(persisted);
  assert.throws(() => loadPools());
});

test("an unreadable actual config path fails closed instead of becoming a local pool", () => {
  mkdirSync(configFile, { recursive: true });
  assert.throws(() => loadPools());
  assert.equal(statSync(configFile).isDirectory(), true);
});

const invalidConfigurations = [
  ["unsafe pool ID", (p) => { p.id = "../workers"; }],
  ["unsafe member ID", (p) => { p.members[0].hostId = "../host"; }],
  ["unsafe project ID", (p) => { p.projects[0].id = "../project"; }],
  ["duplicate member ID", (p) => { p.members.push({ ...p.members[0] }); }],
  ["duplicate project ID", (p) => { p.projects.push({ ...p.projects[0] }); }],
  ["relative projects root", (p) => { p.members[0].projectsRoot = "projects"; }],
  ["relative clone path", (p) => { p.projects[0].clonePaths["host-a"] = "project-a"; }],
  ["invalid origin", (p) => { p.projects[0].origin = "/tmp/not-a-registered-origin"; }],
  ["HTTPS credential origin", (p) => { p.projects[0].origin = "https://user:secret@github.com/example/one.git"; }],
  ["reserved launch argument", (p) => { p.projects[0].launchConfig = { extraArgs: ["--cwd=/tmp"] }; }],
];
for (const [name, invalidate] of invalidConfigurations) {
  test(`save rejects ${name} without overwriting valid configuration`, () => {
    savePools([configuredPool()]);
    const original = readFileSync(configFile, "utf8");
    const invalid = configuredPool();
    invalidate(invalid);
    assert.throws(() => savePools([invalid]));
    assert.equal(readFileSync(configFile, "utf8"), original);
  });
  test(`load rejects stored ${name} rather than using a partial or fallback pool`, () => {
    savePools([configuredPool()]);
    const persisted = JSON.parse(readFileSync(configFile, "utf8"));
    invalidate(persisted.pools[0]);
    writeConfig(persisted);
    assert.throws(() => loadPools());
  });
}

test("removing membership preserves registered clone paths without rejoining the former member", () => {
  const configured = configuredPool();
  configured.members = [];
  savePools([configured]);
  const [loaded] = loadPools();
  assert.deepEqual(loaded.projects[0].clonePaths, { "host-a": "/srv/host-a/projects/existing-checkout" });
  assert.equal(choose(loaded, snapshots()), null);
});
