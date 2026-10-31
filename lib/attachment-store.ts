import { randomUUID } from "node:crypto";
import { promises as fsp, type Dirent } from "node:fs";
import path from "node:path";
import {
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_BATCH_FILES,
  type AttachmentReferenceData,
  type AttachmentReferenceKind,
} from "./chat-attachments";
import { getAgentDir } from "./omp/paths";

/**
 * Composer path attachments (`/api/attachments`): files and folders the user
 * uploads for the model to read with its own tools. One batch is one chip:
 *
 *   <agent dir>/omp-web/attachments/<batchId>/.omp-web-attachment.json
 *   <agent dir>/omp-web/attachments/<batchId>/<name>          (kind "file")
 *   <agent dir>/omp-web/attachments/<batchId>/<name>/<a>/<b>  (kind "folder")
 *
 * The batch is declared first (paths + sizes, every cap checked before any
 * byte arrives), filled by sequential chunks, then completed. Batches older
 * than `ATTACHMENT_RETENTION_MS` are pruned opportunistically.
 */

export const ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MANIFEST_NAME = ".omp-web-attachment.json";
const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_BYTES = 255;
const BATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/;
// Device names Windows reserves in every directory, with or without an
// extension ("NUL.txt" is still NUL); matched against the part before the
// first dot. Superscript digits are reserved too; COM0/LPT0 are not.
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

export class AttachmentError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export interface AttachmentBatchFile {
  path: string;
  size: number;
}

export interface AttachmentBatchRequest {
  kind: AttachmentReferenceKind;
  name: string;
  files: AttachmentBatchFile[];
}

interface AttachmentManifest extends AttachmentBatchRequest {
  version: 1;
  totalBytes: number;
  createdAt: number;
  completed: boolean;
}

export interface AttachmentChunk {
  path: string;
  offset: number;
  data: Uint8Array;
}

declare global {
  var __ompAttachmentsPrunedAt: number | undefined;
  var __ompAttachmentBatchLocks: Map<string, Promise<void>> | undefined;
}

export function getAttachmentsDir(): string {
  return path.join(getAgentDir(), "omp-web", "attachments");
}

// Windows and default macOS volumes address `A.txt` and `a.txt` as one
// filesystem object, so the path dedupe there folds case. APFS also treats
// the NFC and NFD spellings of a name as one file; NTFS and ext4 do not.
const CASE_INSENSITIVE_FILESYSTEM = process.platform === "win32" || process.platform === "darwin";
const NORMALIZATION_INSENSITIVE_FILESYSTEM = process.platform === "darwin";

interface PathKeyOptions {
  caseInsensitive?: boolean;
  normalizationInsensitive?: boolean;
}

/** The form two paths share when this filesystem addresses them as one object. */
function attachmentPathKey(
  value: string,
  { caseInsensitive = CASE_INSENSITIVE_FILESYSTEM, normalizationInsensitive = NORMALIZATION_INSENSITIVE_FILESYSTEM }: PathKeyOptions = {},
): string {
  const folded = caseInsensitive ? value.toLocaleLowerCase() : value;
  return normalizationInsensitive ? folded.normalize("NFC") : folded;
}

/** Error for one browser-supplied relative path ("dir/sub/file.pdf"), or null. */
export function validateAttachmentPath(relativePath: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof relativePath !== "string" || relativePath.length === 0) return "Invalid path: (empty)";
  if (relativePath.length > MAX_PATH_CHARS) return `Path is too long: ${relativePath.slice(0, 80)}…`;
  if (CONTROL_CHARACTERS.test(relativePath)) return `Invalid character in path: ${JSON.stringify(relativePath)}`;
  if (relativePath.includes("\\")) return `Paths must use "/" separators: ${relativePath}`;
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return `Path must be relative: ${relativePath}`;
  for (const segment of relativePath.split("/")) {
    if (segment === "") return `Path has an empty segment: ${relativePath}`;
    if (segment === "." || segment === "..") return `Path must not contain "${segment}": ${relativePath}`;
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) return `Path segment is too long: ${relativePath}`;
    if (platform === "win32" && (
      WINDOWS_RESERVED_CHARACTERS.test(segment)
      || /[. ]$/.test(segment)
      || WINDOWS_RESERVED_NAMES.test(segment.split(".", 1)[0].trimEnd())
    )) {
      return `Path is not valid on this server: ${relativePath}`;
    }
  }
  return null;
}

/** Every path valid, none duplicated, and none both a file and a folder.
 *  Duplicates follow the filesystem: folded case and Unicode normalization
 *  where it addresses those spellings as one object. */
