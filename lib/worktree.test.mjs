import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { addWorktree, listWorktrees, removeWorktree, resolveProject } = await jiti.import("./worktree.ts");
const { samePath } = await jiti.import("./paths.ts");
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, "-c", "safe.directory=*", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("discovers the main checkout and linked worktrees without retaining prunable paths", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "omp-web-worktree-test-"));
  const repo = join(root, "repo");
  const worktreeBase = `${repo}-worktrees`;
  try {
    git(root, ["init", repo]);
    git(repo, ["config", "user.email", "omp-web@example.invalid"]);
    git(repo, ["config", "user.name", "omp-web test"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "fixture"]);

    const main = await resolveProject(repo);
    assert.ok(samePath(main.projectRoot, repo));
    assert.equal(main.isWorktree, false);
    assert.equal(main.isTopLevel, true);
    assert.ok(main.branch);

    const created = await addWorktree(repo, "feature/test");
    assert.equal(created.branch, "feature/test");
    assert.equal(existsSync(created.path), true);

    const worktrees = await listWorktrees(repo);
    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[0].isMain, true);
    assert.ok(worktrees.some((entry) => samePath(entry.path, created.path) && entry.branch === "feature/test"));

    const linked = await resolveProject(created.path);
    assert.ok(samePath(linked.projectRoot, repo));
    assert.equal(linked.isWorktree, true);
    assert.equal(linked.branch, "feature/test");
    await removeWorktree(repo, created.path, true);
    assert.equal(existsSync(created.path), false);
  } finally {
    rmSync(worktreeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
