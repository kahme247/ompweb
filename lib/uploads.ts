// Composer uploads on the main server (docs/specs/2026-11-02-file-uploads-design.md, U3 to U5): an in-memory registry
// of the uploads browsers send through it, relaying their bytes to the target host's daemon and the host's acks back,
// and attaching finished ones to a prompt. The server keeps no upload bytes on its own disk.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { RequestBodyTooLargeError } from "./bounded-form-data";
import { dropUploadFrames, getHost, hostUploadOp, onHostHello, onUploadEvent, sendUploadFrame, type UploadAck } from "./hosts/hub";
import { HostOpError, LINK_LIMITS } from "./hosts/link-protocol";
import { isRecord } from "./type-guards";
import { formatUploadSize, MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_MESSAGE, UPLOAD_ID_RE, UPLOAD_WINDOW_BYTES } from "./upload-limits";
import type { UploadConflictStrategy } from "./file-upload";
import type { WorkspaceUploadResult } from "./workspace-types";
import { completedUpload, forgetCompletedUpload, outboxScope, outboxUsesUpload, saveCompletedUpload } from "./message-outbox";

/** Unfinished uploads one owner may have registered: each may hold a window of bytes in its host link's queue. */
const MAX_OPEN_UPLOADS_PER_OWNER = 32;
/** An unfinished upload nothing touched this long (no start, chunk or ack) gives its place up: an up_start re-registers
 * it and resumes from the host's offset. */
const UPLOAD_IDLE_MS = 10 * 60_000;
/** Aborts kept per host while it cannot take them; past this the oldest go (the daemon's sweep deletes those files). */
const MAX_PENDING_ABORTS_PER_HOST = 1000;

/** Who hears back about one upload: a browser link, or an HTTP request waiting for its chunk's ack. */
export interface UploadSink {
  ack(received: number, done: boolean, proof?: string): void;
  error(status: number, code: string, message: string): void;
}

export interface UploadStartRequest { id: string; hostId: string; owner: string; name: string; size: number; type: string; sink: UploadSink; onRegistered?(): void }

/** A failed upload step; `received`: the host's offset, on a 409 upload_offset. A HostOpError, so the agent command
 * routes answer it like a failed host op (`{error, code}` with its status, `hostOffline` on a 503 host_offline). */
export class UploadError extends HostOpError {
  constructor(status: number, code: string, message: string, readonly received?: number) {
    super(status, code, message);
  }
}

/** An upload route's failure as JSON: `{error, code}` with its status, plus the host's offset on a 409 upload_offset. */
export function uploadErrorResponse(error: unknown): Response {
  if (error instanceof HostOpError) {
    const received = error instanceof UploadError && error.received !== undefined ? { received: error.received } : {};
    return Response.json({ error: error.message, code: error.code, ...received }, { status: error.status });
  }
  if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "The request is too large", code: "request_too_large" }, { status: 413 });
  if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  return Response.json({ error: error instanceof Error ? error.message : String(error), code: "upload_failed" }, { status: 500 });
}

/** `sent`: bytes forwarded to the host since the last uploadStart (≥ `received`); `live`: frames are forwarded (false
 * from a start until its answer, and after the host's socket ended); `attached`: where an attach put it, kept until
 * the prompt is sent so a retried send attaches it once; `attempt`: the latest uploadStart's UUID (only its answer and
 * acks set the offset); `touched`: the last start, chunk or ack. */
interface Upload {
  hostId: string;
  owner: string;
  name: string;
  size: number;
  type: string;
  received: number;
  sent: number;
  done: boolean;
  live: boolean;
  sink: UploadSink | null;
  attached: { sessionFile: string; path: string; url: string } | null;
  completionKey?: string;
  /** The attach in flight, shared by overlapping attaches of this upload to this session file. */
  attaching?: { sessionFile: string; completionKey?: string; result: Promise<{ sessionFile: string; path: string; url: string }> } | null;
  attempt: string;
  touched: number;
  workspace?: { directory: string; name: string; conflict: UploadConflictStrategy; pending?: Promise<WorkspaceUploadResult>; result?: WorkspaceUploadResult; timer?: NodeJS.Timeout };
}

/** Private receipt saved with a server-held outbox entry: no bytes or browser sink, only the finished staging
 * registration needed to call uploadAttach after a web restart. Never accepted from a browser command. */
