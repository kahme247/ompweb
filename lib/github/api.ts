import { GhError, type GhRunner, type GithubTarget } from "./gh";

/**
 * GitHub data layer over `gh api`. Snapshots carry metadata only (ids, urls,
 * authors, states): no title, body or branch name, so what the poller derives
 * from them can never carry text written on GitHub. `readItem` is the one
 * explicit path that returns that text.
 *
 * Every comment, review and review-thread comment id is the GraphQL node id
 * (`node_id` in REST responses), so ids from any call compare equal.
 */

export type ItemKind = "pull_request" | "issue";

export interface GithubActor {
  login: string;
  bot: boolean;
  association: string;
}

export interface ItemSnapshot {
  kind: ItemKind;
  url: string;
  state: "open" | "closed" | "merged";
  closedReason?: "completed" | "not_planned";
  comments: { id: string; url: string; author: GithubActor }[];
  reviews: { id: string; databaseId?: string; url: string; author: GithubActor; state: string; commentCount: number }[];
  threadComments: { id: string; url: string; author: GithubActor; threadId: string; path: string; line: number | null }[];
  /** Checks are lower-cased: `conclusion` "success" | "failure" | ..., `status` "completed" | "in_progress" | ... Commit statuses map to the same words. */
  head?: { sha: string; checks: { name: string; conclusion: string | null; status: string }[] };
  /** The login's GraphQL points left after the last snapshot request, and when they refill. */
  rateLimit?: { remaining: number; resetAt: string };
}

export type ReadPart = "summary" | "comments" | "reviews" | "threads" | "checks" | "files" | "diff";

// --- GraphQL plumbing -------------------------------------------------------

interface GqlActor {
  login: string;
  __typename: string;
}
interface GqlComment {
  id: string;
  url: string;
  author: GqlActor | null;
  authorAssociation: string;
}
interface GqlReview extends GqlComment {
  state: string;
  comments: { totalCount: number };
  fullDatabaseId: string | null;
}
interface GqlThread {
  id: string;
  path: string;
  line: number | null;
  comments: GqlForwardPage<GqlComment & { state: string }>;
}
interface GqlPage<T> {
  pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  nodes: (T | null)[];
}
interface GqlForwardPage<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (T | null)[];
}
interface GqlContext {
  __typename: string;
  name?: string;
  conclusion?: string | null;
  status?: string;
  context?: string;
  state?: string;
}
interface GqlContexts {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (GqlContext | null)[];
}
interface GqlItem {
  __typename: "Issue" | "PullRequest";
  url: string;
  state: string;
  stateReason?: string | null;
  comments?: GqlPage<GqlComment>;
  reviews?: GqlPage<GqlReview>;
  reviewThreads?: GqlPage<GqlThread>;
  commits?: { nodes: ({ commit: { oid: string; statusCheckRollup: { id: string; contexts: GqlContexts } | null } } | null)[] };
}

async function graphql<T>(run: GhRunner, query: string, variables: Record<string, unknown>): Promise<T> {
  const out = JSON.parse(await run(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }))) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (out.errors?.length || !out.data) throw new Error(out.errors?.map((e) => e.message).join("; ") || "GitHub returned no data.");
  return out.data;
}

const ACTOR = "author { login __typename } authorAssociation";
const COMMENT = `id url ${ACTOR}`;

