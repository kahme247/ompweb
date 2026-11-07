import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { HostOpError } from "./hosts/link-protocol";
import { getAgentDir } from "./omp/paths";

const LEASE_MS = 30_000;
const RENEW_MS = 10_000;

/** Main-only: coordinate restores across web processes sharing an agent directory (not separate web servers sharing a daemon). */
export async function withArchiveRestoreLock<T>(sessionId: string, restore: () => Promise<T>): Promise<T> {
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
    db.exec("PRAGMA synchronous = NORMAL");
    // A lease, not a PID: a dead holder's claim lapses even when its PID is reused.
    db.exec("CREATE TABLE IF NOT EXISTS restore_leases (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, renewed_at INTEGER NOT NULL)");
    claimed = db.transaction(() => {
      const now = Date.now();
      db.prepare("DELETE FROM restore_leases WHERE session_id = ? AND renewed_at < ?").run(sessionId, now - LEASE_MS);
      return db.prepare("INSERT INTO restore_leases (session_id, owner, renewed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(sessionId, owner, now).changes === 1;
    }).immediate();
    if (!claimed) throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} is already being restored`);
    renewal = setInterval(() => {
      try {
        db.prepare("UPDATE restore_leases SET renewed_at = ? WHERE session_id = ? AND owner = ?").run(Date.now(), sessionId, owner);
      } catch { /* busy: the next renewal retries well within the lease */ }
    }, RENEW_MS);
    renewal.unref();
    return await restore();
  } catch (error) {
    if (!claimed && error && typeof error === "object" && "errno" in error && error.errno === 5) {
      throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} restore lock is busy`);
    }
    throw error;
  } finally {
    clearInterval(renewal);
    try {
      if (claimed) db.prepare("DELETE FROM restore_leases WHERE session_id = ? AND owner = ?").run(sessionId, owner);
    } finally { db.close(true); }
  }
}
