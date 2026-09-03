import { randomUUID } from "crypto";
import type { Dirent } from "fs";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  lstatSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import * as fsRuntime from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { gunzipSync, gzipSync } from "zlib";
import { isRecord } from "../type-guards";

// Keep user-session directory traversal out of Next's static NFT globbing.
// These paths are resolved and authorized at request time by omp-web.
const readDirectorySyncRuntime = Reflect.get(fsRuntime, "readdirSync") as typeof readdirSync;
import type {
  CompactionEntry,
  SessionEntry,
  SessionHeader,
  SessionTitleSource,
  SessionTreeNode,
} from "../types";
import { getArchivedSessionsDir, getBlobsDir, getSessionsDir } from "./paths";

/**
 * Pure-Node reader/writer for oh-my-pi's session JSONL files (format v3).
 * Ported from oh-my-pi packages/coding-agent/src/session/ (session-entries,
 * session-title-slot, session-listing, session-loader, session-migrations,
 * blob-store) because the @oh-my-pi packages are Bun-only and cannot run
 * inside the Node-hosted Next.js server.
 *
 * File layout: optional fixed-width 256-byte title-slot line, then the
 * {"type":"session"} header line, then entries forming a tree via
 * (id, parentId). Legacy pi v1/v2 files have no title slot and are migrated
 * in memory on load. Large image payloads are externalized to the
 * content-addressed blob store and referenced as "blob:sha256:<hex>".
 */

export const SESSION_TITLE_SLOT_BYTES = 256;
export const CURRENT_SESSION_VERSION = 3;

// ============================================================================
// Title slot (fixed-width line 1)
// ============================================================================

export interface SessionTitleSlot {
  type: "title";
  v: 1;
  title: string;
  source?: SessionTitleSource;
  updatedAt: string;
  pad: string;
}

export interface SessionTitleUpdate {
  title?: string;
  source?: SessionTitleSource;
  updatedAt: string;
}

function titleSlotLine(
  title: string,
  source: SessionTitleSource | undefined,
  updatedAt: string,
  pad: string,
): string {
  const slot: SessionTitleSlot = source
    ? { type: "title", v: 1, title, source, updatedAt, pad }
    : { type: "title", v: 1, title, updatedAt, pad };
  return `${JSON.stringify(slot)}\n`;
}

/** Longest code-point prefix of `title` whose serialized line fits the slot. */
function truncateTitleForSlot(
  title: string,
  source: SessionTitleSource | undefined,
  updatedAt: string,
): string {
  const codePoints = [...title];
  let low = 0;
  let high = codePoints.length;
  let best = "";
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = codePoints.slice(0, mid).join("");
    if (Buffer.byteLength(titleSlotLine(candidate, source, updatedAt, ""), "utf8") <= SESSION_TITLE_SLOT_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function isSessionTitleSource(value: unknown): value is SessionTitleSource {
  return value === "auto" || value === "user";
}

/** Parse a physical title-slot JSONL line. Returns undefined for anything else. */
export function parseTitleSlotLine(line: string): SessionTitleSlot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== "title" || record.v !== 1) return undefined;
  if (typeof record.title !== "string" || typeof record.updatedAt !== "string" || typeof record.pad !== "string") {
    return undefined;
  }
  if (record.source !== undefined && !isSessionTitleSource(record.source)) return undefined;
  const slot: SessionTitleSlot = {
    type: "title",
    v: 1,
    title: record.title,
    updatedAt: record.updatedAt,
    pad: record.pad,
  };
  if (record.source) slot.source = record.source as SessionTitleSource;
  return slot;
}

/** Serialize the title slot to exactly 256 UTF-8 bytes including the newline. */
export function serializeTitleSlot(update: SessionTitleUpdate): string {
  const title = truncateTitleForSlot(update.title ?? "", update.source, update.updatedAt);
  const unpadded = titleSlotLine(title, update.source, update.updatedAt, "");
  const padBytes = SESSION_TITLE_SLOT_BYTES - Buffer.byteLength(unpadded, "utf8");
  if (padBytes < 0) throw new Error("Session title slot metadata exceeds fixed slot size");
  const line = titleSlotLine(title, update.source, update.updatedAt, " ".repeat(padBytes));
  if (Buffer.byteLength(line, "utf8") !== SESSION_TITLE_SLOT_BYTES) {
    throw new Error("Session title slot serialization failed to produce fixed-width output");
  }
  return line;
}

/** Read only the fixed-size head window to detect a physical title slot. */
export function readTitleSlot(filePath: string): SessionTitleSlot | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(SESSION_TITLE_SLOT_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = head.indexOf("\n");
    if (newlineIndex < 0) return undefined;
    return parseTitleSlotLine(head.slice(0, newlineIndex));
  } finally {
    closeSync(fd);
  }
}

// ============================================================================
// Lenient JSONL parsing + migrations
// ============================================================================

/** JSON.stringify never emits raw newlines, so line splitting is a faithful
 * lenient JSONL parse: malformed/truncated lines are skipped, not fatal. */
