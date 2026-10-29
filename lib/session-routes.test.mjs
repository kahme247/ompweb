import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { linkLocalDaemon } from "./hosts/link-driver.test-helper.mjs";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const contextRoute = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const importRoute = await jiti.import("../app/api/sessions/import/route.ts");
const archiveRoute = await jiti.import("../app/api/sessions/archive/route.ts");
const exportRoute = await jiti.import("../app/api/sessions/[id]/export/route.ts");
const stateRoute = await jiti.import("../app/api/sessions/[id]/state/route.ts");
const autoNameRoute = await jiti.import("../app/api/sessions/[id]/auto-name/route.ts");
const { cacheSessionPath, invalidateSessionListCache, listAllSessions, resolveSessionPath } = await jiti.import("./session-reader.ts");
const { allowFileRoot, normalizeSlashes } = await jiti.import("./file-access.ts");
const { AgentSessionWrapper, WebRpcError } = await jiti.import("./rpc-manager.ts");
const { closeHostLink, getHost } = await jiti.import("./hosts/hub.ts");
const { listSessionsAllHosts } = await jiti.import("./hosts/session-index.ts");

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

  const response = await getState(id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    running: false,
    exited: { id, cwd: "/tmp/project", at: 123, code: 1, signal: null, detail: "startup failed" },
  });
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

test("before this machine's daemon has listed its sessions, an unknown id answers offline, not gone", async () => {
  const id = "0a000000-0000-4000-8000-000000000021";
  const get = () => sessionRoute.GET(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
  // The client keeps the transcript on 503 hostOffline; a 404 would drop it.
  const offlineBody = { error: "This machine is offline", code: "host_offline", hostOffline: true, delivery: "refused" };
  await withAgentDir(async () => {
    const offline = await get();
    assert.equal(offline.status, 503);
    assert.deepEqual(await offline.json(), offlineBody);
  }, null);
  await withAgentDir(async () => {
    const unlisted = await get();
    assert.equal(unlisted.status, 503, "linked, but its list never arrived");
    assert.deepEqual(await unlisted.json(), offlineBody);
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
  const { sessionOps } = await jiti.import("./hosts/session-ops.ts");
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
    const { setSessionTitle } = await jiti.import("./omp/session-files.ts");
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
