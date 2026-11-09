import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { Database } from "bun:sqlite";
import { LinkDriver, linkHost, linkLocalDaemon, listedSession } from "./hosts/link-driver.test-helper.mjs";

const sessionRoute = await import("../app/api/sessions/[id]/route.ts");
const contextRoute = await import("../app/api/sessions/[id]/context/route.ts");
const importRoute = await import("../app/api/sessions/import/route.ts");
const archiveRoute = await import("../app/api/sessions/archive/route.ts");
const sessionArchiveRoute = await import("../app/api/sessions/[id]/archive/route.ts");
const exportRoute = await import("../app/api/sessions/[id]/export/route.ts");
const stateRoute = await import("../app/api/sessions/[id]/state/route.ts");
const autoNameRoute = await import("../app/api/sessions/[id]/auto-name/route.ts");
const { cacheSessionPath, invalidateSessionListCache, listAllSessions, resolveSessionPath } = await import("./session-reader.ts");
const { allowFileRoot, normalizeSlashes } = await import("./file-access.ts");
const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
const { closeHostLink, getHost, linkTimings } = await import("./hosts/hub.ts");
const { HostOpError } = await import("./hosts/link-protocol.ts");
const { revokeHost } = await import("./hosts/registry.ts");
const { listSessionsAllHosts } = await import("./hosts/session-index.ts");
const { closeOutboxStore, outboxScope } = await import("./message-outbox.ts");

const getContext = (id, query = "") => contextRoute.GET(
  new Request(`http://localhost/api/sessions/${id}/context${query ? `?${query}` : ""}`),
  { params: Promise.resolve({ id }) },
);

const getState = (id) => stateRoute.GET(
  new Request(`http://localhost/api/sessions/${id}/state`),
  { params: Promise.resolve({ id }) },
);

// MAX_SESSION_LOAD_BYTES from lib/omp/session-files.ts (1 GiB).
const MAX_SESSION_LOAD_BYTES = 1024 * 1024 * 1024;

/** Point the omp agent dir at a throwaway location for the duration of `run`;
 * this machine's daemon serves it from this process (`daemonOps` null: no daemon links). */
async function withAgentDir(run, daemonOps = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-routes-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // The global session-list cache (30s TTL), the path cache and main's per-host
  // lists could hold entries from another test's agent dir; clear them so
  // resolution sees only THIS dir's files.
  invalidateSessionListCache();
  globalThis.__ompHostLists = undefined;
  if (daemonOps) await linkLocalDaemon(daemonOps);
  try {
    await run(projectDir);
  } finally {
    closeHostLink("local");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    closeOutboxStore();
    rmSync(agentDir, { recursive: true, force: true });
  }
}
test("state reports a retained exit before the session file exists", async (t) => {
  const id = "exited-before-file";
  const previousExited = globalThis.__ompExitedSessions;
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompExitedSessions = new Map([[
    id,
    { id, cwd: "/tmp/project", at: 123, code: 1, signal: null, detail: "startup failed" },
  ]]);
  globalThis.__ompSessions = new Map();
  t.after(() => {
    globalThis.__ompExitedSessions = previousExited;
    globalThis.__ompSessions = previousSessions;
  });

  await withAgentDir(async () => {
    const response = await getState(id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      running: false,
      alive: false,
      exited: { id, cwd: "/tmp/project", at: 123, code: 1, signal: null, detail: "startup failed" },
      outbox: [],
      outboxScope: outboxScope(),
      outboxSettledIds: [],
    });
  }, null);
});

function writeSessionFile(dir, name, header, entries = []) {
  const filePath = join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

/** Turn a real small session file into a 1 GiB+1 sparse file WITHOUT losing
 * the (valid) header, mirroring a session that outgrew the load ceiling. */
function makeOversized(filePath) {
  truncateSync(filePath, MAX_SESSION_LOAD_BYTES + 1);
}

test("session route returns 413 session_file_too_large when a valid-header file exceeds the load ceiling", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_giant.jsonl", {
      id: "0a000000-0000-4000-8000-000000000001",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }]);
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/0a000000-0000-4000-8000-000000000001");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "0a000000-0000-4000-8000-000000000001" }) });

    assert.equal(res.status, 413, "valid header must not degrade to 200 with an empty transcript");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("context route returns 413 session_file_too_large when a valid-header file exceeds the load ceiling", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_giant.jsonl", {
      id: "0a000000-0000-4000-8000-000000000002",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }]);
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/0a000000-0000-4000-8000-000000000002/context?leafId=u1");
    const res = await contextRoute.GET(req, { params: Promise.resolve({ id: "0a000000-0000-4000-8000-000000000002" }) });

    assert.equal(res.status, 413, "valid header must not degrade to 200 with an empty context");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("oversized file with an INVALID header still 413s, not 404", async () => {
  await withAgentDir(async (dir) => {
    const filePath = join(dir, "2026-01-01_bad-giant.jsonl");
    writeFileSync(filePath, '{"type":"session","version":3,"id":"0a000000-0000-4000-8000-000000000003","cwd":"/tmp","timestamp":"2026-01-01T00:00:00.000Z"}\n');
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/0a000000-0000-4000-8000-000000000003");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "0a000000-0000-4000-8000-000000000003" }) });

    assert.equal(res.status, 413, "too large is reported as too large even when the header scan fails");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("session and context routes still serve a normal-size file with 200", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-01-01_small.jsonl", {
      id: "0a000000-0000-4000-8000-000000000004",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "world" } },
    ]);

    const req = new Request("http://localhost/api/sessions/0a000000-0000-4000-8000-000000000004");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "0a000000-0000-4000-8000-000000000004" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.context.messages.length, 2, "normal file still yields its transcript");
    assert.equal(body.leafId, "a1", "leaf resolves to the last entry");

    // Branch semantics: the context for a leaf is the path TO that leaf.
    // `u1` is the root, so its context is just itself; `a1` (a child of u1)
    // is a sibling branch whose context is u1 -> a1.
    const ctxReq = new Request("http://localhost/api/sessions/0a000000-0000-4000-8000-000000000004/context?leafId=u1");
    const ctxRes = await contextRoute.GET(ctxReq, { params: Promise.resolve({ id: "0a000000-0000-4000-8000-000000000004" }) });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.equal(ctxBody.context.messages.length, 1, "leaf u1 is the root, so its context contains only itself");
    assert.deepEqual(ctxBody.context.entryIds, ["u1"]);

    const branchReq = new Request("http://localhost/api/sessions/0a000000-0000-4000-8000-000000000004/context?leafId=a1");
    const branchRes = await contextRoute.GET(branchReq, { params: Promise.resolve({ id: "0a000000-0000-4000-8000-000000000004" }) });
    assert.equal(branchRes.status, 200);
    const branchBody = await branchRes.json();
    assert.equal(branchBody.context.messages.length, 2, "leaf a1's context is the full u1 -> a1 branch");
    assert.deepEqual(branchBody.context.entryIds, ["u1", "a1"]);
  });
});

test("session and context routes map a missing session to 404, not 413", async () => {
  const req = new Request("http://localhost/api/sessions/no-such-session");
  const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "no-such-session" }) });
  assert.equal(res.status, 404);

  const ctxReq = new Request("http://localhost/api/sessions/no-such-session/context");
  const ctxRes = await contextRoute.GET(ctxReq, { params: Promise.resolve({ id: "no-such-session" }) });
  assert.equal(ctxRes.status, 404);
});
// ============================================================================
// Route-level integration: DELETE re-parenting + import invalidation
// (TODO §3 leftover — fork itself is RPC-gated behind the omp binary and is
// exercised by the live RPC manager, not these Node-only route tests).
// ============================================================================

