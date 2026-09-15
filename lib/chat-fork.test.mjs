import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveForkEntryIds } = await jiti.import("./chat-fork.ts");

test("assistant replies fork at the user prompt that started their turn", () => {
  const roles = ["user", "assistant", "toolResult", "assistant", "user", "assistant"];
  const entryIds = ["u1", "a1", "t1", "a2", "u2", "a3"];
  assert.deepEqual(resolveForkEntryIds(roles, entryIds), [
    "u1", "u1", undefined, "u1", "u2", "u2",
  ]);
});

test("messages with no earlier user entry have no fork target", () => {
  assert.deepEqual(
    resolveForkEntryIds(["assistant", "toolResult", "bashExecution"], ["a0", "t0", "b0"]),
    [undefined, undefined, undefined],
  );
});

test("a user entry without an id leaves the turn unforkable", () => {
  assert.deepEqual(
    resolveForkEntryIds(["user", "assistant", "user", "assistant"], [undefined, "a1", "u2", "a2"]),
    [undefined, undefined, "u2", "u2"],
  );
});