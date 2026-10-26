import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createJiti } from "jiti";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const jiti = createJiti(import.meta.url);
const { sessionPathKey } = await jiti.import("./paths.ts");
const { forEachFileLineSync, serializeTitleSlot } = await jiti.import("./omp/session-files.ts");
const { SessionFileTooLargeError } = await jiti.import("./session-reader.ts");
const { subscribeSessionFileChanges } = await jiti.import("./session-watcher.ts");
const {
  buildSessionContext,
  cacheSessionPath,
  getSessionEntries,
  getSessionEntriesForDisplay,
  getTodoPhasesFromEntries,
  getSessionHistoryPage,
  getSessionContextBoundary,
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

test("reads the latest todo snapshot on one chain, not the oldest", () => {
  const entries = [
    {
      type: "message",
      id: "todo-early",
      parentId: null,
      message: {
        role: "toolResult",
        toolName: "todo",
        details: { phases: [{ name: "Early", tasks: [{ content: "step", status: "pending" }] }] },
      },
    },
    {
      type: "message",
      id: "todo-late",
      parentId: "todo-early",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: { phases: [{ name: "Late", tasks: [{ content: "step", status: "completed" }] }] },
      },
    },
  ];

  assert.deepEqual(getTodoPhasesFromEntries(entries, "todo-late"), [
    { name: "Late", tasks: [{ content: "step", status: "completed" }] },
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

test("deferred history sends tool-result images as media URLs and keeps user images inline", () => withAgentDir(() => {
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
  const flatToolImage = { type: "image", data: "QUJDRA==", mimeType: "image/png" };
  const blobHash = "a".repeat(64);
  const blobToolImage = { type: "image", data: `blob:sha256:${blobHash}`, mimeType: "image/webp" };
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "blobs"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "blobs", blobHash), "webp bytes");
  const missingHash = "b".repeat(64);
  const missingToolImage = { type: "image", data: `blob:sha256:${missingHash}`, mimeType: "image/webp" };
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
        content: [{ type: "text", text: "Read image file" }, toolImage, flatToolImage, blobToolImage, missingToolImage, toolUrlImage],
      },
    },
  ];
  // omp's blob address: sha256 of the decoded bytes ("ABCD").
  const abcd = createHash("sha256").update("ABCD").digest("hex");

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content, [
    { type: "text", text: "Read image file" },
    { type: "image", mimeType: "image/jpeg", url: `/api/media/${abcd}` },
    { type: "image", mimeType: "image/png", url: `/api/media/${abcd}` },
    { type: "image", mimeType: "image/webp", url: `/api/media/${blobHash}` },
    // Same placeholder as the non-deferred path, instead of a URL that 404s.
    { type: "text", text: `[image unavailable: blob ${missingHash.slice(0, 12)}… not found]` },
    toolUrlImage,
  ]);
  // Inline bytes omp never externalized are kept for the media route.
  assert.equal(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "media", abcd), "utf8"), "ABCD");

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content.slice(1, 3), [toolImage, flatToolImage]);
}));

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

// "Last updated" workspace sorting needs the last message time, which a later
// non-message write (a rename, an auto-name) must not move.
test("lists each session's last message time from the tail, not the file mtime", async () => {
  await withAgentDir(async (dir) => {
    const cwd = join(tmpdir(), "omp-web-missing-project");
    writeSessionFile(dir, "2026-01-01_a.jsonl", { id: "with-messages", cwd, timestamp: "2026-01-01T00:00:00.000Z" }, [
      { ...userEntry("u1", null, "first"), timestamp: "2026-01-01T00:00:01.000Z" },
      { ...userEntry("u2", "u1", "second"), timestamp: "2026-01-02T00:00:00.000Z" },
      { type: "title_change", id: "t1", parentId: "u2", title: "Renamed", timestamp: "2026-03-01T00:00:00.000Z" },
    ]);
    writeSessionFile(dir, "2026-01-02_b.jsonl", { id: "no-messages", cwd, timestamp: "2026-01-02T00:00:00.000Z" });
    const byId = new Map((await listAllSessions()).map((s) => [s.id, s]));
    assert.equal(byId.get("with-messages")?.lastMessageAt, "2026-01-02T00:00:00.000Z");
    assert.equal(byId.get("no-messages")?.lastMessageAt, undefined);
  });
});

