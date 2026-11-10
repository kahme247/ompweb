import assert from "node:assert/strict";
import test from "node:test";
import { StreamSnapshot } from "./stream-snapshot.ts";

test("a joining server gets rebuilt text and streamed tool arguments, never guessed deltas", () => {
  const s = new StreamSnapshot();
  s.note({ type: "message_start", messageId: "m", message: { role: "assistant", content: [] } });
  for (const assistantMessageEvent of [
    { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 0, delta: "hello" },
    { type: "toolcall_start", contentIndex: 1, block: { type: "toolCall", id: "t", name: "write", arguments: {} } },
    { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"a"' },
  ]) s.note({ type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent });
  const whole = JSON.parse(s.whole());
  assert.equal(whole.type, "message_update");
  assert.equal(whole.message.content[0].text, "hello");
  assert.deepEqual(whole.message.content[1].arguments, { path: "a" });
  s.note({ type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 8, delta: "bad" } });
  assert.equal(s.whole(), null);
});

test("terminal boundaries clear the snapshot but a nonterminal agent end does not", () => {
  const s = new StreamSnapshot();
  const start = { type: "message_start", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "x" }] } };
  s.note(start); s.note({ type: "agent_end", isTerminal: false }); assert.ok(s.whole());
  s.note({ type: "agent_end", isTerminal: true }); assert.equal(s.whole(), null);
  s.note(start); s.note({ type: "message_end", messageId: "m" }); assert.equal(s.whole(), null);
  s.note(start); s.clear(); assert.equal(s.whole(), null);
});

test("a queued user echo cannot clear an assistant message still streaming", () => {
  const snapshot = new StreamSnapshot();
  snapshot.note({ type: "message_start", messageId: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
  snapshot.note({ type: "message_end", messageId: "user", message: { role: "user", content: "next" } });
  assert.equal(JSON.parse(snapshot.whole()).message.content[0].text, "working");
});
