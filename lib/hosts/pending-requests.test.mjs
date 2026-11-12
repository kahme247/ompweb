import assert from "node:assert/strict";
import test from "node:test";

const { PendingRequests } = await import("./pending-requests.ts");

const line = (frame) => JSON.stringify(frame);
const event = (event) => line({ t: "event", event });
const LIMIT = 1024 * 1024;

test("a dialog answered on stdin is no longer open", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ t: "ui_request", id: 1, method: "formDialog", args: [{}] }));
  assert.equal(pending.lines().length, 1);
  pending.noteStdin(line({ t: "ui_response", id: 1, value: { data: {} } }));
  assert.deepEqual(pending.lines(), []);
});

test("an open host_tool_call keeps its raw line until host_tool_cancel names it", () => {
  const pending = new PendingRequests(LIMIT);
  const call = line({ t: "host_tool_call", id: 1, toolCallId: "c1", toolName: "browser", arguments: {} });
  pending.noteStdout(event({ type: "message_update", text: "unrelated" }));
  pending.noteStdout(call);
  assert.deepEqual(pending.lines(), [call]);
  pending.noteStdout(line({ t: "host_tool_cancel", id: 9, targetId: 1 }));
  assert.deepEqual(pending.lines(), []);
});

test("host_tool_result on stdin closes the call; omp's ui_end closes a dialog numbered alike", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ t: "host_tool_call", id: 1, toolCallId: "c1", toolName: "browser", arguments: {} }));
  const confirm = line({ t: "ui_request", id: 1, method: "confirm", args: ["t", "m"] });
  pending.noteStdout(confirm);
  pending.noteStdin(`${line({ t: "host_tool_result", id: 1, result: { content: [] } })}\n`);
  assert.deepEqual(pending.lines(), [confirm]);
  pending.noteStdout(line({ t: "ui_end", id: 1 }));
  assert.deepEqual(pending.lines(), []);
});

test("hello and session frames name the child's session", () => {
  const A = "11111111-2222-4333-8444-00000000000a";
  const B = "11111111-2222-4333-8444-00000000000b";
  const pending = new PendingRequests(LIMIT, A);
  assert.equal(pending.sessionId, A);
  pending.noteStdout(line({ t: "res", id: 2, ok: true, data: { sessionId: B } }));
  assert.equal(pending.sessionId, A, "a command result does not name the session");
  pending.noteStdout(line({ t: "session", sessionId: B, sessionFile: "/s/b.jsonl", cwd: "/" }));
  assert.equal(pending.sessionId, B);
  assert.deepEqual(pending.lines(), [], "identity is not an open request");
  pending.noteStdout(line({ t: "hello", proto: 1, pid: 1, sessionId: "not-a-session", sessionFile: "", cwd: "/" }));
  assert.equal(pending.sessionId, null, "an id main could not adopt names no session");
});

test("a host_uri_request stays open until host_uri_result or omp's host_uri_cancel", () => {
  const pending = new PendingRequests(LIMIT);
  const read = line({ t: "host_uri_request", id: 1, operation: "read", url: "web://x" });
  pending.noteStdout(read);
  pending.noteStdout(line({ t: "host_uri_request", id: 2, operation: "write", url: "web://y", content: "c" }));
  assert.equal(pending.lines().length, 2);
  pending.noteStdout(line({ t: "host_uri_cancel", id: 3, targetId: 2 }));
  assert.deepEqual(pending.lines(), [read]);
  pending.noteStdin(line({ t: "host_uri_result", id: 1, content: "body" }));
  assert.deepEqual(pending.lines(), []);
});

test("past limitBytes lines() is null until the oversized request closes", () => {
  const pending = new PendingRequests(1000);
  pending.noteStdout(line({ t: "ui_request", id: 1, method: "input", args: ["t"] }));
  pending.noteStdout(line({ t: "ui_request", id: 2, method: "input", args: ["x".repeat(2000)] }));
  assert.equal(pending.lines(), null);
  pending.noteStdin(line({ t: "ui_response", id: 2, value: "v" }));
  assert.equal(pending.lines().length, 1);
});

test("a closed request frees its bytes: answered traffic past limitBytes leaves later requests adoptable", () => {
  const pending = new PendingRequests(1000);
  // Each request takes about a third of the cap; ten of them, each answered, total three caps.
  for (let i = 0; i < 10; i++) {
    pending.noteStdout(line({ t: "host_tool_call", id: i, toolName: "browser", arguments: { pad: "x".repeat(300) } }));
    pending.noteStdin(line({ t: "host_tool_result", id: i, result: { content: [] } }));
  }
  const open = line({ t: "host_tool_call", id: 99, toolName: "browser", arguments: { pad: "x".repeat(300) } });
  pending.noteStdout(open);
  assert.deepEqual(pending.lines(), [open]);
});

test("presentation frames and garbage lines are not kept", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ t: "notify", message: "hi" }));
  pending.noteStdout("not json host_tool_call");
  pending.noteStdout('{"t":"ui_request"');
  assert.deepEqual(pending.lines(), []);
});

test("turn events track activity, not a count of repeated starts and ends", () => {
  const pending = new PendingRequests(LIMIT);
  assert.equal(pending.activeTurn, false, "an idle child is not an executing turn");
  pending.noteStdout(event({ type: "agent_start" }));
  pending.noteStdout(event({ type: "agent_start" }));
  assert.equal(pending.activeTurn, true);
  pending.noteStdout(event({ type: "agent_end" }));
  assert.equal(pending.activeTurn, false, "one end clears repeated starts");
  pending.noteStdout(event({ type: "agent_end" }));
  assert.equal(pending.activeTurn, false);
  assert.deepEqual(pending.lines(), [], "turn events are not blocking requests");
});
