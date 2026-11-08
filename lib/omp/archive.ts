import { createReadStream, createWriteStream } from "fs";
import { linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync } from "fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "fs/promises";
import { randomUUID } from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import path from "path";
import type { Dirent } from "fs";
import type { ArchivedSessionInfo, SessionHeader } from "../types";
import { getArchivedSessionsDir, getSessionsDir } from "./paths";
import { invalidateSessionFileListCache, parseTitleSlotLine, SESSION_TITLE_SLOT_BYTES, type SessionStatus } from "./session-files";
import { isValidSessionId } from "../session-file-references-core";

export interface ArchivedSessionRecord {
  key: string;
  id: string;
  cwd: string;
  title?: string;
  created: Date;
  archivedAt: Date;
  messageCount: number;
  firstMessage: string;
  size: number;
  status?: SessionStatus;
  /** Captured by a restore: discovery evidence only, never an actionable restore target. */
  restorePending?: true;
}

const ARCHIVE_PREFIX_BYTES = 128 * 1024;
export const MAX_ARCHIVE_COMPRESSED_BYTES = 256 * 1024 * 1024;
/** Restores never expand more than 256 MiB into the staged transcript. */
export const MAX_ARCHIVE_EXPANDED_BYTES = 256 * 1024 * 1024;

function archiveRootPath(root: string): string {
  return path.resolve(root);
}

function normalizeArchiveKey(key: string): string {
  if (!key || key.includes("\\") || path.isAbsolute(key)) throw new Error("Invalid archive key");
  const normalized = path.posix.normalize(key.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized.endsWith("/..") || !normalized.endsWith(".jsonl.gz")) {
    throw new Error("Invalid archive key");
  }
  return normalized;
}

/** Only names emitted by commitRestore: arbitrary similarly named files are not archive evidence. Captures retain a unique
 * physical key and are explicitly discovery-only, never aliases of an ordinary archive's actionable key. */
function capturedArchiveOriginalName(filePath: string): string | null {
  // Basename only, with a newline-safe stem: this parser serves both discovery evidence and artifact-directory pairing.
  return /^([\s\S]*\.jsonl\.gz)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.restore-consume$/i.exec(path.basename(filePath))?.[1] ?? null;
}

function collectArchives(directory: string, files: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return files;
    // An unreadable root/subtree can contain any session's archive. Never turn access or I/O failures into proven absence.
    throw error;
  }
  // OMP archives <session>.jsonl.gz beside its artifacts directory <session>.jsonl. Never recurse into that paired tree:
  // arbitrary uploads there may themselves end in .jsonl.gz or look like captures, without being archive entries.
  // Pair from this same enumeration, including captures whose ordinary .gz name is temporarily absent. Do not blanket-skip
  // .jsonl or hidden directories: those are also valid project path components.
  const artifacts = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const original = entry.name.endsWith(".jsonl.gz") ? entry.name : capturedArchiveOriginalName(entry.name);
    if (original) artifacts.add(original.slice(0, -".gz".length));
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !artifacts.has(entry.name)) collectArchives(fullPath, files);
    else if (entry.isFile() && (entry.name.endsWith(".jsonl.gz") || capturedArchiveOriginalName(entry.name))) files.push(fullPath);
  }
  return files;
}

async function readGzipPrefix(filePath: string, limit: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const input = createReadStream(filePath);
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let length = 0;
  let settled = false;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    if (error) reject(error);
    else resolve(Buffer.concat(chunks, length));
  };
  input.on("error", finish);
  gunzip.on("error", finish);
  gunzip.on("data", (chunk: Buffer) => {
    if (settled) return;
    const remaining = limit - length;
    if (remaining <= 0) {
      input.destroy();
      gunzip.destroy();
      finish();
      return;
    }
    const part = chunk.subarray(0, Math.min(chunk.length, remaining));
    chunks.push(part);
    length += part.length;
    if (length >= limit) {
      input.destroy();
      gunzip.destroy();
      finish();
    }
  });
  gunzip.on("end", () => finish());
  input.pipe(gunzip);
  return promise;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ");
}

