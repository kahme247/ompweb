import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";

const dir = mkdtempSync(join(tmpdir(), "omp-github-watcher-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

const { GhError } = await import("./gh.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
const { MAX_AGENT_COMMAND_REQUEST_BYTES } = await import("../image-attachments.ts");
const { addWatch, removeWatch, listWatches, getPending, closeWatchStore } = await import("./watch-store.ts");
const { deliveryOf, pollOnce, startGithubWatcher, stopGithubWatcher } = await import("./watcher.ts");
const { createGithubToolOps, executeGithubTool } = await import("./tools.ts");

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

/** A pull request as `gh api graphql` would answer; `item` overrides its fields, `data` sits beside `repository`. */
const prJson = (item = {}, data = {}) =>
  JSON.stringify({
    data: {
      repository: {
        issueOrPullRequest: {
          __typename: "PullRequest",
          url: URL,
          state: "OPEN",
          comments: { pageInfo: emptyPage, nodes: [] },
          reviews: { pageInfo: emptyPage, nodes: [] },
          reviewThreads: { pageInfo: emptyPage, nodes: [] },
          commits: { nodes: [] },
          ...item,
        },
      },
      ...data,
    },
  });

/** A pull request carrying the given review ids. */
const snapshotJson = (reviewIds, reviewPageInfo = emptyPage) =>
  prJson({ reviews: { pageInfo: reviewPageInfo, nodes: reviewIds.map((id) => ({ ...node(id), state: "APPROVED", comments: { totalCount: 0 } })) } });

/** Collects console.warn lines for the rest of the test. */
function captureWarnings(t) {
  const warned = [];
  const warn = console.warn;
  console.warn = (line) => warned.push(String(line));
  t.after(() => { console.warn = warn; });
  return warned;
}

/** A fresh store and settings, a watcher whose fakes the test steers, and timers the test fires itself. */
function harness(t, outcome = () => "ok") {
  stopGithubWatcher();
  closeWatchStore();
  rmSync(join(dir, "omp-web"), { recursive: true, force: true });
  saveWebServerSettings({ agentToolsEnabled: true });
  const world = { reviews: ["PRR_1"], runs: 0, failure: undefined, auth: undefined, delivered: [], timers: [], answer: undefined, now: 1_700_000_000_000 };
  startGithubWatcher({
    run: async (args, input) => {
      if (args[1] === "user") {
        if (world.auth) return world.auth();
        if (world.failure) throw world.failure;
        return "alice";
      }
      world.runs++;
      return world.answer ? world.answer(JSON.parse(input).variables) : snapshotJson(world.reviews);
    },
    deliver: async (sessionId, entryId, message) => {
      // The stored update must exist before its outbox add, so a crash in between replays it.
      const item = message.split(" ")[3]; // update messages only; outage notices carry no stored row
      if (item?.includes("#")) {
        const pending = getPending(sessionId, item);
        assert.equal(pending?.batches[pending.batchIndex]?.entryId, entryId);
      }
      world.delivered.push({ sessionId, entryId, message });
      return outcome(sessionId, world.delivered.length);
    },
    now: () => world.now,
    schedule: (fn, ms) => {
      const timer = { fn, ms };
      world.timers.push(timer);
      return () => world.timers.splice(world.timers.indexOf(timer), 1);
    },
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

test("a second close after a re-watch gets its own entry id, so the outbox does not collapse it into the first", async (t) => {
  const world = harness(t);
  world.answer = () => prJson({ state: "CLOSED" });
  addWatch("s1", ITEM, "pull_request", cursor());
  await pollOnce();
  assert.deepEqual(listWatches(), []);
  addWatch("s1", ITEM, "pull_request", cursor()); // reopened, watched again, closed again
  await pollOnce();
  assert.equal(world.delivered.length, 2);
  assert.notEqual(world.delivered[1].entryId, world.delivered[0].entryId);
});

test("an old final or non-final delivery cannot mutate a re-registered watch", async (t) => {
  for (const final of [false, true]) {
    let startDelivery;
    const delivering = new Promise((resolve) => { startDelivery = resolve; });
    let finishDelivery;
    const blocked = new Promise((resolve) => { finishDelivery = resolve; });
    const world = harness(t, async () => {
      startDelivery();
      await blocked;
      return "ok";
    });
    const baseline = cursor();
    if (final) world.answer = () => prJson({ state: "CLOSED" });
    addWatch("s1", ITEM, "pull_request", baseline);
    const poll = pollOnce();
    await delivering;
    const oldWatch = listWatches()[0];
    assert.equal(removeWatch("s1", ITEM), true);
    addWatch("s1", ITEM, "pull_request", baseline);
    const newWatch = listWatches()[0];
    assert.notEqual(newWatch.registrationId, oldWatch.registrationId);
    finishDelivery();
    await poll;
    assert.equal(listWatches().length, 1);
    assert.equal(listWatches()[0].registrationId, newWatch.registrationId);
    assert.deepEqual(listWatches()[0].cursor, baseline);
    assert.equal(getPending("s1", ITEM, newWatch.registrationId), null);
  }
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
  world.failure = new GhError("spawn gh ENOENT", "", "ENOENT");
  await pollOnce();
  await pollOnce();
  assert.deepEqual(world.delivered.map((d) => d.message), Array(2).fill(`GitHub update (omp-web): watching paused: \`gh\` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run \`gh auth login\` there.`));
  world.failure = undefined;
  world.delivered.length = 0;
  await pollOnce();
  await pollOnce();
  const resumed = world.delivered.filter((d) => d.message === "GitHub update (omp-web): watching resumed");
  assert.deepEqual(resumed.map((d) => d.sessionId).sort(), ["s1", "s2"]);
});

test("a lagging watch still receives the events between its cursor and a newer one", async (t) => {
  const world = harness(t);
  // R3 is the newest review; older ones sit on earlier pages.
  const pages = { null: [["PRR_3"], "c1"], c1: [["PRR_2"], "c2"], c2: [["PRR_1"], null] };
  world.answer = ({ rc }) => {
    const [ids, startCursor] = pages[rc];
    return snapshotJson(ids, { hasPreviousPage: startCursor !== null, startCursor });
  };
  addWatch("lagging", ITEM, "pull_request", cursor({ reviewIds: ["PRR_1"] }));
  addWatch("current", ITEM, "pull_request", cursor({ reviewIds: ["PRR_1", "PRR_2", "PRR_3"] }));
  await pollOnce();
  assert.deepEqual(world.delivered.map((d) => d.sessionId), ["lagging"]);
  assert.match(world.delivered[0].message, /PRR_2/);
  assert.match(world.delivered[0].message, /PRR_3/);
});

test("a failing watch read does not stop the next cycle", async (t) => {
  const world = harness(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  const bad = new Database(join(dir, "omp-web", "github-watches.sqlite"));
  bad.exec("UPDATE watches SET cursor_json = '{'");
  bad.close(true);
  const warn = console.warn;
  console.warn = () => undefined;
  t.after(() => { console.warn = warn; });
  const next = () => world.timers.find((timer) => timer.ms === 60_000);
  const first = next();
  assert.ok(first, "the next cycle is scheduled before the watches are read");
  world.timers.length = 0;
  assert.doesNotThrow(() => first.fn()); // as the timer fires it
  assert.ok(next(), "a cycle that failed still schedules the following one");
});

test("the agent's own comment is never delivered, even when a poll lands while it posts", async (t) => {
  const world = harness(t);
  let onGithub = false;
  world.answer = () => prJson({ comments: { pageInfo: emptyPage, nodes: onGithub ? [node("IC_posted")] : [] } });
  addWatch("s1", ITEM, "pull_request", cursor());
  const run = async (args) => {
    if (args[1] === "user") return "alice";
    onGithub = true; // GitHub has the comment before the POST answers
    await pollOnce();
    return JSON.stringify({ node_id: "IC_posted", html_url: `${URL}#issuecomment-1` });
  };
  const ctx = { sourceSessionId: "s1", sourceRequestId: "r1", sourceCwd: "/tmp", sourceHostId: "local", enabled: true, guard: undefined, confirm: async () => true };
  await executeGithubTool("github_comment", { target: ITEM, body: "hi" }, { ...createGithubToolOps(() => []), run }, ctx);
  await pollOnce();
  assert.deepEqual(world.delivered, []);
  assert.deepEqual(listWatches()[0].cursor.commentIds, ["IC_posted"]);
});

test("a pending review and its pending inline comments wait for the submission, which is delivered once", async (t) => {
  const world = harness(t);
  let state = "PENDING";
  world.answer = () => prJson({
    reviews: { pageInfo: emptyPage, nodes: [{ ...node("PRR_draft"), state, comments: { totalCount: 1 } }] },
    reviewThreads: {
      pageInfo: emptyPage,
      nodes: [{ id: "PRRT_1", path: "src/a.ts", line: 3, comments: { nodes: [{ ...node("PRRC_draft"), state: state === "PENDING" ? "PENDING" : "SUBMITTED" }] } }],
    },
  });
  addWatch("s1", ITEM, "pull_request", cursor());
  await pollOnce();
  assert.deepEqual(world.delivered, []);
  state = "CHANGES_REQUESTED";
  await pollOnce();
  await pollOnce();
  assert.equal(world.delivered.length, 1);
  assert.match(world.delivered[0].message, /review \(changes requested, 1 inline comment\) by alice .*id PRR_draft/);
  assert.match(world.delivered[0].message, /inline review comment at line 3 .*id PRRC_draft/);
});

test("past 40 items the cycle stretches to 1.5 s per item and spreads the polls across it", async (t) => {
  const world = harness(t);
  const fire = (ms) => {
    const timer = world.timers.find((x) => x.ms === ms);
    assert.ok(timer, `a cycle scheduled in ${ms} ms`);
    world.timers.length = 0;
    timer.fn();
  };
  for (let n = 1; n <= 40; n++) addWatch(`s${n}`, `acme/widgets#${n}`, "pull_request", cursor());
  fire(60_000);
  assert.deepEqual(world.timers.map((x) => x.ms), [60_000, ...Array.from({ length: 40 }, (_, i) => i * 1500)]);
  for (let n = 41; n <= 50; n++) addWatch(`s${n}`, `acme/widgets#${n}`, "pull_request", cursor());
  fire(60_000);
  assert.deepEqual(world.timers.map((x) => x.ms), [75_000, ...Array.from({ length: 50 }, (_, i) => i * 1500)]);
});

test("a low GraphQL budget skips polls until it resets, logged once", async (t) => {
  const world = harness(t);
  const warned = captureWarnings(t);
  let remaining = 150;
  const resetAt = new Date(world.now + 600_000).toISOString();
  world.answer = () => prJson({ reviews: { pageInfo: emptyPage, nodes: [{ ...node("PRR_1"), state: "APPROVED", comments: { totalCount: 0 } }] } }, { rateLimit: { remaining, resetAt } });
  addWatch("s1", ITEM, "pull_request", cursor());
  addWatch("s2", "acme/widgets#8", "pull_request", cursor());
  await pollOnce();
  assert.equal(world.runs, 1, "the second item waits");
  assert.equal(world.delivered.length, 1, "what the last poll fetched is still delivered");
  await pollOnce();
  assert.equal(world.runs, 1);
  assert.deepEqual(warned.filter((line) => line.includes("GraphQL budget")), [`[omp-web] github watcher: GraphQL budget low (150 points left); polling paused until ${resetAt}`]);
  remaining = 4000;
  world.now += 600_000;
  await pollOnce();
  assert.equal(world.runs, 3);
  assert.equal(world.delivered.length, 2);
});

test("an outbox refusal other than 404, 429 or 5xx drops that update with one log line, and the watch goes on", async (t) => {
  const world = harness(t, (_s, n) => (n <= 2 ? { rejected: "409 outbox_id_conflict" } : "ok"));
  const warned = captureWarnings(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  await pollOnce();
  assert.equal(getPending("s1", ITEM), null);
  assert.deepEqual(listWatches()[0].cursor.reviewIds, ["PRR_1"]);
  world.reviews.push("PRR_2");
  await pollOnce();
  world.reviews.push("PRR_3");
  await pollOnce();
  assert.equal(world.delivered.length, 3);
  assert.match(world.delivered[2].message, /PRR_3/);
  assert.doesNotMatch(world.delivered[2].message, /PRR_2/);
  assert.deepEqual(warned, [`[omp-web] github watcher: the outbox of s1 refused an update for ${ITEM} (409 outbox_id_conflict); dropped it`]);
});

test("deliveryOf: 404 is gone, 429 and 5xx retry, any other 4xx is refused with its code", async () => {
  assert.equal(await deliveryOf(Response.json({ success: true })), "ok");
  assert.equal(await deliveryOf(Response.json({ code: "not_found" }, { status: 404 })), "gone");
  assert.equal(await deliveryOf(Response.json({ code: "outbox_full" }, { status: 429 })), "retry");
  assert.equal(await deliveryOf(Response.json({}, { status: 503 })), "retry");
  assert.deepEqual(await deliveryOf(Response.json({ code: "outbox_id_conflict" }, { status: 409 })), { rejected: "409 outbox_id_conflict" });
  assert.deepEqual(await deliveryOf(new Response("nope", { status: 400 })), { rejected: "400" });
});

test("disabling Agent tools during snapshot fetch preserves the watch cursor", async (t) => {
  const world = harness(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  let snapshotStarted;
  const started = new Promise((resolve) => { snapshotStarted = resolve; });
  let finishSnapshot;
  const blocked = new Promise((resolve) => { finishSnapshot = resolve; });
  world.answer = async () => {
    snapshotStarted();
    await blocked;
    return snapshotJson(["PRR_1"]);
  };

  const poll = pollOnce();
  await started;
  saveWebServerSettings({ agentToolsEnabled: false });
  finishSnapshot();
  await poll;
  assert.equal(world.delivered.length, 0);
  assert.deepEqual(listWatches()[0].cursor, cursor());
  assert.equal(getPending("s1", ITEM), null);

  saveWebServerSettings({ agentToolsEnabled: true });
  await pollOnce();
  assert.equal(world.delivered.length, 1);
  assert.deepEqual(listWatches()[0].cursor.reviewIds, ["PRR_1"]);
});

test("large final updates pause and resume by stored batch without early close", async (t) => {
  const world = harness(t, (_sessionId, attempt) => {
    if (attempt === 1) saveWebServerSettings({ agentToolsEnabled: false });
    return "ok";
  });
  const longUrl = `https://github.com/acme/widgets/pull/7#${"x".repeat(90_000)}`;
  world.answer = () => prJson({
    state: "CLOSED",
    comments: {
      pageInfo: emptyPage,
      nodes: Array.from({ length: 100 }, (_, i) => ({ ...node(`IC_${i + 1}`), url: `${longUrl}${i}` })),
    },
  });
  const baseline = cursor();
  addWatch("s1", ITEM, "pull_request", baseline);
  await pollOnce();

  const pending = getPending("s1", ITEM, listWatches()[0].registrationId);
  assert.ok(pending.batches.length > 1);
  assert.equal(pending.batchIndex, 1);
  assert.equal(world.delivered.length, 1);
  assert.deepEqual(listWatches()[0].cursor, baseline);
  assert.equal(listWatches().length, 1, "final status waits for every batch");
  for (const { entryId, message } of world.delivered) {
    const request = { type: "outbox_add", id: entryId, scope: "S".repeat(43), mode: "prompt", message };
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= MAX_AGENT_COMMAND_REQUEST_BYTES);
  }

  saveWebServerSettings({ agentToolsEnabled: true });
  await pollOnce();
  assert.deepEqual(world.delivered.map((entry) => entry.entryId), pending.batches.map((batch) => batch.entryId));
  assert.deepEqual(listWatches(), []);
  assert.equal(getPending("s1", ITEM), null);
});

test("an unexpected 413 keeps the current batch and cursor for retry", async (t) => {
  const world = harness(t, () => ({ rejected: "413 request_too_large" }));
  const warned = captureWarnings(t);
  addWatch("s1", ITEM, "pull_request", cursor());
  await pollOnce();
  const pending = getPending("s1", ITEM);
  assert.equal(pending.batchIndex, 0);
  assert.deepEqual(listWatches()[0].cursor, cursor());

  await pollOnce();
  assert.equal(world.delivered[1].entryId, world.delivered[0].entryId);
  assert.equal(getPending("s1", ITEM).batchIndex, 0);
  assert.deepEqual(listWatches()[0].cursor, cursor());
  assert.equal(warned.length, 1);
  assert.match(warned[0], /batch retained/);
});


test("Agent tools disabled during availability check suppresses outage notifications", async (t) => {
  const world = harness(t);
  const baseline = cursor();
  addWatch("s1", ITEM, "pull_request", baseline);
  let startAuth;
  const started = new Promise((resolve) => { startAuth = resolve; });
  let finishAuth;
  const blocked = new Promise((resolve) => { finishAuth = resolve; });
  world.auth = async () => {
    startAuth();
    await blocked;
    throw new GhError("spawn gh ENOENT", "", "ENOENT");
  };

  const poll = pollOnce();
  await started;
  saveWebServerSettings({ agentToolsEnabled: false });
  finishAuth();
  await poll;
  assert.deepEqual(world.delivered, []);
  assert.deepEqual(listWatches()[0].cursor, baseline);

  saveWebServerSettings({ agentToolsEnabled: true });
  await pollOnce();
  assert.equal(world.delivered.length, 1);
  assert.match(world.delivered[0].message, /watching paused/);
});