export function parseJsonlLenient<T>(body: string): T[] {
  const out: T[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed line (torn write, prefix-window truncation).
    }
  }
  return out;
}

type MutableEntry = SessionEntry & Record<string, unknown>;

function generateEntryId(taken: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(-8);
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(header: SessionHeader, entries: MutableEntry[]): void {
  header.version = 2;
  const ids = new Set<string>();
  let prevId: string | null = null;
  for (const entry of entries) {
    entry.id = generateEntryId(ids);
    ids.add(entry.id);
    entry.parentId = prevId;
    prevId = entry.id;
    if (entry.type === "compaction" && typeof entry.firstKeptEntryIndex === "number") {
      // firstKeptEntryIndex counts within the physical file entries, where the
      // header occupies index 0 (omp migrates over the combined array).
      const target = entry.firstKeptEntryIndex >= 1 ? entries[entry.firstKeptEntryIndex - 1] : undefined;
      if (target) (entry as CompactionEntry).firstKeptEntryId = target.id;
      delete entry.firstKeptEntryIndex;
    }
  }
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(header: SessionHeader, entries: MutableEntry[]): void {
  header.version = 3;
  for (const entry of entries) {
    if (entry.type === "message") {
      // Imports and hand-edits can produce message entries whose message
      // object is missing — entryToUiMessage tolerates that, so must we.
      const message = entry.message as { role?: string } | null | undefined;
      if (message?.role === "hookMessage") message.role = "custom";
    }
  }
}

function migrateToCurrentVersion(header: SessionHeader, entries: MutableEntry[]): void {
  const version = header.version ?? 1;
  if (version >= CURRENT_SESSION_VERSION) return;
  if (version < 2) migrateV1ToV2(header, entries);
  if (version < 3) migrateV2ToV3(header, entries);
}

// ============================================================================
// Blob store (read side)
// ============================================================================

const BLOB_PREFIX = "blob:sha256:";
const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

function isBlobRef(data: string): boolean {
  return data.startsWith(BLOB_PREFIX);
}

/** Extract the hash from a blob ref; the hash check confines reads to the blob dir. */
function parseBlobRef(data: string): string | null {
  if (!data.startsWith(BLOB_PREFIX)) return null;
  const hash = data.slice(BLOB_PREFIX.length);
  return BLOB_HASH_RE.test(hash) ? hash : null;
}

function readBlobSync(hash: string): Buffer | null {
  try {
    return readFileSync(path.join(getBlobsDir(), hash));
  } catch {
    return null;
  }
}

function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
  return isRecord(value) && value.type === "image" && typeof value.data === "string";
}

function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
  if (!isRecord(value) || typeof value.data !== "string") return false;
  if (isImageBlock(value)) return true;
  return typeof value.mimeType === "string" && value.mimeType.toLowerCase().startsWith("image/");
}

/** Degrade a missing-blob image block to a visible text placeholder in place. */
function degradeMissingBlobImage(block: Record<string, unknown>, hash: string): void {
  block.type = "text";
  block.text = `[image unavailable: blob ${hash.slice(0, 12)}… not found]`;
  delete block.data;
  delete block.mimeType;
  delete block.source;
}

function resolveBlobsInValue(value: unknown, key: string | undefined): void {
  if (Array.isArray(value)) {
    for (const item of value) resolveBlobsInValue(item, key);
    return;
  }
  if (!isRecord(value)) return;
  const record = value as Record<string, unknown>;

  if (
    isImageDataPayload(value) &&
    isBlobRef(value.data) &&
    ((key === "content" && isImageBlock(value)) || key === "images")
  ) {
    const hash = parseBlobRef(value.data);
    if (!hash) return;
    const blob = readBlobSync(hash);
    if (blob) record.data = blob.toString("base64");
    else degradeMissingBlobImage(record, hash);
    return;
  }

  if (
    record.type === "image_generation_call" &&
    typeof record.result === "string" &&
    isBlobRef(record.result)
  ) {
    const hash = parseBlobRef(record.result);
    const blob = hash ? readBlobSync(hash) : null;
    if (blob) record.result = blob.toString("base64");
  }

  if (typeof record.image_url === "string" && isBlobRef(record.image_url)) {
    const hash = parseBlobRef(record.image_url);
    const blob = hash ? readBlobSync(hash) : null;
    // Externalized data URLs are stored as the raw UTF-8 data-URL string.
    if (blob) record.image_url = blob.toString("utf8");
  }

  for (const [childKey, item] of Object.entries(record)) {
    resolveBlobsInValue(item, childKey);
  }
}

/** Cheap precheck so blob-free entries skip the resolution walk entirely. */
function containsBlobRef(value: unknown): boolean {
  if (typeof value === "string") return isBlobRef(value);
  if (Array.isArray(value)) {
    for (const item of value) if (containsBlobRef(item)) return true;
    return false;
  }
  if (!isRecord(value)) return false;
  for (const key in value) {
    if (containsBlobRef(value[key])) return true;
  }
  return false;
}

