import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

const { PendingRequests } = await import("./pending-requests.ts");

const line = (frame) => JSON.stringify(frame);
const LIMIT = 1024 * 1024;

test("an ask request answered on stdin is no longer open", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ type: "extension_ui_request", id: "q1", method: "ask", questions: [] }));
  assert.equal(pending.lines().length, 1);
  pending.noteStdin(line({ type: "extension_ui_response", id: "q1", answers: [] }));
  assert.deepEqual(pending.lines(), []);
});

test("an open host_tool_call keeps its raw line until host_tool_cancel names it", () => {
  const pending = new PendingRequests(LIMIT);
  const call = line({ type: "host_tool_call", id: "t1", toolCallId: "c1", toolName: "browser", arguments: {} });
  pending.noteStdout(line({ type: "message_update", text: "unrelated" }));
  pending.noteStdout(call);
  assert.deepEqual(pending.lines(), [call]);
  pending.noteStdout(line({ type: "host_tool_cancel", id: "x9", targetId: "t1" }));
  assert.deepEqual(pending.lines(), []);
});

test("host_tool_result on stdin closes the call; omp's UI cancel closes a dialog", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ type: "host_tool_call", id: "t1", toolCallId: "c1", toolName: "browser", arguments: {} }));
  const confirm = line({ type: "extension_ui_request", id: "d1", method: "confirm", title: "t", message: "m" });
  pending.noteStdout(confirm);
  pending.noteStdin(`${line({ type: "host_tool_result", id: "t1", result: { content: [] } })}\n`);
  assert.deepEqual(pending.lines(), [confirm]);
  pending.noteStdout(line({ type: "extension_ui_request", id: "x1", method: "cancel", targetId: "d1" }));
  assert.deepEqual(pending.lines(), []);
});