// Rules/skills/memory injections land before the first user message and can
// exceed the 4 KiB list-scan prefix; the sidebar and auto-name need that text.
test("lists the first user message even when injected context precedes it beyond the scan prefix", async () => {
  await withAgentDir(async (dir) => {
    const injected = { type: "custom_message", customType: "rules", content: "r".repeat(20_000), display: false };
    writeSessionFile(dir, "2026-01-01_injected.jsonl", {
      id: "injected",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [injected, userEntry("u1", null, "Integrate and deploy"), assistantEntry("a1", "u1", "ok")]);
    // A torn line mentioning "user" must be skipped, not end the scan.
    const tornPath = writeSessionFile(dir, "2026-01-02_torn.jsonl", {
      id: "torn",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-02T00:00:00.000Z",
    }, [injected]);
    appendFileSync(tornPath, `{"type":"message","message":{"role":"user" torn\n${JSON.stringify(userEntry("u1", null, "after torn"))}\n`);
    writeSessionFile(dir, "2026-01-03_huge.jsonl", {
      id: "huge",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-03T00:00:00.000Z",
    }, [injected, userEntry("u1", null, "x".repeat(300_000))]);
    // No fixed read window: the scan reaches a user entry behind 300 KB of context.
    writeSessionFile(dir, "2026-01-04_deep.jsonl", {
      id: "deep",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-04T00:00:00.000Z",
    }, [...Array(15).fill(injected), userEntry("u1", null, "deep prompt")]);

    const byId = new Map((await listAllSessions()).map((s) => [s.id, s]));
    assert.equal(byId.get("injected")?.firstMessage, "Integrate and deploy");
    assert.equal(byId.get("torn")?.firstMessage, "after torn");
    // The list ships firstMessage for every session, so it stays bounded.
    assert.equal(byId.get("huge")?.firstMessage, "x".repeat(4096));
    assert.equal(byId.get("deep")?.firstMessage, "deep prompt");
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

test("hub send/jobs toolResults keep bounded roster details; other hub ops stay stripped", () => {
  const entries = [
    {
      type: "message",
      id: "h1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "hc1",
        toolName: "hub",
        content: [],
        details: {
          op: "send",
          to: "VisualFix",
          receipts: [{ to: "VisualFix", outcome: "injected", extra: "x".repeat(5000) }],
          noise: "dropped",
        },
      },
    },
    {
      type: "message",
      id: "h2",
      parentId: "h1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "hc2",
        toolName: "hub",
        content: [],
        details: {
          op: "jobs",
          jobs: [{ id: "VisualFix", type: "task", status: "running", label: "VisualFix", durationMs: 1890000, secret: "dropped" }],
        },
      },
    },
    {
      type: "message",
      id: "h3",
      parentId: "h2",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "hc3",
        toolName: "hub",
        content: [],
        details: { op: "list", peers: [], counts: { running: 0 } },
      },
    },
  ];
  const context = buildSessionContext(entries);
  const send = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "hc1");
  const jobs = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "hc2");
  const list = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "hc3");
  assert.ok(send);
  assert.deepEqual(send.details, { op: "send", to: ["VisualFix"], receipts: [{ to: "VisualFix", outcome: "injected" }] });
  assert.ok(jobs);
  assert.deepEqual(jobs.details, { op: "jobs", jobs: [{ id: "VisualFix", type: "task", status: "running", label: "VisualFix", durationMs: 1890000 }] });
  // list carries no chat rendering — nothing allowlisted, details dropped
  assert.ok(list);
  assert.equal("details" in list, false);
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

// Unrelated caches are guaranteed to survive only a known-filename flush.
// Native fs.watch may report fixture creation too, or omit the filename and
// correctly trigger a full flush. Feed the documented known-path contract
// explicitly, while the separate integration case retains real native events.
test("watcher coalesces known-path writes into targeted invalidation, keeping unrelated caches", { timeout: 15000 }, async (t) => {
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

    const watcher = new EventEmitter();
    watcher.close = t.mock.fn();
    let onChange;
    const sessionsDir = join(process.env.PI_CODING_AGENT_DIR, "sessions");
    const watchMock = t.mock.method(fs, "watch", (watchedDir, options, callback) => {
      assert.equal(watchedDir, sessionsDir);
      assert.deepEqual(options, { recursive: true, persistent: false });
      onChange = callback;
      return watcher;
    });
    syncBuiltinESMExports();
    t.after(() => { watchMock.mock.restore(); syncBuiltinESMExports(); });
    const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { subscribeSessionFileChanges: subscribeKnownChanges } = await isolated.import("./session-watcher.ts");
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const notified = [];
    let resolveNotification;
    const notification = new Promise((resolve) => { resolveNotification = resolve; });
    const unsubscribe = subscribeKnownChanges((ids) => {
      notified.push(ids);
      resolveNotification();
    });
    try {
      // Both appends are real; only native scheduling and filenames are
      // controlled. No cache may drop before the debounce window expires.
      appendFileSync(fileA, JSON.stringify(userEntry("u2", "u1", "a2")) + "\n");
      onChange("change", relative(sessionsDir, fileA));
      appendFileSync(fileA, JSON.stringify(userEntry("u3", "u2", "a3")) + "\n");
      onChange("change", relative(sessionsDir, fileA));

      t.mock.timers.tick(249);
      assert.deepEqual(notified, []);
      assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(fileA)), true);
      assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(fileB)), true);
      t.mock.timers.tick(1);
      await notification;
      assert.deepEqual(notified, [["watch-a"]], "both known-path events coalesce into one targeted notification");

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
    assert.equal(watcher.close.mock.callCount(), 1, "the last subscriber closes its watcher");
  });
});