// Each connection is fetched through its own flag, so a follow-up page request
// asks for that connection alone.
const SNAPSHOT_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cc: String, $rc: String, $tc: String,
    $wc: Boolean!, $wr: Boolean!, $wt: Boolean!, $wh: Boolean!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        url state stateReason
        comments(last: 100, before: $cc) @include(if: $wc) { pageInfo { hasPreviousPage startCursor } nodes { ${COMMENT} } }
      }
      ... on PullRequest {
        url state
        comments(last: 100, before: $cc) @include(if: $wc) { pageInfo { hasPreviousPage startCursor } nodes { ${COMMENT} } }
        reviews(last: 100, before: $rc) @include(if: $wr) { pageInfo { hasPreviousPage startCursor } nodes { ${COMMENT} fullDatabaseId state comments { totalCount } } }
        reviewThreads(last: 100, before: $tc) @include(if: $wt) {
          pageInfo { hasPreviousPage startCursor }
          nodes { id path line comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} state } } }
        }
        commits(last: 1) @include(if: $wh) {
          nodes { commit { oid statusCheckRollup { id contexts(first: 100) { pageInfo { hasNextPage endCursor } nodes {
            __typename
            ... on CheckRun { name conclusion status }
            ... on StatusContext { context state }
          } } } } }
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

const SNAPSHOT_THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread {
    comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} state } }
  } }
}`;

const CONTEXTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on StatusCheckRollup { contexts(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
    __typename
    ... on CheckRun { name conclusion status }
    ... on StatusContext { context state }
  } } } }
}`;

const lower = (value: string | null | undefined) => (value == null ? null : value.toLowerCase());

function actorOf(author: GqlActor | null, association: string | undefined): GithubActor {
  return { login: author?.login ?? "ghost", bot: author?.__typename === "Bot", association: association ?? "NONE" };
}

function checkOf(node: GqlContext): { name: string; conclusion: string | null; status: string } {
  if (node.__typename === "CheckRun") return { name: node.name ?? "", conclusion: lower(node.conclusion), status: lower(node.status) ?? "" };
  const pending = node.state === "PENDING" || node.state === "EXPECTED";
  return { name: node.context ?? "", conclusion: pending ? null : lower(node.state), status: pending ? "in_progress" : "completed" };
}

const present = <T>(nodes: (T | null)[]): T[] => nodes.filter((n): n is T => n !== null);

async function allThreadComments<T extends GqlComment>(
  run: GhRunner,
  threadId: string,
  first: GqlForwardPage<T>,
  query: string,
): Promise<T[]> {
  const nodes = present(first.nodes);
  let pageInfo = first.pageInfo;
  while (pageInfo.hasNextPage) {
    const data = await graphql<{ node: { comments: GqlForwardPage<T> } | null }>(run, query, { id: threadId, after: pageInfo.endCursor });
    const page = data.node?.comments;
    if (!page) throw new Error(`Review thread ${threadId} was not found.`);
    nodes.push(...present(page.nodes));
    pageInfo = page.pageInfo;
  }
  return nodes;
}

/**
 * The first GraphQL page includes item state, comments, reviews, threads and
 * head checks. Outer connections page backwards; nested thread comments page
 * forward. Threads and their comments always page fully because replies to old
 * threads may be new. With `since`, outer comments and reviews stop at the
 * first page containing a known id, so a quiet item needs one request.
 */
