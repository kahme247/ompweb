import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatReport, LINK_ACK_NOTE, percentile, summarize, type SummaryRow } from "./transport-metrics";

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
  { ...at(1_000), metric: "action", transport: "ws", type: "prompt", req: "r3", outcome: "ok", attempts: 1, sentAt: 1000, recvAt: 1005, repliedAt: 1015, gotAt: 1040, offset: 0 },
  // never answered: no gotAt → no totalMs, still counted in outcomes
  { ...at(1_000), metric: "action", transport: "ws", type: "prompt", req: "r4", outcome: "lost", attempts: 1, sentAt: 5000 },
  // abort behind an upload vs alone
  { ...at(1_000), metric: "action", transport: "ws", type: "abort", req: "r5", outcome: "ok", behindBytes: 8_000_000, sentAt: 0, gotAt: 900, offset: 0 },
  { ...at(1_000), metric: "action", transport: "ws", type: "abort_bash", req: "r6", outcome: "ok", behindBytes: 0, sentAt: 0, gotAt: 50, offset: 0 },
  // event ms = gotAt + offset − at
  { ...at(1_000), metric: "event", transport: "ws", conn: "link", channel: "session", at: 400, gotAt: 500, offset: 20 },
  // reconnect: ms = 900 − 200, fromDropMs = 900 − 100
  { ...at(1_000), metric: "reconnect", transport: "ws", conn: "link", trigger: "online", dropAt: 100, startAt: 200, firstFrameAt: 900, batch: 3, resumed: true },
  { ...at(1_000), metric: "reconnect", transport: "ws", conn: "link", trigger: "online", dropAt: 100, startAt: 200, firstFrameAt: 500, batch: 1, resumed: false },
  // r2 was answered later (its action is above); r9 never was (a POST after the link fell back to SSE)
  { ...at(1_000), metric: "hang", transport: "sse", req: "r2", type: "get_state", via: "http", bytes: 10, waitedMs: 10_000 },
  { ...at(1_000), metric: "hang", transport: "ws", req: "r9", type: "prompt", via: "http", bytes: 10, waitedMs: 10_000 },
  // outside the window / another client
  { ...at(9_000), metric: "event", transport: "ws", conn: "link", channel: "running", at: 0, gotAt: 7, offset: 0 },
  { ...at(1_000), metric: "event", transport: "ws", conn: "link", channel: "running", at: 0, gotAt: 3, offset: 0, clientId: "c2", effectiveType: null },
];

const row = (rows: SummaryRow[], section: string, transport: string, key: string) => rows.find((r) => r.section === section && r.transport === transport && r.key === key);

test("summarize derives the action latencies per transport and type", () => {
  const rows = summarize(fixture, {});
  assert.deepEqual(row(rows, "action totalMs", "sse", "all"), { section: "action totalMs", transport: "sse", key: "all", count: 2, p50: 100, p95: 300, max: 300 });
  assert.equal(row(rows, "action totalMs", "sse", "prompt")?.max, 100);
  assert.equal(row(rows, "action totalMs", "ws", "prompt")?.p50, 40);
  // total − (repliedAt − recvAt)
  assert.equal(row(rows, "action transportMs", "sse", "prompt")?.p50, 70);
  assert.equal(row(rows, "action transportMs", "sse", "get_state")?.p50, 290);
  // recvAt − (sentAt + offset)
  assert.equal(row(rows, "action upMs", "sse", "prompt")?.p50, 10);
});

test("summarize derives event and reconnect times, and counts resumed links apart from resyncs", () => {
  const rows = summarize(fixture, { since: 0, until: 5_000 });
  assert.equal(row(rows, "event ms", "ws", "link session")?.p50, 120);
  const reconnect = row(rows, "reconnect ms", "ws", "online/visible")!;
  assert.equal(reconnect.count, 2);
  assert.equal(reconnect.max, 700);
  assert.equal(reconnect.meanBatch, 2);
  assert.equal(row(rows, "reconnect fromDropMs", "ws", "online/visible")?.max, 800);
  assert.deepEqual(["yes", "no"].map((key) => row(rows, "reconnect resumed", "ws", key)?.count), [1, 1]);
  assert.equal(rows.some((r) => r.section === "reconnect resumed" && r.transport === "sse"), false, "SSE never resumes");
});

