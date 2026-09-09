import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sessionPathKey } = await jiti.import("./paths.ts");
const { serializeTitleSlot } = await jiti.import("./omp/session-files.ts");
const { SessionFileTooLargeError } = await jiti.import("./session-reader.ts");
const { subscribeSessionFileChanges } = await jiti.import("./session-watcher.ts");
const {
  buildSessionContext,
  cacheSessionPath,
  getSessionEntries,
  getSessionEntriesForDisplay,
  getTodoPhasesFromEntries,
  invalidateSessionCaches,
  getSessionEntriesForDisplayAsync,
  invalidateSessionListCache,
  invalidateSessionListMeta,
  invalidateSessionPathCache,
  listAllSessions,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
} = await jiti.import("./session-reader.ts");

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content,
    },
  };
}

function assistantEntry(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
    },
  };
}

test("renders the SDK compaction-aware context with aligned entry IDs", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp", "u2", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => [message.role, message.customType, message.content]),
    [
      ["custom", "compaction", "old exchange summary"],
      ["user", undefined, "kept user request"],
      ["user", undefined, "after compaction"],
    ],
  );
});

test("can expose pre-compaction entries for read-only transcript browsing", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction", id: "cmp", parentId: "u2", timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary", firstKeptEntryId: "u2", tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries, undefined, { includePreCompaction: true });

  assert.deepEqual(context.entryIds, ["u1", "a1", "u2", "cmp", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => message.role === "custom" ? message.customType : message.content),
    ["old user request", [{ type: "text", text: "old assistant answer" }], "kept user request", "compaction", "after compaction"],
  );
});

test("uses only the latest compaction on the active path", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "first kept request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "second kept answer"),
    userEntry("u3", "a2", "second kept request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp2", "a2", "u3", "a3"]);
  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].content, "latest summary");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("uses the selected leaf's path before a later compaction", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", "root answer"),
    userEntry("u2", "a1", "main branch"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main branch summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries, "alt");

  assert.deepEqual(context.entryIds, ["u1", "a1", "alt"]);
  assert.equal(context.messages.some((message) => message.role === "custom"), false);
});

test("returns an empty context for a null leaf", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "not active"),
  ], null);

  assert.deepEqual(context.messages, []);
  assert.deepEqual(context.entryIds, []);
});

test("reads the latest valid persisted todo snapshot from the selected branch", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "message",
      id: "todo-main",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolName: "todo",
        content: [],
        details: { phases: [{ name: "Main", tasks: [{ content: "Keep", status: "in_progress" }] }] },
      },
    },
    {
      type: "custom",
      id: "todo-alt",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "user_todo_edit",
      data: { phases: [{ name: "Alternate", tasks: [{ content: "Use this", status: "pending" }] }] },
    },
  ];

  assert.deepEqual(getTodoPhasesFromEntries(entries, "todo-main"), [
    { name: "Main", tasks: [{ content: "Keep", status: "in_progress" }] },
  ]);
  assert.deepEqual(buildSessionContext(entries, "todo-alt").todoPhases, [
    { name: "Alternate", tasks: [{ content: "Use this", status: "pending" }] },
  ]);
});

test("defers historical thinking without changing live-session content", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "large reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });

  const full = buildSessionContext(entries);
  assert.equal(full.messages[1].content[0].thinking, "large reasoning");
});

test("does not defer empty historical thinking blocks", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(context.messages[1].content[0], { type: "thinking", thinking: "" });
});

test("deferThinking tolerates string-content assistant entries without crashing", () => {
  // normalizeToolCalls passes non-array content through unchanged; the
  // defer-thinking branch must not 500 the context route for legacy entries.
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "assistant", content: "legacy plain-text answer" },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.equal(context.messages[1].role, "assistant");
  assert.equal(context.messages[1].content, "legacy plain-text answer");
});

