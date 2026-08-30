import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const { extractSubagentHistory, readCompletionArtifact, readSubagentTranscriptPage, resolveSubagentArtifact, siblingDirForSession, MAX_SUBAGENT_COMPLETION_BYTES } =
  await jiti.import("./subagent-history.ts");

function makeSessionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-history-"));
  const sessionFile = join(dir, "2026-08-01T00-00-00_abc123.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-08-01T00:00:00.000Z", cwd: "C:\\work" }),
    JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "task",
        content: [],
        details: {
          projectAgentsDir: "C:\\work\\.omp\\agents",
          progress: [
            {
              index: 0,
              id: "ScoutAgent",
              agent: "scout",
              agentSource: "bundled",
              status: "running",
              task: "Map the surface",
              assignment: "Inspect files",
              tokens: 1200,
              cost: 0.012,
              durationMs: 65000,
              requests: 3,
              toolCount: 9,
              resolvedModel: "provider/gpt-x",
              modelRole: "smol",
            },
          ],
          results: [
            {
              index: 0,
              id: "ScoutAgent",
              agent: "scout",
              agentSource: "bundled",
              task: "Map the surface",
              exitCode: 0,
              tokens: 999,
              durationMs: 60000,
              requests: 3,
              toolCount: 9,
              resolvedModel: "provider/gpt-x",
              modelRole: "smol",
              structuredOutput: { status: "valid", mode: "permissive" },
              outputPath: "C:\\work\\artifacts\\ScoutAgent.md",
              usage: { cost: { input: 0.4, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
            },
          ],
          async: { state: "completed", jobId: "ScoutAgent", type: "task" },
        },
      },
    }),
    JSON.stringify({
      type: "message",
      id: "e2",
      parentId: null,
      timestamp: "2026-08-01T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "task",
        content: [],
        details: {
          results: [
            {
              index: 1,
              id: "WorkerOne",
              agent: "worker",
              agentSource: "bundled",
              task: "Write the code",
              exitCode: 1,
              error: "Test failed",
              tokens: 500,
            },
          ],
          async: { state: "failed", jobId: "WorkerOne", type: "task" },
        },
      },
    }),
  ];
  writeFileSync(sessionFile, lines.join("\n") + "\n");

  // Sibling artifacts dir with one transcript file.
  const artifactsDir = siblingDirForSession(sessionFile);
  mkdirSync(artifactsDir, { recursive: true });
  const transcript = [
    JSON.stringify({ type: "session", version: 3, id: "sub-session", timestamp: "2026-08-01T00:00:00.000Z", cwd: "C:\\work" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: "Map the surface" } }),
    JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
  ];
  writeFileSync(join(artifactsDir, "ScoutAgent.jsonl"), transcript.join("\n") + "\n");

  return { dir, sessionFile, artifactsDir };
}

