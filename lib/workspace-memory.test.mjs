import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  workspaceKeyOf,
} = await jiti.import("./workspace-memory.ts");

test("uses the shared project root so worktrees restore the same workspace", () => {
  assert.equal(workspaceKeyOf({ cwd: "D:/repo-worktrees/feature", projectRoot: "D:/repo" }), "D:/repo");
  assert.equal(workspaceKeyOf({ cwd: "D:/scratch" }), "D:/scratch");
});

test("empty-string fields fall through to the next workspace key", () => {
  // Headers from hand-edited or partially written session files can carry
  // "" instead of a missing field; ?? would keep the empty string and the
  // session would group under no project.
  assert.equal(workspaceKeyOf({ cwd: "/scratch", projectRoot: "", projectKey: "" }), "/scratch");
  assert.equal(workspaceKeyOf({ cwd: "", projectRoot: "/repo", projectKey: "" }), "/repo");
  assert.equal(workspaceKeyOf({ cwd: "", projectRoot: "", projectKey: "" }), "");
});
