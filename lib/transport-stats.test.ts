import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticStats, percentile, summarizeDurations } from "./transport-stats";

test("percentile is nearest rank", () => {
  assert.equal(percentile([10, 20, 30, 40, 100], 50), 30);
  assert.equal(percentile([100, 10, 40, 20, 30], 95), 100);
  assert.equal(percentile([], 50), null);
});

test("p99.9 is reported only from 1000 values, where it is no longer just the max", () => {
  const few = summarizeDurations(Array.from({ length: 999 }, (_, i) => i));
  assert.equal(few.p999, null);
  assert.equal(few.max, 998);
  const boundary = summarizeDurations(Array.from({ length: 1000 }, (_, i) => i + 1));
  assert.equal(boundary.p999, 999);
  // 2000 values: rank ceil(0.999 * 2000) = 1998, the 1998th smallest.
  const many = summarizeDurations(Array.from({ length: 2000 }, (_, i) => 2000 - i));
  assert.equal(many.p999, 1998);
  assert.equal(many.max, 2000);
  assert.equal(many.mean, 1000.5);
  assert.deepEqual(summarizeDurations([]), { count: 0, mean: null, p50: null, p95: null, p999: null, max: null });
});

test("diagnostic rows split by transport; omp delivery counts get_state only", () => {
  // Server clock = tab clock + 1000. Sent 0, received (server) 1010, replied 1030, got 50.
  const action = { metric: "action", outcome: "ok", status: 200, sentAt: 0, gotAt: 50, recvAt: 1010, repliedAt: 1030, offset: 1000 };
  const rows = diagnosticStats([
    { ...action, transport: "ws", type: "get_state" },
    { ...action, transport: "ws", type: "prompt", repliedAt: 1040, gotAt: 60 },
    { metric: "event", transport: "sse", at: 2000, gotAt: 1005, offset: 1000 },
    { metric: "reconnect", transport: "ws", dropAt: 0, firstFrameAt: 5 },
  ]);
  const value = (transport: string, metric: string) => rows.find((r) => r.transport === transport && r.metric === metric);
  assert.deepEqual(rows.map((r) => `${r.transport} ${r.metric} ${r.count}`), [
    "sse eventMs 1",
    "ws upMs 2", "ws transportMs 2", "ws ompMs 1", "ws serverMs 2", "ws totalMs 2",
  ]);
  assert.equal(value("ws", "upMs")?.p50, 10);
  assert.equal(value("ws", "transportMs")?.max, 30);
  assert.equal(value("ws", "ompMs")?.max, 20);
  assert.equal(value("ws", "serverMs")?.max, 30);
  assert.equal(value("sse", "eventMs")?.p50, 5);
});

test("diagnostics exclude unconfirmed deliveries and failed commands from successful-command latencies", () => {
  const base = { metric: "action", transport: "ws", type: "get_state", sentAt: 0, gotAt: 15_000, recvAt: null, repliedAt: null };
  const failed = [
    { ...base, outcome: "unavailable", status: 503 },
    { ...base, outcome: "lost", status: 503 },
    { ...base, transport: "sse", outcome: "error", status: 0 },
    { ...base, transport: "sse", outcome: "error", status: 502 },
    { ...base, outcome: "error", status: 503, recvAt: 1, repliedAt: 2 },
    { ...base, outcome: "ok", status: 200 },
  ];
  assert.deepEqual(diagnosticStats(failed), []);
  const rows = diagnosticStats([...failed, { ...base, outcome: "ok", status: 200, gotAt: 10, recvAt: 2, repliedAt: 5 }]);
  assert.deepEqual(rows.map((row) => [row.metric, row.count, row.mean]), [
    ["transportMs", 1, 7], ["ompMs", 1, 3], ["serverMs", 1, 3], ["totalMs", 1, 10],
  ]);
});

test("commands the web app may answer without omp count as transport only, never as omp time", () => {
  const ok = { metric: "action", transport: "ws", outcome: "ok", sentAt: 0, gotAt: 10, recvAt: 2, repliedAt: 3 };
  const rows = diagnosticStats([{ ...ok, type: "predict_word" }, { ...ok, type: "get_btw_history" }]);
  assert.deepEqual(rows.map((row) => [row.metric, row.count]), [["transportMs", 2]]);
});

test("a backward clock step drops the command's round trip and transport share", () => {
  const rows = diagnosticStats([{ metric: "action", transport: "ws", type: "prompt", outcome: "ok", sentAt: 100, gotAt: 40, recvAt: 2, repliedAt: 5 }]);
  assert.deepEqual(rows.map((row) => row.metric), ["serverMs"]);
});

test("commands forwarded to omp without awaiting its reply count as transport only", () => {
  const ok = { metric: "action", transport: "sse", outcome: "ok", sentAt: 0, gotAt: 10, recvAt: 2, repliedAt: 3 };
  const rows = diagnosticStats(["host_tool_result", "host_uri_result", "extension_ui_response"].map((type) => ({ ...ok, type })));
  assert.deepEqual(rows.map((row) => [row.metric, row.count]), [["transportMs", 3]]);
});
