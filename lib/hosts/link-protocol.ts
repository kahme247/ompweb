// Wire format between the main omp-web server and the `ompweb host` daemon.
// Pure: no I/O and no Next or `@/` imports, so both sides share it.
import type { SessionOps } from "./session-ops";

/** 2: the hello moved from a GET header into a POST body (a v1 daemon gets 426).
 * 3: hello channels carry `pending`, the raw lines of their open blocking requests.
 * Rules for changing it: docs/specs/2026-10-28-remote-hosts-design.md, "Protocol versions and compatibility". */
export const LINK_PROTOCOL_VERSION = 3;
/** The oldest daemon protocol the server still links (older ones get 426). Dropping one is an explicit decision. */
export const MIN_LINK_PROTOCOL_VERSION = 2;

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
  /** Per channel: open blocking requests past this are not replayed (the channel is not adoptable). */
  pendingBytes: 1024 * 1024,
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
  /** `op` is whatever the sender named: the daemon answers one it does not know with 501 `unknown_op`. */
  | { type: "req"; seq: number; id: string; op: string; args: unknown }
  | { type: "replaced"; seq: number }
  | { type: "ping" }
  | { type: "pong" };

/** `sessionId`: the session the child last reported (null before it named one); `cwd`: where the
 * daemon spawned it; `pending`: raw stdout lines of its open blocking requests, or null when over `pendingBytes`. */
export type HelloChannel = { ch: string; sessionId: string | null; cwd: string; pending: string[] | null };

export type UpMessage =
  | {
      type: "hello";
      v: number;
      ompVersion: string | null;
      platform: string;
      home: string;
      /** omp's `tools.approval.extension: allow` on the host: a run adopted after a web restart had no spawn to report it. */
      autoApproveExtension: boolean;
      ack: number;
      channels: HelloChannel[];
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

/** A message this side cannot decode by type (a newer peer's), or one that only the other side may send
 * (`wrongDirection`): receivers skip it, but ack its `seq` (null when it carries none) so it is never resent. */
export type UnknownMessage = { type: "unknown"; messageType: string; seq: number | null; wrongDirection: boolean };

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

/** A `seq` or `ack`: a safe non-negative integer, so one line cannot push a window out of reach of every later message. */
function seqNum(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(`${key} must be a non-negative safe integer`);
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

function strings(o: Obj, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) fail(`${key} must be an array of strings`);
  return v;
}

export function isHostOp(name: string): name is HostOpName {
  return (HOST_OP_NAMES as readonly string[]).includes(name);
}

const DOWN_TYPES: readonly string[] = ["welcome", "stdin", "kill", "req", "replaced", "ping", "pong"];
const UP_TYPES: readonly string[] = ["hello", "stdout", "stderr", "exit", "resync", "res", "ping", "pong"];

/** `otherDirection`: the types only the other direction decodes; one of those arrived on the wrong way. */
function unknownMessage(o: Obj, otherDirection: readonly string[]): UnknownMessage {
  const messageType = str(o, "type");
  return { type: "unknown", messageType, seq: "seq" in o ? seqNum(o, "seq") : null, wrongDirection: otherDirection.includes(messageType) };
}

/** Distinct unknown types, and wrong-direction messages, one link may make a side log. */
export const UNKNOWN_LOG_CAP = 16;

/** What one side logs about the messages it skips, per link: an unknown type once, a wrong-direction message every
 * time, each within UNKNOWN_LOG_CAP, so a peer cannot flood the log. The type is escaped and cut to 64 characters. */
export class UnknownMessageLog {
  private readonly types = new Set<string>();
  private misdirected = 0;
  private readonly from: "daemon" | "server";

  /** `from`: who sends the messages this log sees. */
  constructor(from: "daemon" | "server") {
    this.from = from;
  }

  /** The text to log for `message`, or null when there is nothing to log. */
  note(message: UnknownMessage): string | null {
    const type = JSON.stringify(message.messageType.slice(0, 64));
    if (message.wrongDirection) {
      if (this.misdirected >= UNKNOWN_LOG_CAP) return null;
      this.misdirected += 1;
      return `${type} is not valid from the ${this.from}`;
    }
    if (this.types.has(type) || this.types.size >= UNKNOWN_LOG_CAP) return null;
    this.types.add(type);
    return `ignored an unknown link message type ${type}`;
  }

  /** A new link starts again. */
  reset(): void {
    this.types.clear();
    this.misdirected = 0;
  }
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

export function decodeDown(line: string): DownMessage | UnknownMessage {
  const o = parseLine(line);
  switch (o.type) {
    case "welcome":
      return { type: "welcome", v: int(o, "v"), hostId: str(o, "hostId"), nonce: str(o, "nonce") };
    case "stdin":
      return { type: "stdin", seq: seqNum(o, "seq"), ch: str(o, "ch"), line: str(o, "line") };
    case "kill":
      return { type: "kill", seq: seqNum(o, "seq"), ch: str(o, "ch"), force: bool(o, "force") };
    case "req":
      return { type: "req", seq: seqNum(o, "seq"), id: str(o, "id"), op: str(o, "op"), args: "args" in o ? o.args : fail("args must be present") };
    case "replaced":
      return { type: "replaced", seq: seqNum(o, "seq") };
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    default:
      return unknownMessage(o, UP_TYPES);
  }
}

/** A v2 hello's channels carry no `cwd` or `pending`: decoded with `pending: null`, which reattach kills instead of adopting. */
function channels(o: Obj, v2: boolean): HelloChannel[] {
  const list = o.channels;
  if (!Array.isArray(list)) fail("channels must be an array");
  return list.map((c: unknown) => {
    if (!isObj(c)) fail("channel must be an object");
    const ch = str(c, "ch");
    const sessionId = nullable(c, "sessionId", str);
    return v2 ? { ch, sessionId, cwd: "", pending: null } : { ch, sessionId, cwd: str(c, "cwd"), pending: nullable(c, "pending", strings) };
  });
}

function res(o: Obj): UpMessage {
  const seq = seqNum(o, "seq");
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

export function decodeUp(line: string): UpMessage | UnknownMessage {
  const o = parseLine(line);
  switch (o.type) {
    case "hello": {
      const v = int(o, "v");
      return {
        type: "hello",
        v,
        ompVersion: nullable(o, "ompVersion", str),
        platform: str(o, "platform"),
        home: str(o, "home"),
        // A v2 hello does not say: off until a spawn result reports it.
        autoApproveExtension: v === 2 ? false : bool(o, "autoApproveExtension"),
        ack: seqNum(o, "ack"),
        channels: channels(o, v === 2),
      };
    }
    case "stdout":
      return { type: "stdout", seq: seqNum(o, "seq"), ch: str(o, "ch"), line: str(o, "line") };
    case "stderr":
      return { type: "stderr", seq: seqNum(o, "seq"), ch: str(o, "ch"), chunk: str(o, "chunk") };
    case "exit":
      return {
        type: "exit",
        seq: seqNum(o, "seq"),
        ch: str(o, "ch"),
        code: nullable(o, "code", int),
        signal: nullable(o, "signal", str),
      };
    case "resync":
      return { type: "resync", seq: seqNum(o, "seq"), ch: str(o, "ch") };
    case "res":
      return res(o);
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    default:
      return unknownMessage(o, DOWN_TYPES);
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
