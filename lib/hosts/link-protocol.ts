// Wire format between the main omp-web server and the `ompweb host` daemon.
// Pure: no I/O and no Next or `@/` imports, so both sides share it. The browser link (lib/browser-link.ts and the
// worker it talks to, lib/event-stream-worker.ts) reuses its transport pieces: LINK_LIMITS' piece, window and liveness
// values, LinkSender, PartJoiner, SeqWindow, Outbox, queuedLine and withSeq.
import { isValidSessionId } from "../session-file-references-core";
import type { SessionOps } from "./session-ops";

/** 5: a line over `pieceBytes` goes as `part` messages and a large result as several binary frames, both sent fair
 * across channels (docs/specs/2026-10-31-websocket-link-design.md, D7). 4: the link is one WebSocket: text frames carry
 * the messages, binary frames large results, `ack` messages replace the ack header and the POST answer.
 * Rules for changing it: docs/specs/2026-10-28-remote-hosts-design.md, "Protocol versions and compatibility". */
export const LINK_PROTOCOL_VERSION = 5;
/** The oldest daemon protocol the server still links (older ones get close 4426). Dropping one is an explicit decision. */
export const MIN_LINK_PROTOCOL_VERSION = 4;

export const LINK_LIMITS = {
  pingMs: 15_000,
  offlineMs: 30_000,
  // One prompt's two echoes (message_start, message_end) must fit with no ack on a
  // slow link: each is up to the 8 MiB command body as base64 rpc_chunk lines
  // (~10.7 MiB), and the rest is room for the streamed reply.
  channelBufferBytes: 32 * 1024 * 1024,
  flushMs: 16,
  /** Largest `part` line and binary frame payload (v5); an uplink text frame batches lines up to it. */
  pieceBytes: 256 * 1024,
  /** v5: a side sends queued lines and result pieces only while less than this is sent and not acked (spec D7), so a
   * small message never waits behind more than this plus one piece in kernel, proxy or peer buffers (768 KiB: about
   * 3.1 s at 2 Mbit). It also caps throughput at about this per round trip. Control lines go regardless. The browser
   * link's server side uses it as a cap: its window follows the link below it (lib/browser-link.ts `measure`). */
  unackedBytes: 2 * 256 * 1024,
  uplinkBytes: 16 * 1024 * 1024,
  blobBytes: 64 * 1024 * 1024,
  inlineResultBytes: 1024 * 1024,
  opTimeoutMs: 30_000,
  maxLineBytes: 8 * 1024 * 1024,
  /** Per channel: open blocking requests past this are not replayed (the channel is not adoptable). */
  pendingBytes: 1024 * 1024,
  /** Link head-of-line samples (metric "link"): each side writes or reports them at this count, else after statsFlushMs.
   * Also the most one `stats` message may carry, which bounds it to about 40 KB. */
  statsSamples: 256,
  statsFlushMs: 30_000,
};

/** WebSocket close codes the link uses. */
export const LINK_CLOSE = { goingAway: 1001, invalidData: 1007, policy: 1008, tooBig: 1009, replaced: 4409, versionMismatch: 4426 } as const;

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

/** v5: one slice of a sequenced line longer than `pieceBytes` (`LinkSender` cuts it, `PartJoiner` joins it): `data`
 * starts at UTF-16 offset `at` of the line; `end` marks the last slice. */
export type Part = { type: "part"; seq: number; at: number; end: boolean; data: string };

export type DownMessage =
  | { type: "welcome"; v: number; hostId: string }
  | { type: "stdin"; seq: number; ch: string; line: string }
  | { type: "kill"; seq: number; ch: string; force: boolean }
  /** `op` is whatever the sender named: the daemon answers one it does not know with 501 `unknown_op`. */
  | { type: "req"; seq: number; id: string; op: string; args: unknown }
  | { type: "ping" }
  | { type: "pong" }
  /** Unsequenced: the highest uplink `seq` the hub applied. */
  | { type: "ack"; ack: number }
  | Part;