test("DELETE /api/sessions/[id] re-parents children to the grandparent and stops resolving the deleted id", async () => {
  await withAgentDir(async (dir) => {
    const cwd = join(tmpdir(), "omp-web-missing-project");
    const gpPath = writeSessionFile(dir, "2026-01-01_gp.jsonl", {
      id: "0a000000-0000-4000-8000-000000000005",
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "gp" } }]);
    const parentPath = writeSessionFile(dir, "2026-01-02_parent.jsonl", {
      id: "0a000000-0000-4000-8000-000000000006",
      cwd,
      timestamp: "2026-01-02T00:00:00.000Z",
      parentSession: gpPath,
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "parent" } }]);
    writeSessionFile(dir, "2026-01-03_child.jsonl", {
      id: "0a000000-0000-4000-8000-000000000007",
      cwd,
      timestamp: "2026-01-03T00:00:00.000Z",
      parentSession: parentPath,
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-03T00:00:00.000Z", message: { role: "user", content: "child" } }]);
    writeSessionFile(dir, "2026-01-04_childid.jsonl", {
      id: "0a000000-0000-4000-8000-000000000008",
      cwd,
      timestamp: "2026-01-04T00:00:00.000Z",
      parentSession: "0a000000-0000-4000-8000-000000000006",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-04T00:00:00.000Z", message: { role: "user", content: "child-id" } }]);

    // Warm the list so id/path resolution is exercised the way the UI does.
    await listAllSessions();

    const res = await sessionRoute.DELETE(new Request("http://localhost/api/sessions/0a000000-0000-4000-8000-000000000006"), {
      params: Promise.resolve({ id: "0a000000-0000-4000-8000-000000000006" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    assert.equal(existsSync(parentPath), false, "deleted session's file must be gone");
    assert.equal(await resolveSessionPath("0a000000-0000-4000-8000-000000000006"), null, "deleted session must no longer resolve (stale cache would make omp create a new session on --resume)");

    const after = new Map((await listAllSessions()).map((s) => [s.id, s]));
    assert.equal(after.get("0a000000-0000-4000-8000-000000000007")?.parentSessionId, "0a000000-0000-4000-8000-000000000005", "child linked by PATH form must re-attach to the grandparent path");
    assert.equal(after.get("0a000000-0000-4000-8000-000000000008")?.parentSessionId, "0a000000-0000-4000-8000-000000000005", "child linked by ID form must re-attach to the grandparent id");
  });
});

test("POST /api/sessions/import writes a fresh-id copy and makes it visible immediately", async () => {
  await withAgentDir(async () => {
    const workspace = mkdtempSync(join(tmpdir(), "omp-web-import-ws-"));
    try {
      allowFileRoot(workspace);
      // The sidebar's list of this machine's sessions, warm before the import.
      assert.deepEqual(await listSessionsAllHosts(), []);
      const content = [
        JSON.stringify({ type: "session", version: 3, id: "src-id", cwd: workspace, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "imported hello" } }),
        JSON.stringify({ type: "message", id: "b1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "bashExecution", content: "ls", fullOutputPath: "/tmp/pi-bash-evil.log" } }),
      ].join("\n") + "\n";

      const res = await importRoute.POST(new Request("http://localhost/api/sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: "src.jsonl", content }),
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(existsSync(body.sessionFile), "imported file must exist at the reported path");

      // Fresh id: an imported copy must never keep the source id, or opening
      // / deleting the import would hit the ORIGINAL session file.
      const imported = (await listSessionsAllHosts()).find((s) => s.firstMessage === "imported hello");
      assert.ok(imported, "imported session must appear in the sidebar's list right away (list invalidation)");
      assert.equal(imported.hostId, "local");
      assert.notEqual(imported.id, "src-id", "imported copy must get a fresh session id");

      // The imported bashExecution must not carry fullOutputPath: it could
      // otherwise forge a reference the bash-output route would trust.
      const written = readFileSync(body.sessionFile, "utf8").split("\n");
      const bashLine = written.find((line) => line.includes("bashExecution"));
      assert.ok(bashLine, "bashExecution entry is preserved");
      assert.equal(JSON.parse(bashLine).message.fullOutputPath, undefined, "fullOutputPath must be stripped on import");
    } finally {
      // Don't leak the allowed root into other tests in this process.
      globalThis.__piAdditionalAllowedRoots?.delete(normalizeSlashes(workspace));
      globalThis.__piAllowedRootsCache?.roots.delete(normalizeSlashes(workspace));
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

test("POST /api/sessions/archive restores a session into the sidebar's list right away", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000020";
    // getArchivedSessionsDir(): <agent dir>/archive/sessions, beside <agent dir>/sessions.
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const lines = [
      { type: "session", version: 3, id, cwd: dir, timestamp: "2026-01-02T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "restored hello" } },
    ];
    writeFileSync(join(archived, "2026-01-02_restored.jsonl.gz"), gzipSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)));
    assert.deepEqual(await listSessionsAllHosts(), [], "the sidebar's list, warm before the restore");

    const res = await archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "-project/2026-01-02_restored.jsonl.gz" }),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, sessionId: id });
    assert.deepEqual((await listSessionsAllHosts()).map((s) => [s.id, s.hostId]), [[id, "local"]]);
  });
});

test("archive restore rejects malformed hosts and unlisted key aliases without consuming a local archive", async () => {
  await withAgentDir(async (dir) => {
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const file = join(archived, "kept.jsonl.gz");
    const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: "kept-archive", cwd: dir })}\n`));
    writeFileSync(file, bytes);
    const post = (body) => archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    for (const hostId of [42, false, [], null, "", "   "]) {
      const response = await post({ key: "-project/kept.jsonl.gz", hostId });
      assert.equal(response.status, 400, `hostId ${JSON.stringify(hostId)}`);
      assert.deepEqual(readFileSync(file), bytes);
    }
    for (const key of ["-project/./kept.jsonl.gz", "-project/missing.jsonl.gz"]) {
      assert.equal((await post({ key })).status, 404);
      assert.deepEqual(readFileSync(file), bytes);
    }
    assert.equal((await post({ key: "-project/kept.jsonl.gz", hostId: "unknown-host" })).status, 404);
    assert.deepEqual(readFileSync(file), bytes);
  });
});

test("local archive restore preserves the archive when another host has its session ID", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000043";
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const file = join(archived, "kept.jsonl.gz");
    const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`));
    writeFileSync(file, bytes);
    const remote = await linkHost("Active remote");
    try {
      remote.serve({ listSessions: () => [listedSession(id)] });
      const response = await archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "-project/kept.jsonl.gz", hostId: "local" }),
      }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "session_host_conflict");
      assert.deepEqual(readFileSync(file), bytes);
      assert.deepEqual((await listAllSessions()).map((session) => session.id), []);
    } finally {
      closeHostLink(remote.id);
    }
  });
});

