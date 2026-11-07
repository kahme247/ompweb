// The web server's leg of the message outbox (docs/specs/2026-11-04-message-outbox-design.md, O2 to O4 and O6): a
// message sent to an existing session is stored here before `outbox_add` answers, then sent to omp by one dispatcher
// per session, oldest first and one at a time, and leaves once omp has it. The `session` channel shows the entries.
import { chmodSync, closeSync, mkdirSync, openSync } from "fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "path";
import { Database } from "bun:sqlite";
import { commandErrorResponse, runAgentCommand } from "./agent-command";
import { apiErrorResponse, resolveSessionHostOr404 } from "./api-utils";
import { onHostHello } from "./hosts/hub";
import { STAGED_MAX_AGE_MS } from "./hosts/uploads";
import { validateAgentImages, MAX_AGENT_COMMAND_REQUEST_BYTES, MAX_ATTACHED_IMAGE_BYTES, MAX_TOTAL_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, getBase64DecodedByteLength } from "./image-attachments";
import { listArchivedSessions } from "./omp/archive";
import { getAgentDir } from "./omp/paths";
import { getRpcSession, getRpcSessionKeys, nativeWriteStarted, onSessionMove, tapSessionFrames, type AgentEvent, type AgentSessionWrapper } from "./rpc-manager";
import { isRecord } from "./type-guards";
import type { OutboxEntry, OutboxMode } from "./types";
import { MAX_UPLOADS_PER_MESSAGE, UPLOAD_ID_RE } from "./upload-limits";
import { snapshotOutboxUploads, UploadError, type OutboxUploadReceipt } from "./uploads";
import { resolveWebAuthSecret } from "./web-auth-secret";

/** Delivered (and removed) ids answer a repeated `outbox_add` this long (spec O2: idempotent by id); the browser gives
 * up resending after 7 days, so a resend always finds its id. */
export const KEEP_DELIVERED_MS = 8 * 24 * 60 * 60 * 1000;
/** A session that was busy (restarting, an MCP or history edit) or a host op that timed out: tried again after this. */
export const RETRY_MS = 5_000;
/** Fixed snapshot budget below the browser link's 32 MiB backlog; per-entry error margin and frame envelope included. */
export const MAX_OUTBOX_BYTES = 16 * 1024 * 1024;
const MAX_GLOBAL_OUTBOX_BYTES = 256 * 1024 * 1024;
const MAX_GLOBAL_OUTBOX_ENTRIES = 1000;

const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODES: Record<OutboxMode, true> = { prompt: true, followUp: true, steer: true };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_session_id TEXT,
  mode TEXT NOT NULL,
  message TEXT NOT NULL,
  images TEXT,
  uploads TEXT,
  upload_receipts TEXT,
  owner TEXT NOT NULL,
  advisor INTEGER NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  may_have_been_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  dispatch_pid INTEGER,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  previous_entry_ids TEXT,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS entries_session ON entries (session_id, state);
