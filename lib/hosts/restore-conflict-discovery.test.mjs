import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { mock } from "bun:test";

// Install before loading the real scanner: permissions cannot be modeled with chmod when tests run as root.
const realFs = { ...await import("fs") };
// The scanner retains its first imported readdirSync wrapper across Bun --rerun-each. Share the state with that wrapper,
// rather than silently disabling faults when the test module is re-evaluated.
const faultState = (globalThis.__restoreConflictDiscoveryFault ??= { value: null });
mock.module("fs", () => ({
  ...realFs,
  readdirSync(directory, ...args) {
    const fault = faultState.value;
    if (fault?.operation === "readdir" && directory === fault.path) throw Object.assign(new Error("directory unreadable"), { code: fault.code });
    return realFs.readdirSync(directory, ...args);
  },
  openSync(file, ...args) {
    const fault = faultState.value;
    if (fault?.operation === "open" && file === fault.path) throw Object.assign(new Error("header unreadable"), { code: fault.code });
    return realFs.openSync(file, ...args);
  },
}));
const { listSessionIdsForRestore, listSessionFiles, invalidateSessionFileListCache, readSessionHeaderSync } = await import("../omp/session-files.ts");
const { listArchivedSessionInfos, restoreArchivedSession } = await import("../omp/archive.ts");
const { linkHost, linkLocalDaemon } = await import("./link-driver.test-helper.mjs");
const { closeHostLink, flushLinkSamples } = await import("./hub.ts");
const { HostOpError } = await import("./link-protocol.ts");
const route = await import("../../app/api/sessions/archive/route.ts");
const ID = "11111111-2222-4333-8444-555555555555";
const body = () => `${JSON.stringify({ type: "session", version: 3, id: ID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00Z" })}\n`;

async function withRoots(run) {
  const root = mkdtempSync(join(tmpdir(), "strict-restore-discovery-"));
  const agent = join(root, "agent");
  const local = join(agent, "sessions");
  const remote = join(root, "remote-sessions");
  for (const directory of [local, remote]) mkdirSync(join(directory, "project"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  invalidateSessionFileListCache();
  try { await run({ root, local, remote }); }
  finally {
    faultState.value = null;
    closeHostLink("local");
    flushLinkSamples();
    invalidateSessionFileListCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const code of ["EACCES", "EIO"]) {
  for (const project of [false, true]) {
    test(`restore-only discovery rejects ${code} at ${project ? "project" : "root"}, ignoring a warm best-effort empty cache`, () => withRoots(async ({ local }) => {
      const file = join(local, "project", "active.jsonl");
      writeFileSync(file, body());
      faultState.value = { operation: "readdir", path: project ? join(local, "project") : local, code };
      // The ordinary sidebar keeps its historical best-effort semantics and may cache an empty result.
      assert.deepEqual(await listSessionFiles(local), []);
      const cache = globalThis.__ompSessionFileListCache;
      assert.throws(() => listSessionIdsForRestore(local), (error) => error.code === code);
      assert.equal(globalThis.__ompSessionFileListCache, cache, "strict discovery neither reads nor replaces the walk cache");
      faultState.value = null;
      assert.deepEqual(listSessionIdsForRestore(local), [ID]);
    }));
  }
  test(`restore-only discovery rejects ${code} reading an active header, while ordinary header reads remain best-effort`, () => withRoots(async ({ local }) => {
    const file = join(local, "project", "active.jsonl");
    writeFileSync(file, body());
    faultState.value = { operation: "open", path: file, code };
    assert.equal(readSessionHeaderSync(file), null);
    assert.throws(() => listSessionIdsForRestore(local), (error) => error.code === code);
  }));
}

test("strict discovery rejects unidentifiable headers but accepts a genuinely missing sessions root", () => withRoots(async ({ root, local }) => {
  assert.deepEqual(listSessionIdsForRestore(join(root, "absent")), []);
  writeFileSync(join(local, "project", "unknown.jsonl"), "not a session header\n");
  assert.throws(() => listSessionIdsForRestore(local), /Cannot identify active session/);
}));

for (const side of ["local", "remote"]) {
  for (const code of ["EACCES", "EIO"]) {
    for (const project of [false, true]) {
      test(`${side} ${project ? "project" : "root"} ${code} blocks a restore on another host without consuming its real archive`, () => withRoots(async ({ root, local, remote }) => {
        const active = side === "local" ? local : remote;
        writeFileSync(join(active, "project", "active.jsonl"), body());
        await linkLocalDaemon();
        const peer = await linkHost("Peer with active session");
        const selected = await linkHost("Selected restore host");
        const target = join(root, "target-sessions");
        const archive = join(root, "target-archive");
        const key = "project/restored.jsonl.gz";
        mkdirSync(join(archive, "project"), { recursive: true });
        const compressed = gzipSync(body());
        writeFileSync(join(archive, key), compressed);
        let restores = 0;
        try {
          peer.serve({ listSessionIdsForRestore: () => listSessionIdsForRestore(remote) });
          selected.serve({
            listArchives: () => listArchivedSessionInfos(archive),
            listSessionIdsForRestore: () => listSessionIdsForRestore(target),
            restoreReserve: () => ({ ok: true, value: { instance: "selected" } }),
            restoreArchive: async ({ key: requested }) => {
              restores++;
              return { ok: true, value: { sessionId: await restoreArchivedSession(requested, target, archive) } };
            },
          });
          faultState.value = { operation: "readdir", path: project ? join(active, "project") : active, code };
          const response = await route.POST(new Request("http://localhost/api/sessions/archive", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, hostId: selected.id }),
          }));
          assert.deepEqual([response.status, (await response.json()).code], [503, "host_sessions_unavailable"]);
          assert.equal(restores, 0);
          assert.deepEqual(readFileSync(join(archive, key)), compressed);
          assert.equal(existsSync(join(target, "project", "restored.jsonl")), false);
        } finally {
          faultState.value = null;
          closeHostLink(peer.id);
          closeHostLink(selected.id);
        }
      }));
    }
  }
}

test("an older daemon without strict discovery blocks restore without falling back to its best-effort list", () => withRoots(async () => {
  await linkLocalDaemon();
  const old = await linkHost("Old daemon");
  let restores = 0;
  let legacyLists = 0;
  try {
    old.serve({
      listArchives: () => [{ key: "project/a.jsonl.gz", id: ID, cwd: "/project", created: "c", archivedAt: "a", messageCount: 0, firstMessage: "", size: 10 }],
      listSessions: () => { legacyLists++; return []; },
      listSessionIdsForRestore: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: listSessionIdsForRestore"); },
      restoreArchive: () => { restores++; },
    });
    const response = await route.POST(new Request("http://localhost/api/sessions/archive", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "project/a.jsonl.gz", hostId: old.id }),
    }));
    assert.deepEqual([response.status, (await response.json()).code], [503, "host_sessions_unavailable"]);
    assert.equal(legacyLists, 0);
    assert.equal(restores, 0);
  } finally { closeHostLink(old.id); }
}));