test("GET /api/sessions/archive lists every host's archives newest first, tagged by host, and names a host it cannot read", async () => {
  await withAgentDir(async (dir) => {
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const lines = [
      { type: "session", version: 3, id: "0a000000-0000-4000-8000-000000000040", cwd: dir, timestamp: "2026-01-15T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-15T00:00:01.000Z", message: { role: "user", content: "local archived" } },
    ];
    const localFile = join(archived, "2026-01-15_local.jsonl.gz");
    writeFileSync(localFile, gzipSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)));
    // A local archive's date is its file's mtime.
    utimesSync(localFile, new Date("2026-01-15T00:00:00.000Z"), new Date("2026-01-15T00:00:00.000Z"));
    const remoteArchive = (key, archivedAt) => ({ key, id: key, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z", archivedAt, messageCount: 1, firstMessage: "remote", size: 10, status: "complete" });
    const remote = await linkHost("Remote");
    const broken = await linkHost("Broken");
    try {
      remote.serve({ listArchives: () => [remoteArchive("-srv/old.jsonl.gz", "2026-01-10T00:00:00.000Z"), remoteArchive("-srv/new.jsonl.gz", "2026-02-01T00:00:00.000Z")] });
      broken.serve({ listArchives: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: listArchives"); } });
      const res = await archiveRoute.GET();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assert.deepEqual(body.archives.map((archive) => [archive.hostId, archive.key]), [
        [remote.id, "-srv/new.jsonl.gz"],
        ["local", "-project/2026-01-15_local.jsonl.gz"],
        [remote.id, "-srv/old.jsonl.gz"],
      ]);
      assert.deepEqual(body.unavailableHosts, [{ id: broken.id, label: "Broken" }]);
    } finally {
      closeHostLink(remote.id);
      closeHostLink(broken.id);
    }
  });
});

test("a corrupt local archive is reported as unavailable without hiding healthy linked archives or proving local absence", async () => {
  await withAgentDir(async (dir) => {
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const corrupt = join(archived, "corrupt.jsonl.gz");
    writeFileSync(corrupt, "not a gzip stream");
    const healthy = await linkHost("Healthy archive");
    const broken = await linkHost("Unreadable remote");
    const id = "0a000000-0000-4000-8000-000000000063";
    try {
      healthy.serve({ listArchives: () => [remoteArchive(id)] });
      broken.serve({ listArchives: () => { throw Object.assign(new Error("remote disk I/O failed"), { code: "EIO" }); } });
      const response = await archiveRoute.GET();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.archives.map((entry) => [entry.hostId, entry.id]), [[healthy.id, id]]);
      assert.deepEqual(body.unavailableHosts, [
        { id: "local", label: getHost("local").label },
        { id: broken.id, label: "Unreadable remote" },
      ]);
      // Direct discovery used by the outbox still fails closed; the UI's per-host isolation never converts it to [].
      const { listArchivedSessionInfos } = await import("./omp/archive.ts");
      await assert.rejects(listArchivedSessionInfos());
      assert.equal(readFileSync(corrupt, "utf8"), "not a gzip stream");
    } finally {
      closeHostLink(healthy.id);
      closeHostLink(broken.id);
    }
  });
});

test("POST /api/sessions/archive with a remote hostId restores on that host and returns the host's refusal as is", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000041";
    const keys = [];
    const remote = await linkHost("Remote");
    try {
      remote.serve({
        listSessions: () => [],
        listArchives: () => ["-srv/new.jsonl.gz", "-srv/taken.jsonl.gz"].map((key) => ({
          key, id, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z", archivedAt: "2026-01-02T00:00:00.000Z",
          messageCount: 1, firstMessage: "remote", size: 10, status: "complete",
        })),
        restoreReserve: () => ({ ok: true, value: { instance: "d-remote" } }),
        restoreArchive({ key }) {
          keys.push(key);
          return key === "-srv/taken.jsonl.gz"
            ? { ok: false, status: 409, code: "archive_restore_failed", error: "Active session destination already exists" }
            : { ok: true, value: { sessionId: id } };
        },
      });
      const post = (key) => archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, hostId: remote.id }),
      }));
      const restored = await post("-srv/new.jsonl.gz");
      assert.equal(restored.status, 200);
      assert.deepEqual(await restored.json(), { ok: true, sessionId: id });
      const taken = await post("-srv/taken.jsonl.gz");
      assert.equal(taken.status, 409);
      assert.deepEqual(await taken.json(), { error: "Active session destination already exists", code: "archive_restore_failed" });
      assert.deepEqual(keys, ["-srv/new.jsonl.gz", "-srv/taken.jsonl.gz"]);
      assert.equal((await post("-srv/./new.jsonl.gz")).status, 404);
      assert.equal((await post("-srv/missing.jsonl.gz")).status, 404);
      assert.deepEqual(keys, ["-srv/new.jsonl.gz", "-srv/taken.jsonl.gz"]);
      assert.deepEqual(restoreClaims(), [], "an answer, even a refusal, ends the claim");
    } finally {
      closeHostLink(remote.id);
    }
  });
});

test("remote archive restore rejects a session ID active on another host before consuming the archive", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000044";
    writeSessionFile(dir, "active.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" });
    const archives = [{
      key: "-srv/kept.jsonl.gz", id, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-02T00:00:00.000Z", messageCount: 1, firstMessage: "remote", size: 10, status: "complete",
    }];
    let restores = 0;
    const remote = await linkHost("Archived remote");
    try {
      remote.serve({
        listSessions: () => [],
        listArchives: () => archives,
        restoreArchive() {
          restores++;
          archives.splice(0);
          return { ok: true, value: { sessionId: id } };
        },
      });
      const response = await archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: archives[0].key, hostId: remote.id }),
      }));
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, "session_host_conflict");
      assert.match(body.error, /another host/i);
      assert.equal(restores, 0);
      assert.equal(archives.length, 1);
    } finally {
      closeHostLink(remote.id);
    }
  });
});

