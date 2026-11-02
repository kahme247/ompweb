// Rebuilds a streaming assistant message from omp's delta `message_update`
// frames (`set_event_filter` with `messageUpdates: "delta"`, omp >= 18.13.2):
// `message` is only `{ role }`, and `assistantMessageEvent` carries the
// increment instead of the accumulated `partial`. Starts carry the opened
// block, deltas append to the block at `contentIndex`, ends carry the final
// block. Shared by the server (live snapshot, backpressure merge) and the
// browser (display), so both rebuild the same message.
//
// Messages are never mutated: every applied update returns a new message with
// a new content array and a new block, so a snapshot handed out earlier stays
// as it was.

import { isRecord } from "./type-guards";

type Block = { type?: unknown; [key: string]: unknown };
/** Any message shape; only `content` is read. */
const contentOf = (message: object | undefined): unknown => (message as { content?: unknown } | undefined)?.content;

const MAX_INDEX_GAP = 32;
const DELTA_KINDS: Record<string, true> = { text_delta: true, thinking_delta: true, toolcall_delta: true };

/** A `message_update` without a snapshot: omp's delta projection sends `message: { role }` only. */
export function isDeltaUpdate(event: { type?: unknown; message?: unknown }): boolean {
  return event.type === "message_update" && isRecord(event.message) && !("content" in event.message);
}

/**
 * `message` with one omp `assistantMessageEvent` applied, or null when the
 * update does not fit it (no base, no block at its index, a block of another
 * kind, an unknown kind, an omp older than 18.13.2 that sends no opened block):
 * the caller has lost the message and must get a snapshot, never guess.
 */
export function applyMessageDelta<T extends object>(message: T | undefined, update: unknown): T | null {
  if (!isRecord(update)) return null;
  if (update.type === "start") return isRecord(update.message) && Array.isArray(update.message.content) ? update.message as T : null;
  const blocks = contentOf(message);
  if (!message || !Array.isArray(blocks)) return null;
  if (update.type === "done" || update.type === "error") return message;
  const index = update.contentIndex;
  // A block opens at most a little past the last one: a far index would grow the message by millions of holes.
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > blocks.length + MAX_INDEX_GAP) return null;
  const block = blocks[index] as Block | null | undefined;
  let next: unknown;
  switch (update.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      next = update.block;
      break;
    case "text_delta":
      if (block?.type !== "text" || typeof block.text !== "string" || typeof update.delta !== "string") return null;
      next = { ...block, text: block.text + update.delta };
      break;
    case "thinking_delta":
      if (block?.type !== "thinking" || typeof block.thinking !== "string" || typeof update.delta !== "string") return null;
      next = { ...block, thinking: block.thinking + update.delta };
      break;
    case "toolcall_delta":
      // The arguments are complete only at toolcall_end; until then keep the JSON so far (see withStreamedArguments).
      if (block?.type !== "toolCall" || typeof update.delta !== "string") return null;
    {
      const streamed = { ...block, partialJson: (typeof block.partialJson === "string" ? block.partialJson : "") + update.delta };
      // The block's last parse carries over, so withStreamedArguments can skip re-parsing a few more bytes.
      const parsed = parsedArguments.get(block);
      if (parsed) parsedArguments.set(streamed, parsed);
      next = streamed;
      break;
    }
    case "text_end":
      if (typeof update.content !== "string") return null;
      next = { ...(isRecord(update.block) ? update.block : block?.type === "text" ? block : { type: "text" }), text: update.content };
      break;
    case "thinking_end":
      if (typeof update.content !== "string") return null;
      next = { ...(isRecord(update.block) ? update.block : block?.type === "thinking" ? block : { type: "thinking" }), thinking: update.content };
      break;
    case "image_end":
      next = update.content;
      break;
    case "toolcall_end":
      next = update.toolCall;
      break;
    default:
      return null;
  }
  if (!isRecord(next)) return null;
  const content = blocks.slice();
  content[index] = next;
  return { ...message, content } as T;
}

/**
 * One frame for two consecutive deltas of the same block, or null when they cannot merge. It keeps the later
 * frame's sequence and stamps `web.first` with the earlier's first: a snapshot inside that range holds only part
 * of it, so the browser must not apply it there (message-update-coalescer.ts).
 */
export function mergeDeltaUpdates<T extends { messageId?: unknown; assistantMessageEvent?: unknown; web?: unknown }>(earlier: T, later: T): T | null {
  const a = earlier.assistantMessageEvent;
  const b = later.assistantMessageEvent;
  if (!isRecord(a) || !isRecord(b) || earlier.messageId !== later.messageId) return null;
  if (a.type !== b.type || typeof a.type !== "string" || !DELTA_KINDS[a.type] || a.contentIndex !== b.contentIndex) return null;
  if (typeof a.delta !== "string" || typeof b.delta !== "string") return null;
  const merged = { ...later, assistantMessageEvent: { ...b, delta: a.delta + b.delta } };
  const before = earlier.web;
  if (!isRecord(before) || !isRecord(later.web)) return merged;
  const first = typeof before.first === "number" ? before.first : before.sequence;
  return typeof first === "number" ? { ...merged, web: { ...later.web, first } } : merged;
}