export async function fetchSnapshot(run: GhRunner, target: GithubTarget, since?: ReadonlySet<string>): Promise<ItemSnapshot> {
  const vars = { owner: target.owner, repo: target.repo, number: target.number };
  let rateLimit: ItemSnapshot["rateLimit"];
  const query = async (extra: Record<string, unknown>) => {
    const flags = { wc: false, wr: false, wt: false, wh: false, cc: null, rc: null, tc: null, ...extra };
    const data = await graphql<{ repository: { issueOrPullRequest: GqlItem | null } | null; rateLimit?: ItemSnapshot["rateLimit"] }>(run, SNAPSHOT_QUERY, { ...vars, ...flags });
    rateLimit = data.rateLimit ?? rateLimit;
    const item = data.repository?.issueOrPullRequest;
    if (!item) throw new Error(`${target.owner}/${target.repo}#${target.number} was not found.`);
    return item;
  };

  const first = await query({ wc: true, wr: true, wt: true, wh: true });
  const collect = async <T extends { id: string }>(conn: "comments" | "reviews" | "reviewThreads", flag: string, cursor: string, stopWhenKnown: boolean) => {
    let page = first[conn] as unknown as GqlPage<T> | undefined;
    if (!page) return [];
    let nodes = present(page.nodes);
    while (page.pageInfo.hasPreviousPage && !(stopWhenKnown && since && nodes.some((n) => since.has(n.id)))) {
      page = (await query({ [flag]: true, [cursor]: page.pageInfo.startCursor }))[conn] as unknown as GqlPage<T>;
      nodes = [...present(page.nodes), ...nodes];
    }
    return nodes;
  };
  const [comments, reviews, threads] = await Promise.all([
    collect<GqlComment>("comments", "wc", "cc", true),
    collect<GqlReview>("reviews", "wr", "rc", true),
    collect<GqlThread>("reviewThreads", "wt", "tc", false),
  ]);
  for (const thread of threads) {
    thread.comments.nodes = await allThreadComments(run, thread.id, thread.comments, SNAPSHOT_THREAD_COMMENTS_QUERY);
  }

  // A draft (pending) review and its comments are left out, so their submission is new later.
  const snapshot: ItemSnapshot = {
    kind: first.__typename === "PullRequest" ? "pull_request" : "issue",
    url: first.url,
    state: first.state === "MERGED" ? "merged" : first.state === "CLOSED" ? "closed" : "open",
    comments: comments.map((c) => ({ id: c.id, url: c.url, author: actorOf(c.author, c.authorAssociation) })),
    reviews: reviews
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({ id: r.id, ...(typeof r.fullDatabaseId === "string" && /^\d+$/.test(r.fullDatabaseId) && { databaseId: r.fullDatabaseId }), url: r.url, author: actorOf(r.author, r.authorAssociation), state: r.state, commentCount: r.comments.totalCount })),
    threadComments: threads.flatMap((t) =>
      present(t.comments.nodes)
        .filter((c) => c.state !== "PENDING")
        .map((c) => ({ id: c.id, url: c.url, author: actorOf(c.author, c.authorAssociation), threadId: t.id, path: t.path, line: t.line })),
    ),
  };
  if (rateLimit) snapshot.rateLimit = rateLimit;
  // Issues closed before GitHub recorded a reason have none; they were closed as done.
  if (first.state === "CLOSED" && first.__typename === "Issue") snapshot.closedReason = first.stateReason === "NOT_PLANNED" ? "not_planned" : "completed";

  const commit = first.commits?.nodes[0]?.commit;
  if (commit) {
    const rollup = commit.statusCheckRollup;
    let nodes = rollup ? present(rollup.contexts.nodes) : [];
    let info = rollup?.contexts.pageInfo;
    while (rollup && info?.hasNextPage) {
      const next = await graphql<{ node: { contexts: GqlContexts } }>(run, CONTEXTS_QUERY, { id: rollup.id, after: info.endCursor });
      nodes = [...nodes, ...present(next.node.contexts.nodes)];
      info = next.node.contexts.pageInfo;
    }
    snapshot.head = { sha: commit.oid, checks: nodes.map(checkOf) };
  }
  return snapshot;
}

// --- REST reads -------------------------------------------------------------

interface RestUser {
  login: string;
  type?: string;
}
interface RestItem {
  node_id?: string;
  html_url?: string;
  user?: RestUser | null;
  author_association?: string;
  body?: string | null;
  [key: string]: unknown;
}

const restActor = (user: RestUser | null | undefined, association: string | undefined): GithubActor => ({
  login: user?.login ?? "ghost",
  bot: user?.type === "Bot",
  association: association ?? "NONE",
});

const rest = async <T>(run: GhRunner, path: string): Promise<T> => JSON.parse(await run(["api", path])) as T;

async function restPages<T>(run: GhRunner, path: string, key?: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const data = await rest<T[] | Record<string, T[]>>(run, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const items = Array.isArray(data) ? data : data[key ?? ""] ?? [];
    all.push(...items);
    if (items.length < 100) return all;
  }
}

const DIFF_LIMIT = 1024 * 1024;
const DIFF_MARKER = "…[diff truncated at 1 MiB]";

