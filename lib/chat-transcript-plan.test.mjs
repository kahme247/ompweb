import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { planTranscriptRows } = await jiti.import("./chat-transcript-plan.ts");

function user(id, content = `u-${id}`) {
  return { role: "user", content };
}
function assistant(id, blocks, text) {
  const content = blocks ?? [{ type: "text", text: text ?? `a-${id}` }];
  return { role: "assistant", provider: "t", model: "m", content };
}
function toolResult(_id, toolCallId) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }] };
}
function compaction() {
  return { role: "custom", customType: "compaction", display: true, content: "sum" };
}
function todoMessage() {
  return { role: "custom", customType: "user_todo_edit", display: false, content: "", data: { phases: [] } };
}

test("plans a plain Q/A pair as standalone rows", () => {
  const rows = planTranscriptRows([user("u1"), assistant("a1")]);
  assert.deepEqual(rows, [
    { kind: "message", index: 0 },
    { kind: "message", index: 1 },
  ]);
});

test("folds process tool-call messages into one collapsed group row (anchor rendered separately by the caller)", () => {
  // user → toolcall → result → final answer. The group row carries the
  // anchor's index; the ChatWindow renderer pushes the anchor element itself.
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } }]),
    toolResult("tr1", "tc1"),
    assistant("a2"), // final answer
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 1, "one group row");
  const group = rows[0];
  assert.equal(group.kind, "group");
  assert.equal(group.userIndex, 0);
  assert.equal(group.endIndex, 4);
  assert.equal(group.finalAssistantIndex, 3);
  assert.equal(group.processCount, 1, "only the tool-call message folds in; a2 is the answer row");
  assert.equal(group.toolCallCount, 1);
  assert.equal(group.hasFinalAnswer, true);
});

test("a turn whose only assistant is a tool-call message still folds (no final answer)", () => {
  // user → toolcall → result → user. No assistant has an answer block, so the
  // tool-call assistant becomes the fallback final assistant and its blocks
  // fold into the process group — mirroring the pre-refactor renderer.
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } }]),
    toolResult("tr1", "tc1"),
    user("u2"),
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 2, "group + trailing user");
  assert.equal(rows[0].kind, "group");
  assert.deepEqual(
    { start: rows[0].userIndex, end: rows[0].endIndex, final: rows[0].finalAssistantIndex, count: rows[0].processCount, hasFinal: rows[0].hasFinalAnswer },
    { start: 0, end: 3, final: 1, count: 1, hasFinal: false },
  );
  assert.deepEqual(rows[1], { kind: "message", index: 3 });
});

test("treats a compaction summary as a group anchor", () => {
  const messages = [
    compaction("cmp1"),
    assistant("a1", [{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } }]),
    toolResult("tr1", "tc1"),
    assistant("a2"),
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "group");
  assert.equal(rows[0].userIndex, 0);
});

test("collapses the group when the final assistant has an answer + trailing toolResults", () => {
  // user → toolcall → result → final answer → toolresult. One group row
  // covers the whole turn [0,5); the renderer emits anchor + group + answer +
  // trailing toolResult from the row's indices.
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } }]),
    toolResult("tr1", "tc1"),
    assistant("a2"),
    toolResult("tr2", "tc2"),
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 1, "one group row for the whole turn");
  assert.equal(rows[0].kind, "group");
  assert.equal(rows[0].endIndex, 5, "group covers trailing toolResult; renderer emits it after the answer");
});

test("keeps empty-answer process groups collapsed with processCount from tool calls", () => {
  const messages = [
    user("u1"),
    assistant("a1", [
      { type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } },
      { type: "toolCall", toolCallId: "tc2", toolName: "read", input: { path: "x" } },
    ]),
    toolResult("tr1", "tc1"),
    toolResult("tr2", "tc2"),
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "group");
  // a1 is the fallback final assistant; its two tool-call blocks fold in as
  // the single finalProcessMessage. The toolResults render after the group.
  assert.equal(rows[0].processCount, 1);
  assert.equal(rows[0].toolCallCount, 2);
  assert.equal(rows[0].hasFinalAnswer, false);
  assert.deepEqual(rows[0].processIndices, []);
});

test("keeps an assistant provider error visible as the final row of a process group", () => {
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } }]),
    toolResult("tr1", "tc1"),
    { ...assistant("a2", []), stopReason: "error", errorMessage: "provider failed" },
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "group");
  assert.equal(rows[0].finalAssistantIndex, 3);
  assert.equal(rows[0].hasFinalAnswer, true);
});

test("non-message entries (todo custom) render inside the group when folded", () => {
  // user → todo-custom → assistant. The todo message is displayable process
  // content (role custom), so it folds into one group covering the turn.
  const rows = planTranscriptRows([user("u1"), todoMessage("td1"), assistant("a1")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "group");
  assert.deepEqual(
    { start: rows[0].userIndex, end: rows[0].endIndex, final: rows[0].finalAssistantIndex },
    { start: 0, end: 3, final: 2 },
  );
});

test("two consecutive collapsed turns produce two group rows with stable anchors", () => {
  const messages = [
    user("u1"),
    assistant("a1", [{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "x" } }]),
    toolResult("tr1", "tc1"),
    assistant("a2"), // final answer 1
    user("u2"),
    assistant("a3", [{ type: "toolCall", toolCallId: "tc2", toolName: "bash", input: { command: "y" } }]),
    toolResult("tr2", "tc2"),
    assistant("a4"), // final answer 2
  ];
  const rows = planTranscriptRows(messages);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => ({ start: r.userIndex, end: r.endIndex, final: r.finalAssistantIndex })),
    [
      { start: 0, end: 4, final: 3 },
      { start: 4, end: 8, final: 7 },
    ],
  );
});