// Real native delivery is asynchronous; first observe a fixture-write flush
// before priming the cache for the content-change assertions. This does not
// assume that native events carry only one path or always include filenames.
test("native watcher refreshes a session after content appends", { timeout: 15000 }, async (t) => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_native.jsonl", {
      id: "watch-native",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "a")]);
    assert.equal(await resolveSessionIdByPath(filePath), "watch-native");
    const fixture = readFileSync(filePath);
    const notifications = new EventEmitter();
    let nativeReady = false;
    const unsubscribe = subscribeSessionFileChanges((ids) => {
      if (ids.includes("watch-native")) nativeReady = true;
      notifications.emit("change", ids);
    });
    try {
      while (!nativeReady) {
        writeFileSync(filePath, fixture);
        await setImmediate(undefined, { signal: t.signal });
      }
      getSessionEntries(filePath);
      assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(filePath)), true);
      const changed = (async () => {
        for (;;) {
          const [ids] = await once(notifications, "change", { signal: t.signal });
          if (ids.includes("watch-native")) return;
        }
      })();
      appendFileSync(filePath, JSON.stringify(userEntry("u2", "u1", "a2")) + "\n");
      appendFileSync(filePath, JSON.stringify(userEntry("u3", "u2", "a3")) + "\n");
      await changed;
      assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(filePath)), false, "written session's parse cache must be dropped");
      assert.equal(getSessionEntries(filePath).length, 3, "appended entries are visible after native invalidation");
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

test("history catch-up pages persisted IDs contiguously without resolving old blobs", async (t) => {
  await withAgentDir(async (dir) => {
    const hash = "b".repeat(64);
    const blobDir = join(dir, "..", "..", "blobs");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, hash);
    writeFileSync(blobPath, "old image");
    const filePath = writeSessionFile(dir, "2026-01-01_catch-up.jsonl", {
      id: "catch-up", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z",
    }, [
      { ...userEntry("image", null, ""), message: { role: "user", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] } },
      userEntry("repeat-1", "image", "same"),
      userEntry("repeat-2", "repeat-1", "same"),
      assistantEntry("answer", "repeat-2", "answer"),
    ]);
    const blobReads = [];
    const originalRead = fs.readFileSync;
    const readMock = t.mock.method(fs, "readFileSync", (path, ...args) => {
      if (String(path) === blobPath) blobReads.push(String(path));
      return originalRead(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { readMock.mock.restore(); syncBuiltinESMExports(); });
    const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { getSessionHistoryPage: readPage } = await isolated.import("./session-reader.ts");
    const first = readPage(filePath, null, 1);
    assert.deepEqual(blobReads, [blobPath], "positive control: the observer sees a real image-page blob read");
    blobReads.length = 0;
    assert.equal(first.history.mode, "replace");
    assert.equal(first.history.hasMore, true);
    assert.deepEqual(first.history.context.entryIds, ["image"]);
    assert.equal(first.history.context.messages[0].content[0].data, Buffer.from("old image").toString("base64"));
    assert.equal(getSessionEntries(filePath)[0].message.content[0].data, `blob:sha256:${hash}`);
    const second = readPage(filePath, first.history.cursor, 2);
    assert.equal(second.history.mode, "append");
    assert.equal(second.history.baseEntryId, "image");
    assert.deepEqual(second.history.context.entryIds, ["repeat-1", "repeat-2"]);
    assert.deepEqual(second.history.context.messages.map((message) => message.content), ["same", "same"]);
    assert.equal(second.history.hasMore, true);
    const third = readPage(filePath, second.history.cursor, 2);
    assert.deepEqual(third.history.context.entryIds, ["answer"]);
    assert.equal(third.history.hasMore, false);
    assert.equal(third.history.context.model.modelId, "test-model", "page metadata describes the whole selected context");
    const quiet = readPage(filePath, third.history.cursor, 2);
    assert.equal(quiet.history.mode, "append");
    assert.deepEqual(quiet.history.context.entryIds, []);
    assert.deepEqual(quiet.history.cursor, third.history.cursor);
    assert.deepEqual(blobReads, [], "delivered image prefixes must not perform blob I/O on later pages");
  });
});

