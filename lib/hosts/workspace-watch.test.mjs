import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("a real daemon watch observes the final burst and atomic replacements, then stops at its epoch", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost();
  await owner.host.sessionOps.validateCwd(owner.project);
  const path = join(owner.project, "watched.txt"); writeFileSync(path, "first");
  const id = randomUUID(), epoch = randomUUID(), events = [];
  const unsubscribe = f.hub.onWorkspaceFile(owner.id, id, epoch, (event) => events.push(event));
  t.after(unsubscribe);
  const input = { segments: path.replace(/^\/+/, "").split("/"), sessionId: null };
  const result = await owner.host.workspaceOps.watchFile(id, epoch, input);
  assert.equal(result.ok, true);
  writeFileSync(path, "second"); writeFileSync(path, "final burst bytes");
  const until = async (size) => { const end = Date.now() + 3000; while (!events.some((e) => e.type === "change" && e.size === size)) { assert.ok(Date.now() < end, "watch must report final bytes"); await delay(10); } };
  await until(17);
  const replacement = join(owner.project, "replacement"); writeFileSync(replacement, "atomic save"); renameSync(replacement, path); await until(11);
  assert.equal((await owner.host.workspaceOps.unwatchFile(id, "old-epoch")).ok, true);
  writeFileSync(path, "newer epoch survives old close"); await until(30);
  await owner.host.workspaceOps.unwatchFile(id, epoch);
  const count = events.length; writeFileSync(path, "after close"); await delay(100); assert.equal(events.length, count);
  const denied = await owner.host.workspaceOps.watchFile(randomUUID(), randomUUID(), { segments: ["etc", "passwd"], sessionId: null });
  assert.equal(denied.ok, false); assert.equal(denied.status, 403);
});

test("closing a watch while authorization is pending cannot leave a late native watcher", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost();
  const file = join(owner.project, "pending.txt"); writeFileSync(file, "pending");
  const { WorkspaceWatches } = await import("./workspace-watch.ts");
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const watches = new WorkspaceWatches(() => delayed, () => assert.fail("a closed pending watch must not emit"));
  t.after(() => watches.closeAll());
  const id = randomUUID(), epoch = randomUUID();
  const starting = watches.watch(id, epoch, { segments: [], sessionId: null });
  watches.unwatch(id, epoch);
  release({ path: file, name: "pending.txt", size: 7, mtimeMs: Date.now(), isDirectory: false, language: "text", mime: "text/plain", previewKind: null });
  await assert.rejects(starting, (error) => error.code === "watch_closed");
});

test("a daemon socket ending closes its file consumers immediately, without waiting for host-status grace", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost();
  await owner.host.sessionOps.validateCwd(owner.project);
  const file = join(owner.project, "disconnect.txt"); writeFileSync(file, "live");
  const id = randomUUID(), epoch = randomUUID();
  let closed;
  const closing = new Promise((resolve) => { closed = resolve; });
  t.after(f.hub.onWorkspaceFile(owner.id, id, epoch, (event) => { if (event.type === "error") closed(event); }));
  assert.equal((await owner.host.workspaceOps.watchFile(id, epoch, { segments: file.replace(/^\/+/, "").split("/"), sessionId: null })).ok, true);
  const exited = once(owner.child, "exit"); owner.child.kill("SIGTERM"); await exited;
  let timer;
  const event = await Promise.race([closing, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the file consumer was left live after its daemon socket ended")), 2000); })]).finally(() => clearTimeout(timer));
  assert.equal(event.type, "error");
});
