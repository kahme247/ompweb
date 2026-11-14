import assert from "node:assert/strict";
import test from "node:test";

const { fetchReviewComment, fetchSnapshot, postComment, readItem, resolveThread } = await import("./api.ts");

const TARGET = { owner: "acme", repo: "widgets", number: 7 };
const DIFF_MARKER = "…[diff truncated at 1 MiB]";

const graphql = (data) => JSON.stringify({ data });
const user = (login, type = "User") => ({ login, __typename: type });
const comment = (id, login = "alice") => ({ id, url: `https://github.com/acme/widgets/pull/7#${id}`, author: user(login), authorAssociation: "MEMBER", body: "SECRET-BODY" });
const emptyPage = { hasPreviousPage: false, startCursor: null };
const emptyNextPage = { hasNextPage: false, endCursor: null };

function prFixture() {
  return {
    __typename: "PullRequest",
    url: "https://github.com/acme/widgets/pull/7",
    state: "OPEN",
    title: "SECRET-TITLE",
    headRefName: "SECRET-BRANCH",
    comments: { pageInfo: emptyPage, nodes: [comment("IC_1")] },
    reviews: {
      pageInfo: emptyPage,
      nodes: [{ ...comment("PRR_1", "robo"), author: user("robo", "Bot"), fullDatabaseId: "5893030645", state: "CHANGES_REQUESTED", comments: { totalCount: 2 } }],
    },
    reviewThreads: {
      pageInfo: emptyPage,
      nodes: [{ id: "PRRT_1", path: "src/a.ts", line: 12, comments: { pageInfo: emptyNextPage, nodes: [comment("PRRC_1"), { ...comment("PRRC_2"), author: null }] } }],
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: "abc123",
            statusCheckRollup: {
              id: "SCR_1",
              contexts: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { __typename: "CheckRun", name: "build", conclusion: "FAILURE", status: "COMPLETED" },
                  { __typename: "CheckRun", name: "lint", conclusion: null, status: "IN_PROGRESS" },
                  { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
                ],
              },
            },
          },
        },
      ],
    },
  };
}

const wrap = (node) => graphql({ repository: { issueOrPullRequest: node } });

test("fetchSnapshot maps a pull request with reviews, threads and a check rollup, without any body text", async () => {
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    return wrap(prFixture());
  };
  const snapshot = await fetchSnapshot(run, TARGET);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ["api", "graphql"]);
  assert.match(JSON.parse(calls[0].input).query, /\bfullDatabaseId\b/);
  assert.equal(snapshot.kind, "pull_request");
  assert.equal(snapshot.state, "open");
  assert.deepEqual(snapshot.comments, [
    { id: "IC_1", url: "https://github.com/acme/widgets/pull/7#IC_1", author: { login: "alice", bot: false, association: "MEMBER" } },
  ]);
  assert.equal(snapshot.reviews[0].state, "CHANGES_REQUESTED");
  assert.equal(snapshot.reviews[0].commentCount, 2);
  assert.equal(snapshot.reviews[0].databaseId, "5893030645");
  assert.deepEqual(snapshot.reviews[0].author, { login: "robo", bot: true, association: "MEMBER" });
  assert.equal(snapshot.threadComments.length, 2);
  assert.equal(snapshot.threadComments[0].threadId, "PRRT_1");
  assert.equal(snapshot.threadComments[0].path, "src/a.ts");
  assert.equal(snapshot.threadComments[0].line, 12);
  assert.equal(snapshot.threadComments[1].author.login, "ghost");
  assert.equal(snapshot.head.sha, "abc123");
  assert.deepEqual(snapshot.head.checks, [
    { name: "build", conclusion: "failure", status: "completed" },
    { name: "lint", conclusion: null, status: "in_progress" },
    { name: "ci/legacy", conclusion: "success", status: "completed" },
  ]);

  const text = JSON.stringify(snapshot);
  for (const secret of ["SECRET-BODY", "SECRET-TITLE", "SECRET-BRANCH"]) assert.ok(!text.includes(secret), secret);
});