export interface OutboxUploadReceipt {
  id: string;
  hostId: string;
  name: string;
  size: number;
  type: string;
  attached: Upload["attached"];
  /** Private accepted authority; optional only for entries written before upload continuity. */
  owner?: string;
  completedAt?: number;
  /** Nonsecret completion identity: an accepted receipt cannot authorize a replacement file with the same UUID. */
  completionKey?: string;
}

function completionIdentity(proof: string): string {
  return createHash("sha256").update(proof).digest("hex");
}

/** Snapshot authoritative completed metadata and its original owner, never caller-supplied receipts or owner strings. */
export function snapshotOutboxUploads(ids: string[], owner: string, proofs?: unknown): OutboxUploadReceipt[] {
  if (proofs !== undefined && (!isRecord(proofs) || Object.keys(proofs).length > MAX_UPLOADS_PER_MESSAGE
    || Object.entries(proofs).some(([id, proof]) => !ids.includes(id) || typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)))) {
    throw new UploadError(400, "invalid_uploads", "uploadProofs must map attached upload ids to completion proofs");
  }
  return ids.map((id) => {
    const upload = uploads().get(id);
    const stored = completedUpload(id);
    const actualOwner = stored?.owner ?? upload?.owner;
    if (!actualOwner) throw missing();
    const claim = isRecord(proofs) && Object.hasOwn(proofs, id) ? proofs[id] as string : undefined;
    if (claim !== undefined || actualOwner !== owner) {
      if (!claim || !stored?.proof || stored.scope !== outboxScope()
        || !timingSafeEqual(Buffer.from(claim), Buffer.from(stored.proof))) throw missing();
    }
    const receipt = stored?.receipt ?? (upload && { id, hostId: upload.hostId, name: upload.name, size: upload.size, type: upload.type, attached: upload.attached });
    if (!receipt) throw missing();
    if (!stored && upload && !upload.done) throw new UploadError(409, "upload_incomplete", "The upload has not finished");
    // Bind original-owner legacy preparation before an await can promote its canonical receipt.
    const proof = stored?.proof ?? (stored && actualOwner === owner ? saveCompletedUpload(owner, stored.receipt) : undefined);
    const completionKey = proof ? completionIdentity(proof) : upload?.completionKey;
    return { ...receipt, owner: actualOwner, ...(stored ? { completedAt: stored.at } : {}), ...(completionKey ? { completionKey } : {}) };
  });
}

function sameMetadata(upload: Pick<Upload, "hostId" | "name" | "size" | "type">, receipt: OutboxUploadReceipt): boolean {
  return upload.hostId === receipt.hostId && upload.name === receipt.name && upload.size === receipt.size && upload.type === receipt.type;
}

function sameUpload(upload: Upload, receipt: OutboxUploadReceipt, owner: string): boolean {
  if (upload.owner !== owner || !sameMetadata(upload, receipt) || upload.completionKey !== receipt.completionKey) return false;
  const current = completedUpload(receipt.id);
  // Consumed rows may be absent, but a later completion never inherits an earlier operation's authority.
  return !current || (current.owner === owner && sameMetadata(current.receipt, receipt)
    && (current.proof ? completionIdentity(current.proof) : undefined) === receipt.completionKey);
}

/** Restore private accepted receipts, refreshing stale caches only from the canonical completion generation. */
export function restoreOutboxUploads(receipts: OutboxUploadReceipt[], owner: string): void {
  const registry = uploads();
  for (const receipt of receipts) {
    const { id, hostId, name, size, type, attached, completionKey } = receipt;
    const originalOwner = receipt.owner ?? owner;
    const current = completedUpload(id);
    if (current && (current.owner !== originalOwner || !sameMetadata(current.receipt, receipt)
      || (current.proof ? completionIdentity(current.proof) : undefined) !== completionKey)) continue;
    const cached = registry.get(id);
    if (cached && (sameUpload(cached, receipt, originalOwner) || !current)) continue;
    registry.set(id, {
      hostId, owner: originalOwner, name, size, type, attached, completionKey,
      received: size, sent: size, done: true, live: false, sink: null, attempt: "", touched: Date.now(),
    });
  }
}

function persistCompletedUpload(id: string, upload: Upload): string {
  const { hostId, name, size, type, attached, owner } = upload;
  const proof = saveCompletedUpload(owner, { id, hostId, name, size, type, attached });
  if (!proof) throw missing();
  upload.completionKey = completionIdentity(proof);
  return proof;
}