function parseArchivePrefix(prefix: Buffer, filePath: string, archiveRoot: string): ArchivedSessionRecord | undefined {
  const lines = prefix.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return undefined;
  let title: string | undefined;
  let headerIndex = 0;
  try {
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    if (first.type === "title" && typeof first.title === "string") {
      title = first.title || undefined;
      headerIndex = 1;
    }
    const header = JSON.parse(lines[headerIndex]) as SessionHeader;
    if (header.type !== "session" || typeof header.id !== "string") return undefined;
    let messageCount = 0;
    let firstMessage = "";
    for (const line of lines.slice(headerIndex + 1)) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (entry.type !== "message" || !entry.message) continue;
        messageCount++;
        if (!firstMessage && entry.message.role === "user") firstMessage = textFromContent(entry.message.content);
      } catch {
        // The final prefix line may be truncated; earlier metadata remains valid.
      }
    }
    const fileStat = statSync(filePath);
    const created = header.timestamp && !Number.isNaN(new Date(header.timestamp).getTime()) ? new Date(header.timestamp) : fileStat.mtime;
    return {
      key: path.relative(archiveRoot, filePath).split(path.sep).join("/"),
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      title: title ?? (typeof header.title === "string" ? header.title : undefined),
      created,
      archivedAt: fileStat.mtime,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      size: fileStat.size,
      status: "unknown",
    };
  } catch {
    return undefined;
  }
}

export async function listArchivedSessions(archiveRoot = getArchivedSessionsDir()): Promise<ArchivedSessionRecord[]> {
  const root = archiveRootPath(archiveRoot);
  const snapshot = () => new Map(collectArchives(root).map((file) => {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("Archive changed during listing; retry discovery");
    return [file, `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`] as const;
  }));
  // Verify both names AND generations after reading. A successful read can be replacement B, while capture A was added
  // after enumeration: merely rescanning on ENOENT silently drops A and falsely proves that session absent.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const before = snapshot();
      const records = await Promise.all([...before.keys()].map(async (filePath) => {
        if (statSync(filePath).size > MAX_ARCHIVE_COMPRESSED_BYTES) return undefined;
        const record = parseArchivePrefix(await readGzipPrefix(filePath, ARCHIVE_PREFIX_BYTES), filePath, root);
        if (record && capturedArchiveOriginalName(filePath)) record.restorePending = true;
        return record;
      }));
      const after = snapshot();
      const stable = before.size === after.size && [...before].every(([file, generation]) => after.get(file) === generation);
      if (!stable) {
        if (attempt === 0) continue;
        throw new Error("Archive changed during listing; retry discovery");
      }
      // A captured entry keeps its unique physical key. It must never alias an ordinary archive's actionable key, even when
      // both compressed headers have the same session ID.
      return records.filter((record): record is ArchivedSessionRecord => record !== undefined)
        .sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        if (attempt === 0) continue;
        throw new Error("Archive changed during listing; retry discovery");
      }
      // Corrupt gzip/unreadable archive: its unknown session ID may be the held message's owner. Reject discovery rather
      // than silently skip it and falsely prove absence; this intentionally makes the whole host temporarily unavailable.
      throw error;
    }
  }
  throw new Error("Archive changed during listing; retry discovery");
}

/** The Archived Sessions browser's entries (dates as ISO strings): also what a host sends over its link. */
export async function listArchivedSessionInfos(archiveRoot = getArchivedSessionsDir()): Promise<ArchivedSessionInfo[]> {
  return (await listArchivedSessions(archiveRoot)).map((archive) => ({
    key: archive.key,
    id: archive.id,
    cwd: archive.cwd,
    ...(archive.title ? { name: archive.title } : {}),
    created: archive.created.toISOString(),
    archivedAt: archive.archivedAt.toISOString(),
    messageCount: archive.messageCount,
    firstMessage: archive.firstMessage,
    size: archive.size,
    status: archive.status,
    ...(archive.restorePending ? { restorePending: true as const } : {}),
  }));
}

/** HTTP status for a `restoreArchivedSession` failure message. */
export function restoreFailureStatus(message: string): number {
  return message.includes("already exists") || message.includes("generation changed") ? 409 : message.includes("Invalid archive key") || message.includes("Invalid archived session ID") || message.includes("required") ? 400 : message.includes("not found") ? 404 : 500;
}