test("persisted history catch-up resets after unknown cursors, branch changes and compaction", async () => {
  await withAgentDir(async (dir) => {
    const entries = [
      userEntry("root", null, "root"),
      assistantEntry("left", "root", "left"),
      assistantEntry("right", "root", "right"),
    ];
    const filePath = writeSessionFile(dir, "2026-01-01_reset.jsonl", {
      id: "catch-up-reset", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z",
    }, entries);
    const left = getSessionHistoryPage(filePath, null, 200, "left");
    const right = getSessionHistoryPage(filePath, left.history.cursor, 200, "right");
    assert.equal(right.history.mode, "replace");
    assert.deepEqual(right.history.context.entryIds, ["root", "right"]);
    assert.equal(right.leafId, "right");
    const unknown = getSessionHistoryPage(filePath, { firstEntryId: "root", lastEntryId: "missing" }, 200);
    assert.equal(unknown.history.mode, "replace");
    assert.equal(unknown.history.baseEntryId, null);
    appendFileSync(filePath, JSON.stringify({
      type: "compaction", id: "summary", parentId: "right", timestamp: "2026-01-01T00:00:04.000Z",
      summary: "condensed", firstKeptEntryId: "right", tokensBefore: 100,
    }) + "\n");
    const compacted = getSessionHistoryPage(filePath, right.history.cursor, 200);
    assert.equal(compacted.history.mode, "replace");
    assert.deepEqual(compacted.history.context.entryIds, ["summary", "right"]);
    assert.equal(compacted.history.context.messages[0].content, "condensed");
    const transcript = getSessionHistoryPage(filePath, compacted.history.cursor, 200, undefined, { includePreCompaction: true });
    assert.equal(transcript.history.mode, "replace");
    assert.deepEqual(transcript.history.context.entryIds, ["root", "right", "summary"]);
  });
});

test("history pages seek only new bodies even above the raw-cache budget", async (t) => {
  await withAgentDir(async (dir) => {
    const entries = [
      assistantEntry("page-one", null, "前文 ".repeat(1000)),
      assistantEntry("page-two", "page-one", "second"),
      assistantEntry("page-three", "page-two", "third"),
    ];
    const filePath = writeSessionFile(dir, "indexed.jsonl", {
      id: "indexed", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z",
    }, entries);
    const fds = new Set();
    const reads = [];
    const touchedBodies = new Set();
    const entryIds = new Set(entries.map((entry) => entry.id));
    const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, stat: fs.statSync, fstat: fs.fstatSync, parse: JSON.parse };
    // Report a >256 MiB file, but perform every observed read on the small
    // physical fixture. Both stat paths describe the same artificial version.
    const reported = (stat) => Object.assign(stat, { size: 256 * 1024 * 1024 + 1 });
    const mocks = [
      t.mock.method(fs, "openSync", (path, ...args) => {
        const fd = original.open(path, ...args);
        if (String(path) === filePath) fds.add(fd);
        return fd;
      }),
      t.mock.method(fs, "closeSync", (fd) => { fds.delete(fd); return original.close(fd); }),
      t.mock.method(fs, "statSync", (path, ...args) => {
        const stat = original.stat(path, ...args);
        return String(path) === filePath ? reported(stat) : stat;
      }),
      t.mock.method(fs, "fstatSync", (fd, ...args) => {
        const stat = original.fstat(fd, ...args);
        return fds.has(fd) ? reported(stat) : stat;
      }),
      t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
        const count = original.read(fd, buffer, offset, length, position);
        if (fds.has(fd) && count > 0) reads.push({ position, count, text: buffer.subarray(offset, offset + count).toString("utf8") });
        return count;
      }),
      t.mock.method(JSON, "parse", (text, ...args) => {
        const value = original.parse(text, ...args);
        if (value?.type === "message" && entryIds.has(value.id)) {
          const content = value.message.content;
          Object.defineProperty(value.message, "content", {
            enumerable: true, configurable: true,
            get() { touchedBodies.add(value.id); return content; },
          });
        }
        return value;
      }),
    ];
    syncBuiltinESMExports();
    t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
    const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { getSessionHistoryPage: readPage } = await isolated.import("./session-reader.ts");
    const first = readPage(filePath, null, 1);
    assert.ok(reads.some((read) => read.position === null && read.text.includes('"page-three"')), "positive control: index construction scanned the real fixture");
    assert.deepEqual([...touchedBodies], ["page-one"], "indexing does not transform off-page bodies");
    assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(filePath)) ?? false, false, "oversized raw bodies are never cached");
    let cursor = first.history.cursor;
    const messages = [...first.history.context.messages];
    for (const id of ["page-two", "page-three"]) {
      reads.length = 0;
      touchedBodies.clear();
      const page = readPage(filePath, cursor, 1);
      assert.equal(page.history.mode, "append");
      assert.deepEqual(page.history.context.entryIds, [id]);
      assert.deepEqual([...touchedBodies], [id], "delivered bodies must not be converted again");
      assert.ok(reads.length > 0, "positive control: each uncached page body was read from disk");
      assert.ok(reads.every((read) => Number.isInteger(read.position) && read.position > 0), "later pages seek, never scan from the start");
      const readEntries = reads.map((read) => original.parse(read.text));
      assert.deepEqual(readEntries.map((entry) => entry.id), [id], "only requested JSONL bodies are read");
      messages.push(...page.history.context.messages);
      cursor = page.history.cursor;
    }
    assert.deepEqual(messages, buildSessionContext(entries).messages);
    reads.length = 0;
    touchedBodies.clear();
    const quiet = readPage(filePath, cursor, 1);
    assert.deepEqual(quiet.history.context.messages, []);
    assert.deepEqual(reads, [], "an unchanged completed cursor needs no body I/O");
    assert.deepEqual([...touchedBodies], []);
  });
});