/** `sessionId`: the session the child last reported (null before it named one); `cwd`: where the
 * daemon spawned it; `pending`: raw stdout lines of its open blocking requests, or null when over `pendingBytes`. */
export type HelloChannel = { ch: string; sessionId: string | null; cwd: string; pending: string[] | null };

/** One uplink message the daemon measured: enqueued at `at` (its wall clock) with `bytesAhead` bytes unacked ahead of
 * it (messages and result blobs), `bytes` its own size (with its blob), acked by the hub `ackMs` later (a monotonic
 * interval). */
export type LinkStatSample = { session: string | null; bytes: number; bytesAhead: number; ackMs: number; at: number };

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
  /** The daemon's link samples, at most LINK_LIMITS.statsSamples; a hub that predates it skips the type. Advisory: the
   * receiver keeps the valid ones and counts the rest in `invalid` (decodeUp only; a sender leaves it out). */
  | { type: "stats"; seq: number; samples: LinkStatSample[]; invalid?: number }
  | { type: "res"; seq: number; id: string; ok: true; result?: unknown; blob?: { bytes: number } }
  | {
      type: "res";
      seq: number;
      id: string;
      ok: false;
      error: { status: number; code: string; message: string };
    }
  | { type: "ping" }
  | { type: "pong" }
  /** Unsequenced: the highest downlink `seq` the daemon applied. */
  | { type: "ack"; ack: number }
  | Part;

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
const decoder = new TextDecoder();

export function encodeLine(message: DownMessage | UpMessage): string {
  const json = JSON.stringify(message);
  if (encoder.encode(json).byteLength > LINK_LIMITS.maxLineBytes) {
    throw new LinkLimitError(`link line exceeds ${LINK_LIMITS.maxLineBytes} bytes`);
  }
  return json + "\n";
}

/** A sequenced message before the link numbers it. */
export type Unsequenced<M> = M extends { seq: number } ? Omit<M, "seq"> : never;

const SEQ_TAIL = `${Number.MAX_SAFE_INTEGER}}\n`;

/** A sequenced message's line before its `seq` is known: `LinkSender` numbers it as it goes out (`withSeq`). Encoded
 * with the widest seq, so the real one never takes it past maxLineBytes. Throws LinkLimitError. */
export function encodeQueued(body: Unsequenced<DownMessage | UpMessage>): string {
  return encodeLine({ ...body, seq: Number.MAX_SAFE_INTEGER } as DownMessage | UpMessage);
}

/** `line` from encodeQueued with `seq` filled in (it is the last key). */
export function withSeq(line: string, seq: number): string {
  return `${line.slice(0, -SEQ_TAIL.length)}${seq}}\n`;
}

/** A JSON object's text as a line `LinkSender` numbers (`withSeq`), like encodeQueued without the typed message. */
export function queuedLine(json: string): string {
  return `${json.slice(0, -1)},"seq":${SEQ_TAIL}`;
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

/** A `seq`, an `ack` or a count: a safe non-negative integer, so one line cannot push a window out of reach of every later message. */
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

const DOWN_TYPES: readonly string[] = ["welcome", "stdin", "kill", "req", "ping", "pong", "ack"];
const UP_TYPES: readonly string[] = ["hello", "stdout", "stderr", "exit", "resync", "stats", "res", "ping", "pong", "ack"];

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
      return { type: "welcome", v: int(o, "v"), hostId: str(o, "hostId") };
    case "stdin":
      return { type: "stdin", seq: seqNum(o, "seq"), ch: str(o, "ch"), line: str(o, "line") };
    case "kill":
      return { type: "kill", seq: seqNum(o, "seq"), ch: str(o, "ch"), force: bool(o, "force") };
    case "req":
      return { type: "req", seq: seqNum(o, "seq"), id: str(o, "id"), op: str(o, "op"), args: "args" in o ? o.args : fail("args must be present") };
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    case "ack":
      return { type: "ack", ack: seqNum(o, "ack") };
    case "part":
      return part(o);
    default:
      return unknownMessage(o, UP_TYPES);
  }
}