function capDiff(diff: string): string {
  const bytes = Buffer.from(diff);
  return bytes.length > DIFF_LIMIT ? `${bytes.subarray(0, DIFF_LIMIT).toString()}\n${DIFF_MARKER}` : diff;
}

const THREADS_READ_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved isOutdated path line comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} body } } }
    }
  } }
}`;

const THREAD_COMMENTS_READ_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread {
    comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT} body } }
  } }
}`;

interface ReadThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: GqlForwardPage<GqlComment & { body: string }>;
}

async function readThreads(run: GhRunner, target: GithubTarget): Promise<ReadThread[]> {
  const out: ReadThread[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ReadThread[] } } } } = await graphql(
      run,
      THREADS_READ_QUERY,
      { owner: target.owner, repo: target.repo, number: target.number, after },
    );
    const { pageInfo, nodes } = data.repository.pullRequest.reviewThreads;
    out.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  for (const thread of out) {
    thread.comments.nodes = await allThreadComments(run, thread.id, thread.comments, THREAD_COMMENTS_READ_QUERY);
  }
  return out;
}

interface RestPull {
  head: { sha: string; ref: string };
  base: { ref: string };
  merged?: boolean;
  draft?: boolean;
}

/**
 * The explicit read path: returns titles, bodies and branch names, each
 * user-written field with its author and association. `ids` (node ids) limits
 * comments, reviews and threads.
 */
export async function readItem(run: GhRunner, target: GithubTarget, include: ReadPart[], ids?: string[]): Promise<Record<string, unknown>> {
  const base = `repos/${target.owner}/${target.repo}`;
  const number = target.number;
  const issue = await rest<RestItem & { title: string; state: string; state_reason?: string | null; labels: { name: string }[]; pull_request?: unknown }>(run, `${base}/issues/${number}`);
  const isPull = Boolean(issue.pull_request);
  let pull: Promise<RestPull> | undefined;
  const getPull = () => (pull ??= rest<RestPull>(run, `${base}/pulls/${number}`));
  const keep = (id: string | undefined) => !ids || (id !== undefined && ids.includes(id));
  const out: Record<string, unknown> = {};

  for (const part of new Set(include)) {
    if (part !== "summary" && part !== "comments" && !isPull) throw new Error(`"${part}" is only available for pull requests.`);
    switch (part) {
      case "summary": {
        const p = isPull ? await getPull() : undefined;
        out.summary = {
          kind: isPull ? "pull_request" : "issue",
          url: issue.html_url,
          title: issue.title,
          state: p?.merged ? "merged" : issue.state,
          stateReason: issue.state_reason ?? undefined,
          author: restActor(issue.user, issue.author_association),
          body: issue.body ?? "",
          labels: issue.labels.map((l) => l.name),
          ...(p && { base: p.base.ref, head: { ref: p.head.ref, sha: p.head.sha }, draft: p.draft }),
        };
        break;
      }
      case "comments":
        out.comments = (await restPages<RestItem>(run, `${base}/issues/${number}/comments`))
          .filter((c) => keep(c.node_id))
          .map((c) => ({ id: c.node_id, url: c.html_url, author: restActor(c.user, c.author_association), body: c.body ?? "", createdAt: c.created_at }));
        break;
      case "reviews":
        out.reviews = (await restPages<RestItem>(run, `${base}/pulls/${number}/reviews`))
          .filter((r) => keep(r.node_id))
          .map((r) => ({ id: r.node_id, url: r.html_url, author: restActor(r.user, r.author_association), state: r.state, body: r.body ?? "", submittedAt: r.submitted_at }));
        break;
      case "threads":
        out.threads = (await readThreads(run, target))
          .filter((t) => !ids || keep(t.id) || present(t.comments.nodes).some((c) => keep(c.id)))
          .map((t) => ({
            id: t.id,
            resolved: t.isResolved,
            outdated: t.isOutdated,
            path: t.path,
            line: t.line,
            comments: present(t.comments.nodes).map((c) => ({ id: c.id, url: c.url, author: actorOf(c.author, c.authorAssociation), body: c.body })),
          }));
        break;
      case "checks": {
        const sha = (await getPull()).head.sha;
        const [runs, statuses] = await Promise.all([
          restPages<RestItem>(run, `${base}/commits/${sha}/check-runs`, "check_runs"),
          restPages<RestItem>(run, `${base}/commits/${sha}/status`, "statuses"),
        ]);
        out.checks = {
          sha,
          checkRuns: runs.map((c) => {
            const o = (c.output ?? {}) as { title?: string | null; summary?: string | null };
            return { name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url, title: o.title ?? null, summary: o.summary ?? null };
          }),
          statuses: statuses.map((s) => ({ context: s.context, state: s.state, description: s.description ?? null, url: s.target_url ?? null })),
        };
        break;
      }
      case "files":
        out.files = (await restPages<RestItem>(run, `${base}/pulls/${number}/files`)).map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
        break;
      case "diff":
        out.diff = capDiff(await run(["api", "-H", "Accept: application/vnd.github.diff", `${base}/pulls/${number}`]));
        break;
    }
  }
  return out;
}