test("active-context boundaries reuse the history index without reading or hydrating bodies", async (t) => {
  await withAgentDir(async (dir) => {
    const hash = "c".repeat(64);
    const blobDir = join(dir, "..", "..", "blobs");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, hash);
    writeFileSync(blobPath, "boundary image");
    const entries = [
      userEntry("omitted", null, "old context"),
      { ...userEntry("image", "omitted", ""), message: { role: "user", content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }] } },
      { type: "compaction", id: "summary", parentId: "image", summary: "condensed", firstKeptEntryId: "image", tokensBefore: 50 },
      assistantEntry("inactive", "summary", "other branch"),
      assistantEntry("active", "summary", "current branch"),
    ];
    const filePath = writeSessionFile(dir, "boundary.jsonl", { id: "boundary", cwd: dir }, entries);
    const expected = buildSessionContext(getSessionEntriesForDisplay(filePath)).entryIds;
    assert.deepEqual(expected, ["summary", "image", "active"]);
    invalidateSessionCaches(filePath);
    const fds = new Set();
    const reads = [];
    const blobReads = [];
    const touchedBodies = new Set();
    const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, readFile: fs.readFileSync, parse: JSON.parse };
    const mocks = [
      t.mock.method(fs, "openSync", (path, ...args) => {
        const fd = original.open(path, ...args);
        if (String(path) === filePath) fds.add(fd);
        return fd;
      }),
      t.mock.method(fs, "closeSync", (fd) => { fds.delete(fd); return original.close(fd); }),
      t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
        const count = original.read(fd, buffer, offset, length, position);
        if (fds.has(fd) && count > 0) reads.push({ position, count });
        return count;
      }),
      t.mock.method(fs, "readFileSync", (path, ...args) => {
        if (String(path) === blobPath) blobReads.push(String(path));
        return original.readFile(path, ...args);
      }),
      t.mock.method(JSON, "parse", (text, ...args) => {
        const value = original.parse(text, ...args);
        if (value?.type === "message" && entries.some((entry) => entry.id === value.id)) {
          const content = value.message.content;
          Object.defineProperty(value.message, "content", {
            enumerable: true, configurable: true,
            get() { touchedBodies.add(value.id); return content; },
          });
        }
        return value;
      }),
    ];
    syncBuiltinESMExports();
    t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
    const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { getSessionContextBoundary: readBoundary, getSessionHistoryPage: readPage } = await isolated.import("./session-reader.ts");
    assert.deepEqual(readBoundary(filePath), { entryIds: expected });
    assert.ok(reads.some((read) => read.position === null), "positive control: a cold boundary scans the real file");
    assert.deepEqual([...touchedBodies], [], "index projection does not hydrate message content");
    assert.deepEqual(blobReads, [], "even a cold boundary does not resolve blobs");
    assert.equal(globalThis.__ompSessionEntriesCache?.has(sessionPathKey(filePath)) ?? false, false);
    reads.length = 0;
    const page = readPage(filePath, null, 200);
    assert.deepEqual(page.history.context.entryIds, expected);
    assert.equal(page.history.context.messages[1].content[0].data, Buffer.from("boundary image").toString("base64"));
    assert.deepEqual(blobReads, [blobPath], "positive control: the page really reads its image blob");
    assert.deepEqual([...touchedBodies], ["image", "active"], "positive control: the page really converts its bodies");
    assert.ok(reads.length > 0 && reads.every((read) => read.position > 0), "the page reuses the boundary index and seeks bodies");
    reads.length = 0;
    blobReads.length = 0;
    touchedBodies.clear();
    assert.deepEqual(readBoundary(filePath), { entryIds: expected });
    assert.deepEqual(reads, [], "an unchanged boundary performs no transcript-body I/O");
    assert.deepEqual(blobReads, []);
    assert.deepEqual([...touchedBodies], []);
  });
});