function part(o: Obj): Part {
  return { type: "part", seq: seqNum(o, "seq"), at: seqNum(o, "at"), end: bool(o, "end"), data: str(o, "data") };
}

function channels(o: Obj): HelloChannel[] {
  const list = o.channels;
  if (!Array.isArray(list)) fail("channels must be an array");
  return list.map((c: unknown) => {
    if (!isObj(c)) fail("channel must be an object");
    return { ch: str(c, "ch"), sessionId: nullable(c, "sessionId", str), cwd: str(c, "cwd"), pending: nullable(c, "pending", strings) };
  });
}

/** One sample's fixed fields, or null when one is missing or out of range. Extra fields are dropped. */
function statSample(s: unknown): LinkStatSample | null {
  if (!isObj(s)) return null;
  const { session, bytes, bytesAhead, ackMs, at } = s;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!(session === null || (typeof session === "string" && isValidSessionId(session)))) return null;
  return count(bytes) && count(bytesAhead) && count(ackMs) && count(at) ? { session, bytes, bytesAhead, ackMs, at } : null;
}

/** Samples are advisory: a bad one (or one past statsSamples) is dropped and counted, never fails the line, so a
 * daemon's measuring bug cannot stop its link. */
function stats(o: Obj): UpMessage {
  const seq = seqNum(o, "seq");
  const list = Array.isArray(o.samples) ? o.samples : null;
  if (!list) return { type: "stats", seq, samples: [], invalid: 1 };
  const samples: LinkStatSample[] = [];
  for (const s of list.slice(0, LINK_LIMITS.statsSamples)) {
    const sample = statSample(s);
    if (sample) samples.push(sample);
  }
  return { type: "stats", seq, samples, invalid: list.length - samples.length };
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
    case "hello":
      return {
        type: "hello",
        v: int(o, "v"),
        ompVersion: nullable(o, "ompVersion", str),
        platform: str(o, "platform"),
        home: str(o, "home"),
        autoApproveExtension: bool(o, "autoApproveExtension"),
        ack: seqNum(o, "ack"),
        channels: channels(o),
      };
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
    case "stats":
      return stats(o);
    case "res":
      return res(o);
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    case "ack":
      return { type: "ack", ack: seqNum(o, "ack") };
    case "part":
      return part(o);
    default:
      return unknownMessage(o, DOWN_TYPES);
  }
}

/** One binary WebSocket frame: `[n][id: n bytes][payload]`, n = UTF-8 length of the request id (1..255). */
export function encodeBlobFrame(id: string, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const idBytes = encoder.encode(id);
  if (idBytes.byteLength === 0 || idBytes.byteLength > 255) fail("blob frame id must be 1..255 UTF-8 bytes");
  const frame = new Uint8Array(1 + idBytes.byteLength + bytes.byteLength);
  frame[0] = idBytes.byteLength;
  frame.set(idBytes, 1);
  frame.set(bytes, 1 + idBytes.byteLength);
  return frame;
}