test("local same-ID session at a different path blocks restore despite a warm empty daemon cache", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000048";
    assert.deepEqual(await getHost("local").sessionOps.listSessions(), []);
    writeSessionFile(dir, "different-active.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" });
    const archiveDir = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archiveDir, { recursive: true });
    const file = join(archiveDir, "kept.jsonl.gz");
    const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`));
    writeFileSync(file, bytes);
    const response = await restoreRequest("-project/kept.jsonl.gz");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "archive_restore_failed");
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(existsSync(join(dir, "kept.jsonl")), false);
  });
});

test("link loss during fresh conflict discovery preserves the remote archive", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000049";
    const remote = await linkHost("Drops during listing");
    let restores = 0;
    try {
      remote.serve({ listArchives: () => [remoteArchive(id)],
        listSessions: () => { closeHostLink(remote.id); return []; },
        restoreArchive: () => { restores++; } });
      const response = await restoreRequest(remoteArchive(id).key, remote.id);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "host_offline");
      assert.equal(restores, 0);
    } finally { closeHostLink(remote.id); }
  });
});

function restoreRequest(key, hostId = "local") {
  return archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, hostId }),
  }));
}

function remoteArchive(id) {
  return { key: "-srv/kept.jsonl.gz", id, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z",
    archivedAt: "2026-01-02T00:00:00.000Z", messageCount: 1, firstMessage: "", size: 10, status: "complete" };
}

test("capture A and replacement B have distinct restore targets: capture is refused and only B's ID is claimed", async () => {
  await withAgentDir(async () => {
    const a = "0a000000-0000-4000-8000-000000000061";
    const b = "0a000000-0000-4000-8000-000000000062";
    const original = remoteArchive(b);
    const capture = { ...remoteArchive(a), key: `${original.key}.11111111-2222-4333-8444-555555555555.restore-consume`, restorePending: true };
    const remote = await linkHost("Captured and replaced");
    const restoredKeys = [];
    try {
      remote.serve({
        listArchives: () => [capture, original],
        listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreArchive: ({ key }) => {
          restoredKeys.push(key);
          const claims = restoreClaims();
          assert.deepEqual(claims.map((claim) => claim.session_id), [b]);
          return { ok: true, value: { sessionId: b } };
        },
      });
      const blocked = await restoreRequest(capture.key, remote.id);
      assert.deepEqual([blocked.status, (await blocked.json()).code], [409, "archive_restore_unconfirmed"]);
      assert.deepEqual(restoredKeys, []);
      const response = await restoreRequest(original.key, remote.id);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).sessionId, b);
      assert.deepEqual(restoredKeys, [original.key]);
    } finally { closeHostLink(remote.id); }
  });
});

/** The restore claims on disk as `{ session_id, host_id }` (`host_id` set: held for a remote restore); with `idleMs`, first
 * ages every claim to that long without renewal, as if its request had died. */
function restoreClaims(idleMs) {
  const db = new Database(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "archive-restore-locks.sqlite"));
  try {
    if (idleMs !== undefined) db.prepare("UPDATE restore_claims SET renewed_at = ?").run(Date.now() - idleMs);
    return db.prepare("SELECT session_id, host_id FROM restore_claims").all().map((row) => ({ ...row }));
  } finally { db.close(true); }
}

test("restore checks raw same-host and later-host duplicate IDs without consuming either archive", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000045";
    const selected = await linkHost("Selected");
    const later = await linkHost("Later");
    let restores = 0;
    let foreign = false;
    try {
      selected.serve({ listArchives: () => [remoteArchive(id)],
        listSessions: () => [{ ...listedSession(id), path: "/different/active.jsonl" }],
        restoreArchive: () => { restores++; return { ok: true, value: { sessionId: id } }; } });
      later.serve({ listSessions: () => foreign ? [listedSession(id)] : [] });
      const same = await restoreRequest(remoteArchive(id).key, selected.id);
      assert.equal(same.status, 409);
      assert.equal((await same.json()).code, "archive_restore_failed");
      foreign = true;
      const both = await restoreRequest(remoteArchive(id).key, selected.id);
      assert.equal(both.status, 409);
      assert.equal((await both.json()).code, "session_host_conflict");
      assert.equal(restores, 0);
    } finally {
      closeHostLink(selected.id);
      closeHostLink(later.id);
    }
  });
});

test("restore fails closed for an uncached offline host or a rejected linked listing", async () => {
  for (const offline of [true, false]) {
    await withAgentDir(async (dir) => {
      const id = "0a000000-0000-4000-8000-000000000046";
      const archiveDir = join(dir, "..", "..", "archive", "sessions", "-project");
      mkdirSync(archiveDir, { recursive: true });
      const file = join(archiveDir, "kept.jsonl.gz");
      const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`));
      writeFileSync(file, bytes);
      const broken = await linkHost("Unavailable");
      const selected = await linkHost("Selected");
      let restores = 0;
      try {
        selected.serve({ listArchives: () => [remoteArchive(id)], listSessions: () => [],
          restoreArchive: () => { restores++; return { ok: true, value: { sessionId: id } }; } });
        if (offline) closeHostLink(broken.id);
        else broken.serve({ listSessions: () => { throw new Error("listing failed"); } });
        for (const [key, hostId] of [["-project/kept.jsonl.gz", "local"], [remoteArchive(id).key, selected.id]]) {
          const response = await restoreRequest(key, hostId);
          assert.equal(response.status, 503);
          const body = await response.json();
          assert.equal(body.code, offline ? "host_offline" : "host_sessions_unavailable");
          // Even a local restore names the offline host that blocks it.
          if (offline) assert.deepEqual([body.host, body.hostOffline], ["Unavailable", true]);
          assert.deepEqual(readFileSync(file), bytes);
          assert.equal(restores, 0);
        }
      } finally {
        closeHostLink(broken.id);
        closeHostLink(selected.id);
      }
    });
  }
});

test("concurrent same-ID restores on different hosts cannot both consume archives", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000047";
    const first = await linkHost("First");
    const second = await linkHost("Second");
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const consumed = [];
    try {
      for (const remote of [first, second]) remote.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: `d-${remote.id}` } }),
        restoreArchive: async () => {
          entered();
          await gate;
          consumed.push(remote.id);
          return { ok: true, value: { sessionId: id } };
        },
      });
      const winner = restoreRequest(remoteArchive(id).key, first.id);
      await started;
      try {
        const loser = await restoreRequest(remoteArchive(id).key, second.id);
        assert.equal(loser.status, 409);
        assert.equal((await loser.json()).code, "archive_restore_busy");
      } finally { release(); }
      assert.equal((await winner).status, 200);
      assert.deepEqual(consumed, [first.id]);
    } finally {
      release();
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

/** The daemon end of restore admission as `sessionOps` keeps it: a restore starts only under a claim that was reserved and
 * not fenced since. `state.published`: whether this host lists the session. */
function admissionOps(id, state) {
  return {
    listArchives: () => [remoteArchive(id)],
    listSessions: () => (state.published ? [listedSession(id)] : []),
    restoreReserve: ({ claim }) => { state.reserved.add(claim); return { ok: true, value: { instance: state.instance } }; },
    restoreFence: ({ claim }) => { state.reserved.delete(claim); return { ok: true, value: { instance: state.instance, running: state.running.has(claim) } }; },
  };
}

/** A restore request reaching the daemon: whether it started (nothing answers it, as when main stopped waiting). */
function deliverRestore(state, claim) {
  if (!state.reserved.delete(claim)) return false;
  state.running.add(claim);
  return true;
}

/** One daemon process's restore state: its `instance`, the tokens reserved and not spent or fenced, those running. */
const daemonState = (instance) => ({ instance, reserved: new Set(), running: new Set(), published: false });

for (const [n, loss] of [[0, "a silent host"], [1, "a lost link"]]) {
  test(`a remote restore left unanswered by ${loss} keeps its session claimed, so another host cannot publish a duplicate before the daemon stops`, async () => {
    await withAgentDir(async () => {
      const id = `0a000000-0000-4000-8000-00000000005${n}`;
      const key = remoteArchive(id).key;
      const first = await linkHost("Slow restore");
      const second = await linkHost("Other host");
      // The daemon behind `first` keeps restoring after main stopped waiting, then has published the session.
      const daemon = daemonState("d1");
      let secondRestores = 0;
      const serveFirst = () => void first.serve(admissionOps(id, daemon), (message) => {
        if (message.type !== "req" || message.op !== "restoreArchive") return;
        deliverRestore(daemon, message.args.claim);
        if (loss === "a lost link") first.drop();
      });
      try {
        serveFirst();
        second.serve({
          listArchives: () => [remoteArchive(id)], listSessions: () => [],
          restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
          restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
        });
        const timeout = linkTimings.opTimeoutMs;
        linkTimings.opTimeoutMs = 250;
        let unanswered;
        try { unanswered = await restoreRequest(key, first.id); } finally { linkTimings.opTimeoutMs = timeout; }
        assert.equal(unanswered.status, loss === "a silent host" ? 504 : 503);
        assert.equal((await unanswered.json()).code, "archive_restore_unconfirmed");
        assert.equal(daemon.running.size, 1, "the daemon has the restore");
        assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);

        // Its request is gone but the claim still renews: busy.
        const busy = await restoreRequest(key, second.id);
        assert.deepEqual([busy.status, (await busy.json()).code], [409, "archive_restore_busy"]);
        // An hour without renewal: a plain lease would have lapsed, but only the daemon's word frees this claim.
        restoreClaims(3_600_000);
        const refused = await restoreRequest(key, second.id);
        assert.deepEqual([refused.status, (await refused.json()).code], [409, "archive_restore_unconfirmed"]);
        assert.equal(secondRestores, 0);
        assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);

        // The daemon publishes and reports it stopped: the claim goes, and the session is seen active on `first`.
        daemon.running.clear();
        daemon.published = true;
        if (loss === "a lost link") {
          await first.dial();
          serveFirst();
        }
        const conflict = await restoreRequest(key, second.id);
        assert.deepEqual([conflict.status, (await conflict.json()).code], [409, "session_host_conflict"]);
        assert.equal(secondRestores, 0, "the other host's archive was never consumed");
        assert.deepEqual(restoreClaims(), []);
      } finally {
        closeHostLink(first.id);
        closeHostLink(second.id);
      }
    });
  });
}