export interface ResolveBlobOptions {
  /** Leave blob refs inside toolResult messages unresolved (the caller is about
   * to omit those images from the payload anyway). */
  skipToolResultImages?: boolean;
}

/** Resolve blob references in loaded entries back to inline base64. Mutates in place. */
export function resolveBlobRefsInEntries(entries: SessionEntry[], options: ResolveBlobOptions = {}): void {
  for (const entry of entries) {
    if (
      options.skipToolResultImages &&
      entry.type === "message" &&
      ((entry.message as { role?: string } | null | undefined)?.role === "toolResult")
    ) {
      continue;
    }
    if (!containsBlobRef(entry)) continue;
    resolveBlobsInValue(entry, undefined);
  }
}

// ============================================================================
// Session file loading
// ============================================================================

export type SessionLoadError = "too_large";

export interface LoadedSession {
  header: SessionHeader | null;
  entries: SessionEntry[];
  titleSlot: SessionTitleSlot | undefined;
  /** Set when the file exists but could not be materialized (see loadSessionFile). */
  error?: SessionLoadError;
}

export interface LoadSessionOptions extends ResolveBlobOptions {
  /** Resolve blob:sha256 image references to inline base64 for display. */
  resolveBlobs?: boolean;
}

const SESSION_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Ceiling on the on-disk size omp-web will materialize into memory. omp streams
 * sessions, so this is not an omp limit — it is the point past which parsing a
 * session into JS objects (and serializing it into one HTTP response) would OOM
 * the whole Next.js server. Refusing loudly beats taking the process down.
 */
export const MAX_SESSION_LOAD_BYTES = 1024 * 1024 * 1024;

/**
 * Read a file line by line over a byte buffer. Unlike readFileSync(path,"utf8")
 * this never materializes the whole file as a single JS string, so sessions
 * past Node's ~512 MiB string cap still open. Lines exclude the newline; the
 * decoder carries multi-byte characters across chunk boundaries.
 */
export function forEachFileLineSync(filePath: string, onLine: (line: string) => void): void {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SESSION_READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    // Fragments of the current unterminated line, joined only when a chunk
    // actually contains a newline (or EOF completes the file). Appending to a
    // single `pending` string per 1 MiB chunk copies the whole accumulated
    // prefix every chunk — quadratic on single-line files (17ms @8MiB → 149ms
    // @32MiB). With fragments, a newline-free file is joined exactly once at
    // EOF; a file with newlines joins only the (small) tail since the last
    // newline, so the total cost stays linear in file size.
    const fragments: string[] = [];
    let hasNewline = false;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const decoded = decoder.write(buffer.subarray(0, bytesRead));
      hasNewline = hasNewline || decoded.includes("\n");
      fragments.push(decoded);
      if (!hasNewline) continue;
      // Materialize the accumulated buffer once, emit every completed line,
      // and keep only the unterminated tail (bounded by the largest line).
      const joined = fragments.join("");
      fragments.length = 0;
      hasNewline = false;
      let start = 0;
      let newlineIndex = joined.indexOf("\n", start);
      while (newlineIndex !== -1) {
        onLine(joined.slice(start, newlineIndex));
        start = newlineIndex + 1;
        newlineIndex = joined.indexOf("\n", start);
      }
      if (start < joined.length) fragments.push(joined.slice(start));
    }
    const tail = decoder.end();
    if (tail) fragments.push(tail);
    if (fragments.length > 0) onLine(fragments.join(""));
  } finally {
    closeSync(fd);
  }
}

/**
 * Load and parse a session file: strip the optional title slot, validate the
 * header, migrate legacy pi v1/v2 shapes, fold the slot title into the header,
 * and optionally resolve blob refs. Missing/malformed files yield
 * { header: null, entries: [] } instead of throwing; a session too large to
 * hold in memory additionally sets error:"too_large" so routes can say so
 * instead of reporting it as malformed.
 */
export function loadSessionFile(filePath: string, options: LoadSessionOptions = {}): LoadedSession {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { header: null, entries: [], titleSlot: undefined };
  }
  if (size > MAX_SESSION_LOAD_BYTES) {
    return { header: null, entries: [], titleSlot: undefined, error: "too_large" };
  }

  let titleSlot: SessionTitleSlot | undefined;
  const records: Record<string, unknown>[] = [];
  let isFirstLine = true;
  try {
    forEachFileLineSync(filePath, (rawLine) => {
      if (isFirstLine) {
        isFirstLine = false;
        titleSlot = parseTitleSlotLine(rawLine);
        if (titleSlot) return;
      }
      const line = rawLine.trim();
      if (!line) return;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Skip malformed line (torn write).
      }
    });
  } catch (error) {
    // A single line past the string cap, or an allocation failure part-way in.
    const tooLarge = error instanceof RangeError;
    return { header: null, entries: [], titleSlot, ...(tooLarge ? { error: "too_large" as const } : {}) };
  }

  const headerRecord = records[0];
  if (!headerRecord || headerRecord.type !== "session" || typeof headerRecord.id !== "string") {
    return { header: null, entries: [], titleSlot };
  }
  const header = headerRecord as unknown as SessionHeader;
  const entries = records.slice(1).filter((record) => record.type !== "session") as unknown as MutableEntry[];

  migrateToCurrentVersion(header, entries);

  if (titleSlot) {
    if (titleSlot.title) {
      header.title = titleSlot.title;
      if (titleSlot.source) header.titleSource = titleSlot.source;
      else delete header.titleSource;
    } else {
      delete header.title;
      delete header.titleSource;
    }
  }

  if (options.resolveBlobs) {
    resolveBlobRefsInEntries(entries, { skipToolResultImages: options.skipToolResultImages });
  }

  return { header, entries, titleSlot };
}