test("defers only base64 images from historical tool results", () => {
  const userImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const toolImage = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" },
  };
  const toolUrlImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/result.png" },
  };
  const flatToolImage = {
    type: "image",
    data: "QUJDRA==",
    mimeType: "image/png",
  };
  const entries = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "Read image file" },
          toolImage,
          flatToolImage,
          toolUrlImage,
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(deferred.messages[2].content[1], toolUrlImage);
  assert.match(deferred.messages[2].content[2].text, /2 tool result images omitted.*image\/jpeg, image\/png.*~8 bytes/);

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content[1], toolImage);
  assert.deepEqual(full.messages[2].content[2], flatToolImage);
  assert.deepEqual(full.messages[2].content[3], toolUrlImage);
});

test("preserves hidden custom messages so the UI can render them collapsed", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
    assistantEntry("a1", "c1", "done"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "c1", "a1"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "extension_debug");
  assert.equal(context.messages[1].display, false);
  assert.equal(context.messages[1].content, "hidden extension payload");
});

test("preserves valid epoch timestamps on synthetic UI messages", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      summary: "epoch summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const context = buildSessionContext(entries);

  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].customType, "compaction");
  assert.equal(context.messages[0].timestamp, 0);
});

test("reads only a bounded session header, including headers larger than 4 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"p".repeat(5_000)}.jsonl`;
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    assert.equal(readSessionHeader(filePath)?.parentSession, parentSession);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null for malformed or unbounded session headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-invalid-"));
  const malformedPath = join(dir, "malformed.jsonl");
  const oversizedPath = join(dir, "oversized.jsonl");
  writeFileSync(malformedPath, "{not-json}\n");
  writeFileSync(oversizedPath, "x".repeat(64 * 1024));

  try {
    assert.equal(readSessionHeader(malformedPath), null);
    assert.equal(readSessionHeader(oversizedPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a throwaway agent dir with one project directory of session files. */
function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-agent-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  return Promise.resolve(run(projectDir)).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
}

function writeSessionFile(dir, name, header, entries = []) {
  const filePath = join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

// omp writes header.parentSession as a file path (RPC branch) OR as a bare
// session id (TUI /fork, `omp --fork`, /tan). Both must link to the parent.
test("links forked children whose parentSession is a bare session id", async () => {
  await withAgentDir(async (dir) => {
    const cwd = join(tmpdir(), "omp-web-missing-project");
    const parentPath = writeSessionFile(dir, "2026-01-01_parent.jsonl", {
      id: "parent-id",
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "root")]);
    writeSessionFile(dir, "2026-01-02_by-path.jsonl", {
      id: "child-by-path",
      cwd,
      timestamp: "2026-01-02T00:00:00.000Z",
      parentSession: parentPath,
    }, [userEntry("u1", null, "branched")]);
    writeSessionFile(dir, "2026-01-03_by-id.jsonl", {
      id: "child-by-id",
      cwd,
      timestamp: "2026-01-03T00:00:00.000Z",
      parentSession: "parent-id",
    }, [userEntry("u1", null, "forked")]);
    writeSessionFile(dir, "2026-01-04_orphan.jsonl", {
      id: "orphan",
      cwd,
      timestamp: "2026-01-04T00:00:00.000Z",
      parentSession: "gone-id",
    }, [userEntry("u1", null, "orphan")]);

    const byId = new Map((await listAllSessions()).map((s) => [s.id, s]));
    assert.equal(byId.get("child-by-path")?.parentSessionId, "parent-id");
    assert.equal(byId.get("child-by-id")?.parentSessionId, "parent-id");
    assert.equal(byId.get("orphan")?.parentSessionId, undefined);
  });
});

test("stops resolving a session path once the file is deleted", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_doomed.jsonl", {
      id: "doomed",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "hello")]);

    assert.equal(await resolveSessionPath("doomed"), filePath);
    unlinkSync(filePath);
    // A stale cache hit here would make the agent routes spawn omp with
    // --resume against a missing file, silently creating a new session.
    assert.equal(await resolveSessionPath("doomed"), null);
    assert.equal(globalThis.__piSessionPathCache?.has("doomed"), false);
  });
});

