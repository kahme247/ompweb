import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { planTranscriptRows, looksLikeRunningTurn, collectToolResults, sanitizePassiveToolContext } = await jiti.import("./chat-transcript-plan.ts");

function user(id, content = `u-${id}`) {
  return { role: "user", content };
}
function assistant(id, blocks, text) {
  const content = blocks ?? [{ type: "text", text: text ?? `a-${id}` }];
  return { role: "assistant", provider: "t", model: "m", content };
}
function toolCall(id, toolName = "bash") {
  return { type: "toolCall", toolCallId: id, toolName, input: {} };
}
function toolResult(toolCallId) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }] };
}
function compaction() {
  return { role: "custom", customType: "compaction", display: true, content: "sum" };
}

/** Summarize segments as [kind, detail] pairs: text → its text, activity → piece message indices. */
function shape(row) {
  return row.segments.map((segment) => {
    if (segment.kind === "text") return ["text", segment.blocks.map((block) => block.text).join("|")];
    return ["activity", segment.pieces.map((piece) => piece.index)];
  });
}

test("plans a plain Q/A pair as standalone rows", () => {
  const rows = planTranscriptRows([user("u1"), assistant("a1")]);
  assert.deepEqual(rows, [
    { kind: "message", index: 0 },
    { kind: "message", index: 1 },
  ]);
});

test("an answer that ended the turn stays visible when a reminder resumes the agent", () => {
  // Session 01a0d187: the agent yields a reply carrying drafts, a todo
  // reminder restarts it, it updates todos, then closes with a short message
  // pointing back at the drafts. The drafts must not fold behind the closer.
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "thinking", thinking: "plan" }, toolCall("tc1")]),
    toolResult("tc1"),
    assistant("a2", [{ type: "thinking", thinking: "report" }, { type: "text", text: "Drafted replies: 1, 2, 3" }]),
    { role: "developer", content: [{ type: "text", text: "<system-reminder>You stopped with 7 incomplete todo item(s)</system-reminder>" }] },
    assistant("a3", [toolCall("tc2", "todo"), toolCall("tc3", "todo")]),
    toolResult("tc2"),
    toolResult("tc3"),
    assistant("a4", undefined, "I need your decision on the drafts above."),
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 1);
  assert.deepEqual(shape(rows[0]), [
    ["activity", [1, 3]],
    ["text", "Drafted replies: 1, 2, 3"],
    ["activity", [4, 5]],
    ["text", "I need your decision on the drafts above."],
  ]);
  assert.deepEqual(rows[0].segments.filter((s) => s.kind === "activity").map((s) => s.toolCallCount), [1, 2]);
});

test("text before a tool call stays visible and splits the activity around it", () => {
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "text", text: "Checking the repo." }, toolCall("tc1"), toolCall("tc2")]),
    toolResult("tc1"),
    toolResult("tc2"),
    assistant("a2", [toolCall("tc3")]),
    toolResult("tc3"),
    assistant("a2", undefined, "Done."),
  ];
  const [row] = planTranscriptRows(messages);
  assert.deepEqual(shape(row), [
    ["text", "Checking the repo."],
    ["activity", [1, 4]],
    ["text", "Done."],
  ]);
  assert.equal(row.segments[1].toolCallCount, 3);
  // Only text that ends its message carries usage/error.
  assert.deepEqual(row.segments.filter((s) => s.kind === "text").map((s) => s.last), [false, true]);
});

test("a provider error after activity gets its own visible segment", () => {
  const messages = [
    user("u1"),
    assistant("a1", [toolCall("tc1")]),
    toolResult("tc1"),
    { ...assistant("a2", [toolCall("tc2")]), stopReason: "error", errorMessage: "provider failed" },
  ];
  const [row] = planTranscriptRows(messages);
  assert.deepEqual(shape(row), [["activity", [1, 3]], ["text", ""]]);
  assert.deepEqual({ index: row.segments[1].index, last: row.segments[1].last }, { index: 3, last: true });
});

test("hideThinking drops thinking, so a turn with only thinking and text has nothing to fold", () => {
  const messages = [user("u1"), assistant("a1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Answer" }])];
  const shown = planTranscriptRows(messages);
  assert.deepEqual(shape(shown[0]), [["activity", [1]], ["text", "Answer"]]);
  assert.deepEqual(planTranscriptRows(messages, { hideThinking: true }), [
    { kind: "message", index: 0 },
    { kind: "message", index: 1 },
  ]);
});