test("a restore request a suspended sender delivers late is refused once another request fenced its claim, so only one host publishes", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000053";
    const key = remoteArchive(id).key;
    const first = await linkHost("Suspended sender's host");
    const second = await linkHost("Other host");
    const daemon = daemonState("d1");
    // The sender held its claim and reserved here, then was suspended: its restore request reaches the daemon only later.
    const delayed = [];
    let secondRestores = 0;
    try {
      void first.serve(admissionOps(id, daemon), (message) => {
        if (message.type === "req" && message.op === "restoreArchive") delayed.push(message.args.claim);
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      assert.equal(delayed.length, 1);
      assert.equal(daemon.running.size, 0, "the daemon has not seen the restore yet");
      // The claim is stale and the daemon says nothing runs, but only because its fence now revokes the claim: another host restores.
      restoreClaims(3_600_000);
      assert.equal((await restoreRequest(key, second.id)).status, 200);
      assert.equal(secondRestores, 1);
      // The suspended sender wakes and its request arrives: refused, so the session exists once.
      assert.equal(deliverRestore(daemon, delayed[0]), false);
      assert.equal(daemon.running.size, 0);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

test("a held restore on a daemon that cannot fence stays blocked", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000052";
    const key = remoteArchive(id).key;
    const first = await linkHost("Daemon without restoreFence");
    const second = await linkHost("Other host");
    let secondRestores = 0;
    try {
      void first.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreFence: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: restoreFence"); },
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      restoreClaims(3_600_000);
      const refused = await restoreRequest(key, second.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /Unknown host op: restoreFence/);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

test("a restore is never sent to a daemon that cannot reserve it, and leaves no claim behind", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000055";
    const bare = await linkHost("Daemon without restoreReserve");
    let restores = 0;
    try {
      void bare.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: restoreReserve"); },
        restoreArchive: () => { restores++; return { ok: true, value: { sessionId: id } }; },
      });
      const response = await restoreRequest(remoteArchive(id).key, bare.id);
      assert.deepEqual([response.status, (await response.json()).code], [501, "unknown_op"]);
      assert.equal(restores, 0);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(bare.id);
    }
  });
});

test("a held restore whose host was unregistered stays blocked: unregistering does not stop its daemon", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000054";
    const key = remoteArchive(id).key;
    const first = await linkHost("Soon unregistered");
    const second = await linkHost("Other host");
    const daemon = daemonState("d1");
    let secondRestores = 0;
    try {
      void first.serve(admissionOps(id, daemon), (message) => {
        if (message.type === "req" && message.op === "restoreArchive") deliverRestore(daemon, message.args.claim);
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      revokeHost(first.id);
      restoreClaims(3_600_000);
      const refused = await restoreRequest(key, second.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /no longer registered/);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

test("a restore whose daemon was replaced stays blocked: the replacement cannot fence the original, which may still publish; the original itself can", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000056";
    const key = remoteArchive(id).key;
    const first = await linkHost("Replaced daemon");
    const second = await linkHost("Other host");
    // d1 took the restore and keeps running it: it is shared with another server, so losing this server's link ends nothing.
    const d1 = daemonState("d1");
    let secondRestores = 0;
    try {
      void first.serve(admissionOps(id, d1), (message) => {
        if (message.type === "req" && message.op === "restoreArchive") deliverRestore(d1, message.args.claim);
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      assert.equal(d1.running.size, 1, "d1 has the restore");

      // d2, another process with this host's id and token, takes the link over. It reserved nothing, so its fence reports
      // nothing running: true of d2, and no proof about d1.
      const d2 = daemonState("d2");
      const replacement = new LinkDriver(first.id, first.token);
      await replacement.dial();
      void replacement.serve(admissionOps(id, d2));
      restoreClaims(3_600_000);
      for (const afterPublish of [false, true]) {
        const refused = await restoreRequest(key, second.id);
        const body = await refused.json();
        assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
        assert.match(body.error, /replaced or restarted/);
        assert.equal(secondRestores, 0, "the other host's archive was never consumed");
        assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
        // d1 finishes and publishes between the attempts: still blocked, and no duplicate follows.
        if (!afterPublish) Object.assign(d1, { published: true, running: new Set() });
      }

      // The original daemon is the one linked again (a fresh driver: its sequence numbers start over, as a redial that
      // acks nothing): its own fence is authoritative, and the published session is a conflict.
      const survivor = new LinkDriver(first.id, first.token);
      await survivor.dial();
      void survivor.serve(admissionOps(id, d1), () => {});
      const conflict = await restoreRequest(key, second.id);
      assert.deepEqual([conflict.status, (await conflict.json()).code], [409, "session_host_conflict"]);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

test("a restore refused as not admitted keeps its claim: only the daemon that reserved the token can say it was never spent", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000057";
    const key = remoteArchive(id).key;
    const first = await linkHost("Resent to a replacement");
    const second = await linkHost("Other host");
    // d1 reserved the token. The request was answered by the daemon linked now, d2, which never saw it: a refusal that proves
    // nothing about d1, which may be running a restore it was sent before the replacement.
    let fence = { instance: "d2", running: false };
    let secondRestores = 0;
    try {
      void first.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreArchive: () => ({ ok: false, status: 409, code: "archive_restore_not_admitted", error: "This restore was not admitted or was fenced; the archive was not consumed" }),
        restoreFence: () => ({ ok: true, value: fence }),
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const refused = await restoreRequest(key, first.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /did not run this restore/);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id], "a refusal to admit never releases the claim");

      // The fence is answered by d2: it cannot clear d1's claim, however long it has been idle.
      restoreClaims(3_600_000);
      const blocked = await restoreRequest(key, second.id);
      assert.deepEqual([blocked.status, (await blocked.json()).code], [409, "archive_restore_unconfirmed"]);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);

      // d1 itself answers the fence, with nothing running and its token revoked: now the claim may be taken over.
      fence = { instance: "d1", running: false };
      const taken = await restoreRequest(key, second.id);
      assert.equal(taken.status, 200);
      assert.equal(secondRestores, 1);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

test("a held claim written without the daemon process that took it is never taken over, and its host is not asked", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000058";
    const key = remoteArchive(id).key;
    const first = await linkHost("Earlier build's host");
    const second = await linkHost("Other host");
    let fences = 0;
    let secondRestores = 0;
    try {
      void first.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreFence: () => { fences++; return { ok: true, value: { instance: "d1", running: false } }; },
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      // The row as a build that recorded no process leaves it.
      const db = new Database(join(dir, "..", "..", "omp-web", "archive-restore-locks.sqlite"));
      try { db.prepare("UPDATE restore_claims SET instance = NULL").run(); } finally { db.close(true); }
      restoreClaims(3_600_000);
      const refused = await restoreRequest(key, second.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /without the daemon process/);
      assert.equal(fences, 0, "no answer could be matched to the claim, so none is asked for");
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

test("restore rejects invalid archive session IDs before invoking restore", async () => {
  await withAgentDir(async () => {
    const remote = await linkHost("Invalid archive");
    let restores = 0;
    try {
      remote.serve({ listArchives: () => [remoteArchive("../invalid")],
        restoreArchive: () => { restores++; } });
      const response = await restoreRequest(remoteArchive("../invalid").key, remote.id);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "archive_session_invalid");
      assert.equal(restores, 0);
    } finally { closeHostLink(remote.id); }
  });
});

test("archive restore retains an old daemon's unavailable response without invoking restore", async () => {
  await withAgentDir(async () => {
    let restores = 0;
    const remote = await linkHost("Old daemon");
    try {
      remote.serve({
        listArchives() { throw new HostOpError(501, "unknown_op", "Unknown host op: listArchives"); },
        restoreArchive() { restores++; },
      });
      const response = await archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "-srv/kept.jsonl.gz", hostId: remote.id }),
      }));
      assert.equal(response.status, 501);
      assert.equal((await response.json()).code, "unknown_op");
      assert.equal(restores, 0);
    } finally {
      closeHostLink(remote.id);
    }
  });
});

test("a remote session archives on its own host: POST /api/sessions/[id]/archive no longer answers 501", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000042";
    const archivedIds = [];
    const remote = await linkHost("Remote");
    try {
      remote.serve({
        listSessions: () => [listedSession(id, "/srv/app")],
        archiveSession({ id: sessionId }) {
          archivedIds.push(sessionId);
          return { ok: true, value: { archivedPath: `/srv/archive/${sessionId}.jsonl.gz` } };
        },
      });
      const res = await sessionArchiveRoute.POST(new Request(`http://localhost/api/sessions/${id}/archive`, { method: "POST" }), { params: Promise.resolve({ id }) });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, archived: true, archivedPath: `/srv/archive/${id}.jsonl.gz` });
      assert.deepEqual(archivedIds, [id]);
    } finally {
      closeHostLink(remote.id);
    }
  });
});

