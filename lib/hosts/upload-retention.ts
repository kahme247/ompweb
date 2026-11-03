// Retention of sent uploads, the daemon's side (docs/specs/2026-11-02-file-uploads-design.md, U6): main sends the
// `uploadRetentionDays` setting (op `setUploadRetention`), the daemon keeps it in `<agent dir>/omp-web/upload-retention.json`
// and deletes files older than that from every session's `local://uploads/`, at start and every 24 h.
// Loaded by the daemon through jiti: no `@/` imports and no Bun APIs.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, getArchivedSessionsDir, getSessionsDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { isUploadRetentionDays } from "../upload-limits";
import { HostOpError } from "./link-protocol";
import { UPLOADS_LOCAL_DIR } from "./uploads";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where sent uploads live: `<sessions>/<project>/<session>/local/uploads/*`, the same under the archive (a session's
 * artifacts directory moves there whole), and on Windows the long-path fallback `<tmp>/omp-local/<session id>/uploads/*`
 * (`sessionLocalRoot` in uploads.ts). `tmp` is null where that fallback never applies. */
export interface RetentionRoots {
  sessions: string;
  archive: string;
  tmp: string | null;
}

function defaultRoots(): RetentionRoots {
  return { sessions: getSessionsDir(), archive: getArchivedSessionsDir(), tmp: process.platform === "win32" ? join(tmpdir(), "omp-local") : null };
}

/** The directories (never symlinks) directly in `dir`; empty when it cannot be read. */
async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Delete the regular files in `dir` last modified before `cutoff`. A symlink, directory or anything else is left alone;
 * an entry that fails (gone, not ours to delete) is skipped and tried at the next sweep. */
async function sweepDir(dir: string, cutoff: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const info = await lstat(file);
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(file);
    } catch {
      // Skipped.
    }
  }
}

/** Delete every sent upload older than `days` days at `now`. Fixed depth: only the uploads folders, never a tree below
 * them, and a `local` or `uploads` that is a symlink is not followed. The folders stay. Staged files keep U3's 24 h rule. */
export async function sweepSentUploads(days: number, now = Date.now(), roots: RetentionRoots = defaultRoots()): Promise<void> {
  const cutoff = now - days * DAY_MS;
  const folders: string[] = [];
  for (const root of [roots.sessions, roots.archive]) {
    for (const project of await subdirs(root)) {
      for (const session of await subdirs(project)) {
        // A symlinked `local` would lead the sweep out of the session.
        const local = join(session, "local");
        if (await isRealDir(local)) folders.push(join(local, UPLOADS_LOCAL_DIR));
      }
    }
  }
  if (roots.tmp) {
    for (const session of await subdirs(roots.tmp)) folders.push(join(session, UPLOADS_LOCAL_DIR));
  }
  for (const folder of folders) {
    if (await isRealDir(folder)) await sweepDir(folder, cutoff);
  }
}

/** The stored days, or undefined when nothing valid is stored. */
function readStored(file: string): number | null | undefined {
  try {
    const stored: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(stored) && isUploadRetentionDays(stored.days)) return stored.days;
  } catch {
    // Absent or unreadable: no sweep until main sends the setting.
  }
  return undefined;
}

export class UploadRetention {
  /** undefined: main has not said yet. null: keep for ever. */
  private days: number | null | undefined;
  /** Sweeps run one after the other. */
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly file: string = join(getAgentDir(), "omp-web", "upload-retention.json"),
    private readonly roots: RetentionRoots = defaultRoots(),
  ) {
    this.days = readStored(file);
  }

  /** Sweep with the stored setting, then again every 24 h (a timer that never keeps the process alive). */
  start(): Promise<void> {
    this.timer ??= setInterval(() => void this.sweep(), DAY_MS);
    this.timer.unref();
    return this.sweep();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  sweep(now = Date.now()): Promise<void> {
    const run = this.queue.then(() => (typeof this.days === "number" ? sweepSentUploads(this.days, now, this.roots) : undefined));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Op setUploadRetention: keep `days` (null: for ever), then sweep without holding up the answer. The same value as
   * the last one does nothing, so a daemon that links over and over does not walk every session each time. */
  set(days: unknown): null {
    if (!isUploadRetentionDays(days)) throw new HostOpError(400, "invalid_request", "days must be a whole number from 1 to 3650, or null");
    if (days === this.days) return null;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ days })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.days = days;
    void this.sweep();
    return null;
  }
}
