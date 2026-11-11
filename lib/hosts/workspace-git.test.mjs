import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("Git status, patch and repository links come from the authorized owning daemon", async (t) => {
 const f = await workspaceHarness(); t.after(() => f.close()); const owner = await f.startHost(); const cwd = owner.project;
 const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args]);
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

test("gitOrigins answers each requested path in order with its origin and main-checkout state", async (t) => {
 const f = await workspaceHarness(); t.after(() => f.close()); const owner = await f.startHost();
 const dir = (name) => { const path = join(owner.home, name); mkdirSync(path, { recursive: true }); return path; };
 const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args]);
 const one = dir("one"); git(one, "init", "-q"); git(one, "remote", "add", "origin", "https://example.invalid/one.git");
 const none = dir("none"); git(none, "init", "-q");
 const many = dir("many"); git(many, "init", "-q"); git(many, "remote", "add", "origin", "https://example.invalid/a.git"); git(many, "remote", "set-url", "--add", "origin", "https://example.invalid/b.git");
 const sub = join(one, "sub"); mkdirSync(sub);
 const plain = dir("plain"); const foreign = join(f.root, "foreign"); mkdirSync(foreign); git(foreign, "init", "-q");
 for (const path of [one, none, many, plain]) assert.equal((await owner.host.sessionOps.addProject(path)).ok, true);
 const paths = [plain, many, sub, join(owner.home, "missing"), one, foreign, none];
 const answer = await owner.host.workspaceOps.gitOrigins(paths);
 assert.deepEqual(answer, { ok: true, value: { origins: [
  { path: plain, origin: null, mainCheckout: false }, { path: many, origin: null, mainCheckout: true },
  { path: sub, origin: "https://example.invalid/one.git", mainCheckout: false }, { path: join(owner.home, "missing"), origin: null, mainCheckout: false },
  { path: one, origin: "https://example.invalid/one.git", mainCheckout: true }, { path: foreign, origin: null, mainCheckout: false },
  { path: none, origin: null, mainCheckout: true },
 ] } });
 const tooMany = await owner.host.workspaceOps.gitOrigins(Array.from({ length: 501 }, () => one));
 assert.equal(tooMany.ok, false); assert.equal(tooMany.status, 400);
});