test("summarize counts hangs, answered-later hangs, resends, deduped and outcomes", () => {
  const rows = summarize(fixture, {});
  assert.equal(row(rows, "hang", "sse", "total")?.count, 1);
  assert.equal(row(rows, "hang", "sse", "answered later")?.count, 1);
  assert.equal(row(rows, "hang", "ws", "total")?.count, 1);
  assert.equal(row(rows, "hang", "ws", "answered later"), undefined);
  assert.equal(row(rows, "resend", "sse", "attempts>1")?.count, 1);
  assert.equal(row(rows, "deduped", "sse", "deduped")?.count, 1);
  assert.equal(row(rows, "outcome", "ws", "lost")?.count, 1);
  assert.equal(row(rows, "outcome", "ws", "ok")?.count, 3);
});

test("a hang whose command was never answered is not counted as answered later", () => {
  const rows = summarize(
    [
      { ...at(1), metric: "hang", transport: "ws", req: "x", type: "prompt", via: "http", bytes: 1, waitedMs: 1 },
      { ...at(1), metric: "action", transport: "ws", req: "x", type: "prompt", outcome: "lost" },
      // A fetch that got no response at all records an error with status 0.
      { ...at(1), metric: "hang", transport: "sse", req: "y", type: "prompt", via: "http", bytes: 1, waitedMs: 1 },
      { ...at(1), metric: "action", transport: "sse", req: "y", type: "prompt", outcome: "error", status: 0 },
    ],
    {},
  );
  assert.equal(row(rows, "hang", "ws", "total")?.count, 1);
  assert.equal(row(rows, "hang", "ws", "answered later"), undefined);
  assert.equal(row(rows, "hang", "sse", "total")?.count, 1);
  assert.equal(row(rows, "hang", "sse", "answered later"), undefined);
});

test("an abort behind an upload lands in its own row", () => {
  const rows = summarize(fixture, {});
  assert.equal(row(rows, "abort behind upload", "ws", "yes")?.max, 900);
  assert.equal(row(rows, "abort behind upload", "ws", "no")?.max, 50);
  for (const behindBytes of [1_000, 65_535, 65_536]) {
    const boundary = summarize([{ ...at(1), metric: "action", transport: "sse", type: "abort", req: "a", outcome: "ok", behindBytes, sentAt: 0, gotAt: 70, offset: 0 }], {});
    assert.equal(row(boundary, "abort behind upload", "sse", behindBytes < 65_536 ? "no" : "yes")?.max, 70, `blocking starts at 64 KiB, not at ${behindBytes} bytes`);
  }
});

test("an abort whose POST got no response has no behindBytes and lands under unknown, not no", () => {
  const rows = summarize([{ ...at(1), metric: "action", transport: "sse", type: "abort", req: "a", outcome: "error", sentAt: 0, gotAt: 70, offset: 0 }], {});
  assert.equal(row(rows, "abort behind upload", "sse", "unknown")?.max, 70);
  assert.equal(row(rows, "abort behind upload", "sse", "no"), undefined);
});

test("a req shared by two clients is looked up per client for answered later and the hang class", () => {
  const hang = { ...at(1), metric: "hang", transport: "sse", req: "r1", type: "prompt", via: "http", bytes: 1, waitedMs: 100 };
  const action = (clientId: string, outcome: string, gotAt: number) =>
    ({ ...at(1), clientId, metric: "action", transport: "sse", req: "r1", type: "prompt", outcome, sentAt: 0, recvAt: 0, repliedAt: 0, gotAt });
  // c2 answered r1 slowly (stalled would need transportMs ≥ 100); c1's r1 was lost and its own action was fast.
  const rows = summarize([hang, action("c1", "lost", 10), action("c2", "ok", 5_000)], { client: "c1" });
  assert.equal(row(rows, "hang", "sse", "total")?.count, 1);
  assert.equal(row(rows, "hang", "sse", "answered later"), undefined);
  assert.equal(row(rows, "hang", "sse", "slow command")?.count, 1);
  assert.equal(row(rows, "hang", "sse", "stalled"), undefined);
});