test("a browser-held message for an archived session is accepted and held until it is restored, not refused", async () => {
  const { outboxEntries, runOutboxCommand } = await import("./message-outbox.ts");
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000023";
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const lines = [
      { type: "session", version: 3, id, cwd: dir, timestamp: "2026-01-02T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "before archiving" } },
    ];
    writeFileSync(join(archived, "2026-01-02_held.jsonl.gz"), gzipSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)));
    const add = (entryId) => runOutboxCommand(id, { type: "outbox_add", scope: outboxScope(), id: entryId, mode: "prompt", message: "saved offline" }, false, "owner");
    const accepted = await add("archived-held");
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.deepEqual(outboxEntries(id).map((entry) => [entry.id, entry.state]), [["archived-held", "held"]]);
    // A session that is neither listed nor archived is still gone.
    const gone = await runOutboxCommand("0a000000-0000-4000-8000-000000000024", { type: "outbox_add", scope: outboxScope(), id: "gone-held", mode: "prompt", message: "x" }, false, "owner");
    assert.equal(gone.status, 404);
  });
});

test("an unknown session remains retryable until its daemon can establish absence", async () => {
  const id = "0a000000-0000-4000-8000-000000000021";
  const get = () => sessionRoute.GET(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
  // Neither an offline daemon nor a failed linked list proves the session is gone.
  await withAgentDir(async () => {
    const offline = await get();
    assert.equal(offline.status, 503);
    const body = await offline.json();
    assert.deepEqual([body.code, body.hostOffline, body.delivery], ["host_offline", true, "refused"]);
  }, null);
  await withAgentDir(async () => {
    const unlisted = await get();
    assert.equal(unlisted.status, 503, "linked, but its list never arrived");
    const body = await unlisted.json();
    assert.equal(body.code, "host_sessions_unavailable");
    assert.equal(body.hostOffline, undefined, "a linked list failure retries without requiring a host reconnect");
  }, { listSessions: () => { throw new Error("sessions dir unreadable"); } });
  await withAgentDir(async () => {
    const gone = await get();
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).code, "session_not_found");
  });
});

test("a live session resolves to its own host before any list has it", async (t) => {
  const id = "0a000000-0000-4000-8000-000000000022";
  const exported = [];
  const host = {
    id: "local",
    label: "This machine",
    status: () => "online",
    sessionOps: {
      async exportSession(sessionId) {
        exported.push(sessionId);
        return { ok: true, value: { html: "<p>live</p>", fileName: "live.html" } };
      },
    },
  };
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[id, { isAlive: () => true, host }]]);
  t.after(() => { globalThis.__ompSessions = previousSessions; });
  // No daemon has listed anything: without the live session this answers 503.
  await withAgentDir(async () => {
    const response = await exportRoute.GET(new Request(`http://localhost/api/sessions/${id}/export`), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<p>live</p>");
    assert.deepEqual(exported, [id]);
  }, null);
});

test("POST /api/sessions/import rejects unauthorized workspaces and malformed files", async () => {
  await withAgentDir(async () => {
    const unauthorized = mkdtempSync(join(tmpdir(), "omp-web-import-denied-"));
    try {
      const goodEntries = [
        JSON.stringify({ type: "session", version: 3, id: "any", cwd: unauthorized, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "x" } }),
      ];

      const post = (body) => importRoute.POST(new Request("http://localhost/api/sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));

      // Workspace never authorized through projects/sessions/cwd selection.
      const denied = await post({ fileName: "x.jsonl", content: goodEntries.join("\n") + "\n" });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "import_cwd_not_authorized");

      // Malformed JSON line.
      const malformed = await post({
        fileName: "x.jsonl",
        content: goodEntries[0] + "\n{not json}\n",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).code, "invalid_session_file");

      // Missing session header (no cwd anywhere).
      const noHeader = await post({
        fileName: "x.jsonl",
        content: JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "x" } }) + "\n",
      });
      assert.equal(noHeader.status, 400);
      assert.equal((await noHeader.json()).code, "invalid_session_file");

      // Path traversal in fileName.
      const traversal = await post({ fileName: "../escape.jsonl", content: goodEntries.join("\n") + "\n" });
      assert.equal(traversal.status, 400);
      assert.equal((await traversal.json()).code, "invalid_file_name");
    } finally {
      globalThis.__piAdditionalAllowedRoots?.delete(normalizeSlashes(unauthorized));
      globalThis.__piAllowedRootsCache?.roots.delete(normalizeSlashes(unauthorized));
      rmSync(unauthorized, { recursive: true, force: true });
    }
  });
});

test("sync serves paged file-only history and preserves the legacy context shape", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000009";
    writeSessionFile(dir, "2026-01-01_sync.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }, [
      { type: "message", id: "one", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "one" } },
      { type: "message", id: "two", parentId: "one", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "two" }] } },
    ]);
    const legacy = await (await getContext(id)).json();
    assert.deepEqual(Object.keys(legacy), ["context"]);
    const response = await getContext(id, "sync=1&limit=1&deferThinking");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const first = await response.json();
    assert.equal(first.sessionId, id);
    assert.equal(first.leafId, "two");
    assert.equal(first.live, null);
    assert.equal(globalThis.__ompSessions?.has(id) ?? false, false, "history browsing creates no native wrapper");
    assert.equal(first.mode, "replace");
    assert.deepEqual(first.context.entryIds, ["one"]);
    assert.equal(first.hasMore, true);
    const second = await (await getContext(id, `sync=1&deferThinking&cursor=${encodeURIComponent(JSON.stringify(first.cursor))}`)).json();
    assert.equal(second.mode, "append");
    assert.equal(second.baseEntryId, "one");
    assert.deepEqual(second.context.entryIds, ["two"]);
    assert.deepEqual(second.context.messages[0].content, [{ type: "thinking", thinking: "", deferred: true }, { type: "text", text: "two" }]);
    assert.equal(second.hasMore, false);
    assert.equal("tree" in second, false);
    assert.equal("messages" in second, false);
  });
});

