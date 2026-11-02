// Composer uploads on the main server (docs/specs/2026-11-02-file-uploads-design.md, U3 to U5): an in-memory registry
// of the uploads browsers send through it, relaying their bytes to the target host's daemon and the host's acks back,
// and attaching finished ones to a prompt. The server keeps no upload bytes on its own disk.
import { createHash } from "node:crypto";
import { RequestBodyTooLargeError } from "./bounded-form-data";
import { dropUploadFrames, getHost, hostUploadOp, onUploadEvent, sendUploadFrame, type UploadAck } from "./hosts/hub";
import { decodeBlobFrame, HostOpError, LINK_LIMITS } from "./hosts/link-protocol";
import { isRecord } from "./type-guards";
import { formatUploadSize, MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_MESSAGE, UPLOAD_ID_RE, UPLOAD_WINDOW_BYTES } from "./upload-limits";
import { isTrustedProxyRequest, OMP_WEB_SESSION_COOKIE, OMP_WEB_TRUSTED_HEADER } from "./web-auth";

export { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_MESSAGE, UPLOAD_ID_RE, UPLOAD_WINDOW_BYTES };

/** Who hears back about one upload: a browser link, or an HTTP request waiting for its chunk's ack. */
export interface UploadSink {
  ack(received: number, done: boolean): void;
  error(status: number, code: string, message: string): void;
}

export interface UploadStartRequest { id: string; hostId: string; owner: string; name: string; size: number; type: string; sink: UploadSink }

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

/** The web session a request belongs to (B5): uploads and browser-link resumes are honored only for the same one. */
export function requestOwner(request: Request): string {
  const cookie = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(OMP_WEB_SESSION_COOKIE);
  if (cookie) return `session:${createHash("sha256").update(cookie).digest("base64url")}`;
  return isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER)) ? "trusted" : "open";
}

/** `sent`: bytes forwarded to the host since the last uploadStart (≥ `received`); `live`: frames are forwarded (false
 * from a start until its answer, and after the host's socket ended); `attached`: where an attach put it, kept until
 * the prompt is sent so a retried send attaches it once. */
interface Upload {
  hostId: string;
  owner: string;
  size: number;
  type: string;
  received: number;
  sent: number;
  done: boolean;
  live: boolean;
  sink: UploadSink | null;
  attached: { sessionFile: string; path: string; url: string } | null;
}