test("active-context boundaries refresh after append and prefix rewrites, including file growth", async () => {
  await withAgentDir(async (dir) => {
    const header = { id: "boundary-changes", cwd: dir };
    const entries = [userEntry("root", null, "first"), userEntry("child", "root", "second")];
    const filePath = writeSessionFile(dir, "boundary-changes.jsonl", header, entries);
    assert.deepEqual(getSessionContextBoundary(filePath).entryIds, ["root", "child"]);
    entries.push(userEntry("appended", "child", "third"));
    appendFileSync(filePath, JSON.stringify(entries.at(-1)) + "\n");
    assert.deepEqual(getSessionContextBoundary(filePath).entryIds, ["root", "child", "appended"]);
    const before = statSync(filePath);
    entries[1] = userEntry("other", null, "rewritten branch with a longer body");
    entries[2].parentId = "other";
    writeSessionFile(dir, "boundary-changes.jsonl", header, entries);
    assert.ok(statSync(filePath).size > before.size, "the prefix rewrite grows the file; growth is not append-only evidence");
    assert.deepEqual(getSessionContextBoundary(filePath).entryIds, ["other", "appended"]);
    const rewritten = statSync(filePath);
    entries[1].id = "fresh";
    entries[2].parentId = "fresh";
    writeSessionFile(dir, "boundary-changes.jsonl", header, entries);
    utimesSync(filePath, rewritten.atime, rewritten.mtime);
    assert.equal(statSync(filePath).size, rewritten.size);
    assert.deepEqual(getSessionContextBoundary(filePath).entryIds, ["fresh", "appended"]);
    assert.deepEqual(getSessionHistoryPage(filePath, null, 200).history.context, buildSessionContext(entries));
  });
});

test("indexed pages trim the same Unicode line whitespace as the lenient full reader", async () => {
  await withAgentDir(async (dir) => {
    const entries = [userEntry("one", null, "first"), assistantEntry("two", "one", "second")];
    const filePath = join(dir, "trimmed.jsonl");
    writeFileSync(filePath, [
      JSON.stringify({ type: "session", version: 3, id: "trimmed", cwd: dir }),
      "\ufeff" + JSON.stringify(entries[0]) + "\u00a0",
      "{torn write",
      "\u2003" + JSON.stringify(entries[1]) + "\ufeff",
    ].join("\r\n"));
    const expected = buildSessionContext(getSessionEntriesForDisplay(filePath));
    assert.deepEqual(expected.entryIds, ["one", "two"]);
    assert.deepEqual(getSessionContextBoundary(filePath), { entryIds: expected.entryIds });
    assert.deepEqual(getSessionHistoryPage(filePath, null, 200).history.context, expected);
  });
});

test("indexed pages concatenate to full Unicode/CRLF compaction and branch context", async () => {
  await withAgentDir(async (dir) => {
    const phases = [{ name: "最新", tasks: [{ content: "finish", status: "completed" }] }];
    const entries = [
      userEntry("root", null, "漢字 ".repeat(300_000)),
      { type: "compaction", id: "old-summary", parentId: "root", timestamp: "2026-01-01T00:00:00.000Z", summary: "旧 summary", firstKeptEntryId: "root", tokensBefore: 500 },
      { type: "thinking_level_change", id: "thinking", parentId: "old-summary", thinkingLevel: "high" },
      { type: "model_change", id: "model", parentId: "thinking", model: "provider/model/with/slashes", role: "default" },
      { type: "custom", customType: "user_todo_edit", id: "todo", parentId: "model", data: { phases } },
      { type: "branch_summary", id: "branch-summary", parentId: "todo", timestamp: "2026-01-01T00:00:00.000Z", summary: "旁支" },
      { type: "message", id: "invalid-message", parentId: "branch-summary" },
      { type: "compaction", id: "new-summary", parentId: "invalid-message", timestamp: "2026-01-01T00:00:01.000Z", summary: "最新 summary", firstKeptEntryId: "old-summary", tokensBefore: 1000, tokensAfter: 50, method: "manual" },
      assistantEntry("left", "new-summary", "左"),
      assistantEntry("right", "new-summary", "右"),
    ];
    const filePath = join(dir, "unicode.jsonl");
    const records = [
      { type: "session", version: 3, id: "unicode", cwd: dir },
      ...entries,
    ];
    // The first body spans scanner chunks; CRLF and an unterminated last line
    // make byte offsets differ from both JS character and LF-only offsets.
    writeFileSync(filePath, serializeTitleSlot({ title: "題名", updatedAt: "2026-01-01T00:00:00.000Z" })
      + records.map((entry) => JSON.stringify(entry)).join("\r\n"));
    for (const leafId of ["left", "right", "missing"]) {
      for (const includePreCompaction of [false, true]) {
        const options = { includePreCompaction, deferThinking: true, deferToolResultImages: true };
        const expected = buildSessionContext(getSessionEntriesForDisplay(filePath), leafId, options);
        const actual = { ...expected, messages: [], entryIds: [] };
        let cursor = null;
        for (;;) {
          const { history, tipId, leafId: selectedLeaf } = getSessionHistoryPage(filePath, cursor, 2, leafId, options);
          assert.equal(tipId, "right");
          assert.equal(selectedLeaf, leafId === "missing" ? "right" : leafId);
          assert.deepEqual(history.context.todoPhases, leafId === "missing" ? [] : phases);
          assert.deepEqual(history.context.model, expected.model);
          assert.equal(history.context.thinkingLevel, "high");
          actual.messages.push(...history.context.messages);
          actual.entryIds.push(...history.context.entryIds);
          if (!history.hasMore) break;
          cursor = history.cursor;
        }
        assert.deepEqual(actual, expected);
      }
    }
  });
});