test("boundary returns only the latest compaction-aware active context IDs without a native wrapper", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-00000000000a";
    const filePath = writeSessionFile(dir, "0a000000-0000-4000-8000-00000000000a.jsonl", { id, cwd: dir }, [
      { type: "message", id: "old", parentId: null, message: { role: "user", content: "omitted" } },
      { type: "message", id: "kept", parentId: "old", message: { role: "user", content: "retained" } },
      { type: "compaction", id: "summary", parentId: "kept", summary: "condensed", firstKeptEntryId: "kept", tokensBefore: 50 },
      { type: "message", id: "inactive", parentId: "summary", message: { role: "assistant", content: "other branch" } },
      { type: "message", id: "active", parentId: "summary", message: { role: "assistant", content: "current branch" } },
    ]);
    const response = await getContext(id, "boundary=1");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const boundary = await response.json();
    assert.deepEqual(boundary, { entryIds: ["summary", "kept", "active"] });
    const full = await (await getContext(id)).json();
    assert.deepEqual(boundary.entryIds, full.context.entryIds);
    assert.deepEqual(await (await getContext(id, "boundary=1")).json(), boundary);
    assert.equal(globalThis.__ompSessions?.has(id) ?? false, false, "boundary browsing creates no native wrapper");
    writeFileSync(filePath, JSON.stringify({ type: "session", version: 3, id, cwd: dir }) + "\n");
    assert.deepEqual(await (await getContext(id, "boundary=1")).json(), { entryIds: [] });
  });
});

test("boundary rejects invalid modes and incompatible options before resolving a session", async () => {
  for (const query of ["boundary=", "boundary=0", "boundary=true", "boundary=1&boundary=0"]) {
    const response = await getContext("missing-boundary", query);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_boundary");
  }
  for (const option of ["sync=1", "leafId=", "includePreCompaction", "cursor=", "limit=1"]) {
    const response = await getContext("missing-boundary", `boundary=1&${option}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_boundary_options");
  }
  assert.equal((await getContext("missing-boundary", "boundary=1")).status, 404);
});

test("boundary preserves malformed-header and oversized-file errors", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-00000000000b";
    const filePath = writeSessionFile(dir, "0a000000-0000-4000-8000-00000000000b.jsonl", { id, cwd: dir });
    cacheSessionPath(id, filePath);
    makeOversized(filePath);
    const validHeader = await getContext(id, "boundary=1");
    assert.equal(validHeader.status, 413);
    assert.equal((await validHeader.json()).code, "session_file_too_large");
    writeFileSync(filePath, "not a session\n");
    const malformed = await getContext(id, "boundary=1");
    assert.equal(malformed.status, 404);
    assert.equal((await malformed.json()).code, "session_file_malformed");
    makeOversized(filePath);
    const invalidHeader = await getContext(id, "boundary=1");
    assert.equal(invalidHeader.status, 413);
    assert.equal((await invalidHeader.json()).code, "session_file_too_large");
  });
});

test("sync samples current live output after the history read and excludes pinned historical views", async () => {
  const { sessionOps } = await import("./hosts/session-ops.ts");
  let emit;
  let emittedDuringRead = false;
  // The history read is this machine's daemon op: output arriving while it runs must reach the response.
  const readContextOp = async ({ id, leafId, options }) => {
    if (!emittedDuringRead) {
      emittedDuringRead = true;
      queueMicrotask(() => emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "during read" }] } }));
    }
    return sessionOps.readContext(id, leafId, options);
  };
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-00000000000c";
    writeSessionFile(dir, "2026-01-01_live.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }, [
      { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "history-read" } },
      { type: "message", id: "tip", parentId: "old", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [] } },
    ]);
    const wrapper = new AgentSessionWrapper({
      isAlive: true,
      onFrame(listener) { emit = listener; return () => {}; },
      sendCommand: async () => { throw new Error("sync must not query or start the native process"); },
      sendFrame() {},
      dispose: async () => {},
    }, dir);
    wrapper.start();
    globalThis.__ompSessions ??= new Map();
    globalThis.__ompSessions.set(id, wrapper);
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "before read" }] } });
    try {
      const readContext = (query) => contextRoute.GET(
        new Request(`http://localhost/api/sessions/${id}/context?${query}`),
        { params: Promise.resolve({ id }) },
      );
      const initial = await (await readContext("sync=1")).json();
      assert.equal(emittedDuringRead, true);
      assert.equal(initial.live.streamingMessage.content[0].text, "during read");
      assert.deepEqual(initial.live.cursor, wrapper.getStreamSnapshot().cursor);
      const quiet = await (await readContext(`sync=1&cursor=${encodeURIComponent(JSON.stringify(initial.cursor))}`)).json();
      assert.deepEqual(quiet.context.messages, []);
      assert.deepEqual(quiet.live, initial.live, "no new tokens are needed to recover partial output");
      const pinned = await (await readContext("sync=1&leafId=old")).json();
      assert.deepEqual(pinned.context.entryIds, ["old"]);
      assert.equal(pinned.live, null);
      const current = await (await readContext("sync=1&leafId=tip")).json();
      assert.equal(current.live.streamingMessage.content[0].text, "during read");
    } finally {
      await wrapper.destroyAndWait();
      globalThis.__ompSessions.delete(id);
    }
  }, { readContext: readContextOp });
});

test("sync rejects malformed cursor, page bounds and mode before reading a session", async () => {
  for (const cursor of ["{", "null", "[]", "{}", '{"firstEntryId":"","lastEntryId":""}', JSON.stringify({ firstEntryId: "x", lastEntryId: "x".repeat(257) })]) {
    const response = await getContext("missing", `sync=1&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_sync_cursor");
  }
  for (const limit of ["", "0", "-1", "201", "1.5", "1e2", "Infinity", " 2"]) {
    const response = await getContext("missing", `sync=1&limit=${encodeURIComponent(limit)}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_sync_limit");
  }
  const mode = await getContext("missing", "sync=wrong");
  assert.equal(mode.status, 400);
  assert.equal((await mode.json()).code, "invalid_sync");
  const missing = await getContext("missing-sync-session", "sync=1");
  assert.equal(missing.status, 404);
});

test("sync preserves the too-large and malformed-file error contracts", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_big-sync.jsonl", {
      id: "0a000000-0000-4000-8000-00000000000d", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z",
    });
    // Listed by the daemon while its header is valid; it turns malformed below.
    const malformedPath = writeSessionFile(dir, "2026-01-01_malformed-sync.jsonl", {
      id: "0a000000-0000-4000-8000-00000000000e", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z",
    });
    makeOversized(filePath);
    const large = await getContext("0a000000-0000-4000-8000-00000000000d", "sync=1");
    assert.equal(large.status, 413);
    assert.equal((await large.json()).code, "session_file_too_large");
    writeFileSync(malformedPath, "not a session\n");
    const malformed = await getContext("0a000000-0000-4000-8000-00000000000e", "sync=1");
    assert.equal(malformed.status, 404);
    assert.equal((await malformed.json()).code, "session_file_malformed");
  });
});