async function validateRestorePath(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Invalid archive key");
  let ancestor = root;
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const canonicalRoot = path.join(await realpath(ancestor), ...missing);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    // Check every ancestor, not only the final path: a symlink may escape and re-enter.
    let canonical: string;
    try {
      canonical = await realpath(current);
    } catch (error) {
      // A competing commit may remove and recreate a directory while realpath is pending. Absence is fine; a recreated
      // ordinary directory needs fresh validation, not a traversal error. A dangling symlink is still refused.
      if (errnoCode(error) === "ENOENT") {
        const now = await lstatIfExists(current);
        if (!now) break;
        if (!now.isSymbolicLink()) return validateRestorePath(root, target);
      }
      throw new Error("Invalid archive key");
    }
    if (escapesRoot(canonicalRoot, canonical)) {
      // realpath may resolve an opened directory at its new location after another commit renames it. If the original
      // pathname disappeared, this is absence, not an escaping link. The guarded commit validates the paths again.
      if (!(await lstatIfExists(current))) break;
      throw new Error("Invalid archive key");
    }
  }
}

/** Whether `canonical` is the root itself or outside it (both refused: a restore touches only what is strictly inside). */
function escapesRoot(canonicalRoot: string, canonical: string): boolean {
  const relative = path.relative(canonicalRoot, canonical);
  return !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** `validateRestorePath`, synchronously, for the commit: the async checks before it can be a thread-pool turn stale, and
 * another process can swap a directory for a link in that time. Run last, under the caller's guard, right before the moves. */
function validateRestorePathSync(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Invalid archive key");
  let ancestor = root;
  const missing: string[] = [];
  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const canonicalRoot = path.join(realpathSync(ancestor), ...missing);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      lstatSync(current);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") break;
      throw error;
    }
    let canonical: string;
    try {
      canonical = realpathSync(current);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        const now = lstatSyncIfExists(current);
        if (!now) break;
        if (!now.isSymbolicLink()) return validateRestorePathSync(root, target);
      }
      throw new Error("Invalid archive key");
    }
    if (escapesRoot(canonicalRoot, canonical)) {
      if (!lstatSyncIfExists(current)) break;
      throw new Error("Invalid archive key");
    }
  }
}

async function lstatIfExists(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function lstatSyncIfExists(filePath: string) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    return undefined;
  }
}

/**
 * Moves the directory `from` to `to`, which must not exist, and never replaces anything at `to`. POSIX rename(2) replaces an
 * empty directory at its target, so a rename after an existence check silently replaces one that another process created in
 * between (an attachment's `mkdir -p`, say). Here `to` is first taken with mkdir, which is exclusive: once it succeeds the
 * name is this call's, and the rename replaces only that empty directory of its own. If something has been put into it since,
 * the rename fails (ENOTEMPTY) rather than replace it, and what was put there is never removed (rmdir refuses a directory
 * that is not empty, so only our own, still-empty claim is dropped). Windows' MoveFileEx refuses to replace a directory, so
 * there a plain rename already never does.
 */
function moveDirectoryNoReplace(from: string, to: string): void {
  const taken = () => new Error("Active session destination already exists");
  if (process.platform === "win32") {
    try {
      renameSync(from, to);
    } catch (error) {
      if (lstatSyncIfExists(to)) throw taken();
      throw error;
    }
    return;
  }
  try {
    mkdirSync(to);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") throw taken();
    throw error;
  }
  try {
    renameSync(from, to);
  } catch (error) {
    try { rmdirSync(to); } catch { /* content was put in it: not ours to remove */ }
    // `from` gone: another restore consumed it.
    if (["ENOTEMPTY", "EEXIST", "ENOENT"].includes(errnoCode(error) ?? "")) throw taken();
    throw error;
  }
}

