import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test from "node:test";

const { renderActivityPieces } = await import("./ChatWindow.tsx");

const call = (id, name = "bash") => ({ type: "toolCall", toolCallId: id, toolName: name, input: { command: id } });
const assistant = (content) => ({ role: "assistant", provider: "p", model: "m", content });

test("folded activity keeps tool calls from separate messages as separate entries", () => {
  const thinking = { type: "thinking", thinking: "plan" };
  const messages = [
    { role: "user", content: "go" },
    assistant([call("a")]),
    assistant([thinking, call("b"), call("c")]),
    { role: "custom", customType: "developer", content: "notice", display: true },
    assistant([call("d")]),
  ];
  const pieces = [
    { index: 1, blocks: messages[1].content },
    { index: 2, blocks: messages[2].content },
    { index: 3 },
    { index: 4, blocks: messages[4].content },
  ];
  const calls = [];
  renderActivityPieces(messages, pieces, (idx, options) => { calls.push({ idx, options }); return null; });

  // One entry per piece, in order: nothing merged across messages, and the
  // parallel calls of message 2 stay together with their thinking block.
  assert.deepEqual(calls.map(({ idx }) => idx), [1, 2, 3, 4]);
  assert.deepEqual(
    calls.map(({ options }) => options.messageOverride?.content.map((b) => b.toolCallId ?? b.type)),
    [["a"], ["thinking", "b", "c"], undefined, ["d"]],
  );
  assert.deepEqual(calls[1].options.sourceBlockIndices, [0, 1, 2]);
  assert.equal(new Set(calls.map(({ idx, options }) => `${options.keyPrefix}-${idx}`)).size, calls.length);
});