/**
 * Bounded, slot-aware header read: parses only the first physical line (plus
 * the second when line 1 is a title slot), capped at 64 KiB. The slot title is
 * folded into the returned header.
 */
export function readSessionHeaderSync(filePath: string): SessionHeader | null {
  const maxHeaderBytes = 64 * 1024 + SESSION_TITLE_SLOT_BYTES;
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  let head: string;
  try {
    const buffer = Buffer.allocUnsafe(maxHeaderBytes);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }

  let firstLineEnd = head.indexOf("\n");
  if (firstLineEnd === -1) {
    if (Buffer.byteLength(head, "utf8") >= maxHeaderBytes) return null;
    firstLineEnd = head.length;
  }
  const firstLine = head.slice(0, firstLineEnd).trim();
  if (!firstLine) return null;

  const slot = parseTitleSlotLine(firstLine);
  let headerLine: string;
  if (slot) {
    const rest = head.slice(firstLineEnd + 1);
    const secondLineEnd = rest.indexOf("\n");
    if (secondLineEnd === -1 && Buffer.byteLength(rest, "utf8") + firstLineEnd >= maxHeaderBytes) return null;
    headerLine = (secondLineEnd === -1 ? rest : rest.slice(0, secondLineEnd)).trim();
  } else {
    headerLine = firstLine;
  }
  if (!headerLine) return null;

  let header: SessionHeader;
  try {
    header = JSON.parse(headerLine) as SessionHeader;
  } catch {
    return null;
  }
  if (header.type !== "session") return null;
  if (slot?.title) {
    header.title = slot.title;
    if (slot.source) header.titleSource = slot.source;
  } else if (slot) {
    delete header.title;
    delete header.titleSource;
  }
  return header;
}

// ============================================================================
// Tree + leaf helpers
// ============================================================================

/**
 * Build the session tree: one root for a well-formed session, orphaned entries
 * (broken parent chain) become extra roots. Labels come from label entries in
 * append order (a later label overrides; an empty label clears).
 */
export function buildSessionTree(entries: SessionEntry[]): SessionTreeNode[] {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label) labels.set(entry.targetId, entry.label);
    else labels.delete(entry.targetId);
  }

  const nodes = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodes.set(entry.id, { entry, children: [], label: labels.get(entry.id) });
  }
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byTimestamp = (a: SessionTreeNode, b: SessionTreeNode) =>
    new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort(byTimestamp);
    stack.push(...node.children);
  }
  return roots;
}

/** The persisted leaf: the last appended entry (matches omp's loaded-session leaf). */
export function getLeafEntryId(entries: SessionEntry[]): string | null {
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

// ============================================================================
// Session listing (port of session-listing.ts)
// ============================================================================

export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

export interface OmpSessionInfo {
  path: string;
  id: string;
  cwd: string;
  title?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  size: number;
  firstMessage: string;
  status?: SessionStatus;
}

const SESSION_LIST_PREFIX_BYTES = 4096;
const SESSION_LIST_SUFFIX_BYTES = 32_768;

function decodeJsonStringFragment(value: string): string {
  const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
  try {
    return JSON.parse(`"${safeValue}"`) as string;
  } catch {
    return safeValue
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

/** Raw-text string-property scan used on the possibly-truncated prefix window. */
function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
  const propertyIndex = source.indexOf(`"${name}"`, startIndex);
  if (propertyIndex === -1) return undefined;
  const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
  if (colonIndex === -1) return undefined;

  let valueIndex = colonIndex + 1;
  while (valueIndex < source.length) {
    const char = source.charCodeAt(valueIndex);
    if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
    valueIndex++;
  }
  if (source.charCodeAt(valueIndex) !== 34) return undefined;

  const valueStart = valueIndex + 1;
  let escaped = false;
  for (let i = valueStart; i < source.length; i++) {
    const char = source.charCodeAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === 92) {
      escaped = true;
      continue;
    }
    if (char === 34) {
      return decodeJsonStringFragment(source.slice(valueStart, i));
    }
  }
  return decodeJsonStringFragment(source.slice(valueStart));
}

function countMessageMarkers(content: string): number {
  let count = 0;
  let index = 0;
  while (index < content.length) {
    const typeIndex = content.indexOf('"type"', index);
    if (typeIndex === -1) break;
    const colonIndex = content.indexOf(":", typeIndex + 6);
    if (colonIndex === -1) break;
    if (extractStringProperty(content, "type", typeIndex) === "message") count++;
    index = colonIndex + 1;
  }
  return count;
}

function extractFirstDisplayMessageFromPrefix(content: string): string | undefined {
  let fallback: string | undefined;
  let index = content.indexOf('"role"');
  while (index !== -1) {
    const role = extractStringProperty(content, "role", index);
    const text = extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
    if (text) {
      if (role === "user") return text;
      if (!fallback && (role === "developer" || role === "assistant")) fallback = text;
    }
    index = content.indexOf('"role"', index + 6);
  }
  return fallback;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") text.push(block.text);
  }
  return text.join(" ");
}

