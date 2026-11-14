import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";

const store = await import("./watch-store.ts");

const cursor = (over = {}) => ({ commentIds: [], reviewIds: [], threadCommentIds: [], reportedHeads: [], final: false, ...over });
const ITEM = "acme/widgets#7";
/** Watches without their generated registration identity. */
const listed = () => store.listWatches().map(({ createdAt, registrationId, ...watch }) => (assert.equal(typeof createdAt, "number"), assert.equal(typeof registrationId, "string"), watch));
const watchOf = (sessionId, itemKey) => store.listWatches().find((watch) => watch.sessionId === sessionId && watch.itemKey === itemKey);
const asPending = (pending) => ({
  entryId: pending.entryId,
  cursor: pending.cursor,
  final: pending.final,
  batches: pending.batches ?? [{ entryId: pending.entryId, message: pending.message }],
  batchIndex: pending.batchIndex ?? 0,
});
const claim = (sessionId, itemKey, pending, watch = watchOf(sessionId, itemKey), eventIds = []) =>
  store.claimPending(sessionId, itemKey, watch.registrationId, watch.cursor, asPending(pending), eventIds) ? pending : null;
const commit = (sessionId, itemKey, pending, watch = watchOf(sessionId, itemKey)) => {
  const current = store.getPending(sessionId, itemKey, watch.registrationId);
  if (!current) return false;
  for (let index = current.batchIndex; index < current.batches.length; index++) {
    if (!store.advancePendingBatch(sessionId, itemKey, watch.registrationId, current.entryId, index)) return false;
  }
  return store.commitUpdate(sessionId, itemKey, watch.registrationId, pending.entryId, pending.cursor, pending.final);
};

/** A fresh agent dir; `reopen()` drops the cached handle, as a restart would. */
function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-watch-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const connections = new Set();
  const trackConnection = (database) => {
    connections.add(database);
    return database;
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  store.closeWatchStore();
  t.after(() => {
    if (connections.has(globalThis.__ompGithubWatchStore?.db)) globalThis.__ompGithubWatchStore = undefined;
    store.closeWatchStore();
    for (const connection of connections) connection.close(true);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, reopen: store.closeWatchStore, trackConnection };
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
  assert.deepEqual(listed(), [{ sessionId: "s1", itemKey: ITEM, kind: "issue", cursor: cursor({ commentIds: ["IC_1"] }) }]);
});

