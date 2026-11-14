import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "omp-github-tools-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

// tools.ts first: it must load without agent-tools.ts having been evaluated.
const { GhError, defaultGhRunner } = await import("./gh.ts");
const { GITHUB_TOOL_DEFINITIONS, GITHUB_TOOL_NAMES, createGithubToolOps, executeGithubTool } = await import("./tools.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
const { closeWatchStore, grantRead, hasReadGrant, listWatches, postedIds } = await import("./watch-store.ts");
const { diffSnapshot } = await import("./events.ts");

test.after(() => {
  closeWatchStore();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

const ITEM = "acme/widgets#7";
const URL = "https://github.com/acme/widgets/pull/7";
const emptyPage = { hasPreviousPage: false, startCursor: null };
const snapshotJson = (state = "OPEN") =>
  JSON.stringify({
    data: {
      repository: {
        issueOrPullRequest: {
          __typename: "PullRequest",
          url: URL,
          state,
          comments: { pageInfo: emptyPage, nodes: [] },
          reviews: { pageInfo: emptyPage, nodes: [] },
          reviewThreads: { pageInfo: emptyPage, nodes: [] },
          commits: { nodes: [] },
        },
      },
    },
  });

const THREAD = { id: "PRRT_here", path: "src/a.ts", line: 12, pullRequest: { number: 7, repository: { nameWithOwner: "acme/widgets" } } };

/** A fake `gh`: records every call and answers like GitHub would. */
function world(over = {}) {
  const w = { calls: [], state: "OPEN", loginError: undefined, thread: THREAD, reviewNodeId: "PRR_agent", reviewFullDatabaseId: "4564699236", reviewDatabaseId: 4564699235, ...over };
  w.run = async (args, input) => {
    w.calls.push({ args, input });
    if (args[1] === "user") {
      if (w.loginError) throw w.loginError;
      return "octocat\n";
    }
    if (args[1] === "graphql") {
      const { query, variables } = JSON.parse(input);
      if (variables.threadId && variables.body) {
        if (w.postError) throw w.postError;
        assert.match(query, /pullRequestReview\s*\{\s*id\s+fullDatabaseId\s*\}/);
        return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_reply", url: `${URL}#discussion_r1`, pullRequestReview: { id: w.reviewNodeId, fullDatabaseId: w.reviewFullDatabaseId } } } } });
      }
      if (variables.threadId) return JSON.stringify({ data: { resolveReviewThread: { thread: { id: variables.threadId, isResolved: true } } } });
      if (variables.id?.startsWith("PRRC_")) {
        const root = variables.id === "PRRC_root";
        return JSON.stringify({
          data: {
            node: w.thread
              ? { id: variables.id, fullDatabaseId: root ? "4564699235" : "4564699236", pullRequest: w.thread.pullRequest, replyTo: root ? null : { id: "PRRC_root" } }
              : null,
          },
        });
      }
      if (variables.id) return JSON.stringify({ data: { node: w.thread } });
      if (w.snapshot) return await w.snapshot();
      return snapshotJson(w.state);
    }
    if (args[1] === "-X") {
      if (w.postError) throw w.postError;
      if (args[3]?.includes("/pulls/")) {
        return JSON.stringify({ node_id: "PRRC_rest_posted", html_url: `${URL}#discussion_r2`, pull_request_review_id: w.reviewDatabaseId });
      }
      return JSON.stringify({ node_id: "IC_posted", html_url: `${URL}#issuecomment-1` });
    }
    if (args[1].includes("/comments?")) return JSON.stringify(w.listed ?? []);
    return JSON.stringify({ title: "T", state: "open", user: { login: "alice" }, body: "hello", labels: [], html_url: URL, author_association: "MEMBER" });
  };
  return w;
}
const posts = (w) => w.calls.filter((c) => c.args[1] === "-X");
/** Calls that change GitHub: REST posts and GraphQL mutations. */
const writes = (w) => w.calls.filter((c) => c.args[1] === "-X" || (c.args[1] === "graphql" && JSON.parse(c.input).query.startsWith("mutation")));

const HOSTS = [
  { id: "local", label: "This machine", online: true, allowAgentStart: true },
  { id: "h-build", label: "build-box", online: true, allowAgentStart: false },
  { id: "h-ci", label: "ci-box", online: true, allowAgentStart: true },
];

/** The real ops factory (settings and host rule) with the fake `gh` in place of the process. */
function setup(t, { writesUnasked = false, sourceHostId = "local", answers = [], signal, confirm, getSessionId, ...rest } = {}) {
  closeWatchStore();
  rmSync(join(dir, "omp-web"), { recursive: true, force: true });
  saveWebServerSettings({ githubWritesUnasked: writesUnasked });
  const w = world(rest);
  const asked = [];
  const ops = { ...createGithubToolOps(() => HOSTS), run: w.run };
  const queue = [...answers];
  const ctx = (session = "s1") => ({
    get sourceSessionId() { return getSessionId ? getSessionId(session) : session; },
    sourceRequestId: "r1",
    sourceCwd: "/tmp",
    sourceHostId,
    enabled: true,
    guard: undefined,
    confirm: async (title) => {
      asked.push(title);
      const answer = queue.length ? queue.shift() : true;
      return confirm ? confirm(title, answer) : answer;
    },
    signal,
  });
  t.after(closeWatchStore);
  const call = (name, args, session) => executeGithubTool(name, args, ops, ctx(session));
  return { w, asked, call };
}

test("every GitHub tool description starts with the gh requirement", () => {
  assert.deepEqual([...GITHUB_TOOL_NAMES].sort(), ["github_comment", "github_read", "github_resolve_thread", "unwatch_github", "watch_github"]);
  assert.deepEqual(GITHUB_TOOL_DEFINITIONS.map((d) => d.name).sort(), [...GITHUB_TOOL_NAMES].sort());
  for (const def of GITHUB_TOOL_DEFINITIONS) {
    assert.ok(def.description.startsWith("Requires the GitHub CLI (`gh`) on the PATH of the omp-web server machine, logged in (`gh auth login`); acts as that account."), def.name);
  }
  assert.match(GITHUB_TOOL_DEFINITIONS.find((d) => d.name === "github_read").description, /untrusted/);
});

test("a missing gh fails the call with the install message", async (t) => {
  const { call } = setup(t, { loginError: new GhError("spawn gh ENOENT", "", "ENOENT") });
  await assert.rejects(
    () => call("github_read", { target: ITEM }),
    { message: "`gh` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run `gh auth login` there." },
  );
});

test("a logged-out gh fails the call with the login message", async (t) => {
  const { call } = setup(t, { loginError: new GhError("x", "gh auth login required", 1) });
  await assert.rejects(() => call("watch_github", { target: ITEM }), { message: "`gh` is not logged in on the omp-web server machine. Ask the user to run `gh auth login` there." });
});

test("a remote session asks once per repository and remembers the answer", async (t) => {
  const { w, asked, call } = setup(t, { sourceHostId: "h-build" });
  const read = await call("github_read", { target: ITEM });
  assert.equal(read.summary.title, "T");
  assert.deepEqual(asked, ["Let this session on build-box read acme/widgets through the server's GitHub login?"]);
  assert.equal(hasReadGrant("s1", "acme/widgets"), true);
  await call("github_read", { target: "https://github.com/ACME/Widgets/issues/9" }); // same repo, any case
  assert.equal(asked.length, 1);
  await call("github_read", { target: "acme/other#1" });
  assert.equal(asked.length, 2);
  await call("github_read", { target: ITEM }, "s2"); // another session asks again
  assert.equal(asked.length, 3);
  assert.ok(w.calls.length > 0);
});

test("a declined read grants nothing and reads nothing", async (t) => {
  const { w, call } = setup(t, { sourceHostId: "h-build", answers: [false] });
  await assert.rejects(() => call("github_read", { target: ITEM }), { message: "The user declined GitHub access for this session." });
  assert.equal(hasReadGrant("s1", "acme/widgets"), false);
  assert.equal(w.calls.filter((c) => c.args[1] !== "user").length, 0);
});

test("a remote read canceled during confirmation grants no access", async (t) => {
  const cancel = new AbortController();
  const { w, asked, call } = setup(t, {
    sourceHostId: "h-build",
    signal: cancel.signal,
    confirm: async (_title, answer) => {
      cancel.abort();
      return answer;
    },
  });
  await assert.rejects(
    () => call("github_read", { target: ITEM }),
    { message: "The tool call was cancelled before GitHub access was granted." },
  );
  assert.equal(hasReadGrant("s1", "acme/widgets"), false);
  assert.deepEqual(asked, ["Let this session on build-box read acme/widgets through the server's GitHub login?"]);
  assert.equal(w.calls.filter((c) => c.args[1] !== "user").length, 0);
});


test("a call cancelled before its write posts nothing, even with writes unasked", async (t) => {
  const cancel = new AbortController();
  const { w, call } = setup(t, { writesUnasked: true, signal: cancel.signal });
  cancel.abort(); // host_tool_cancel landed while the call checked gh or waited for a confirm
  const cancelled = { message: "The tool call was cancelled; nothing was posted to GitHub." };
  await assert.rejects(() => call("github_comment", { target: ITEM, body: "hi" }), cancelled);
  await assert.rejects(() => call("github_resolve_thread", { threadId: "PRRT_abc" }), cancelled);
  assert.deepEqual(writes(w), []);
});

test("a host with allowAgentStart reads without asking", async (t) => {
  const { asked, call } = setup(t, { sourceHostId: "h-ci" });
  await call("github_read", { target: ITEM });
  assert.deepEqual(asked, []);
  const local = setup(t, { sourceHostId: "local" });
  await local.call("github_read", { target: ITEM });
  assert.deepEqual(local.asked, []);
});

test("a write asks every time unless writes are unasked", async (t) => {
  const body = "line1\nline2\nline3\nline4";
  const { w, asked, call } = setup(t);
  const posted = await call("github_comment", { target: ITEM, body });
  assert.deepEqual(posted, { id: "IC_posted", url: `${URL}#issuecomment-1` });
  await call("github_comment", { target: ITEM, body: "again" });
  assert.deepEqual(asked, [`Post on ${ITEM} as the server's GitHub account?\nline1\nline2\nline3\n… (+6 more characters)`, `Post on ${ITEM} as the server's GitHub account?\nagain`]);
  assert.equal(posts(w).length, 2);
  await call("github_resolve_thread", { threadId: "PRRT_abc" });
  assert.equal(asked[2], `Resolve review thread PRRT_abc on ${ITEM} src/a.ts:12 as the server's GitHub account?`);

  const free = setup(t, { writesUnasked: true });
  await free.call("github_comment", { target: ITEM, body: "quiet" });
  await free.call("github_resolve_thread", { threadId: "PRRT_abc" });
  assert.deepEqual(free.asked, []);
});

test("a declined write posts nothing", async (t) => {
  const { w, call } = setup(t, { answers: [false, false] });
  await assert.rejects(() => call("github_comment", { target: ITEM, body: "hi" }), { message: "The user declined to post on GitHub." });
  await assert.rejects(() => call("github_resolve_thread", { threadId: "PRRT_abc" }), { message: "The user declined to post on GitHub." });
  assert.equal(writes(w).length, 0);
  assert.equal(postedIds(ITEM).size, 0);
});

test("github_comment records its comment so the watcher skips it", async (t) => {
  const { call } = setup(t);
  await call("github_comment", { target: ITEM, body: "hi" });
  assert.deepEqual([...postedIds(ITEM)], ["IC_posted"]);
});

test("an uncertain write does not claim an identical human comment as agent-authored", async (t) => {
  const { w, call } = setup(t, {
    postError: new GhError("timed out", "", null),
    listed: [{ node_id: "IC_human", html_url: `${URL}#issuecomment-2`, body: "Done", user: { login: "octocat" } }],
  });
  await assert.rejects(() => call("github_comment", { target: ITEM, body: "Done" }), { message: "timed out" });
  assert.deepEqual([...postedIds(ITEM)], []);
  assert.equal(w.calls.some((c) => c.args[1]?.includes("/comments?since=")), false);
});

test("github_comment refuses an oversized body before asking", async (t) => {
  const { asked, w, call } = setup(t);
  await assert.rejects(() => call("github_comment", { target: ITEM, body: "x".repeat(65_537) }), /65536/);
  await call("github_comment", { target: ITEM, body: "x".repeat(65_536) });
  assert.equal(asked.length, 1);
  assert.equal(posts(w).length, 1);
});

test("watch_github is idempotent and refuses the 21st", async (t) => {
  const { call } = setup(t);
  const first = await call("watch_github", { target: ITEM });
  assert.deepEqual(first, { watching: true, target: ITEM, kind: "pull_request", state: "open" });
  assert.deepEqual(await call("watch_github", { target: ITEM }), first);
  assert.equal(listWatches().length, 1);
  for (let n = 1; n < 20; n++) await call("watch_github", { target: `acme/widgets#${100 + n}` });
  assert.equal(listWatches().length, 20);
  await assert.rejects(() => call("watch_github", { target: "acme/widgets#999" }), /20/);
  assert.equal(listWatches().length, 20);
  assert.deepEqual(await call("unwatch_github", { target: ITEM }), { watching: false, target: ITEM });
  assert.deepEqual(await call("unwatch_github", { target: ITEM }), { watching: false, target: ITEM });
  assert.equal(listWatches().length, 19);
});

test("watch_github on a finished item stores no watch", async (t) => {
  const { call } = setup(t, { state: "MERGED" });
  assert.deepEqual(await call("watch_github", { target: ITEM }), { watching: false, target: ITEM, kind: "pull_request", state: "merged" });
  assert.equal(listWatches().length, 0);
});

test("watch_github registers under the current session after a move during snapshot fetch", async (t) => {
  let currentSession = "session-a";
  let startSnapshot;
  let finishSnapshot;
  const snapshotStarted = new Promise((resolve) => { startSnapshot = resolve; });
  const waitingSnapshot = new Promise((resolve) => { finishSnapshot = resolve; });
  const { call } = setup(t, {
    getSessionId: () => currentSession,
    snapshot: () => {
      startSnapshot();
      return waitingSnapshot;
    },
  });

  const watching = call("watch_github", { target: ITEM });
  await snapshotStarted;
  currentSession = "session-b";
  finishSnapshot(snapshotJson());
  await watching;
  assert.deepEqual(listWatches().map((watch) => watch.sessionId), ["session-b"]);

  await call("unwatch_github", { target: ITEM });
  assert.deepEqual(listWatches(), []);
});

test("watch_github cancelled during snapshot never registers a watch", async (t) => {
  const cancel = new AbortController();
  let startSnapshot;
  let finishSnapshot;
  const snapshotStarted = new Promise((resolve) => { startSnapshot = resolve; });
  const waitingSnapshot = new Promise((resolve) => { finishSnapshot = resolve; });
  const { w, call } = setup(t, {
    signal: cancel.signal,
    snapshot: () => {
      startSnapshot();
      return waitingSnapshot;
    },
  });

  const pending = call("watch_github", { target: ITEM });
  await snapshotStarted;
  cancel.abort();
  finishSnapshot(snapshotJson());
  await assert.rejects(pending, { message: "The tool call was cancelled; no watch was registered." });
  assert.equal(listWatches().length, 0);
  assert.equal(w.calls.filter((c) => c.args[1] === "graphql").length, 1);
});


test("arguments are validated before gh is touched", async (t) => {
  const { w, call } = setup(t);
  await assert.rejects(() => call("github_read", { target: "nope" }), /target/);
  await assert.rejects(() => call("github_read", { target: ITEM, include: ["bogus"] }), /include/);
  await assert.rejects(() => call("github_read", { target: ITEM, ids: Array(101).fill("a") }), /ids/);
  await assert.rejects(() => call("github_comment", { target: ITEM }), /body/);
  await assert.rejects(() => call("github_resolve_thread", { threadId: "x y" }), /threadId/);
  assert.equal(w.calls.length, 0);
});

test("a write confirm shows what was cut: lines past the third and text past 200 characters", async (t) => {
  const { asked, call } = setup(t, { answers: [true, true, true] });
  const title = `Post on ${ITEM} as the server's GitHub account?`;
  await call("github_comment", { target: ITEM, body: "x".repeat(250) });
  await call("github_comment", { target: ITEM, body: "a\nb\nc" }); // exactly three short lines: nothing cut
  await call("github_comment", { target: ITEM, body: `${"y".repeat(200)}\nz` });
  assert.deepEqual(asked, [`${title}\n${"x".repeat(200)}\n… (+50 more characters)`, `${title}\na\nb\nc`, `${title}\n${"y".repeat(200)}\nz`]);
});

test("a thread reply's confirm names the thread", async (t) => {
  const { w, asked, call } = setup(t);
  await call("github_comment", { target: ITEM, body: "ok", replyTo: "PRRT_kwDOabc" });
  assert.deepEqual(asked, [`Reply in review thread PRRT_kwDOabc on ${ITEM} as the server's GitHub account?\nok`]);
  assert.equal(posts(w).length, 0, "a thread reply goes through GraphQL, not the REST post");
  await call("github_comment", { target: ITEM, body: "ok", replyTo: "12345" });
  assert.equal(posts(w).length, 1);
  assert.equal(asked[1], `Reply in review thread 12345 on ${ITEM} as the server's GitHub account?\nok`);
});

test("an invalid replyTo throws before any confirm and before any gh call", async (t) => {
  const { w, asked, call } = setup(t);
  for (const replyTo of ["abc", "PRRT_", "PRRC_", "12 3", "PRRT_x/y"]) {
    await assert.rejects(() => call("github_comment", { target: ITEM, body: "hi", replyTo }), { message: "replyTo must be a review comment id or a review thread id." }, replyTo);
  }
  assert.deepEqual(asked, []);
  assert.equal(w.calls.length, 0);
});

test("createGithubToolOps reads githubWritesUnasked and the calling host's allowAgentStart", async (t) => {
  const ops = createGithubToolOps(() => HOSTS);
  assert.equal(ops.run, defaultGhRunner);
  assert.deepEqual(ops.listHosts(), HOSTS);

  const asking = setup(t, { writesUnasked: false });
  await asking.call("github_comment", { target: ITEM, body: "hi" });
  assert.equal(asking.asked.length, 1, "githubWritesUnasked off: a write asks");
  const quiet = setup(t, { writesUnasked: true });
  await quiet.call("github_comment", { target: ITEM, body: "hi" });
  assert.deepEqual(quiet.asked, [], "githubWritesUnasked on: no ask");

  const closed = setup(t, { sourceHostId: "h-build" });
  await closed.call("github_read", { target: ITEM });
  assert.equal(closed.asked.length, 1, "a remote host without allowAgentStart asks");
  const open = setup(t, { sourceHostId: "h-ci" });
  await open.call("github_read", { target: ITEM });
  assert.deepEqual(open.asked, [], "a remote host with allowAgentStart does not");
  const unknown = setup(t, { sourceHostId: "h-gone" });
  await unknown.call("github_read", { target: ITEM });
  assert.deepEqual(unknown.asked, ["Let this session on h-gone read acme/widgets through the server's GitHub login?"]);
});

test("a review-comment reply mismatch does not disclose a private repository or pull request", async (t) => {
  const { w, asked, call } = setup(t, { thread: { ...THREAD, pullRequest: { number: 3, repository: { nameWithOwner: "other/repo" } } } });
  await assert.rejects(
    () => call("github_comment", { target: ITEM, body: "hi", replyTo: "PRRC_elsewhere" }),
    (error) => {
      assert.equal(error.message, "The reply target does not match the requested pull request.");
      assert.equal(error.message.includes("other/repo"), false);
      assert.equal(error.message.includes("#3"), false);
      return true;
    },
  );
  assert.deepEqual(asked, []);
  assert.equal(writes(w).length, 0);
  assert.equal(postedIds(ITEM).size + postedIds("other/repo#3").size, 0);
});

test("a remote PRRT mismatch hides the private target and skips confirmation and posting", async (t) => {
  const { w, asked, call } = setup(t, {
    sourceHostId: "h-build",
    thread: { ...THREAD, pullRequest: { number: 3, repository: { nameWithOwner: "private/repo" } } },
  });
  grantRead("s1", "acme/widgets");

  await assert.rejects(
    () => call("github_comment", { target: ITEM, body: "hi", replyTo: "PRRT_private" }),
    (error) => {
      assert.equal(error.message, "The reply target does not match the requested pull request.");
      assert.equal(error.message.includes("private/repo"), false);
      assert.equal(error.message.includes("#3"), false);
      return true;
    },
  );
  assert.deepEqual(asked, []);
  assert.equal(writes(w).length, 0);
  assert.equal(posts(w).length, 0);
  assert.equal(postedIds(ITEM).size, 0);
});

test("a thread reply on the target posts and records under that item", async (t) => {
  const { call } = setup(t, { thread: { ...THREAD, pullRequest: { number: 7, repository: { nameWithOwner: "ACME/Widgets" } } } });
  await call("github_comment", { target: ITEM, body: "ok", replyTo: "PRRT_here" });
  assert.deepEqual([...postedIds(ITEM)].sort(), ["PRR_agent", "PRRC_reply", "review:4564699236"].sort());
});

test("an agent reply suppresses its comment and review but leaves a same-account human review visible", async (t) => {
  const { call } = setup(t);
  const reply = await call("github_comment", { target: ITEM, body: "ok", replyTo: "PRRT_here" });
  assert.deepEqual(reply, { id: "PRRC_reply", url: `${URL}#discussion_r1` });

  const snapshot = {
    kind: "pull_request",
    url: URL,
    state: "open",
    comments: [],
    reviews: [
      { id: "PRR_agent", databaseId: "4564699236", url: "agent-review", author: { login: "octocat", bot: false, association: "NONE" }, state: "COMMENTED", commentCount: 1 },
      { id: "PRR_human", databaseId: "4564699237", url: "human-review", author: { login: "octocat", bot: false, association: "MEMBER" }, state: "COMMENTED", commentCount: 0 },
    ],
    threadComments: [
      { id: "PRRC_reply", url: `${URL}#discussion_r1`, author: { login: "octocat", bot: false, association: "NONE" }, threadId: "PRRT_here", path: "src/a.ts", line: 12 },
    ],
  };
  const cursor = { commentIds: [], reviewIds: [], threadCommentIds: [], reportedHeads: [], final: false };
  const { events } = diffSnapshot(cursor, snapshot, postedIds(ITEM));
  assert.deepEqual(events.map((event) => [event.kind, event.id]), [["review", "PRR_human"]]);
});


test("a review-comment node id replies through its verified root comment", async (t) => {
  const { w, call } = setup(t);
  await call("github_comment", { target: ITEM, body: "ok", replyTo: "PRRC_original" });

  const lookup = w.calls.find((c) => c.args[1] === "graphql" && JSON.parse(c.input).variables.id === "PRRC_original");
  const rootLookup = w.calls.find((c) => c.args[1] === "graphql" && JSON.parse(c.input).variables.id === "PRRC_root");
  assert.ok(lookup);
  assert.ok(rootLookup);
  const reply = posts(w)[0];
  assert.ok(reply.args.includes("repos/acme/widgets/pulls/7/comments/4564699235/replies"));
  assert.equal(JSON.parse(reply.input).body, "ok");
  assert.deepEqual([...postedIds(ITEM)].sort(), ["PRRC_rest_posted", "review:4564699235"].sort());
});

test("a PRRC reply without a review ID keeps the known comment recorded", async (t) => {
  const { w, call } = setup(t, { reviewDatabaseId: null });
  const result = await call("github_comment", { target: ITEM, body: "ok", replyTo: "PRRC_original" });
  assert.deepEqual(result, { id: "PRRC_rest_posted", url: `${URL}#discussion_r2` });
  assert.deepEqual([...postedIds(ITEM)], ["PRRC_rest_posted"]);
  assert.equal(posts(w).length, 1);
});

test("a remote session's comment needs the target repo's read grant, asked before the write confirm", async (t) => {
  const { w, asked, call } = setup(t, { sourceHostId: "h-build", answers: [false] });
  await assert.rejects(() => call("github_comment", { target: ITEM, body: "hi" }), { message: "The user declined GitHub access for this session." });
  assert.equal(writes(w).length, 0);
  await call("github_comment", { target: ITEM, body: "hi" });
  await call("github_comment", { target: ITEM, body: "again" });
  assert.deepEqual(asked, [
    "Let this session on build-box read acme/widgets through the server's GitHub login?",
    "Let this session on build-box read acme/widgets through the server's GitHub login?",
    `Post on ${ITEM} as the server's GitHub account?\nhi`,
    `Post on ${ITEM} as the server's GitHub account?\nagain`,
  ]);
  assert.equal(hasReadGrant("s1", "acme/widgets"), true);
  assert.equal(posts(w).length, 2);
});

test("resolving a thread names its pull request and line, and a remote session needs that repo's read grant", async (t) => {
  const { w, asked, call } = setup(t, { sourceHostId: "h-build", answers: [false], thread: { ...THREAD, line: null, pullRequest: { number: 3, repository: { nameWithOwner: "other/repo" } } } });
  await assert.rejects(() => call("github_resolve_thread", { threadId: "PRRT_x" }), { message: "The user declined GitHub access for this session." });
  assert.deepEqual(asked, ["Let this session on build-box read other/repo through the server's GitHub login?"]);
  await call("github_resolve_thread", { threadId: "PRRT_x" });
  assert.deepEqual(asked.slice(1), [
    "Let this session on build-box read other/repo through the server's GitHub login?",
    "Resolve review thread PRRT_x on other/repo#3 src/a.ts as the server's GitHub account?",
  ]);
  assert.equal(writes(w).length, 1);
  const missing = setup(t, { thread: null });
  await assert.rejects(() => missing.call("github_resolve_thread", { threadId: "PRRT_gone" }), { message: "Review thread PRRT_gone was not found." });
  assert.deepEqual(missing.asked, []);
});
