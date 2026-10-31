import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatReport, percentile, summarize, type SummaryRow } from "./transport-metrics";

test("percentile is nearest rank", () => {
  assert.equal(percentile([10, 20, 30, 40, 100], 50), 30);
  assert.equal(percentile([100, 10, 40, 20, 30], 95), 100);
  assert.equal(percentile([], 50), null);
});

const base = { clientId: "c1", effectiveType: "4g", visible: true, ua: "UA/1" };
const at = (serverAt: number) => ({ ...base, serverAt });
const fixture: Record<string, unknown>[] = [
  // sse: total 100, server 30 → transport 70; up = 1020 − (1000 + 10) = 10
  { ...at(1_000), metric: "action", transport: "sse", type: "prompt", req: "r1", outcome: "ok", attempts: 1, sentAt: 1000, recvAt: 1020, repliedAt: 1050, gotAt: 1100, offset: 10 },
  { ...at(1_000), metric: "action", transport: "sse", type: "get_state", req: "r2", outcome: "ok", attempts: 2, deduped: true, sentAt: 2000, recvAt: 2020, repliedAt: 2030, gotAt: 2300, offset: 0 },
  { ...at(1_000), metric: "action", transport: "websocket", type: "prompt", req: "r3", outcome: "ok", attempts: 1, sentAt: 1000, recvAt: 1005, repliedAt: 1015, gotAt: 1040, offset: 0 },
  // never answered: no gotAt → no totalMs, still counted in outcomes
  { ...at(1_000), metric: "action", transport: "websocket", type: "prompt", req: "r4", outcome: "lost", attempts: 1, sentAt: 5000 },
  // abort behind an upload vs alone
  { ...at(1_000), metric: "action", transport: "websocket", type: "abort", req: "r5", outcome: "ok", behindBytes: 8_000_000, sentAt: 0, gotAt: 900, offset: 0 },
  { ...at(1_000), metric: "action", transport: "websocket", type: "abort_bash", req: "r6", outcome: "ok", behindBytes: 0, sentAt: 0, gotAt: 50, offset: 0 },
  // event ms = gotAt + offset − at = 500 + 20 − 400
  { ...at(1_000), metric: "event", transport: "websocket", conn: "session", channel: "session:s1", at: 400, gotAt: 500, offset: 20 },
  // reconnect: ms = 900 − 200, fromDropMs = 900 − 100
  { ...at(1_000), metric: "reconnect", transport: "websocket", conn: "general", trigger: "online", dropAt: 100, startAt: 200, firstFrameAt: 900, batch: 3 },
  { ...at(1_000), metric: "reconnect", transport: "websocket", conn: "general", trigger: "online", dropAt: 100, startAt: 200, firstFrameAt: 500, batch: 1 },
  // r2 was answered later (its action is above); r9 never was
  { ...at(1_000), metric: "hang", transport: "sse", req: "r2", type: "get_state", via: "http", bytes: 10, waitedMs: 10_000 },
  { ...at(1_000), metric: "hang", transport: "websocket", req: "r9", type: "prompt", via: "ws", bytes: 10, waitedMs: 10_000 },
  // outside the window / another client
  { ...at(9_000), metric: "event", transport: "websocket", conn: "general", channel: "running", at: 0, gotAt: 7, offset: 0 },
  { ...at(1_000), metric: "event", transport: "websocket", conn: "general", channel: "running", at: 0, gotAt: 3, offset: 0, clientId: "c2", effectiveType: null },
];

const row = (rows: SummaryRow[], section: string, transport: string, key: string) => rows.find((r) => r.section === section && r.transport === transport && r.key === key);

test("summarize derives the action latencies per transport and type", () => {
  const rows = summarize(fixture, {});
  assert.deepEqual(row(rows, "action totalMs", "sse", "all"), { section: "action totalMs", transport: "sse", key: "all", count: 2, p50: 100, p95: 300, max: 300 });
  assert.equal(row(rows, "action totalMs", "sse", "prompt")?.max, 100);
  assert.equal(row(rows, "action totalMs", "websocket", "prompt")?.p50, 40);
  // total − (repliedAt − recvAt)
  assert.equal(row(rows, "action transportMs", "sse", "prompt")?.p50, 70);
  assert.equal(row(rows, "action transportMs", "sse", "get_state")?.p50, 290);
  // recvAt − (sentAt + offset)
  assert.equal(row(rows, "action upMs", "sse", "prompt")?.p50, 10);
});

