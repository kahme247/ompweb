// Main's side of usage from linked hosts: pulls through `listUsageTranscripts`/`readUsageRecords` into usage.db.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-usage-sync-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { closeUsageDatabase, getUsageDatabase, getUsageReportFromDb } = await import("../usage-db.ts");
const { pullAllHostUsage, pullHostUsage, usageSyncTimings } = await import("./usage-sync.ts");
const { closeHostLink, getHost } = await import("./hub.ts");
const { HostOpError } = await import("./link-protocol.ts");
const { createHost, revokeHost } = await import("./registry.ts");
const { linkHost, upgradeSocket } = await import("./link-driver.test-helper.mjs");

after(() => {
  closeUsageDatabase();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const PARSER_VERSION = 7;
let dbCount = 0;
/** An empty usage.db per test: hosts of earlier tests stay registered but hold no rows here. */
const freshDb = () => getUsageDatabase(join(agentDir, `usage-${++dbCount}.db`));

/** A transcript on a linked host: one request of `input` tokens. */
function transcript(session, cwd, input, { mtimeMs = 1, entryId = `${session}-${input}`, timestamp = Date.now() - 1_000 } = {}) {
  return {
    session,
    mtimeMs,
    size: 100,
    records: [{
      timestamp, sessionId: session, sessionCwd: cwd, provider: "anthropic", model: "claude-opus-5-5",
      input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: input / 1000, cacheSavings: 0,
      costQuality: "model_priced", entryId, sessionStarted: 1,
    }],
  };
}

/** Serve `link` as a daemon whose transcripts are `files` (path to transcript; edit it to change the host). Each
 * `readUsageRecords` answers at most `pageSize` files, the rest `unread`. Returns the read requests, in order. */
function serveUsage(link, files, { pageSize = Infinity, ops = {} } = {}) {
  const reads = [];
  void link.serve({
    listUsageTranscripts: () => {
      const sessions = new Map();
      for (const [path, { session, mtimeMs, size }] of files) {
        if (!sessions.has(session)) sessions.set(session, []);
        sessions.get(session).push({ path, mtimeMs, size });
      }
      return { ok: true, value: { parserVersion: PARSER_VERSION, sessions: [...sessions].map(([session, transcripts]) => ({ session, transcripts })) } };
    },
    readUsageRecords: ({ requests }) => {
      reads.push(requests);
      const page = { files: [], missing: [], unread: [] };
      for (const { session, paths } of requests) {
        const unread = [];
        for (const path of paths) {
          const file = files.get(path);
          if (!file) page.missing.push(path);
          else if (page.files.length >= pageSize) unread.push(path);
          else page.files.push({ path, mtimeMs: file.mtimeMs, size: file.size, records: file.records });
        }
        if (unread.length > 0) page.unread.push({ session, paths: unread });
      }
      return { ok: true, value: page };
    },
    ...ops,
  });
  return reads;
}

const hostTokens = (db, hostId) => db.prepare("SELECT COALESCE(SUM(input_tokens), 0) AS t FROM usage_records WHERE host_id = ?").get(hostId).t;
const statusOf = (hosts, hostId) => hosts.find((host) => host.hostId === hostId);

test("a linked host's usage is counted under its id, with its projects named", async (t) => {
  const db = freshDb();
  const link = await linkHost("Laptop");
  t.after(() => link.drop());
  serveUsage(link, new Map([
    ["/home/u/.omp/agent/sessions/a.jsonl", transcript("a", "/home/u/alpha", 100)],
    ["/home/u/.omp/agent/sessions/a/sub.jsonl", transcript("a", "/home/u/alpha", 20)],
    ["C:\\Users\\u\\.omp\\agent\\sessions\\b.jsonl", transcript("b", "C:\\Users\\u\\beta", 50)],
  ]));

  const hosts = await pullAllHostUsage(db, false);
  assert.deepEqual(hosts[0], { hostId: "local", label: "", state: "current", syncedAt: null });
  const laptop = statusOf(hosts, link.id);
  assert.equal(laptop.label, "Laptop");
  assert.equal(laptop.state, "current");
  assert.equal(typeof laptop.syncedAt, "number");

  const report = await getUsageReportFromDb({ range: "30d" }, db, hosts);
  assert.equal(report.summary.inputTokens, 170);
  const row = report.hostBreakdown.find((host) => host.hostId === link.id);
  assert.deepEqual([row.tokens, row.sessionsCount, row.share], [170, 2, 100]);
  assert.equal(report.hostBreakdown[0].tokens, 0, "this machine has no transcripts");
  assert.deepEqual(
    report.projectBreakdown.map(({ hostId, hostLabel, projectName, tokens }) => ({ hostId, hostLabel, projectName, tokens })),
    [
      { hostId: link.id, hostLabel: "Laptop", projectName: "alpha", tokens: 120 },
      { hostId: link.id, hostLabel: "Laptop", projectName: "beta", tokens: 50 },
    ],
  );
});

test("only new or changed transcripts are read again, and ones the host dropped are removed", async (t) => {
  const db = freshDb();
  const link = await linkHost("Changes");
  t.after(() => link.drop());
  const files = new Map([
    ["/s/a.jsonl", transcript("a", "/p", 1)],
    ["/s/b.jsonl", transcript("b", "/p", 10)],
    ["/s/c.jsonl", transcript("c", "/p", 100)],
  ]);
  const reads = serveUsage(link, files);
  await pullHostUsage(link.id, db, false);
  assert.equal(hostTokens(db, link.id), 111);

  files.set("/s/a.jsonl", transcript("a", "/p", 2, { mtimeMs: 2 }));
  files.delete("/s/c.jsonl");
  files.set("/s/d.jsonl", transcript("d", "/p", 1000));
  await pullHostUsage(link.id, db, false);
  assert.equal(reads.length, 1, "within the TTL the host is not asked again");

  await pullHostUsage(link.id, db, true);
  assert.deepEqual(reads[1].flatMap((request) => request.paths).sort(), ["/s/a.jsonl", "/s/d.jsonl"]);
  assert.equal(hostTokens(db, link.id), 1012);
});

test("transcripts that did not fit an answer are asked for again until all are read", async (t) => {
  const db = freshDb();
  const link = await linkHost("Paged");
  t.after(() => link.drop());
  const reads = serveUsage(link, new Map([
    ["/s/a.jsonl", transcript("a", "/p", 1)],
    ["/s/a/sub.jsonl", transcript("a", "/p", 10)],
    ["/s/b.jsonl", transcript("b", "/p", 100)],
  ]), { pageSize: 1 });

  await pullHostUsage(link.id, db, true);
  assert.deepEqual(reads.map((requests) => requests.flatMap((request) => request.paths)), [
    ["/s/a.jsonl", "/s/a/sub.jsonl", "/s/b.jsonl"],
    ["/s/a/sub.jsonl", "/s/b.jsonl"],
    ["/s/b.jsonl"],
  ]);
  assert.equal(hostTokens(db, link.id), 111);
});

test("one read asks for at most 50 sessions", async (t) => {
  const db = freshDb();
  const link = await linkHost("Many");
  t.after(() => link.drop());
  const files = new Map(Array.from({ length: 120 }, (_, i) => [`/s/${i}.jsonl`, transcript(`s${i}`, "/p", 1)]));
  const reads = serveUsage(link, files);

  await pullHostUsage(link.id, db, true);
  assert.deepEqual(reads.map((requests) => requests.length), [50, 50, 20]);
  assert.equal(hostTokens(db, link.id), 120);
});

test("a daemon without the usage ops is unsupported; an offline or failing host keeps its last numbers", async (t) => {
  const db = freshDb();
  const old = await linkHost("Old daemon");
  t.after(() => old.drop());
  serveUsage(old, new Map(), { ops: { listUsageTranscripts: () => { throw new HostOpError(501, "unknown_op", "Unknown op"); } } });
  const { host: outdated, token } = createHost("Outdated link");
  upgradeSocket(token).socket.frame(`${JSON.stringify({ type: "hello", v: 3 })}\n`);
  assert.equal(getHost(outdated.id).status(), "needs-upgrade");

  const flaky = await linkHost("Flaky");
  t.after(() => flaky.drop());
  let failing = false;
  const flakyFiles = new Map([["/s/f.jsonl", transcript("f", "/p", 5)]]);
  serveUsage(flaky, flakyFiles, {
    ops: { listUsageTranscripts: () => failing ? { ok: false, status: 500, code: "host_op_failed", error: "disk on fire" } : { ok: true, value: { parserVersion: PARSER_VERSION, sessions: [{ session: "f", transcripts: [{ path: "/s/f.jsonl", mtimeMs: 1, size: 100 }] }] } } },
  });
  const gone = await linkHost("Going away");
  serveUsage(gone, new Map([["/s/g.jsonl", transcript("g", "/p", 40)]]));

  const first = await pullAllHostUsage(db, true);
  assert.equal(statusOf(first, old.id).state, "unsupported");
  assert.equal(statusOf(first, outdated.id).state, "unsupported");
  assert.equal(statusOf(first, gone.id).state, "current");
  const syncedAt = statusOf(first, gone.id).syncedAt;

  closeHostLink(gone.id);
  assert.equal(getHost(gone.id).status(), "offline");
  failing = true;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = warn; });
  const second = await pullAllHostUsage(db, true);
  assert.deepEqual([statusOf(second, gone.id).state, statusOf(second, gone.id).syncedAt], ["offline", syncedAt]);
  assert.equal(statusOf(second, flaky.id).state, "stale");
  assert.deepEqual(warnings, ["[omp-web] could not sync usage from host Flaky: disk on fire"]);

  const report = await getUsageReportFromDb({ range: "30d" }, db, second);
  assert.equal(report.hostBreakdown.find((host) => host.hostId === gone.id).tokens, 40);
  assert.equal(report.hostBreakdown.find((host) => host.hostId === flaky.id).tokens, 5);
});