test("showThinking keeps thinking out of the fold, so an expanded block is not hidden on commit", () => {
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "thinking", thinking: "plan" }, toolCall("tc1")]),
    toolResult("tc1"),
    assistant("a2", [{ type: "thinking", thinking: "report" }, { type: "text", text: "Done" }]),
  ];
  const rows = planTranscriptRows(messages, { showThinking: true });
  const kinds = rows[0].segments.map((segment) => segment.kind === "text" ? ["text", segment.index, segment.blocks.map((block) => block.type)] : ["activity", segment.pieces.map((piece) => piece.blocks?.map((block) => block.type))]);
  // Thinking leads its message as visible content; only the tool call folds.
  assert.deepEqual(kinds, [
    ["text", 1, ["thinking"]],
    ["activity", [["toolCall"]]],
    ["text", 3, ["thinking", "text"]],
  ]);
  // A turn of only thinking and text has nothing left to fold.
  assert.deepEqual(planTranscriptRows([user("u1"), assistant("a1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Answer" }])], { showThinking: true }), [
    { kind: "message", index: 0 },
    { kind: "message", index: 1 },
  ]);
});

test("showToolCalls keeps tool call rows out of the fold; with showThinking nothing is left to fold", () => {
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "thinking", thinking: "plan" }, toolCall("tc1")]),
    toolResult("tc1"),
    assistant("a2", [{ type: "text", text: "Done" }]),
  ];
  const kinds = (row) => row.segments.map((segment) => segment.kind === "text" ? ["text", segment.blocks.map((block) => block.type)] : ["activity", segment.pieces.map((piece) => piece.blocks?.map((block) => block.type))]);
  // Only the thinking still folds; the tool call leads as visible content.
  assert.deepEqual(kinds(planTranscriptRows(messages, { showToolCalls: true })[0]), [
    ["activity", [["thinking"]]],
    ["text", ["toolCall"]],
    ["text", ["text"]],
  ]);
  // Nothing left to fold: standalone rows, without a row for the tool result (it renders under its call).
  assert.deepEqual(planTranscriptRows(messages, { showToolCalls: true, showThinking: true }), [
    { kind: "message", index: 0 },
    { kind: "message", index: 1 },
    { kind: "message", index: 3 },
  ]);
});

test("mount notices, which never render, do not open an empty fold", () => {
  const mount = { role: "custom", customType: "xdev-mount-notice", display: true, content: "mounted" };
  assert.deepEqual(planTranscriptRows([user("u1"), mount, assistant("a1")]), [
    { kind: "message", index: 0 },
    { kind: "message", index: 1 },
    { kind: "message", index: 2 },
  ]);
});