export function validateAttachmentPaths(
  paths: readonly unknown[],
  { platform = process.platform, ...keyOptions }: PathKeyOptions & { platform?: NodeJS.Platform } = {},
): string | null {
  if (paths.length === 0) return "No files selected";
  const files = new Map<string, string>();
  const folders = new Map<string, string>();
  for (const candidate of paths) {
    const error = validateAttachmentPath(candidate, platform);
    if (error) return error;
    const relativePath = candidate as string;
    const fileKey = attachmentPathKey(relativePath, keyOptions);
    if (files.has(fileKey)) return `Duplicate path in upload: ${relativePath}`;
    files.set(fileKey, relativePath);
    const segments = relativePath.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      const folder = segments.slice(0, end).join("/");
      folders.set(attachmentPathKey(folder, keyOptions), folder);
    }
  }
  for (const [fileKey, relativePath] of files) {
    if (folders.has(fileKey)) return `Path is both a file and a folder: ${relativePath}`;
  }
  return null;
}

function badRequest(message: string, code = "invalid_attachment"): AttachmentError {
  return new AttachmentError(message, 400, code);
}

/** Validate a declared batch: shape, caps, and the relative-path rules. */
export function parseAttachmentBatchRequest(body: unknown): AttachmentBatchRequest {
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object");
  const { kind, name, files } = body as Record<string, unknown>;
  if (kind !== "file" && kind !== "folder") throw badRequest('kind must be "file" or "folder"');
  if (typeof name !== "string" || name.includes("/") || validateAttachmentPath(name)) {
    throw badRequest(`Invalid attachment name: ${typeof name === "string" ? name || "(empty)" : "(missing)"}`);
  }
  // A file batch is `<batch>/<name>` and a folder batch lives under it, so the
  // root name is the only path that could land on the batch's manifest.
  if (attachmentPathKey(name) === attachmentPathKey(MANIFEST_NAME)) {
    throw badRequest(`Name is reserved for attachment metadata: ${name}`, "invalid_attachment_path");
  }
  if (!Array.isArray(files) || files.length === 0) throw badRequest("files must be a non-empty array");
  if (files.length > MAX_ATTACHMENT_BATCH_FILES) {
    throw new AttachmentError(`Attachments are limited to ${MAX_ATTACHMENT_BATCH_FILES} files`, 413, "attachment_too_many_files");
  }
  const parsed: AttachmentBatchFile[] = [];
  let totalBytes = 0;
  for (const entry of files) {
    const { path: relativePath, size } = (entry ?? {}) as Record<string, unknown>;
    if (typeof relativePath !== "string" || !Number.isSafeInteger(size) || (size as number) < 0) {
      throw badRequest("Each file needs a string path and a non-negative integer size");
    }
    totalBytes += size as number;
    parsed.push({ path: relativePath, size: size as number });
  }
  if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
    throw new AttachmentError(
      `Attachments are limited to ${Math.round(MAX_ATTACHMENT_BATCH_BYTES / (1024 * 1024))} MB`,
      413,
      "attachment_batch_too_large",
    );
  }
  const pathError = validateAttachmentPaths(parsed.map((file) => file.path));
  if (pathError) throw badRequest(pathError, "invalid_attachment_path");
  if (kind === "file" && (parsed.length !== 1 || parsed[0].path !== name)) {
    throw badRequest("A file attachment holds exactly the named file");
  }
  if (kind === "folder" && parsed.some((file) => !file.path.startsWith(`${name}/`))) {
    throw badRequest(`Every folder path must start with "${name}/"`);
  }
  return { kind, name, files: parsed };
}

function batchDirectory(batchId: string): string {
  if (!BATCH_ID_PATTERN.test(batchId)) throw new AttachmentError("Attachment not found", 404, "attachment_not_found");
  return path.join(getAttachmentsDir(), batchId);
}

async function writeManifest(directory: string, manifest: AttachmentManifest): Promise<void> {
  const target = path.join(directory, MANIFEST_NAME);
  // Unique per call: overlapping writers in one process must not share a file.
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
  await fsp.rename(temporary, target);
}

async function readManifest(batchId: string): Promise<{ directory: string; manifest: AttachmentManifest }> {
  const directory = batchDirectory(batchId);
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(directory, MANIFEST_NAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AttachmentError("Attachment not found", 404, "attachment_not_found");
    }
    throw error;
  }
  return { directory, manifest: JSON.parse(raw) as AttachmentManifest };
}

/** Create the batch directory with every declared file present and empty. */
export async function createAttachmentBatch(
  request: AttachmentBatchRequest,
  { now = Date.now() }: { now?: number } = {},
): Promise<{ batchId: string }> {
  const batchId = randomUUID();
  const directory = path.join(getAttachmentsDir(), batchId);
  await fsp.mkdir(getAttachmentsDir(), { recursive: true, mode: 0o700 });
  await fsp.mkdir(directory, { mode: 0o700 });
  try {
    for (const file of request.files) {
      const target = path.join(directory, file.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, "", { flag: "wx" });
    }
    await writeManifest(directory, {
      version: 1,
      ...request,
      totalBytes: request.files.reduce((total, file) => total + file.size, 0),
      createdAt: now,
      completed: false,
    });
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { batchId };
}

/** Run `task` after every earlier chunk write or completion of this batch
 *  has settled, so overlapping requests (a direct API caller; the composer
 *  sends in order) cannot both pass the offset check for the same bytes. */
async function withBatchLock<T>(batchId: string, task: () => Promise<T>): Promise<T> {
  const locks = (globalThis.__ompAttachmentBatchLocks ??= new Map());
  const previous = locks.get(batchId) ?? Promise.resolve();
  const { promise: settled, resolve: release } = Promise.withResolvers<void>();
  const tail = previous.then(() => settled);
  locks.set(batchId, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(batchId) === tail) locks.delete(batchId);
  }
}

