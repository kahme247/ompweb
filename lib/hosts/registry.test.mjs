import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const registry = await jiti.import("./registry.ts");
const { createHost, customLocalLabel, hostForToken, loadHosts, revokeHost, rotateLocalHostToken, touchHost, updateHost } = registry;

/** Point the omp agent dir at a throwaway location for the duration of `fn`. */
async function withAgentDir(fn) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-hosts-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn(join(agentDir, "omp-web", "hosts.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("createHost returns a 43-char base64url token and stores only its sha256", () =>
  withAgentDir(async (file) => {
    const { host, token } = createHost("laptop");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(host.tokenHash, sha256(token));
    assert.equal(host.label, "laptop");
    assert.equal(host.lastSeenAt, null);
    assert.equal(host.allowAgentStart, false);

    const onDisk = readFileSync(file, "utf8");
    assert.ok(onDisk.includes(sha256(token)));
    assert.ok(!onDisk.includes(token));
  }));

test("hostForToken matches the exact token only", () =>
  withAgentDir(async () => {
    const { host, token } = createHost("laptop");
    assert.equal(hostForToken(token)?.id, host.id);
    assert.equal(hostForToken(token + "x"), null);
  }));

test("revokeHost removes the record and its token stops matching", () =>
  withAgentDir(async () => {
    const { token } = createHost("laptop");
    assert.equal(revokeHost(loadHosts()[0].id), true);
    assert.equal(hostForToken(token), null);
    assert.equal(revokeHost("missing"), false);
  }));

test("hosts.json is written with mode 0600 on POSIX", { skip: process.platform === "win32" }, () =>
  withAgentDir(async (file) => {
    createHost("laptop");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

test("a corrupt hosts.json loads as an empty list", () =>
  withAgentDir(async (file) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{not json");
    assert.deepEqual(loadHosts(), []);
  }));

test("hostForToken throws on an unreadable registry but treats a missing one as empty", () =>
  withAgentDir(async (file) => {
    assert.equal(hostForToken("anything"), null);
    mkdirSync(join(file, ".."), { recursive: true });
    for (const content of ["{not json", "{}", "null"]) {
      writeFileSync(file, content);
      assert.throws(() => hostForToken("anything"), { name: "HostRegistryUnreadableError" });
    }
  }));

test("create, update and revoke refuse an unreadable registry and leave the file untouched", () =>
  withAgentDir(async (file) => {
    const { host } = createHost("laptop");
    const broken = "{not json";
    writeFileSync(file, broken);
    assert.throws(() => createHost("other"), { name: "HostRegistryUnreadableError" });
    assert.throws(() => updateHost(host.id, { label: "x" }), { name: "HostRegistryUnreadableError" });
    assert.throws(() => revokeHost(host.id), { name: "HostRegistryUnreadableError" });
    touchHost(host.id, "2026-10-29T10:00:00.000Z");
    assert.equal(readFileSync(file, "utf8"), broken);
  }));

test("createHost trims the label and rejects an empty one", () =>
  withAgentDir(async () => {
    assert.equal(createHost("  desk  ").host.label, "desk");
    assert.throws(() => createHost("   "), { message: "Host label is required" });
  }));

test("updateHost persists changes and rejects an unknown id", () =>
  withAgentDir(async () => {
    const { host } = createHost("laptop");
    const updated = updateHost(host.id, { label: " studio ", allowAgentStart: true });
    assert.equal(updated.label, "studio");
    assert.equal(updated.allowAgentStart, true);
    assert.equal(loadHosts()[0].label, "studio");
    assert.throws(() => updateHost("missing", { label: "x" }), { message: "Unknown host" });
  }));

test("touchHost stamps lastSeenAt and ignores unknown ids", () =>
  withAgentDir(async () => {
    const { host } = createHost("laptop");
    touchHost(host.id, "2026-10-29T10:00:00.000Z");
    touchHost("missing", "2026-10-29T11:00:00.000Z");
    assert.equal(loadHosts()[0].lastSeenAt, "2026-10-29T10:00:00.000Z");
    assert.equal(loadHosts().length, 1);
  }));

test("malformed records are skipped and do not break token lookup", () =>
  withAgentDir(async (file) => {
    const { host, token } = createHost("laptop");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.hosts = [null, { id: "x" }, ...stored.hosts];
    writeFileSync(file, JSON.stringify(stored));

    assert.deepEqual(loadHosts().map((h) => h.id), [host.id]);
    assert.equal(hostForToken(token)?.id, host.id);
    assert.equal(hostForToken(undefined), null);
  }));

test("this machine can be renamed and reset, never revoked or given agent-start rights", () =>
  withAgentDir(async () => {
    const token = rotateLocalHostToken();
    assert.equal(customLocalLabel(), "");

    assert.equal(updateHost("local", { label: "  Desk  " }).label, "Desk");
    assert.equal(customLocalLabel(), "Desk");
    assert.equal(hostForToken(token)?.id, "local");
    assert.equal(loadHosts()[0].allowAgentStart, true);

    rotateLocalHostToken();
    assert.equal(customLocalLabel(), "Desk", "a new token keeps the name");

    assert.throws(() => revokeHost("local"), { name: "ReservedHostError" });
    assert.throws(() => updateHost("local", { allowAgentStart: false }), { name: "ReservedHostError" });
    assert.equal(customLocalLabel(), "Desk");

    updateHost("local", { label: "  " });
    assert.equal(customLocalLabel(), "");
    assert.throws(() => updateHost(createHost("laptop").host.id, { label: " " }), { message: "Host label is required" });
  }));