/** `bytes` is a view into `frame`, not a copy. */
export function decodeBlobFrame(frame: Uint8Array): { id: string; bytes: Uint8Array } {
  const n = frame[0];
  if (!n) fail("blob frame has no id");
  if (frame.byteLength < 1 + n) fail("blob frame is shorter than its header");
  return { id: decoder.decode(frame.subarray(1, 1 + n)), bytes: frame.subarray(1 + n) };
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

/** Sent lines a side keeps until the peer acks them, in `seq` order (both sides push them in the order they number
 * them). `ack` and `drop` return what they removed. */
export class Outbox<M extends { seq: number }> {
  private items: M[] = [];

  push(m: M): void {
    this.items.push(m);
  }

  ack(upTo: number): M[] {
    let n = 0;
    while (n < this.items.length && this.items[n].seq <= upTo) n += 1;
    return this.items.splice(0, n);
  }

  /** A copy, in seq order. */
  pending(): M[] {
    return this.items.slice();
  }

  drop(predicate: (m: M) => boolean): M[] {
    const dropped = this.items.filter(predicate);
    if (dropped.length > 0) this.items = this.items.filter((m) => !predicate(m));
    return dropped;
  }
}

/** What `LinkSender` queues under a key: a line from `encodeQueued` (`size`: its UTF-8 bytes), or a result's bytes. */
export type SendItem = { line: string; size: number } | { id: string; blob: Uint8Array };

/** One unit from `LinkSender.next`; `done` when it was the last of `item`. A line (a whole message, or a `part` when
 * `part`) carries the `seq` it was numbered with and `messageBytes`, the UTF-8 size of its whole message as numbered
 * (seq 0 for one sent in parts); a piece of result bytes is an unnumbered binary `frame`. */
export type SendUnit<T extends SendItem> = { key: string; item: T; done: boolean } & ({ seq: number; line: string; part: boolean; messageBytes: number } | { frame: Uint8Array<ArrayBuffer> });

/** The UTF-8 size of a line from encodeQueued (`size`) once numbered `seq`. */
function numberedBytes(size: number, seq: number): number {
  return size - (SEQ_TAIL.length - 2) + String(seq).length;
}

/** The `part` line for `line` from `at`: as much of it as fits in pieceBytes once encoded. */
function cutPart(line: string, at: number, seq: number): { line: string; at: number } {
  for (let n = Math.min(line.length - at, LINK_LIMITS.pieceBytes); ;) {
    const part: Part = { type: "part", seq, at, end: at + n >= line.length, data: line.slice(at, at + n) };
    const encoded = `${JSON.stringify(part)}\n`;
    const size = encoder.encode(encoded).byteLength;
    if (size <= LINK_LIMITS.pieceBytes || n === 1) return { line: encoded, at: at + n };
    n = Math.max(1, Math.floor((n * LINK_LIMITS.pieceBytes) / size) - 1);
  }
}

/** The sending side of one link direction (spec D7): FIFO per key, keys served round-robin (Map order: a key that
 * sent goes to the back), each turn one whole line, one `part` or one result piece. Lines are numbered as they go
 * out, so wire order is `seq` order. One key at a time may be part-way through a multi-part line, so the receiver
 * holds at most one partial line. `parts`: false for a v4 peer, which gets every line whole. */
export class LinkSender<T extends SendItem> {
  parts: boolean;
  /** `at`: how far the item has gone out (UTF-16 units of `line`, bytes of `blob`); `line`: set while it goes in parts;
   * `left`: its bytes still counted in queuedBytes. */
  private readonly queues = new Map<string, { item: T; at: number; line: string | null; left: number }[]>();
  private active: string | null = null;
  private queued = 0;

  constructor(parts: boolean) {
    this.parts = parts;
  }

  /** Bytes queued and not sent yet (a line's `size`, a result's bytes; a line going in parts less the parts sent). */
  get queuedBytes(): number {
    return this.queued;
  }

  push(key: string, item: T): void {
    const left = "blob" in item ? item.blob.byteLength : item.size;
    this.queued += left;
    const entry = { item, at: 0, line: null, left };
    const queue = this.queues.get(key);
    if (queue) queue.push(entry);
    else this.queues.set(key, [entry]);
  }

  /** Forget what `key` queued, a line part-way out included: the receiver drops that partial line. */
  drop(key: string): void {
    for (const { left } of this.queues.get(key) ?? []) this.queued -= left;
    this.queues.delete(key);
    if (this.active === key) this.active = null;
  }

  /** Forget every result's bytes not sent yet, a result part-way out included, but not the `res` behind them: after a
   * redial the server has failed those ops, or their `res` fails 502 host_blob_missing. */
  dropBlobs(): void {
    for (const [key, queue] of this.queues) {
      const rest = queue.filter(({ item }) => !("blob" in item));
      for (const entry of queue) if ("blob" in entry.item) this.queued -= entry.left;
      if (rest.length === 0) this.queues.delete(key);
      else this.queues.set(key, rest);
    }
  }

  /** `bytes` of an entry went out (all of what it has left when `done`). */
  private sent(entry: { left: number }, done: boolean, bytes: number): void {
    const gone = done ? entry.left : Math.min(entry.left, bytes);
    entry.left -= gone;
    this.queued -= gone;
  }

  /** The next unit, or null when nothing is queued; `nextSeq` numbers a line. */
  next(nextSeq: () => number): SendUnit<T> | null {
    for (const [key, queue] of this.queues) {
      const head = queue[0];
      const { item } = head;
      let unit: SendUnit<T>;
      if ("blob" in item) {
        const piece = item.blob.subarray(head.at, head.at + LINK_LIMITS.pieceBytes);
        head.at += piece.byteLength;
        unit = { key, item, done: head.at >= item.blob.byteLength, frame: encodeBlobFrame(item.id, piece) };
        this.sent(head, unit.done, piece.byteLength);
      } else if (!this.parts || item.size <= LINK_LIMITS.pieceBytes) {
        // A line part-way out in parts when the peer turned out to be v4 goes whole from the start.
        if (this.active === key) this.active = null;
        const seq = nextSeq();
        unit = { key, item, done: true, seq, line: withSeq(item.line, seq), part: false, messageBytes: numberedBytes(item.size, seq) };
        this.sent(head, true, 0);
      } else {
        if (this.active !== null && this.active !== key) continue;
        this.active = key;
        // The joined line is applied without a dedup of its own (its parts had one), so its seq is 0.
        head.line ??= withSeq(item.line, 0);
        const seq = nextSeq();
        const from = head.at;
        const cut = cutPart(head.line, from, seq);
        head.at = cut.at;
        const done = head.at >= head.line.length;
        if (done) this.active = null;
        unit = { key, item, done, seq, line: cut.line, part: true, messageBytes: numberedBytes(item.size, 0) };
        // `left` counts the line's own bytes: what the part consumed of it, not the part's size with its envelope.
        this.sent(head, done, done ? 0 : encoder.encode(head.line.slice(from, cut.at)).byteLength);
      }
      if (unit.done) queue.shift();
      this.queues.delete(key);
      if (queue.length > 0) this.queues.set(key, queue);
      return unit;
    }
    return null;
  }
}

/** Joins `part`s back into their line (spec D7), one line at a time as `LinkSender` sends them. */
export class PartJoiner {
  /** Most parts in one line: a legitimate 8 MiB line needs about 200, even with every character escaped. */
  static readonly maxParts = 512;
  private chunks: string[] | null = null;
  private at = 0;

  /** `maxChars`: the longest joined line in UTF-16 units (the browser link's commands are up to 8 MiB plus their envelope). */
  constructor(private readonly maxChars: number = LINK_LIMITS.maxLineBytes) {}

  /** A copy to try a frame's parts on: the original stays as it was until the frame is known to decode. */
  clone(): PartJoiner {
    const copy = new PartJoiner(this.maxChars);
    copy.chunks = this.chunks && [...this.chunks];
    copy.at = this.at;
    return copy;
  }

  /** The whole line once `part` ends it, else null. A part at 0 starts a new line, dropping a partial one; a part that
   * does not continue the line in progress (its sender dropped the rest), or takes it past maxChars or maxParts,
   * is dropped with that line. */
  add(part: Pick<Part, "at" | "end" | "data">): string | null {
    if (part.at === 0) {
      this.chunks = [];
      this.at = 0;
    }
    if (
      !this.chunks
      || part.at !== this.at
      || this.at + part.data.length > this.maxChars
      || this.chunks.length >= PartJoiner.maxParts
    ) {
      this.chunks = null;
      return null;
    }
    this.chunks.push(part.data);
    this.at += part.data.length;
    if (!part.end) return null;
    const line = this.chunks.join("");
    this.chunks = null;
    return line;
  }
}