test("extracts subagent roster from task toolResults with settled results winning", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const roster = extractSubagentHistory(sessionFile);
    assert.equal(roster.length, 2);

    const scout = roster.find((entry) => entry.id === "ScoutAgent");
    assert.ok(scout);
    assert.equal(scout.agent, "scout");
    assert.equal(scout.agentSource, "bundled");
    // Settled result overrides the mid-run progress snapshot.
    assert.equal(scout.status, "completed");
    assert.equal(scout.tokens, 999);
    // Settled cost rides usage.cost.total (top-level cost is absent)
    assert.equal(scout.cost, 0.5);
    assert.equal(scout.durationMs, 60000);
    assert.equal(scout.task, "Map the surface");
    assert.equal(scout.transcriptAvailable, true);
    assert.equal(scout.sessionFile, join(dir, "2026-08-01T00-00-00_abc123", "ScoutAgent.jsonl"));
    assert.equal(scout.result?.structuredOutput?.status, "valid");

    const worker = roster.find((entry) => entry.id === "WorkerOne");
    assert.ok(worker);
    assert.equal(worker.status, "failed");
    assert.equal(worker.result?.error, "Test failed");
    assert.equal(worker.transcriptAvailable, false);
    // Both spawns were async (details.async present).
    assert.equal(scout.detached, true);
    assert.equal(worker.detached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps async-only spawns (empty results) as started entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-history-"));
  const sessionFile = join(dir, "sess.jsonl");
  try {
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "p", timestamp: "2026-08-01T00:00:00.000Z", cwd: "C:\\work" }),
      JSON.stringify({
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2026-08-01T00:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "task",
          content: [],
          details: { async: { state: "running", jobId: "AsyncJob", type: "task" } },
        },
      }),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");
    const roster = extractSubagentHistory(sessionFile);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].id, "AsyncJob");
    assert.equal(roster[0].status, "started");
    assert.equal(roster[0].transcriptAvailable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pages subagent transcripts byte-wise with UI messages", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const transcriptFile = join(siblingDirForSession(sessionFile), "ScoutAgent.jsonl");
    const page1 = readSubagentTranscriptPage(transcriptFile, 0);
    assert.equal(page1.reset, false);
    assert.equal(page1.messages.length, 2);
    assert.equal(page1.messages[0].role, "user");
    assert.equal(page1.messages[1].role, "assistant");
    assert.ok(page1.nextByte > 0);

    // Continue from the end: nothing new.
    const page2 = readSubagentTranscriptPage(transcriptFile, page1.nextByte);
    assert.equal(page2.messages.length, 0);
    assert.equal(page2.nextByte, page1.nextByte);

    // Past EOF resets to the start.
    const page3 = readSubagentTranscriptPage(transcriptFile, 999999);
    assert.equal(page3.reset, true);
    assert.equal(page3.messages.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("byte-window paging survives non-ASCII content before the offset", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const transcriptFile = join(siblingDirForSession(sessionFile), "ScoutAgent.jsonl");
    // First entry carries multi-byte UTF-8 so byte offsets and UTF-16 string
    // indices diverge (the regression that .slice(startByte) reintroduced).
    const entry1 = JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: "user", content: "質問：マルチバイトのテキストです" },
    });
    const entry2 = JSON.stringify({
      type: "message",
      id: "e2",
      parentId: null,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { role: "assistant", content: "plain ascii follow-up" },
    });
    writeFileSync(transcriptFile, `${entry1}\n${entry2}\n`);

    // Continue from the exact byte length of entry1's line: only entry2 may
    // come back. A UTF-16 slice would start mid-line and drop it.
    const fromByte = Buffer.byteLength(`${entry1}\n`, "utf8");
    const page = readSubagentTranscriptPage(transcriptFile, fromByte);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].role, "assistant");
    assert.equal(page.nextByte, fromByte + Buffer.byteLength(`${entry2}\n`, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page without a trailing newline still advances (no infinite paging)", () => {
  const { dir, sessionFile } = makeSessionFixture();
  try {
    const transcriptFile = join(siblingDirForSession(sessionFile), "ScoutAgent.jsonl");
    // No trailing newline: the last line is partial until the file grows.
    writeFileSync(transcriptFile, `{"type":"message","id":"e1","parentId":null,"timestamp":"2026-08-01T00:00:00.000Z","message":{"role":"user","content":"a"}}
{"type":"message","id":"e2","parentId":null,"timestamp":"2026-08-01T00:00:01.000Z","message":{"role":"assistant","content":"b"}}`);
    const page1 = readSubagentTranscriptPage(transcriptFile, 0);
    // Only the complete first line parses; the partial tail is skipped so
    // the next page makes progress instead of looping on the same offset.
    assert.equal(page1.messages.length, 1);
    assert.ok(page1.nextByte > 0);
    const page2 = readSubagentTranscriptPage(transcriptFile, page1.nextByte);
    assert.equal(page2.nextByte, page1.nextByte);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing transcript file yields an empty page", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-history-"));
  try {
    const page = readSubagentTranscriptPage(join(dir, "missing.jsonl"), 0);
    assert.equal(page.messages.length, 0);
    assert.equal(page.nextByte, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("completion reads keep complete trailing multibyte characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-completion-"));
  const sessionFile = join(dir, "sess.jsonl");
  const artifactsDir = siblingDirForSession(sessionFile);
  mkdirSync(artifactsDir, { recursive: true });
  try {
    writeFileSync(join(artifactsDir, "Scout.md"), "hello");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md"))?.completion, "hello");
    writeFileSync(join(artifactsDir, "Scout.md"), "oké");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md"))?.completion, "oké");
    writeFileSync(join(artifactsDir, "Scout.md"), "done😀");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md"))?.completion, "done😀");
    // Missing file -> null; empty file -> null.
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Nope", ".md")), null);
    writeFileSync(join(artifactsDir, "Scout.md"), "");
    assert.equal(readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Scout", ".md")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completion caps materialized bytes without splitting a codepoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-completion-"));
  const sessionFile = join(dir, "sess.jsonl");
  const artifactsDir = siblingDirForSession(sessionFile);
  mkdirSync(artifactsDir, { recursive: true });
  try {
    // A file slightly over the cap ending with a 4-byte emoji: the read is
    // capped mid-emoji, and the partial sequence must be dropped, not shown.
    const prefix = "x".repeat(MAX_SUBAGENT_COMPLETION_BYTES);
    writeFileSync(join(artifactsDir, "Big.md"), prefix + "😀tail");
    const result = readCompletionArtifact(resolveSubagentArtifact(sessionFile, "Big", ".md"));
    assert.equal(result?.truncated, true);
    assert.ok(result?.completion);
    assert.ok(result.completion.length <= MAX_SUBAGENT_COMPLETION_BYTES);
    assert.equal(result.completion.includes("�"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One task toolResult holding a batch of agents that all number from 0. */
function taskBatchLine(id, callId, agents, timestamp) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "task",
      content: [],
      details: {
        progress: agents.map((agent, index) => ({
          index,
          id: `${callId}_${agent}${index}`,
          agent,
          agentSource: "bundled",
          status: "completed",
          task: "work",
        })),
      },
    },
  });
}

/** The assistant turn that issues the calls, in the order it issued them. */
function taskCallLine(id, callIds, timestamp) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: callIds.map((callId) => ({ type: "toolCall", id: callId, name: "task", arguments: {} })),
    },
  });
}