test("a hang stays answered later when its reply is outside the filter, and a hang without req never is", () => {
  const rows = summarize(
    [
      { ...at(5_000), metric: "hang", transport: "sse", req: "x", type: "prompt", via: "http", bytes: 1, waitedMs: 1 },
      { ...at(9_000), metric: "action", transport: "sse", req: "x", type: "prompt", outcome: "ok" },
      { ...at(5_000), metric: "hang", transport: "ws", type: "prompt", via: "http", bytes: 1, waitedMs: 1 },
      { ...at(5_000), metric: "action", transport: "ws", type: "prompt", outcome: "ok" },
    ],
    { until: 6_000 },
  );
  assert.equal(row(rows, "hang", "sse", "answered later")?.count, 1);
  assert.equal(row(rows, "hang", "ws", "total")?.count, 1);
  assert.equal(row(rows, "hang", "ws", "answered later"), undefined);
});

test("the report keeps one section order whatever the order of the samples", () => {
  const forward = summarize(fixture, {});
  assert.deepEqual(summarize([...fixture].reverse(), {}), forward);
  assert.deepEqual(
    [...new Set(forward.filter((r) => r.transport === "ws").map((r) => r.section))],
    ["action totalMs", "action transportMs", "action upMs", "abort behind upload", "event ms", "reconnect ms", "reconnect fromDropMs", "reconnect resumed", "hang", "outcome"],
  );
});