declare global {
  var __ompUploads: Map<string, Upload> | undefined;
  var __ompPendingAborts: Map<string, Set<string>> | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function uploads(): Map<string, Upload> {
  if (!globalThis.__ompUploads) {
    globalThis.__ompUploads = new Map();
    onUploadEvent(onHostEvent);
    onHostHello((hostId) => {
      const ids = pendingAborts().get(hostId);
      if (!ids) return;
      pendingAborts().delete(hostId);
      for (const id of ids) deliverAbort(hostId, id);
    });
  }
  return globalThis.__ompUploads;
}

/** Aborts a host could not take (offline, timed out): sent again on its next hello. In memory only. */
function pendingAborts(): Map<string, Set<string>> {
  return (globalThis.__ompPendingAborts ??= new Map());
}

function deliverAbort(hostId: string, id: string): Promise<void> {
  return hostUploadOp(hostId, "uploadAbort", { id }).then(() => {}, (error: unknown) => {
    if (!(error instanceof HostOpError) || (error.code !== "host_offline" && error.code !== "host_timeout")) return;
    // A start of the same id since (a Retry) registered it again: replayed later, this abort would delete that upload.
    // The host runs an id's ops in arrival order, so if this abort does land late, the Retry's start comes after it.
    if (uploads().has(id)) return;
    const ids = pendingAborts().get(hostId) ?? new Set<string>();
    ids.add(id);
    if (ids.size > MAX_PENDING_ABORTS_PER_HOST) ids.delete(ids.values().next().value as string);
    pendingAborts().set(hostId, ids);
  });
}

function onHostEvent(hostId: string, ack: UploadAck | null): void {
  const map = uploads();
  if (!ack) {
    // Bytes in flight to this host are lost: each of its uploads resumes from the host's offset (a new start).
    for (const upload of map.values()) {
      if (upload.hostId !== hostId || !upload.live) continue;
      upload.live = false;
      upload.sink?.error(503, "host_offline", "The host link dropped; start the upload again to resume it");
    }
    return;
  }
  const upload = map.get(ack.id);
  if (!upload || upload.hostId !== hostId || upload.attempt !== ack.attempt) return;
  if (ack.error) {
    map.delete(ack.id);
    const stored = completedUpload(ack.id);
    if (stored && sameUpload(upload, { ...stored.receipt, completionKey: stored.proof ? completionIdentity(stored.proof) : undefined }, stored.owner)) {
      forgetCompletedUpload(ack.id, stored);
    }
    dropUploadFrames(hostId, ack.id);
    // A daemon's status is untrusted: Response.json throws on one outside 200-599.
    const status = ack.error.status >= 400 && ack.error.status <= 599 ? ack.error.status : 502;
    upload.sink?.error(status, ack.error.code, ack.error.message);
    return;
  }
  upload.received = Math.min(upload.size, Math.max(upload.received, ack.received));
  upload.done = ack.done && upload.received === upload.size;
  upload.touched = Date.now();
  let proof: string | undefined;
  if (upload.done) {
    try {
      // Before its done ACK: an outbox_add may never reach main until after a restart.
      proof = persistCompletedUpload(ack.id, upload);
    } catch (error) {
      upload.done = upload.live = false;
      if (error instanceof UploadError) upload.sink?.error(error.status, error.code, error.message);
      else upload.sink?.error(500, "upload_receipt_failed", "Could not save the completed upload; retry the upload");
      return;
    }
  }
  if (upload.live) upload.sink?.ack(upload.received, upload.done, proof);
}

const missing = () => new UploadError(404, "upload_missing", "The upload is gone: attach the file again");

/** Room for one more unfinished upload of `owner`: its idle ones give their place up (an up_start re-registers them). */
function makeRoom(map: Map<string, Upload>, owner: string): void {
  const now = Date.now();
  let open = 0;
  for (const [id, upload] of map) {
    if (upload.owner !== owner || upload.done) continue;
    if (now - upload.touched < UPLOAD_IDLE_MS) open += 1;
    else {
      map.delete(id);
      dropUploadFrames(upload.hostId, id);
    }
  }
  if (open >= MAX_OPEN_UPLOADS_PER_OWNER) {
    throw new UploadError(429, "too_many_uploads", `At most ${MAX_OPEN_UPLOADS_PER_OWNER} uploads may be in progress at once`);
  }
}

/** Register (or re-register, to resume) an upload and open it on its host; resolves the host's offset. Of starts that
 * overlap, the latest one's answer sets where the bytes go on from. `onRegistered` transfers sink ownership
 * synchronously after preflight accepts this start, before asking the host. Throws HostOpError. */
export async function startUpload(req: UploadStartRequest): Promise<{ received: number; proof?: string }> {
  const { id, hostId, owner, name, size, type, sink } = req;
  if (
    typeof id !== "string" || !UPLOAD_ID_RE.test(id) || typeof hostId !== "string" || !hostId
    || typeof name !== "string" || !name.trim() || name.length > 4096 || typeof type !== "string" || type.length > 255
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0
  ) {
    throw new UploadError(400, "invalid_request", "Invalid upload");
  }
  if (size > MAX_UPLOAD_BYTES) throw new UploadError(413, "upload_too_large", "The file is larger than 2 GiB");
  if (!getHost(hostId)) throw new UploadError(404, "host_not_found", "Unknown host");
  const map = uploads();
  const stored = completedUpload(id);
  if (stored) {
    if (stored.owner !== owner) throw new UploadError(409, "upload_id_conflict", "Another upload has this id");
    restoreOutboxUploads([{ ...stored.receipt, owner: stored.owner, completionKey: stored.proof ? completionIdentity(stored.proof) : undefined }], owner);
  }
  if (!stored && outboxUsesUpload(id)) throw new UploadError(409, "upload_id_conflict", "Another upload has this id");
  let upload = map.get(id);
  const known = upload !== undefined;
  if (upload && (upload.owner !== owner || upload.hostId !== hostId || upload.name !== name || upload.type !== type || upload.size !== size)) {
    throw new UploadError(409, "upload_id_conflict", "Another upload has this id");
  }
  const attempt = randomUUID();
  if (upload) {
    // Bytes still queued would land after the offset this start reports: they go again from that offset instead.
    upload.live = false;
    dropUploadFrames(hostId, id);
    upload.sink = sink;
    upload.attempt = attempt;
  } else {
    makeRoom(map, owner);
    upload = { hostId, owner, name, size, type, received: 0, sent: 0, done: false, live: false, sink, attached: null, attempt, touched: 0 };
    map.set(id, upload);
  }
  upload.touched = Date.now();
  // A Retry reuses the id of an upload whose failure parked an abort for its host: replayed on the next hello, that abort
  // would delete the upload this start is resuming.
  pendingAborts().get(hostId)?.delete(id);
  req.onRegistered?.();
  let result: unknown;
  try {
    result = await hostUploadOp(hostId, "uploadStart", { id, name, size, type, attempt });
  } catch (error) {
    if (!known && upload.attempt === attempt && map.get(id) === upload) map.delete(id);
    throw error;
  }
  if (map.get(id) !== upload) {
    // Aborted while the host opened it (its ops run concurrently): what this start staged goes too.
    if (!map.has(id)) hostUploadOp(hostId, "uploadAbort", { id }).catch(() => {});
    throw missing();
  }
  if (!isRecord(result) || typeof result.received !== "number" || !Number.isSafeInteger(result.received) || result.received < 0 || result.received > size || typeof result.done !== "boolean") {
    throw new UploadError(502, "host_bad_result", "The host sent an invalid uploadStart result");
  }
  let proof: string | undefined;
  if (upload.attempt === attempt) {
    if (stored && (!result.done || result.received !== size)) {
      forgetCompletedUpload(id, stored);
      map.delete(id);
      throw missing();
    }
    upload.received = upload.sent = result.received;
    upload.done = result.done && result.received === size;
    upload.live = !upload.done;
    if (upload.done) {
      try { proof = persistCompletedUpload(id, upload); }
      catch (error) { upload.done = upload.live = false; throw error; }
    }
  }
  else if (stored && result.done && result.received === size) {
    const current = completedUpload(id);
    if (current?.proof && current.proof === stored.proof && current.scope === outboxScope()) proof = current.proof;
  }
  return { received: result.received, ...(proof ? { proof } : {}) };
}

/** Delete an upload here and on its host, telling its sink why. */
function failUpload(id: string, upload: Upload, status: number, code: string, message: string): void {
  uploads().delete(id);
  dropUploadFrames(upload.hostId, id);
  upload.sink?.error(status, code, message);
  void deliverAbort(upload.hostId, id);
}

function forward(id: string, upload: Upload, bytes: Uint8Array): void {
  // Not live: the next start reports the host's offset, so dropping these leaves no gap.
  if (!upload.live) return;
  if (upload.sent + bytes.byteLength > upload.size) return failUpload(id, upload, 413, "upload_too_large", "The upload is larger than announced");
  // Past the window (a piece of slack) the sender is not waiting for acks: these bytes would only pile up in the host
  // link's queue. It stops here, and a new start resumes it from the host's offset.
  if (upload.sent + bytes.byteLength - upload.received > UPLOAD_WINDOW_BYTES + LINK_LIMITS.pieceBytes) {
    upload.live = false;
    upload.sink?.error(429, "upload_window_exceeded", "The upload ran past its window; start it again to resume it");
    return;
  }
  if (!sendUploadFrame(upload.hostId, id, bytes)) {
    upload.live = false;
    upload.sink?.error(503, "host_offline", "The host is offline");
    return;
  }
  upload.sent += bytes.byteLength;
  upload.touched = Date.now();
}

/** Forward one chunk (a binary frame's payload) to its upload's host. False when `id` is not an upload of `owner`,
 * `sink` is not its current sender (a WS link superseded by an HTTP resume or a newer start: its late frames would land
 * after the offset that start reported), or the chunk is over pieceBytes. */
export function forwardUploadFrame(owner: string, id: string, bytes: Uint8Array, sink: UploadSink): boolean {
  const upload = uploads().get(id);
  if (!upload || upload.owner !== owner || upload.sink !== sink || bytes.byteLength > LINK_LIMITS.pieceBytes) return false;
  forward(id, upload, bytes);
  return true;
}

/** HTTP form of the window (PUT /api/uploads/<id>?offset=N): `body` at the host's offset, cut into pieces, answered
 * once the host has acked through its end. */
export function putUploadChunk(id: string, owner: string, offset: number, body: Uint8Array): Promise<{ received: number; done: boolean; proof?: string }> {
  const upload = uploads().get(id);
  if (!upload || upload.owner !== owner) return Promise.reject(missing());
  if (offset !== upload.received || upload.sent !== upload.received || (!upload.live && !upload.done)) {
    return Promise.reject(new UploadError(409, "upload_offset", "The upload is at another offset", upload.received));
  }
  if (body.byteLength === 0) {
    const proof = upload.done ? persistCompletedUpload(id, upload) : undefined;
    return Promise.resolve({ received: upload.received, done: upload.done, ...(proof ? { proof } : {}) });
  }
  const target = offset + body.byteLength;
  const { promise, resolve, reject } = Promise.withResolvers<{ received: number; done: boolean; proof?: string }>();
  const previous = upload.sink;
  const finish = (error: UploadError | null, received = 0, done = false, proof?: string) => {
    clearTimeout(timer);
    if (upload.sink === sink) upload.sink = previous;
    if (error) reject(error);
    else resolve({ received, done, ...(proof ? { proof } : {}) });
  };
  const sink: UploadSink = {
    ack(received, done, proof) {
      // The last byte resolves on `done` only: the host's final fsync may outlast its ack coalescing, and a send needs the file finished.
      if ((received >= target && target < upload.size) || done) finish(null, received, done, proof);
      else timer.refresh();
    },
    error(status, code, message) {
      finish(new UploadError(status, code, message));
    },
  };
  // A deadline for silence: each ack restarts it.
  const timer = setTimeout(() => finish(new UploadError(504, "host_timeout", "The host did not acknowledge the upload in time")), LINK_LIMITS.opTimeoutMs);
  timer.unref?.();
  upload.sink = sink;
  for (let at = 0; at < body.byteLength && upload.sink === sink; at += LINK_LIMITS.pieceBytes) {
    forward(id, upload, body.subarray(at, at + LINK_LIMITS.pieceBytes));
  }
  return promise;
}

/** Cancel an upload of `owner` and delete its staged file, now or on its host's next hello. One this server does not
 * register (it restarted, or forgot an idle or failed one) goes to `hostId`, the host its browser names: upload ids are
 * random UUIDs only their owner's browser holds. */
export async function abortUpload(id: string, owner: string, hostId?: string): Promise<void> {
  const map = uploads();
  const stored = completedUpload(id);
  if (stored) {
    if (stored.owner !== owner) return;
    restoreOutboxUploads([{ ...stored.receipt, owner: stored.owner, completionKey: stored.proof ? completionIdentity(stored.proof) : undefined }], owner);
  }
  const upload = map.get(id);
  if (upload) {
    if (upload.owner !== owner) return;
    map.delete(id);
    forgetCompletedUpload(id);
    dropUploadFrames(upload.hostId, id);
    return deliverAbort(upload.hostId, id);
  }
  if (hostId && UPLOAD_ID_RE.test(id) && getHost(hostId)) return deliverAbort(hostId, id);
}

/** Detach a sink (its browser link is gone) without aborting the upload; a later startUpload resumes it. */
export function releaseUploadSink(id: string, sink: UploadSink): void {
  const upload = uploads().get(id);
  if (upload?.sink === sink) upload.sink = null;
}

const PROMPT_TYPES: Record<string, true> = { prompt: true, steer: true, follow_up: true };

/** Remove browser-only fields before native dispatch. Trusted receipts are supplied ONLY by the server dispatcher. */
export function takeUploads(command: Record<string, unknown>, owner: string, trusted?: OutboxUploadReceipt[]): { ids: string[]; receipts: OutboxUploadReceipt[] } | null {
  const proofs = command.uploadProofs;
  delete command.uploadProofs;
  if (!Object.hasOwn(command, "uploads")) {
    if (proofs !== undefined) snapshotOutboxUploads([], owner, proofs);
    return null;
  }
  const ids = command.uploads;
  delete command.uploads;
  if (
    !Array.isArray(ids) || ids.length > MAX_UPLOADS_PER_MESSAGE || new Set(ids).size !== ids.length
    || !ids.every((id) => typeof id === "string" && UPLOAD_ID_RE.test(id))
  ) {
    throw new UploadError(400, "invalid_uploads", `uploads must be at most ${MAX_UPLOADS_PER_MESSAGE} distinct upload ids`);
  }
  if (ids.length && (typeof command.type !== "string" || !Object.hasOwn(PROMPT_TYPES, command.type))) {
    throw new UploadError(400, "invalid_uploads", "Only a prompt, steer or follow_up attaches files");
  }
  const receipts = trusted ?? snapshotOutboxUploads(ids as string[], owner, proofs);
  if (receipts.length !== ids.length || !ids.every((id) => receipts.some((receipt) => receipt.id === id))) throw missing();
  if (!ids.length) return null;
  restoreOutboxUploads(receipts, owner);
  for (const receipt of receipts) {
    const upload = uploads().get(receipt.id);
    if (!upload || !sameUpload(upload, receipt, receipt.owner ?? owner)) throw missing();
    if (!upload.done) throw new UploadError(409, "upload_incomplete", "The upload has not finished");
    if (upload.workspace) throw new UploadError(409, "upload_destination_conflict", "The upload belongs to a workspace");
  }
  return { ids: ids as string[], receipts };
}

/** Link (or copy) each upload into the session's `local://uploads/` on its host and append the block naming them to the
 * command's `message` (spec U1). The uploads stay registered until forgetUploads, so a retried send reuses an attach. */
export async function attachUploads(
  ids: string[],
  owner: string,
  session: { readonly host: { readonly id: string }; readonly sessionFile: string; readonly sessionId: string },
  command: Record<string, unknown>,
  receipts?: OutboxUploadReceipt[],
): Promise<void> {
  const { sessionFile, sessionId } = session;
  if (!sessionFile) throw new UploadError(409, "session_file_unknown", "The session has no file yet to attach files to");
  const lines: string[] = [];
  for (const id of ids) {
    const upload = uploads().get(id);
    const receipt = receipts?.find((receipt) => receipt.id === id);
    if (!upload || (receipt ? !sameUpload(upload, receipt, receipt.owner ?? owner) : upload.owner !== owner)) throw missing();
    if (!upload.done) throw new UploadError(409, "upload_incomplete", "The upload has not finished");
    if (upload.hostId !== session.host.id) throw new UploadError(409, "upload_wrong_host", "The file was uploaded to another host than the session's");
    if (upload.workspace) throw new UploadError(409, "upload_destination_conflict", "The upload belongs to a workspace");
    // The daemon owns receipt/file validation, including replays after an earlier successful attach.
    if (upload.attaching?.sessionFile !== sessionFile || upload.attaching.completionKey !== upload.completionKey) {
      const completionKey = upload.completionKey;
      const result = hostUploadOp(upload.hostId, "uploadAttach", { id, sessionFile, sessionId }).then((answer) => {
        if (!isRecord(answer) || typeof answer.path !== "string" || typeof answer.url !== "string") {
          throw new UploadError(502, "host_bad_result", "The host sent an invalid uploadAttach result");
        }
        return { sessionFile, path: answer.path, url: answer.url };
      });
      upload.attaching = { sessionFile, completionKey, result };
      const settled = () => { if (upload.attaching?.result === result) upload.attaching = null; };
      result.then(settled, settled);
    }
    const attached = await upload.attaching!.result;
    if (uploads().get(id) !== upload || (receipt && !sameUpload(upload, receipt, receipt.owner ?? owner))) throw missing();
    upload.attached = attached;
    const { url, path } = attached;
    // The agent reads the exact path in the parentheses; the link target is percent-encoded so no name breaks it.
    const href = encodeURI(path.toWellFormed()).replace(/[()#?&]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    lines.push(`- [${markdownCode(url)}](${href}) (${path}, ${formatUploadSize(upload.size)}, ${upload.type || "application/octet-stream"})`);
  }
  const block = `Attached files (this session's local:// directory):\n${lines.join("\n")}`;
  const message = typeof command.message === "string" ? command.message : "";
  command.message = message ? `${message}\n\n${block}` : block;
}

/** A CommonMark code span holding `text` verbatim: the fence outruns any backtick run inside it. */
function markdownCode(text: string): string {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const pad = /^`|`$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The prompt carrying these uploads reached omp: their registry entries go. */
export function forgetUploads(ids: string[], owner: string, receipts?: OutboxUploadReceipt[]): void {
  for (const id of ids) {
    const upload = uploads().get(id);
    const receipt = receipts?.find((receipt) => receipt.id === id);
    const expectedOwner = receipt?.owner ?? owner;
    if (upload && (!upload.done || (receipt ? !sameUpload(upload, receipt, expectedOwner) : upload.owner !== expectedOwner))) continue;
    const stored = completedUpload(id);
    if (stored && (stored.owner !== expectedOwner || !receipt || !sameMetadata(stored.receipt, receipt)
      || (stored.proof ? completionIdentity(stored.proof) : undefined) !== receipt.completionKey)) continue;
    if (upload) uploads().delete(id);
    if (stored) forgetCompletedUpload(id, stored);
  }
}

/** Bind one completed upload to one authorized workspace destination, including lost-reply retries. */
export async function publishWorkspaceUpload(id: string, owner: string, hostId: string, directory: string, name: string, conflict: UploadConflictStrategy): Promise<WorkspaceUploadResult> {
  const upload = uploads().get(id);
  if (!upload || upload.owner !== owner) throw missing();
  if (upload.hostId !== hostId) throw new UploadError(409, "upload_wrong_host", "The file was uploaded to another host");
  if (!upload.done) throw new UploadError(409, "upload_incomplete", "The upload has not finished");
  if (upload.attached || upload.attaching || upload.name !== name) throw new UploadError(409, "upload_destination_conflict", "The upload already has another destination");
  const binding = upload.workspace ??= { directory, name, conflict };
  if (binding.directory !== directory || binding.name !== name || binding.conflict !== conflict) throw new UploadError(409, "upload_destination_conflict", "The upload already has another destination");
  clearTimeout(binding.timer);
  const expire = () => {
    binding.timer = setTimeout(() => { if (uploads().get(id) === upload && !binding.pending) uploads().delete(id); }, UPLOAD_IDLE_MS);
    binding.timer.unref?.();
  };
  if (binding.result) { expire(); return binding.result; }
  if (binding.pending) return binding.pending;
  const host = getHost(hostId);
  if (!host) throw missing();
  const pending = host.workspaceOps.publishUpload(id, directory, name, conflict).then((result) => {
    if (!result.ok) throw new UploadError(result.status, result.code, result.error);
    binding.result = result.value;
    return result.value;
  });
  binding.pending = pending;
  try { return await pending; }
  finally { binding.pending = undefined; expire(); }
}