CREATE TABLE IF NOT EXISTS completed_uploads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, receipt TEXT NOT NULL, at INTEGER NOT NULL);
`;

const COLUMNS = "id, session_id, mode, message, images, uploads, owner, advisor, state, error, may_have_been_sent, created_at, upload_receipts, previous_entry_ids, source_session_id";

/** `owner`: the web session whose uploads the entry attaches; `advisor`: the chat's spawn flag at Send. */
interface Row {
  id: string;
  session_id: string;
  source_session_id: string;
  mode: OutboxMode;
  message: string;
  images: string | null;
  uploads: string | null;
  owner: string;
  upload_receipts: string | null;
  advisor: number;
  state: OutboxEntry["state"];
  error: string | null;
  may_have_been_sent: number;
  created_at: number;
  previous_entry_ids: string | null;
}

declare global {
  var __ompOutboxStore: { path: string; db: Database } | undefined;
  var __ompOutbox: { busy: Set<string>; listeners: Map<string, Set<(entries: OutboxEntry[]) => void>>; started: boolean; maintenance?: NodeJS.Timeout; startupRetry?: NodeJS.Timeout; retries?: Set<NodeJS.Timeout>; detach?: () => void; preparing?: Map<string, object> } | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function outbox(): NonNullable<typeof globalThis.__ompOutbox> {
  return (globalThis.__ompOutbox ??= { busy: new Set(), listeners: new Map(), started: false });
}

/** The store for the current agent directory; reopened when PI_CODING_AGENT_DIR changes. */
function db(): Database {
  const dir = join(getAgentDir(), "omp-web");
  const path = join(dir, "outbox.db");
  const cached = globalThis.__ompOutboxStore;
  if (cached?.path === path) return cached.db;
  mkdirSync(dir, { recursive: true });
  // Owner-only before SQLite opens it: it holds message texts. SQLite gives its -wal/-shm files the same mode.
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    // A fresh WAL switch ignores busy_timeout while another instance holds its exclusive lock (notification-store).
    for (let attempt = 0; ; attempt++) {
      try {
        database.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (!isRecord(error) || error.errno !== 5 || attempt >= 250) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    database.exec("PRAGMA synchronous = NORMAL");
    database.transaction(() => {
      database.exec(SCHEMA);
      const columns = database.prepare("PRAGMA table_info(entries)").all() as { name: string }[];
      for (const [name, type] of [["dispatch_pid", "INTEGER"], ["upload_receipts", "TEXT"], ["payload_bytes", "INTEGER NOT NULL DEFAULT 0"], ["previous_entry_ids", "TEXT"], ["source_session_id", "TEXT"]]) {
        if (!columns.some((column) => column.name === name)) database.exec(`ALTER TABLE entries ADD COLUMN ${name} ${type}`);
      }
      const uploadColumns = database.prepare("PRAGMA table_info(completed_uploads)").all() as { name: string }[];
      for (const name of ["proof", "scope"]) {
        if (!uploadColumns.some((column) => column.name === name)) database.exec(`ALTER TABLE completed_uploads ADD COLUMN ${name} TEXT`);
      }
      database.exec("UPDATE entries SET source_session_id = session_id WHERE source_session_id IS NULL");
      for (const entry of database.prepare(`SELECT ${COLUMNS} FROM entries WHERE state != 'delivered' AND payload_bytes = 0`).all() as Row[]) {
        database.prepare("UPDATE entries SET payload_bytes = ? WHERE id = ?").run(Buffer.byteLength(JSON.stringify(toEntry(entry))) + 8192, entry.id);
      }
    }).immediate();
  } catch (error) {
    database.close(true);
    throw error;
  }
  cached?.db.close(true);
  globalThis.__ompOutboxStore = { path, db: database };
  return database;
}

/** Closes the cached store. `close(true)` finalizes the statements still alive: without it the file stays open until GC, and Windows keeps it locked. */
export function closeOutboxStore(): void {
  const state = globalThis.__ompOutbox;
  if (state) {
    clearInterval(state.maintenance);
    clearTimeout(state.startupRetry);
    for (const timer of state.retries ?? []) clearTimeout(timer);
    state.retries?.clear();
    state.detach?.();
    state.detach = undefined;
    state.maintenance = undefined;
    state.startupRetry = undefined;
    state.started = false;
  }
  globalThis.__ompOutboxStore?.db.close(true);
  globalThis.__ompOutboxStore = undefined;
}

/** Main-issued completion authority is committed before "done"; replays never renew its original staging lifetime. */
export function saveCompletedUpload(owner: string, receipt: OutboxUploadReceipt): string | undefined {
  const database = db();
  return database.transaction(() => {
    const stored = database.prepare("SELECT owner, receipt, at, proof, scope FROM completed_uploads WHERE id = ?").get(receipt.id) as CompletedUploadRow | null;
    const scope = outboxScope();
    if (stored) {
      const prior = JSON.parse(stored.receipt) as OutboxUploadReceipt;
      if (stored.owner !== owner || prior.hostId !== receipt.hostId || prior.name !== receipt.name || prior.size !== receipt.size || prior.type !== receipt.type) {
        throw new UploadError(409, "upload_id_conflict", "Another upload has this id");
      }
      if (Date.now() - stored.at > STAGED_MAX_AGE_MS) return undefined;
      if (stored.proof) return stored.scope === scope ? stored.proof : undefined;
      const proof = randomBytes(32).toString("base64url");
      database.prepare("UPDATE completed_uploads SET proof = ?, scope = ? WHERE id = ?").run(proof, scope, receipt.id);
      const completionKey = createHash("sha256").update(proof).digest("hex");
      const held = database.prepare("SELECT id, owner, upload_receipts FROM entries WHERE state != 'delivered' AND upload_receipts IS NOT NULL")
        .all() as { id: string; owner: string; upload_receipts: string }[];
      for (const entry of held) {
        const receipts = JSON.parse(entry.upload_receipts) as OutboxUploadReceipt[];
        let changed = false;
        for (const saved of receipts) {
          if (saved.id !== receipt.id || (saved.owner ?? entry.owner) !== owner || saved.completionKey !== undefined
            || (saved.completedAt !== undefined && saved.completedAt !== stored.at)
            || saved.hostId !== prior.hostId || saved.name !== prior.name || saved.size !== prior.size || saved.type !== prior.type) continue;
          saved.completionKey = completionKey;
          saved.completedAt = stored.at;
          changed = true;
        }
        if (changed) {
          const encoded = JSON.stringify(receipts);
          database.prepare("UPDATE entries SET upload_receipts = ?, payload_bytes = payload_bytes + ? WHERE id = ?")
            .run(encoded, Buffer.byteLength(encoded) - Buffer.byteLength(entry.upload_receipts), entry.id);
        }
      }
      return proof;
    }
    const proof = randomBytes(32).toString("base64url");
    database.prepare("INSERT INTO completed_uploads (id, owner, receipt, at, proof, scope) VALUES (?, ?, ?, ?, ?, ?)")
      .run(receipt.id, owner, JSON.stringify(receipt), Date.now(), proof, scope);
    return proof;
  }).immediate();
}

interface CompletedUploadRow { owner: string; receipt: string; at: number; proof: string | null; scope: string | null }

/** Private authority only: never include this result in browser snapshots or native commands. */
export function completedUpload(id: string): { owner: string; receipt: OutboxUploadReceipt; at: number; proof: string | null; scope: string | null } | null {
  const stored = db().prepare("SELECT owner, receipt, at, proof, scope FROM completed_uploads WHERE id = ?").get(id) as CompletedUploadRow | null;
  if (!stored || Date.now() - stored.at > STAGED_MAX_AGE_MS) return null;
  return { ...stored, receipt: JSON.parse(stored.receipt) as OutboxUploadReceipt };
}

export function forgetCompletedUpload(id: string, expected?: Pick<CompletedUploadRow, "owner" | "at" | "proof">): void {
  if (expected) {
    db().prepare("DELETE FROM completed_uploads WHERE id = ? AND owner = ? AND at = ? AND proof IS ?")
      .run(id, expected.owner, expected.at, expected.proof);
  } else db().prepare("DELETE FROM completed_uploads WHERE id = ?").run(id);
}

/** Accepted authority reserves an id even if its staging registration was canceled or consumed. */
export function outboxUsesUpload(id: string): boolean {
  return db().prepare("SELECT 1 FROM entries, json_each(entries.uploads) AS upload WHERE entries.state != 'delivered' AND upload.value = ? LIMIT 1").get(id) !== null;
}

function row(id: string): Row | null {
  return db().prepare(`SELECT ${COLUMNS} FROM entries WHERE id = ?`).get(id) as Row | null;
}

function toEntry(entry: Row): OutboxEntry {
  return {
    id: entry.id,
    sessionId: entry.session_id,
    mode: entry.mode,
    message: entry.message,
    ...(entry.images ? { images: JSON.parse(entry.images) as OutboxEntry["images"] } : {}),
    ...(entry.uploads ? { uploads: JSON.parse(entry.uploads) as string[] } : {}),
    state: entry.state,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.may_have_been_sent ? { mayHaveBeenSent: true } : {}),
    ...(entry.state === "delivering" && entry.previous_entry_ids ? { previousEntryIds: JSON.parse(entry.previous_entry_ids) as string[] } : {}),
    createdAt: entry.created_at,
  };
}

/** A session's entries not delivered yet, in submission order. An unreadable store must fail explicitly, not tell a
 * browser that its held messages have vanished. */
export function outboxEntries(sessionId: string): OutboxEntry[] {
  const keys = sessionKeys(sessionId);
  const rows = db().prepare(`SELECT ${COLUMNS} FROM entries WHERE session_id IN (${slots(keys)}) AND state != 'delivered' ORDER BY rowid`).all(...keys) as Row[];
  return rows.map((entry) => ({ ...toEntry(entry), sessionId }));
}

/** Recent tombstones let a browser retire its first-leg bridge even if it subscribes after the message was delivered. */
export function outboxSettledIds(sessionId: string): string[] {
  const keys = sessionKeys(sessionId);
  return (db().prepare(`SELECT id FROM entries WHERE session_id IN (${slots(keys)}) AND state = 'delivered' AND done_at >= ? ORDER BY done_at DESC, rowid DESC LIMIT 256`)
    .all(...keys, Date.now() - KEEP_DELIVERED_MS) as { id: string }[]).map(({ id }) => id);
}

function sessionKeys(sessionId: string): string[] {
  const wrapper = getRpcSession(sessionId);
  return [...new Set([sessionId, ...getRpcSessionKeys(sessionId), ...(wrapper?.sessionId ? [wrapper.sessionId] : [])])];
}
const slots = (keys: string[]) => keys.map(() => "?").join(",");

function entryBelongsToSession(entry: Row, sessionId: string): boolean {
  return entry.session_id === sessionId || entry.source_session_id === sessionId || sessionKeys(sessionId).includes(entry.session_id);
}

/** Call `listener` with the session's entries after every change. */
export function onOutboxChange(sessionId: string, listener: (entries: OutboxEntry[]) => void): () => void {
  const { listeners } = outbox();
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(sessionId) === set) listeners.delete(sessionId);
  };
}

function publish(sessionId: string): void {
  const keys = sessionKeys(sessionId);
  const canonical = getRpcSession(sessionId)?.sessionId;
  if (canonical && keys.length > 1) {
    // Native identity moves keep old registry keys. Ordinary branch/switch drops them and cannot migrate other rows.
    db().prepare(`UPDATE entries SET session_id = ? WHERE session_id IN (${slots(keys)})`).run(canonical, ...keys);
  }
  for (const key of keys) {
    const listeners = outbox().listeners.get(key);
    if (!listeners?.size) continue;
    const entries = outboxEntries(key);
    for (const listener of [...listeners]) listener(entries);
  }
}

function setState(id: string, state: OutboxEntry["state"], error: string | null = null, mayHaveBeenSent = false): boolean {
  return db().prepare("UPDATE entries SET state = ?, error = ?, may_have_been_sent = ?, previous_entry_ids = CASE WHEN ? = 'delivering' THEN previous_entry_ids ELSE NULL END WHERE id = ? AND state IN ('held', 'waiting_host', 'delivering')")
    .run(state, error?.slice(0, 1024) ?? null, mayHaveBeenSent ? 1 : 0, state, id).changes > 0;
}

/** Delivered, or removed by the user: the id stays (without the message) so a late resend of it (keepalive, Background
 * Sync) is answered instead of added again. */
function retire(id: string): void {
  db().prepare("UPDATE entries SET state = 'delivered', message = '', images = NULL, uploads = NULL, upload_receipts = NULL, previous_entry_ids = NULL, error = NULL, done_at = ? WHERE id = ?").run(Date.now(), id);
}

const invalid = (error: string) => Response.json({ error, code: "invalid_outbox_entry" }, { status: 400 });

/** Nonsecret namespace for browser-held sends: stable across cookie renewal, different after installation or
 * credential changes. Never bind an old entry to the new namespace automatically. */
export function outboxScope(): string {
  const secret = resolveWebAuthSecret();
  return createHmac("sha256", Buffer.from(secret.key, "base64url"))
    .update(`omp-web-outbox-scope-v1\0${secret.salt}\0${(process.env.OMP_WEB_PASSWORD_HASH ?? "").trim()}\0${(process.env.OMP_WEB_TRUSTED_HEADER_SHA256 ?? "").trim()}`)
    .digest("base64url");
}

/** `outbox_add` / `outbox_remove` for `sessionId`, as runAgentCommand answers them. */
export async function runOutboxCommand(sessionId: string, command: Record<string, unknown>, advisor: boolean, owner: string): Promise<Response> {
  if (command.type === "outbox_scope") return Response.json({ success: true, data: { scope: outboxScope() } });
  if (command.type === "outbox_add" && command.scope !== outboxScope()) {
    return Response.json({
      error: "This message belongs to another omp-web installation or sign-in configuration.",
      code: "outbox_scope_changed",
    }, { status: 409 });
  }
  const { id } = command;
  if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) return invalid("id must be 1 to 64 letters, digits, - or _");
  if (command.type === "outbox_remove") return removeEntry(sessionId, id);

  const known = row(id);
  if (known) {
    if (!entryBelongsToSession(known, sessionId)) return Response.json({ error: "This message id belongs to another session", code: "outbox_id_conflict" }, { status: 409 });
    return Response.json({ success: true, data: { entry: toEntry(known) } });
  }
  const { mode, message, images, uploads } = command;
  if (typeof mode !== "string" || !Object.hasOwn(MODES, mode)) return invalid("mode must be prompt, followUp or steer");
  if (typeof message !== "string") return invalid("message must be a string");
  if (Buffer.byteLength(JSON.stringify(command)) > MAX_AGENT_COMMAND_REQUEST_BYTES) {
    return Response.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  const imageError = validateAgentImages(images);
  if (imageError) {
    const sizes = Array.isArray(images) ? images.map((image) => isRecord(image) && typeof image.data === "string" ? getBase64DecodedByteLength(image.data) ?? 0 : 0) : [];
    const oversized = sizes.length > MAX_ATTACHED_IMAGES || sizes.some((size) => size > MAX_ATTACHED_IMAGE_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_ATTACHED_IMAGE_BYTES;
    return oversized ? Response.json({ error: imageError, code: "request_too_large" }, { status: 413 }) : invalid(imageError);
  }
  if (uploads !== undefined && (
    !Array.isArray(uploads) || uploads.length > MAX_UPLOADS_PER_MESSAGE || new Set(uploads).size !== uploads.length
    || !uploads.every((upload) => typeof upload === "string" && UPLOAD_ID_RE.test(upload))
  )) {
    return invalid(`uploads must be at most ${MAX_UPLOADS_PER_MESSAGE} upload ids`);
  }
  const resolved = await resolveSessionHostOr404(sessionId);
  // Unavailable host lists cannot prove absence: retain the entry until discovery can resolve its owner. An archived
  // session is not gone either: its entries wait until it is restored (spec O6).
  if ("response" in resolved && resolved.response.status === 404 && !(await isArchived(sessionId))) return resolved.response;

  const now = Date.now();
  const database = db();
  database.prepare("DELETE FROM entries WHERE state = 'delivered' AND done_at < ?").run(now - KEEP_DELIVERED_MS);
  const keys = sessionKeys(sessionId);
  const entryBytes = Buffer.byteLength(JSON.stringify({ id, sessionId, mode, message, images, uploads, state: "waiting_host", createdAt: now })) + 8192;
  let accepted: boolean;
  try {
    accepted = database.transaction(() => {
      if (row(id)) return true; // a concurrent repeat takes no capacity or renewed proof
      const uploadReceipts = snapshotOutboxUploads(Array.isArray(uploads) ? uploads as string[] : [], owner, command.uploadProofs);
      const savedUploads = uploadReceipts.length ? JSON.stringify(uploadReceipts) : null;
      const payloadBytes = entryBytes + (savedUploads ? Buffer.byteLength(savedUploads) : 0);
      const total = database.prepare(`SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM entries WHERE session_id IN (${slots(keys)}) AND state != 'delivered'`).get(...keys) as { bytes: number };
      if (total.bytes + payloadBytes > MAX_OUTBOX_BYTES - 64 * 1024) return false;
      const global = database.prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS bytes, COUNT(*) AS count FROM entries WHERE state != 'delivered'").get() as { bytes: number; count: number };
      if (global.bytes + payloadBytes > MAX_GLOBAL_OUTBOX_BYTES || global.count >= MAX_GLOBAL_OUTBOX_ENTRIES) return false;
      database.prepare(`INSERT INTO entries (${COLUMNS}, payload_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', NULL, 0, ?, ?, NULL, ?, ?)`).run(
        id, sessionId, mode, message,
        Array.isArray(images) && images.length ? JSON.stringify(images) : null,
        Array.isArray(uploads) && uploads.length ? JSON.stringify(uploads) : null,
        owner, advisor ? 1 : 0, now,
        savedUploads,
        sessionId, payloadBytes,
      );
      return true;
    }).immediate();
  } catch (error) {
    return commandErrorResponse(error);
  }
  if (!accepted) return Response.json({ error: "The message outbox is full. It will accept more messages after held entries drain or are deleted.", code: "outbox_full" }, { status: 429 });
  if (!entryBelongsToSession(row(id)!, sessionId)) return Response.json({ error: "This message id belongs to another session", code: "outbox_id_conflict" }, { status: 409 });
  publish(sessionId);
  pumpOutbox(sessionId);
  return Response.json({ success: true, data: { entry: toEntry(row(id)!) } });
}

