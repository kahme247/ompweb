import { createHash } from "node:crypto";
import type { GithubActor, ItemSnapshot } from "./api";

/**
 * What a watch has already reported, diffed against each snapshot. Pure: the
 * poller owns the store and the outbox; this module only decides what is new
 * and words it without any text GitHub users wrote.
 */

/** Comment/thread history is bounded; all review IDs stay in the cursor for late submissions. */
const KEPT = 2000;
const NAME_LIMIT = 100;
const REVIEW_STATES: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

type Head = NonNullable<ItemSnapshot["head"]>;
type ReviewSnapshot = ItemSnapshot["reviews"][number] & { databaseId?: string };

export interface WatchCursor {
  commentIds: string[];
  reviewIds: string[];
  threadCommentIds: string[];
  reportedHeads: string[];
  final: boolean;
}

export type GithubEvent =
  | { kind: "comment"; id: string; url: string; author: GithubActor }
  | { kind: "review"; id: string; url: string; author: GithubActor; state: string; commentCount: number; databaseId?: string }
  | { kind: "thread_comment"; id: string; url: string; author: GithubActor; threadId: string; line: number | null }
  | { kind: "ci"; id: string; url: string; sha: string; counts: Record<string, number> }
  | { kind: "merged"; id: string; url: string }
  | { kind: "closed"; id: string; url: string; reason?: "completed" | "not_planned" };

const settled = (head: Head | undefined): head is Head => head !== undefined && head.checks.length > 0 && head.checks.every((c) => c.status === "completed");

// The snapshot's own ids are never trimmed: a trimmed id would come back as new on the next poll.
const remember = (known: string[], seen: string[]): string[] => {
  const fresh = new Set(seen);
  return [...known.filter((id) => !fresh.has(id)).slice(-KEPT), ...seen];
};

const unseen = <T extends { id: string }>(items: T[], known: string[], posted: ReadonlySet<string>): T[] => {
  const seen = new Set(known);
  return items.filter((item) => !seen.has(item.id) && !posted.has(item.id));
};


// Comments arrive oldest-first; the earliest retained ID bounds an expanded shared snapshot.
const unseenHistory = <T extends { id: string }>(items: T[], known: string[], posted: ReadonlySet<string>): T[] => {
  const seen = new Set(known);
  const boundary = items.findIndex((item) => seen.has(item.id));
  return items.filter((item, index) => index >= boundary && !seen.has(item.id) && !posted.has(item.id));
};

