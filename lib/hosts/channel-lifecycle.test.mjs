import assert from "node:assert/strict";
import test from "node:test";
import { ChannelLifecycle } from "./channel-lifecycle.ts";

function harness(abandonedMs = 120000) {
  let now = 0, id = 0;
  const timers = new Map(), stops = [], runs = [];
  const lifecycle = new ChannelLifecycle({ abandonedMs, idleMs: 600000, graceMs: 120000, now: () => now,
    setTimeout(fn, delay) { timers.set(++id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); }, stop: reason => stops.push(reason), onRunning: on => runs.push(on) });
  const tick = delta => { const end = now + delta; for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); } now = end; };
  return { lifecycle, tick, stops, runs };
}

test("abandonment begins after the last disconnected interest expires", () => {
  const h = harness(); const l = h.lifecycle;
  l.setStartup(false); l.setInterest("a", true); l.setInterest("b", true); l.linkDown("a");
  h.tick(240000); assert.deepEqual(h.stops, []);
  l.linkDown("b"); h.tick(120000); h.tick(119999); assert.deepEqual(h.stops, []);
  h.tick(1); assert.deepEqual(h.stops, ["abandoned"]); l.dispose();
});

test("reconnect cancels old grace and protected work resets both clocks", () => {
  for (const protection of ["run", "settlement", "dialog", "preparing", "command", "startup"]) {
    const h = harness(); const l = h.lifecycle; l.setStartup(false); l.setInterest("a", true);
    l.linkDown("a"); h.tick(100000); l.setInterest("a", true); h.tick(20000);
    if (protection === "run" || protection === "settlement") l.noteStdout({ type: "agent_start" });
    if (protection === "settlement") l.noteStdout({ type: "agent_end", isTerminal: true });
    if (protection === "dialog") l.noteStdout({ type: "extension_ui_request", id: "q", method: "ask" });
    if (protection === "preparing") l.setPreparing("a", true);
    if (protection === "command") l.noteStdin({ type: "prompt", id: "w1" });
    if (protection === "startup") l.setStartup(true);
    h.tick(900000); assert.deepEqual(h.stops, [], protection);
    l.noteStdout({ type: "agent_end", isTerminal: true }); l.noteStdout({ type: "session_settled" });
    l.noteStdin({ type: "extension_ui_response", id: "q" }); l.setPreparing("a", false);
    l.noteStdout({ type: "response", id: "w1" }); l.setStartup(false);
    h.tick(599999); assert.deepEqual(h.stops, [], protection); h.tick(1);
    assert.deepEqual(h.stops, ["idle"], protection); l.dispose();
  }
});

test("zero disables abandonment but retains idle and running transition recording", () => {
  const h = harness(0); h.lifecycle.setStartup(false);
  h.lifecycle.noteStdout({ type: "agent_start" }); h.lifecycle.noteStdout({ type: "agent_end", isTerminal: true });
  assert.deepEqual(h.runs, [true]); h.lifecycle.noteStdout({ type: "session_settled" }); assert.deepEqual(h.runs, [true, false]);
  h.tick(599999); assert.deepEqual(h.stops, []); h.tick(1); assert.deepEqual(h.stops, ["idle"]); h.lifecycle.dispose();
});