test("#136 a tail awaiting a tool result counts as a live foreign run", () => {
  // omp-web gets no SSE frames for a run owned by another `omp` process, so the
  // transcript tail is the only signal that a turn is still in flight.
  assert.equal(looksLikeRunningTurn([user("u1"), assistant("a1", [toolCall("tc1")])]), true);
  assert.equal(looksLikeRunningTurn([user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1")]), true);
  assert.equal(looksLikeRunningTurn([]), false);
});

test("#136 a completed or never-started turn is not a live foreign run", () => {
  assert.equal(looksLikeRunningTurn([user("u1")]), false, "the user just typed");
  assert.equal(looksLikeRunningTurn([user("u1"), assistant("a2", undefined, "Done.")]), false);
  // Text anywhere after the last tool call closed the turn.
  assert.equal(
    looksLikeRunningTurn([user("u1"), assistant("a1", [toolCall("tc1"), { type: "text", text: "Working on it" }])]),
    false,
  );
  // A turn closed by an error or a cancel is finished, not pending.
  assert.equal(
    looksLikeRunningTurn([user("u1"), { ...assistant("a2", [toolCall("tc2")]), stopReason: "error", errorMessage: "provider failed" }]),
    false,
  );
  assert.equal(
    looksLikeRunningTurn([user("u1"), { ...assistant("a2", [toolCall("tc2")]), stopReason: "aborted" }]),
    false,
  );
});

test("compaction summaries anchor turns, and consecutive turns stay separate rows", () => {
  const messages = [
    user("u1"),
    assistant("a1", [toolCall("tc1")]),
    toolResult("tc1"),
    assistant("a2"),
    compaction(),
    assistant("a3", [toolCall("tc2")]),
    toolResult("tc2"),
    assistant("a4"),
  ];
  const rows = planTranscriptRows(messages);
  assert.deepEqual(
    rows.map((r) => ({ start: r.userIndex, end: r.endIndex })),
    [
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ],
  );
});

function passive(text) {
  return { role: "custom", customType: "passive-tool-context", display: false, content: [{ type: "text", text }] };
}

test("passive context attaches to the last tool call of the batch it follows, not as a row", () => {
  const messages = [
    user("u1"),
    assistant("a1", [toolCall("tc1"), toolCall("tc2")]),
    toolResult("tc1"),
    toolResult("tc2"),
    passive("Use both results before continuing."),
    assistant("a2", undefined, "Done."),
  ];
  const results = collectToolResults(messages);
  assert.equal(results.get("tc2").passiveContext, "Use both results before continuing.");
  assert.equal(results.get("tc1").passiveContext, undefined);
  assert.equal(results.get("tc2").content, messages[3].content, "the result itself is unchanged");
  assert.equal(messages[3].passiveContext, undefined, "the committed message is not mutated");
  assert.equal(collectToolResults(messages).get("tc2"), results.get("tc2"), "stable identity across recomputes");
  // The context message is neither a fold piece nor a standalone row.
  assert.deepEqual(shape(planTranscriptRows(messages)[0]), [["activity", [1]], ["text", "Done."]]);
  // Mid-run, trailing context does not make the turn look finished.
  assert.equal(looksLikeRunningTurn(messages.slice(0, 5)), true);
});

test("orphaned passive context is dropped instead of attaching to an earlier card", () => {
  const notice = { role: "custom", customType: "job-result", display: true, content: "job done" };
  const afterNotice = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), notice, passive("stale"),
  ]);
  assert.equal(afterNotice.get("tc1").passiveContext, undefined);
  const afterText = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), assistant("a2", undefined, "hi"), passive("stale"),
  ]);
  assert.equal(afterText.get("tc1").passiveContext, undefined);
  const afterUser = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), user("u2"), passive("stale"),
  ]);
  assert.equal(afterUser.get("tc1").passiveContext, undefined);
  // A second context after the batch already took one is orphaned too.
  const twice = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), passive("first"), passive("second"),
  ]);
  assert.equal(twice.get("tc1").passiveContext, "first");
});

test("passive context keeps line breaks and indentation; blank context attaches nothing", () => {
  assert.equal(
    sanitizePassiveToolContext("\n\x1b[31mUse\x1b[0m\tboth  \r\n\n\n\n  results\x07\n\n"),
    "Use\tboth\n\n  results",
  );
  assert.equal(sanitizePassiveToolContext([{ type: "text", text: "line one" }, { type: "text", text: "line two" }]), "line one\nline two");
  // Lines holding only whitespace count as blank for the blank-line cap.
  assert.equal(sanitizePassiveToolContext("a\n \n\u00a0\n\t\nb"), "a\n\nb");
  const results = collectToolResults([user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), passive(" \t\x1b[0m\n")]);
  assert.equal(results.get("tc1").passiveContext, undefined);
});

test("malformed or hostile passive context never breaks the transcript", () => {
  // Imported and hand-edited session files can carry any content shape.
  for (const content of [undefined, null, 5, { a: 1 }, [null], [{ type: "text" }]]) {
    const results = collectToolResults([
      user("u1"), assistant("a1", [null, toolCall("tc1")]), toolResult("tc1"), { ...passive(""), content },
    ]);
    assert.equal(results.get("tc1").passiveContext, undefined, `content ${JSON.stringify(content)}`);
  }
  // Bidi overrides and zero-width characters could visually rewrite the line.
  assert.equal(sanitizePassiveToolContext("safe\u202Etxet\u200B tail"), "safetxet tail");
  assert.equal(sanitizePassiveToolContext("a".repeat(5000)).length, 2000);
  // A huge whitespace run stays linear (a backtracking trim regex would hang
  // here), and the cap never leaves trailing whitespace behind.
  assert.equal(sanitizePassiveToolContext(`a${" ".repeat(200_000)}b`), "a");
  assert.equal(sanitizePassiveToolContext(`${"a".repeat(1999)}\n\nb`), "a".repeat(1999));
});