test("fetchSnapshot reads an issue and its closed reason", async () => {
  const issue = (state, stateReason) => ({ __typename: "Issue", url: "https://github.com/acme/widgets/issues/7", state, stateReason, title: "SECRET-TITLE", comments: { pageInfo: emptyPage, nodes: [comment("IC_9")] } });
  const snapshotOf = (node) => fetchSnapshot(async () => wrap(node), TARGET);

  const closed = await snapshotOf(issue("CLOSED", "NOT_PLANNED"));
  assert.equal(closed.kind, "issue");
  assert.equal(closed.state, "closed");
  assert.equal(closed.closedReason, "not_planned");
  assert.equal(closed.head, undefined);
  assert.deepEqual(closed.reviews, []);

  const open = await snapshotOf(issue("OPEN", null));
  assert.equal(open.state, "open");
  assert.equal(open.closedReason, undefined);

  const merged = await snapshotOf({ ...prFixture(), state: "MERGED" });
  assert.equal(merged.state, "merged");
});

test("fetchSnapshot pages every comment inside a long review thread", async () => {
  const comments = Array.from({ length: 120 }, (_, i) => comment(`PRRC_${i}`));
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    const { query, variables } = JSON.parse(input);
    if (query.includes("... on PullRequestReviewThread")) {
      assert.equal(variables.id, "PRRT_1");
      assert.equal(variables.after, "thread-comments-100");
      return graphql({
        node: {
          comments: {
            pageInfo: emptyNextPage,
            nodes: comments.slice(100),
          },
        },
      });
    }
    return wrap({
      ...prFixture(),
      reviewThreads: {
        pageInfo: emptyPage,
        nodes: [{
          id: "PRRT_1",
          path: "src/a.ts",
          line: 12,
          comments: {
            pageInfo: { hasNextPage: true, endCursor: "thread-comments-100" },
            nodes: comments.slice(0, 100),
          },
        }],
      },
    });
  };

  const snapshot = await fetchSnapshot(run, TARGET);
  assert.deepEqual(snapshot.threadComments.map((c) => c.id), comments.map((c) => c.id));
  assert.equal(calls.length, 2);
});


test("fetchSnapshot pages past 100 comments", async () => {
  const ids = (from, to) => Array.from({ length: to - from }, (_, i) => `IC_${from + i}`);
  const make = () => async (_args, input) => {
    const vars = JSON.parse(input).variables;
    const base = { __typename: "Issue", url: "u", state: "OPEN", stateReason: null };
    if (vars.cc === "cursor-1") {
      assert.equal(vars.wr, false);
      return wrap({ ...base, comments: { pageInfo: emptyPage, nodes: ids(0, 20).map((id) => comment(id)) } });
    }
    return wrap({ ...base, comments: { pageInfo: { hasPreviousPage: true, startCursor: "cursor-1" }, nodes: ids(20, 120).map((id) => comment(id)) } });
  };

  const baseline = await fetchSnapshot(make(), TARGET);
  assert.equal(baseline.comments.length, 120);

  let requests = 0;
  const counting = make();
  const counted = await fetchSnapshot(async (...a) => (requests++, counting(...a)), TARGET, new Set(["IC_50"]));
  assert.equal(requests, 1, "a known id on the newest page ends paging");
  assert.equal(counted.comments.length, 100);
});

test("fetchSnapshot bounds missing and repeated backward cursors", async () => {
  for (const mode of ["missing", "repeated"]) {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls > 2) throw new Error("cursor loop did not stop");
      const base = { __typename: "Issue", url: "u", state: "OPEN", stateReason: null };
      const startCursor = mode === "missing" ? null : "cursor-1";
      return wrap({ ...base, comments: { pageInfo: { hasPreviousPage: true, startCursor }, nodes: [] } });
    };

    await assert.rejects(fetchSnapshot(run, TARGET), /pagination cursor/);
    assert.equal(calls, mode === "missing" ? 1 : 2);
  }
});

test("fetchSnapshot bounds nested comment pagination without a cursor", async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return wrap({
      ...prFixture(),
      reviewThreads: {
        pageInfo: emptyPage,
        nodes: [{
          id: "PRRT_1",
          path: "src/a.ts",
          line: 12,
          comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
        }],
      },
    });
  };

  await assert.rejects(fetchSnapshot(run, TARGET), /pagination cursor/);
  assert.equal(calls, 1);
});

test("fetchSnapshot bounds check-context pagination without a cursor", async () => {
  const item = prFixture();
  item.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo = { hasNextPage: true, endCursor: null };
  let calls = 0;
  const run = async () => {
    calls++;
    if (calls > 1) throw new Error("cursor loop did not stop");
    return wrap(item);
  };

  await assert.rejects(fetchSnapshot(run, TARGET), /pagination cursor/);
  assert.equal(calls, 1);
});