test("indexed legacy pages preserve migrations and compaction links without reassigning IDs", async () => {
  await withAgentDir(async (dir) => {
    for (const version of [1, 2]) {
      const entries = [
        userEntry("root", null, "旧 request"),
        { ...userEntry("hook", "root", "legacy hook"), message: { role: "hookMessage", customType: "hook", content: "legacy hook", display: false } },
        { type: "compaction", id: "summary", parentId: "hook", timestamp: "2026-01-01T00:00:00.000Z", summary: "short", firstKeptEntryId: "hook", firstKeptEntryIndex: 2, tokensBefore: 50 },
        assistantEntry("answer", "summary", "response"),
      ];
      if (version === 1) for (const entry of entries) { delete entry.id; delete entry.parentId; }
      const filePath = join(dir, `v${version}.jsonl`);
      writeFileSync(filePath, [
        { type: "session", version, id: `legacy-${version}`, cwd: dir },
        ...entries,
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      const expected = buildSessionContext(getSessionEntriesForDisplay(filePath));
      const pages = [];
      let cursor = null;
      for (;;) {
        const { history } = getSessionHistoryPage(filePath, cursor, 1);
        assert.equal(history.mode, cursor ? "append" : "replace");
        pages.push(history);
        if (!history.hasMore) break;
        cursor = history.cursor;
      }
      const messages = pages.flatMap((page) => page.context.messages);
      const ids = pages.flatMap((page) => page.context.entryIds);
      // v1 has no persisted IDs: native-compatible migration assigns fresh
      // IDs on a cold load, but those IDs and firstKept links survive paging.
      assert.equal(messages[0].details.firstKeptEntryId, ids[1]);
      if (version === 1) expected.messages[0].details.firstKeptEntryId = ids[1];
      else assert.deepEqual(ids, expected.entryIds);
      assert.deepEqual(messages, expected.messages);
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual(getSessionHistoryPage(filePath, pages.at(-1).cursor, 1).history.context.messages, []);
      assert.deepEqual(getSessionContextBoundary(filePath).entryIds, ids, "boundary and pages share migrated IDs");
    }
  });
});

test("history offsets invalidate for append, same-size rewrite, replacement, truncation and explicit invalidation", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "changing.jsonl", { id: "changing", cwd: dir }, [
      userEntry("one", null, "original"),
      userEntry("two", "one", "version-one"),
    ]);
    const initial = getSessionHistoryPage(filePath, null, 1);
    const before = statSync(filePath);
    const header = JSON.stringify({ type: "session", version: 3, id: "changing", cwd: dir });
    const body = (text) => [header, JSON.stringify(userEntry("one", null, "original")), JSON.stringify(userEntry("two", "one", text))].join("\n") + "\n";
    // A write with the original mtime still changes ctime.
    writeFileSync(filePath, body("version-two"));
    utimesSync(filePath, before.atime, before.mtime);
    assert.equal(getSessionHistoryPage(filePath, initial.history.cursor, 1).history.context.messages[0].content, "version-two");
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, body("version-new"));
    utimesSync(replacement, before.atime, before.mtime);
    renameSync(replacement, filePath);
    assert.equal(getSessionHistoryPage(filePath, initial.history.cursor, 1).history.context.messages[0].content, "version-new");
    appendFileSync(filePath, JSON.stringify(userEntry("three", "two", "appended")) + "\n");
    const appended = getSessionHistoryPage(filePath, { firstEntryId: "one", lastEntryId: "two" }, 1);
    assert.deepEqual(appended.history.context.entryIds, ["three"]);
    writeFileSync(filePath, header + "\n" + JSON.stringify(userEntry("one", null, "original")) + "\n");
    const truncated = getSessionHistoryPage(filePath, appended.history.cursor, 1);
    assert.equal(truncated.history.mode, "replace");
    assert.deepEqual(truncated.history.context.entryIds, ["one"]);
    invalidateSessionCaches(filePath);
    assert.deepEqual(getSessionHistoryPage(filePath, null, 1).history.context.messages, truncated.history.context.messages);
    truncateSync(filePath, DISPLAY_LOAD_CEILING + 1);
    assert.throws(() => getSessionHistoryPage(filePath, null, 1), SessionFileTooLargeError);
    writeFileSync(filePath, body("after-shrink"));
    assert.equal(getSessionHistoryPage(filePath, initial.history.cursor, 1).history.context.messages[0].content, "after-shrink");
  });
});