test("commitUpdate with final removes the watch", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const update = { entryId: "e1", message: "m1", cursor: cursor({ commentIds: ["IC_2"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, update), update);
  assert.equal(commit("s1", ITEM, update), true);
  assert.deepEqual(store.listWatches()[0].cursor, cursor({ commentIds: ["IC_2"] }));
  const final = { entryId: "e2", message: "m2", cursor: cursor({ final: true }), final: true };
  assert.deepEqual(claim("s1", ITEM, final), final);
  assert.equal(commit("s1", ITEM, final), true);
  assert.deepEqual(store.listWatches(), []);
});
test("watches survive reopening the store", (t) => {
  const { reopen } = isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor({ reportedHeads: ["abc"] }));
  reopen();
  assert.deepEqual(listed(), [{ sessionId: "s1", itemKey: ITEM, kind: "pull_request", cursor: cursor({ reportedHeads: ["abc"] }) }]);
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

test("claimPending then commitUpdate clears the pending batch", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const pending = { entryId: "e1", message: "GitHub update (omp-web): acme/widgets#7 https://x", cursor: cursor({ commentIds: ["IC_3"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  assert.deepEqual(store.getPending("s1", ITEM), asPending(pending));
  assert.equal(commit("s1", ITEM, pending), true);
  assert.equal(store.getPending("s1", ITEM), null);
});

test("pending survives reopening the store", (t) => {
  const { reopen } = isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const pending = { entryId: "e2", message: "m", cursor: cursor({ final: true }), final: true };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  reopen();
  assert.deepEqual(store.getPending("s1", ITEM), asPending(pending));
});

test("removeWatch and renameSession carry pending rows with the watch", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const pending = { entryId: "e3", message: "m", cursor: cursor(), final: false };
  claim("s1", ITEM, pending);
  store.renameSession("s1", "s2");
  assert.equal(store.getPending("s1", ITEM), null);
  assert.equal(store.getPending("s2", ITEM)?.entryId, "e3");
  assert.equal(store.removeWatch("s2", ITEM), true);
  assert.equal(store.getPending("s2", ITEM), null);
  assert.equal(store.removeWatch("s2", ITEM), false);
});

test("removeSessionWatches drops the session's watches, pending updates and read grants", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  store.addWatch("s2", "acme/widgets#8", "issue", cursor());
  claim("s1", ITEM, { entryId: "e6", message: "m", cursor: cursor(), final: false });
  store.grantRead("s1", "acme/widgets");
  store.grantRead("s2", "acme/widgets");
  store.removeSessionWatches("s1");
  assert.deepEqual(store.listWatches().map((w) => w.sessionId), ["s2"]);
  assert.equal(store.getPending("s1", ITEM), null);
  assert.equal(store.hasReadGrant("s1", "acme/widgets"), false);
  assert.equal(store.hasReadGrant("s2", "acme/widgets"), true);
});

test("a rename onto a session that watches the same item keeps the moved watch and its pending update", (t) => {
  isolated(t);
  store.addWatch("old", ITEM, "pull_request", cursor({ commentIds: ["IC_old"] }));
  store.addWatch("new", ITEM, "pull_request", cursor({ commentIds: ["IC_new"] }));
  const movedPending = { entryId: "e-old", message: "m-old", cursor: cursor({ commentIds: ["IC_old", "IC_2"] }), final: false };
  claim("old", ITEM, movedPending);
  claim("new", ITEM, { entryId: "e-new", message: "m-new", cursor: cursor(), final: false });
  assert.doesNotThrow(() => store.renameSession("old", "new"));
  assert.deepEqual(listed(), [{ sessionId: "new", itemKey: ITEM, kind: "pull_request", cursor: cursor({ commentIds: ["IC_old"] }) }]);
  assert.deepEqual(store.getPending("new", ITEM), asPending(movedPending));
  assert.equal(store.getPending("old", ITEM), null);
});

test("renameSession to the same id leaves the rows intact", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  store.grantRead("s1", "acme/widgets");
  claim("s1", ITEM, { entryId: "e4", message: "m", cursor: cursor(), final: false });
  store.renameSession("s1", "s1");
  assert.deepEqual(store.listWatches().map((w) => w.sessionId), ["s1"]);
  assert.equal(store.getPending("s1", ITEM)?.entryId, "e4");
  assert.equal(store.hasReadGrant("s1", "acme/widgets"), true);
});

test("claimPending on a removed watch stores nothing", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const oldWatch = watchOf("s1", ITEM);
  const pending = { entryId: "e5", message: "m", cursor: cursor(), final: false };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  assert.equal(store.removeWatch("s1", ITEM), true);
  assert.equal(store.claimPending("s1", ITEM, oldWatch.registrationId, oldWatch.cursor, asPending(pending), []), null);
  assert.equal(store.getPending("s1", ITEM), null);
});

test("separate connections cannot replace a pending batch from the same cursor", (t) => {
  const { dir, trackConnection } = isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  const primary = globalThis.__ompGithubWatchStore;
  trackConnection(primary.db);
  const secondary = trackConnection(new Database(join(dir, "omp-web", "github-watches.sqlite")));
  secondary.exec("PRAGMA busy_timeout = 5000");
  assert.notEqual(primary.db, secondary);

  const batchA = { entryId: "event-a", message: "A", cursor: cursor({ commentIds: ["A"] }), final: false };
  const batchAB = { entryId: "event-a-b", message: "A, B", cursor: cursor({ commentIds: ["A", "B"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, batchA, watch, ["A"]), batchA);
  globalThis.__ompGithubWatchStore = { path: primary.path, db: secondary };
  assert.equal(store.claimPending("s1", ITEM, watch.registrationId, watch.cursor, asPending(batchAB), ["A", "B"]), null);
  assert.deepEqual(store.getPending("s1", ITEM, watch.registrationId), asPending(batchA));

  globalThis.__ompGithubWatchStore = primary;
  assert.equal(commit("s1", ITEM, batchA, watch), true);
  assert.equal(store.claimPending("s1", ITEM, watch.registrationId, watch.cursor, asPending(batchAB), ["A", "B"]), null);
  assert.equal(store.getPending("s1", ITEM), null);
  assert.deepEqual(store.listWatches()[0].cursor, batchA.cursor);
});

test("stale final and non-final commits cannot mutate a re-registered watch", (t) => {
  isolated(t);
  for (const final of [false, true]) {
    const sessionId = `s-${final}`;
    const baseline = cursor();
    store.addWatch(sessionId, ITEM, "pull_request", baseline);
    const oldWatch = watchOf(sessionId, ITEM);
    const oldPending = { entryId: `old-${final}`, message: "old", cursor: cursor({ commentIds: ["OLD"], final }), final };
    assert.deepEqual(claim(sessionId, ITEM, oldPending, oldWatch), oldPending);
    assert.equal(store.removeWatch(sessionId, ITEM), true);
    assert.equal(store.addWatch(sessionId, ITEM, "pull_request", baseline), "added");
    const newWatch = watchOf(sessionId, ITEM);
    assert.notEqual(newWatch.registrationId, oldWatch.registrationId);
    const newPending = { entryId: `new-${final}`, message: "new", cursor: cursor({ commentIds: ["NEW"] }), final: false };
    assert.deepEqual(claim(sessionId, ITEM, newPending, newWatch), newPending);

    assert.equal(store.commitUpdate(sessionId, ITEM, oldWatch.registrationId, oldPending.entryId, oldPending.cursor, final), false);
    assert.deepEqual(watchOf(sessionId, ITEM).cursor, baseline);
    assert.deepEqual(store.getPending(sessionId, ITEM, newWatch.registrationId), asPending(newPending));
  }
});

test("cursor-only advances require the current registration, base cursor, and no pending batch", (t) => {
  isolated(t);
  const baseline = cursor();
  store.addWatch("s1", ITEM, "pull_request", baseline);
  const oldWatch = watchOf("s1", ITEM);
  store.removeWatch("s1", ITEM);
  const newBaseline = cursor({ commentIds: ["NEW"] });
  store.addWatch("s1", ITEM, "pull_request", newBaseline);
  const current = watchOf("s1", ITEM);
  const staleCursor = cursor({ commentIds: ["STALE"] });
  assert.equal(store.advanceCursor("s1", ITEM, oldWatch.registrationId, oldWatch.cursor, staleCursor), false);
  assert.deepEqual(watchOf("s1", ITEM).cursor, newBaseline);
  const advanced = cursor({ commentIds: ["NEW", "NEXT"] });
  assert.equal(store.advanceCursor("s1", ITEM, current.registrationId, current.cursor, advanced), true);
  assert.deepEqual(watchOf("s1", ITEM).cursor, advanced);
  const pending = { entryId: "pending", message: "m", cursor: cursor({ commentIds: ["NEW", "NEXT", "PENDING"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  assert.equal(store.advanceCursor("s1", ITEM, current.registrationId, advanced, pending.cursor), false);
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

test("a shared post lease prevents self-post claims across connections", async (t) => {
  const { dir, trackConnection } = isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  const primary = globalThis.__ompGithubWatchStore;
  trackConnection(primary.db);
  const secondary = trackConnection(new Database(join(dir, "omp-web", "github-watches.sqlite")));
  secondary.exec("PRAGMA busy_timeout = 5000");

  let startPost;
  const started = new Promise((resolve) => { startPost = resolve; });
  let finishPost;
  const blocked = new Promise((resolve) => { finishPost = resolve; });
  const post = store.whilePosting(ITEM, async () => {
    startPost();
    await blocked;
    store.recordPosted(ITEM, "IC_self");
  });
  await started;

  const pending = { entryId: "self-post", message: "own post", cursor: cursor({ commentIds: ["IC_self"] }), final: false };
  globalThis.__ompGithubWatchStore = { path: primary.path, db: secondary };
  assert.equal(store.isPosting(ITEM), true);
  assert.equal(store.claimPending("s1", ITEM, watch.registrationId, watch.cursor, asPending(pending), ["IC_self"]), null);

  globalThis.__ompGithubWatchStore = primary;
  finishPost();
  await post;
  globalThis.__ompGithubWatchStore = { path: primary.path, db: secondary };
  assert.equal(store.isPosting(ITEM), false);
  assert.equal(store.claimPending("s1", ITEM, watch.registrationId, watch.cursor, asPending(pending), ["IC_self"]), null);
  assert.deepEqual([...store.postedIds(ITEM)], ["IC_self"]);
  assert.equal(store.getPending("s1", ITEM), null);
  globalThis.__ompGithubWatchStore = primary;
  await assert.rejects(store.whilePosting(ITEM, async () => { throw new Error("uncertain"); }), /uncertain/);
  assert.equal(store.isPosting(ITEM), true);
  globalThis.__ompGithubWatchStore = { path: primary.path, db: secondary };
  secondary.prepare("UPDATE active_posts SET lease_until = ? WHERE item_key = ?").run(Date.now() - 1, ITEM);
  assert.equal(store.isPosting(ITEM), false);
});

test("batch progress survives restart and only the complete update commits its cursor", (t) => {
  const { reopen } = isolated(t);
  const baseline = cursor();
  store.addWatch("s1", ITEM, "pull_request", baseline);
  const watch = watchOf("s1", ITEM);
  const pending = {
    entryId: "whole-update",
    cursor: cursor({ commentIds: ["IC_1", "IC_2"] }),
    final: true,
    batches: [
      { entryId: "chunk-1", message: "first chunk" },
      { entryId: "chunk-2", message: "second chunk" },
    ],
    batchIndex: 0,
  };
  assert.deepEqual(store.claimPending("s1", ITEM, watch.registrationId, watch.cursor, pending, ["IC_1", "IC_2"]), pending);
  const acceptedBeforeCrash = pending.batches[0].entryId;
  const outboxAccepted = new Set([acceptedBeforeCrash]);
  reopen();
  const replay = store.getPending("s1", ITEM, watch.registrationId);
  assert.equal(replay.batchIndex, 0);
  assert.equal(replay.batches[0].entryId, acceptedBeforeCrash);
  assert.equal(outboxAccepted.has(replay.batches[replay.batchIndex].entryId), true);
  assert.equal(store.advancePendingBatch("s1", ITEM, watch.registrationId, pending.entryId, 1), false);
  assert.equal(store.advancePendingBatch("s1", ITEM, watch.registrationId, pending.entryId, 0), true);
  assert.equal(store.commitUpdate("s1", ITEM, watch.registrationId, pending.entryId, pending.cursor, true), false);
  assert.equal(store.advancePendingBatch("s1", ITEM, watch.registrationId, pending.entryId, 1), true);
  assert.equal(store.getPending("s1", ITEM, watch.registrationId).batchIndex, 2);
  assert.equal(store.commitUpdate("s1", ITEM, watch.registrationId, pending.entryId, pending.cursor, true), true);
  assert.deepEqual(store.listWatches(), []);
});

test("legacy pending updates migrate as one replayable batch", (t) => {
  const { dir } = isolated(t);
  const storeDir = join(dir, "omp-web");
  mkdirSync(storeDir, { recursive: true });
  const legacy = new Database(join(storeDir, "github-watches.sqlite"));
  legacy.exec(`
    CREATE TABLE watches (session_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, cursor_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, item_key));
    CREATE TABLE pending (session_id TEXT NOT NULL, item_key TEXT NOT NULL, entry_id TEXT NOT NULL, message TEXT NOT NULL, cursor_json TEXT NOT NULL, final INTEGER NOT NULL, PRIMARY KEY (session_id, item_key));
  `);
  const baseline = cursor({ reviewIds: ["PRR_1"] });
  const pendingCursor = cursor({ reviewIds: ["PRR_1", "PRR_2"] });
  legacy.prepare("INSERT INTO watches VALUES (?, ?, ?, ?, ?)").run("s1", ITEM, "pull_request", JSON.stringify(baseline), 1);
  legacy.prepare("INSERT INTO pending VALUES (?, ?, ?, ?, ?, ?)").run("s1", ITEM, "legacy-entry", "legacy update", JSON.stringify(pendingCursor), 0);
  legacy.close(true);

  const watch = watchOf("s1", ITEM);
  assert.equal(typeof watch.registrationId, "string");
  assert.deepEqual(store.getPending("s1", ITEM, watch.registrationId), {
    entryId: "legacy-entry",
    cursor: pendingCursor,
    final: false,
    batches: [{ entryId: "legacy-entry", message: "legacy update" }],
    batchIndex: 0,
  });
});

test("claims reject review snapshots whose REST alias is already posted", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  store.recordPosted(ITEM, "review:123");
  const pending = {
    entryId: "review-update",
    cursor: cursor({ reviewIds: ["PRR_node"] }),
    final: false,
    batches: [{ entryId: "review-batch", message: "review" }],
    batchIndex: 0,
  };
  assert.equal(store.claimPending("s1", ITEM, watch.registrationId, watch.cursor, pending, ["PRR_node", "review:123"]), null);
  assert.equal(store.getPending("s1", ITEM), null);
});

test("review alias posts fence claims that raced the snapshot diff", (t) => {
  isolated(t);
  store.addWatch("s1", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  store.recordPosted(ITEM, "review:123");
  const pending = {
    entryId: "review-update",
    cursor: cursor({ reviewIds: ["PRR_node"] }),
    final: false,
    batches: [{ entryId: "review-batch", message: "review" }],
    batchIndex: 0,
  };
  assert.equal(store.claimPending("s1", ITEM, watch.registrationId, watch.cursor, pending, ["PRR_node", "review:123"]), null);
  assert.equal(store.getPending("s1", ITEM), null);
});
