import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { HostOpError } from "./hosts/link-protocol";
import { getAgentDir } from "./omp/paths";

/** Main-only: coordinate restores across web processes sharing an agent directory. */
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
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("CREATE TABLE IF NOT EXISTS claims (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL)");
    const insert = db.prepare("INSERT INTO claims (session_id, owner, pid) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    claimed = insert.run(sessionId, owner, process.pid).changes === 1;
    if (!claimed) {
      const occupied = db.prepare("SELECT owner, pid FROM claims WHERE session_id = ?").get(sessionId) as { owner: string; pid: number } | null;
      if (occupied) {
        try {
          process.kill(occupied.pid, 0);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
            db.prepare("DELETE FROM claims WHERE session_id = ? AND owner = ?").run(sessionId, occupied.owner);
            claimed = insert.run(sessionId, owner, process.pid).changes === 1;
          }
        }
      }
    }
    if (!claimed) throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} is already being restored`);
    return await restore();
  } catch (error) {
    if (!claimed && error && typeof error === "object" && "errno" in error && error.errno === 5) {
      throw new HostOpError(409, "archive_restore_busy", `Session ${sessionId} restore lock is busy`);
    }
    throw error;
  } finally {
    try {
      if (claimed) db.prepare("DELETE FROM claims WHERE session_id = ? AND owner = ?").run(sessionId, owner);
    } finally { db.close(true); }
  }
}