test("readItem bounds outer thread pagination without a cursor", async () => {
  let calls = 0;
  const run = async (args) => {
    if (args.includes("repos/acme/widgets/issues/7")) return JSON.stringify({ number: 7, pull_request: {} });
    calls++;
    if (calls > 1) throw new Error("cursor loop did not stop");
    return graphql({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } });
  };

  await assert.rejects(readItem(run, TARGET, ["threads"]), /pagination cursor/);
  assert.equal(calls, 1);
});

test("readItem truncates a diff over 1 MiB", async () => {
  const MiB = 1024 * 1024;
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes("Accept: application/vnd.github.diff")) return "x".repeat(MiB + 500);
    return JSON.stringify({ number: 7, pull_request: {} });
  };
  const { diff } = await readItem(run, TARGET, ["diff"]);
  assert.ok(diff.endsWith(DIFF_MARKER));
  assert.ok(diff.length < MiB + 100);
  assert.ok(calls.some((a) => a.includes("repos/acme/widgets/pulls/7")));

  const small = await readItem(async (args) => (args.includes("Accept: application/vnd.github.diff") ? "diff --git a b" : JSON.stringify({ pull_request: {} })), TARGET, ["diff"]);
  assert.equal(small.diff, "diff --git a b");
});

test("readItem filters comments by node id and keeps author and association", async () => {
  const run = async (args) => {
    if (args.includes("repos/acme/widgets/issues/7")) return JSON.stringify({ number: 7 });
    return JSON.stringify([
      { node_id: "IC_1", html_url: "u1", body: "one", user: { login: "alice", type: "User" }, author_association: "OWNER", created_at: "t" },
      { node_id: "IC_2", html_url: "u2", body: "two", user: { login: "bot", type: "Bot" }, author_association: "NONE", created_at: "t" },
    ]);
  };
  const { comments } = await readItem(run, TARGET, ["comments"], ["IC_2"]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "IC_2");
  assert.equal(comments[0].body, "two");
  assert.deepEqual(comments[0].author, { login: "bot", bot: true, association: "NONE" });
});

test("readItem selects a comment beyond the first 100 in its review thread", async () => {
  const comments = Array.from({ length: 120 }, (_, i) => ({ ...comment(`PRRC_${i}`), body: `comment ${i}` }));
  const run = async (args, input) => {
    if (args.includes("repos/acme/widgets/issues/7")) return JSON.stringify({ number: 7, pull_request: {} });
    const { query, variables } = JSON.parse(input);
    if (query.includes("node(id: $id)")) {
      assert.equal(variables.id, "PRRT_1");
      assert.equal(variables.after, "thread-comments-100");
      return graphql({ node: { comments: { pageInfo: emptyNextPage, nodes: comments.slice(100) } } });
    }
    return graphql({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: emptyPage,
            nodes: [{
              id: "PRRT_1",
              isResolved: false,
              isOutdated: false,
              path: "src/a.ts",
              line: 12,
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "thread-comments-100" },
                nodes: comments.slice(0, 100),
              },
            }],
          },
        },
      },
    });
  };

  const result = await readItem(run, TARGET, ["threads"], ["PRRC_119"]);
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].comments.length, 120);
  assert.equal(result.threads[0].comments.at(-1).id, "PRRC_119");
});

