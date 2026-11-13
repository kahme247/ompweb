import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const store = await import("./watch-store.ts");

const cursor = (over = {}) => ({ commentIds: [], reviewIds: [], threadCommentIds: [], reportedHeads: [], final: false, ...over });
const ITEM = "acme/widgets#7";

/** A fresh agent dir; `reopen()` drops the cached handle, as a restart would. */
function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-watch-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  store.closeWatchStore();
  t.after(() => {
    store.closeWatchStore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { reopen: store.closeWatchStore };
}

test("the 21st watch of a session is refused", (t) => {
  isolated(t);
  for (let n = 1; n <= 20; n++) assert.equal(store.addWatch("s1", `acme/widgets#${n}`, "pull_request", cursor()), "added");
  assert.equal(store.addWatch("s1", "acme/widgets#21", "pull_request", cursor()), "limit");
  assert.equal(store.addWatch("s2", "acme/widgets#21", "pull_request", cursor()), "added");
});

test("adding a watch twice keeps the stored cursor", (t) => {
  isolated(t);
  assert.equal(store.addWatch("s1", ITEM, "issue", cursor({ commentIds: ["IC_1"] })), "added");
  assert.equal(store.addWatch("s1", ITEM, "issue", cursor({ commentIds: ["IC_9"] })), "exists");
  assert.deepEqual(store.listWatches(), [{ sessionId: "s1", itemKey: ITEM, kind: "issue", cursor: cursor({ commentIds: ["IC_1"] }) }]);
});

test("commitUpdate with final removes the watch", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  store.commitUpdate("s1", ITEM, cursor({ commentIds: ["IC_2"] }), false);
  assert.deepEqual(store.listWatches()[0].cursor, cursor({ commentIds: ["IC_2"] }));
  store.commitUpdate("s1", ITEM, cursor({ final: true }), true);
  assert.deepEqual(store.listWatches(), []);
});

test("watches survive reopening the store", (t) => {
  const { reopen } = isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor({ reportedHeads: ["abc"] }));
  reopen();
  assert.deepEqual(store.listWatches(), [{ sessionId: "s1", itemKey: ITEM, kind: "pull_request", cursor: cursor({ reportedHeads: ["abc"] }) }]);
});

test("renameSession moves watches and read grants", (t) => {
  isolated(t);
  store.addWatch("old", ITEM, "pull_request", cursor());
  store.grantRead("old", "acme/widgets");
  store.renameSession("old", "new");
  assert.deepEqual(store.listWatches().map((w) => w.sessionId), ["new"]);
  assert.equal(store.hasReadGrant("new", "acme/widgets"), true);
  assert.equal(store.hasReadGrant("old", "acme/widgets"), false);
});

test("setPending then commitUpdate clears it", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const pending = { entryId: "e1", message: "GitHub update (omp-web): acme/widgets#7 https://x", cursor: cursor({ commentIds: ["IC_3"] }), final: false };
  store.setPending("s1", ITEM, pending);
  assert.deepEqual(store.getPending("s1", ITEM), pending);
  store.commitUpdate("s1", ITEM, pending.cursor, false);
  assert.equal(store.getPending("s1", ITEM), null);
});

test("pending survives reopening the store", (t) => {
  const { reopen } = isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const pending = { entryId: "e2", message: "m", cursor: cursor({ final: true }), final: true };
  store.setPending("s1", ITEM, pending);
  reopen();
  assert.deepEqual(store.getPending("s1", ITEM), pending);
});

test("removeWatch and renameSession carry pending rows with the watch", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  store.setPending("s1", ITEM, { entryId: "e3", message: "m", cursor: cursor(), final: false });
  store.renameSession("s1", "s2");
  assert.equal(store.getPending("s1", ITEM), null);
  assert.equal(store.getPending("s2", ITEM)?.entryId, "e3");
  assert.equal(store.removeWatch("s2", ITEM), true);
  assert.equal(store.getPending("s2", ITEM), null);
  assert.equal(store.removeWatch("s2", ITEM), false);
});

test("posted ids are kept per item", (t) => {
  isolated(t);
  store.recordPosted(ITEM, "IC_10");
  store.recordPosted(ITEM, "IC_10");
  store.recordPosted("acme/widgets#8", "IC_11");
  assert.deepEqual([...store.postedIds(ITEM)], ["IC_10"]);
});

test("itemKeyOf and repoKeyOf lower-case owner and repo", () => {
  assert.equal(store.itemKeyOf({ owner: "Acme", repo: "Widgets", number: 7 }), "acme/widgets#7");
  assert.equal(store.repoKeyOf({ owner: "Acme", repo: "Widgets", number: 7 }), "acme/widgets");
});
