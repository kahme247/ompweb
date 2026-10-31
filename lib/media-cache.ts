import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getBlobsDir, getDiagnosticsDir } from "./omp/paths";
import { isRecord } from "./type-guards";

/**
 * Tool-result images reach the browser as `/api/media/<sha256>` URLs instead of
 * inline base64, so big screenshots never sit in the chat's React state. The
 * hash is omp's own blob address (sha256 of the image bytes): history entries
 * already carry it as `blob:sha256:<hash>`, and live output is hashed here and
 * copied into omp-web's media directory until omp writes its own blob.
 */

const HASH_RE = /^[a-f0-9]{64}$/;
const BLOB_PREFIX = "blob:sha256:";
/** Twice the 240px tool-result preview, for high-density screens. */
const THUMB_PX = 480;
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

declare global {
  var __ompWebMediaSweptAt: number | undefined;
}

function mediaDir(): string {
  return path.join(getDiagnosticsDir(), "media");
}

function fileSize(file: string): number | undefined {
  return statSync(file, { throwIfNoEntry: false })?.size;
}

function writeAtomic(file: string, data: Buffer): void {
  sweepMediaCache();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Daily: drop copies omp now holds as complete blobs, and anything older than 30 days (previews regenerate on demand). */
function sweepMediaCache(): void {
  const now = Date.now();
  if (now - (globalThis.__ompWebMediaSweptAt ?? 0) < SWEEP_EVERY_MS) return;
  globalThis.__ompWebMediaSweptAt = now;
  let names: string[];
  try {
    names = readdirSync(mediaDir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(mediaDir(), name);
    try {
      const stat = statSync(file);
      const hasBlob = HASH_RE.test(name) && fileSize(path.join(getBlobsDir(), name)) === stat.size;
      if (hasBlob || now - stat.mtimeMs > MAX_AGE_MS) unlinkSync(file);
    } catch {
      // Removed concurrently or unreadable: the next sweep retries.
    }
  }
}

// Live tool output resends the full accumulated result on every update; this
// keeps one screenshot from being decoded and hashed once per frame. Each key
// is a whole base64 image, so the memo is capped by size.
const recentHashes = new Map<string, string>();
const RECENT_MAX_CHARS = 16 * 1024 * 1024;
let recentChars = 0;

/** Store a base64 image under its content address and return the hash. */
export function storeInlineImage(base64: string): string {
  // The memo skips only decoding and hashing: the files are rechecked every
  // time, because the sweep may have removed the copy since.
  let hash = recentHashes.get(base64);
  if (!hash) {
    hash = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
    if (base64.length <= RECENT_MAX_CHARS) {
      recentHashes.set(base64, hash);
      recentChars += base64.length;
      while (recentChars > RECENT_MAX_CHARS) {
        const oldest = recentHashes.keys().next().value!;
        recentChars -= oldest.length;
        recentHashes.delete(oldest);
      }
    }
  }
  const size = Buffer.byteLength(base64, "base64");
  const copy = path.join(mediaDir(), hash);
  // omp writes blobs in place: keep our own copy unless its blob is already complete.
  if (fileSize(path.join(getBlobsDir(), hash)) !== size && fileSize(copy) !== size) writeAtomic(copy, Buffer.from(base64, "base64"));
  return hash;
}

/** Keep a copy of an image another host sent, so later requests are served locally. */
export function storeMediaCopy(hash: string, bytes: Uint8Array): void {
  if (HASH_RE.test(hash)) writeAtomic(path.join(mediaDir(), hash), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function imageBlockAsUrl(block: unknown): unknown {
  if (!isRecord(block) || block.type !== "image") return block;
  let data: unknown;
  let mimeType: unknown;
  if (typeof block.data === "string") {
    data = block.data;
    mimeType = block.mimeType;
  } else if (isRecord(block.source) && block.source.type === "base64") {
    data = block.source.data;
    mimeType = block.source.media_type;
  }
  if (typeof data !== "string" || data === "") return block;
  let hash: string;
  if (data.startsWith(BLOB_PREFIX)) {
    hash = data.slice(BLOB_PREFIX.length);
    if (!HASH_RE.test(hash)) return block;
    if (!existsSync(path.join(getBlobsDir(), hash)) && !existsSync(path.join(mediaDir(), hash))) {
      return { type: "text", text: `[image unavailable: blob ${hash.slice(0, 12)}… not found]` };
    }
  } else {
    try {
      hash = storeInlineImage(data);
    } catch {
      return block; // Disk trouble: keep showing the inline image.
    }
  }
  return { type: "image", ...(typeof mimeType === "string" ? { mimeType } : {}), url: `/api/media/${hash}` };
}

/** Tool-result content with every image replaced by a media URL. */
export function toolResultContentAsUrls<T>(content: T): T {
  if (!Array.isArray(content) || !content.some((block) => isRecord(block) && block.type === "image")) return content;
  return content.map(imageBlockAsUrl) as T;
}

function withContentAsUrls(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const content = toolResultContentAsUrls(value.content);
  return content === value.content ? value : { ...value, content };
}

function toolResultMessageAsUrls(message: unknown): unknown {
  return isRecord(message) && message.role === "toolResult" ? withContentAsUrls(message) : message;
}

function mapMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const mapped = value.map(toolResultMessageAsUrls);
  return mapped.some((message, i) => message !== value[i]) ? mapped : value;
}

/** An omp agent event with its tool-result images as media URLs (same object when it has none). */
export function eventWithToolResultImageUrls<E extends { type: string; [key: string]: unknown }>(event: E): E {
  const swap = (key: string, value: unknown): E => (value === event[key] ? event : { ...event, [key]: value });
  switch (event.type) {
    case "tool_execution_update": return swap("partialResult", withContentAsUrls(event.partialResult));
    case "tool_execution_end": return swap("result", withContentAsUrls(event.result));
    case "message_start":
    case "message_end": return swap("message", toolResultMessageAsUrls(event.message));
    case "turn_end": return swap("toolResults", mapMessages(event.toolResults));
    case "agent_end": return swap("messages", mapMessages(event.messages));
    case "subagent_event": {
      // The child's raw event rides in `payload.event`.
      const payload = event.payload;
      if (!isRecord(payload) || !isRecord(payload.event) || typeof payload.event.type !== "string") return event;
      const inner = eventWithToolResultImageUrls(payload.event as { type: string });
      return inner === payload.event ? event : swap("payload", { ...payload, event: inner });
    }
    default: return event;
  }
}

/**
 * File holding a stored image: omp's blob, else omp-web's copy. omp writes
 * blobs in place, so a blob that differs in size from our copy is still being
 * written and the copy is served instead.
 */
export function mediaFilePath(hash: string): string | null {
  if (!HASH_RE.test(hash)) return null;
  const blob = path.join(getBlobsDir(), hash);
  const copy = path.join(mediaDir(), hash);
  const blobSize = fileSize(blob);
  const copySize = fileSize(copy);
  if (blobSize !== undefined && (copySize === undefined || blobSize === copySize)) return blob;
  return copySize === undefined ? null : copy;
}

/** Raster image type from magic bytes; null for anything else (the blob store also holds non-images). */
export function imageMimeType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Existing thumbnail for `hash`, if one was generated before. */
export function existingThumbnail(hash: string): string | null {
  const thumb = path.join(mediaDir(), `${hash}.thumb.webp`);
  return HASH_RE.test(hash) && existsSync(thumb) ? thumb : null;
}

/** Generate and cache a small WebP preview; null when sharp is unavailable or fails. */
export async function createThumbnail(hash: string, image: Buffer): Promise<Buffer | null> {
  let thumb: Buffer;
  try {
    // Dynamic on purpose: sharp's native binary is platform-specific and may be
    // missing, and this module is also loaded by the session reader and RPC
    // manager, which must not fail or load libvips just to rewrite URLs.
    const { default: sharp } = await import("sharp");
    thumb = await sharp(image)
      .rotate() // apply EXIF orientation; WebP output drops the tag
      .resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
  try {
    writeAtomic(path.join(mediaDir(), `${hash}.thumb.webp`), thumb);
  } catch {
    // Not cached this time; the preview is still served.
  }
  return thumb;
}