test("a revoked host's rows are pruned; an unreadable hosts.json prunes nothing", async (t) => {
  const db = freshDb();
  const link = await linkHost("Revoked");
  t.after(() => link.drop());
  serveUsage(link, new Map([["/s/r.jsonl", transcript("r", "/p", 9)]]));
  await pullAllHostUsage(db, true);
  assert.equal(hostTokens(db, link.id), 9);

  const hostsFile = join(agentDir, "omp-web", "hosts.json");
  const registry = readFileSync(hostsFile, "utf8");
  writeFileSync(hostsFile, "{ not json");
  try {
    await pullAllHostUsage(db, true);
  } finally {
    writeFileSync(hostsFile, registry);
  }
  assert.equal(hostTokens(db, link.id), 9);

  revokeHost(link.id);
  const hosts = await pullAllHostUsage(db, true);
  assert.equal(hostTokens(db, link.id), 0);
  assert.equal(statusOf(hosts, link.id), undefined);
});

test("the same request in transcripts on two hosts counts once", async (t) => {
  const db = freshDb();
  const timestamp = Date.now() - 5_000;
  for (const label of ["Copy one", "Copy two"]) {
    const link = await linkHost(label);
    t.after(() => link.drop());
    serveUsage(link, new Map([[`/s/${label}.jsonl`, transcript("moved", "/p", 300, { entryId: "e1", timestamp })]]));
  }
  const report = await getUsageReportFromDb({ range: "30d" }, db, await pullAllHostUsage(db, true));
  assert.equal(report.summary.inputTokens, 300);
});

test("a report waits for slow hosts only so long; their pull finishes in the background", async (t) => {
  const db = freshDb();
  const link = await linkHost("Slow");
  t.after(() => link.drop());
  const gate = Promise.withResolvers();
  const index = { ok: true, value: { parserVersion: PARSER_VERSION, sessions: [{ session: "slow", transcripts: [{ path: "/s/slow.jsonl", mtimeMs: 1, size: 100 }] }] } };
  const reads = serveUsage(link, new Map([["/s/slow.jsonl", transcript("slow", "/p", 3)]]), {
    ops: { listUsageTranscripts: async () => { await gate.promise; return index; } },
  });
  const waitMs = usageSyncTimings.waitMs;
  usageSyncTimings.waitMs = 20;
  t.after(() => { usageSyncTimings.waitMs = waitMs; });

  const hosts = await pullAllHostUsage(db, true);
  assert.deepEqual([statusOf(hosts, link.id).state, statusOf(hosts, link.id).syncedAt], ["syncing", null]);
  assert.equal(hostTokens(db, link.id), 0);

  gate.resolve();
  await pullHostUsage(link.id, db, false);
  assert.equal(hostTokens(db, link.id), 3);
  assert.equal(reads.length, 1, "the waiting pull did not start a second one");
});