test("summarize derives event and reconnect times", () => {
  const rows = summarize(fixture, { since: 0, until: 5_000 });
  assert.equal(row(rows, "event ms", "websocket", "session session:s1")?.p50, 120);
  const reconnect = row(rows, "reconnect ms", "websocket", "online/visible")!;
  assert.equal(reconnect.count, 2);
  assert.equal(reconnect.max, 700);
  assert.equal(reconnect.meanBatch, 2);
  assert.equal(row(rows, "reconnect fromDropMs", "websocket", "online/visible")?.max, 800);
});

test("summarize counts hangs, answered-later hangs, resends, deduped and outcomes", () => {
  const rows = summarize(fixture, {});
  assert.equal(row(rows, "hang", "sse", "total")?.count, 1);
  assert.equal(row(rows, "hang", "sse", "answered later")?.count, 1);
  assert.equal(row(rows, "hang", "websocket", "total")?.count, 1);
  assert.equal(row(rows, "hang", "websocket", "answered later"), undefined);
  assert.equal(row(rows, "resend", "sse", "attempts>1")?.count, 1);
  assert.equal(row(rows, "deduped", "sse", "deduped")?.count, 1);
  assert.equal(row(rows, "outcome", "websocket", "lost")?.count, 1);
  assert.equal(row(rows, "outcome", "websocket", "ok")?.count, 3);
});

test("a hang whose command was never answered is not counted as answered later", () => {
  const rows = summarize(
    [
      { ...at(1), metric: "hang", transport: "websocket", req: "x", type: "prompt", via: "ws", bytes: 1, waitedMs: 1 },
      { ...at(1), metric: "action", transport: "websocket", req: "x", type: "prompt", outcome: "lost" },
    ],
    {},
  );
  assert.equal(row(rows, "hang", "websocket", "total")?.count, 1);
  assert.equal(row(rows, "hang", "websocket", "answered later"), undefined);
});

test("an abort behind an upload lands in its own row", () => {
  const rows = summarize(fixture, {});
  assert.equal(row(rows, "abort behind upload", "websocket", "yes")?.max, 900);
  assert.equal(row(rows, "abort behind upload", "websocket", "no")?.max, 50);
  for (const behindBytes of [1_000, 65_535, 65_536]) {
    const boundary = summarize([{ ...at(1), metric: "action", transport: "sse", type: "abort", req: "a", outcome: "ok", behindBytes, sentAt: 0, gotAt: 70, offset: 0 }], {});
    assert.equal(row(boundary, "abort behind upload", "sse", behindBytes < 65_536 ? "no" : "yes")?.max, 70, `blocking starts at 64 KiB, not at ${behindBytes} bytes`);
  }
});

test("a hang stays answered later when its reply is outside the filter, and a hang without req never is", () => {
  const rows = summarize(
    [
      { ...at(5_000), metric: "hang", transport: "sse", req: "x", type: "prompt", via: "http", bytes: 1, waitedMs: 1 },
      { ...at(9_000), metric: "action", transport: "sse", req: "x", type: "prompt", outcome: "ok" },
      { ...at(5_000), metric: "hang", transport: "websocket", type: "prompt", via: "ws", bytes: 1, waitedMs: 1 },
      { ...at(5_000), metric: "action", transport: "websocket", type: "prompt", outcome: "ok" },
    ],
    { until: 6_000 },
  );
  assert.equal(row(rows, "hang", "sse", "answered later")?.count, 1);
  assert.equal(row(rows, "hang", "websocket", "total")?.count, 1);
  assert.equal(row(rows, "hang", "websocket", "answered later"), undefined);
});

test("the report keeps one section order whatever the order of the samples", () => {
  const forward = summarize(fixture, {});
  assert.deepEqual(summarize([...fixture].reverse(), {}), forward);
  assert.deepEqual(
    [...new Set(forward.filter((r) => r.transport === "websocket").map((r) => r.section))],
    ["action totalMs", "action transportMs", "action upMs", "abort behind upload", "event ms", "reconnect ms", "reconnect fromDropMs", "hang", "outcome"],
  );
});

