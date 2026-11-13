import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "omp-github-watcher-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

const { GhUnavailableError } = await import("./gh.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
const { addWatch, listWatches, getPending, closeWatchStore } = await import("./watch-store.ts");
const { pollOnce, startGithubWatcher, stopGithubWatcher } = await import("./watcher.ts");

test.after(() => {
  stopGithubWatcher();
  closeWatchStore();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

const ITEM = "acme/widgets#7";
const URL = "https://github.com/acme/widgets/pull/7";
const cursor = (over = {}) => ({ commentIds: [], reviewIds: [], threadCommentIds: [], reportedHeads: [], final: false, ...over });
const emptyPage = { hasPreviousPage: false, startCursor: null };
const node = (id) => ({ id, url: `${URL}#${id}`, author: { login: "alice", __typename: "User" }, authorAssociation: "MEMBER" });

/** A pull request carrying the given review ids, as `gh api graphql` would answer. */
const snapshotJson = (reviewIds) =>
  JSON.stringify({
    data: {
      repository: {
        issueOrPullRequest: {
          __typename: "PullRequest",
          url: URL,
          state: "OPEN",
          comments: { pageInfo: emptyPage, nodes: [] },
          reviews: { pageInfo: emptyPage, nodes: reviewIds.map((id) => ({ ...node(id), state: "APPROVED", comments: { totalCount: 0 } })) },
          reviewThreads: { pageInfo: emptyPage, nodes: [] },
          commits: { nodes: [] },
        },
      },
    },
  });

/** A fresh store and settings, a watcher whose fakes the test steers, and no timers. */
function harness(t, outcome = () => "ok") {
  stopGithubWatcher();
  closeWatchStore();
  rmSync(join(dir, "omp-web"), { recursive: true, force: true });
  saveWebServerSettings({ agentToolsEnabled: true });
  const world = { reviews: ["PRR_1"], runs: 0, failure: undefined, delivered: [] };
  startGithubWatcher({
    run: async () => {
      world.runs++;
      if (world.failure) throw world.failure;
      return snapshotJson(world.reviews);
    },
    deliver: async (sessionId, entryId, message) => {
      world.delivered.push({ sessionId, entryId, message });
      return outcome(sessionId, world.delivered.length);
    },
    now: () => 1_700_000_000_000,
    schedule: () => () => undefined,
  });
  t.after(stopGithubWatcher);
  return world;
}

test("a new review is delivered once and the cursor advances", async (t) => {
  const world = harness(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  await pollOnce();
  assert.equal(world.delivered.length, 1);
  assert.ok(world.delivered[0].message.startsWith(`GitHub update (omp-web): ${ITEM} ${URL}`));
  assert.deepEqual(listWatches()[0].cursor.reviewIds, ["PRR_1"]);
  assert.equal(getPending("s1", ITEM), null);
  await pollOnce();
  assert.equal(world.delivered.length, 1);
});

test("a retry leaves the cursor so the next poll redelivers the same entry id", async (t) => {
  const world = harness(t, (_s, n) => (n === 1 ? "retry" : "ok"));
  addWatch("s1", ITEM, "pull_request", cursor());
  await pollOnce();
  assert.deepEqual(listWatches()[0].cursor.reviewIds, []);
  assert.ok(getPending("s1", ITEM));
  world.reviews.push("PRR_2"); // a pending update is redelivered as stored, not diffed anew
  await pollOnce();
  assert.equal(world.delivered.length, 2);
  assert.equal(world.delivered[1].entryId, world.delivered[0].entryId);
  assert.equal(world.delivered[1].message, world.delivered[0].message);
  assert.deepEqual(listWatches()[0].cursor.reviewIds, ["PRR_1"]);
  assert.equal(getPending("s1", ITEM), null);
});

test("a gone session ends its watches only", async (t) => {
  harness(t, (sessionId) => (sessionId === "s1" ? "gone" : "ok"));
  addWatch("s1", ITEM, "pull_request", cursor());
  addWatch("s2", ITEM, "pull_request", cursor());
  await pollOnce();
  assert.deepEqual(listWatches().map((w) => [w.sessionId, w.cursor.reviewIds]), [["s2", ["PRR_1"]]]);
});

test("two sessions watching one item fetch it once and each get an entry", async (t) => {
  const world = harness(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  addWatch("s2", ITEM, "pull_request", cursor());
  await pollOnce();
  assert.equal(world.runs, 1);
  assert.deepEqual(world.delivered.map((d) => d.sessionId).sort(), ["s1", "s2"]);
  assert.notEqual(world.delivered[0].entryId, world.delivered[1].entryId);
});

test("agent tools off pauses polling and turning it on catches up", async (t) => {
  const world = harness(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  saveWebServerSettings({ agentToolsEnabled: false });
  await pollOnce();
  assert.equal(world.runs, 0);
  assert.equal(world.delivered.length, 0);
  assert.equal(listWatches().length, 1);
  saveWebServerSettings({ agentToolsEnabled: true });
  await pollOnce();
  assert.equal(world.delivered.length, 1);
});

test("gh unavailability is announced once and its recovery once", async (t) => {
  const world = harness(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  addWatch("s2", "acme/widgets#8", "pull_request", cursor());
  world.failure = new GhUnavailableError("gh is not logged in");
  await pollOnce();
  await pollOnce();
  assert.deepEqual(world.delivered.map((d) => d.message), [
    "GitHub update (omp-web): watching paused: gh is not logged in",
    "GitHub update (omp-web): watching paused: gh is not logged in",
  ]);
  world.failure = undefined;
  world.delivered.length = 0;
  await pollOnce();
  await pollOnce();
  const resumed = world.delivered.filter((d) => d.message === "GitHub update (omp-web): watching resumed");
  assert.deepEqual(resumed.map((d) => d.sessionId).sort(), ["s1", "s2"]);
});
