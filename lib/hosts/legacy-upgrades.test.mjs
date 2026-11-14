import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "ompweb-legacy-operation-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { observeLegacyUpgrade, readLegacyUpgrade, rejectLegacyBootstrap, startLegacyUpgrade } = await import("./legacy-upgrades.ts");
const id = "12345678-1234-4234-8234-123456789012";
const hostId = "worker";
const directory = join(root, "omp-web", "legacy-updates", hostId);
const lock = join(directory, "lock.json");
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
function pending() {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "status.json"), JSON.stringify({
    hostId, operation: { id, target: "ompweb", version: "0.7.1", state: "running" },
    helper: { version: "0.7.1", repo: "ompweb-dev/ompweb", assets: [{ name: "ompweb-linux-x64.tar.gz", digest: `sha256:${"a".repeat(64)}` }] },
    compatibility: { min: 12, max: 12 }, platform: "linux", startedAt: Date.now(),
  }), { mode: 0o600 });
  writeFileSync(lock, JSON.stringify({ id }), { mode: 0o600 });
}
const info = (version, state = "succeeded") => ({
  ompweb: { currentVersion: version, availableVersion: "0.7.1", updateAvailable: version !== "0.7.1", canUpdate: false, blockedReason: null, updateCommand: "", installMethod: "binary", protocolVersion: 12 },
  omp: { currentVersion: "18.20.0" }, operation: { id, target: "ompweb", version: "0.7.1", state },
});

test("a failed bootstrap is reported instead of remaining running forever, and releases only its own claim", () => {
  pending();
  rejectLegacyBootstrap(hostId, "87654321-1234-4234-8234-123456789012", "unrelated response");
  assert.equal(readLegacyUpgrade(hostId).operation.state, "running");
  assert.equal(existsSync(lock), true);
  rejectLegacyBootstrap(hostId, id, "The fixed bootstrap could not download its matching helper");
  assert.equal(readLegacyUpgrade(hostId).operation.state, "failed");
  assert.equal(existsSync(lock), false);
});

test("a success-shaped receipt from the wrong running release cannot complete recovery", () => {
  pending();
  assert.equal(observeLegacyUpgrade(hostId, info("0.6.0")).state, "running");
  assert.equal(existsSync(lock), true);
  assert.equal(observeLegacyUpgrade(hostId, info("0.7.1")).state, "succeeded");
  assert.equal(existsSync(lock), false);
});

test("an authenticated worker receipt reconciles a failed or lost shell response without trusting shell success", () => {
  pending();
  rejectLegacyBootstrap(hostId, id, "The legacy runner lost its bootstrap response");
  assert.equal(observeLegacyUpgrade(hostId, info("0.6.0", "running")).state, "running");
  assert.equal(observeLegacyUpgrade(hostId, info("0.7.1")).state, "succeeded");
  rejectLegacyBootstrap(hostId, id, "late bootstrap error");
  assert.equal(readLegacyUpgrade(hostId).operation.state, "succeeded");
});

test("a running recovery with no matching receipt expires after 30 minutes, releases only its claim, and a late receipt still reconciles", async (t) => {
  const now = 1_700_000_000_000;
  const leaseMs = 30 * 60 * 1000;
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const stale = "stale-host";
  const staleLock = join(root, "omp-web", "legacy-updates", stale, "lock.json");
  const otherLock = join(root, "omp-web", "legacy-updates", "other-host", "lock.json");
  const otherBody = JSON.stringify({ id: "87654321-1234-4234-8234-123456789012" });
  const hostUpdateLock = join(root, "omp-web", "host-update", "lock.json");
  const hostUpdateBody = JSON.stringify({ id: "host-update-claim" });
  const busyLock = join(root, "omp-web", "legacy-updates", "busy-host", "lock.json");
  const writeRunning = (host, startedAt, lockId = id) => {
    const dir = join(root, "omp-web", "legacy-updates", host);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      hostId: host, operation: { id, target: "ompweb", version: "0.7.1", state: "running" },
      helper: { version: "0.7.1", repo: "ompweb-dev/ompweb", assets: [{ name: "ompweb-linux-x64.tar.gz", digest: `sha256:${"a".repeat(64)}` }] },
      compatibility: { min: 12, max: 12 }, platform: "linux", startedAt,
    }), { mode: 0o600 });
    writeFileSync(join(dir, "lock.json"), JSON.stringify({ id: lockId }), { mode: 0o600 });
  };
  mkdirSync(join(root, "omp-web", "legacy-updates", "other-host"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "omp-web", "host-update"), { recursive: true, mode: 0o700 });
  writeFileSync(otherLock, otherBody, { mode: 0o600 });
  writeFileSync(hostUpdateLock, hostUpdateBody, { mode: 0o600 });
  const silent = { ...info("0.6.0"), operation: null, stdout: "update healthy", health: { ok: true } };

  writeRunning(stale, now - leaseMs);
  assert.equal(observeLegacyUpgrade(stale, silent).state, "running", "exactly 30 minutes is still inside the lease");
  assert.equal(existsSync(staleLock), true);

  writeRunning(stale, now - leaseMs - 1);
  assert.equal(observeLegacyUpgrade(stale, info("0.6.0", "running")).state, "running");
  assert.equal(existsSync(staleLock), true, "a matching receipt, even a running one, is not expiry");
  assert.equal(observeLegacyUpgrade(stale, silent).state, "failed");
  const expired = readLegacyUpgrade(stale);
  assert.equal(expired.operation.id, id);
  assert.equal(expired.operation.error, "no receipt within 30 minutes");
  assert.equal(expired.confirmedTerminal, true);
  assert.equal(existsSync(staleLock), false);
  assert.equal(readFileSync(otherLock, "utf8"), otherBody);
  assert.equal(readFileSync(hostUpdateLock, "utf8"), hostUpdateBody);

  writeRunning("busy-host", now - leaseMs - 1, "87654321-1234-4234-8234-123456789012");
  assert.equal(observeLegacyUpgrade("busy-host", silent).state, "failed");
  assert.equal(readFileSync(busyLock, "utf8"), otherBody, "another operation's claim stays");

  assert.equal(observeLegacyUpgrade(stale, info("0.7.1")).state, "succeeded");
  assert.equal(readLegacyUpgrade(stale).operation.state, "succeeded");
  assert.equal(existsSync(staleLock), false);

  const retryHost = "retry-host";
  writeRunning(retryHost, now - leaseMs - 1);
  assert.equal(observeLegacyUpgrade(retryHost, silent).state, "failed");
  const packageDir = join(root, "bad-package");
  mkdirSync(packageDir, { mode: 0o700 });
  writeFileSync(join(packageDir, "build-info.json"), JSON.stringify({ version: "nope", releaseTag: "nope" }), { mode: 0o600 });
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const originalFetch = globalThis.fetch;
  process.env.OMP_WEB_PACKAGE_DIR = packageDir;
  globalThis.fetch = async () => { throw new Error("offline"); };
  let opened = false;
  try {
    await assert.rejects(() => startLegacyUpgrade({
      hostId: retryHost, version: "0.7.1", compatibility: { min: 12, max: 12 }, platform: "linux",
      transport: {
        async open() { opened = true; throw new Error("retry probe"); },
        send() { opened = true; },
      },
    }), (error) => {
      assert.notEqual(error?.code, "update_in_progress");
      assert.notEqual(error?.status, 409);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
  }
  assert.equal(opened, false, "a permitted retry stops at helper identity, not a new bootstrap");
});
