import assert from "node:assert/strict";
import test from "node:test";
import { SharedRequests } from "./shared-requests.ts";

/** `defer`: hold omp's reply to each write until `reply()`, as a slow child would. */
function harness({ defer = false } = {}) {
  const delivered = [], writes = [], links = ["a", "b"], up = new Set(links), replies = [];
  const shared = new SharedRequests({ members: () => links, isUp: id => up.has(id), deliver: (id, lines) => delivered.push({ id, frames: lines.map(JSON.parse) }),
    write: (frame, onReply) => { writes.push(frame); if (defer) replies.push(onReply); else onReply?.(); } });
  return { shared, delivered, writes, up, reply: () => { for (const onReply of replies.splice(0)) onReply?.(); } };
}

test("first dialog answer wins and native cancellation prevents a late answer", () => {
  const h = harness(); const q = { type: "extension_ui_request", id: "q", method: "ask" };
  h.shared.note(q, [JSON.stringify(q)]);
  assert.equal(h.shared.answer("b", { type: "extension_ui_response", id: "q" }), true);
  assert.equal(h.shared.answer("a", { type: "extension_ui_response", id: "q" }), false);
  assert.deepEqual(h.delivered.at(-1), { id: "a", frames: [{ type: "extension_ui_request", method: "cancel", targetId: "q" }] });
  const cancelled = { ...q, id: "cancelled" };
  h.shared.note(cancelled, [JSON.stringify(cancelled)]); h.shared.note({ type: "extension_ui_request", method: "cancel", targetId: "cancelled" }, []);
  assert.equal(h.shared.answer("a", { type: "extension_ui_response", id: "cancelled" }), false);
});

test("callback executes once on last eligible prompter and remains pinned after disconnect", () => {
  const h = harness(); for (const id of ["a", "b"]) h.shared.setTools(id, [{ name: "open_url" }], [{ scheme: "browser", writable: false }]);
  h.shared.prompt("b"); const call = { type: "host_tool_call", id: "t", toolName: "open_url" };
  h.shared.note(call, [JSON.stringify(call)]); assert.equal(h.delivered.at(-1).id, "b");
  h.up.delete("b"); h.shared.linkChanged(); h.shared.remove("b"); assert.equal(h.delivered.length, 1);
  assert.equal(h.shared.answer("a", { type: "host_tool_result", id: "t" }), false);
  assert.equal(h.shared.answer("b", { type: "host_tool_result", id: "t" }), true);
  assert.deepEqual(h.writes.filter(frame => frame.type === "set_host_tools").at(-1).tools.map(t => t.name), ["open_url"]);
  h.shared.remove("a"); assert.deepEqual(h.writes.filter(frame => frame.type === "set_host_tools").at(-1).tools, []);
});

test("unregistered callback waits, malformed registrations do not replace the union", () => {
  const h = harness(); const call = { type: "host_uri_request", id: "u", url: "browser:clip" };
  h.shared.note(call, [JSON.stringify(call)]); assert.deepEqual(h.delivered, []);
  h.shared.setTools("a", [], [{ scheme: "browser", writable: false }]); assert.equal(h.delivered[0].id, "a");
  for (const tools of [[null], [{ name: "" }], [{ name: "x", parameters: [] }]]) assert.throws(() => h.shared.setTools("b", tools, []));
  for (const schemes of [["browser"], [{ scheme: "bad scheme", writable: true }], [{ scheme: "browser" }]]) assert.throws(() => h.shared.setTools("b", [], schemes));
});

test("a repeated completed native callback never executes a second time", () => {
  const h = harness(), call = { type: "host_tool_call", id: "once", toolName: "open_url" };
  h.shared.setTools("a", [{ name: "open_url" }], []);
  h.shared.note(call, [JSON.stringify(call)]);
  assert.equal(h.shared.answer("a", { type: "host_tool_result", id: "once" }), true);
  h.shared.note(call, [JSON.stringify(call)]);
  assert.equal(h.delivered.length, 1);
});

test("writes reach only a writable registration and calls only a server advertising omp's definition", () => {
  const h = harness();
  h.shared.setTools("a", [{ name: "open_url", description: "advertised" }], [{ scheme: "browser", writable: false }]);
  h.shared.setTools("b", [{ name: "open_url", description: "other version" }], [{ scheme: "browser", writable: true }]);
  assert.deepEqual(h.writes.at(-1), { type: "set_host_uri_schemes", schemes: [{ scheme: "browser", writable: true }] });
  h.shared.prompt("a");
  const write = { type: "host_uri_request", id: "w", url: "browser:x", operation: "write" }, read = { ...write, id: "r", operation: "read" };
  h.shared.note(write, [JSON.stringify(write)]); h.shared.note(read, [JSON.stringify(read)]);
  assert.deepEqual(h.delivered.map(item => [item.id, item.frames[0].id]), [["b", "w"], ["a", "r"]]);
  h.shared.prompt("b");
  const call = { type: "host_tool_call", id: "t", toolName: "open_url" };
  h.shared.note(call, [JSON.stringify(call)]);
  assert.deepEqual(h.delivered.at(-1), { id: "a", frames: [call] }, "the last prompter's different schema does not qualify it");
});

test("a call that arrives while its registration is briefly missing dispatches once it is restored", () => {
  const h = harness(), tool = { name: "open_url", description: "Open" };
  h.shared.setTools("a", [tool], []);
  h.shared.setTools("a", [], []); // omp already advertised the tool when it made the call below.
  const call = { type: "host_tool_call", id: "late", toolName: "open_url" };
  h.shared.note(call, [JSON.stringify(call)]);
  assert.deepEqual(h.delivered, []);
  h.shared.setTools("a", [tool], []);
  assert.deepEqual(h.delivered, [{ id: "a", frames: [call] }]);
});

test("a pending call never dispatches to a different definition registered under its name first", () => {
  const h = harness(), original = { name: "open_url", description: "Open" }, other = { name: "open_url", description: "Other version" };
  h.shared.setTools("a", [original], []);
  h.shared.setTools("a", [], []);
  const call = { type: "host_tool_call", id: "late", toolName: "open_url" };
  h.shared.note(call, [JSON.stringify(call)]);
  h.shared.setTools("b", [other], []);
  assert.deepEqual(h.delivered, [], "the other version is not what omp was advertised");
  h.shared.setTools("a", [original], []);
  assert.deepEqual(h.delivered, [{ id: "a", frames: [call] }]);
});

test("a call omp made before it read a replacement definition keeps the old one, even if the new one registered first", () => {
  const h = harness({ defer: true }), original = { name: "open_url", description: "Open" }, other = { name: "open_url", description: "Other version" };
  h.shared.setTools("a", [original], []); h.reply();
  h.shared.setTools("a", [], []); h.shared.setTools("b", [other], []); // omp has not answered either union yet
  const early = { type: "host_tool_call", id: "early", toolName: "open_url" };
  h.shared.note(early, [JSON.stringify(early)]);
  assert.deepEqual(h.delivered, [], "an unconfirmed replacement never takes a call made under the old definition");
  h.reply();
  const late = { type: "host_tool_call", id: "late", toolName: "open_url" };
  h.shared.note(late, [JSON.stringify(late)]);
  assert.deepEqual(h.delivered, [{ id: "b", frames: [late] }], "after omp's reply, calls use the new definition");
  h.shared.setTools("a", [original], []); h.reply();
  assert.deepEqual(h.delivered.at(-1), { id: "a", frames: [early] }, "the early call waits for its own definition");
});
