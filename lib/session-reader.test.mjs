import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sessionPathKey } = await jiti.import("./paths.ts");
const {
  buildSessionContext,
  cacheSessionPath,
  getSessionEntries,
  getTodoPhasesFromEntries,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
} = await jiti.import("./session-reader.ts");
const { getSessionsDir } = await jiti.import("./omp/paths.ts");

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

test("loads a workspace profile from its profile-specific session directory", async (t) => {
  const defaultAgentDir = mkdtempSync(join(tmpdir(), "omp-web-default-agent-"));
  const homeDir = mkdtempSync(join(tmpdir(), "omp-web-profile-home-"));
  const workspace = join(tmpdir(), "omp-web-profile-workspace");
  const workspaceChild = join(workspace, "nested");
  mkdirSync(workspaceChild, { recursive: true });
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    ompProfile: process.env.OMP_PROFILE,
    piProfile: process.env.PI_PROFILE,
  };
  process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  t.after(() => {
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.userProfile;
    if (previous.ompProfile === undefined) delete process.env.OMP_PROFILE;
    else process.env.OMP_PROFILE = previous.ompProfile;
    if (previous.piProfile === undefined) delete process.env.PI_PROFILE;
    else process.env.PI_PROFILE = previous.piProfile;
    invalidateSessionListCache();
    rmSync(defaultAgentDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  try {
    const projects = [{ path: workspace, addedAt: "2026-01-01T00:00:00.000Z", hidden: false, launchConfig: { profile: "work" } }];
    writeFileSync(join(defaultAgentDir, "projects.json"), JSON.stringify({ version: 1, projects }));
    const defaultSessions = join(defaultAgentDir, "sessions", "-workspace-nested");
    const profileSessions = join(getSessionsDir("work"), "-workspace-nested");
    mkdirSync(defaultSessions, { recursive: true });
    mkdirSync(profileSessions, { recursive: true });
    writeSessionFile(defaultSessions, "default.jsonl", { id: "same-id", cwd: workspaceChild, timestamp: "2026-01-01T00:00:00.000Z" });
    writeSessionFile(profileSessions, "profile.jsonl", { id: "same-id", cwd: workspaceChild, timestamp: "2026-01-02T00:00:00.000Z" });

    invalidateSessionListCache();
    const sessions = await listAllSessions();
    assert.deepEqual(sessions.map((session) => session.id), ["work:same-id"]);
    assert.equal(sessions[0]?.profile, "work");
  } finally {
    // t.after restores the process-wide environment after this test completes.
  }
});

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
    assert.equal(byId.get("default:child-by-path")?.parentSessionId, "default:parent-id");
    assert.equal(byId.get("default:child-by-id")?.parentSessionId, "default:parent-id");
    assert.equal(byId.get("default:orphan")?.parentSessionId, undefined);
  });
});

test("stops resolving a session path once the file is deleted", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_doomed.jsonl", {
      id: "doomed",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [userEntry("u1", null, "hello")]);

    assert.equal(await resolveSessionPath("default:doomed"), filePath);
    unlinkSync(filePath);
    // A stale cache hit here would make the agent routes spawn omp with
    // --resume against a missing file, silently creating a new session.
    assert.equal(await resolveSessionPath("default:doomed"), null);
    assert.equal(globalThis.__piSessionPathCache?.has("default:doomed"), false);
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
    assert.equal(before.some((s) => s.id === "default:first"), true);

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
    assert.equal(after.some((s) => s.id === "default:second"), true);
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
