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
const { closeWatchStore, hasReadGrant, listWatches, postedIds } = await import("./watch-store.ts");

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

const THREAD = { path: "src/a.ts", line: 12, pullRequest: { number: 7, repository: { nameWithOwner: "acme/widgets" } } };

/** A fake `gh`: records every call and answers like GitHub would. */
function world(over = {}) {
  const w = { calls: [], state: "OPEN", loginError: undefined, thread: THREAD, ...over };
  w.run = async (args, input) => {
    w.calls.push({ args, input });
    if (args[1] === "user") {
      if (w.loginError) throw w.loginError;
      return "octocat\n";
    }
    if (args[1] === "graphql") {
      const { variables } = JSON.parse(input);
      if (variables.threadId && variables.body) return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_reply", url: `${URL}#discussion_r1` } } } });
      if (variables.threadId) return JSON.stringify({ data: { resolveReviewThread: { thread: { id: variables.threadId, isResolved: true } } } });
      if (variables.id) return JSON.stringify({ data: { node: w.thread } });
      return snapshotJson(w.state);
    }
    if (args[1] === "-X") return JSON.stringify({ node_id: "IC_posted", html_url: `${URL}#issuecomment-1` });
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
function setup(t, { writesUnasked = false, sourceHostId = "local", answers = [], ...rest } = {}) {
  closeWatchStore();
  rmSync(join(dir, "omp-web"), { recursive: true, force: true });
  saveWebServerSettings({ githubWritesUnasked: writesUnasked });
  const w = world(rest);
  const asked = [];
  const ops = { ...createGithubToolOps(() => HOSTS), run: w.run };
  const queue = [...answers];
  const ctx = (session = "s1") => ({
    sourceSessionId: session,
    sourceRequestId: "r1",
    sourceCwd: "/tmp",
    sourceHostId,
    enabled: true,
    guard: undefined,
    confirm: async (title) => { asked.push(title); return queue.length ? queue.shift() : true; },
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
  for (const replyTo of ["abc", "PRRT_", "12 3", "PRRT_x/y"]) {
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

test("a thread reply whose thread is on another pull request is refused before asking", async (t) => {
  const { w, asked, call } = setup(t, { thread: { ...THREAD, pullRequest: { number: 3, repository: { nameWithOwner: "other/repo" } } } });
  await assert.rejects(
    () => call("github_comment", { target: ITEM, body: "hi", replyTo: "PRRT_elsewhere" }),
    { message: `Review thread PRRT_elsewhere is on other/repo#3, not ${ITEM}.` },
  );
  assert.deepEqual(asked, []);
  assert.equal(writes(w).length, 0);
  assert.equal(postedIds(ITEM).size + postedIds("other/repo#3").size, 0);
});

test("a thread reply on the target posts and records under that item", async (t) => {
  const { call } = setup(t, { thread: { ...THREAD, pullRequest: { number: 7, repository: { nameWithOwner: "ACME/Widgets" } } } });
  await call("github_comment", { target: ITEM, body: "ok", replyTo: "PRRT_here" });
  assert.deepEqual([...postedIds(ITEM)], ["PRRC_reply"]);
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