/** Whether `first` and `second` are the same file (a hard link of it), by device and inode. */
function isSameFile(first: string, second: string): boolean {
  try {
    const a = lstatSync(first, { bigint: true });
    const b = lstatSync(second, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * Undoes the commit's publish: removes the transcript this restore linked at `destination` (`tempFile` is its other name).
 * It never deletes a file it did not create. Whatever is at `destination` is first renamed away, atomically, to a name of
 * its own, so the identity check and the removal are of that one file and not of a path another process can swap; a file
 * that is not ours is linked back, exclusively. Returns the path a file this call could not put right is left at, or null.
 */
function takeBackTranscript(destination: string, tempFile: string): string | null {
  const taken = `${destination}.${randomUUID()}.rollback`;
  try {
    renameSync(destination, taken);
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? null : destination;
  }
  if (isSameFile(taken, tempFile)) {
    try { unlinkSync(taken); return null; } catch { return taken; }
  }
  try {
    linkSync(taken, destination);
    unlinkSync(taken);
    return null;
  } catch {
    return taken;
  }
}

/**
 * The restore's commit: the archived artifacts move into place, the transcript is published, and the archive entry is
 * consumed, in that order and all synchronously.
 *
 * The order is the point. A published transcript makes the session visible, and whatever then acts on it (an upload attaching
 * to it, a tab opening it) can create its artifacts directory. Moving the artifacts after the transcript raced that: the
 * restore found the directory taken, rolled the transcript back, and left that directory behind, which then refused every
 * retry. With the artifacts first the session is never visible without them (an attachment finds the archived names and
 * avoids them). With no `await` between the steps nothing else in this process runs between them, and the caller's guard
 * holds its lock across all of it. Other processes can still act at any instant, so every step is exclusive or
 * identity-checked rather than a check followed by an act: directories move by `moveDirectoryNoReplace`, the transcript by
 * an exclusive hard link, and the undo by `takeBackTranscript`. A transcript or artifacts directory that appears at the
 * destination is never merged into, replaced or removed, and a step that fails undoes the earlier ones, newest first.
 *
 * A process killed inside this step (SIGKILL, an OOM kill) leaves its `.restore-lock` directory behind and may leave artifacts
 * at the destination without a transcript. Never expire/remove the marker while a restorer can still run: stop all owners,
 * inspect and repair the partial commit, then remove the orphaned marker manually. A power loss or kernel crash is not
 * covered: nothing here calls fsync or keeps a journal, so which directory operations reached disk is not guaranteed.
 */

type ArchiveGeneration = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };

/** The pin retains the inode until staging and commit end, so an unlinked generation cannot have its inode reused. Size and
 * mtime also reject in-place changes; normal archive publication replaces the inode atomically. */
function matchesArchiveGeneration(file: string, expected: ArchiveGeneration): boolean {
  try {
    const actual = lstatSync(file, { bigint: true });
    return actual.isFile() && actual.dev === expected.dev && actual.ino === expected.ino
      && actual.size === expected.size && actual.mtimeNs === expected.mtimeNs;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Restore a captured pathname without overwriting a replacement installed meanwhile. On conflict keep the captured entry
 * at its recovery name, never silently delete either generation. */
function returnCapturedArchive(captured: string, source: string): string | null {
  try {
    linkSync(captured, source);
    unlinkSync(captured);
    return null;
  } catch {
    return captured;
  }
}
/** A filesystem claim coordinates the whole commit across independent web/daemon processes. Artifact source/destination
 * observations cannot safely coordinate it: another process may move artifacts between those observations, and a loser
 * can then publish the transcript before the mover does, causing the mover to roll the winner's artifacts back.
 * Never expire this claim: a suspended holder can still publish. A killed holder requires manual recovery. */
function commitRestore(plan: { archiveBase: string; activeRoot: string; source: string; sourceArtifacts: string; destination: string; destinationArtifacts: string; tempFile: string; generation: ArchiveGeneration }): void {
  validateRestorePathSync(plan.activeRoot, plan.destination);
  const claim = `${plan.destination}.restore-lock`;
  validateRestorePathSync(plan.activeRoot, claim);
  try {
    mkdirSync(claim);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") throw new Error(`Active session destination already exists (restore commit claimed at ${claim}; if its owner was killed, manual recovery is required)`);
    throw error;
  }
  const identity = lstatSync(claim, { bigint: true });
  try {
    commitRestoreOwned(plan);
  } finally {
    const current = lstatSync(claim, { bigint: true });
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`Restore claim changed at ${claim}; manual recovery is required`);
    rmdirSync(claim);
  }
}

function commitRestoreOwned({ archiveBase, activeRoot, source, sourceArtifacts, destination, destinationArtifacts, tempFile, generation }: { archiveBase: string; activeRoot: string; source: string; sourceArtifacts: string; destination: string; destinationArtifacts: string; tempFile: string; generation: ArchiveGeneration }): void {
  validateRestorePathSync(archiveBase, source);
  validateRestorePathSync(archiveBase, sourceArtifacts);
  validateRestorePathSync(activeRoot, destination);
  validateRestorePathSync(activeRoot, destinationArtifacts);
  // Staging happened before ownership was acquired: a previous owner may already have consumed the archive.
  if (!lstatSyncIfExists(source)?.isFile()) {
    if (lstatSyncIfExists(destination)) throw new Error("Active session destination already exists");
    throw new Error("Archived session not found");
  }
  if (!matchesArchiveGeneration(source, generation)) throw new Error("Archived session generation changed; retry restore");
  const artifacts = lstatSyncIfExists(sourceArtifacts);
  if (artifacts && !artifacts.isDirectory()) throw new Error("Archived artifacts are invalid");
  // The active artifacts directory is the session's own: one already there belongs to another session, or to a restore
  // of this one that is running elsewhere.
  if (lstatSyncIfExists(destinationArtifacts)) throw new Error("Active session destination already exists");
  let movedArtifacts = false;
  let published = false;
  // A check followed by unlink(source) can delete a newer archive. Take the pathname atomically first, verify what was
  // actually taken, and consume only this private captured name. A replacement at source is never deleted.
  const captured = `${source}.${randomUUID()}.restore-consume`;
  renameSync(source, captured);
  try {
    if (!matchesArchiveGeneration(captured, generation)) throw new Error("Archived session generation changed; retry restore");
    if (artifacts) {
      moveDirectoryNoReplace(sourceArtifacts, destinationArtifacts);
      movedArtifacts = true;
    }
    // A hard link publishes atomically without overwriting a concurrently created transcript.
    try {
      linkSync(tempFile, destination);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") throw new Error("Active session destination already exists");
      throw error;
    }
    published = true;
    unlinkSync(captured);
  } catch (error) {
    const stranded: string[] = [];
    if (published) {
      const left = takeBackTranscript(destination, tempFile);
      if (left) stranded.push(left);
    }
    if (movedArtifacts) {
      try { moveDirectoryNoReplace(destinationArtifacts, sourceArtifacts); } catch { stranded.push(destinationArtifacts); }
    }
    const left = returnCapturedArchive(captured, source);
    if (left) stranded.push(left);
    if (stranded.length > 0 && error instanceof Error) error.message += `; the restore could not be undone at ${stranded.join(" and ")}`;
    throw error;
  }
}

function archiveSizeLimit(kind: "compressed" | "expanded", limit: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error(`Archived session ${kind} size exceeds 256 MiB limit; archive was not consumed`) : null, bytes > limit ? undefined : chunk);
    },
  });
}

