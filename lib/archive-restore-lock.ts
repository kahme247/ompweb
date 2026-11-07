import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { HostOpError } from "./hosts/link-protocol";
import { getAgentDir } from "./omp/paths";

const LEASE_MS = 30_000;
const RENEW_MS = 10_000;

/** A restore sent, or about to be sent, to `hostId` under claim token `claim`, whose outcome this server never learned: that
 * daemon may be running it, or be handed its request later by a sender that was suspended. `since`: when the claim last
 * renewed. `instance`: the daemon process that reserved the token (null in a row an earlier build wrote, which recorded none):
 * only that process can revoke the token and say whether its restore runs, so no other answer proves the restore stopped. */
export type HeldRestore = { sessionId: string; hostId: string; claim: string; instance: string | null; since: number };

export type RestoreClaim = {
  /** The row's owner and the token daemons admit a restore by (`restoreReserve`, `restoreArchive`, `restoreFence`). */
  readonly token: string;
  /** `hostId` is about to be sent this claim's restore, already reserved there by the daemon process `instance`. Keeps the
   * session claimed past this request and past this process dying: a lease's clock cannot end a claim whose op can still
   * run, or still be sent, from another machine. Only `release()`, or a later request's `confirmStopped`, drops it. Throws
   * 409 when this request already lost its lease, before anything is sent. */
  hold(hostId: string, instance: string): void;
  /** The host gave a definite answer for the restore: drop the claim now. Never call it on an answer that does not prove this
   * claim's restore ended (a refusal to admit it, an error, silence): the claim then stays held. */
  release(): void;
  /** Run `run`, the step that makes a local restore's transcript visible, only while this claim still owns the session, with
   * the store's write lock held across it: no request can take the session over from a holder suspended past its lease
   * between the check and the publish, and one that takes over afterwards sees the published session. `run` must be
   * synchronous (no await): SQLite waits for a lock by blocking the whole process, so a lock held across an await would
   * freeze this process's event loop, and the await with it, for the busy timeout. */
  publish<T>(run: () => T): T;
};

/**
 * Main-only: coordinate restores across web processes sharing an agent directory (not separate web servers sharing a daemon).
 *
 * `confirmStopped` is asked about a held claim after its request stopped renewing it: the host's restore may be running, or
 * may still be sent. It resolves only once the host has fenced that claim (its restore can no longer start) and reports
 * nothing running, and throws otherwise; the claim is then taken over. Without it such a claim stays busy.
 */