/** `frame` as omp chunks it: RpcFrameDecoder only accepts chunked frames of at least 1 MiB in 256 KiB pieces. */
function chunked(frame, chunkId) {
  const bytes = Buffer.from(line(frame));
  const size = 256 * 1024;
  const count = Math.ceil(bytes.byteLength / size);
  return Array.from({ length: count }, (_, index) => line({
    type: "rpc_chunk", chunkId, index, count, byteLength: bytes.byteLength,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
}

/** A blocking request omp would chunk (five lines). */
function chunkedRequest(id) {
  return chunked({ type: "extension_ui_request", id, method: "editor", title: "t", prefill: randomBytes(600_000).toString("hex") }, `k-${id}`);
}

test("the session a successful get_state reports, plain or chunked, is the child's session from then on", () => {
  const A = "11111111-2222-4333-8444-00000000000a";
  const B = "11111111-2222-4333-8444-00000000000b";
  const pending = new PendingRequests(LIMIT, A);
  assert.equal(pending.sessionId, A);
  pending.noteStdout(line({ type: "response", id: "1", command: "get_state", success: false, error: "busy" }));
  pending.noteStdout(line({ type: "response", id: "2", command: "get_session_stats", success: true, data: { sessionId: B } }));
  assert.equal(pending.sessionId, A, "only a successful get_state names the session");
  for (const chunk of chunked({ type: "response", id: "3", command: "get_state", success: true, data: { sessionId: B, pad: randomBytes(600_000).toString("hex") } }, "s3")) {
    pending.noteStdout(chunk);
  }
  assert.equal(pending.sessionId, B);
  assert.deepEqual(pending.lines(), [], "a response is not an open request");
  pending.noteStdout(line({ type: "response", id: "4", command: "get_state", success: true, data: { sessionId: "not-a-session" } }));
  assert.equal(pending.sessionId, null, "an id main could not adopt names no session");
});

test("a chunked request keeps all of its rpc_chunk lines in order", () => {
  const chunks = chunkedRequest("big");
  const pending = new PendingRequests(4 * LIMIT);
  for (const chunk of chunks) pending.noteStdout(chunk);
  assert.deepEqual(pending.lines(), chunks);
  pending.noteStdin(line({ type: "extension_ui_response", id: "big", cancelled: true }));
  assert.deepEqual(pending.lines(), []);
});

test("a chunked request over the cap makes lines() null until it closes", () => {
  const pending = new PendingRequests(LIMIT);
  for (const chunk of chunkedRequest("big")) pending.noteStdout(chunk);
  assert.equal(pending.lines(), null);
  pending.noteStdin(line({ type: "extension_ui_response", id: "big", cancelled: true }));
  assert.deepEqual(pending.lines(), []);
});

test("a host_uri_request stays open until host_uri_result or omp's host_uri_cancel", () => {
  const pending = new PendingRequests(LIMIT);
  const read = line({ type: "host_uri_request", id: "u1", operation: "read", url: "web://x" });
  pending.noteStdout(read);
  pending.noteStdout(line({ type: "host_uri_request", id: "u2", operation: "write", url: "web://y", content: "c" }));
  assert.equal(pending.lines().length, 2);
  pending.noteStdout(line({ type: "host_uri_cancel", id: "x2", targetId: "u2" }));
  assert.deepEqual(pending.lines(), [read]);
  pending.noteStdin(line({ type: "host_uri_result", id: "u1", content: "body" }));
  assert.deepEqual(pending.lines(), []);
});

test("past limitBytes lines() is null until the oversized request closes", () => {
  const pending = new PendingRequests(1000);
  pending.noteStdout(line({ type: "extension_ui_request", id: "small", method: "input", title: "t" }));
  pending.noteStdout(line({ type: "extension_ui_request", id: "big", method: "input", title: "x".repeat(2000) }));
  assert.equal(pending.lines(), null);
  pending.noteStdin(line({ type: "extension_ui_response", id: "big", value: "v" }));
  assert.equal(pending.lines().length, 1);
});

test("a closed request frees its bytes: answered traffic past limitBytes leaves later requests adoptable", () => {
  const pending = new PendingRequests(1000);
  // Each request takes about a third of the cap; ten of them, each answered, total three caps.
  for (let i = 0; i < 10; i++) {
    pending.noteStdout(line({ type: "host_tool_call", id: `t${i}`, toolName: "browser", arguments: { pad: "x".repeat(300) } }));
    pending.noteStdin(line({ type: "host_tool_result", id: `t${i}`, result: { content: [] } }));
  }
  const open = line({ type: "host_tool_call", id: "last", toolName: "browser", arguments: { pad: "x".repeat(300) } });
  pending.noteStdout(open);
  assert.deepEqual(pending.lines(), [open]);
});

test("non-blocking UI requests and garbage lines are not kept", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" }));
  pending.noteStdout("not json host_tool_call");
  pending.noteStdout(line({ type: "rpc_chunk", chunkId: "bad" }));
  assert.deepEqual(pending.lines(), []);
});

test("plain turn events track activity, not a count of repeated starts and ends", () => {
  const pending = new PendingRequests(LIMIT);
  assert.equal(pending.activeTurn, false, "an idle child is not an executing turn");
  pending.noteStdout(line({ type: "agent_start" }));
  pending.noteStdout(line({ type: "agent_start" }));
  assert.equal(pending.activeTurn, true);
  pending.noteStdout(line({ type: "agent_end" }));
  assert.equal(pending.activeTurn, false, "one end clears repeated starts");
  pending.noteStdout(line({ type: "agent_end" }));
  assert.equal(pending.activeTurn, false);
  assert.deepEqual(pending.lines(), [], "turn events are not blocking requests");
});

test("chunked turn events change activity only after the whole real RPC frame arrives", () => {
  const pending = new PendingRequests(LIMIT);
  for (const [type, want] of [["agent_start", true], ["agent_end", false]]) {
    const chunks = chunked({ type, pad: "x".repeat(LIMIT) }, type);
    for (const chunk of chunks.slice(0, -1)) pending.noteStdout(chunk);
    assert.equal(pending.activeTurn, !want, "a partial frame cannot change activity");
    pending.noteStdout(chunks.at(-1));
    assert.equal(pending.activeTurn, want, "a frame over the pending-request cap still updates activity");
    assert.deepEqual(pending.lines(), [], "turn output does not consume the blocking-request budget");
  }
});

test("successful get_state reconciles activity while unrelated or invalid state cannot change it", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ type: "agent_start" }));
  for (const frame of [
    { type: "response", command: "get_state", success: false, data: { isStreaming: false } },
    { type: "response", command: "get_session_stats", success: true, data: { isStreaming: false } },
    { type: "response", command: "get_state", success: true, data: { isStreaming: "false" } },
    { type: "response", command: "get_state", success: true, data: {} },
  ]) {
    pending.noteStdout(line(frame));
    assert.equal(pending.activeTurn, true);
  }
  pending.noteStdout(line({ type: "response", command: "get_state", success: true, data: { isStreaming: false } }));
  assert.equal(pending.activeTurn, false);
  for (const chunk of chunked({
    type: "response", command: "get_state", success: true, data: { isStreaming: true, pad: "x".repeat(LIMIT) },
  }, "streaming-state")) pending.noteStdout(chunk);
  assert.equal(pending.activeTurn, true);
  pending.noteStdout(line({ type: "agent_end" }));
  assert.equal(pending.activeTurn, false, "subsequent live events supersede a state snapshot");
});