/** The last parse of a streaming tool call's JSON: how long it was, when, and what it read as. */
const parsedArguments = new WeakMap<object, { length: number; at: number; arguments: unknown }>();
const REPARSE_BYTES = 2048;
const REPARSE_MS = 100;

/**
 * Tool calls still streaming get the arguments their JSON so far reads as, like omp's full snapshots. Parsing a
 * large argument (a whole file being written) costs milliseconds, so it is redone only once the JSON grew by
 * REPARSE_BYTES or REPARSE_MS passed; toolcall_end replaces the block with omp's final arguments.
 */
export function withStreamedArguments<T extends object>(message: T, now = Date.now()): T {
  const content = contentOf(message);
  if (!Array.isArray(content) || !content.some((block) => typeof block?.partialJson === "string")) return message;
  return {
    ...message,
    content: content.map((block: Block) => {
      const json = block?.partialJson;
      if (typeof json !== "string") return block;
      let parsed = parsedArguments.get(block);
      if (!parsed || (parsed.length !== json.length && (json.length - parsed.length >= REPARSE_BYTES || now - parsed.at >= REPARSE_MS))) {
        parsed = { length: json.length, at: now, arguments: parsePartialJson(json) };
        parsedArguments.set(block, parsed);
      }
      return { ...block, arguments: parsed.arguments };
    }),
  } as T;
}

/** What the transcript renders: streamed arguments parsed, and no holes left by block kinds omp sends only in full at message_end. */
export function displayMessage<T extends object>(message: T): T {
  const parsed = withStreamedArguments(message);
  const content = contentOf(parsed);
  if (!Array.isArray(content) || content.every((block) => block != null)) return parsed;
  return { ...parsed, content: content.filter((block) => block != null) } as T;
}

const INCOMPLETE = Symbol("incomplete");
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * A JSON prefix read as omp's `parseStreamingJson` does: open strings,
 * objects and arrays keep what arrived; a half-sent number, keyword or key is
 * left out. Anything unreadable is `{}`.
 */
export function parsePartialJson(text: string): unknown {
  // Only the start is trimmed: spaces at the end belong to an unfinished string.
  const source = text.trimStart();
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    // A prefix: read it below.
  }
  let i = 0;
  const skipWhitespace = () => {
    while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\n" || source[i] === "\r")) i += 1;
  };
  const string = (): { value: string; closed: boolean } => {
    i += 1;
    let value = "";
    let run = i;
    while (i < source.length) {
      const char = source[i];
      if (char === '"') {
        value += source.slice(run, i);
        i += 1;
        return { value, closed: true };
      }
      if (char !== "\\") {
        i += 1;
        continue;
      }
      value += source.slice(run, i);
      const kind = source[i + 1];
      const hex = source.slice(i + 2, i + 6);
      // An escape cut off by the stream stays as sent.
      if (kind === undefined || (kind === "u" && hex.length < 4)) {
        const rest = source.slice(i);
        i = source.length;
        return { value: value + rest, closed: false };
      }
      if (kind === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("bad escape");
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        if (!(kind in ESCAPES)) throw new SyntaxError("bad escape");
        value += ESCAPES[kind];
        i += 2;
      }
      run = i;
    }
    return { value: value + source.slice(run), closed: false };
  };
  const value = (): unknown => {
    skipWhitespace();
    if (i >= source.length) return INCOMPLETE;
    const char = source[i];
    if (char === "{") {
      i += 1;
      const out: Record<string, unknown> = {};
      for (;;) {
        skipWhitespace();
        if (i >= source.length) return out;
        if (source[i] === "}") {
          i += 1;
          return out;
        }
        if (source[i] === ",") {
          i += 1;
          continue;
        }
        if (source[i] !== '"') throw new SyntaxError("expected a key");
        const key = string();
        if (!key.closed) return out;
        skipWhitespace();
        if (i >= source.length) return out;
        if (source[i] !== ":") throw new SyntaxError("expected a colon");
        i += 1;
        const item = value();
        if (item === INCOMPLETE) return out;
        // JSON.parse keeps a "__proto__" key as an own property; plain assignment would call the prototype setter.
        Object.defineProperty(out, key.value, { value: item, enumerable: true, writable: true, configurable: true });
      }
    }
    if (char === "[") {
      i += 1;
      const out: unknown[] = [];
      for (;;) {
        skipWhitespace();
        if (i >= source.length) return out;
        if (source[i] === "]") {
          i += 1;
          return out;
        }
        if (source[i] === ",") {
          i += 1;
          continue;
        }
        const item = value();
        if (item === INCOMPLETE) return out;
        out.push(item);
      }
    }
    if (char === '"') return string().value;
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (source.startsWith(word, i)) {
        i += word.length;
        return literal;
      }
      if (word.startsWith(source.slice(i))) return INCOMPLETE;
    }
    const start = i;
    while (i < source.length && /[-+0-9.eE]/.test(source[i])) i += 1;
    const number = source.slice(start, i);
    if (NUMBER.test(number)) return Number(number);
    if (i >= source.length) return INCOMPLETE;
    throw new SyntaxError("unexpected token");
  };
  try {
    const parsed = value();
    return parsed === INCOMPLETE ? {} : parsed;
  } catch {
    return {};
  }
}
