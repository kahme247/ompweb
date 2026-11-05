import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { filePathApiSegments } from "../file-paths.ts";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("worktrees are granted only by their owner and dirty removal requires explicit force", async (t) => {
 const f=await workspaceHarness();t.after(()=>f.close());const owner=await f.startHost();const other=await f.startHost();const cwd=owner.project;
 const git=(...args)=>execFileSync("git",["-C",cwd,...args]);git("init","-q");git("config","user.name","Workspace test");git("config","user.email","test@example.invalid");writeFileSync(join(cwd,"file.txt"),"base");git("add",".");git("commit","-qm","fixture");
 await owner.host.sessionOps.validateCwd(cwd);
 const added=await owner.host.workspaceOps.addWorktree(cwd,"feature/remote");assert.equal(added.ok,true);const target=added.value.path;
 const input={segments:filePathApiSegments(target),sessionId:null};assert.equal((await owner.host.workspaceOps.listFiles(input,false)).ok,true);assert.equal((await other.host.workspaceOps.listFiles(input,false)).status,403);
 const listing=await owner.host.workspaceOps.listWorktrees(target);assert.equal(listing.value.projectRoot,cwd);assert.equal(listing.value.currentWorktreePath,target);
 writeFileSync(join(target,"file.txt"),"dirty bytes");const dirty=await owner.host.workspaceOps.removeWorktree(cwd,target,false);assert.equal(dirty.status,409);assert.equal(dirty.code,"worktree_dirty");assert.equal(existsSync(target),true);
 const main=await owner.host.workspaceOps.removeWorktree(cwd,cwd,true);assert.equal(main.ok,false);assert.equal(existsSync(cwd),true);
 const unrelated=await owner.host.workspaceOps.removeWorktree(cwd,other.project,true);assert.equal(unrelated.ok,false);assert.equal(existsSync(other.project),true);
 assert.deepEqual(await owner.host.workspaceOps.removeWorktree(cwd,target,true),{ok:true,value:null});assert.equal(existsSync(target),false);
 rmSync(`${cwd}-worktrees`, { recursive: true, force: true });
 symlinkSync(other.project, `${cwd}-worktrees`, "dir");
 const escape = await owner.host.workspaceOps.addWorktree(cwd,"feature/escape"); assert.equal(escape.ok,false); assert.equal(existsSync(join(other.project,"feature-escape")),false);
});