declare global {
  var __ompUploads: Map<string, Upload> | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function uploads(): Map<string, Upload> {
  if (!globalThis.__ompUploads) {
    globalThis.__ompUploads = new Map();
    onUploadEvent(onHostEvent);
  }
  return globalThis.__ompUploads;
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
  if (!upload || upload.hostId !== hostId) return;
  if (ack.error) {
    map.delete(ack.id);
    dropUploadFrames(hostId, ack.id);
    upload.sink?.error(ack.error.status, ack.error.code, ack.error.message);
    return;
  }
  upload.received = Math.min(upload.size, Math.max(upload.received, ack.received));
  upload.done = ack.done && upload.received === upload.size;
  if (upload.live) upload.sink?.ack(upload.received, upload.done);
}

function uploadError(error: unknown): unknown {
  return error instanceof HostOpError ? new UploadError(error.status, error.code, error.message) : error;
}

const missing = () => new UploadError(404, "upload_missing", "The upload is gone: attach the file again");

/** Register (or re-register, to resume) an upload and open it on its host; resolves the host's offset. */
export async function startUpload(req: UploadStartRequest): Promise<{ received: number }> {
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
  let upload = map.get(id);
  const known = upload !== undefined;
  if (upload && (upload.owner !== owner || upload.hostId !== hostId || upload.size !== size)) {
    throw new UploadError(409, "upload_conflict", "Another upload has this id");
  }
  if (upload) {
    // Bytes still queued would land after the offset this start reports: they go again from that offset instead.
    upload.live = false;
    dropUploadFrames(hostId, id);
    upload.sink = sink;
  } else {
    upload = { hostId, owner, size, type, received: 0, sent: 0, done: false, live: false, sink, attached: null };
    map.set(id, upload);
  }
  let result: unknown;
  try {
    result = await hostUploadOp(hostId, "uploadStart", { id, name, size, type });
  } catch (error) {
    if (!known && map.get(id) === upload) map.delete(id);
    throw uploadError(error);
  }
  if (map.get(id) !== upload) throw missing();
  if (!isRecord(result) || typeof result.received !== "number" || !Number.isSafeInteger(result.received) || result.received < 0 || result.received > size || typeof result.done !== "boolean") {
    throw new UploadError(502, "host_bad_result", "The host sent an invalid uploadStart result");
  }
  upload.received = upload.sent = result.received;
  upload.done = result.done && result.received === size;
  upload.live = !upload.done;
  return { received: result.received };
}

/** Delete an upload here and on its host, telling its sink why. */
function failUpload(id: string, upload: Upload, status: number, code: string, message: string): void {
  uploads().delete(id);
  dropUploadFrames(upload.hostId, id);
  upload.sink?.error(status, code, message);
  hostUploadOp(upload.hostId, "uploadAbort", { id }).catch(() => {});
}

function forward(id: string, upload: Upload, bytes: Uint8Array): void {
  // Not live: the next start reports the host's offset, so dropping these leaves no gap.
  if (!upload.live) return;
  if (upload.sent + bytes.byteLength > upload.size) return failUpload(id, upload, 413, "upload_too_large", "The upload is larger than announced");
  if (!sendUploadFrame(upload.hostId, id, bytes)) {
    upload.live = false;
    upload.sink?.error(503, "host_offline", "The host is offline");
    return;
  }
  upload.sent += bytes.byteLength;
}

/** Forward one binary frame `[n][id][payload]` to its upload's host. False when the id is not an upload of `owner`, or
 * the payload is over pieceBytes. */
export function forwardUploadFrame(owner: string, frame: Uint8Array): boolean {
  let decoded: { id: string; bytes: Uint8Array };
  try {
    decoded = decodeBlobFrame(frame);
  } catch {
    return false;
  }
  const upload = uploads().get(decoded.id);
  if (!upload || upload.owner !== owner || decoded.bytes.byteLength > LINK_LIMITS.pieceBytes) return false;
  forward(decoded.id, upload, decoded.bytes);
  return true;
}

/** HTTP form of the window (PUT /api/uploads/<id>?offset=N): `body` at the host's offset, cut into pieces, answered
 * once the host has acked through its end. */
export function putUploadChunk(id: string, owner: string, offset: number, body: Uint8Array): Promise<{ received: number; done: boolean }> {
  const upload = uploads().get(id);
  if (!upload || upload.owner !== owner) return Promise.reject(missing());
  if (offset !== upload.received || upload.sent !== upload.received || (!upload.live && !upload.done)) {
    return Promise.reject(new UploadError(409, "upload_offset", "The upload is at another offset", upload.received));
  }
  if (body.byteLength === 0) return Promise.resolve({ received: upload.received, done: upload.done });
  const target = offset + body.byteLength;
  const { promise, resolve, reject } = Promise.withResolvers<{ received: number; done: boolean }>();
  const previous = upload.sink;
  const finish = (error: UploadError | null, received = 0, done = false) => {
    clearTimeout(timer);
    if (upload.sink === sink) upload.sink = previous;
    if (error) reject(error);
    else resolve({ received, done });
  };
  const sink: UploadSink = {
    ack(received, done) {
      if (received >= target || done) finish(null, received, done);
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

/** Cancel an upload of `owner` and delete its staged file (best effort while its host is offline). */
export async function abortUpload(id: string, owner: string): Promise<void> {
  const map = uploads();
  const upload = map.get(id);
  if (!upload || upload.owner !== owner) return;
  map.delete(id);
  dropUploadFrames(upload.hostId, id);
  await hostUploadOp(upload.hostId, "uploadAbort", { id }).catch(() => {});
}

/** Detach a sink (its browser link is gone) without aborting the upload; a later startUpload resumes it. */
export function releaseUploadSink(id: string, sink: UploadSink): void {
  const upload = uploads().get(id);
  if (upload?.sink === sink) upload.sink = null;
}

const PROMPT_TYPES: Record<string, true> = { prompt: true, steer: true, follow_up: true };

/** The `uploads` of an agent command, taken off it (omp never sees the field) and checked: ids of finished uploads of
 * `owner`, on a prompt, steer or follow_up only. Null when it names none. Throws UploadError. */
export function takeUploads(command: Record<string, unknown>, owner: string): string[] | null {
  if (!Object.hasOwn(command, "uploads")) return null;
  const ids = command.uploads;
  delete command.uploads;
  if (
    !Array.isArray(ids) || ids.length > MAX_UPLOADS_PER_MESSAGE || new Set(ids).size !== ids.length
    || !ids.every((id) => typeof id === "string" && UPLOAD_ID_RE.test(id))
  ) {
    throw new UploadError(400, "invalid_uploads", `uploads must be at most ${MAX_UPLOADS_PER_MESSAGE} distinct upload ids`);
  }
  if (ids.length === 0) return null;
  if (typeof command.type !== "string" || !Object.hasOwn(PROMPT_TYPES, command.type)) throw new UploadError(400, "invalid_uploads", "Only a prompt, steer or follow_up attaches files");
  for (const id of ids as string[]) {
    const upload = uploads().get(id);
    if (!upload || upload.owner !== owner) throw missing();
    if (!upload.done) throw new UploadError(409, "upload_incomplete", "The upload has not finished");
  }
  return ids as string[];
}

/** Move each upload into the session's `local://uploads/` on its host and append the block naming them to the
 * command's `message` (spec U1). The uploads stay registered until forgetUploads, so a retried send reuses an attach. */
export async function attachUploads(
  ids: string[],
  owner: string,
  session: { readonly host: { readonly id: string }; readonly sessionFile: string; readonly sessionId: string },
  command: Record<string, unknown>,
): Promise<void> {
  const { sessionFile, sessionId } = session;
  if (!sessionFile) throw new UploadError(409, "session_file_unknown", "The session has no file yet to attach files to");
  const lines: string[] = [];
  for (const id of ids) {
    const upload = uploads().get(id);
    if (!upload || upload.owner !== owner) throw missing();
    if (upload.hostId !== session.host.id) throw new UploadError(409, "upload_wrong_host", "The file was uploaded to another host than the session's");
    if (upload.attached?.sessionFile !== sessionFile) {
      let result: unknown;
      try {
        result = await hostUploadOp(upload.hostId, "uploadAttach", { id, sessionFile, sessionId });
      } catch (error) {
        throw uploadError(error);
      }
      if (!isRecord(result) || typeof result.path !== "string" || typeof result.url !== "string") {
        throw new UploadError(502, "host_bad_result", "The host sent an invalid uploadAttach result");
      }
      upload.attached = { sessionFile, path: result.path, url: result.url };
    }
    lines.push(`- ${upload.attached.url} (${upload.attached.path}, ${formatUploadSize(upload.size)}, ${upload.type || "application/octet-stream"})`);
  }
  const block = `Attached files (this session's local:// directory):\n${lines.join("\n")}`;
  const message = typeof command.message === "string" ? command.message : "";
  command.message = message ? `${message}\n\n${block}` : block;
}

/** The prompt carrying these uploads reached omp: their registry entries go. */
export function forgetUploads(ids: string[]): void {
  for (const id of ids) uploads().delete(id);
}