interface TailMessage {
  role?: string;
  stopReason?: string;
  content?: unknown;
}

function statusFromTailMessage(message: TailMessage): SessionStatus {
  switch (message.role) {
    case "assistant": {
      switch (message.stopReason) {
        case "error":
          return "error";
        case "aborted":
          return "aborted";
        case "length":
          return "interrupted";
      }
      const content = message.content;
      if (Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "toolCall")) {
        return "interrupted";
      }
      return "complete";
    }
    case "toolResult":
      return "interrupted";
    case "user":
      return "pending";
    default:
      return "unknown";
  }
}

/** Derive the lifecycle status from the tail window's last message entry. */
function deriveSessionStatus(suffix: string): SessionStatus {
  if (!suffix) return "unknown";
  const lines = suffix.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Every persisted entry starts with "{" — cheaply skips blank lines and
    // the leading partial fragment of the tail window.
    if (line.charCodeAt(0) !== 123) continue;
    let entry: { type?: string; message?: TailMessage };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "message" && entry.message) {
      return statusFromTailMessage(entry.message);
    }
  }
  return "unknown";
}

interface SessionListHeader {
  id: string;
  cwd?: string;
  title?: string;
  parentSession?: string;
  timestamp?: string;
}

function normalizeTitleOverride(title: string | undefined): string | null | undefined {
  if (title === undefined) return undefined;
  return title.trim() ? title : null;
}

function sessionListHeaderFromRecord(
  record: Record<string, unknown> | undefined,
  titleOverride?: string | null,
): SessionListHeader | undefined {
  if (record?.type !== "session" || typeof record.id !== "string") return undefined;
  return {
    id: record.id,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    title:
      titleOverride === null
        ? undefined
        : (titleOverride ?? (typeof record.title === "string" ? record.title : undefined)),
    parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
  };
}

function parseSessionListHeaderLine(line: string, titleOverride?: string | null): SessionListHeader | undefined {
  if (extractStringProperty(line, "type") !== "session") return undefined;
  const id = extractStringProperty(line, "id");
  if (!id) return undefined;
  return {
    id,
    cwd: extractStringProperty(line, "cwd"),
    title: titleOverride === null ? undefined : (titleOverride ?? extractStringProperty(line, "title")),
    parentSession: extractStringProperty(line, "parentSession"),
    timestamp: extractStringProperty(line, "timestamp"),
  };
}

/** Parse the header from the prefix window; slot titles override header titles.
 * Falls back to a raw-text scan when the header line straddles the window. */
function parseSessionListHeader(
  content: string,
  entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
  const firstEntry = entries[0];
  const parsedSlotTitle = normalizeTitleOverride(
    firstEntry?.type === "title" && typeof firstEntry.title === "string" ? firstEntry.title : undefined,
  );
  const parsedHeader = sessionListHeaderFromRecord(entries[firstEntry?.type === "title" ? 1 : 0], parsedSlotTitle);
  if (parsedHeader) return parsedHeader;

  let slotTitle: string | null | undefined;
  let firstNonEmpty = true;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (firstNonEmpty && extractStringProperty(line, "type") === "title") {
      slotTitle = normalizeTitleOverride(extractStringProperty(line, "title"));
      firstNonEmpty = false;
      continue;
    }
    return parseSessionListHeaderLine(line, slotTitle);
  }
  return undefined;
}