// For a confirm the user reads (a thread's file path): one line, no control or format characters, bounded length.
export function capName(name: string): string {
  const chars = Array.from(name.replace(/\s+/g, " ").replace(/\p{C}/gu, ""));
  return chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT - 1).join("")}…` : chars.join("");
}

function ciEvent(url: string, head: Head): GithubEvent {
  const counts: Record<string, number> = {};
  for (const check of head.checks) {
    const conclusion = check.conclusion ?? "unknown";
    counts[conclusion] = (counts[conclusion] ?? 0) + 1;
  }
  return { kind: "ci", id: head.sha, url, sha: head.sha, counts };
}

/** The current state as already reported, so a watch starts from what it sees now. */
export function baselineCursor(snapshot: ItemSnapshot): WatchCursor {
  const head = snapshot.head;
  return {
    commentIds: remember([], snapshot.comments.map((c) => c.id)),
    reviewIds: snapshot.reviews.map((r) => r.id),
    threadCommentIds: remember([], snapshot.threadComments.map((t) => t.id)),
    reportedHeads: settled(head) ? [head.sha] : [],
    final: false,
  };
}

/**
 * New comments, reviews and thread comments since the cursor, and the CI result
 * of the current head once it has settled. Ids in `postedIds` (the agent's own
 * posts) join the cursor without an event. A merge or close is one final event.
 */
export function diffSnapshot(
  cursor: WatchCursor,
  snapshot: ItemSnapshot,
  postedIds: ReadonlySet<string>,
): { events: GithubEvent[]; cursor: WatchCursor } {
  const reviews = snapshot.reviews as ReviewSnapshot[];
  const seenReviews = new Set(cursor.reviewIds);
  const reviewEvents: GithubEvent[] = [];
  for (const review of reviews) {
    const known = seenReviews.has(review.id);
    seenReviews.add(review.id);
    const posted = postedIds.has(review.id) || (review.databaseId !== undefined && postedIds.has(`review:${review.databaseId}`));
    if (known || posted) continue;
    reviewEvents.push({
      kind: "review",
      id: review.id,
      url: review.url,
      author: review.author,
      state: review.state,
      commentCount: review.commentCount,
      ...(review.databaseId === undefined ? {} : { databaseId: review.databaseId }),
    });
  }
  const events: GithubEvent[] = [
    ...unseenHistory(snapshot.comments, cursor.commentIds, postedIds).map((c) => ({ kind: "comment" as const, id: c.id, url: c.url, author: c.author })),
    ...reviewEvents,
    ...unseen(snapshot.threadComments, cursor.threadCommentIds, postedIds).map((t) => ({
      kind: "thread_comment" as const,
      id: t.id,
      url: t.url,
      author: t.author,
      threadId: t.threadId,
      line: t.line,
    })),
  ];

  const head = snapshot.head;
  const ci = settled(head) && !cursor.reportedHeads.includes(head.sha) ? head : undefined;
  if (ci) events.push(ciEvent(snapshot.url, ci));

  const ended = snapshot.state !== "open";
  if (ended && !cursor.final) {
    events.push(
      snapshot.state === "merged"
        ? { kind: "merged", id: snapshot.url, url: snapshot.url }
        : { kind: "closed", id: snapshot.url, url: snapshot.url, reason: snapshot.closedReason },
    );
  }

  return {
    events,
    cursor: {
      commentIds: remember(cursor.commentIds, snapshot.comments.map((c) => c.id)),
      reviewIds: [...seenReviews],
      threadCommentIds: remember(cursor.threadCommentIds, snapshot.threadComments.map((t) => t.id)),
      reportedHeads: ci ? [...cursor.reportedHeads, ci.sha].slice(-KEPT) : cursor.reportedHeads,
      final: cursor.final || ended,
    },
  };
}

const who = (author: GithubActor) => `${author.login} (${author.bot ? "bot" : "user"}, association ${author.association})`;

function describe(event: GithubEvent): string {
  switch (event.kind) {
    case "comment":
      return `- comment by ${who(event.author)}. id ${event.id}, url ${event.url}`;
    case "review": {
      const state = REVIEW_STATES[event.state] ?? "unknown";
      const inline = `${event.commentCount} inline comment${event.commentCount === 1 ? "" : "s"}`;
      return `- review (${state}, ${inline}) by ${who(event.author)}. id ${event.id}, url ${event.url}`;
    }
    case "thread_comment": {
      const place = event.line === null ? "" : ` at line ${event.line}`;
      return `- inline review comment${place} (thread ${event.threadId}) by ${who(event.author)}. id ${event.id}, url ${event.url}`;
    }
    case "ci": {
      const counts = Object.keys(event.counts)
        .sort()
        .map((conclusion) => `${event.counts[conclusion]} ${conclusion}`)
        .join(", ");
      return `- CI result for head ${event.sha}: ${counts}. url ${event.url}`;
    }
    case "merged":
      return `- merged. url ${event.url}`;
    case "closed": {
      const reason = event.reason === undefined ? "" : ` as ${event.reason === "not_planned" ? "not planned" : "completed"}`;
      return `- closed${reason}. url ${event.url}`;
    }
  }
}

/** Header, then one line per event. Only logins, association, review states, line numbers, ids and URLs come from GitHub; never check names or file paths, which a fork writes. */
export function formatUpdate(targetText: string, url: string, events: GithubEvent[]): string {
  return [`GitHub update (omp-web): ${targetText} ${url}`, ...events.map(describe)].join("\n");
}

const jsonStringContentBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value)) - 2;

/** Splits events without losing any; the caller supplies space left after its complete JSON command envelope. */
export function splitUpdateEvents(targetText: string, url: string, events: GithubEvent[], maxMessageContentBytes: number): GithubEvent[][] {
  const headerBytes = jsonStringContentBytes(`GitHub update (omp-web): ${targetText} ${url}`);
  const batches: GithubEvent[][] = [];
  let batch: GithubEvent[] = [];
  let bytes = headerBytes;
  for (const event of events) {
    const lineBytes = 2 + jsonStringContentBytes(describe(event)); // JSON escapes the joining newline as two bytes.
    if (headerBytes + lineBytes > maxMessageContentBytes) throw new RangeError("A GitHub event exceeds the agent command size limit.");
    if (bytes + lineBytes > maxMessageContentBytes) {
      batches.push(batch);
      batch = [];
      bytes = headerBytes;
    }
    batch.push(event);
    bytes += lineBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Stable for the same watch and events, so re-adding after a crash finds the stored entry. */
export function updateEntryId(watchKey: string, events: GithubEvent[]): string {
  const ids = events.map((event) => event.id).join("\0");
  return `gh-${createHash("sha256").update(`${watchKey}\0${ids}`).digest("base64url").slice(0, 40)}`;
}
