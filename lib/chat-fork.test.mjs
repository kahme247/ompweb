import assert from "node:assert/strict";
import test from "node:test";

const { resolveForkTargets } = await import("./chat-fork.ts");

const edit = (entryId) => ({ entryId, editPrompt: true });
const keep = (entryId) => ({ entryId, editPrompt: false });
const rows = (...roles) => roles.map((role) => (role === "summary" ? { role: "user", branchSummary: true } : { role }));

test("user prompts edit-and-resend; replies fork at the next prompt so they are kept", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "toolResult", "assistant", "user", "assistant"), ["u1", "a1", "t1", "a2", "u2", "a3"]),
    [undefined, keep("u2"), undefined, keep("u2"), edit("u2"), edit("u2")],
  );
});

test("a fork that would edit the first prompt into an empty session is not offered", () => {
  assert.deepEqual(resolveForkTargets(rows("user", "assistant"), ["u1", "a1"]), [undefined, undefined]);
  // After compaction the first prompt has a summary before it, so it can be edited.
  // A compaction row renders as "custom", not a user message
  // (lib/session-reader.ts), so it can never become a branch point itself.
  assert.deepEqual(
    resolveForkTargets(rows("custom", "user", "assistant"), ["c0", "u1", "a1"]),
    [undefined, edit("u1"), edit("u1")],
  );
});

test("branch summaries render as user rows but are never branch points", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "user", "assistant", "summary", "user", "assistant"), ["u0", "a0", "u1", "a1", "s1", "u2", "a2"]),
    [undefined, keep("u1"), edit("u1"), keep("u2"), undefined, edit("u2"), edit("u2")],
  );
});

test("messages with no usable user entry have no fork target", () => {
  assert.deepEqual(
    resolveForkTargets(rows("assistant", "toolResult", "bashExecution"), ["a0", "t0", "b0"]),
    [undefined, undefined, undefined],
  );
});

test("a reply with no following prompt to fork at is offered nothing", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "user", "assistant", "user", "assistant"), ["u0", "a0", "u1", "a1", undefined, "a2"]),
    [undefined, keep("u1"), edit("u1"), edit("u1"), undefined, undefined],
  );
});