function readTextSlices(filePath: string, prefixBytes: number, suffixBytes: number): [string, string, number, Date] {
  const stat = statSync(filePath);
  const fd = openSync(filePath, "r");
  try {
    const prefixLength = Math.min(prefixBytes, stat.size);
    const prefixBuffer = Buffer.allocUnsafe(prefixLength);
    const prefixRead = prefixLength > 0 ? readSync(fd, prefixBuffer, 0, prefixLength, 0) : 0;
    const prefix = prefixBuffer.subarray(0, prefixRead).toString("utf8");

    let suffix = "";
    if (suffixBytes > 0 && stat.size > 0) {
      const suffixLength = Math.min(suffixBytes, stat.size);
      const suffixBuffer = Buffer.allocUnsafe(suffixLength);
      const suffixRead = readSync(fd, suffixBuffer, 0, suffixLength, stat.size - suffixLength);
      suffix = suffixBuffer.subarray(0, suffixRead).toString("utf8");
    }
    return [prefix, suffix, stat.size, stat.mtime];
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan a single session file into an OmpSessionInfo using only a 4 KiB prefix
 * window (plus a 32 KiB tail window when `withStatus` is set). Faithful port
 * of omp's scanSessionFile — messageCount is a prefix-derived lower bound.
 */
export function scanSessionInfo(filePath: string, withStatus = true): OmpSessionInfo | undefined {
  try {
    const [content, suffix, size, mtime] = readTextSlices(
      filePath,
      SESSION_LIST_PREFIX_BYTES,
      withStatus ? SESSION_LIST_SUFFIX_BYTES : 0,
    );
    const entries = parseJsonlLenient<Record<string, unknown>>(content);
    const header = parseSessionListHeader(content, entries);
    if (!header) return undefined;

    let parsedMessageCount = 0;
    let firstMessage = "";
    let shortSummary: string | undefined;
    for (let i = 1; i < entries.length; i++) {
      const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown }; shortSummary?: string };
      if (entry.type === "compaction" && typeof entry.shortSummary === "string") {
        shortSummary = entry.shortSummary;
      }
      if (entry.type === "message" && entry.message) {
        parsedMessageCount++;
        if (entry.message.role === "user" && !firstMessage) {
          firstMessage = extractTextFromContent(entry.message.content);
        }
      }
    }

    firstMessage ||= extractFirstDisplayMessageFromPrefix(content) ?? "";
    const messageCount = Math.max(parsedMessageCount, countMessageMarkers(content));
    return {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      title: header.title ?? shortSummary,
      parentSessionPath: header.parentSession,
      created: new Date(header.timestamp ?? ""),
      modified: mtime,
      messageCount,
      size,
      firstMessage: firstMessage || "(no messages)",
      status: withStatus ? deriveSessionStatus(suffix) : undefined,
    };
  } catch {
    return undefined;
  }
}

// Memo of per-file scan results keyed by (size, mtimeMs). The session list
// cache is invalidated after every agent turn/rename/model change, so full
// rescans are frequent; the memo turns each UNCHANGED file's prefix+suffix
// window reads into a single stat. (path, size, mtimeMs) covers every session
// mutation omp-web cares about. Stored on globalThis for hot-reload safety and
// LRU-bounded (Map iteration order doubles as recency order).
interface SessionScanCacheEntry {
  size: number;
  mtimeMs: number;
  info: OmpSessionInfo;
}

declare global {
  var __ompSessionScanCache: Map<string, SessionScanCacheEntry> | undefined;
}

const MAX_SESSION_SCAN_CACHE_ENTRIES = 2048;

function getSessionScanCache(): Map<string, SessionScanCacheEntry> {
  if (!globalThis.__ompSessionScanCache) globalThis.__ompSessionScanCache = new Map();
  return globalThis.__ompSessionScanCache;
}

/** scanSessionInfo memoized on (path, size, mtimeMs). Callers must treat the
 * returned info as immutable — cache hits share one object. */
function scanSessionInfoCached(filePath: string): OmpSessionInfo | undefined {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }
  const cache = getSessionScanCache();
  const cached = cache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.info;
  }
  if (cached) cache.delete(filePath);
  const info = scanSessionInfo(filePath, true);
  // Failed scans are not negatively cached: a transient read error must not
  // hide a session until its next mtime bump.
  if (info) {
    cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, info });
    while (cache.size > MAX_SESSION_SCAN_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }
  return info;
}

/**
 * List all sessions across all project subdirectories (newest first). Only
 * `<sessionsDir>/<projectDir>/*.jsonl` files are scanned — per-session
 * artifacts directories (session file name minus .jsonl) are skipped because
 * the walk only descends one level and only accepts regular files.
 *
 * The directory walk itself is cached on the sessions root's mtimeMs: creating
 * or deleting any session changes that parent directory's mtime, so the cache
 * invalidates for free on every add/remove while turning repeated listing
 * requests (sidebar poll, page loads) into a single stat. Per-file scanning is
 * still memoized by scanSessionInfoCached on (size, mtimeMs).
 */
