// Composer file uploads, the daemon's side (docs/specs/2026-11-02-file-uploads-design.md, U3 and U5): an upload is
// staged as `<agent dir>/omp-web/uploads/<id>.part` plus `<id>.json`, written in order at the part's length, and on
// attach hard-linked (or copied) into the session's `local://uploads/`.
// Loaded by the daemon through jiti: no `@/` imports and no Bun APIs.
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { appendFile, copyFile, link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getAgentDir } from "../omp/paths";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import { MAX_UPLOAD_BYTES, UPLOAD_ID_RE } from "../upload-limits";
import { HostOpError, LINK_LIMITS } from "./link-protocol";

/** Uploads land in this subdirectory of the session's `local://` root. */
export const UPLOADS_LOCAL_DIR = "uploads";
// Leaves room for ` (n)` under the usual 255-byte file name limit.
const MAX_NAME_BYTES = 200;
const MAX_EXT_BYTES = 20;
// omp's own rule (internal-urls/local-protocol.ts): long artifact paths move to the temp dir on Windows.
const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;
/** Staged files untouched this long, and open uploads idle this long, are deleted (at start, on every uploadStart and
 * every UPLOAD_SWEEP_INTERVAL_MS). */
export const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** The longest prefix of `text` within `bytes` UTF-8 bytes, cut between code points. */
function clipUtf8(text: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > bytes) break;
    out += char;
  }
  return out;
}

/** A file name safe to create in one directory on any OS: no separators, control or bidi characters, Windows device
 * names or trailing dots and spaces, at most MAX_NAME_BYTES; never empty. */
export function sanitizeUploadName(name: string): string {
  let clean = basename(name.replace(/\\/g, "/"))
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9]) *(\.|$)/i.test(clean)) clean = `_${clean}`;
  if (Buffer.byteLength(clean) > MAX_NAME_BYTES) {
    const ext = extname(clean);
    const keptExt = clipUtf8(ext, MAX_EXT_BYTES);
    clean = (clipUtf8(clean.slice(0, clean.length - ext.length), MAX_NAME_BYTES - Buffer.byteLength(keptExt)) + keptExt).replace(/[. ]+$/, "");
  }
  return clean || "file";
}