test("separate task calls keep their agents apart instead of interleaving", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-order-"));
  const sessionFile = join(dir, "2026-08-02T00-00-00_order.jsonl");
  try {
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-08-02T00:00:00.000Z", cwd: "C:\\work" }),
      taskCallLine("a1", ["callA"], "2026-08-02T00:00:00.500Z"),
      taskBatchLine("e1", "callA", ["scout", "scout"], "2026-08-02T00:00:01.000Z"),
      taskCallLine("a2", ["callB"], "2026-08-02T00:04:00.000Z"),
      taskBatchLine("e2", "callB", ["worker", "worker"], "2026-08-02T00:05:00.000Z"),
    ].join("\n") + "\n");

    // Both batches number their children 0,1, so ordering by `index` alone
    // would yield callA_scout0, callB_worker0, callA_scout1, callB_worker1.
    assert.deepEqual(
      extractSubagentHistory(sessionFile).map((entry) => entry.id),
      ["callA_scout0", "callA_scout1", "callB_worker0", "callB_worker1"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel calls follow the order the assistant issued them, not the order they finished", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-order-"));
  const sessionFile = join(dir, "2026-08-02T00-00-00_parallel.jsonl");
  try {
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-08-02T00:00:00.000Z", cwd: "C:\\work" }),
      // One turn spawns both batches; the slower one is announced first.
      taskCallLine("a1", ["callSlow", "callFast"], "2026-08-02T00:00:00.500Z"),
      // Results are appended as each call finishes, so the fast one lands first.
      taskBatchLine("e1", "callFast", ["sonic"], "2026-08-02T00:00:20.000Z"),
      taskBatchLine("e2", "callSlow", ["worker"], "2026-08-02T00:09:00.000Z"),
    ].join("\n") + "\n");

    const roster = extractSubagentHistory(sessionFile);
    assert.deepEqual(roster.map((entry) => entry.id), ["callSlow_worker0", "callFast_sonic0"]);

    // The ordinal has to travel to the client: a live snapshot and a partial
    // history fetch both leave it guessing which call came first.
    assert.deepEqual(roster.map((entry) => entry.batchSeq), [0, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent seen only in results keeps its own call's place", () => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-subagent-order-"));
  const sessionFile = join(dir, "2026-08-02T00-00-00_results.jsonl");
  try {
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-08-02T00:00:00.000Z", cwd: "C:\\work" }),
      taskCallLine("a1", ["zzFirst", "aaSecond"], "2026-08-02T00:00:00.500Z"),
      taskBatchLine("e1", "zzFirst", ["scout"], "2026-08-02T00:00:01.000Z"),
      JSON.stringify({
        type: "message",
        id: "e2",
        parentId: null,
        timestamp: "2026-08-02T00:05:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "aaSecond",
          toolName: "task",
          content: [],
          // No progress array: a child that finished before any snapshot was
          // recorded exists only as a settled result.
          details: { results: [{ index: 0, id: "aaLateWorker", agent: "worker", exitCode: 0 }] },
        },
      }),
    ].join("\n") + "\n");

    // Ids are chosen so that the old `index` comparator, which tie-breaks
    // alphabetically, would put the later agent first.
    assert.deepEqual(
      extractSubagentHistory(sessionFile).map((entry) => entry.id),
      ["zzFirst_scout0", "aaLateWorker"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