// --- Writes -----------------------------------------------------------------

const REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id url pullRequestReview { id fullDatabaseId } } }
}`;
const RESOLVE_MUTATION = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`;

const UNKNOWN_WRITE_OUTCOME =
  "The GitHub write outcome is unknown; check with github_read (include comments or threads) before retrying.";

function writeOutcomeError(error: unknown): Error {
  if (error instanceof GhError) {
    const match = /\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i.exec(`${error.stderr}\n${error.message}`);
    const status = Number(match?.[1]);
    if (status >= 400 && status < 500 && status !== 408) return error;
  }
  return new Error(UNKNOWN_WRITE_OUTCOME);
}
const THREAD_QUERY = `query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { id path line pullRequest { number repository { nameWithOwner } } } }
}`;

const REVIEW_COMMENT_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewComment {
      id fullDatabaseId
      pullRequest { number repository { nameWithOwner } }
      replyTo { id }
    }
  }
}`;

/** Where a review thread lives, so a write names it and lands on the item it claims. */
export async function fetchThread(run: GhRunner, threadId: string): Promise<{ threadId: string; target: GithubTarget; path: string; line: number | null }> {
  type ThreadNode = { id: string; path?: string; line?: number | null; pullRequest?: { number: number; repository: { nameWithOwner: string } } };
  const data = await graphql<{ node: (ThreadNode | { pullRequestReviewThread: ThreadNode | null }) | null }>(
    run,
    THREAD_QUERY,
    { id: threadId },
  );
  const node = data.node;
  const thread = node && "pullRequestReviewThread" in node ? node.pullRequestReviewThread : node;
  const pr = thread?.pullRequest;
  if (!thread || !pr) throw new Error(`Review thread ${threadId} was not found.`);
  const [owner, repo] = pr.repository.nameWithOwner.split("/");
  return { threadId: thread.id, target: { owner, repo, number: pr.number }, path: thread.path ?? "", line: thread.line ?? null };
}

export async function fetchReviewComment(run: GhRunner, commentId: string): Promise<{ replyId: string; target: GithubTarget }> {
  type ReviewCommentNode = {
    id: string;
    fullDatabaseId: string | null;
    pullRequest: { number: number; repository: { nameWithOwner: string } };
    replyTo: { id: string } | null;
  };
  let nodeId: string | null = commentId;
  let rootId: string | undefined;
  let target: GithubTarget | undefined;
  const seen = new Set<string>();
  while (nodeId) {
    if (seen.has(nodeId)) throw new Error(`Review comment ${commentId} was not found.`);
    seen.add(nodeId);
    const data: { node: ReviewCommentNode | null } = await graphql<{ node: ReviewCommentNode | null }>(run, REVIEW_COMMENT_QUERY, { id: nodeId });
    const comment: ReviewCommentNode | null = data.node;
    if (!comment || comment.id !== nodeId || typeof comment.fullDatabaseId !== "string" || !/^\d+$/.test(comment.fullDatabaseId)) {
      throw new Error(`Review comment ${commentId} was not found.`);
    }
    const [owner, repo] = comment.pullRequest.repository.nameWithOwner.split("/");
    const commentTarget = { owner, repo, number: comment.pullRequest.number };
    if (target && (target.owner.toLowerCase() !== owner.toLowerCase() || target.repo.toLowerCase() !== repo.toLowerCase() || target.number !== commentTarget.number)) {
      throw new Error(`Review comment ${commentId} was not found.`);
    }
    target = commentTarget;
    rootId = comment.fullDatabaseId;
    nodeId = comment.replyTo?.id ?? null;
  }
  if (!target || !rootId) throw new Error(`Review comment ${commentId} was not found.`);
  return { replyId: rootId, target };
}

/** The body always travels on stdin as JSON, never in argv. */
export async function postComment(
  run: GhRunner,
  target: GithubTarget,
  body: string,
  replyTo?: string,
): Promise<{ id: string; url: string; reviewId?: string; reviewDatabaseId?: string }> {
  const base = `repos/${target.owner}/${target.repo}`;
  if (replyTo?.startsWith("PRRT_")) {
    let data: {
      addPullRequestReviewThreadReply: {
        comment: { id: string; url: string; pullRequestReview: { id: string; fullDatabaseId: string | null } | null } | null;
      } | null;
    };
    try {
      data = await graphql<{
        addPullRequestReviewThreadReply: {
          comment: { id: string; url: string; pullRequestReview: { id: string; fullDatabaseId: string | null } | null } | null;
        } | null;
      }>(run, REPLY_MUTATION, { threadId: replyTo, body });
    } catch (error) {
      throw writeOutcomeError(error);
    }
    const comment = data.addPullRequestReviewThreadReply?.comment;
    if (!comment || typeof comment.id !== "string" || !comment.id || typeof comment.url !== "string" || !comment.url) {
      throw new Error(UNKNOWN_WRITE_OUTCOME);
    }
    const review = comment.pullRequestReview;
    return {
      id: comment.id,
      url: comment.url,
      ...(typeof review?.id === "string" && review.id && { reviewId: review.id }),
      ...(typeof review?.fullDatabaseId === "string" && /^\d+$/.test(review.fullDatabaseId) && { reviewDatabaseId: review.fullDatabaseId }),
    };
  }
  if (replyTo !== undefined && !/^\d+$/.test(replyTo)) throw new Error("replyTo must be a review comment id or a review thread id.");
  const path = replyTo === undefined ? `${base}/issues/${target.number}/comments` : `${base}/pulls/${target.number}/comments/${replyTo}/replies`;
  let response: unknown;
  try {
    response = JSON.parse(await run(["api", "-X", "POST", path, "--input", "-"], JSON.stringify({ body })));
  } catch (error) {
    throw writeOutcomeError(error);
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error(UNKNOWN_WRITE_OUTCOME);
  const posted = response as { node_id?: unknown; html_url?: unknown; pull_request_review_id?: unknown };
  if (typeof posted.node_id !== "string" || !posted.node_id || typeof posted.html_url !== "string" || !posted.html_url) {
    throw new Error(UNKNOWN_WRITE_OUTCOME);
  }
  return {
    id: posted.node_id,
    url: posted.html_url,
    ...(replyTo !== undefined &&
      typeof posted.pull_request_review_id === "number" &&
      Number.isSafeInteger(posted.pull_request_review_id) && {
        reviewDatabaseId: String(posted.pull_request_review_id),
      }),
  };
}


export async function resolveThread(run: GhRunner, threadId: string): Promise<void> {
  await graphql(run, RESOLVE_MUTATION, { threadId });
}
