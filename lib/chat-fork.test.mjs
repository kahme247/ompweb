import assert from "node:assert/strict";
import test from "node:test";

const { resolveForkTargets } = await import("./chat-fork.ts");

const branch = (entryId, editPrompt) => ({ type: "branch", entryId, editPrompt });
const leafFork = () => ({ type: "fork", editPrompt: false });
const rows = (...roles) => roles.map((role) => (role === "summary" ? { role: "user", branchSummary: true } : { role }));

test("user prompts edit-and-resend; replies fork at the next prompt so they are kept; active leaf clones in-place", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "toolResult", "assistant", "user", "assistant"), ["u1", "a1", "t1", "a2", "u2", "a3"]),
    [undefined, branch("u2", false), undefined, branch("u2", false), branch("u2", true), leafFork()],
  );
});

test("single-turn session allows forking assistant response as leaf clone, but first user prompt has no rewind target", () => {
  assert.deepEqual(resolveForkTargets(rows("user", "assistant"), ["u1", "a1"]), [undefined, leafFork()]);
  // After compaction the first prompt has a summary before it, so it can be edited.
  // A compaction row renders as "custom", not a user message
  // (lib/session-reader.ts), so it can never become a branch point itself.
  assert.deepEqual(
    resolveForkTargets(rows("custom", "user", "assistant"), ["c0", "u1", "a1"]),
    [undefined, branch("u1", true), leafFork()],
  );
});

test("branch summaries render as user rows but are never branch points", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "user", "assistant", "summary", "user", "assistant"), ["u0", "a0", "u1", "a1", "s1", "u2", "a2"]),
    [undefined, branch("u1", false), branch("u1", true), branch("u2", false), undefined, branch("u2", true), leafFork()],
  );
});

test("messages with no usable user entry have no fork target", () => {
  assert.deepEqual(
    resolveForkTargets(rows("assistant", "toolResult", "bashExecution"), ["a0", "t0", "b0"]),
    [undefined, undefined, undefined],
  );
});

test("leaf assistant forks in-place even when terminal user prompt has no entry ID", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "user", "assistant", "user", "assistant"), ["u0", "a0", "u1", "a1", undefined, "a2"]),
    [undefined, branch("u1", false), branch("u1", true), branch("u1", true), undefined, leafFork()],
  );
});

test("when activeLeafId is desynchronized from HEAD, terminal message falls back to branch instead of leaf fork", () => {
  assert.deepEqual(
    resolveForkTargets(
      rows("user", "assistant", "user", "assistant"),
      ["u1", "a1", "u2", "a2"],
      { activeLeafId: "branch-a-leaf", headLeafId: "head-leaf" },
    ),
    [undefined, branch("u2", false), branch("u2", true), branch("u2", true)],
  );
});
