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
export type StreamedMessage = { role?: unknown; content?: unknown; [key: string]: unknown };
type DeltaEvent = {
  type?: unknown;
  contentIndex?: unknown;
  delta?: unknown;
  content?: unknown;
  block?: unknown;
  toolCall?: unknown;
  message?: unknown;
};

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
export function applyMessageDelta<T extends StreamedMessage>(message: T | undefined, update: DeltaEvent): T | null {
  if (update.type === "start") return isRecord(update.message) && Array.isArray(update.message.content) ? update.message as T : null;
  if (!message || !Array.isArray(message.content)) return null;
  if (update.type === "done" || update.type === "error") return message;
  const index = update.contentIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  const block = message.content[index] as Block | null | undefined;
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
      next = { ...block, partialJson: (typeof block.partialJson === "string" ? block.partialJson : "") + update.delta };
      break;
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
  const content = message.content.slice();
  content[index] = next;
  return { ...message, content };
}

/** One frame for two consecutive deltas of the same block, or null when they cannot merge. */
export function mergeDeltaUpdates<T extends { messageId?: unknown; assistantMessageEvent?: unknown }>(earlier: T, later: T): T | null {
  const a = earlier.assistantMessageEvent;
  const b = later.assistantMessageEvent;
  if (!isRecord(a) || !isRecord(b) || earlier.messageId !== later.messageId) return null;
  if (a.type !== b.type || typeof a.type !== "string" || !DELTA_KINDS[a.type] || a.contentIndex !== b.contentIndex) return null;
  if (typeof a.delta !== "string" || typeof b.delta !== "string") return null;
  return { ...later, assistantMessageEvent: { ...b, delta: a.delta + b.delta } };
}

const parsedCalls = new WeakMap<object, Block>();

/** Tool calls still streaming get the arguments their JSON so far reads as, like omp's full snapshots. */
export function withStreamedArguments<T extends StreamedMessage>(message: T): T {
  const content = message.content;
  if (!Array.isArray(content) || !content.some((block) => typeof block?.partialJson === "string")) return message;
  return {
    ...message,
    content: content.map((block: Block) => {
      if (typeof block?.partialJson !== "string") return block;
      let parsed = parsedCalls.get(block);
      if (!parsed) {
        parsed = { ...block, arguments: parsePartialJson(block.partialJson) };
        parsedCalls.set(block, parsed);
      }
      return parsed;
    }),
  };
}

/** What the transcript renders: streamed arguments parsed, and no holes left by block kinds omp sends only in full at message_end. */
export function displayMessage<T extends StreamedMessage>(message: T): T {
  const parsed = withStreamedArguments(message);
  const content = parsed.content;
  if (!Array.isArray(content) || content.every((block) => block != null)) return parsed;
  return { ...parsed, content: content.filter((block) => block != null) };
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
  const source = text.trim();
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
        out[key.value] = item;
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
