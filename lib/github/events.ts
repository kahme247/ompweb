import { createHash } from "node:crypto";
import type { GithubActor, ItemSnapshot } from "./api";

/**
 * What a watch has already reported, diffed against each snapshot. Pure: the
 * poller owns the store and the outbox; this module only decides what is new
 * and words it without any text GitHub users wrote.
 */

/** Id lists keep the newest of each, so a long-lived watch stays bounded. */
const KEPT = 2000;
const NAME_LIMIT = 100;
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "error"]);
const REVIEW_STATES: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

type Head = NonNullable<ItemSnapshot["head"]>;

export interface WatchCursor {
  commentIds: string[];
  reviewIds: string[];
  threadCommentIds: string[];
  reportedHeads: string[];
  final: boolean;
}

export type GithubEvent =
  | { kind: "comment"; id: string; url: string; author: GithubActor }
  | { kind: "review"; id: string; url: string; author: GithubActor; state: string; commentCount: number }
  | { kind: "thread_comment"; id: string; url: string; author: GithubActor; threadId: string; path: string; line: number | null }
  | { kind: "ci"; id: string; url: string; sha: string; counts: Record<string, number>; failed: string[] }
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

// Check names come from workflow files a fork controls: one line, bounded length.
function capName(name: string): string {
  const chars = Array.from(name.replace(/\s+/g, " "));
  return chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT - 1).join("")}…` : chars.join("");
}

function ciEvent(url: string, head: Head): GithubEvent {
  const counts: Record<string, number> = {};
  const failed: string[] = [];
  for (const check of head.checks) {
    const conclusion = check.conclusion ?? "unknown";
    counts[conclusion] = (counts[conclusion] ?? 0) + 1;
    if (check.conclusion && FAILED.has(check.conclusion)) failed.push(capName(check.name));
  }
  return { kind: "ci", id: head.sha, url, sha: head.sha, counts, failed };
}

/** The current state as already reported, so a watch starts from what it sees now. */
export function baselineCursor(snapshot: ItemSnapshot): WatchCursor {
  const head = snapshot.head;
  return {
    commentIds: remember([], snapshot.comments.map((c) => c.id)),
    reviewIds: remember([], snapshot.reviews.map((r) => r.id)),
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
  const events: GithubEvent[] = [
    ...unseen(snapshot.comments, cursor.commentIds, postedIds).map((c) => ({ kind: "comment" as const, id: c.id, url: c.url, author: c.author })),
    ...unseen(snapshot.reviews, cursor.reviewIds, postedIds).map((r) => ({
      kind: "review" as const,
      id: r.id,
      url: r.url,
      author: r.author,
      state: r.state,
      commentCount: r.commentCount,
    })),
    ...unseen(snapshot.threadComments, cursor.threadCommentIds, postedIds).map((t) => ({
      kind: "thread_comment" as const,
      id: t.id,
      url: t.url,
      author: t.author,
      threadId: t.threadId,
      path: t.path,
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
      reviewIds: remember(cursor.reviewIds, snapshot.reviews.map((r) => r.id)),
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
      const path = event.path.replace(/\s+/g, " ");
      const place = event.line === null ? path : `${path}:${event.line}`;
      return `- inline review comment on ${place} (thread ${event.threadId}) by ${who(event.author)}. id ${event.id}, url ${event.url}`;
    }
    case "ci": {
      const counts = Object.keys(event.counts)
        .sort()
        .map((conclusion) => `${event.counts[conclusion]} ${conclusion}`)
        .join(", ");
      const failed = event.failed.length > 0 ? `; failed: ${event.failed.join(", ")}` : "";
      return `- CI result for head ${event.sha}: ${counts}${failed}. url ${event.url}`;
    }
    case "merged":
      return `- merged. url ${event.url}`;
    case "closed": {
      const reason = event.reason === undefined ? "" : ` as ${event.reason === "not_planned" ? "not planned" : "completed"}`;
      return `- closed${reason}. url ${event.url}`;
    }
  }
}

/** Header, then one line per event. Only logins, association, review states, file paths, line numbers, ids, URLs and check names come from GitHub. */
export function formatUpdate(targetText: string, url: string, events: GithubEvent[]): string {
  return [`GitHub update (omp-web): ${targetText} ${url}`, ...events.map(describe)].join("\n");
}

/** Stable for the same watch and events, so re-adding after a crash finds the stored entry. */
export function updateEntryId(watchKey: string, events: GithubEvent[]): string {
  const ids = events.map((event) => event.id).join("\0");
  return `gh-${createHash("sha256").update(`${watchKey}\0${ids}`).digest("base64url").slice(0, 40)}`;
}