async function readArchivedSessionId(filePath: string): Promise<string> {
  const maxHeaderBytes = 64 * 1024 + SESSION_TITLE_SLOT_BYTES;
  const file = await open(filePath, "r");
  let prefix: string;
  let bytesRead: number;
  try {
    const buffer = Buffer.allocUnsafe(maxHeaderBytes);
    ({ bytesRead } = await file.read(buffer, 0, buffer.length, 0));
    prefix = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
  const lines = prefix.split("\n");
  const headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
  if (lines.length <= headerIndex + 1 && bytesRead === maxHeaderBytes) throw new Error("Archived session header is invalid");
  let header: SessionHeader;
  try {
    header = JSON.parse(lines[headerIndex] ?? "") as SessionHeader;
  } catch {
    throw new Error("Archived session header is invalid");
  }
  if (!header || header.type !== "session") throw new Error("Archived session header is invalid");
  if (typeof header.id !== "string" || !isValidSessionId(header.id)) throw new Error("Invalid archived session ID");
  return header.id;
}

/** Absence during any stage may mean another owner captured the source. Never hide its recovery diagnostic behind 404. */
function throwMissingArchive(activeRoot: string, destination: string): never {
  const claim = `${destination}.restore-lock`;
  validateRestorePathSync(activeRoot, claim);
  if (lstatSyncIfExists(claim)) throw new Error(`Active session destination already exists (restore commit claimed at ${claim}; if its owner was killed, manual recovery is required)`);
  throw new Error("Archived session not found");
}

/** `publish` wraps the restore's whole commit (see `commitRestore`) as one synchronous step: a caller holding a lock across it
 * must never have to await there, and one whose claim may have lapsed refuses in it, before anything moves. */
export async function restoreArchivedSession(key: string, sessionsRoot = getSessionsDir(), archiveRoot = getArchivedSessionsDir(), publish: <T>(run: () => T) => T = (run) => run()): Promise<string> {
  const activeRoot = archiveRootPath(sessionsRoot);
  const archiveBase = archiveRootPath(archiveRoot);
  const relative = normalizeArchiveKey(key);
  const source = path.resolve(archiveBase, relative);
  const destination = path.resolve(activeRoot, relative.slice(0, -3));
  const sourceArtifacts = source.slice(0, -3);
  const destinationArtifacts = destination.slice(0, -6);
  await validateRestorePath(archiveBase, source);
  await validateRestorePath(archiveBase, sourceArtifacts);
  await validateRestorePath(activeRoot, destination);
  await validateRestorePath(activeRoot, destinationArtifacts);
  const sourceStat = await lstatIfExists(source);
  if (!sourceStat?.isFile()) throwMissingArchive(activeRoot, destination);
  if (await lstatIfExists(destination) || await lstatIfExists(destinationArtifacts)) throw new Error("Active session destination already exists");

  if (sourceStat.size > MAX_ARCHIVE_COMPRESSED_BYTES) throw new Error("Archived session compressed size exceeds 256 MiB limit; archive was not consumed");
  await mkdir(path.dirname(destination), { recursive: true });
  await validateRestorePath(activeRoot, destination);
  await validateRestorePath(activeRoot, destinationArtifacts);
  const tempDir = await mkdtemp(path.join(path.dirname(destination), ".omp-web-restore-"));
  const tempFile = path.join(tempDir, path.basename(destination));
  // Same filesystem as the archive, independent of the sessions filesystem. Reading this private hard link pins exactly
  // the source generation staged here, even if another restorer consumes and later re-archives the same pathname.
  const pin = `${source}.${randomUUID()}.restore-pin`;
  try {
    validateRestorePathSync(archiveBase, source);
    try { linkSync(source, pin); } catch (error) {
      if (errnoCode(error) === "ENOENT") throwMissingArchive(activeRoot, destination);
      throw error;
    }
    const generation = lstatSync(pin, { bigint: true });
    if (!generation.isFile()) throw new Error("Invalid archive key");
    await validateRestorePath(activeRoot, tempDir);
    try {
      await pipeline(
        createReadStream(pin),
        archiveSizeLimit("compressed", MAX_ARCHIVE_COMPRESSED_BYTES),
        createGunzip(),
        archiveSizeLimit("expanded", MAX_ARCHIVE_EXPANDED_BYTES),
        createWriteStream(tempFile, { flags: "wx" }),
      );
    } catch (error) {
      // Another restore consumed the archive between the check above and this read: it is gone, not unreadable.
      if (errnoCode(error) === "ENOENT" && !lstatSyncIfExists(source)) throw new Error("Archived session not found");
      throw error;
    }
    const sessionId = await readArchivedSessionId(tempFile);
    // Revalidated again here to refuse early, before the guard is taken; the commit repeats it synchronously, which is the
    // check that counts.
    await validateRestorePath(activeRoot, destination);
    await validateRestorePath(activeRoot, destinationArtifacts);
    await validateRestorePath(archiveBase, sourceArtifacts);
    publish(() => commitRestore({ archiveBase, activeRoot, source, sourceArtifacts, destination, destinationArtifacts, tempFile, generation }));
    invalidateSessionFileListCache();
    return sessionId;
  } finally {
    try { unlinkSync(pin); } catch (error) { if (errnoCode(error) !== "ENOENT") throw error; }
    await rm(tempDir, { recursive: true, force: true });
  }
}
