import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { applyMessageDelta, displayMessage, isDeltaUpdate, mergeDeltaUpdates, parsePartialJson, withStreamedArguments } = await import("./message-delta.ts");

const fixture = readFileSync(new URL("../tests/fixtures/omp-delta-stream.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));

const without = (object, key) => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};

/** omp's `toDelta` (coding-agent/src/modes/rpc/rpc-session-events.ts, v18.13.2+), the projection `messageUpdates: "delta"` writes. */
function ompDelta(event) {
  const opened = (block) => {
    switch (block?.type) {
      case "text": return { ...block, text: "" };
      case "thinking": return { ...block, thinking: "" };
      case "toolCall": return { ...block, arguments: {} };
      default: return block;
    }
  };
  const { partial, ...rest } = event;
  switch (event.type) {
    case "done":
    case "error": return event;
    case "start": return { ...rest, message: partial };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta": return rest;
    case "text_end": {
      const block = partial.content[event.contentIndex];
      return block?.type === "text" ? { ...rest, block: without(block, "text") } : rest;
    }
    case "thinking_end": {
      const block = partial.content[event.contentIndex];
      return block?.type === "thinking" ? { ...rest, block: without(block, "thinking") } : rest;
    }
    case "image_end":
    case "toolcall_end": return rest;
    default: {
      const block = opened(partial.content[event.contentIndex]);
      return block === undefined ? rest : { ...rest, block };
    }
  }
}

const strip = (content) => content.map((block) => (block ? without(block, "partialJson") : block));

test("rebuilds every assistant message of a real omp delta stream exactly as message_end commits it", () => {
  const open = new Map();
  let rebuiltMessages = 0;
  let toolDeltas = 0;
  for (const frame of fixture) {
    if (frame.type === "message_start" && frame.message.role === "assistant") open.set(frame.messageId, frame.message);
    if (frame.type === "message_update") {
      assert.equal(isDeltaUpdate(frame), true);
      const next = applyMessageDelta(open.get(frame.messageId), frame.assistantMessageEvent);
      assert.ok(next, `${frame.assistantMessageEvent.type} applies`);
      open.set(frame.messageId, next);
      if (frame.assistantMessageEvent.type === "toolcall_delta") {
        toolDeltas += 1;
        const call = withStreamedArguments(next).content[frame.assistantMessageEvent.contentIndex];
        // The first fragment is `{"path": "note.txt`: omp's streaming parse already shows the open string.
        assert.equal(call.arguments.path, "note.txt");
      }
    }
    if (frame.type === "message_end" && open.has(frame.messageId)) {
      // message_end is authoritative and may add to the streamed blocks: omp lifts a tool call's `i` into `intent` there.
      const committed = frame.message.content.map((block) => without(block, "intent"));
      assert.deepEqual(open.get(frame.messageId).content, committed);
      open.delete(frame.messageId);
      rebuiltMessages += 1;
    }
  }
  assert.equal(rebuiltMessages, 2);
  assert.equal(toolDeltas, 5);
});

/** A provider that mutates one partial in place, as pi-ai's do; each event yields omp's full and delta frames. */
function scriptedStream() {
  const partial = { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", stopReason: "stop", timestamp: 1 };
  const frames = [];
  const push = (event) => {
    const snapshot = structuredClone(partial);
    frames.push({ full: snapshot, delta: ompDelta({ ...structuredClone(event), partial: snapshot }) });
  };
  push({ type: "start" });
  partial.content.push({ type: "thinking", thinking: "" });
  push({ type: "thinking_start", contentIndex: 0 });
  for (const delta of ["let me ", "think"]) {
    partial.content[0].thinking += delta;
    push({ type: "thinking_delta", contentIndex: 0, delta });
  }
  partial.content[0].thinkingSignature = "sig-think";
  push({ type: "thinking_end", contentIndex: 0, content: "let me think" });
  partial.content.push({ type: "text", text: "" });
  push({ type: "text_start", contentIndex: 1 });
  for (const delta of ["hel", "lo ", "there"]) {
    partial.content[1].text += delta;
    push({ type: "text_delta", contentIndex: 1, delta });
  }
  partial.content[1].textSignature = "sig-text";
  push({ type: "text_end", contentIndex: 1, content: "hello there" });
  const image = { type: "image", data: "aGk=", mimeType: "image/png" };
  partial.content.push(image);
  push({ type: "image_end", contentIndex: 2, content: image });
  partial.content.push({ type: "toolCall", id: "call-1", name: "edit", arguments: {} });
  push({ type: "toolcall_start", contentIndex: 3 });
  // Each fragment's arguments are what omp's parseStreamingJson makes of the JSON so far.
  for (const [delta, args] of [
    ['{"path":', {}],
    [' "src/a', { path: "src/a" }],
    ['.ts", "n": 1', { path: "src/a.ts", n: 1 }],
    ['2, "ok": tr', { path: "src/a.ts", n: 12 }],
    ['ue, "lines": ["x', { path: "src/a.ts", n: 12, ok: true, lines: ["x"] }],
    ['"]}', { path: "src/a.ts", n: 12, ok: true, lines: ["x"] }],
  ]) {
    partial.content[3].arguments = args;
    push({ type: "toolcall_delta", contentIndex: 3, delta });
  }
  const toolCall = { type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/a.ts", n: 12, ok: true, lines: ["x"] } };
  partial.content[3] = toolCall;
  push({ type: "toolcall_end", contentIndex: 3, toolCall });
  partial.content.push({ type: "text", text: "" });
  push({ type: "text_start", contentIndex: 4 });
  partial.content[4].text += "done";
  push({ type: "text_delta", contentIndex: 4, delta: "done" });
  push({ type: "text_end", contentIndex: 4, content: "done" });
  partial.stopReason = "toolUse";
  return { frames, final: structuredClone(partial) };
}

test("matches the partial omp sends in full mode, event by event: thinking, text, image, streamed tool arguments", () => {
  const { frames, final } = scriptedStream();
  let rebuilt = { role: "assistant", content: [] };
  for (const [step, { full, delta }] of frames.entries()) {
    rebuilt = applyMessageDelta(rebuilt, delta);
    assert.ok(rebuilt, delta.type);
    // A display frame per event, 100 ms apart: the arguments are parsed each time.
    assert.deepEqual(strip(withStreamedArguments(rebuilt, step * 100).content), full.content, `after ${delta.type}`);
  }
  assert.deepEqual(rebuilt.content, final.content);
});

test("done and error (abort) leave the streamed content as it was", () => {
  const { frames } = scriptedStream();
  let rebuilt = { role: "assistant", content: [] };
  for (const { delta } of frames.slice(0, 9)) rebuilt = applyMessageDelta(rebuilt, delta);
  const streamed = rebuilt;
  assert.equal(applyMessageDelta(streamed, { type: "error", reason: "aborted", error: { role: "assistant", content: [] } }), streamed);
  assert.equal(applyMessageDelta(streamed, { type: "done", reason: "stop", message: { role: "assistant", content: [] } }), streamed);
  assert.deepEqual(streamed.content.map((block) => block.type), ["thinking", "text"]);
  assert.equal(streamed.content[1].text, "hello there");
});

test("a re-start replaces the message with the one omp restarts from", () => {
  const restart = { role: "assistant", content: [{ type: "text", text: "retry" }], model: "m" };
  assert.equal(applyMessageDelta({ role: "assistant", content: [{ type: "text", text: "old" }] }, { type: "start", message: restart }), restart);
});

test("never mutates the message it was given", () => {
  const base = { role: "assistant", content: [{ type: "text", text: "a" }] };
  const frozen = structuredClone(base);
  const next = applyMessageDelta(base, { type: "text_delta", contentIndex: 0, delta: "b" });
  assert.deepEqual(base, frozen);
  assert.equal(next.content[0].text, "ab");
});

test("returns null for an update it cannot apply, so the caller recovers a snapshot instead of rendering a guess", () => {
  const base = { role: "assistant", content: [{ type: "text", text: "a" }] };
  assert.equal(applyMessageDelta(base, { type: "text_delta", contentIndex: 3, delta: "x" }), null, "no block there");
  assert.equal(applyMessageDelta(base, { type: "thinking_delta", contentIndex: 0, delta: "x" }), null, "wrong block kind");
  assert.equal(applyMessageDelta(base, { type: "text_start", contentIndex: 1 }), null, "an omp before 18.13.2 sends no block");
  assert.equal(applyMessageDelta(base, { type: "start" }), null, "a re-start without its message");
  assert.equal(applyMessageDelta(base, { type: "future_delta", contentIndex: 0 }), null, "an unknown kind");
  assert.equal(applyMessageDelta(undefined, { type: "text_delta", contentIndex: 0, delta: "x" }), null, "no base");
});

test("a block opened past a gap keeps its index; display drops the hole", () => {
  const next = applyMessageDelta({ role: "assistant", content: [{ type: "text", text: "a" }] }, { type: "text_start", contentIndex: 2, block: { type: "text", text: "" } });
  assert.equal(next.content.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(next)).content[1], null);
  assert.deepEqual(displayMessage(JSON.parse(JSON.stringify(next))).content, [{ type: "text", text: "a" }, { type: "text", text: "" }]);
});

test("parsePartialJson reads a JSON prefix as omp's parseStreamingJson does", () => {
  for (const [text, value] of [
    ["", {}],
    ["{", {}],
    ['{"pa', {}],
    ['{"path"', {}],
    ['{"path":', {}],
    ['{"path": "fi', { path: "fi" }],
    ['{"path":"a\\', { path: "a\\" }],
    ['{"path":"a\\u00', { path: "a\\u00" }],
    ['{"path":"a\\nb\\u0041', { path: "a\nbA" }],
    ['{"n": 12', { n: 12 }],
    ['{"n": 12,', { n: 12 }],
    ['{"b": tr', {}],
    ['{"b": true', { b: true }],
    ['{"a":[1,2', { a: [1, 2] }],
    ['{"a":[1,"x', { a: [1, "x"] }],
    ['{"a":{"b":"c', { a: { b: "c" } }],
    ['{"a":"x","b"', { a: "x" }],
    ['{"a":"x","b":nu', { a: "x" }],
    ['{"a": -', {}],
    ['{"a": 1.5e', {}],
    ["[1,2", [1, 2]],
    ['"str', "str"],
    ['{"a":"x"}', { a: "x" }],
    ['{"a": null, "b": false}', { a: null, b: false }],
  ]) assert.deepEqual(parsePartialJson(text), value, JSON.stringify(text));
});

test("parsePartialJson keeps spaces at the end of an unfinished string", () => {
  assert.deepEqual(parsePartialJson('{"path": "src/a '), { path: "src/a " });
  assert.deepEqual(parsePartialJson('  {"path": "src/a'), { path: "src/a" });
});

test("parsePartialJson keeps a streamed __proto__ key as an own property, as JSON.parse does", () => {
  const prefix = parsePartialJson('{"__proto__": {"x": 1}, "b": ');
  const complete = JSON.parse('{"__proto__": {"x": 1}, "b": 2}');
  assert.equal(Object.hasOwn(prefix, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(prefix), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prefix, "__proto__"), Object.getOwnPropertyDescriptor(complete, "__proto__"));
  assert.equal(Object.hasOwn(prefix, "x"), false);
});

test("isDeltaUpdate tells omp's delta frames from full snapshots", () => {
  assert.equal(isDeltaUpdate({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } }), true);
  assert.equal(isDeltaUpdate({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", partial: {} } }), false);
  assert.equal(isDeltaUpdate({ type: "message_update", message: { content: "v1" } }), false);
  assert.equal(isDeltaUpdate({ type: "message_start", message: { role: "assistant" } }), false);
});

test("mergeDeltaUpdates concatenates consecutive deltas of one block and nothing else", () => {
  const frame = (type, contentIndex, delta, sequence, messageId = "msg-1") => ({
    type: "message_update", messageId, message: { role: "assistant" },
    assistantMessageEvent: { type, contentIndex, delta }, web: { streamId: "s", sequence },
  });
  // A merged frame keeps its last piece's sequence and names its first piece's: a snapshot between them holds only part of it.
  const spanning = (merged, first) => ({ ...merged, web: { ...merged.web, first } });
  assert.deepEqual(mergeDeltaUpdates(frame("text_delta", 1, "ab", 4), frame("text_delta", 1, "cd", 5)), spanning(frame("text_delta", 1, "abcd", 5), 4));
  assert.deepEqual(mergeDeltaUpdates(frame("toolcall_delta", 2, '{"a', 4), frame("toolcall_delta", 2, '":1}', 6)), spanning(frame("toolcall_delta", 2, '{"a":1}', 6), 4));
  const twice = mergeDeltaUpdates(mergeDeltaUpdates(frame("text_delta", 1, "a", 3), frame("text_delta", 1, "b", 4)), frame("text_delta", 1, "c", 7));
  assert.deepEqual(twice, spanning(frame("text_delta", 1, "abc", 7), 3), "the first piece of a merged frame stays first");
  assert.equal(mergeDeltaUpdates(frame("text_delta", 1, "a", 4), frame("text_delta", 2, "b", 5)), null, "another block");
  assert.equal(mergeDeltaUpdates(frame("text_delta", 1, "a", 4), frame("thinking_delta", 1, "b", 5)), null, "another kind");
  assert.equal(mergeDeltaUpdates(frame("text_delta", 1, "a", 4), frame("text_delta", 1, "b", 5, "msg-2")), null, "another message");
  assert.equal(mergeDeltaUpdates(frame("text_start", 1, undefined, 4), frame("text_delta", 1, "b", 5)), null, "a start is not a delta");
});

test("an end event's content replaces whatever the block streamed, which heals a snapshot that was ahead", () => {
  const ahead = { role: "assistant", content: [{ type: "text", text: "Hello world world" }, { type: "thinking", thinking: "hmm hmm" }] };
  const text = applyMessageDelta(ahead, { type: "text_end", contentIndex: 0, content: "Hello world", block: { type: "text", textSignature: "s" } });
  assert.deepEqual(text.content[0], { type: "text", text: "Hello world", textSignature: "s" });
  const thinking = applyMessageDelta(text, { type: "thinking_end", contentIndex: 1, content: "hmm" });
  assert.deepEqual(thinking.content[1], { type: "thinking", thinking: "hmm" });
});

test("a contentIndex far past the message's blocks is refused instead of growing the message", () => {
  const base = { role: "assistant", content: [{ type: "text", text: "a" }] };
  const shell = { type: "text", text: "" };
  assert.ok(applyMessageDelta(base, { type: "text_start", contentIndex: 1 + 32, block: shell }));
  assert.equal(applyMessageDelta(base, { type: "text_start", contentIndex: 1 + 33, block: shell }), null);
  assert.equal(applyMessageDelta(base, { type: "text_start", contentIndex: 5e6, block: shell }), null);
});

test("streamed tool arguments are re-parsed only after 2 KB more JSON or 100 ms, and exactly at toolcall_end", () => {
  const call = (message) => message.content[0];
  let message = applyMessageDelta({ role: "assistant", content: [] }, { type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "c", name: "write", arguments: {} } });
  const grow = (delta) => { message = applyMessageDelta(message, { type: "toolcall_delta", contentIndex: 0, delta }); };
  grow('{"path": "a.ts", "content": "');
  assert.deepEqual(call(withStreamedArguments(message, 1000)).arguments, { path: "a.ts", content: "" });
  grow("x".repeat(100));
  assert.deepEqual(call(withStreamedArguments(message, 1050)).arguments, { path: "a.ts", content: "" }, "50 ms and 100 bytes later: not yet");
  assert.equal(call(withStreamedArguments(message, 1100)).arguments.content.length, 100, "100 ms later");
  grow("y".repeat(2048));
  assert.equal(call(withStreamedArguments(message, 1101)).arguments.content.length, 2148, "2 KB later");
  grow('"}');
  message = applyMessageDelta(message, { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "c", name: "write", arguments: { path: "a.ts", content: "done" } } });
  assert.deepEqual(call(withStreamedArguments(message, 1102)).arguments, { path: "a.ts", content: "done" });
});