test("postComment sends the body on stdin, not argv", async () => {
  const body = "hello 'world' $(rm -rf) \"quoted\"";
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    return JSON.stringify({ node_id: "IC_new", html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1" });
  };
  const result = await postComment(run, TARGET, body);
  assert.deepEqual(result, { id: "IC_new", url: "https://github.com/acme/widgets/issues/7#issuecomment-1" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("repos/acme/widgets/issues/7/comments"));
  assert.ok(calls[0].args.includes("--input"));
  assert.ok(!calls[0].args.some((a) => a.includes("hello")));
  assert.equal(JSON.parse(calls[0].input).body, body);
});

test("fetchReviewComment resolves nested replies to the root REST comment id", async () => {
  const pullRequest = { number: 7, repository: { nameWithOwner: "acme/widgets" } };
  const comments = {
    PRRC_reply: { id: "PRRC_reply", fullDatabaseId: "4564699236", pullRequest, replyTo: { id: "PRRC_root" } },
    PRRC_root: { id: "PRRC_root", fullDatabaseId: "4564699235", pullRequest, replyTo: null },
  };
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    const { query, variables } = JSON.parse(input);
    assert.match(query, /\bfullDatabaseId\b/);
    assert.match(query, /\bpullRequest\s*\{/);
    assert.match(query, /\breplyTo\s*\{\s*id\s*\}/);
    assert.doesNotMatch(query, /\bpullRequestReviewThread\b/);
    return graphql({ node: comments[variables.id] });
  };

  const resolved = await fetchReviewComment(run, "PRRC_reply");
  assert.deepEqual(resolved, { replyId: "4564699235", target: TARGET });
  assert.deepEqual(calls.map((c) => JSON.parse(c.input).variables.id), ["PRRC_reply", "PRRC_root"]);
});

test("postComment routes replies and returns exact associated review identities", async () => {
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args.includes("graphql")) {
      const { query } = JSON.parse(input);
      assert.match(query, /pullRequestReview\s*\{\s*id\s+fullDatabaseId\s*\}/);
      return graphql({
        addPullRequestReviewThreadReply: {
          comment: { id: "PRRC_new", url: "https://x/gql", pullRequestReview: { id: "PRR_gql", fullDatabaseId: "5893030645" } },
        },
      });
    }
    return JSON.stringify({ node_id: "PRRC_rest", html_url: "https://x/rest", pull_request_review_id: 42 });
  };

  const rest = await postComment(run, TARGET, "b", "123456");
  assert.deepEqual(rest, { id: "PRRC_rest", url: "https://x/rest", reviewDatabaseId: "42" });
  assert.ok(calls[0].args.includes("repos/acme/widgets/pulls/7/comments/123456/replies"));

  const gql = await postComment(run, TARGET, "b", "PRRT_kwDOabc");
  assert.deepEqual(gql, { id: "PRRC_new", url: "https://x/gql", reviewId: "PRR_gql", reviewDatabaseId: "5893030645" });
  const sent = JSON.parse(calls[1].input);
  assert.match(sent.query, /pullRequestReview\s*\{\s*id\s+fullDatabaseId\s*\}/);
  assert.equal(sent.variables.threadId, "PRRT_kwDOabc");
  assert.equal(sent.variables.body, "b");
  assert.ok(!calls[1].args.some((a) => a === "b"));

  await assert.rejects(postComment(run, TARGET, "b", "PRRC_xyz"), { message: "replyTo must be a review comment id or a review thread id." });
  assert.equal(calls.length, 2, "an unusable replyTo never reaches gh");
});

test("postComment keeps a known GraphQL reply when no review ID is returned", async () => {
  let calls = 0;
  const posted = await postComment(async () => {
    calls++;
    return graphql({ addPullRequestReviewThreadReply: { comment: { id: "PRRC_written", url: "https://x/written", pullRequestReview: null } } });
  }, TARGET, "b", "PRRT_1");
  assert.deepEqual(posted, { id: "PRRC_written", url: "https://x/written" });
  assert.equal(calls, 1);
});

test("postComment keeps a known REST reply without an exact review ID", async () => {
  let calls = 0;
  const run = async (args) => {
    calls++;
    assert.ok(args.includes("-X"));
    return JSON.stringify({ node_id: "PRRC_written", html_url: "https://x/written", pull_request_review_id: null });
  };

  const posted = await postComment(run, TARGET, "b", "123456");
  assert.deepEqual(posted, { id: "PRRC_written", url: "https://x/written" });
  assert.equal(calls, 1);
});

test("postComment skips an unsafe REST review ID alias rather than rounding it", async () => {
  const posted = await postComment(
    async () => JSON.stringify({ node_id: "PRRC_unsafe", html_url: "https://x/unsafe", pull_request_review_id: Number.MAX_SAFE_INTEGER + 1 }),
    TARGET,
    "b",
    "123456",
  );
  assert.deepEqual(posted, { id: "PRRC_unsafe", url: "https://x/unsafe" });
});


test("resolveThread sends the resolveReviewThread mutation", async () => {
  const calls = [];
  await resolveThread(async (args, input) => (calls.push({ args, input }), graphql({ resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } })), "PRRT_1");
  const sent = JSON.parse(calls[0].input);
  assert.match(sent.query, /resolveReviewThread/);
  assert.equal(sent.variables.threadId, "PRRT_1");
});