export async function listAllSessionInfos(profile?: string): Promise<OmpSessionInfo[]> {
  const sessionsRoot = getSessionsDir(profile);
  const files = await listSessionFiles(sessionsRoot);

  const sessions: OmpSessionInfo[] = [];
  for (const file of files) {
    const info = scanSessionInfoCached(file);
    if (info) sessions.push(info);
  }
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

interface SessionFileListCacheEntry {
  rootMtimeMs: number;
  subMaxMtimeMs: number;
  files: string[];
}

declare global {
  var __ompSessionFileListCache: Map<string, SessionFileListCacheEntry> | undefined;
}

/** Cached walk of `<sessionsRoot>/<project>/*.jsonl`, keyed on the root's
 * mtimeMs. Adding/removing a session bumps the root's mtime, invalidating
 * automatically — except on filesystems where a write inside a project
 * subdirectory does not touch the parent directory's mtime (Windows/NTFS
 * behaves this way in some configurations). Callers that know a session
 * changed must therefore also call invalidateSessionFileListCache(). */
export function invalidateSessionFileListCache(): void {
  globalThis.__ompSessionFileListCache?.clear();
}

export async function listSessionFiles(sessionsRoot: string): Promise<string[]> {
  let rootStat: { mtimeMs: number };
  try {
    rootStat = statSync(sessionsRoot);
  } catch {
    return [];
  }
  if (!globalThis.__ompSessionFileListCache) globalThis.__ompSessionFileListCache = new Map();
  const cache = globalThis.__ompSessionFileListCache;
  const cached = cache.get(sessionsRoot);
  if (cached && cached.rootMtimeMs === rootStat.mtimeMs) {
    // Windows/NTFS: root mtime may not bump when a file is added inside a project subdir.
    // Validate by sampling subdir mtimes (cheap: stat per project dir, not per file).
    let stale = false;
    try {
      for (const dirent of readDirectorySyncRuntime(sessionsRoot, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const subPath = path.join(sessionsRoot, dirent.name);
        const subMtime = statSync(subPath).mtimeMs;
        if (subMtime > cached.subMaxMtimeMs) { stale = true; break; }
      }
    } catch { stale = true; }
    if (!stale) return cached.files;
  }

  const files = collectSessionFiles(sessionsRoot);
  // Remember the root mtime separately from the sampled subdir max: comparing
  // the combined max against the current root mtime never matches once any
  // subdir outgrows the root (the normal NTFS steady state), defeating the cache.
  let subMaxMtimeMs = 0;
  try {
    for (const dirent of readDirectorySyncRuntime(sessionsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      subMaxMtimeMs = Math.max(subMaxMtimeMs, statSync(path.join(sessionsRoot, dirent.name)).mtimeMs);
    }
  } catch {}
  cache.set(sessionsRoot, { rootMtimeMs: rootStat.mtimeMs, subMaxMtimeMs, files });
  return files;
}

function collectSessionFiles(sessionsRoot: string): string[] {
  const files: string[] = [];
  try {
    for (const dirent of readDirectorySyncRuntime(sessionsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const dirPath = path.join(sessionsRoot, dirent.name);
      let inner: Dirent[];
      try {
        inner = readDirectorySyncRuntime(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of inner) {
        if (file.isFile() && file.name.endsWith(".jsonl")) {
          files.push(path.join(dirPath, file.name));
        }
      }
    }
  } catch {
    return [];
  }
  return files;
}

// ============================================================================
// Title updates + deletion
// ============================================================================

/** Strip control characters and collapse runs of spaces (omp's #cleanTitle). */
export function cleanSessionTitle(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Persist a session title. When line 1 is already a title slot the new slot is
 * rewritten IN PLACE: serializeTitleSlot always produces exactly 256 bytes
 * (title truncated by code points to fit), so the overwrite never shifts the
 * rest of the file. Fallback for legacy files without a slot: rewrite the
 * whole file atomically (temp + rename), inserting a fresh slot line and
 * updating the header's title fields.
 *
 * Note: unlike omp's SessionManager.setSessionName this does not append a
 * title_change audit entry — omp-web only needs the display title, and a
 * bounded 256-byte write cannot corrupt a file a live omp process may hold.
 */
export function setSessionTitle(filePath: string, title: string, source: SessionTitleSource): boolean {
  const cleaned = cleanSessionTitle(title);
  if (!cleaned) return false;
  const update: SessionTitleUpdate = { title: cleaned, source, updatedAt: new Date().toISOString() };

  if (readTitleSlot(filePath)) {
    const slotLine = Buffer.from(serializeTitleSlot(update), "utf8");
    const fd = openSync(filePath, "r+");
    try {
      let offset = 0;
      while (offset < slotLine.length) {
        const written = writeSync(fd, slotLine, offset, slotLine.length - offset, offset);
        if (written === 0) throw new Error("Short write while updating session title slot");
        offset += written;
      }
    } finally {
      closeSync(fd);
    }
    return true;
  }

  // Legacy file without a slot: full rewrite through a temp file. Refuse to
  // materialize a file larger than the load ceiling — renaming a session
  // should never risk OOMing the server, and legacy slot-less files are rare.
  let legacySize: number;
  try {
    legacySize = statSync(filePath).size;
  } catch {
    return false;
  }
  if (legacySize > MAX_SESSION_LOAD_BYTES) {
    return false;
  }
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex === -1) throw new Error("Cannot rename an empty session file");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[headerIndex]) as Record<string, unknown>;
  } catch {
    throw new Error("Cannot rename a session file with a malformed header");
  }
  if (header.type !== "session") throw new Error("Not a session file");
  header.title = cleaned;
  header.titleSource = source;
  lines[headerIndex] = JSON.stringify(header);
  const body = serializeTitleSlot(update) + lines.join("\n");

  writeSessionFileAtomicSync(filePath, body, "title");
  return true;
}

/**
 * Replace a session file's contents through a temp file in the same directory
 * plus renameSync. writeFileSync truncates before writing, so a crash or ENOSPC
 * mid-write would permanently destroy the session; rename is atomic, leaving
 * either the old or the new file. Mirrors omp's own atomic session rewrite.
 */
export function writeSessionFileAtomicSync(filePath: string, body: string, tag = "rewrite"): void {
  const dir = path.dirname(filePath);
  const tempDir = mkdtempSync(path.join(dir, `.omp-web-${tag}-`));
  const tempPath = path.join(tempDir, path.basename(filePath));
  try {
    writeFileSync(tempPath, body, "utf8");
    renameSync(tempPath, filePath);
  } finally {
    try {
      rmdirSync(tempDir);
    } catch {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export interface SessionArchiveRoots {
  /** Override the active sessions root for tests or an injected filesystem. */
  sessionsRoot?: string;
  /** Override the OMP archive root for tests or an injected filesystem. */
  archiveRoot?: string;
}

/**
 * Archive one native OMP session using the same layout as `omp gc --archive`:
 * the JSONL is gzip-compressed below `<agent>/archive/sessions`, while its
 * sibling artifacts directory is moved alongside the compressed file. The
 * source file remains byte-for-byte unchanged until the compressed destination
 * is durably renamed; failures roll back both moves where possible.
 */
export function archiveSessionFileWithArtifacts(filePath: string, roots: SessionArchiveRoots = {}): string {
  const sessionsRoot = path.resolve(roots.sessionsRoot ?? getSessionsDir());
  const source = path.resolve(filePath);
  const relative = path.relative(sessionsRoot, source);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    !relative.endsWith(".jsonl")
  ) {
    throw new Error("Session path is outside the active OMP sessions directory");
  }
  if (!lstatSync(source).isFile()) throw new Error("Session path is not a regular file");

  const archiveRoot = path.resolve(roots.archiveRoot ?? getArchivedSessionsDir());
  const destination = path.join(archiveRoot, `${relative}.gz`);
  const legacyDestination = destination.slice(0, -3);
  if (existsSync(destination) || existsSync(legacyDestination)) {
    throw new Error("Archived session destination already exists");
  }

  const sourceArtifacts = source.slice(0, -".jsonl".length);
  // OMP's archive convention keeps the `.jsonl` suffix on the artifacts
  // directory after appending `.gz` to the session file.
  const destinationArtifacts = destination.slice(0, -".gz".length);
  mkdirSync(path.dirname(destination), { recursive: true });
  const tempDir = mkdtempSync(path.join(path.dirname(destination), ".omp-web-archive-"));
  const tempCompressed = path.join(tempDir, path.basename(destination));
  const tempRestore = path.join(tempDir, path.basename(source));
  let destinationCreated = false;
  let sourceRemoved = false;
  let artifactsMoved = false;

  try {
    writeFileSync(tempCompressed, gzipSync(readFileSync(source), { level: 9 }));
    renameSync(tempCompressed, destination);
    destinationCreated = true;
    unlinkSync(source);
    sourceRemoved = true;

    if (existsSync(sourceArtifacts)) {
      if (existsSync(destinationArtifacts)) throw new Error("Archived session artifacts destination already exists");
      mkdirSync(path.dirname(destinationArtifacts), { recursive: true });
      renameSync(sourceArtifacts, destinationArtifacts);
      artifactsMoved = true;
    }
    return destination;
  } catch (error) {
    if (artifactsMoved) {
      try { renameSync(destinationArtifacts, sourceArtifacts); } catch { /* preserve original error */ }
    }
    // Restore the source if it was already removed. Only after the restore
    // SUCCEEDS is the archive safe to delete — if the restore fails, the
    // archive is the only copy of the session left, and deleting it would
    // lose both copies permanently.
    let restored = true; // nothing to restore unless the source was removed
    if (sourceRemoved && destinationCreated) {
      restored = false;
      try {
        writeFileSync(tempRestore, gunzipSync(readFileSync(destination)));
        mkdirSync(path.dirname(source), { recursive: true });
        renameSync(tempRestore, source);
        restored = true;
      } catch { /* preserve original error */ }
    }
    if (destinationCreated && restored) {
      try { unlinkSync(destination); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Delete a session file and its per-session artifacts directory (the sibling
 * directory named after the file minus ".jsonl", holding subagent transcripts).
 */
export function deleteSessionFileWithArtifacts(filePath: string): void {
  unlinkSync(filePath);
  if (!filePath.endsWith(".jsonl")) return;
  const artifactsDir = filePath.slice(0, -".jsonl".length);
  try {
    rmSync(artifactsDir, { recursive: true, force: true });
  } catch {
    // The session file itself is already gone; artifact cleanup is best-effort.
  }
}