test("loads sessions larger than the line-reader chunk without corrupting text", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-large-"));
  const filePath = join(dir, "large.jsonl");
  // Multi-byte content and >1 MiB of it, so lines and characters both straddle
  // the reader's chunk boundaries.
  const count = 900;
  const lines = [JSON.stringify({
    type: "session",
    version: 3,
    id: "large",
    cwd: dir,
    timestamp: "2026-01-01T00:00:00.000Z",
  })];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify(userEntry(`u${i}`, i === 0 ? null : `u${i - 1}`, `${"あ".repeat(500)}${i}`)));
  }
  writeFileSync(filePath, `${lines.join("\n")}\n`);

  try {
    const entries = getSessionEntries(filePath);
    assert.equal(entries.length, count);
    assert.equal(entries[450].message.content, `${"あ".repeat(500)}450`);
    assert.equal(entries[count - 1].message.content, `${"あ".repeat(500)}${count - 1}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps forward and reverse session path caches in sync", async () => {
  const sessionId = "cache-test-session";
  const filePath = join(tmpdir(), "pi-web-cache-test", "..", "cache-test", "session.jsonl");

  cacheSessionPath(sessionId, filePath);
  try {
    assert.equal(
      await resolveSessionIdByPath(filePath),
      sessionId,
    );
  } finally {
    invalidateSessionPathCache(sessionId);
  }

  assert.equal(globalThis.__piSessionPathCache?.has(sessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(sessionPathKey(filePath)), false);
});

// The session-file walk cache keys on the sessions-root mtime, which does not
// change when a file is added inside an existing project subdirectory on some
// filesystems (Windows/NTFS). invalidateSessionListCache() must clear it so a
// brand-new session appears in the sidebar without a full app reload.
test("invalidateSessionListCache clears the session-file walk cache", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-01-01_first.jsonl", {
      id: "first",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "first")]);

    const before = await listAllSessions();
    assert.equal(before.some((s) => s.id === "first"), true);

    // Simulate the walk cache being populated; the root mtime does not change
    // when the new file lands inside the project subdirectory.
    writeSessionFile(dir, "2026-01-02_second.jsonl", {
      id: "second",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-02T00:00:00.000Z",
    }, [userEntry("u1", null, "second")]);

    // Without invalidation the stale walk cache would hide the new session.
    invalidateSessionListCache();
    const after = await listAllSessions();
    assert.equal(after.some((s) => s.id === "second"), true);
  });
});

test("invalidateSessionCaches(path) drops only that file's parse caches", async () => {
  await withAgentDir(async (dir) => {
    const fileA = writeSessionFile(dir, "2026-01-01_a.jsonl", {
      id: "a",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "a")]);
    const fileB = writeSessionFile(dir, "2026-01-01_b.jsonl", {
      id: "b",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "b")]);

    // Prime both per-file parse caches.
    getSessionEntries(fileA);
    getSessionEntries(fileB);

    const cacheKey = (p) => sessionPathKey(p);
    assert.equal(globalThis.__ompSessionEntriesCache?.has(cacheKey(fileA)), true);
    assert.equal(globalThis.__ompSessionEntriesCache?.has(cacheKey(fileB)), true);

    // Only A's entry is dropped; B's parse stays cached.
    invalidateSessionCaches(fileA);
    assert.equal(globalThis.__ompSessionEntriesCache?.has(cacheKey(fileA)), false, "A parse cache must drop");
    assert.equal(globalThis.__ompSessionEntriesCache?.has(cacheKey(fileB)), true, "B parse cache must survive");

    // Same-size + same-mtime replacement of A must be re-parsed after the
    // targeted invalidation: the targeted invalidation is the ONLY signal the
    // (size, mtimeMs) key cannot detect.
    const entries = getSessionEntries(fileA);
    assert.equal(entries.length, 1, "A re-parses to fresh contents after targeted invalidation");
  });
});

test("targeted invalidation catches same-size + same-mtime content changes", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_t.jsonl", {
      id: "t",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "version-one")]);

    // Normalize mtime to a whole-millisecond value FIRST so the restore below
    // is exact on filesystems with finer precision (NTFS 100ns): with a
    // fractional original, JS Date truncation would make mtimeMs differ after
    // utimesSync and the stat key would invalidate "for free", masking the
    // very staleness this test must catch.
    const FIXED_MTIME = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const originalStat = statSync(filePath);
    const originalSize = originalStat.size;
    const originalMtime = originalStat.mtimeMs;
    assert.equal(originalMtime, FIXED_MTIME.getTime(), "mtime normalized to whole ms");

    // Prime the parse cache keyed on (size, originalMtime).
    const cachedFirst = getSessionEntries(filePath);
    assert.equal(cachedFirst[0].message.content, "version-one");

    // Rewrite with DIFFERENT content of EXACTLY the same byte length, then
    // restore the mtime: (size, mtimeMs) now matches the cached entry again,
    // so only an explicit invalidation can see through.
    const rewrittenBody = JSON.stringify({ type: "session", version: 3, id: "t", cwd: join(tmpdir(), "omp-web-missing-project"), timestamp: "2026-01-01T00:00:00.000Z" })
      + "\n"
      + JSON.stringify(userEntry("u1", null, "version-two"))
      + "\n";
    assert.equal(
      Buffer.byteLength(rewrittenBody, "utf8"),
      originalSize,
      "rewrite must preserve byte length so the stat key cannot detect it",
    );
    writeFileSync(filePath, rewrittenBody);
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
    const restoredStat = statSync(filePath);
    assert.equal(restoredStat.size, originalSize, "size restored");
    assert.equal(restoredStat.mtimeMs, originalMtime, "mtime restored to pre-rewrite value");

    // WITHOUT invalidation the memoized parse must serve the STALE snapshot —
    // this proves the stat key alone cannot detect the change. Then the
    // targeted invalidation must force a fresh parse.
    const stale = getSessionEntries(filePath);
    assert.equal(stale[0].message.content, "version-one", "cached snapshot served without invalidation (stale)");

    invalidateSessionCaches(filePath);
    const fresh = getSessionEntries(filePath);
    assert.equal(fresh[0].message.content, "version-two", "same-size+mtime change must be picked up after targeted invalidation");
  });
});


test("task toolResults keep size-bounded details; other toolResults stay stripped", () => {
  const entries = [
    {
      type: "message",
      id: "t1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "task",
        content: [],
        details: {
          projectAgentsDir: "C:\work\agents",
          totalDurationMs: 360000,
          progress: [{ id: "Scout", agent: "scout", status: "running", task: "Map", tokens: 100, cost: 0.001 }],
          results: [{
            id: "Scout", agent: "scout", task: "Map", exitCode: 0, tokens: 999000, cost: 1.25,
            output: "x".repeat(5000),
            stderr: "err",
            aborted: false,
            resolvedModel: "m".repeat(5000),
            outputPath: "p".repeat(5000),
          }],
          async: { state: "completed", jobId: "Scout", type: "task", message: "x".repeat(10000) },
          agent: "a".repeat(5000),
        },
      },
    },
    {
      type: "message",
      id: "t2",
      parentId: "t1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "edit",
        content: [],
        details: { huge: "x".repeat(10000), patch: "the patch" },
      },
    },
  ];
  const context = buildSessionContext(entries);
  const taskMessage = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "tc1");
  const editMessage = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "tc2");
  assert.ok(taskMessage);
  const taskDetails = taskMessage.details ?? {};
  assert.ok(Array.isArray(taskDetails.results));
  assert.equal(taskDetails.results[0].tokens, 999000);
  // bulky output is not shipped to the client
  assert.equal("output" in taskDetails.results[0], false);
  assert.equal("stderr" in taskDetails.results[0], false);
  assert.equal(taskDetails.progress[0].id, "Scout");
  assert.equal(taskDetails.async.jobId, "Scout");
  // async is projected: extra payload fields never ride the response
  assert.equal("message" in taskDetails.async, false);
  // long scalar strings are truncated to the 240-char bound
  assert.equal(taskDetails.results[0].resolvedModel.length <= 241, true);
  assert.equal(taskDetails.results[0].outputPath.length <= 241, true);
  // agent is an allowlisted (truncated) field — present but bounded
  assert.equal(taskDetails.results[0].agent.length <= 241, true);
  // non-task details keep only the allowlisted patch/diff keys
  assert.deepEqual(editMessage.details, { patch: "the patch" });
});


test("message entries without a message object are skipped, not fatal", () => {
  // Imports and hand-edited files can contain type:"message" entries whose
  // `message` object is missing entirely. Every reader (context build, todo
  // phases, model inference) must skip them instead of throwing.
  const entries = [
    {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    },
    {
      type: "message",
      id: "bad1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    userEntry("u1", "bad1", "still readable"),
    {
      type: "message",
      id: "bad2",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: null,
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
  assert.deepEqual(context.entryIds, ["u1"]);

  assert.doesNotThrow(() => getTodoPhasesFromEntries(entries, "u1"));
});

test("single files larger than the cache budget are not cached, so they cannot starve peers", async () => {
  await withAgentDir(async (dir) => {
    // Tiny session to confirm the parse cache works normally.
    const smallPath = writeSessionFile(dir, "2026-01-01_small.jsonl", {
      id: "small",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "small")]);
    getSessionEntries(smallPath);
    assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(smallPath)), true, "normal files cache");

    // A file bigger than the whole budget must NOT be injected into the cache
    // (it would pin MAX_SESSION_ENTRIES_CACHE_BYTES for itself and evict every
    // peer on the next insert). The budget is 256 MiB; sparse-file it: write a
    // real 1-byte file then truncate to budget+1 so stat.size reflects a giant
    // without materializing it.
    const giantPath = join(dir, "2026-01-01_giant.jsonl");
    writeFileSync(giantPath, "{\"type\":\"session\",\"version\":3,\"id\":\"giant\",\"cwd\":\"/tmp\",\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n");
    // truncate to just past the budget
    const budget = 256 * 1024 * 1024;
    truncateSync(giantPath, budget + 1);
    getSessionEntries(giantPath);
    assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(giantPath)), false, "giant does not cache");

    // The small file's parse must still be cached (the giant did not evict it).
    assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(smallPath)), true, "peer still cached after giant");
  });
});

test("getSessionEntriesForDisplay resolves blobs on copies without contaminating the shared cache", async () => {
  await withAgentDir(async (dir) => {
    // A blob-bearing assistant image entry: data is a blob:sha256 ref.
    // The blob store lives under the agent dir (<agent>/blobs/<hash>).
    const blobHash = "a".repeat(64);
    // getBlobsDir() = <agentDir>/blobs — withAgentDir sets agentDir; `dir`
    // is <agentDir>/sessions/-project, so ../.. is the agentDir root.
    const blobDir = join(dir, "..", "..", "blobs");
    mkdirSync(blobDir, { recursive: true });
    writeFileSync(join(blobDir, blobHash), "fake-image-bytes");

    const filePath = writeSessionFile(dir, "2026-01-01_blob.jsonl", {
      id: "blob",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [
      userEntry("u1", null, "show me"),
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "assistant",
          provider: "t",
          model: "m",
          content: [{ type: "image", data: `blob:sha256:${blobHash}`, mimeType: "image/png" }],
        },
      },
    ]);

    // Prime the shared cache WITHOUT blob resolution.
    const cached = getSessionEntries(filePath);
    assert.equal(cached[1].message.content[0].data, `blob:sha256:${blobHash}`, "cache holds the unresolved ref");

    // Display read resolves the blob to inline base64...
    const display = getSessionEntriesForDisplay(filePath);
    assert.equal(
      display[1].message.content[0].data,
      Buffer.from("fake-image-bytes").toString("base64"),
      "display path resolves the blob to base64",
    );
    // ...and leaves the shared cache untouched.
    const cachedAfter = getSessionEntries(filePath);
    assert.equal(cachedAfter[1].message.content[0].data, `blob:sha256:${blobHash}`, "cache is NOT mutated by display read");
    assert.notEqual(cachedAfter[1], display[1], "display read must not share the blob entry object");
  });
});

// ============================================================================
// Targeted invalidation + concurrency (watcher hot-path regression coverage)
// ============================================================================

// Invalidation that lands WHILE a list scan is still in flight must never let
// the stale scan result repopulate the cache (generation gate); callers that
// arrive after the invalidation must start a fresh scan instead of reusing
// the stale in-flight promise.
test("invalidation during an in-flight scan does not repopulate the list cache", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-01-01_gen.jsonl", {
      id: "gen",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "gen")]);

    // Concurrent callers within one generation share one in-flight scan:
    // listAllSessions is async, so each call wraps the shared tracked scan
    // promise in its own async wrapper — the shared scan is observable as an
    // identical result array and a single tracked promise on globalThis.
    const p1 = listAllSessions();
    const sharedScan = globalThis.__piSessionListPromise;
    assert.notEqual(sharedScan, undefined, "listAllSessions must track its in-flight scan");
    const p2 = listAllSessions();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, r2, "concurrent callers must share one in-flight scan (identical result array)");

    // Invalidate SYNCHRONOUSLY after starting a scan, before it settles: the
    // stale result must be discarded by the generation gate.
    invalidateSessionListCache();
    await sharedScan;
    assert.equal(
      globalThis.__piSessionListCache,
      undefined,
      "a scan invalidated mid-flight must not repopulate the cache",
    );

    // A caller after the invalidation starts a NEW scan, not the stale one.
    const staleScan = sharedScan;
    await listAllSessions();
    assert.notEqual(
      globalThis.__piSessionListPromise,
      staleScan,
      "post-invalidation caller must not reuse the stale scan promise",
    );
    const fresh = await listAllSessions();
    assert.ok(fresh.some((s) => s.id === "gen"), "fresh scan sees the session");
    assert.ok(globalThis.__piSessionListCache, "a clean scan repopulates the cache");
  });
});

// The per-file scan memo is keyed on (size, mtimeMs), which a title-slot
// rewrite does NOT change: the 256-byte slot is rewritten in place with equal
// byte length and the mtime restored. Only targeted invalidation of the scan
// memo lets the sidebar pick up the new title.
test("same-size + same-mtime title-slot rewrite is caught by targeted scan invalidation", async () => {
  await withAgentDir(async (dir) => {
    const cwd = join(tmpdir(), "omp-web-missing-project");
    const titleSlot = serializeTitleSlot({ title: "title-original", updatedAt: "2026-01-01T00:00:00.000Z" });
    const body =
      JSON.stringify({ type: "session", version: 3, id: "titled", cwd, timestamp: "2026-01-01T00:00:00.000Z" })
      + "\n"
      + JSON.stringify(userEntry("u1", null, "hello"))
      + "\n";
    const filePath = join(dir, "2026-01-01_titled.jsonl");
    writeFileSync(filePath, titleSlot + body);

    const FIXED_MTIME = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);

    const first = await listAllSessions();
    assert.equal(first.find((s) => s.id === "titled")?.name, "title-original");

    // In-place rewrite, same byte length (both titles are 14 ASCII chars),
    // mtime restored: the (size, mtimeMs) scan key cannot detect this.
    const newSlot = serializeTitleSlot({ title: "title-CHANGED", updatedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(Buffer.byteLength(newSlot), Buffer.byteLength(titleSlot), "rewrite must keep the slot byte length");
    const fd = openSync(filePath, "r+");
    writeSync(fd, newSlot, 0, Buffer.byteLength(newSlot), 0);
    closeSync(fd);
    utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);

    // Clear only the list TTL cache: the scan memo now serves the stale
    // title — exactly the staleness window the watcher's targeted flush
    // must close.
    invalidateSessionListMeta();
    const stale = await listAllSessions();
    assert.equal(
      stale.find((s) => s.id === "titled")?.name,
      "title-original",
      "scan memo must serve the old title before targeted invalidation",
    );

    // Watcher-style known-path flush: drop the list metadata AND only this
    // file's parse + scan memos.
    invalidateSessionCaches(filePath);
    const fresh = await listAllSessions();
    assert.equal(fresh.find((s) => s.id === "titled")?.name, "title-CHANGED");
  });
});

// Real fs.watch integration: continuous appends to one session must collapse
// into a debounced flush that resolves the session id, targets ONLY that
// file's parse caches, and leaves unrelated sessions cached.
test("watcher coalesces continuous writes into targeted invalidation, keeping unrelated caches", { timeout: 15000 }, async () => {
  await withAgentDir(async (dir) => {
    const cwd = join(tmpdir(), "omp-web-missing-project");
    const fileA = writeSessionFile(dir, "2026-01-01_wa.jsonl", {
      id: "watch-a",
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "a")]);
    const fileB = writeSessionFile(dir, "2026-01-01_wb.jsonl", {
      id: "watch-b",
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "b")]);

    // Prime both per-file parse caches and resolve watch-a's id so the flush
    // path exercises the cached id resolution.
    getSessionEntries(fileA);
    getSessionEntries(fileB);
    assert.equal(await resolveSessionIdByPath(fileA), "watch-a");

    const notified = [];
    const unsubscribe = subscribeSessionFileChanges((ids) => notified.push(...ids));
    try {
      // Continuous writes: two appends inside the 250ms debounce window must
      // collapse into ONE flush that targets watch-a only.
      appendFileSync(fileA, JSON.stringify(userEntry("u2", "u1", "a2")) + "\n");
      appendFileSync(fileA, JSON.stringify(userEntry("u3", "u2", "a3")) + "\n");

      const deadline = Date.now() + 10_000;
      while (!notified.includes("watch-a")) {
        if (Date.now() > deadline) {
          assert.fail(`watcher never notified for watch-a; got: ${JSON.stringify(notified)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(
        globalThis.__ompSessionEntriesCache?.has(sessionPathKey(fileA)),
        false,
        "written session's parse cache must be dropped",
      );
      assert.equal(
        globalThis.__ompSessionEntriesCache?.has(sessionPathKey(fileB)),
        true,
        "unrelated session's parse cache must survive the targeted flush",
      );
      assert.equal(getSessionEntries(fileA).length, 3, "appended entries are visible after invalidation");
    } finally {
      unsubscribe();
    }
  });
});

