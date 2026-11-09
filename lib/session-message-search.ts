import { createHash, randomUUID } from "crypto";
import { open } from "fs/promises";
import { isRecord } from "./type-guards";
import { listAllSessionInfos, type OmpSessionInfo } from "./omp/session-files";
import { getSessionsDir } from "./omp/paths";

/**
 * Full-text search over the on-disk omp session files.
 *
 * The corpus is several gigabytes, so the scan is deliberately bounded:
 * sessions are opened newest-first and each file is read **backwards** (the
 * newest lines are at the end), one chunk at a time. Every request stops at
 * whichever limit trips first — result count, per-file bytes, total bytes or
 * the wall-clock budget — and returns an opaque cursor that resumes at the next
 * unread line. Only a line above 1 MiB is skipped, and just that case can leave
 * a cursor inside the skipped line. `partial:true` therefore means
 * "more sessions/lines remain", not "the answer is incomplete".
 *
 * Only `message` entries are considered: user and assistant text blocks.
 * Thinking blocks, tool results and tool-call arguments are not searchable,
 * matching what the web transcript actually shows.
 *
 * Scope and limits, so a client never reads more into an empty page than it
 * proves:
 *
 *  - **This machine only.** The scan reads the session directory of the
 *    omp-web process. Sessions of linked hosts (the daemon on another
 *    machine) are not searched and cannot be; the route reports
 *    `scope: "local"` so a native client does not present an empty answer as
 *    a global search.
 *  - **Files above 64 MiB are skipped** and counted in `skippedFiles`; their
 *    messages are not searchable. Lines above 1 MiB are skipped too.
 *  - **Two scans per process.** A third concurrent request is refused with
 *    429 `search_busy` + `Retry-After`; a client that paginates while another
 *    search runs can see that answer.
 *  - **A cursor is a snapshot.** Sessions created after the first page are
 *    not included, and a session that grows between pages is scanned only
 *    below the cursor offset, so lines appended in the meantime are not
 *    returned by that pagination run. The first page's session listing is
 *    bound to the run: every page resolves the same snapshot, so a session
 *    that another client's search re-walked into a different position can
 *    neither be skipped nor returned twice. A run whose snapshot expired
 *    (idle for five minutes, or evicted by newer runs) is refused with
 *    `cursor_expired`; the client restarts the search instead of receiving a
 *    silently incomplete answer.
 *  - **The budget covers the whole page.** The listing walk is charged to the
 *    same 5 s budget as the scan, and the walk yields to the event loop every
 *    few milliseconds, so a cold 4,000-file corpus no longer blocks other
 *    requests or hides its cost from the budget.
 *
 * A request may carry an `AbortSignal`; an aborted scan stops at the next
 * chunk/line boundary and throws `SearchAbortedError`, so the caller's slot is
 * released instead of being held by work nobody reads.
 */

export const SEARCH_TIME_BUDGET_MS = 5_000;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_MAX_QUERY_LENGTH = 200;
/** Files above this size are skipped: reading them would blow the budget. */
export const SEARCH_LARGE_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_FILE_SCAN_BYTES = 16 * 1024 * 1024;
const DEFAULT_TOTAL_SCAN_BYTES = 64 * 1024 * 1024;
/** Longest physical line we try to parse; larger lines are tool payloads. */
const MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const SNIPPET_CONTEXT_CHARS = 80;
/**
 * Maximum extra bytes read after a budget stop to finish the partial line the
 * reader is standing in, so a cursor always points at a line start.
 */
const MAX_LINE_COMPLETION_BYTES = MAX_LINE_BYTES;
const LF = 0x0a;

/**
 * Process-wide ceiling for simultaneous scans. A single scan may spend its
 * whole 5 s budget parsing JSON on the event-loop thread, so unbounded
 * concurrency would starve the SSE stream and every other API call.
 */
