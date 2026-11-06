import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("Git status, patch and repository links come from the authorized owning daemon", async (t) => {
 const f = await workspaceHarness(); t.after(() => f.close()); const owner = await f.startHost(); const cwd = owner.project;
 const git = (...args) => execFileSync("git", ["-C", cwd, ...args]);
 git("init", "-q"); git("config", "user.name", "Workspace test"); git("config", "user.email", "test@example.invalid");
 writeFileSync(join(cwd, "report.txt"), "before\n"); git("add", "."); git("commit", "-qm", "fixture"); git("remote", "add", "origin", "https://github.com/example/owning-host.git");
 await owner.host.sessionOps.validateCwd(cwd); writeFileSync(join(cwd, "report.txt"), "owning host after\n");
 const status = await owner.host.workspaceOps.gitStatus(cwd); assert.equal(status.ok, true); assert.equal(status.value.files.find((x) => x.filePath === join(cwd, "report.txt")).status, "modified");
 const diff = await owner.host.workspaceOps.gitDiff(cwd, join(cwd, "report.txt")); assert.equal(diff.ok, true); assert.match(diff.value.patch, /\+owning host after/);
 assert.deepEqual(await owner.host.workspaceOps.githubRepo(cwd), {ok:true,value:{repo:"example/owning-host"}});
 const outside = join(owner.home, "outside.txt"); writeFileSync(outside, "outside workspace\n");
 symlinkSync(outside, join(cwd, "escape")); const denied = await owner.host.workspaceOps.gitDiff(cwd, join(cwd,"escape")); assert.equal(denied.ok,false); assert.equal(denied.status,403);
 git("checkout", "--detach", "-q"); const worktrees = await owner.host.workspaceOps.listWorktrees(cwd); assert.equal(worktrees.value.worktrees[0].branch,null);
});
