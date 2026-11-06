// The local host daemon's own pid (`<agent dir>/omp-web/host.pid`), shared by
// `ompweb host` (which writes it) and the web server (which reads it). Pure
// Node: no daemon or spawn code, no `next/*` or `@/` imports.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

/**
 * How long a pid record is trusted. The daemon stamps it whenever its link
 * ends and before every dial attempt, so a live daemon's record is seconds old
 * while its link is down (the only time it is read); an older one belongs to a
 * daemon that died, and its pid may since belong to another process.
 */
export const HOST_PID_FRESH_MS = 120_000;

/** `<agent dir>/omp-web/host.pid`: one record per agent dir, beside `host.json`. */
function hostPidFile(): string {
  return join(getAgentDir(), "omp-web", "host.pid");
}

/**
 * Record this daemon as the machine's host daemon for `url`, owner-only and
 * replaced atomically. Best effort: a read-only agent dir must not stop the
 * daemon, it only leaves the reconnect window without the exact signal.
 */
export function writeHostPid(pid: number, url: string): void {
  const file = hostPidFile();
  const temp = `${file}.${pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ pid, url: url.replace(/\/+$/, ""), at: Date.now() })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    console.warn(`[omp-web] could not record the host daemon's pid: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The pid of the live daemon that serves `url`, or null. A record of another
 * server (a dev server beside a production daemon, say) is not this machine's
 * daemon for us: its children are not ours. A pid that is gone, or a record no
 * daemon refreshed, is not a daemon either.
 */
export function readHostPid(url: string, now = Date.now()): number | null {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(hostPidFile(), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(saved) || typeof saved.url !== "string" || saved.url !== url.replace(/\/+$/, "")) return null;
  const { pid, at } = saved;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return null;
  if (typeof at !== "number" || now - at >= HOST_PID_FRESH_MS) return null;
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: another user's process, never our daemon.
    return null;
  }
  return pid;
}

/** Remove the record, but only while it is this daemon's (a newer daemon may own it already). */
export function clearHostPid(pid: number): void {
  try {
    const saved: unknown = JSON.parse(readFileSync(hostPidFile(), "utf8"));
    if (isRecord(saved) && saved.pid === pid) rmSync(hostPidFile(), { force: true });
  } catch {
    // Missing or unreadable: nothing to clear.
  }
}