export const SEARCH_MAX_CONCURRENT = 2;
// Kept on `globalThis` so every module instance of this file (bundler graphs,
// `bun --hot` re-evaluation) shares one process-wide counter.
interface SearchSlotHost {
  __ompActiveSessionSearches?: number;
}
const searchSlotHost = globalThis as unknown as SearchSlotHost;

/** Reserve a scan slot; the caller MUST call `releaseSearchSlot` afterwards.
 *
 * The read-check-write below is safe because it runs to completion without an
 * `await`: JavaScript is single-threaded, so no other request can observe the
 * counter between the read and the write. Keep it that way — an `await` (or a
 * move to a worker) would need an `Atomics`-backed counter instead. */
export function tryAcquireSearchSlot(): boolean {
  const active = searchSlotHost.__ompActiveSessionSearches ?? 0;
  if (active >= SEARCH_MAX_CONCURRENT) return false;
  searchSlotHost.__ompActiveSessionSearches = active + 1;
  return true;
}

export function releaseSearchSlot(): void {
  const active = searchSlotHost.__ompActiveSessionSearches ?? 0;
  if (active > 0) searchSlotHost.__ompActiveSessionSearches = active - 1;
}

export type SessionSearchRole = "user" | "assistant";

export interface SessionSearchHit {
  sessionId: string;
  title: string;
  cwd: string;
  entryId: string;
  role: SessionSearchRole;
  timestamp: string;
  /** A single-line excerpt around the match. */
  snippet: string;
  /** Match offsets inside `snippet` (UTF-16 code units, like Kotlin strings). */
  matchStart: number;
  matchEnd: number;
}

export interface SessionSearchCursor {
  v: 1;
  /** Fingerprint of the query/option set the cursor belongs to. */
  q: string;
  /**
   * Id of the listing snapshot this run's first page installed. Every page of
   * the run resolves this id, so a continuation can never page a corpus other
   * than the one page 1 scanned — not even after another search re-walked the
   * shared directory.
   */
  l: string;
  /**
   * Session id the scan resumes at. The id — not the session file path — is
   * what the cursor carries: a path would disclose the server's home
   * directory for no benefit, and the id is already in every hit.
   */
  sessionId: string;
  /**
   * Resume scanning bytes strictly below this offset. It is a line start,
   * except after a >1 MiB line was skipped mid-way.
   */
  offset: number;
  /** Used only when the cursor's session vanished: continue with older ones. */
  modifiedMs: number;
}

export interface SessionSearchPage {
  results: SessionSearchHit[];
  /** True when the scan stopped before the corpus was exhausted. */
  partial: boolean;
  /** Opaque token for the next page; null when the scan is complete. */
  cursor: string | null;
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
}

/** One session file the scan can visit; keeps the core testable without omp. */
export interface SessionSearchFile {
  path: string;
  id: string;
  cwd: string;
  title?: string;
  size: number;
  modifiedMs: number;
}

export interface SessionSearchOptions {
  query: string;
  limit?: number;
  cursor?: string;
  /** Aborted by the HTTP layer when the client disconnects. */
  signal?: AbortSignal;
  /** Test hooks; production uses the defaults. */
  now?: () => number;
  budgetMs?: number;
  chunkBytes?: number;
  maxFileScanBytes?: number;
  maxTotalScanBytes?: number;
  sessions?: readonly SessionSearchFile[];
  /** Listing stand-in; production uses `loadSessionSearchFiles`. */
  listSessions?: () => Promise<SessionSearchFile[]>;
}

/** A cursor that does not belong to this query (or was tampered with). */
export class SearchCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchCursorError";
  }
}

/** The request went away; the scan stopped early and its slot was released. */
export class SearchAbortedError extends Error {
  constructor() {
    super("search_aborted");
    this.name = "SearchAbortedError";
  }
}