test("isolation, sockets, pool size and rebalance rows per transport", () => {
  const transports = ["sse", "ws-client", "ws-session", "ws-pool"];
  const samples = transports.flatMap((transport, index) => {
    const tagged = (fields: Record<string, unknown>) => ({ ...at(1_000), transport, pool: transport === "ws-pool" ? 2 : null, sockets: index + 1, ...fields });
    // event ms = gotAt + offset − at
    const event = (gotAt: number, behindSameBytes: number | null, behindOtherBytes: number | null) =>
      tagged({ metric: "event", conn: "session", channel: "session", at: 0, gotAt, offset: 0, behindSameBytes, behindOtherBytes });
    // transportMs = (gotAt − sentAt) − (repliedAt − recvAt): the server's time is left out of the isolation rows
    const action = (transportMs: number, serverMs: number, behind: Record<string, unknown>) =>
      tagged({ metric: "action", type: "prompt", outcome: "ok", sentAt: 0, recvAt: 5, repliedAt: 5 + serverMs, gotAt: transportMs + serverMs, ...behind });
    return [
      event(10, 0, 70_000),
      event(4, 70_000, 0),
      event(1, 0, 0),
      // below LARGE_FRAME_BYTES: not blocking
      event(2, 1_000, 0),
      // no clock: unknown
      event(6, null, null),
      action(300, 5_000, { behindSameBytes: 0, behindOtherBytes: 70_000, replyBehindOtherBytes: 0 }),
      action(300, 20, { behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: 80_000 }),
      action(200, 9_000, { behindSameBytes: 70_000, behindOtherBytes: 0, replyBehindOtherBytes: 0 }),
      // a lone small command in flight ahead of it (an HTTP POST, an unacked frame) is below the floor
      action(100, 40, { behindSameBytes: 5, behindOtherBytes: 50, replyBehindOtherBytes: 0 }),
      // the reply was not measured (no clock)
      action(150, 40, { behindSameBytes: 0, behindOtherBytes: 0, replyBehindOtherBytes: null }),
      // never sent: no transportMs, no isolation row
      tagged({ metric: "action", type: "prompt", outcome: "unavailable", sentAt: 0, gotAt: 15_000, behindSameBytes: null, behindOtherBytes: null, replyBehindOtherBytes: null }),
    ];
  });
  const rebalance = (reason: string, moved: number, settledMs: number) => ({ ...at(1_000), metric: "rebalance", transport: "ws-pool", pool: 2, sockets: 2, reason, moved, settledMs });
  const rows = summarize([...samples, rebalance("grow", 1, 50), rebalance("grow", 3, 150), rebalance("shrink", 2, 20)], {});
  const keys = ["other", "same", "clear", "unknown"];

  for (const [index, transport] of transports.entries()) {
    assert.deepEqual(keys.map((key) => row(rows, "isolation event ms", transport, key)?.p50), [10, 4, 1, 6], transport);
    assert.equal(row(rows, "isolation event ms", transport, "clear")?.count, 2);
    assert.deepEqual(keys.map((key) => row(rows, "isolation action ms", transport, key)?.p50), [300, 200, 100, 150], transport);
    assert.deepEqual(keys.map((key) => row(rows, "isolation action ms", transport, key)?.count), [2, 1, 1, 1], "the never-sent command is in no isolation row");
    assert.equal(row(rows, "sockets", transport, "all")?.max, index + 1);
    assert.equal(row(rows, "pool size", transport, "all")?.p50, transport === "ws-pool" ? 2 : undefined);
  }
  const grow = row(rows, "rebalance moved", "ws-pool", "grow");
  assert.deepEqual([grow?.count, grow?.p50, grow?.max], [2, 1, 3]);
  assert.equal(row(rows, "rebalance moved", "ws-pool", "shrink")?.p50, 2);
  assert.equal(row(rows, "rebalance settledMs", "ws-pool", "grow")?.max, 150);
  assert.deepEqual(
    [...new Set(rows.filter((r) => r.transport === "ws-pool").map((r) => r.section))],
    ["action totalMs", "action transportMs", "event ms", "isolation event ms", "isolation action ms", "sockets", "pool size", "rebalance moved", "rebalance settledMs", "outcome"],
  );
});

test("a WS hang is a stall; an HTTP hang is a stall only when the transport alone took the ack formula's time", () => {
  const action = (req: string, transportMs: number, serverMs: number) =>
    ({ ...at(1), metric: "action", transport: "sse", req, type: "prompt", outcome: "ok", sentAt: 0, recvAt: 5, repliedAt: 5 + serverMs, gotAt: transportMs + serverMs });
  const hang = (transport: string, req: string, via: string) => ({ ...at(1), metric: "hang", transport, req, type: "prompt", via, bytes: 10, waitedMs: 10_000 });
  const rows = summarize(
    [
      action("stalled", 12_000, 50),
      action("slow", 200, 15_000),
      hang("sse", "stalled", "http"),
      hang("sse", "slow", "http"),
      hang("sse", "never answered", "http"),
      hang("ws-client", "acked never", "ws"),
    ],
    {},
  );
  assert.deepEqual(["total", "stalled", "slow command", "unclassified"].map((key) => row(rows, "hang", "sse", key)?.count), [3, 1, 1, 1]);
  assert.deepEqual(["total", "stalled", "slow command"].map((key) => row(rows, "hang", "ws-client", key)?.count), [1, 1, undefined]);
});

