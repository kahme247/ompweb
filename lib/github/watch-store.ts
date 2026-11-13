import { mkdirSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import type { ItemKind } from "./api";
import type { WatchCursor } from "./events";

/**
 * Server-only persistent GitHub watch state in omp-web's data directory: which
 * session watches which item, the cursor each watch has reported up to, the
 * update a watch is about to post (so a crash re-adds the same outbox entry),
 * the comments the agent posted, and the read grants. Every omp-web instance
 * sharing the agent directory shares it; SQLite serializes their writes.
 */

export const MAX_WATCHES_PER_SESSION = 20;

export interface Watch {
  sessionId: string;
  itemKey: string;
  kind: ItemKind;
  cursor: WatchCursor;
}

export interface PendingUpdate {
  entryId: string;
  message: string;
  cursor: WatchCursor;
  final: boolean;
}

export function repoKeyOf(target: { owner: string; repo: string }): string {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}

export function itemKeyOf(target: { owner: string; repo: string; number: number }): string {
  return `${repoKeyOf(target)}#${target.number}`;
}

declare global {
  var __ompGithubWatchStore: { path: string; db: Database } | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (session_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, cursor_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, item_key));
CREATE TABLE IF NOT EXISTS pending (session_id TEXT NOT NULL, item_key TEXT NOT NULL, entry_id TEXT NOT NULL, message TEXT NOT NULL, cursor_json TEXT NOT NULL, final INTEGER NOT NULL, PRIMARY KEY (session_id, item_key));
CREATE TABLE IF NOT EXISTS posted (item_key TEXT NOT NULL, comment_id TEXT NOT NULL, PRIMARY KEY (item_key, comment_id));
CREATE TABLE IF NOT EXISTS read_grants (session_id TEXT NOT NULL, repo_key TEXT NOT NULL, PRIMARY KEY (session_id, repo_key));
`;

function transaction<T>(db: Database, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** The store for the current agent directory; reopened when PI_CODING_AGENT_DIR changes. */
function db(): Database {
  const dir = join(getAgentDir(), "omp-web");
  const path = join(dir, "github-watches.sqlite");
  const cached = globalThis.__ompGithubWatchStore;
  if (cached?.path === path) return cached.db;
  const database = open(dir, path);
  // Only a working store replaces the cached one; a failed open leaves it usable.
  closeWatchStore();
  globalThis.__ompGithubWatchStore = { path, db: database };
  return database;
}

/** Closes the cached store. `close(true)` finalizes the statements still alive: without it the file stays open until GC, and Windows keeps it locked. */
export function closeWatchStore(): void {
  globalThis.__ompGithubWatchStore?.db.close(true);
  globalThis.__ompGithubWatchStore = undefined;
}

function open(dir: string, path: string): Database {
  mkdirSync(dir, { recursive: true });
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    // Switching a new database to WAL takes an exclusive lock that ignores busy_timeout; another omp-web may hold it.
    for (let attempt = 0; ; attempt++) {
      try {
        database.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (!isRecord(error) || error.errno !== 5 || attempt >= 250) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    // NORMAL is the documented safe pairing with WAL: no corruption, only the last commits can be lost on power failure.
    database.exec("PRAGMA synchronous = NORMAL");
    transaction(database, () => database.exec(SCHEMA));
    return database;
  } catch (error) {
    database.close(true);
    throw error;
  }
}

// ---------------------------------------------------------------- watches

type WatchRow = { session_id: string; item_key: string; kind: ItemKind; cursor_json: string };

const toWatch = (row: WatchRow): Watch => ({
  sessionId: row.session_id,
  itemKey: row.item_key,
  kind: row.kind,
  cursor: JSON.parse(row.cursor_json) as WatchCursor,
});

/** `exists` leaves the stored cursor as it is; `limit` refuses the watch beyond MAX_WATCHES_PER_SESSION. */
export function addWatch(sessionId: string, itemKey: string, kind: ItemKind, baseline: WatchCursor): "added" | "exists" | "limit" {
  const d = db();
  return transaction(d, () => {
    if (d.prepare("SELECT 1 FROM watches WHERE session_id = ? AND item_key = ?").get(sessionId, itemKey)) return "exists";
    const { n } = d.prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM watches WHERE session_id = ?").get(sessionId)!;
    if (n >= MAX_WATCHES_PER_SESSION) return "limit";
    d.prepare("INSERT INTO watches (session_id, item_key, kind, cursor_json, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, itemKey, kind, JSON.stringify(baseline), Date.now());
    return "added";
  });
}

export function removeWatch(sessionId: string, itemKey: string): boolean {
  const d = db();
  return transaction(d, () => {
    d.prepare("DELETE FROM pending WHERE session_id = ? AND item_key = ?").run(sessionId, itemKey);
    return d.prepare("DELETE FROM watches WHERE session_id = ? AND item_key = ?").run(sessionId, itemKey).changes > 0;
  });
}

export function removeSessionWatches(sessionId: string): void {
  const d = db();
  transaction(d, () => {
    d.prepare("DELETE FROM pending WHERE session_id = ?").run(sessionId);
    d.prepare("DELETE FROM watches WHERE session_id = ?").run(sessionId);
  });
}

export function listWatches(): Watch[] {
  return db().prepare<WatchRow, []>("SELECT session_id, item_key, kind, cursor_json FROM watches ORDER BY created_at").all().map(toWatch);
}

/** Saves the cursor, or deletes the watch when `final`; either way the watch's pending update is cleared in the same transaction. */
export function commitUpdate(sessionId: string, itemKey: string, cursor: WatchCursor, final: boolean): void {
  const d = db();
  transaction(d, () => {
    d.prepare("DELETE FROM pending WHERE session_id = ? AND item_key = ?").run(sessionId, itemKey);
    if (final) d.prepare("DELETE FROM watches WHERE session_id = ? AND item_key = ?").run(sessionId, itemKey);
    else d.prepare("UPDATE watches SET cursor_json = ? WHERE session_id = ? AND item_key = ?").run(JSON.stringify(cursor), sessionId, itemKey);
  });
}

// ---------------------------------------------------------------- pending updates

type PendingRow = { entry_id: string; message: string; cursor_json: string; final: number };

/** The update a watch is about to post, stored before its outbox add so a crash replays the same entry id. */
export function setPending(sessionId: string, itemKey: string, pending: PendingUpdate): void {
  db()
    .prepare("INSERT OR REPLACE INTO pending (session_id, item_key, entry_id, message, cursor_json, final) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sessionId, itemKey, pending.entryId, pending.message, JSON.stringify(pending.cursor), pending.final ? 1 : 0);
}

export function getPending(sessionId: string, itemKey: string): PendingUpdate | null {
  const row = db()
    .prepare<PendingRow, [string, string]>("SELECT entry_id, message, cursor_json, final FROM pending WHERE session_id = ? AND item_key = ?")
    .get(sessionId, itemKey);
  if (!row) return null;
  return { entryId: row.entry_id, message: row.message, cursor: JSON.parse(row.cursor_json) as WatchCursor, final: row.final === 1 };
}

// ---------------------------------------------------------------- posted comments

export function recordPosted(itemKey: string, commentId: string): void {
  db().prepare("INSERT OR IGNORE INTO posted (item_key, comment_id) VALUES (?, ?)").run(itemKey, commentId);
}

export function postedIds(itemKey: string): Set<string> {
  return new Set(
    db()
      .prepare<{ comment_id: string }, [string]>("SELECT comment_id FROM posted WHERE item_key = ?")
      .all(itemKey)
      .map((row) => row.comment_id),
  );
}

// ---------------------------------------------------------------- read grants

export function hasReadGrant(sessionId: string, repoKey: string): boolean {
  return db().prepare("SELECT 1 FROM read_grants WHERE session_id = ? AND repo_key = ?").get(sessionId, repoKey) !== null;
}

export function grantRead(sessionId: string, repoKey: string): void {
  db().prepare("INSERT OR IGNORE INTO read_grants (session_id, repo_key) VALUES (?, ?)").run(sessionId, repoKey);
}

/**
 * A session move: the moved session's watches replace any the new id already
 * holds for the same items, and keep their pending updates; read grants the
 * new id already has are kept.
 */
export function renameSession(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const d = db();
  transaction(d, () => {
    const movedItems = "SELECT item_key FROM watches WHERE session_id = ?";
    d.prepare(`DELETE FROM pending WHERE session_id = ? AND item_key IN (${movedItems})`).run(newId, oldId);
    d.prepare(`DELETE FROM watches WHERE session_id = ? AND item_key IN (${movedItems})`).run(newId, oldId);
    d.prepare("UPDATE watches SET session_id = ? WHERE session_id = ?").run(newId, oldId);
    d.prepare("UPDATE pending SET session_id = ? WHERE session_id = ?").run(newId, oldId);
    d.prepare("UPDATE OR IGNORE read_grants SET session_id = ? WHERE session_id = ?").run(newId, oldId);
    d.prepare("DELETE FROM read_grants WHERE session_id = ?").run(oldId);
  });
}
