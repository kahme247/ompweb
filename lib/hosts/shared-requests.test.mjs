import assert from "node:assert/strict";
import test from "node:test";
import { SharedRequests } from "./shared-requests.ts";

function harness() {
  const delivered = [], writes = [], links = ["a", "b"], up = new Set(links);
  const shared = new SharedRequests({ members: () => links, isUp: id => up.has(id), deliver: (id, lines) => delivered.push({ id, frames: lines.map(JSON.parse) }), write: frame => writes.push(frame) });
  return { shared, delivered, writes, up };
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
  const h = harness(); for (const id of ["a", "b"]) h.shared.setTools(id, [{ name: "open_url" }], ["browser"]);
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
  h.shared.setTools("a", [], ["browser"]); assert.equal(h.delivered[0].id, "a");
  for (const tools of [[null], [{ name: "" }], [{ name: "x", parameters: [] }]]) assert.throws(() => h.shared.setTools("b", tools, []));
  assert.throws(() => h.shared.setTools("b", [], ["bad scheme"]));
});

test("a repeated completed native callback never executes a second time", () => {
  const h = harness(), call = { type: "host_tool_call", id: "once", toolName: "open_url" };
  h.shared.setTools("a", [{ name: "open_url" }], []);
  h.shared.note(call, [JSON.stringify(call)]);
  assert.equal(h.shared.answer("a", { type: "host_tool_result", id: "once" }), true);
  h.shared.note(call, [JSON.stringify(call)]);
  assert.equal(h.delivered.length, 1);
});