function removeEntry(sessionId: string, id: string): Response {
  let removed: Row | null = null;
  const response = db().transaction(() => {
    const entry = row(id);
    if (!entry || !entryBelongsToSession(entry, sessionId) || entry.state === "delivered") {
      return Response.json({ success: true, data: { removed: false } });
    }
    if (entry.state === "delivering") {
      return Response.json({ error: "This message is already being delivered.", code: "outbox_dispatched" }, { status: 409 });
    }
    retire(id);
    removed = entry;
    return Response.json({ success: true, data: { removed: true, entry: { ...toEntry(entry), sessionId } } });
  }).immediate();
  if (removed) {
    publish((removed as Row).session_id);
    if ((removed as Row).session_id !== sessionId) publish(sessionId);
  }
  return response;
}

/** Send the session's oldest held entry unless one of its entries is in flight. Never throws. */
export function pumpOutbox(sessionId: string): void {
  const { busy } = outbox();
  const keys = sessionKeys(sessionId);
  if (keys.some((key) => busy.has(key))) return;
  let next: Row | null;
  try {
    for (const key of keys) recoverDelivering(key);
    if (db().prepare(`SELECT 1 FROM entries WHERE session_id IN (${slots(keys)}) AND state = 'delivering'`).get(...keys)) return;
    next = db().prepare(`SELECT ${COLUMNS} FROM entries WHERE session_id IN (${slots(keys)}) AND state IN ('held', 'waiting_host') ORDER BY rowid LIMIT 1`).get(...keys) as Row | null;
  } catch (error) {
    console.warn(`[omp-web] outbox: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!next) return;
  for (const key of keys) busy.add(key);
  const release = () => { for (const key of keys) busy.delete(key); };
  void deliver(next).then((outcome) => {
    release();
    if (outcome === "next") pumpOutbox(sessionId);
    else if (outcome === "offline") {
      const linkedKeys = sessionKeys(sessionId);
      db().prepare(`UPDATE entries SET state = 'waiting_host', error = NULL WHERE session_id IN (${slots(linkedKeys)}) AND (state = 'held' OR (id = ? AND state = 'delivering' AND dispatch_pid = ?))`)
        .run(...linkedKeys, next.id, process.pid);
      publish(sessionId);
    }
  }).catch((error: unknown) => {
    release();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[omp-web] outbox delivery failed: ${message}`);
    try {
      // Thrown before the claim, it is not sent and nothing else would pump it again.
      const state = row(next.id)?.state;
      if (state === "delivering") fail(next, message, true);
      else if (state === "held" || state === "waiting_host") retry(next);
    } catch {
      // The store itself failed; the next start settles a "delivering" row.
    }
  });
}

