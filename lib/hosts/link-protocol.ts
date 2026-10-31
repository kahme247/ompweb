// Wire format between the main omp-web server and the `ompweb host` daemon.
// Pure: no I/O and no Next or `@/` imports, so both sides share it.
import type { SessionOps } from "./session-ops";

/** 2: the hello moved from a GET header into a POST body (a v1 daemon gets 426). */
export const LINK_PROTOCOL_VERSION = 2;

export const LINK_LIMITS = {
  pingMs: 15_000,
  offlineMs: 30_000,
  channelBufferBytes: 8 * 1024 * 1024,
  flushMs: 16,
  flushBytes: 256 * 1024,
  uplinkBytes: 16 * 1024 * 1024,
  blobBytes: 64 * 1024 * 1024,
  inlineResultBytes: 1024 * 1024,
  opTimeoutMs: 30_000,
  maxLineBytes: 8 * 1024 * 1024,
};

/** A POST carrying this header (value `1`) is the daemon's `hello`, in its body;
 * main answers `{helloId}`, and the downlink GET names that id in this header. */
export const LINK_HELLO_HEADER = "x-omp-web-hello";
/** Every uplink POST carries the highest downlink `seq` the daemon applied. */
export const LINK_ACK_HEADER = "x-omp-web-ack";
/** Uplink POSTs and blob uploads name the link (`welcome.nonce`) they belong to;
 * main refuses one from a link that was replaced since. */
export const LINK_NONCE_HEADER = "x-omp-web-link";

/** Named `req.args` keys for each session op, in parameter order. Named, not
 * positional, so an omitted optional argument never turns into `null`. */
export const SESSION_OP_PARAMS: { readonly [K in keyof SessionOps]: readonly string[] } = {
  listSessions: [],
  readSession: ["id", "options"],
  readContext: ["id", "leafId", "options"],
  readThinking: ["id", "entryId", "block"],
  readSessionState: ["id"],
  readSubagentHistory: ["id"],
  readSubagentTranscript: ["id", "subagentId", "mode", "cursor"],
  renameSessionFile: ["id", "title", "source"],
  deleteSession: ["id", "liveSessionIds"],
  archiveSession: ["id"],
  exportSession: ["id"],
  readMedia: ["hash"],
  listProjects: [],
  addProject: ["path", "launchConfig"],
  updateProject: ["updates"],
  hideProject: ["path"],
  validateCwd: ["path"],
};

/** Every op a daemon answers: the session ops plus three on the host itself. */
export const HOST_OP_NAMES = [...(Object.keys(SESSION_OP_PARAMS) as (keyof SessionOps)[]), "spawn", "sessionFileExists", "invalidateSessionLists"] as const;

export type HostOpName = (typeof HOST_OP_NAMES)[number];

/** A failed host op, as carried by `res {ok: false, error}`. */
export class HostOpError extends Error {
  readonly name = "HostOpError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type DownMessage =
  | { type: "welcome"; v: number; hostId: string; nonce: string }
  | { type: "stdin"; seq: number; ch: string; line: string }
  | { type: "kill"; seq: number; ch: string; force: boolean }
  | { type: "req"; seq: number; id: string; op: HostOpName; args: unknown }
  | { type: "replaced"; seq: number }
  | { type: "ping" }
  | { type: "pong" };

export type UpMessage =
  | {
      type: "hello";
      v: number;
      ompVersion: string | null;
      platform: string;
      home: string;
      ack: number;
      channels: { ch: string; sessionId: string | null }[];
    }
  | { type: "stdout"; seq: number; ch: string; line: string }
  | { type: "stderr"; seq: number; ch: string; chunk: string }
  | { type: "exit"; seq: number; ch: string; code: number | null; signal: string | null }
  | { type: "resync"; seq: number; ch: string }
  | { type: "res"; seq: number; id: string; ok: true; result?: unknown; blob?: { bytes: number } }
  | {
      type: "res";
      seq: number;
      id: string;
      ok: false;
      error: { status: number; code: string; message: string };
    }
  | { type: "ping" }
  | { type: "pong" };

export class LinkProtocolError extends Error {
  readonly name = "LinkProtocolError";
}

export class LinkLimitError extends Error {
  readonly name = "LinkLimitError";
}

const encoder = new TextEncoder();

export function encodeLine(message: DownMessage | UpMessage): string {
  const json = JSON.stringify(message);
  if (encoder.encode(json).byteLength > LINK_LIMITS.maxLineBytes) {
    throw new LinkLimitError(`link line exceeds ${LINK_LIMITS.maxLineBytes} bytes`);
  }
  return json + "\n";
}

type Obj = Record<string, unknown>;

function fail(message: string): never {
  throw new LinkProtocolError(message);
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== "string") fail(`${key} must be a string`);
  return v;
}

function int(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`${key} must be an integer`);
  return v;
}