// ============================================================================
// High-cost read dedup + oversize cache hygiene (TODO §2)
// ============================================================================

const DISPLAY_LOAD_CEILING = 1024 * 1024 * 1024; // MAX_SESSION_LOAD_BYTES

// A cached small file that grows past the load ceiling can never match its
// (size, mtime) cache key again — the stale entry must be dropped when the
// 413 gate fires, not left to linger until LRU eviction.
test("oversize cache entry is dropped when a cached file outgrows the load ceiling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-oversize-"));
  try {
    const filePath = join(dir, "grown.jsonl");
    writeFileSync(filePath, [
      JSON.stringify({ type: "session", version: 3, id: "grown", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify(userEntry("u1", null, "small")),
    ].join("\n") + "\n");

    // Prime the parse cache.
    assert.equal(getSessionEntries(filePath).length, 1);
    assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(filePath)), true);

    // Grow to past the load ceiling (sparse truncate — no real bytes written).
    truncateSync(filePath, DISPLAY_LOAD_CEILING + 1);

    // Sync display read: 413 semantics preserved AND the stale entry is gone.
    assert.throws(() => getSessionEntriesForDisplay(filePath), SessionFileTooLargeError);
    assert.equal(
      globalThis.__ompSessionEntriesCache?.has(sessionPathKey(filePath)),
      false,
      "stale cache entry must be dropped at the 413 gate",
    );

    // Async display read: same 413 semantics, same cleanup.
    await assert.rejects(
      () => getSessionEntriesForDisplayAsync(filePath),
      SessionFileTooLargeError,
      "async display read must preserve the structured 413",
    );
    assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(filePath)), false);
    assert.equal(
      globalThis.__ompEntriesInFlight?.size ?? 0,
      0,
      "a rejected read must not linger in the in-flight map",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Concurrent same-tick display reads for one file must share ONE parse: both
// callers resolve to the identical entry array (separate parses would produce
// distinct arrays), and the in-flight bookkeeping clears after settling.
test("concurrent display reads share one in-flight parse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-dedup-"));
  try {
    const filePath = join(dir, "shared.jsonl");
    writeFileSync(filePath, [
      JSON.stringify({ type: "session", version: 3, id: "shared", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify(userEntry("u1", null, "hello")),
      JSON.stringify(assistantEntry("a1", "u1", "world")),
    ].join("\n") + "\n");

    // Two calls in the same tick, before any microtask runs.
    const p1 = getSessionEntriesForDisplayAsync(filePath);
    const p2 = getSessionEntriesForDisplayAsync(filePath);

    // The second call must have joined the first one's parse, not started
    // its own (and the map entry is visible while the parse is pending).
    assert.equal(globalThis.__ompEntriesInFlight?.size, 1, "exactly one in-flight parse");

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.length, 2);
    // The transform returns a fresh array per caller, but the entries inside
    // come from the ONE shared parse: separate parses would produce distinct
    // entry objects.
    assert.equal(r1[0], r2[0], "entries must come from the same shared parse");
    assert.equal(r1[1], r2[1], "entries must come from the same shared parse");
    assert.equal(
      globalThis.__ompEntriesInFlight?.size,
      0,
      "in-flight entry must be removed once the parse settles",
    );

    // A settled file is a stat cache hit afterwards: no in-flight entry.
    const again = await getSessionEntriesForDisplayAsync(filePath);
    assert.equal(again.length, 2);
    assert.equal(globalThis.__ompEntriesInFlight?.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Distinct files must not collide in the dedup map, and a rejection (here:
// the 413 gate) must not poison a later read after the file shrank back.
test("dedup is per-file and rejections are not memoized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-dedup2-"));
  try {
    const fileA = join(dir, "a.jsonl");
    const fileB = join(dir, "b.jsonl");
    for (const [filePath, id] of [[fileA, "a"], [fileB, "b"]]) {
      writeFileSync(filePath, [
        JSON.stringify({ type: "session", version: 3, id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify(userEntry("u1", null, id)),
      ].join("\n") + "\n");
    }

    const [ra, rb] = await Promise.all([
      getSessionEntriesForDisplayAsync(fileA),
      getSessionEntriesForDisplayAsync(fileB),
    ]);
    assert.equal(ra.length, 1);
    assert.equal(rb.length, 1);
    assert.equal(ra[0].message.content, "a");
    assert.equal(rb[0].message.content, "b");
    assert.equal(globalThis.__ompEntriesInFlight?.size, 0);

    // Oversize B past the ceiling, then shrink it back: the first (oversize)
    // read rejects, the second (shrunk) read succeeds — no memoized failure.
    truncateSync(fileB, DISPLAY_LOAD_CEILING + 1);
    await assert.rejects(() => getSessionEntriesForDisplayAsync(fileB), SessionFileTooLargeError);
    truncateSync(fileB, 0);
    writeFileSync(fileB, [
      JSON.stringify({ type: "session", version: 3, id: "b", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify(userEntry("u1", null, "shrunk-back")),
    ].join("\n") + "\n");
    const recovered = await getSessionEntriesForDisplayAsync(fileB);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].message.content, "shrunk-back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