/** omp's `local://` root for a session (`resolveLocalRoot` in omp's local-protocol.ts). */
export function sessionLocalRoot(sessionFile: string, sessionId: string, platform: NodeJS.Platform = process.platform): string {
  const candidate = resolve(dirname(sessionFile), basename(sessionFile, ".jsonl"), "local");
  if (platform === "win32" && candidate.length >= WINDOWS_LOCAL_ROOT_MAX_CHARS) {
    return join(tmpdir(), "omp-local", sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  }
  return candidate;
}

/** What the daemon sends up as `upload_ack`. */
export type UploadAck = { id: string; attempt: string; received: number; done: boolean; error?: { status: number; code: string; message: string } };

type Receipt = { sessionFile: string; path: string; url: string };
/** `attached`: the receipt of a finished attach, kept (the `.part` is gone) so an attach retried after a lost reply is answered again. */
type Meta = { name: string; size: number; type: string; created: number; attached?: Receipt };
type OpenUpload = { name: string; type: string; size: number; attempt: string; received: number; chain: Promise<void>; timer: NodeJS.Timeout | undefined; active: number };

const errno = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const isUploadId = (id: unknown): id is string => typeof id === "string" && UPLOAD_ID_RE.test(id);

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

async function requireReceiptTarget(receipt: Receipt): Promise<void> {
  try {
    if ((await stat(receipt.path)).isFile()) return;
  } catch (error) {
    if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR") throw error;
  }
  throw new HostOpError(404, "upload_missing", "The upload is gone: attach the file again");
}

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** This daemon's staged uploads. Frames for one upload are written in arrival order; `send` gets each `upload_ack`. */
export class StagedUploads {
  private readonly open = new Map<string, OpenUpload>();
  /** Start, attach and abort for one id run in arrival order; other ids remain independent. */
  private readonly controls = new Map<string, Promise<void>>();

  constructor(
    private readonly send: (ack: UploadAck) => void,
    readonly dir: string = join(getAgentDir(), "omp-web", "uploads"),
  ) {}

  private path(id: string, kind: "part" | "json"): string {
    return join(this.dir, `${id}.${kind}`);
  }

  private async control<T>(id: string, action: () => Promise<T>): Promise<T> {
    const run = (this.controls.get(id) ?? Promise.resolve()).then(action);
    const tail = run.then(() => {}, () => {});
    this.controls.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.controls.get(id) === tail) this.controls.delete(id);
    }
  }

  private async meta(id: string): Promise<Meta | null> {
    try {
      const meta: unknown = JSON.parse(await readFile(this.path(id, "json"), "utf8"));
      if (!isRecord(meta) || typeof meta.name !== "string" || !Number.isSafeInteger(meta.size) || typeof meta.type !== "string") return null;
      const { attached } = meta;
      if (attached !== undefined && !(isRecord(attached) && typeof attached.sessionFile === "string" && typeof attached.path === "string" && typeof attached.url === "string")) return null;
      return meta as Meta;
    } catch {
      return null;
    }
  }

  private async remove(id: string): Promise<void> {
    await rm(this.path(id, "part"), { force: true });
    await rm(this.path(id, "json"), { force: true });
  }

  /** Abort open uploads idle (no start, no write) longer than STAGED_MAX_AGE_MS, then delete staged files older than
   * that which no write is going to. Never rejects: it runs from a timer, and before every uploadStart. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, upload] of this.open) {
      if (this.controls.has(id) || now - upload.active <= STAGED_MAX_AGE_MS) continue;
      try {
        await this.abort(id);
      } catch (error) {
        // Its files could not be removed (a .part replaced by a directory, EPERM): the upload is closed already, and
        // the file scan below tries them again on every sweep.
        console.error(`[ompweb host] could not delete staged upload ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.split(".")[0];
      if (this.open.has(id) || this.controls.has(id)) continue;
      const file = join(this.dir, name);
      try {
        const modified = (await stat(file)).mtimeMs;
        if (!this.open.has(id) && !this.controls.has(id) && now - modified > STAGED_MAX_AGE_MS) await rm(file, { force: true });
      } catch {
        // Gone already, or unreadable: the next sweep tries again.
      }
    }
  }

  /** Op uploadStart: create the staged upload, or open it again, and report how much of it is written. */
  async start(args: Record<string, unknown>): Promise<{ received: number; done: boolean }> {
    const { id, name, size, type, attempt } = args;
    if (!isUploadId(id) || !isUploadId(attempt) || typeof name !== "string" || !name || name.length > 4096 || typeof type !== "string" || type.length > 255 || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new HostOpError(400, "invalid_request", "Invalid upload");
    }
    if (size > MAX_UPLOAD_BYTES) throw new HostOpError(413, "upload_too_large", "The file is larger than 2 GiB");
    return this.control(id, () => this.begin(id, name, size, type, attempt));
  }

  private async begin(id: string, name: string, size: number, type: string, attempt: string): Promise<{ received: number; done: boolean }> {
    await this.sweep();
    const known = this.open.get(id);
    if (known) {
      // An id names one file: the same id with another name, type or size is a different upload.
      if (known.name !== name || known.type !== type || known.size !== size) throw new HostOpError(409, "upload_id_conflict", "The upload id is in use for another file");
      // Frames that came before this start are written first: they are part of the offset it reports.
      await known.chain;
      if (this.open.get(id) === known) {
        clearTimeout(known.timer);
        known.timer = undefined;
        known.attempt = attempt;
        known.active = Date.now();
        return { received: known.received, done: false };
      }
    }
    await mkdir(this.dir, { recursive: true });
    const part = this.path(id, "part");
    const meta = await this.meta(id);
    if (meta?.attached) {
      if (meta.name !== name || meta.type !== type || meta.size !== size) throw new HostOpError(409, "upload_id_conflict", "The upload id is in use for another file");
      await requireReceiptTarget(meta.attached);
      return { received: size, done: true };
    }
    let received = meta?.name === name && meta.type === type && meta.size === size ? await sizeOf(part) : null;
    if (received === null || received > size) {
      await writeFile(part, new Uint8Array(0));
      await writeFile(this.path(id, "json"), JSON.stringify({ name, size, type, created: Date.now() } satisfies Meta));
      received = 0;
    }
    if (received === size) {
      await sync(part);
      return { received, done: true };
    }
    this.open.set(id, { name, type, size, attempt, received, chain: Promise.resolve(), timer: undefined, active: Date.now() });
    return { received, done: false };
  }

  /** A binary frame's payload: appended at the staged file's length. One for an upload not open here (unknown,
   * finished, aborted) is dropped; the next uploadStart reports the real offset. */
  write(id: string, bytes: Uint8Array): void {
    const upload = this.open.get(id);
    if (!upload) return;
    const attempt = upload.attempt;
    upload.active = Date.now();
    upload.chain = upload.chain.then(async () => {
      if (this.open.get(id) !== upload) return;
      if (upload.received + bytes.byteLength > upload.size) throw new HostOpError(413, "upload_too_large", "The upload is larger than announced");
      await appendFile(this.path(id, "part"), bytes);
      upload.received += bytes.byteLength;
      if (upload.received < upload.size) return this.ackSoon(id, upload, attempt);
      await sync(this.path(id, "part"));
      this.close(id, upload);
      this.send({ id, attempt, received: upload.received, done: true });
    }).catch(async (error: unknown) => {
      if (this.open.get(id) !== upload) return;
      // A new start must still find and drain this chain until its old files are gone.
      clearTimeout(upload.timer);
      upload.timer = undefined;
      await this.remove(id).catch(() => {});
      this.close(id, upload);
      const failure = error instanceof HostOpError ? error : new HostOpError(507, "upload_write_failed", `The upload could not be written: ${error instanceof Error ? error.message : String(error)}`);
      this.send({ id, attempt, received: upload.received, done: false, error: { status: failure.status, code: failure.code, message: failure.message } });
    });
  }

  /** At most one ack per flushMs per upload, with what is written by then. */
  private ackSoon(id: string, upload: OpenUpload, attempt: string): void {
    upload.timer ??= setTimeout(() => {
      upload.timer = undefined;
      if (this.open.get(id) === upload) this.send({ id, attempt, received: upload.received, done: false });
    }, LINK_LIMITS.flushMs);
    upload.timer.unref?.();
  }

  private close(id: string, upload: OpenUpload): void {
    clearTimeout(upload.timer);
    upload.timer = undefined;
    this.open.delete(id);
  }

  /** Op uploadAbort: forget the upload and delete its staged files. */
  async abort(id: unknown): Promise<null> {
    if (!isUploadId(id)) throw new HostOpError(400, "invalid_request", "Invalid upload id");
    return this.control(id, async () => {
      const upload = this.open.get(id);
      if (upload) {
        this.close(id, upload);
        await upload.chain;
      }
      await this.remove(id);
      return null;
    });
  }

  /** Op uploadAttach: hard-link (or copy) a finished upload into the session's `local://uploads/`, never over an
   * existing file (a taken name gets ` (1)`, ` (2)`, ...). `sessionFile` is already confined to the sessions directory. */
  async attach(id: unknown, sessionFile: string, sessionId: unknown): Promise<{ path: string; url: string }> {
    if (!isUploadId(id) || typeof sessionId !== "string" || !isValidSessionId(sessionId)) throw new HostOpError(400, "invalid_request", "Invalid upload attach");
    return this.control(id, () => this.finishAttach(id, sessionFile, sessionId));
  }

  private async finishAttach(id: string, sessionFile: string, sessionId: string): Promise<{ path: string; url: string }> {
    const part = this.path(id, "part");
    const meta = await this.meta(id);
    if (meta?.attached) {
      // Attached already (the reply was lost): the same session file gets the same answer, any other one finds it gone.
      if (meta.attached.sessionFile === sessionFile) {
        await requireReceiptTarget(meta.attached);
        return { path: meta.attached.path, url: meta.attached.url };
      }
      throw new HostOpError(404, "upload_missing", "The upload is gone: attach the file again");
    }
    const size = meta ? await sizeOf(part) : null;
    if (!meta || size === null) throw new HostOpError(404, "upload_missing", "The upload is gone: attach the file again");
    if (this.open.has(id) || size !== meta.size) throw new HostOpError(409, "upload_incomplete", "The upload has not finished");
    const dir = join(sessionLocalRoot(sessionFile, sessionId), UPLOADS_LOCAL_DIR);
    await mkdir(dir, { recursive: true });
    const name = sanitizeUploadName(meta.name);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 0; ; n++) {
      const fileName = n === 0 ? name : `${stem} (${n})${ext}`;
      const target = join(dir, fileName);
      // A hard link never replaces a file; another device (or a file system without links) gets a copy instead.
      try {
        await link(part, target);
      } catch (error) {
        if (errno(error) === "EEXIST" && n < 1000) continue;
        if (!["EXDEV", "EPERM", "ENOTSUP", "ENOSYS"].includes(errno(error) ?? "")) throw error;
        try {
          await copyFile(part, target, fsConstants.COPYFILE_EXCL);
        } catch (copyError) {
          // EEXIST: the name is someone else's file, never ours to delete.
          if (errno(copyError) === "EEXIST") {
            if (n < 1000) continue;
            throw copyError;
          }
          await rm(target, { force: true });
          throw copyError;
        }
      }
      // Publish atomically before removing the part; a failed receipt leaves the original metadata and data retryable.
      const receipt: Receipt = { sessionFile, path: target, url: `local://${UPLOADS_LOCAL_DIR}/${fileName}` };
      const temporary = `${this.path(id, "json")}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ ...meta, attached: receipt } satisfies Meta), { flag: "wx" });
        await rename(temporary, this.path(id, "json"));
      } catch (error) {
        await rm(target, { force: true }).catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await rm(part, { force: true });
      return { path: target, url: receipt.url };
    }
  }
}