test("isolation and sockets rows per transport", () => {
  const transports = ["sse", "ws"];
  const samples = transports.flatMap((transport, index) => {
    const tagged = (fields: Record<string, unknown>) => ({ ...at(1_000), transport, sockets: index + 1, ...fields });
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
  const rows = summarize(samples, {});
  const keys = ["other", "same", "clear", "unknown"];

  for (const [index, transport] of transports.entries()) {
    assert.deepEqual(keys.map((key) => row(rows, "isolation event ms", transport, key)?.p50), [10, 4, 1, 6], transport);
    assert.equal(row(rows, "isolation event ms", transport, "clear")?.count, 2);
    assert.deepEqual(keys.map((key) => row(rows, "isolation action ms", transport, key)?.p50), [300, 200, 100, 150], transport);
    assert.deepEqual(keys.map((key) => row(rows, "isolation action ms", transport, key)?.count), [2, 1, 1, 1], "the never-sent command is in no isolation row");
    assert.equal(row(rows, "sockets", transport, "all")?.max, index + 1);
  }
  assert.deepEqual(
    [...new Set(rows.filter((r) => r.transport === "ws").map((r) => r.section))],
    ["action totalMs", "action transportMs", "event ms", "isolation event ms", "isolation action ms", "sockets", "outcome"],
  );
});

test("an HTTP hang is a stall only when the transport alone took the hang formula's time", () => {
  const action = (req: string, transportMs: number, serverMs: number) =>
    ({ ...at(1), metric: "action", transport: "sse", req, type: "prompt", outcome: "ok", sentAt: 0, recvAt: 5, repliedAt: 5 + serverMs, gotAt: transportMs + serverMs });
  const hang = (req: string) => ({ ...at(1), metric: "hang", transport: "sse", req, type: "prompt", via: "http", bytes: 10, waitedMs: 10_000 });
  const rows = summarize([action("stalled", 12_000, 50), action("slow", 200, 15_000), hang("stalled"), hang("slow"), hang("never answered")], {});
  assert.deepEqual(["total", "stalled", "slow command", "unclassified"].map((key) => row(rows, "hang", "sse", key)?.count), [3, 1, 1, 1]);
});

test("reconnect rows group triggers by family, keep the link's silence apart, split network wakes by a changed effective type, and the clock RTT is printed", () => {
  const reconnect = (transport: string, trigger: string, effectiveTypeBefore = "4g", effectiveType = "4g") =>
    ({ ...at(1), metric: "reconnect", transport, conn: transport === "sse" ? "sse" : "link", trigger, dropAt: 0, startAt: 0, firstFrameAt: 100, batch: 1, effectiveTypeBefore, effectiveType });
  const rows = summarize(
    [
      reconnect("sse", "error"),
      ...["close", "silence"].map((trigger) => reconnect("ws", trigger)),
      reconnect("ws", "network", "4g", "3g"),
      reconnect("ws", "network"),
      reconnect("ws", "online"),
      reconnect("ws", "visible"),
      { ...at(1), metric: "event", transport: "sse", conn: "sse", channel: "running", at: 0, gotAt: 1, offset: 0, offsetRtt: 10 },
      { ...at(1), metric: "event", transport: "sse", conn: "sse", channel: "running", at: 0, gotAt: 1, offset: 0, offsetRtt: 30 },
      { ...at(1), metric: "action", transport: "sse", type: "get_state", outcome: "ok", offset: 0, offsetRtt: 20 },
      { ...at(1), metric: "action", transport: "sse", type: "get_state", outcome: "unavailable", offset: null, offsetRtt: null },
    ],
    {},
  );
  assert.equal(row(rows, "reconnect ms", "sse", "error/close")?.count, 1);
  assert.equal(row(rows, "reconnect ms", "ws", "error/close")?.count, 1);
  // The link's own detector: kept apart, SSE has none.
  assert.equal(row(rows, "reconnect ms", "ws", "silence")?.count, 1);
  assert.equal(row(rows, "reconnect ms", "ws", "network (type changed)")?.count, 1);
  assert.equal(row(rows, "reconnect fromDropMs", "ws", "network (same type)")?.count, 1);
  assert.equal(row(rows, "reconnect ms", "ws", "online/visible")?.count, 2);
  const rtt = row(rows, "clock offsetRtt", "sse", "all");
  assert.deepEqual([rtt?.count, rtt?.p50, rtt?.max], [3, 20, 30]);
});

test("since, until and client filter on serverAt and clientId", () => {
  const eventRows = (options: Parameters<typeof summarize>[1]) => row(summarize(fixture, options), "event ms", "ws", "link running");
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

test("link samples: small lines' ackMs split clear vs behind-large per host and direction, with the bytesAhead spread", () => {
  const link = (dir: string, bytes: number, bytesAhead: number, ackMs: number, host = "mac") =>
    ({ metric: "link", dir, host, session: null, bytes, bytesAhead, ackMs, at: 0, serverAt: 1, ua: null });
  const rows = summarize([
    link("down", 200, 0, 10),
    link("down", 200, 65_535, 20),
    link("down", 200, 65_536, 900),
    link("down", 200, 6_000_000, 1_500),
    // A large line itself: only in bytesAhead.
    link("down", 6_000_000, 0, 2_000),
    link("up", 300, 7_000_000, 3_000),
    link("up", 300, 0, 5, "box"),
  ], {});
  const stats = (section: string, transport: string, key: string) => {
    const r = row(rows, section, transport, key);
    return r && [r.count, r.p50, r.p95, r.max];
  };
  assert.deepEqual(stats("link small ackMs", "link:mac:down", "clear"), [2, 10, 20, 20]);
  assert.deepEqual(stats("link small ackMs", "link:mac:down", "behind-large"), [2, 900, 1_500, 1_500]);
  assert.deepEqual(stats("link bytesAhead", "link:mac:down", "all"), [5, 65_535, 6_000_000, 6_000_000]);
  assert.deepEqual(stats("link small ackMs", "link:mac:up", "behind-large"), [1, 3_000, 3_000, 3_000]);
  assert.equal(row(rows, "link small ackMs", "link:mac:up", "clear"), undefined);
  assert.deepEqual(stats("link small ackMs", "link:box:up", "clear"), [1, 5, 5, 5]);
  // Not a browser client.
  assert.equal(rows.some((r) => r.section === "client"), false);
});

test("link samples: --session keeps one session's link samples only, and budget drops show per host and direction", () => {
  const A = "11111111-2222-4333-8444-0000000000aa";
  const link = (session: string | null, ackMs: number) => ({ metric: "link", dir: "down", host: "mac", session, bytes: 200, bytesAhead: 0, ackMs, at: 0, serverAt: 1 });
  const samples = [
    link(A, 10),
    link(null, 15_000),
    { metric: "link", dir: "up", host: "mac", dropped: 300, at: 0, serverAt: 1 },
    { metric: "action", transport: "sse", type: "prompt", clientId: "c", req: "r", outcome: "ok", sentAt: 0, gotAt: 10, serverAt: 1 },
  ];
  const all = summarize(samples, {});
  assert.equal(row(all, "link small ackMs", "link:mac:down", "clear")?.count, 2);
  assert.deepEqual([row(all, "link dropped", "link:mac:up", "samples")?.count, row(all, "link dropped", "link:mac:up", "samples")?.max], [1, 300]);
  const one = summarize(samples, { session: A });
  assert.deepEqual([row(one, "link small ackMs", "link:mac:down", "clear")?.count, row(one, "link small ackMs", "link:mac:down", "clear")?.max], [1, 10]);
  assert.equal(row(one, "link dropped", "link:mac:up", "samples"), undefined);
  // The browser samples are not filtered by session.
  assert.equal(row(one, "action totalMs", "sse", "all")?.count, 1);
});

test("formatReport prints one line per row", () => {
  const rows = summarize(fixture, {});
  const report = formatReport(rows);
  assert.equal(report.split("\n").length, rows.length);
  assert.match(report, /ws +action totalMs +prompt +n=1 +p50=40 +p95=40 +max=40/);
});

test("the CLI prints the table for a file, reading .1 before the file, and the ackMs note under link rows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-web-transport-summary-"));
  try {
    const file = path.join(dir, "m.jsonl");
    const sample = (req: string, serverAt: number, ua: string) => JSON.stringify({ metric: "action", transport: "sse", type: "prompt", clientId: "c", req, outcome: "ok", sentAt: 0, gotAt: 10, serverAt, ua });
    writeFileSync(`${file}.1`, `${sample("a", 1_000, "old-agent")}\n`);
    writeFileSync(file, `${sample("b", 2_000, "new-agent")}\nnot json\n`);
    const summary = () => Bun.spawnSync([process.execPath, path.join(import.meta.dir, "transport-metrics.ts"), "--file", file, "--since", "1970-01-01T00:00:00Z"]);
    const run = summary();
    assert.equal(run.exitCode, 0, run.stderr.toString());
    assert.match(run.stdout.toString(), /sse +action totalMs +all +n=2 +p50=10/);
    // The client row keeps the last user agent it read: the file's, only if .1 was read first.
    assert.match(run.stdout.toString(), /all +client +c null new-agent +n=2/);
    assert.doesNotMatch(run.stdout.toString(), /round trip/);
    writeFileSync(file, `${JSON.stringify({ metric: "link", dir: "down", host: "mac", session: null, bytes: 200, bytesAhead: 0, ackMs: 10, at: 0, serverAt: 3_000 })}\n`, { flag: "a" });
    const withLink = summary().stdout.toString();
    assert.match(withLink, /link:mac:down +link small ackMs +clear +n=1/);
    assert.ok(withLink.trimEnd().endsWith(LINK_ACK_NOTE), withLink);
    const bad = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "transport-metrics.ts"), "--file", file, "--since", "soon"]);
    assert.notEqual(bad.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hang without a req is neither answered later nor classed by an action whose req is the string \"undefined\"", () => {
  const rows = summarize(
    [
      { ...at(1), metric: "hang", transport: "sse", type: "prompt", via: "http", bytes: 1, waitedMs: 100 },
      { ...at(1), metric: "action", transport: "sse", type: "prompt", req: "undefined", outcome: "ok", sentAt: 0, recvAt: 0, repliedAt: 0, gotAt: 5_000 },
    ],
    {},
  );
  assert.equal(row(rows, "hang", "sse", "total")?.count, 1);
  assert.equal(row(rows, "hang", "sse", "answered later"), undefined);
  assert.equal(row(rows, "hang", "sse", "unclassified")?.count, 1);
});