test("reconnect rows group triggers by family, keep silence and hang apart, split network wakes by a changed effective type, and the clock RTT is printed", () => {
  const reconnect = (transport: string, trigger: string, effectiveTypeBefore = "4g", effectiveType = "4g") =>
    ({ ...at(1), metric: "reconnect", transport, conn: transport === "sse" ? "sse" : "client", trigger, dropAt: 0, startAt: 0, firstFrameAt: 100, batch: 1, effectiveTypeBefore, effectiveType });
  const rows = summarize(
    [
      reconnect("sse", "error"),
      ...["close", "silence", "hang"].map((trigger) => reconnect("ws-client", trigger)),
      reconnect("ws-client", "network", "4g", "3g"),
      reconnect("ws-client", "network"),
      reconnect("ws-client", "online"),
      reconnect("ws-client", "visible"),
      { ...at(1), metric: "event", transport: "sse", conn: "sse", channel: "running", at: 0, gotAt: 1, offset: 0, offsetRtt: 10 },
      { ...at(1), metric: "event", transport: "sse", conn: "sse", channel: "running", at: 0, gotAt: 1, offset: 0, offsetRtt: 30 },
      { ...at(1), metric: "action", transport: "sse", type: "get_state", outcome: "ok", offset: 0, offsetRtt: 20 },
      { ...at(1), metric: "action", transport: "sse", type: "get_state", outcome: "unavailable", offset: null, offsetRtt: null },
    ],
    {},
  );
  assert.equal(row(rows, "reconnect ms", "sse", "error/close")?.count, 1);
  assert.equal(row(rows, "reconnect ms", "ws-client", "error/close")?.count, 1);
  // A socket's own detectors can fire behind a large downlink frame on a slow link: kept apart so they show.
  assert.equal(row(rows, "reconnect ms", "ws-client", "silence")?.count, 1);
  assert.equal(row(rows, "reconnect ms", "ws-client", "hang")?.count, 1);
  assert.equal(row(rows, "reconnect ms", "ws-client", "network (type changed)")?.count, 1);
  assert.equal(row(rows, "reconnect fromDropMs", "ws-client", "network (same type)")?.count, 1);
  assert.equal(row(rows, "reconnect ms", "ws-client", "online/visible")?.count, 2);
  const rtt = row(rows, "clock offsetRtt", "sse", "all");
  assert.deepEqual([rtt?.count, rtt?.p50, rtt?.max], [3, 20, 30]);
});

test("since, until and client filter on serverAt and clientId", () => {
  const eventRows = (options: Parameters<typeof summarize>[1]) => row(summarize(fixture, options), "event ms", "websocket", "general running");
  assert.equal(eventRows({})?.count, 2);
  assert.equal(eventRows({ until: 5_000 })?.count, 1);
  assert.equal(eventRows({ since: 5_000 })?.count, 1);
  assert.equal(eventRows({ client: "c2" })?.count, 1);
  assert.equal(eventRows({ client: "c2", since: 5_000 }), undefined);
});

test("the client table lists samples, effective types and the user agent", () => {
  const rows = summarize(fixture, {});
  const c1 = rows.find((r) => r.section === "client" && r.key.startsWith("c1 "))!;
  assert.equal(c1.count, 12);
  assert.equal(c1.key, "c1 4g UA/1");
});

test("formatReport prints one line per row", () => {
  const rows = summarize(fixture, {});
  const report = formatReport(rows);
  assert.equal(report.split("\n").length, rows.length);
  assert.match(report, /websocket +action totalMs +prompt +n=1 +p50=40 +p95=40 +max=40/);
});

test("the CLI prints the table for a file, reading .1 before the file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-web-transport-summary-"));
  try {
    const file = path.join(dir, "m.jsonl");
    const sample = (req: string, serverAt: number) => JSON.stringify({ metric: "action", transport: "sse", type: "prompt", clientId: "c", req, outcome: "ok", sentAt: 0, gotAt: 10, serverAt });
    writeFileSync(`${file}.1`, `${sample("a", 1_000)}\n`);
    writeFileSync(file, `${sample("b", 2_000)}\nnot json\n`);
    const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "transport-metrics.ts"), "--file", file, "--since", "1970-01-01T00:00:00Z"]);
    assert.equal(run.exitCode, 0, run.stderr.toString());
    assert.match(run.stdout.toString(), /sse +action totalMs +all +n=2 +p50=10/);
    const bad = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "transport-metrics.ts"), "--file", file, "--since", "soon"]);
    assert.notEqual(bad.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
