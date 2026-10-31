import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { hasVisibleAssistantContent, hasHoldableAssistantContent } = await jiti.import("./assistant-response.ts");

const thinkingOnly = {
  role: "assistant",
  content: [{ type: "thinking", thinking: "Let me think through the options carefully." }],
};
const textReply = { role: "assistant", content: [{ type: "text", text: "hi" }] };
const toolCallOnly = {
  role: "assistant",
  content: [{ type: "toolCall", toolCallId: "c1", toolName: "read", input: {} }],
};

test("hasVisibleAssistantContent is unchanged: thinking alone is not visible content", () => {
  assert.equal(hasVisibleAssistantContent(thinkingOnly), false);
  assert.equal(hasVisibleAssistantContent(textReply), true);
  assert.equal(hasVisibleAssistantContent(toolCallOnly), false);
});

test("hasHoldableAssistantContent holds a thinking-only finished reply", () => {
  assert.equal(hasHoldableAssistantContent(thinkingOnly), true);
});

test("hasHoldableAssistantContent holds ordinary visible replies", () => {
  assert.equal(hasHoldableAssistantContent(textReply), true);
  assert.equal(hasHoldableAssistantContent({ role: "assistant", content: [{ type: "image", source: { type: "base64", data: "x", media_type: "image/png" } }] }), true);
});

test("hasHoldableAssistantContent rejects empty and tool-call-only replies", () => {
  assert.equal(hasHoldableAssistantContent({ role: "assistant", content: [{ type: "thinking", thinking: "   " }] }), false);
  assert.equal(hasHoldableAssistantContent({ role: "assistant", content: [{ type: "thinking", thinking: "" }] }), false);
  assert.equal(hasHoldableAssistantContent(toolCallOnly), false);
  assert.equal(hasHoldableAssistantContent({ role: "assistant", content: [] }), false);
  assert.equal(hasHoldableAssistantContent({ role: "user", content: [{ type: "text", text: "hi" }] }), false);
});