function pumpAll(): void {
  try {
    const rows = db().prepare("SELECT DISTINCT session_id FROM entries WHERE state IN ('held', 'waiting_host', 'delivering')").all() as { session_id: string }[];
    for (const { session_id } of rows) pumpOutbox(session_id);
  } catch (error) {
    console.warn(`[omp-web] outbox: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** At startup: settle what the last server left in flight, then dispatch stored entries now and on every host link.
 * A second instance sharing the agent dir must not fail or resend another live process's delivery. */
export function startOutbox(): void {
  const state = outbox();
  if (state.started) return;
  clearTimeout(state.startupRetry);
  state.startupRetry = undefined;
  try {
    db();
    recoverDelivering(undefined, true);
    db().prepare("DELETE FROM entries WHERE state = 'delivered' AND done_at < ?").run(Date.now() - KEEP_DELIVERED_MS);
    db().prepare("DELETE FROM completed_uploads WHERE at < ?").run(Date.now() - STAGED_MAX_AGE_MS);
  } catch (error) {
    console.warn(`[omp-web] outbox startup failed: ${error instanceof Error ? error.message : String(error)}`);
    state.startupRetry = setTimeout(() => {
      state.startupRetry = undefined;
      if (globalThis.__ompOutbox === state) startOutbox();
    }, RETRY_MS);
    state.startupRetry.unref?.();
    return;
  }
  process.once("exit", closeOutboxStore);
  const detachHello = onHostHello(() => { if (globalThis.__ompOutbox === state && state.started) pumpAll(); });
  const detachFrames = tapSessionFrames((wrapper, event) => {
    if (globalThis.__ompOutbox === state && state.started) onChildExit(wrapper, event);
  });
  const detachMoves = onSessionMove((from) => {
    if (globalThis.__ompOutbox === state && state.started) publish(from);
  });
  state.detach = () => {
    process.removeListener("exit", closeOutboxStore);
    detachHello();
    detachFrames();
    detachMoves();
  };
  // A live owner at boot can die later without another add or hello. Recover its claim, never resend it.
  const maintenance = setInterval(() => {
    if (globalThis.__ompOutbox !== state) { clearInterval(maintenance); return; }
    try {
      const rows = db().prepare("SELECT DISTINCT session_id FROM entries WHERE state = 'delivering'").all() as { session_id: string }[];
      for (const { session_id } of rows) pumpOutbox(session_id);
    } catch (error) {
      console.warn(`[omp-web] outbox maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, RETRY_MS);
  state.maintenance = maintenance;
  maintenance.unref?.();
  state.started = true;
  pumpAll();
}

/** A live instance owns its delivery. An orphaned claim is uncertain, never replayed by this dispatcher. */
function recoverDelivering(sessionId?: string, startup = false): void {
  const inFlight = db().prepare(`SELECT id, session_id, dispatch_pid FROM entries WHERE state = 'delivering'${sessionId ? " AND session_id = ?" : ""}`)
    .all(...(sessionId ? [sessionId] : [])) as { id: string; session_id: string; dispatch_pid: number | null }[];
  for (const entry of inFlight) {
    // At startup a same-PID row is usually a reused PID from the last run; only a claim this process holds in memory is live.
    if (entry.dispatch_pid === process.pid && (!startup || outbox().busy.has(entry.session_id))) continue;
    if (entry.dispatch_pid && entry.dispatch_pid !== process.pid) {
      try {
        process.kill(entry.dispatch_pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") continue;
      }
    }
    setState(entry.id, "failed", "omp-web restarted while this message was being delivered", true);
    publish(entry.session_id);
  }
}

/** Lifecycle bookkeeping only. Text equality is NOT delivery identity, especially after an unknown/lost reply.
 * An entry this process claimed but whose command no wrapper has begun writing is left to its dispatcher, which
 * retries it. */
function onChildExit(wrapper: AgentSessionWrapper, event: AgentEvent): void {
  if (event.type !== "process_exit") return;
  const preparing = outbox().preparing;
  for (const key of sessionKeys(wrapper.sessionId)) {
    const inFlight = db().prepare(`SELECT ${COLUMNS} FROM entries WHERE session_id = ? AND state = 'delivering' AND dispatch_pid = ?`).all(key, process.pid) as Row[];
    for (const entry of inFlight) {
      const command = preparing?.get(entry.id);
      if (!command || nativeWriteStarted(command)) fail(entry, "omp exited while this message was being delivered", true);
    }
  }
}

/** After one entry's delivery: "next" when the session's next entry may go now (this one left the queue, or failed),
 * "offline" when the host is down (every entry waits for its next hello), "wait" when a timer or a restore resumes it. */
type Outcome = "next" | "wait" | "offline";

async function deliver(entry: Row): Promise<Outcome> {
  const sessionId = entry.session_id;
  if (entry.uploads && Date.now() - entry.created_at > STAGED_MAX_AGE_MS) {
    // The host's sweep has removed the staged files by now (spec O3): never send the message without them.
    return fail(entry, "The attached files are gone: attach them again", false);
  }
  // Start (or join) the session's omp first, as any command would, so the echo watch is on the wrapper that gets it.
  const priorWrapper = getRpcSession(sessionId);
  const generation = priorWrapper?.getMessageCommandGeneration() ?? 0;
  const competingPending = priorWrapper?.hasPendingMessageCommands() ?? false;
  const started = await runAgentCommand(sessionId, { type: "get_state" }, entry.advisor === 1, entry.owner);
  const wrapper = getRpcSession(sessionId);
  const current = row(entry.id);
  if (!current || (current.state !== "held" && current.state !== "waiting_host")) return "next";
  if (!started.ok) return refused(current, started, false);
  if (!wrapper?.isAlive()) return retry(current);
  if (wrapper.getMessageCommandGeneration() !== (priorWrapper === wrapper ? generation : 0)
    || (competingPending && !wrapper.hasPendingMessageCommands())) return "next";
  if (competingPending && !wrapper.isRunning()) {
    try {
      if (await wrapper.renewMessageProofBoundaryIfIdle()) return "next";
    } catch (error) {
      return refused(current, commandErrorResponse(error), false);
    }
  }
  const idle = !wrapper.isRunning();
  const keys = sessionKeys(sessionId);
  // A cold start can discover native aliases. Re-select across them before claiming, so an older alias wins.
  const oldest = db().prepare(`SELECT id FROM entries WHERE session_id IN (${slots(keys)}) AND state IN ('held', 'waiting_host') ORDER BY rowid LIMIT 1`).get(...keys) as { id: string } | null;
  if (oldest?.id !== current.id) return "next";
  // Give legacy accepted authority its immutable generation before transcript/attachment preparation can yield.
  for (const receipt of current.upload_receipts ? JSON.parse(current.upload_receipts) as OutboxUploadReceipt[] : []) {
    if (receipt.completionKey !== undefined) continue;
    const stored = completedUpload(receipt.id);
    if (stored && !stored.proof && stored.owner === (receipt.owner ?? current.owner)
      && (receipt.completedAt === undefined || receipt.completedAt === stored.at)
      && stored.receipt.hostId === receipt.hostId && stored.receipt.name === receipt.name
      && stored.receipt.size === receipt.size && stored.receipt.type === receipt.type) saveCompletedUpload(stored.owner, stored.receipt);
  }
  const savedUploads = row(current.id)?.upload_receipts;
  const uploadReceipts = savedUploads ? JSON.parse(savedUploads) as OutboxUploadReceipt[] : undefined;
  if (uploadReceipts?.some((receipt) => receipt.completedAt !== undefined && Date.now() - receipt.completedAt > STAGED_MAX_AGE_MS)) {
    return fail(current, "The attached files are gone: attach them again", false);
  }
  const command: Record<string, unknown> = {
    ...commandOf(current, !idle),
    message: current.message,
    ...(current.images ? { images: JSON.parse(current.images) as unknown } : {}),
    ...(current.uploads ? { uploads: JSON.parse(current.uploads) as unknown } : {}),
  };
  const claimed = db().prepare(`UPDATE entries SET state = 'delivering', dispatch_pid = ? WHERE id = ? AND state IN ('held', 'waiting_host') AND NOT EXISTS (SELECT 1 FROM entries WHERE session_id IN (${slots(keys)}) AND state = 'delivering')`).run(process.pid, current.id, ...keys);
  if (!claimed.changes) return "wait";
  // Claimed but not written yet: anything that stops it before a wrapper begins its native write (including
  // attachment preparation and fences inside runAgentCommand) leaves it unsent, so it is retried.
  const preparing = (outbox().preparing ??= new Map());
  preparing.set(current.id, command);
  let baseline: { data?: { queuedMessages?: unknown } };
  let previousEntryIds: string[] | undefined;
  let handedOn = false;
  try {
    baseline = await started.json() as { data?: { queuedMessages?: unknown } };
    if (idle) {
      try {
        const boundary = await wrapper.withPendingCommand(() => wrapper.host.sessionOps.readContext(wrapper.sessionId, undefined, { boundary: true, deferThinking: true, deferMedia: true, includePreCompaction: false, sync: null }));
        let entryIds: string[];
        if (boundary.ok && isRecord(boundary.value) && Array.isArray(boundary.value.entryIds) && boundary.value.entryIds.every((id) => typeof id === "string")) {
          entryIds = boundary.value.entryIds;
        } else if (!boundary.ok && boundary.status === 404 && !(await wrapper.host.sessionFileExists(wrapper.sessionFile))) {
          entryIds = [];
        } else if (!boundary.ok) {
          return refused(current, Response.json({ error: boundary.error, code: boundary.code, hostOffline: boundary.code === "host_offline" }, { status: boundary.status }), false);
        } else {
          return fail(current, "Could not read the saved transcript boundary before sending", false);
        }
        db().prepare("UPDATE entries SET previous_entry_ids = ? WHERE id = ?").run(JSON.stringify(entryIds), current.id);
        previousEntryIds = entryIds;
        if (Buffer.byteLength(JSON.stringify({ entries: outboxEntries(sessionId), settledIds: outboxSettledIds(sessionId) })) > MAX_OUTBOX_BYTES) {
          return fail(current, "The saved transcript boundary exceeds the outbox snapshot limit", false);
        }
      } catch (error) {
        return refused(current, apiErrorResponse(error), false);
      }
    }
    if (!wrapper.isAlive()) return retry(current);
    if (row(current.id)?.state !== "delivering") return "next";
    if (wrapper.getMessageCommandGeneration() !== (priorWrapper === wrapper ? generation : 0)
      || (competingPending && !wrapper.hasPendingMessageCommands())) {
      // Another command finished during preparation, before THIS native write: discard stale mode/queue/history data.
      setState(current.id, "held");
      publish(sessionId);
      return "next";
    }
    handedOn = true;
  } catch (error) {
    console.warn(`[omp-web] outbox: ${error instanceof Error ? error.message : String(error)}`);
    return retry(current);
  } finally {
    if (!handedOn) preparing.delete(current.id);
  }
  const replacement = wrapper.watchMessageReplacement(command, baseline.data?.queuedMessages, priorWrapper === wrapper ? generation : 0, competingPending, previousEntryIds);
  publish(sessionId);
  try {
    // attachUploads mutates this same command before writing it: the watcher matches the final attachment block too.
    const response = await runAgentCommand(sessionId, command, current.advisor === 1, current.owner, uploadReceipts);
    if (!response.ok) {
      // Nothing was written: a gone child is retried, and any other refusal is classified as not sent.
      const written = nativeWriteStarted(command);
      if (!written && !wrapper.isAlive()) return retry(current);
      return refused(current, response, written);
    }
    const body = await response.json() as { data?: { agentInvoked?: boolean } };
    if (row(current.id)?.state === "failed") return "next";
    const handOff = body.data?.agentInvoked === false ? {} : await replacement.handOff();
    // Proven dropped (spec O6) leaves the child untainted, like a delivery: no renewal before the next message.
    if (!handOff.error || handOff.mayHaveBeenSent === false) wrapper.confirmMessageCommandGeneration((priorWrapper === wrapper ? generation : 0) + 1);
    if (handOff.error) return fail(current, handOff.error, handOff.mayHaveBeenSent === true);
    retire(current.id);
    publish(sessionId);
    return "next";
  } finally {
    preparing.delete(current.id);
    replacement.stop();
  }
}

/** How an entry goes to omp (spec O3): a prompt during a run as a follow-up, a steer with no run to steer as a
 * follow-up. omp expands slash commands and prompt templates in `prompt` only, so one sent during a run goes as a
 * prompt with its streamingBehavior (queued like a follow-up or steer). */
function commandOf(entry: Row, running: boolean): { type: string; streamingBehavior?: "steer" | "followUp" } {
  const slash = entry.message.startsWith("/");
  if (!running) return { type: entry.mode === "prompt" || slash ? "prompt" : "follow_up" };
  if (slash) return { type: "prompt", streamingBehavior: entry.mode === "steer" ? "steer" : "followUp" };
  return { type: entry.mode === "steer" ? "steer" : "follow_up" };
}


function fail(entry: Row, error: string, mayHaveBeenSent: boolean): Outcome {
  if (setState(entry.id, "failed", error, mayHaveBeenSent)) publish(entry.session_id);
  return "next";
}

/** Not sent yet, for a passing reason: held again and tried after RETRY_MS. */
function retry(entry: Row): Outcome {
  if (!setState(entry.id, "held")) return "next";
  publish(entry.session_id);
  const state = outbox();
  const retries = (state.retries ??= new Set());
  const timer = setTimeout(() => {
    retries.delete(timer);
    if (globalThis.__ompOutbox === state) pumpOutbox(entry.session_id);
  }, RETRY_MS);
  retries.add(timer);
  timer.unref?.();
  return "wait";
}

/** A non-2xx answer to the start (`sent` false) or to the message itself (spec O6). */
async function refused(entry: Row, response: Response, sent: boolean): Promise<Outcome> {
  const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; hostOffline?: unknown; delivery?: unknown };
  const current = row(entry.id);
  if (!current || current.state === "delivered" || current.state === "failed") return "next";
  const error = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  // Nothing reached omp: the session's entries wait for the host's next hello.
  if (body.hostOffline === true && (!sent || body.delivery === "refused")) return "offline";
  if (body.code === "session_busy" || body.code === "session_restarting"
    || (!sent && (body.code === "host_timeout" || body.code === "host_sessions_unavailable"))) return retry(entry);
  if (!sent && response.status === 404 && (await isArchived(entry.session_id))) {
    // An archived session keeps its entries held until it is restored (spec O6).
    if (!setState(entry.id, "held")) return "next";
    publish(entry.session_id);
    return "wait";
  }
  // A lost reply (delivery unknown), a server error or an unresponsive child after the message went: omp may have it.
  return fail(entry, error, sent && (response.status >= 500 || body.code === "session_unresponsive"));
}

async function isArchived(sessionId: string): Promise<boolean> {
  return (await listArchivedSessions()).some((archive) => archive.id === sessionId);
}
