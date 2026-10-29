import assert from "node:assert/strict";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { readSessionTailState } = await jiti.import("./session-owner.ts");

const dir = mkdtempSync(join(tmpdir(), "omp-web-session-tail-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function fileWith(lines) {
  counter += 1;
  const path = join(dir, `session-${counter}.jsonl`);
  writeFileSync(path, lines.join("\n"));
  return path;
}

const userMessage = (text) => JSON.stringify({ type: "message", id: `u${counter}`, parentId: null, message: { role: "user", content: text } });
const assistantText = () => JSON.stringify({ type: "message", id: `a${counter}`, parentId: null, message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
const assistantToolCall = () => JSON.stringify({
  type: "message",
  id: `t${counter}`,
  parentId: null,
  message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] },
});
const toolResult = () => JSON.stringify({
  type: "message",
  id: `r${counter}`,
  parentId: null,
  message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
});
const liveToolStart = () => JSON.stringify({
  type: "custom",
  customType: "tool_execution_start",
  id: `e${counter}`,
  parentId: null,
  data: { toolCallId: "call-1", toolName: "bash" },
});
const sessionExit = () => JSON.stringify({
  type: "custom",
  customType: "session_exit",
  id: `x${counter}`,
  parentId: null,
  data: { reason: "dispose" },
});

test("an empty session file is neither active nor closed", () => {
  const state = readSessionTailState(fileWith([""]));
  assert.ok(state);
  assert.equal(state.hasTrailingExit, false);
  assert.equal(state.looksActive, false);
  assert.ok(state.mtimeMs > 0);
});

test("a missing file reads as unknown", () => {
  assert.equal(readSessionTailState(join(dir, "does-not-exist.jsonl")), null);
});

test("an unfinished tool call or tool result reads as an active turn", () => {
  assert.equal(readSessionTailState(fileWith([userMessage("go"), assistantToolCall()])).looksActive, true);
  assert.equal(readSessionTailState(fileWith([userMessage("go"), assistantToolCall(), toolResult()])).looksActive, true);
  // A running tool writes its own record and no result yet.
  assert.equal(readSessionTailState(fileWith([userMessage("go"), liveToolStart()])).looksActive, true);
});

test("a finished turn (trailing assistant text) is not active", () => {
  const state = readSessionTailState(fileWith([userMessage("go"), assistantToolCall(), toolResult(), assistantText()]));
  assert.equal(state.looksActive, false);
  assert.equal(state.hasTrailingExit, false);
});

test("a trailing session_exit means the writer closed the file", () => {
  const state = readSessionTailState(fileWith([userMessage("go"), assistantText(), sessionExit()]));
  assert.equal(state.hasTrailingExit, true);
  assert.equal(state.looksActive, false);
});

test("a torn last line is skipped instead of hiding the real end", () => {
  const path = fileWith([userMessage("go"), assistantText(), '{"type":"message","id":"torn"']);
  const state = readSessionTailState(path);
  assert.equal(state.hasTrailingExit, false);
  assert.equal(state.looksActive, false, "the last complete record is finished text");
});

test("a last line larger than the tail window does not throw", () => {
  const huge = JSON.stringify({
    type: "message",
    id: "huge",
    parentId: null,
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(70 * 1024) }] },
  });
  const path = fileWith([userMessage("go"), huge]);
  const state = readSessionTailState(path);
  assert.ok(state);
  assert.equal(state.hasTrailingExit, false);
});

test("a truncated file still reports its mtime", () => {
  const path = fileWith([userMessage("go"), assistantToolCall()]);
  truncateSync(path, 10);
  const state = readSessionTailState(path);
  // The first 10 bytes are a partial record: no parseable message, no crash.
  assert.ok(state);
  assert.equal(state.looksActive, false);
  assert.ok(state.mtimeMs > 0);
});