export async function withArchiveRestoreLock<T>(
  sessionId: string,
  restore: (claim: RestoreClaim) => Promise<T>,
  confirmStopped?: (held: HeldRestore) => Promise<void>,
): Promise<T> {
  const dir = join(getAgentDir(), "omp-web");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "archive-restore-locks.sqlite");
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const db = new Database(path);
  const owner = randomUUID();
  let claimed = false;
  let renewal: NodeJS.Timeout | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    // FULL: a held row is the only record that a daemon may still publish, so a power loss must not forget it.
    db.exec("PRAGMA synchronous = FULL");
    // Claims live in `restore_claims` (a lease, not a PID: a dead holder's claim lapses even when its PID is reused; a held
    // row, `host_id` set, never lapses by time). `restore_leases`, the earlier builds' table, becomes a read-only view of it:
    // such a build still reads, but every claim, release or reclaim it attempts fails, so it can neither lapse a held row by
    // its clock nor claim past one. Its live claims move across with the rename. The steps are idempotent and gated by
    // `user_version`, so only the first open after an upgrade writes (a build that made `restore_claims` without `instance`
    // gains it in place, its held rows kept with no instance, which nothing can confirm stopped).
    const SCHEMA_VERSION = 2;
    // SQLite rows are untyped; each is read through a named shape.
    const schemaVersion = () => {
      const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
      return row.user_version;
    };
    if (schemaVersion() < SCHEMA_VERSION) {
      db.transaction(() => {
        // Re-checked under the write lock: another process may have migrated since.
        if (schemaVersion() >= SCHEMA_VERSION) return;
        const kind = (name: string) => {
          const row = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name) as { type: string } | null;
          return row === null ? null : row.type;
        };
        if (kind("restore_leases") === "table") db.exec("ALTER TABLE restore_leases RENAME TO restore_claims");
        db.exec("CREATE TABLE IF NOT EXISTS restore_claims (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, renewed_at INTEGER NOT NULL, host_id TEXT, instance TEXT)");
        const columns = (db.prepare("PRAGMA table_info(restore_claims)").all() as { name: string }[]).map((column) => column.name);
        for (const column of ["host_id", "instance"]) if (!columns.includes(column)) db.exec(`ALTER TABLE restore_claims ADD COLUMN ${column} TEXT`);
        if (kind("restore_leases") === null) db.exec("CREATE VIEW restore_leases AS SELECT session_id, owner, renewed_at FROM restore_claims");
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }).immediate();
    }
    const take = () => db.transaction(() => {
      const now = Date.now();
      // A lease dated ahead (the writer's clock was fast) lapses too, or it would never expire.
      db.prepare("DELETE FROM restore_claims WHERE session_id = ? AND host_id IS NULL AND renewed_at NOT BETWEEN ? AND ?").run(sessionId, now - LEASE_MS, now + LEASE_MS);
      return db.prepare("INSERT INTO restore_claims (session_id, owner, renewed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(sessionId, owner, now).changes === 1;
    }).immediate();
    claimed = take();
    if (!claimed && confirmStopped) {
      const now = Date.now();
      // A held claim still renewing belongs to a request awaiting its host: that one stays busy.
      const held = db.prepare("SELECT owner, host_id, instance, renewed_at FROM restore_claims WHERE session_id = ? AND host_id IS NOT NULL AND renewed_at NOT BETWEEN ? AND ?")
        .get(sessionId, now - LEASE_MS, now + LEASE_MS) as { owner: string; host_id: string; instance: string | null; renewed_at: number } | null;
      if (held) {
        await confirmStopped({ sessionId, hostId: held.host_id, claim: held.owner, instance: held.instance, since: held.renewed_at });
        db.prepare("DELETE FROM restore_claims WHERE session_id = ? AND owner = ?").run(sessionId, held.owner);
        claimed = take();
      }
    }
    if (!claimed) throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} is already being restored`);
    renewal = setInterval(() => {
      try {
        db.prepare("UPDATE restore_claims SET renewed_at = ? WHERE session_id = ? AND owner = ?").run(Date.now(), sessionId, owner);
      } catch { /* busy: the next renewal retries well within the lease */ }
    }, RENEW_MS);
    renewal.unref();
    return await restore({
      token: owner,
      hold(hostId, instance) {
        // Renewed in the same write: the request leaves right after, and a held row that looked stale would be fenced by another request.
        if (db.prepare("UPDATE restore_claims SET host_id = ?, instance = ?, renewed_at = ? WHERE session_id = ? AND owner = ?").run(hostId, instance, Date.now(), sessionId, owner).changes !== 1) {
          throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} restore claim was lost`);
        }
      },
      release() {
        try {
          db.prepare("DELETE FROM restore_claims WHERE session_id = ? AND owner = ?").run(sessionId, owner);
        } catch { /* busy: the row stays held, which the next restore of this session asks the host about */ }
      },
      publish(run) {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (!db.prepare("SELECT 1 FROM restore_claims WHERE session_id = ? AND owner = ?").get(sessionId, owner)) {
            throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} restore claim was lost; the archive was not restored`);
          }
          const result = run();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* already ended */ }
          throw error;
        }
      },
    });
  } catch (error) {
    if (!claimed && error && typeof error === "object" && "errno" in error && error.errno === 5) {
      throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} restore lock is busy`);
    }
    throw error;
  } finally {
    clearInterval(renewal);
    try {
      // A held row outlives this request: only its host's confirmation ends it.
      if (claimed) db.prepare("DELETE FROM restore_claims WHERE session_id = ? AND owner = ? AND host_id IS NULL").run(sessionId, owner);
    } finally { db.close(true); }
  }
}