/** Append chunks in order. Each chunk must start where its file currently
 *  ends, so a retried or reordered request is refused instead of corrupting. */
export async function writeAttachmentChunks(batchId: string, chunks: readonly AttachmentChunk[]): Promise<void> {
  await withBatchLock(batchId, async () => {
    const { directory, manifest } = await readManifest(batchId);
    if (manifest.completed) throw new AttachmentError("Attachment upload is already complete", 409, "attachment_completed");
    const declared = new Map(manifest.files.map((file) => [file.path, file.size]));
    for (const chunk of chunks) {
      const size = declared.get(chunk.path);
      if (size === undefined) throw badRequest(`Path was not declared for this attachment: ${chunk.path}`, "attachment_unknown_path");
      if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0) throw badRequest("Chunk offset must be a non-negative integer");
      if (chunk.offset + chunk.data.byteLength > size) {
        throw badRequest(`Chunk runs past the declared size of ${chunk.path}`, "attachment_chunk_overflow");
      }
      const target = path.join(directory, chunk.path);
      const stat = await fsp.lstat(target);
      if (!stat.isFile()) throw new AttachmentError(`Not a regular file: ${chunk.path}`, 409, "attachment_not_file");
      if (stat.size !== chunk.offset) {
        throw new AttachmentError(
          `Chunk for ${chunk.path} starts at ${chunk.offset}, expected ${stat.size}`,
          409,
          "attachment_offset_mismatch",
        );
      }
      const handle = await fsp.open(target, "r+");
      try {
        // A positional write may write fewer bytes than asked; finish the chunk.
        for (let written = 0; written < chunk.data.byteLength;) {
          const { bytesWritten } = await handle.write(chunk.data, written, chunk.data.byteLength - written, chunk.offset + written);
          if (bytesWritten === 0) throw new AttachmentError(`Write made no progress for ${chunk.path}`, 500, "attachment_write_failed");
          written += bytesWritten;
        }
      } finally {
        await handle.close();
      }
    }
  });
}

/** Confirm every declared byte arrived and return what the composer shows. */
export async function completeAttachmentBatch(batchId: string): Promise<AttachmentReferenceData> {
  return withBatchLock(batchId, async () => {
    const { directory, manifest } = await readManifest(batchId);
    for (const file of manifest.files) {
      const stat = await fsp.lstat(path.join(directory, file.path));
      if (!stat.isFile() || stat.size !== file.size) {
        throw new AttachmentError(`Upload incomplete: ${file.path}`, 409, "attachment_incomplete");
      }
    }
    if (!manifest.completed) await writeManifest(directory, { ...manifest, completed: true });
    return {
      batchId,
      kind: manifest.kind,
      name: manifest.name,
      path: path.join(directory, manifest.name),
      size: manifest.totalBytes,
      fileCount: manifest.files.length,
    };
  });
}

async function batchCreatedAt(directory: string): Promise<number> {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(directory, MANIFEST_NAME), "utf8")) as Partial<AttachmentManifest>;
    if (typeof manifest.createdAt === "number" && Number.isFinite(manifest.createdAt)) return manifest.createdAt;
  } catch {
    // An unreadable or missing manifest falls back to the directory's age.
  }
  return (await fsp.stat(directory)).mtimeMs;
}

/** Remove batches older than `maxAgeMs`; returns how many were removed. */
export async function pruneAttachmentBatches(
  { now = Date.now(), maxAgeMs = ATTACHMENT_RETENTION_MS }: { now?: number; maxAgeMs?: number } = {},
): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(getAttachmentsDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !BATCH_ID_PATTERN.test(entry.name)) continue;
    const directory = path.join(getAttachmentsDir(), entry.name);
    if (now - await batchCreatedAt(directory) <= maxAgeMs) continue;
    await fsp.rm(directory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Prune at most once an hour per process; failures only log. */
export async function maybePruneAttachmentBatches(now = Date.now()): Promise<void> {
  if (globalThis.__ompAttachmentsPrunedAt !== undefined && now - globalThis.__ompAttachmentsPrunedAt < PRUNE_INTERVAL_MS) return;
  globalThis.__ompAttachmentsPrunedAt = now;
  try {
    await pruneAttachmentBatches({ now });
  } catch (error) {
    console.warn("[omp-web] pruning old attachments failed:", error);
  }
}
