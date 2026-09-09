import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const contextRoute = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const importRoute = await jiti.import("../app/api/sessions/import/route.ts");
const { invalidateSessionListCache, listAllSessions, resolveSessionPath } = await jiti.import("./session-reader.ts");
const { allowFileRoot, normalizeSlashes } = await jiti.import("./file-access.ts");

// MAX_SESSION_LOAD_BYTES from lib/omp/session-files.ts (1 GiB).
const MAX_SESSION_LOAD_BYTES = 1024 * 1024 * 1024;

/** Point the omp agent dir at a throwaway location for the duration of `run`. */
async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-routes-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // The global session-list cache (30s TTL) and the path cache could hold
  // entries from another test's agent dir; clear both so resolution sees only
  // THIS dir's files.
  invalidateSessionListCache();
  try {
    await run(projectDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

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
      id: "giant-session",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }]);
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/giant-session");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "giant-session" }) });

    assert.equal(res.status, 413, "valid header must not degrade to 200 with an empty transcript");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("context route returns 413 session_file_too_large when a valid-header file exceeds the load ceiling", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_giant.jsonl", {
      id: "giant-context",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }]);
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/giant-context/context?leafId=u1");
    const res = await contextRoute.GET(req, { params: Promise.resolve({ id: "giant-context" }) });

    assert.equal(res.status, 413, "valid header must not degrade to 200 with an empty context");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("oversized file with an INVALID header still 413s, not 404", async () => {
  await withAgentDir(async (dir) => {
    const filePath = join(dir, "2026-01-01_bad-giant.jsonl");
    writeFileSync(filePath, '{"type":"session","version":3,"id":"bad-giant","cwd":"/tmp","timestamp":"2026-01-01T00:00:00.000Z"}\n');
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/bad-giant");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "bad-giant" }) });

    assert.equal(res.status, 413, "too large is reported as too large even when the header scan fails");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("session and context routes still serve a normal-size file with 200", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-01-01_small.jsonl", {
      id: "small-session",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "world" } },
    ]);

    const req = new Request("http://localhost/api/sessions/small-session");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "small-session" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.context.messages.length, 2, "normal file still yields its transcript");
    assert.equal(body.leafId, "a1", "leaf resolves to the last entry");

    // Branch semantics: the context for a leaf is the path TO that leaf.
    // `u1` is the root, so its context is just itself; `a1` (a child of u1)
    // is a sibling branch whose context is u1 -> a1.
    const ctxReq = new Request("http://localhost/api/sessions/small-session/context?leafId=u1");
    const ctxRes = await contextRoute.GET(ctxReq, { params: Promise.resolve({ id: "small-session" }) });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.equal(ctxBody.context.messages.length, 1, "leaf u1 is the root, so its context contains only itself");
    assert.deepEqual(ctxBody.context.entryIds, ["u1"]);

    const branchReq = new Request("http://localhost/api/sessions/small-session/context?leafId=a1");
    const branchRes = await contextRoute.GET(branchReq, { params: Promise.resolve({ id: "small-session" }) });
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
      id: "gp-id",
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "gp" } }]);
    const parentPath = writeSessionFile(dir, "2026-01-02_parent.jsonl", {
      id: "parent-del",
      cwd,
      timestamp: "2026-01-02T00:00:00.000Z",
      parentSession: gpPath,
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "parent" } }]);
    writeSessionFile(dir, "2026-01-03_child.jsonl", {
      id: "child-del",
      cwd,
      timestamp: "2026-01-03T00:00:00.000Z",
      parentSession: parentPath,
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-03T00:00:00.000Z", message: { role: "user", content: "child" } }]);
    writeSessionFile(dir, "2026-01-04_childid.jsonl", {
      id: "child-id-del",
      cwd,
      timestamp: "2026-01-04T00:00:00.000Z",
      parentSession: "parent-del",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-04T00:00:00.000Z", message: { role: "user", content: "child-id" } }]);

    // Warm the list so id/path resolution is exercised the way the UI does.
    await listAllSessions();

    const res = await sessionRoute.DELETE(new Request("http://localhost/api/sessions/parent-del"), {
      params: Promise.resolve({ id: "parent-del" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    assert.equal(existsSync(parentPath), false, "deleted session's file must be gone");
    assert.equal(await resolveSessionPath("parent-del"), null, "deleted session must no longer resolve (stale cache would make omp create a new session on --resume)");

    const after = new Map((await listAllSessions()).map((s) => [s.id, s]));
    assert.equal(after.get("child-del")?.parentSessionId, "gp-id", "child linked by PATH form must re-attach to the grandparent path");
    assert.equal(after.get("child-id-del")?.parentSessionId, "gp-id", "child linked by ID form must re-attach to the grandparent id");
  });
});

test("POST /api/sessions/import writes a fresh-id copy and makes it visible immediately", async () => {
  await withAgentDir(async () => {
    const workspace = mkdtempSync(join(tmpdir(), "omp-web-import-ws-"));
    try {
      allowFileRoot(workspace);
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
      const sessions = await listAllSessions();
      const imported = sessions.find((s) => s.firstMessage === "imported hello");
      assert.ok(imported, "imported session must appear in the list right away (list invalidation)");
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