test("an over-budget metadata index is not retained and does not evict cached peers", async (t) => {
  await withAgentDir(async (dir) => {
    const peer = writeSessionFile(dir, "peer.jsonl", { id: "peer", cwd: dir }, [
      userEntry("peer-one", null, "first"), userEntry("peer-two", "peer-one", "second"),
    ]);
    const filePath = writeSessionFile(dir, "large-metadata.jsonl", { id: "large-metadata", cwd: dir }, [
      { type: "custom", customType: "user_todo_edit", id: "todo", parentId: null, data: {
        phases: [{ name: "large", tasks: [{ content: "x".repeat(17 * 1024 * 1024), status: "pending" }] }],
      } },
      userEntry("one", "todo", "first"), userEntry("two", "one", "second"),
    ]);
    let scannedBytes = 0;
    const originalRead = fs.readSync;
    const readMock = t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
      const count = originalRead(fd, buffer, offset, length, position);
      if (position === null) scannedBytes += count;
      return count;
    });
    syncBuiltinESMExports();
    t.after(() => { readMock.mock.restore(); syncBuiltinESMExports(); });
    const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { getSessionHistoryPage: readPage } = await isolated.import("./session-reader.ts");
    const peerFirst = readPage(peer, null, 1);
    scannedBytes = 0;
    const first = readPage(filePath, null, 1);
    assert.ok(scannedBytes >= statSync(filePath).size, "positive control: the real metadata-heavy fixture was scanned");
    scannedBytes = 0;
    const second = readPage(filePath, first.history.cursor, 1);
    assert.deepEqual(second.history.context.entryIds, ["two"], "the memory bound never truncates history");
    assert.equal(second.history.context.todoPhases[0].tasks[0].content.length, 17 * 1024 * 1024, "metadata is returned in full, not clipped to fit the cache");
    assert.ok(scannedBytes >= statSync(filePath).size, "UTF-16 metadata larger than the entire 32 MiB index budget is not retained");
    scannedBytes = 0;
    assert.deepEqual(readPage(peer, peerFirst.history.cursor, 1).history.context.entryIds, ["peer-two"]);
    assert.equal(scannedBytes, 0, "an uncacheable file must not evict an unrelated reusable index");
  });
});

test("history never advances a cursor through offsets invalidated during a real page read", async (t) => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "race.jsonl", { id: "race", cwd: dir }, [
      userEntry("one", null, "first"), userEntry("two", "one", "second"),
    ]);
    const first = getSessionHistoryPage(filePath, null, 1);
    const originalRead = fs.readSync;
    let changed = false;
    const readMock = t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
      const count = originalRead(fd, buffer, offset, length, position);
      if (!changed && position !== null && buffer.subarray(offset, offset + count).toString("utf8").includes('"id":"two"')) {
        changed = true;
        appendFileSync(filePath, JSON.stringify(userEntry("three", "two", "newer")) + "\n");
      }
      return count;
    });
    syncBuiltinESMExports();
    t.after(() => { readMock.mock.restore(); syncBuiltinESMExports(); });
    const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { getSessionHistoryPage: readPage } = await isolated.import("./session-reader.ts");
    assert.throws(() => readPage(filePath, first.history.cursor, 1), /Session changed/);
    assert.equal(changed, true, "positive control: mutation happened inside the actual page read");
    const recovered = readPage(filePath, first.history.cursor, 2);
    assert.equal(recovered.history.mode, "append");
    assert.deepEqual(recovered.history.context.entryIds, ["two", "three"]);
  });
});

test("streamed line ranges count physical UTF-8 bytes across chunks, CRLF and malformed bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-line-ranges-"));
  try {
    const first = Buffer.from("a".repeat(1024 * 1024 - 1) + "界\r\n");
    const invalid = Buffer.from([0xff, 0x0d, 0x0a]);
    const last = Buffer.from("末尾");
    const body = Buffer.concat([first, invalid, last]);
    const filePath = join(dir, "lines.jsonl");
    writeFileSync(filePath, body);
    const lines = [];
    forEachFileLineSync(filePath, (line, offset, length) => lines.push({ line, offset, length }));
    assert.deepEqual(lines.map(({ offset, length }) => [offset, length]), [
      [0, first.length - 1],
      [first.length, invalid.length - 1],
      [first.length + invalid.length, last.length],
    ]);
    for (const { line, offset, length } of lines) {
      assert.equal(line, body.subarray(offset, offset + length).toString("utf8"), "a sought range decodes to the exact streamed line");
    }
    assert.ok(lines[0].line.endsWith("界\r"), "multi-byte character split across chunks is preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