/** Throw when the caller's request has been aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SearchAbortedError();
}

/** Query fingerprint so a cursor cannot be replayed against another search. */
export function searchQueryKey(query: string): string {
  return createHash("sha1")
    .update(`chat\0${query.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

export function encodeSearchCursor(cursor: SessionSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSearchCursor(raw: string): SessionSearchCursor | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.v !== 1) return undefined;
  if (typeof value.q !== "string" || !value.q) return undefined;
  if (typeof value.l !== "string" || !value.l) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId) return undefined;
  if (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) return undefined;
  if (typeof value.modifiedMs !== "number" || !Number.isFinite(value.modifiedMs)) return undefined;
  return {
    v: 1,
    q: value.q,
    l: value.l,
    sessionId: value.sessionId,
    offset: value.offset,
    modifiedMs: value.modifiedMs,
  };
}

/**
 * Listing snapshots, one per pagination run.
 *
 * A page must never resolve its cursor against a listing other than the one
 * its first page scanned. The corpus moves underneath a run — sessions are
 * created, renamed and rewritten, and another client's search walks the same
 * directory — so a page that re-walked (or reused a shared, re-walked entry)
 * would answer from a *different* ordering: sessions between the two orderings
 * are skipped, and a session that moved below the cursor is scanned twice.
 * Both were reproducible with a real listing and scanner before this design.
 *
 * The first page therefore walks once and installs the result under a fresh
 * id; the cursor carries that id, and every continuation resolves it. Nothing
 * another search does can replace or invalidate a run's snapshot. A snapshot
 * is dropped only when it is evicted (LRU, {@link SEARCH_LISTING_SNAPSHOTS}
 * runs) or unused for {@link SEARCH_LISTING_TTL_MS} — the TTL is sliding, so
 * an actively paginated run never expires. A continuation whose snapshot is
 * gone is refused with `cursor_expired` instead of guessing: walking a fresh
 * corpus would silently skip or repeat hits, and an explicit restart is the
 * only honest answer.
 *
 * A fresh search still walks unconditionally, so a session created a second
 * ago is found even where a write inside a project subdirectory leaves the
 * sessions root's mtime alone (Windows/NTFS; see `listSessionFiles`). The map
 * lives on `globalThis` so `bun --hot` re-evaluations share it.
 *
 * Snapshot ids are unique across processes, not just within one: the counter
 * restarts at 0 after a restart, so ids carry {@link LISTING_ID_NONCE}. A
 * cursor from before a restart therefore resolves nothing and is refused,
 * instead of resolving a new run's snapshot that happens to reuse its number.
 */
const SEARCH_LISTING_TTL_MS = 5 * 60_000;
/** Concurrent pagination runs whose snapshots stay addressable. */
const SEARCH_LISTING_SNAPSHOTS = 4;

interface SearchListingSnapshot {
  id: string;
  /** Sessions root the walk saw; a snapshot never crosses roots. */
  root: string;
  /** Last use, for the sliding TTL and the LRU order. */
  at: number;
  files: readonly SessionSearchFile[];
}

interface SearchListingCacheHost {
  __ompSessionSearchListings?: Map<string, SearchListingSnapshot>;
  /**
   * Monotonic id generator. Deliberately NOT reset by
   * {@link invalidateSessionSearchListing}: ids must never be reused within a
   * process, or a cursor from a dropped run could resolve a later run's
   * snapshot and page a corpus it never scanned. Only the id counter survives
   * an invalidation, and it carries no corpus state.
   */
  __ompSessionSearchListingIds?: number;
}

const listingCacheHost = globalThis as unknown as SearchListingCacheHost;

/**
 * Distinguishes this process's listing ids from those of an earlier one.
 *
 * The counter above restarts at 0 after a server restart, so `l1` minted by a
 * new process would collide with an `l1` an old cursor still names. A cursor
 * is only meaningful against the snapshot it was issued for, and that snapshot
 * died with the old process: without the nonce a new run's first page would
 * claim the recycled id and an old cursor would silently page the new corpus,
 * skipping every session that sorted between the two walks. The nonce makes
 * such a cursor resolve nothing, which the caller reports as `cursor_expired`.
 */
const LISTING_ID_NONCE = randomUUID().slice(0, 8);

/** Drop every pagination listing snapshot (tests and explicit invalidation). */
export function invalidateSessionSearchListing(): void {
  listingCacheHost.__ompSessionSearchListings?.clear();
}

function getListingSnapshots(): Map<string, SearchListingSnapshot> {
  if (!listingCacheHost.__ompSessionSearchListings) {
    listingCacheHost.__ompSessionSearchListings = new Map();
  }
  return listingCacheHost.__ompSessionSearchListings;
}

/**
 * Newest first, equal mtimes ordered by session id. One order for the whole
 * run: it is applied once, when the snapshot is installed, so every page of
 * the run sees the identical sequence.
 */
function sortSessionSearchFiles(files: SessionSearchFile[]): SessionSearchFile[] {
  return files.sort(
    (a, b) => b.modifiedMs - a.modifiedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Production file list: the same newest-first metadata the sidebar uses. */
async function loadSessionSearchFiles(): Promise<SessionSearchFile[]> {
  const infos: OmpSessionInfo[] = await listAllSessionInfos();
  return infos.map((info) => ({
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    ...(info.title ? { title: info.title } : {}),
    size: info.size,
    modifiedMs: info.modified.getTime(),
  }));
}

/** Evict expired snapshots, then the oldest beyond the run cap. */
function pruneListingSnapshots(map: Map<string, SearchListingSnapshot>, now: number): void {
  for (const [id, snapshot] of map) {
    if (now - snapshot.at >= SEARCH_LISTING_TTL_MS) map.delete(id);
  }
  while (map.size > SEARCH_LISTING_SNAPSHOTS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Install a corpus as a new run's listing and return its id. The array is
 * sorted here, once, and stored as-is: pages read it, never mutate it.
 */
export function installSessionSearchListing(
  now: () => number,
  files: SessionSearchFile[],
): { id: string; files: readonly SessionSearchFile[] } {
  const map = getListingSnapshots();
  const next = (listingCacheHost.__ompSessionSearchListingIds ?? 0) + 1;
  listingCacheHost.__ompSessionSearchListingIds = next;
  const id = `l${LISTING_ID_NONCE}-${next}`;
  const sorted = sortSessionSearchFiles(files);
  map.set(id, { id, root: getSessionsDir(), at: now(), files: sorted });
  pruneListingSnapshots(map, now());
  return { id, files: sorted };
}

/**
 * Walk the corpus and install it as a new run's listing. The walk itself is
 * the caller's: production passes {@link loadSessionSearchFiles}, tests pass a
 * stub, and both end up as one immutable snapshot.
 */
export async function startSessionSearchListing(
  now: () => number,
  walk: () => Promise<SessionSearchFile[]> = loadSessionSearchFiles,
): Promise<{ id: string; files: readonly SessionSearchFile[] }> {
  return installSessionSearchListing(now, await walk());
}

/**
 * The listing a continuation pages: exactly the snapshot its first page
 * installed, or `undefined` when that snapshot is gone. Never a re-walk.
 */
export function resumeSessionSearchListing(
  id: string,
  now: () => number,
): readonly SessionSearchFile[] | undefined {
  const map = getListingSnapshots();
  const snapshot = map.get(id);
  if (!snapshot) return undefined;
  if (snapshot.root !== getSessionsDir() || now() - snapshot.at >= SEARCH_LISTING_TTL_MS) {
    map.delete(id);
    return undefined;
  }
  // Re-insert as the most recently used entry: the sliding TTL and the LRU
  // order both follow actual pagination, not the walk that started the run.
  map.delete(id);
  snapshot.at = now();
  map.set(id, snapshot);
  return snapshot.files;
}

interface Segment {
  /** Byte offset of the segment's first byte inside the file. */
  start: number;
  bytes: Buffer;
}

interface ScanOutcome {
  hits: SessionSearchHit[];
  bytes: number;
  cursor?: { offset: number };
  /** The file was read down to byte 0. */
  done: boolean;
}

export async function searchSessionMessages(options: SessionSearchOptions): Promise<SessionSearchPage> {
  const query = options.query.trim();
  const limit = Math.min(Math.max(options.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
  const now = options.now ?? Date.now;
  const chunkBytes = Math.max(1, options.chunkBytes ?? READ_CHUNK_BYTES);
  const fileScanBytes = Math.max(chunkBytes, options.maxFileScanBytes ?? DEFAULT_FILE_SCAN_BYTES);
  const totalScanBytes = Math.max(chunkBytes, options.maxTotalScanBytes ?? DEFAULT_TOTAL_SCAN_BYTES);
  const key = searchQueryKey(query);
  const signal = options.signal;

  if (!query) {
    return { results: [], partial: false, cursor: null, scannedFiles: 0, scannedBytes: 0, skippedFiles: 0 };
  }
  throwIfAborted(signal);

  // Case-insensitive substring search without `toLowerCase()` on the haystack:
  // a lowercasing pass changes the length for some characters (e.g. "İ"), so
  // an offset found there would slice the wrong part of the original text.
  const matcher = new RegExp(escapeRegExp(query), "i");

  // Decode before listing: a cursor that does not belong to this query must
  // not cost a directory walk.
  let cursor: SessionSearchCursor | undefined;
  if (options.cursor) {
    cursor = decodeSearchCursor(options.cursor);
    if (!cursor) throw new SearchCursorError("invalid_cursor");
    if (cursor.q !== key) throw new SearchCursorError("cursor_query_mismatch");
  }

  // Equal mtimes are ordered by session id so the vanished-session fallback
  // below can tell "older" from "same age but already handled" without the
  // cursor having to carry a file path.
  //
  // The corpus is bound to the run: a first page walks once and installs the
  // result under a fresh listing id, the cursor carries that id, and every
  // continuation resolves exactly that snapshot. Nothing another search does
  // to the shared directory can change what this run pages, so a page can
  // neither skip a session that was reordered above it nor rescan one that
  // moved below it.
  //
  // The deadline is armed *before* the walk. The walk itself is bounded by the
  // yielding listing (see `listAllSessionInfos`), so it no longer blocks the
  // event loop for seconds; charging it to the budget keeps the page's total
  // time bounded too, and the first page still returns hits instead of an
  // empty page with a cursor that never advances.
  const deadline = now() + Math.max(1, options.budgetMs ?? SEARCH_TIME_BUDGET_MS);
  const listSessions = options.listSessions;
  let files: readonly SessionSearchFile[];
  let listingId: string;
  if (options.sessions) {
    const installed = installSessionSearchListing(now, [...options.sessions]);
    files = installed.files;
    listingId = installed.id;
  } else if (cursor) {
    const resumed = resumeSessionSearchListing(cursor.l, now);
    if (!resumed) throw new SearchCursorError("cursor_expired");
    files = resumed;
    listingId = cursor.l;
  } else {
    const installed = await startSessionSearchListing(now, listSessions ?? loadSessionSearchFiles);
    files = installed.files;
    listingId = installed.id;
  }
  throwIfAborted(signal);

  let startIndex = 0;
  let startOffset: number | undefined;
  let remainingResults = limit;

  if (cursor) {
    const index = files.findIndex((file) => file.id === cursor.sessionId);
    if (index >= 0) {
      startIndex = index;
      startOffset = cursor.offset;
    } else {
      // The session disappeared between pages: everything older than it is
      // still unscanned, so continue there instead of failing the page.
      // "Older" follows the sort order above (mtime, then session id).
      const fallback = files.findIndex(
        (file) =>
          file.modifiedMs < cursor.modifiedMs ||
          (file.modifiedMs === cursor.modifiedMs && file.id > cursor.sessionId),
      );
      if (fallback < 0) {
        return { results: [], partial: false, cursor: null, scannedFiles: 0, scannedBytes: 0, skippedFiles: 0 };
      }
      startIndex = fallback;
    }
  }

  const results: SessionSearchHit[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let skippedFiles = 0;
  let nextCursor: SessionSearchCursor | null = null;
  let partial = false;

  const cursorFor = (file: SessionSearchFile, offset: number): SessionSearchCursor => ({
    v: 1,
    q: key,
    l: listingId,
    sessionId: file.id,
    offset,
    modifiedMs: file.modifiedMs,
  });

  for (let index = startIndex; index < files.length; index++) {
    // A client that hung up must not keep a slot while its page is built.
    throwIfAborted(signal);
    const file = files[index];
    const resuming = index === startIndex && startOffset !== undefined;
    const boundary = Math.min(resuming ? startOffset! : file.size, file.size);

    if (file.size > SEARCH_LARGE_FILE_BYTES) {
      skippedFiles++;
      continue;
    }
    if (boundary <= 0) continue;
    if (now() >= deadline || scannedBytes >= totalScanBytes) {
      partial = true;
      nextCursor = cursorFor(file, boundary);
      break;
    }

    const outcome = await scanFileBackwards({
      file,
      boundary,
      matcher,
      remainingResults,
      deadline,
      now,
      chunkBytes,
      byteCap: fileScanBytes,
      totalByteCap: totalScanBytes - scannedBytes,
      ...(signal ? { signal } : {}),
    });
    scannedFiles++;
    scannedBytes += outcome.bytes;
    results.push(...outcome.hits);
    remainingResults -= outcome.hits.length;

    if (outcome.cursor) {
      partial = true;
      nextCursor = cursorFor(file, outcome.cursor.offset);
      break;
    }

    if (remainingResults <= 0) {
      // The file itself is exhausted (outcome.done); continue with the next
      // older session if one exists, otherwise the search is complete.
      const nextFile = files[index + 1];
      if (nextFile) {
        partial = true;
        nextCursor = cursorFor(nextFile, nextFile.size);
      }
      break;
    }
  }

  return {
    results,
    partial,
    cursor: nextCursor ? encodeSearchCursor(nextCursor) : null,
    scannedFiles,
    scannedBytes,
    skippedFiles,
  };
}

interface ScanFileOptions {
  file: SessionSearchFile;
  boundary: number;
  matcher: RegExp;
  remainingResults: number;
  deadline: number;
  now: () => number;
  chunkBytes: number;
  byteCap: number;
  totalByteCap: number;
  signal?: AbortSignal;
}

/** A physical line that crosses the current chunk boundary. */
type CarryState = "none" | "partial" | "oversized";

/**
 * Read one session file newest-line-first and collect matching messages.
 *
 * A cursor is returned only when unread bytes remain (byte cap, time budget
 * or the result limit). `offset` is always a line start, so a resumed scan
 * neither skips nor duplicates a line. Lines that cross a chunk edge are
 * carried as bytes until their start is reached; a page ends only after the
 * line it stands in has been finished (bounded by `MAX_LINE_COMPLETION_BYTES`),
 * which keeps the cursor small and independent of the line length.
 */
async function scanFileBackwards(options: ScanFileOptions): Promise<ScanOutcome> {
  const { file, matcher, now, deadline } = options;
  const hits: SessionSearchHit[] = [];
  let boundary = options.boundary;
  let bytesRead = 0;
  let remainingResults = options.remainingResults;
  const byteCap = Math.min(options.byteCap, options.totalByteCap);
  /** Cursor offsets produced here are line starts; so is the incoming one. */
  let atLineStart = true;
  let carry: Buffer | undefined;
  let carryState: CarryState = "none";
  let completionBytes = 0;
  /** The budget tripped inside a line: read on until that line is finished. */
  let completingLine = false;

  let handle;
  try {
    handle = await open(file.path, "r");
  } catch {
    return { hits, bytes: 0, done: true };
  }

  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (boundary > size) boundary = size;

    while (boundary > 0) {
      // Checked per chunk (the read below is the only await in this loop), so
      // an abandoned request stops within one read instead of scanning the
      // rest of the file while holding its slot.
      throwIfAborted(options.signal);
      let chunkLength = Math.min(
        options.chunkBytes,
        boundary,
        byteCap - bytesRead,
        options.totalByteCap - bytesRead,
      );
      if (chunkLength <= 0 || now() >= deadline) {
        if (atLineStart || completionBytes >= MAX_LINE_COMPLETION_BYTES) {
          return { hits, bytes: bytesRead, done: false, cursor: { offset: boundary } };
        }
        // The budget ran out inside a line: finish that line so the next page
        // can resume at a line start instead of carrying bytes in the cursor.
        chunkLength = Math.min(options.chunkBytes, boundary);
        completionBytes += chunkLength;
        completingLine = true;
      }

      const windowStart = boundary - chunkLength;
      // Read up to two bytes below the window: the byte before the window
      // decides whether it splits a line, and the byte before that decides
      // whether the included piece starts a line itself.
      const lookbehind = Math.min(2, windowStart);
      const readStart = windowStart - lookbehind;
      const raw = Buffer.allocUnsafe(boundary - readStart);
      const { bytesRead: read } = await handle.read(raw, 0, raw.length, readStart);
      if (read <= 0 || (read <= lookbehind && read < raw.length)) {
        // The file shrank under us: treat the remaining range as read so the
        // scan cannot spin on a stale size.
        boundary = readStart + Math.max(0, read);
        atLineStart = true;
        carry = undefined;
        carryState = "none";
        continue;
      }
      bytesRead += read;
      const window = raw.subarray(0, read);
      const windowEnd = readStart + read;
      if (read < raw.length) {
        // Short read (truncated file): what we have no longer meets the
        // boundary, so a carried tail cannot be trusted.
        carry = undefined;
        carryState = "none";
      }
      // A byte before the window that is not a LF means the window starts
      // inside a line; include it so that line is not split at the edge.
      const splitsLine = lookbehind > 0 && window[lookbehind - 1] !== LF;
      const dataOffset = splitsLine ? lookbehind - 1 : lookbehind;
      const windowAtLineStart = splitsLine ? lookbehind < 2 || window[lookbehind - 2] === LF : true;
      const data = window.subarray(dataOffset);
      // Absolute offset of data[0].
      const chunkStart = windowEnd - data.length;
      const segments = splitLines(data, chunkStart);
      const endsWithNewline = data.length > 0 && data[data.length - 1] === LF;
      let last = segments.length - 1;
      if (endsWithNewline) last--;
      const first = windowAtLineStart ? 0 : 1;
      // The carried line's start is in this window when a LF splits it from
      // the window's top segment, or when the window itself starts a line.
      const carryLineCompletes =
        carryState !== "none" && (windowAtLineStart || segments.length > 1);

      for (let segmentIndex = last; segmentIndex >= first; segmentIndex--) {
        const segment = segments[segmentIndex];
        let lineBytes: Buffer | undefined = segment.bytes;
        if (segmentIndex === last && carryLineCompletes) {
          // Oversized lines are unsearchable by design; never hand them on.
          lineBytes =
            carryState === "oversized" || !carry ? undefined : Buffer.concat([segment.bytes, carry]);
        }
        if (lineBytes && lineBytes.length <= MAX_LINE_BYTES) {
          const hit = matchLine(lineBytes.toString("utf8"), file, matcher);
          if (hit) {
            hits.push(hit);
            remainingResults--;
          }
        }
        if (remainingResults <= 0 || now() >= deadline) {
          // Resume at this line's start: the lines below it are unscanned.
          return { hits, bytes: bytesRead, done: false, cursor: { offset: segment.start } };
        }
      }

      if (completingLine && carryLineCompletes && first <= last) {
        // The line the budget stopped in is now matched; resume below the
        // lowest line this window processed, so nothing is scanned twice.
        return { hits, bytes: bytesRead, done: false, cursor: { offset: segments[first].start } };
      }

      atLineStart = windowAtLineStart;
      if (windowAtLineStart) {
        carry = undefined;
        carryState = "none";
      } else if (segments.length === 1) {
        // No LF in the window: it is one piece of the carried line, so the
        // pieces have to be joined across chunks until the line start arrives.
        const piece = segments[0].bytes;
        if (carryState === "oversized") {
          carry = undefined;
        } else if (carry && piece.length + carry.length > MAX_LINE_BYTES) {
          carry = undefined;
          carryState = "oversized";
        } else if (carry) {
          carry = Buffer.concat([piece, carry]);
        } else {
          // Resumed mid-line without the upper part (oversized-line bail):
          // keep the bytes so the parse below at least sees one piece.
          carry = piece;
          carryState = "partial";
        }
      } else {
        // A LF ends the carried line above; the top segment now belongs to the
        // line that crosses chunkStart.
        carry = segments[0].bytes;
        carryState = carry.length > MAX_LINE_BYTES ? "oversized" : "partial";
      }
      boundary = chunkStart;
    }

    return { hits, bytes: bytesRead, done: true };
  } catch (error) {
    // An abandoned request is not an unreadable file: let the caller release
    // its slot and answer nothing.
    if (error instanceof SearchAbortedError) throw error;
    // Unreadable file (permissions, deleted mid-scan): skip it, like the list.
    return { hits, bytes: bytesRead, done: true };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Escape a literal string so it can be used as a RegExp pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a byte window at LF; each segment carries its absolute file offset. */
function splitLines(buffer: Buffer, chunkStart: number): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0x0a) {
      segments.push({ start: chunkStart + start, bytes: buffer.subarray(start, index) });
      start = index + 1;
    }
  }
  segments.push({ start: chunkStart + start, bytes: buffer.subarray(start) });
  return segments;
}

/** Parse one physical line and return a hit for a matching message entry. */
function matchLine(
  line: string,
  file: SessionSearchFile,
  matcher: RegExp,
): SessionSearchHit | undefined {
  if (!line.includes('"type"')) return undefined;
  // Cheap reject before the JSON parser: entries omp writes always carry
  // `"type":"message"`; other entry types (model changes, labels, titles)
  // cannot match a message search.
  if (!/"type"\s*:\s*"message"/.test(line)) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const entryId = typeof entry.id === "string" ? entry.id : "";
  if (!entryId) return undefined;
  const message = entry.message;
  const role = message.role;
  let hitRole: SessionSearchRole;
  if (role === "user") hitRole = "user";
  else if (role === "assistant") hitRole = "assistant";
  else return undefined;

  const text = messageText(message.content);
  if (!text) return undefined;
  // Search the original string: lowercasing first can change its length and
  // would shift every offset after such a character.
  const found = matcher.exec(text);
  if (!found) return undefined;

  const index = found.index;
  const matched = found[0];
  const end = index + matched.length;
  const before = text.slice(Math.max(0, index - SNIPPET_CONTEXT_CHARS), index).replace(/\s+/g, " ");
  const after = text.slice(end, end + SNIPPET_CONTEXT_CHARS).replace(/\s+/g, " ");
  const matchText = matched.replace(/\s+/g, " ");
  const leading = index > 0 ? "…" : "";
  const trailing = end < text.length ? "…" : "";
  const snippet = `${leading}${before}${matchText}${after}${trailing}`;
  const matchStart = leading.length + before.length;

  return {
    sessionId: file.id,
    title: file.title ?? "",
    cwd: file.cwd,
    entryId,
    role: hitRole,
    timestamp: timestampOf(entry),
    snippet,
    matchStart,
    matchEnd: matchStart + matchText.length,
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function timestampOf(entry: Record<string, unknown>): string {
  if (typeof entry.timestamp === "string" && entry.timestamp) return entry.timestamp;
  const message = entry.message;
  if (isRecord(message) && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp).toISOString();
  }
  return "";
}
