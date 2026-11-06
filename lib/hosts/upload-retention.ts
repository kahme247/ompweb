// Retention of sent uploads, the daemon's side (docs/specs/2026-11-02-file-uploads-design.md, U6): main sends the
// `uploadRetentionDays` setting (op `setUploadRetention`), the daemon keeps it in `<agent dir>/omp-web/upload-retention.json`
// and deletes files older than that from every session's `local://uploads/`, at start and every 24 h.
// Loaded by the daemon through jiti: no `@/` imports and no Bun APIs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, getArchivedSessionsDir, getSessionsDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { isUploadRetentionDays } from "../upload-limits";
import { HostOpError } from "./link-protocol";
import { UPLOADS_LOCAL_DIR, uploadOwnerNamespace, withUploadNameLock } from "./uploads";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where sent uploads live: `<sessions>/<project>/<session>/local/uploads/*`, the same under the archive (a session's
 * artifacts directory moves there whole), and this daemon's namespace within the Windows fallback uploads directory.
 * `tmp` is null where that fallback never applies. */
export interface RetentionRoots {
  sessions: string;
  archive: string;
  tmp: { dir: string; namespace: string } | null;
}

function defaultRoots(): RetentionRoots {
  return {
    sessions: getSessionsDir(), archive: getArchivedSessionsDir(),
    tmp: process.platform === "win32" ? { dir: join(tmpdir(), "omp-local"), namespace: uploadOwnerNamespace() } : null,
  };
}

/** The directories (never symlinks) directly in `dir`; empty when it cannot be read. */
async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[ompweb host] upload retention: cannot read ${dir}: ${(error as Error).message}`);
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

/** Delete the regular files in `dir` last modified before the cutoff `cutoff()` returns at that moment (null: stop). A
 * symlink, directory or anything else is left alone; an entry that fails (gone, not ours to delete) is skipped and tried
 * at the next sweep. Returns false once the policy says stop. */
async function sweepDir(dir: string, cutoff: () => number | null): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[ompweb host] upload retention: cannot read ${dir}: ${(error as Error).message}`);
    return true;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      // Locked from stat to unlink: a publication cannot replace this name with a fresh file in between.
      const stop = await withUploadNameLock(async () => {
        const info = await lstat(file);
        if (!info.isFile()) return false;
        // Read per file: a setting made longer (or Never) while this sweep runs must not lose a file to the old one.
        const current = cutoff();
        if (current === null) return true;
        if (info.mtimeMs < current) await unlink(file);
        return false;
      });
      if (stop) return false;
    } catch {
      // Skipped.
    }
  }
  return true;
}

/** Delete every sent upload older than `days` days at `now`. Fixed depth: only the uploads folders, never a tree below
 * them, and a `local` or `uploads` that is a symlink is not followed. The folders stay. Staged files keep U3's 24 h rule.
 * The symlink checks see each directory as it is when checked: a directory swapped for a link during the sweep is not
 * caught (Node has no `unlinkat`), which only a process already running as this user can do. `days` may be a function,
 * read before each delete, so a sweep follows a setting changed while it runs (null: stop). */
export async function sweepSentUploads(days: number | (() => number | null), now = Date.now(), roots: RetentionRoots = defaultRoots()): Promise<void> {
  const cutoff = () => {
    const current = typeof days === "function" ? days() : days;
    return current === null ? null : now - current * DAY_MS;
  };
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
  if (roots.tmp && await isRealDir(roots.tmp.dir)) {
    for (const session of await subdirs(roots.tmp.dir)) {
      const uploads = join(session, UPLOADS_LOCAL_DIR);
      if (await isRealDir(uploads)) folders.push(join(uploads, roots.tmp.namespace));
    }
  }
  for (const folder of folders) {
    if (await isRealDir(folder) && !(await sweepDir(folder, cutoff))) return;
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

  /** A sweep is idempotent and skips entries that vanish under it, so two at once are harmless. It reads the setting
   * before each delete, so one still running after a change follows the new value. */
  sweep(now = Date.now()): Promise<void> {
    return typeof this.days === "number" ? sweepSentUploads(() => (typeof this.days === "number" ? this.days : null), now, this.roots) : Promise.resolve();
  }

  /** Op setUploadRetention: keep `days` (null: for ever), then sweep without holding up the answer. The same value as
   * the last one does nothing, so a daemon that links over and over does not walk every session each time. The file is
   * not secret, and one that is corrupt reads as none (main sends the value again at every hello): a plain write. */
  set(days: unknown): null {
    if (!isUploadRetentionDays(days)) throw new HostOpError(400, "invalid_request", "days must be a whole number from 1 to 3650, or null");
    if (days === this.days) return null;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ days })}\n`);
    this.days = days;
    void this.sweep();
    return null;
  }
}