test("sync recovers the first live reply before persistence without erasing an established cursor", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-00000000000f";
    const filePath = join(dir, "2026-01-01_not-yet-persisted.jsonl");
    let emit;
    let stateLoaded = false;
    const wrapper = new AgentSessionWrapper({
      isAlive: true,
      onFrame(listener) { emit = listener; return () => {}; },
      sendCommand: async () => {
        if (stateLoaded) throw new Error("sync must not call native RPC");
        stateLoaded = true;
        return { sessionId: id, sessionFile: filePath, isStreaming: false, isCompacting: false };
      },
      sendFrame() {},
      dispose: async () => {},
    }, dir);
    wrapper.start();
    await wrapper.send({ type: "get_state" });
    globalThis.__ompSessions ??= new Map();
    globalThis.__ompSessions.set(id, wrapper);
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first partial reply" }] } });
    try {
      const response = await getContext(id, "sync=1");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const first = await response.json();
      assert.equal(first.mode, "replace");
      assert.deepEqual(first.context.entryIds, []);
      assert.deepEqual(first.context.messages, []);
      assert.deepEqual(first.cursor, { firstEntryId: null, lastEntryId: null });
      assert.equal(first.leafId, null);
      assert.equal(first.live.streamingMessage.content[0].text, "first partial reply");
      assert.equal(first.live.isPromptRunning, true);
      assert.equal(existsSync(filePath), false);
      const quiet = await (await getContext(id, `sync=1&cursor=${encodeURIComponent(JSON.stringify(first.cursor))}`)).json();
      assert.equal(quiet.mode, "append");
      assert.deepEqual(quiet.live, first.live);
      const establishedCursor = { firstEntryId: "saved-first", lastEntryId: "saved-last" };
      const unavailable = await getContext(id, `sync=1&cursor=${encodeURIComponent(JSON.stringify(establishedCursor))}`);
      assert.equal(unavailable.status, 404);
      assert.equal("context" in await unavailable.json(), false, "an unavailable file is not an empty-history reset");
      assert.equal((await getContext(id, "sync=1&leafId=saved-branch")).status, 404);
      assert.equal((await getContext(id)).status, 404, "legacy no-sync existence rules remain unchanged");
      // A live session that has not persisted anything yet has an empty boundary:
      // the next prompt must be dispatchable (a 404 here aborted the send).
      const emptyBoundary = await getContext(id, "boundary=1");
      assert.equal(emptyBoundary.status, 200);
      assert.equal(emptyBoundary.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await emptyBoundary.json(), { entryIds: [] }, "an unpersisted live session has an empty boundary");
      writeFileSync(filePath, "malformed existing file\n");
      assert.equal((await getContext(id, "boundary=1")).status, 404, "an existing unresolvable file is not an empty boundary");
      // No host lists the bad file, so it resolves like any unknown id: never as not-yet-persisted.
      const malformed = await getContext(id, "sync=1");
      assert.equal(malformed.status, 404);
      assert.equal("context" in await malformed.json(), false, "an existing bad file cannot masquerade as not-yet-persisted");
      globalThis.__ompSessions.delete(id);
      assert.equal((await getContext("file-only-missing", "sync=1")).status, 404);
      assert.equal((await getContext("file-only-missing", "boundary=1")).status, 404, "without a live wrapper a missing file stays 404");
    } finally {
      await wrapper.destroyAndWait();
      globalThis.__ompSessions.delete(id);
    }
  });
});

test("sidebar rename cannot fall back to disk while Edit owns the session", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000010";
    const filePath = writeSessionFile(dir, "0a000000-0000-4000-8000-000000000010.jsonl", { id, cwd: dir }, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "question" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
    ]);
    cacheSessionPath(id, filePath);
    const originalFile = readFileSync(filePath);
    const listeners = new Set();
    const commands = [];
    const state = { sessionId: id, sessionFile: filePath, isStreaming: false, isCompacting: false, queuedMessageCount: 0, isSettled: true };
    const { promise: started, resolve: didStart } = Promise.withResolvers();
    const { setSessionTitle } = await import("./omp/session-files.ts");
    let editRequest;
    const wrapper = new AgentSessionWrapper({
      isAlive: true,
      onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async sendCommand(command) {
        commands.push(command);
        if (command.type === "get_state") return { ...state };
        if (command.type === "get_available_commands") return { commands: [{ name: "omp-web-edit", source: "extension" }] };
        if (command.type === "prompt") {
          editRequest = JSON.parse(command.message.slice("/omp-web-edit ".length));
          didStart();
          return null;
        }
        if (command.type === "set_session_name") {
          state.sessionName = command.name;
          setSessionTitle(filePath, command.name, "user");
          return null;
        }
        throw new Error(`Unexpected native command: ${command.type}`);
      },
      sendFrame() {},
      async dispose() {},
    }, dir);
    wrapper.start();
    const previousSessions = globalThis.__ompSessions;
    globalThis.__ompSessions = new Map([[id, wrapper]]);
    let editing;
    const finishEdit = () => {
      if (!editRequest) return;
      const frame = { type: "extension_ui_request", method: "notify", message: "omp-web-edit:" + JSON.stringify({ requestId: editRequest.requestId, sessionId: id, cancelled: true, leafId: "a1" }) };
      editRequest = null;
      for (const listener of listeners) listener(frame);
    };
    const rename = () => sessionRoute.PATCH(new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Renamed" }),
    }), { params: Promise.resolve({ id }) });
    try {
      await wrapper.send({ type: "get_state" });
      editing = wrapper.send({ type: "edit_message", entryId: "u1" });
      await started;
      const rejected = await rename();
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.json()).code, "session_busy");
      assert.deepEqual(readFileSync(filePath), originalFile, "a busy rename must not rewrite the session title slot or journal");
      assert.equal(commands.some((command) => command.type === "set_session_name"), false);
      finishEdit();
      await editing;
      const accepted = await rename();
      assert.equal(accepted.status, 200);
      assert.equal((await wrapper.send({ type: "get_state" })).sessionName, "Renamed");
      assert.match(readFileSync(filePath, "utf8"), /"title":"Renamed"/);
    } finally {
      finishEdit();
      await editing?.catch(() => {});
      await wrapper.destroyAndWait();
      globalThis.__ompSessions = previousSessions;
    }
  });
});

test("automatic title fallback cannot write after Edit takes over", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000011";
    const filePath = writeSessionFile(dir, "0a000000-0000-4000-8000-000000000011.jsonl", { id, cwd: dir }, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Preserve this conversation" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
    ]);
    cacheSessionPath(id, filePath);
    const originalFile = readFileSync(filePath);
    let editing = false;
    let nativeRenames = 0;
    const rpc = {
      isAlive: () => true,
      host: getHost("local"),
      isEditingHistory: () => editing,
      async generateTitle() {
        // The generation finished without a title; another request acquired Edit.
        editing = true;
        return null;
      },
      async send() {
        nativeRenames += 1;
        throw new WebRpcError("Wait for the history edit to finish", "session_busy");
      },
    };
    const previousSessions = globalThis.__ompSessions;
    globalThis.__ompSessions = new Map([[id, rpc]]);
    try {
      const response = await autoNameRoute.POST(new Request(`http://localhost/api/sessions/${id}/auto-name`, { method: "POST" }), { params: Promise.resolve({ id }) });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "session_busy");
      assert.deepEqual(readFileSync(filePath), originalFile);
      assert.equal(nativeRenames, 0);
    } finally {
      globalThis.__ompSessions = previousSessions;
    }
  });
});