function bool(o: Obj, key: string): boolean {
  const v = o[key];
  if (typeof v !== "boolean") fail(`${key} must be a boolean`);
  return v;
}

function nullable<T>(o: Obj, key: string, read: (o: Obj, key: string) => T): T | null {
  return o[key] === null ? null : read(o, key);
}

function isHostOp(name: string): name is HostOpName {
  return (HOST_OP_NAMES as readonly string[]).includes(name);
}

function parseLine(line: string): Obj {
  if (encoder.encode(line).byteLength > LINK_LIMITS.maxLineBytes) {
    throw new LinkLimitError(`link line exceeds ${LINK_LIMITS.maxLineBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail("link line is not valid JSON");
  }
  if (!isObj(value)) fail("link line is not a JSON object");
  return value;
}

export function decodeDown(line: string): DownMessage {
  const o = parseLine(line);
  switch (o.type) {
    case "welcome":
      return { type: "welcome", v: int(o, "v"), hostId: str(o, "hostId"), nonce: str(o, "nonce") };
    case "stdin":
      return { type: "stdin", seq: int(o, "seq"), ch: str(o, "ch"), line: str(o, "line") };
    case "kill":
      return { type: "kill", seq: int(o, "seq"), ch: str(o, "ch"), force: bool(o, "force") };
    case "req": {
      const op = str(o, "op");
      if (!isHostOp(op)) fail(`unknown host op: ${op}`);
      if (!("args" in o)) fail("args must be present");
      return { type: "req", seq: int(o, "seq"), id: str(o, "id"), op, args: o.args };
    }
    case "replaced":
      return { type: "replaced", seq: int(o, "seq") };
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    default:
      return fail(`unknown down message type: ${String(o.type)}`);
  }
}

function channels(o: Obj): { ch: string; sessionId: string | null }[] {
  const list = o.channels;
  if (!Array.isArray(list)) fail("channels must be an array");
  return list.map((c: unknown) => {
    if (!isObj(c)) fail("channel must be an object");
    return { ch: str(c, "ch"), sessionId: nullable(c, "sessionId", str) };
  });
}

function res(o: Obj): UpMessage {
  const seq = int(o, "seq");
  const id = str(o, "id");
  if (o.ok === true) {
    const blob = o.blob;
    if (blob !== undefined) {
      if (!isObj(blob)) fail("blob must be an object");
      return { type: "res", seq, id, ok: true, blob: { bytes: int(blob, "bytes") } };
    }
    return "result" in o
      ? { type: "res", seq, id, ok: true, result: o.result }
      : { type: "res", seq, id, ok: true };
  }
  if (o.ok === false) {
    const error = o.error;
    if (!isObj(error)) fail("error must be an object");
    return {
      type: "res",
      seq,
      id,
      ok: false,
      error: { status: int(error, "status"), code: str(error, "code"), message: str(error, "message") },
    };
  }
  return fail("ok must be true or false");
}

export function decodeUp(line: string): UpMessage {
  const o = parseLine(line);
  switch (o.type) {
    case "hello":
      return {
        type: "hello",
        v: int(o, "v"),
        ompVersion: nullable(o, "ompVersion", str),
        platform: str(o, "platform"),
        home: str(o, "home"),
        ack: int(o, "ack"),
        channels: channels(o),
      };
    case "stdout":
      return { type: "stdout", seq: int(o, "seq"), ch: str(o, "ch"), line: str(o, "line") };
    case "stderr":
      return { type: "stderr", seq: int(o, "seq"), ch: str(o, "ch"), chunk: str(o, "chunk") };
    case "exit":
      return {
        type: "exit",
        seq: int(o, "seq"),
        ch: str(o, "ch"),
        code: nullable(o, "code", int),
        signal: nullable(o, "signal", str),
      };
    case "resync":
      return { type: "resync", seq: int(o, "seq"), ch: str(o, "ch") };
    case "res":
      return res(o);
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    default:
      return fail(`unknown up message type: ${String(o.type)}`);
  }
}

// Receiving side keeps a high-water mark: a seq at or below it was already applied.
// Sending side hands out 1, 2, 3, ...
export class SeqWindow {
  private sent = 0;
  private high = 0;

  next(): number {
    this.sent += 1;
    return this.sent;
  }

  applied(seq: number): boolean {
    if (seq <= this.high) return false;
    this.high = seq;
    return true;
  }

  get acked(): number {
    return this.high;
  }
}

export class Outbox<M extends { seq: number }> {
  private items: M[] = [];

  push(m: M): void {
    this.items.push(m);
  }

  ack(upTo: number): void {
    this.items = this.items.filter((m) => m.seq > upTo);
  }

  pending(): M[] {
    return [...this.items].sort((a, b) => a.seq - b.seq);
  }

  drop(predicate: (m: M) => boolean): void {
    this.items = this.items.filter((m) => !predicate(m));
  }
}
