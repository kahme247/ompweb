import { createReadStream, createWriteStream } from "fs";
import { readdirSync, statSync } from "fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink } from "fs/promises";
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

function collectArchives(directory: string, files: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectArchives(fullPath, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl.gz")) files.push(fullPath);
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
  const files = collectArchives(root);
  const records = await Promise.all(files.map(async (filePath) => {
    try {
      if (statSync(filePath).size > MAX_ARCHIVE_COMPRESSED_BYTES) return undefined;
      return parseArchivePrefix(await readGzipPrefix(filePath, ARCHIVE_PREFIX_BYTES), filePath, root);
    } catch {
      return undefined;
    }
  }));
  return records.filter((record): record is ArchivedSessionRecord => Boolean(record)).sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());
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
  }));
}

/** HTTP status for a `restoreArchivedSession` failure message. */
export function restoreFailureStatus(message: string): number {
  return message.includes("Invalid archive key") || message.includes("Invalid archived session ID") || message.includes("required") ? 400 : message.includes("not found") ? 404 : message.includes("already exists") ? 409 : 500;
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
    try { canonical = await realpath(current); } catch { throw new Error("Invalid archive key"); }
    const canonicalRelative = path.relative(canonicalRoot, canonical);
    if (!canonicalRelative || canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) throw new Error("Invalid archive key");
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

export async function restoreArchivedSession(key: string, sessionsRoot = getSessionsDir(), archiveRoot = getArchivedSessionsDir()): Promise<string> {
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
  if (!sourceStat?.isFile()) throw new Error("Archived session not found");
  if (await lstatIfExists(destination) || await lstatIfExists(destinationArtifacts)) throw new Error("Active session destination already exists");

  if (sourceStat.size > MAX_ARCHIVE_COMPRESSED_BYTES) throw new Error("Archived session compressed size exceeds 256 MiB limit; archive was not consumed");
  await mkdir(path.dirname(destination), { recursive: true });
  await validateRestorePath(activeRoot, destination);
  await validateRestorePath(activeRoot, destinationArtifacts);
  const tempDir = await mkdtemp(path.join(path.dirname(destination), ".omp-web-restore-"));
  const tempFile = path.join(tempDir, path.basename(destination));
  let destinationCreated = false;
  let artifactsMoved = false;
  try {
    await validateRestorePath(activeRoot, tempDir);
    await pipeline(
      createReadStream(source),
      archiveSizeLimit("compressed", MAX_ARCHIVE_COMPRESSED_BYTES),
      createGunzip(),
      archiveSizeLimit("expanded", MAX_ARCHIVE_EXPANDED_BYTES),
      createWriteStream(tempFile, { flags: "wx" }),
    );
    const sessionId = await readArchivedSessionId(tempFile);
    await validateRestorePath(activeRoot, destination);
    await validateRestorePath(activeRoot, destinationArtifacts);
    // A hard link publishes atomically without overwriting a concurrently created transcript.
    try {
      await link(tempFile, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Active session destination already exists");
      throw error;
    }
    destinationCreated = true;
    const artifactStat = await lstatIfExists(sourceArtifacts);
    if (artifactStat) {
      await validateRestorePath(archiveBase, sourceArtifacts);
      if (!artifactStat.isDirectory()) throw new Error("Archived artifacts are invalid");
      if (await lstatIfExists(destinationArtifacts)) throw new Error("Active session destination already exists");
      await mkdir(path.dirname(destinationArtifacts), { recursive: true });
      await rename(sourceArtifacts, destinationArtifacts);
      artifactsMoved = true;
    }
    await unlink(source);
    invalidateSessionFileListCache();
    return sessionId;
  } catch (error) {
    if (artifactsMoved) {
      try { await rename(destinationArtifacts, sourceArtifacts); } catch { /* preserve original failure */ }
    }
    if (destinationCreated) {
      try { await unlink(destination); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
