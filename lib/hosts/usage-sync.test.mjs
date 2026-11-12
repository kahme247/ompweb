// Main's side of usage from linked hosts: pulls through `listUsageTranscripts`/`readUsageRecords` into usage.db.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-usage-sync-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { closeUsageDatabase, getUsageDatabase, getUsageReportFromDb } = await import("../usage-db.ts");
const { pullAllHostUsage, usageSyncTimings } = await import("./usage-sync.ts");
const { closeHostLink, getHost } = await import("./hub.ts");
const { HostOpError } = await import("./link-protocol.ts");
const { createHost, revokeHost } = await import("./registry.ts");
const { sessionOps } = await import("./session-ops.ts");
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
 * `readUsageRecords` answers at most `pageSize` files and leaves the rest out; `readFails(n)` says whether the nth read
 * fails. Returns the read requests, in order. */
function serveUsage(link, files, { pageSize = Infinity, readFails = () => false, ops = {} } = {}) {
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
      if (readFails(reads.length)) return { ok: false, status: 500, code: "usage_unreadable", error: "disk on fire" };
      const page = { files: [], missing: [] };
      for (const path of requests.flatMap((request) => request.paths)) {
        const file = files.get(path);
        if (!file) page.missing.push(path);
        else if (page.files.length < pageSize) page.files.push({ path, mtimeMs: file.mtimeMs, size: file.size, records: file.records });
      }
      return { ok: true, value: page };
    },
    ...ops,
  });
  return reads;
}

const hostTokens = (db, hostId) => db.prepare("SELECT COALESCE(SUM(input_tokens), 0) AS t FROM usage_records WHERE host_id = ?").get(hostId).t;
const statusOf = (hosts, hostId) => hosts.find((host) => host.hostId === hostId);
const pathsOf = (requests) => requests.flatMap((request) => request.paths);

function captureWarnings(t) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = warn; });
  return warnings;
}

/** Pull every host as soon as it is asked, not once per TTL. */
function withoutTtl(t) {
  const ttlMs = usageSyncTimings.ttlMs;
  usageSyncTimings.ttlMs = 0;
  t.after(() => { usageSyncTimings.ttlMs = ttlMs; });
}

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
  const laptop = statusOf(hosts, link.id);
  assert.equal(laptop.label, "Laptop");
  assert.equal(laptop.state, "current");
  assert.equal(typeof laptop.syncedAt, "number");

  const report = await getUsageReportFromDb({ range: "30d" }, db, hosts);
  assert.equal(report.summary.inputTokens, 170);
  const row = report.hostBreakdown.find((host) => host.hostId === link.id);
  assert.deepEqual([row.tokens, row.sessionsCount, row.share], [170, 2, 100]);
  assert.deepEqual([report.hostBreakdown[0].hostId, report.hostBreakdown[0].tokens], ["local", 0], "this machine comes first and has no transcripts");
  assert.deepEqual(
    report.projectBreakdown.map(({ hostId, hostLabel, projectName, tokens }) => ({ hostId, hostLabel, projectName, tokens })),
    [
      { hostId: link.id, hostLabel: "Laptop", projectName: "alpha", tokens: 120 },
      { hostId: link.id, hostLabel: "Laptop", projectName: "beta", tokens: 50 },
    ],
  );
});

test("only new or changed transcripts are read again and ones the host dropped are removed; a refresh reads them all", async (t) => {
  const db = freshDb();
  const link = await linkHost("Changes");
  t.after(() => link.drop());
  const files = new Map([
    ["/s/a.jsonl", transcript("a", "/p", 1)],
    ["/s/b.jsonl", transcript("b", "/p", 10)],
    ["/s/c.jsonl", transcript("c", "/p", 100)],
  ]);
  const reads = serveUsage(link, files);
  await pullAllHostUsage(db, false);
  assert.equal(hostTokens(db, link.id), 111);

  files.set("/s/a.jsonl", transcript("a", "/p", 2, { mtimeMs: 2 }));
  files.delete("/s/c.jsonl");
  files.set("/s/d.jsonl", transcript("d", "/p", 1000));
  await pullAllHostUsage(db, false);
  assert.equal(reads.length, 1, "within the TTL the host is not asked again");

  withoutTtl(t);
  await pullAllHostUsage(db, false);
  assert.deepEqual(pathsOf(reads[1]).sort(), ["/s/a.jsonl", "/s/d.jsonl"]);
  assert.equal(hostTokens(db, link.id), 1012);

  // The host may price differently now: nothing about a transcript's stamp says so.
  await pullAllHostUsage(db, true);
  assert.deepEqual(pathsOf(reads[2]).sort(), ["/s/a.jsonl", "/s/b.jsonl", "/s/d.jsonl"]);
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

  const hosts = await pullAllHostUsage(db, false);
  assert.deepEqual(reads.map(pathsOf), [
    ["/s/a.jsonl", "/s/a/sub.jsonl", "/s/b.jsonl"],
    ["/s/a/sub.jsonl", "/s/b.jsonl"],
    ["/s/b.jsonl"],
  ]);
  assert.equal(hostTokens(db, link.id), 111);
  assert.equal(statusOf(hosts, link.id).state, "current");
});

test("one read asks for at most 50 sessions", async (t) => {
  const db = freshDb();
  const link = await linkHost("Many");
  t.after(() => link.drop());
  const files = new Map(Array.from({ length: 120 }, (_, i) => [`/s/${i}.jsonl`, transcript(`s${i}`, "/p", 1)]));
  const reads = serveUsage(link, files);

  await pullAllHostUsage(db, false);
  assert.deepEqual(reads.map((requests) => requests.length), [50, 50, 20]);
  assert.equal(hostTokens(db, link.id), 120);
});

test("a host that reads none of what it was asked for fails the pull instead of being asked for ever", async (t) => {
  const db = freshDb();
  const link = await linkHost("Mute");
  t.after(() => link.drop());
  const reads = serveUsage(link, new Map([["/s/m.jsonl", transcript("m", "/p", 1)]]), { pageSize: 0 });
  const warnings = captureWarnings(t);

  const hosts = await pullAllHostUsage(db, false);
  assert.deepEqual([statusOf(hosts, link.id).state, statusOf(hosts, link.id).syncedAt], ["stale", null]);
  assert.equal(reads.length, 1);
  assert.deepEqual(warnings, ["[omp-web] could not sync usage from host Mute: Mute read none of the usage transcripts it was asked for"]);
});

test("an answer about a transcript that was not asked for changes nothing", async (t) => {
  const db = freshDb();
  const link = await linkHost("Chatty");
  t.after(() => link.drop());
  const files = new Map([["/s/a.jsonl", transcript("a", "/p", 1)], ["/s/b.jsonl", transcript("b", "/p", 10)]]);
  const unlisted = { path: "/s/unlisted.jsonl", mtimeMs: 1, size: 100, records: transcript("x", "/p", 1000).records };
  serveUsage(link, files, {
    ops: {
      readUsageRecords: ({ requests }) => {
        const asked = pathsOf(requests);
        const read = asked.map((path) => ({ path, mtimeMs: files.get(path).mtimeMs, size: 100, records: files.get(path).records }));
        return { ok: true, value: { files: [...read, unlisted], missing: ["/s/b.jsonl"].filter((path) => !asked.includes(path)) } };
      },
    },
  });
  await pullAllHostUsage(db, false);
  assert.equal(hostTokens(db, link.id), 11);

  files.set("/s/a.jsonl", transcript("a", "/p", 2, { mtimeMs: 2 }));
  withoutTtl(t);
  await pullAllHostUsage(db, false);
  assert.equal(hostTokens(db, link.id), 12, "the unchanged transcript the host called missing is kept");
});

test("a pull that fails keeps the pages it stored and drops nothing; the next one finishes the job", async (t) => {
  const db = freshDb();
  const link = await linkHost("Halfway");
  t.after(() => link.drop());
  const files = new Map([
    ["/s/a.jsonl", transcript("a", "/p", 1)],
    ["/s/b.jsonl", transcript("b", "/p", 10)],
    ["/s/c.jsonl", transcript("c", "/p", 100)],
  ]);
  let failFrom = Infinity;
  const reads = serveUsage(link, files, { pageSize: 1, readFails: (n) => n >= failFrom });
  await pullAllHostUsage(db, false);
  assert.equal(hostTokens(db, link.id), 111);

  files.set("/s/a.jsonl", transcript("a", "/p", 2, { mtimeMs: 2 }));
  files.set("/s/b.jsonl", transcript("b", "/p", 20, { mtimeMs: 2 }));
  files.delete("/s/c.jsonl");
  failFrom = reads.length + 2;
  withoutTtl(t);
  captureWarnings(t);
  const failed = statusOf(await pullAllHostUsage(db, false), link.id);
  assert.equal(failed.state, "stale");
  assert.equal(hostTokens(db, link.id), 112, "the first page is stored, the transcript the host deleted is still counted");

  failFrom = Infinity;
  const done = statusOf(await pullAllHostUsage(db, false), link.id);
  assert.equal(done.state, "current");
  assert.ok(done.syncedAt >= failed.syncedAt);
  assert.equal(hostTokens(db, link.id), 22);
  assert.deepEqual(pathsOf(reads.at(-1)), ["/s/b.jsonl"], "only what the failed pull had not stored is read");
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
    // What a daemon answers when it cannot examine one of its transcripts.
    ops: { listUsageTranscripts: () => failing ? { ok: false, status: 500, code: "usage_unreadable", error: "disk on fire" } : { ok: true, value: { parserVersion: PARSER_VERSION, sessions: [{ session: "f", transcripts: [{ path: "/s/f.jsonl", mtimeMs: 1, size: 100 }] }] } } },
  });
  const gone = await linkHost("Going away");
  serveUsage(gone, new Map([["/s/g.jsonl", transcript("g", "/p", 40)]]));

  const first = await pullAllHostUsage(db, true);
  assert.equal(statusOf(first, old.id).state, "unsupported");
  assert.equal(statusOf(first, outdated.id).state, "unsupported");
  assert.equal(statusOf(first, gone.id).state, "current");
  const flakySyncedAt = statusOf(first, flaky.id).syncedAt;
  const goneSyncedAt = statusOf(first, gone.id).syncedAt;

  closeHostLink(gone.id);
  assert.equal(getHost(gone.id).status(), "offline");
  failing = true;
  const warnings = captureWarnings(t);
  const second = await pullAllHostUsage(db, true);
  assert.deepEqual([statusOf(second, gone.id).state, statusOf(second, gone.id).syncedAt], ["offline", goneSyncedAt]);
  assert.deepEqual([statusOf(second, flaky.id).state, statusOf(second, flaky.id).syncedAt], ["stale", flakySyncedAt]);
  assert.deepEqual(warnings, ["[omp-web] could not sync usage from host Flaky: disk on fire"]);

  const report = await getUsageReportFromDb({ range: "30d" }, db, second);
  assert.equal(report.hostBreakdown.find((host) => host.hostId === gone.id).tokens, 40);
  assert.equal(report.hostBreakdown.find((host) => host.hostId === flaky.id).tokens, 5);
});

test("a host that dropped since its last pull is offline whatever the TTL, and its last sync time outlives a restart", async () => {
  const db = freshDb();
  const link = await linkHost("Dropped");
  serveUsage(link, new Map([["/s/d.jsonl", transcript("d", "/p", 8)]]));
  const synced = statusOf(await pullAllHostUsage(db, false), link.id);
  assert.equal(synced.state, "current");

  closeHostLink(link.id);
  const offline = statusOf(await pullAllHostUsage(db, false), link.id);
  assert.deepEqual(offline, { ...synced, state: "offline" });

  // What a restart leaves behind: the database, and no memory of earlier pulls.
  globalThis.__ompHostUsagePulls.clear();
  assert.deepEqual(statusOf(await pullAllHostUsage(db, false), link.id), offline);
  assert.equal(hostTokens(db, link.id), 8);
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
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM synced_hosts WHERE host_id = ?").get(link.id).c, 0);
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

  usageSyncTimings.waitMs = waitMs;
  gate.resolve();
  assert.equal(statusOf(await pullAllHostUsage(db, false), link.id).state, "current");
  assert.equal(hostTokens(db, link.id), 3);
  assert.equal(reads.length, 1, "the report that waited did not start a second pull");
});

test("a refresh prices a host's unchanged transcripts with its current models.yml", async (t) => {
  const db = freshDb();
  const project = join(agentDir, "sessions", "-priced");
  mkdirSync(project, { recursive: true });
  t.after(() => rmSync(join(agentDir, "sessions"), { recursive: true, force: true }));
  writeFileSync(join(project, "2026-01-01_priced.jsonl"), [
    JSON.stringify({ type: "session", id: "priced", cwd: "/work/priced", timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "message", id: "e1", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 1_000_000, output: 0 } } }),
  ].join("\n"));
  const price = (input) => writeFileSync(join(agentDir, "models.yml"), JSON.stringify({
    providers: { anthropic: { models: [{ id: "claude-opus-5-5", cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 } }] } },
  }));
  t.after(() => rmSync(join(agentDir, "models.yml"), { force: true }));

  // A linked host answering with the real ops, as its daemon does.
  const link = await linkHost("Priced");
  t.after(() => link.drop());
  void link.serve({
    listUsageTranscripts: ({ refresh }) => sessionOps.listUsageTranscripts(refresh),
    readUsageRecords: ({ requests }) => sessionOps.readUsageRecords(requests),
  });
  const cost = () => db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM usage_records WHERE host_id = ?").get(link.id).c;
  withoutTtl(t);

  price(2);
  await pullAllHostUsage(db, true);
  assert.equal(cost(), 2);

  price(5);
  await pullAllHostUsage(db, false);
  assert.equal(cost(), 2, "an unchanged transcript is not read again");
  await pullAllHostUsage(db, true);
  assert.equal(cost(), 5);
});

test("a transcript too large for one answer arrives in slices and is only stored whole", async (t) => {
  const db = freshDb();
  const project = join(agentDir, "sessions", "-large");
  const session = join(project, "2026-01-01_large.jsonl");
  const artifact = join(project, "2026-01-01_large", "Sub.jsonl");
  mkdirSync(join(project, "2026-01-01_large"), { recursive: true });
  t.after(() => rmSync(join(agentDir, "sessions"), { recursive: true, force: true }));
  const request = (id, input) => JSON.stringify({ type: "message", id, message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input, output: 0 } } });
  writeFileSync(session, [
    JSON.stringify({ type: "session", id: "large", cwd: "/work/large", timestamp: new Date().toISOString() }),
    ...[1, 2, 3, 4, 5].map((input) => request(`e${input}`, input)),
  ].join("\n"));
  writeFileSync(artifact, request("s1", 100));
  // Room for two of the session's records an answer: its five take three answers.
  const { USAGE_PAGE_LIMITS } = await import("./session-ops.ts");
  const bytes = USAGE_PAGE_LIMITS.bytes;
  const [record] = (await sessionOps.readUsageRecords([{ session, paths: [session] }])).value.files[0].records;
  USAGE_PAGE_LIMITS.bytes = 2 * Buffer.byteLength(JSON.stringify(record));
  t.after(() => { USAGE_PAGE_LIMITS.bytes = bytes; });

  const link = await linkHost("Large");
  t.after(() => link.drop());
  const reads = [];
  let failFrom = 3;
  void link.serve({
    listUsageTranscripts: ({ refresh }) => sessionOps.listUsageTranscripts(refresh),
    readUsageRecords: ({ requests }) => {
      reads.push(requests);
      return reads.length >= failFrom ? { ok: false, status: 500, code: "usage_unreadable", error: "disk on fire" } : sessionOps.readUsageRecords(requests);
    },
  });
  withoutTtl(t);
  captureWarnings(t);

  assert.equal(statusOf(await pullAllHostUsage(db, false), link.id).state, "stale");
  assert.equal(hostTokens(db, link.id), 0, "two slices of three were read: nothing of the transcript is stored");

  failFrom = Infinity;
  reads.length = 0;
  assert.equal(statusOf(await pullAllHostUsage(db, false), link.id).state, "current");
  assert.deepEqual(reads.map((requests) => [requests[0].skip ?? 0, pathsOf(requests)]), [
    [0, [session, artifact]],
    [2, [session, artifact]],
    [4, [session, artifact]],
    [0, [artifact]],
  ]);
  assert.deepEqual(db.prepare("SELECT input_tokens AS t FROM usage_records WHERE host_id = ? ORDER BY input_tokens").all(link.id).map((row) => row.t), [1, 2, 3, 4, 5, 100]);
});

for (const [label, mtimeMs, failure] of [
  ["Shifting", (read) => read, "Shifting changed a usage transcript while it was being read"],
  ["Endless", () => 1, "Endless sent more usage records than a transcript can hold"],
]) {
  test(`slices that ${label === "Shifting" ? "are of a transcript that changed in between" : "never end"} fail the pull and store nothing`, async (t) => {
    const db = freshDb();
    const link = await linkHost(label);
    t.after(() => link.drop());
    let reads = 0;
    serveUsage(link, new Map([["/s/a.jsonl", transcript("a", "/p", 1)]]), {
      ops: {
        readUsageRecords: () => {
          const slice = { path: "/s/a.jsonl", mtimeMs: mtimeMs(++reads), size: 3, records: transcript("a", "/p", reads).records, more: true };
          return { ok: true, value: { files: [slice], missing: [] } };
        },
      },
    });
    const warnings = captureWarnings(t);

    assert.equal(statusOf(await pullAllHostUsage(db, false), link.id).state, "stale");
    assert.equal(hostTokens(db, link.id), 0);
    assert.deepEqual(warnings, [`[omp-web] could not sync usage from host ${label}: ${failure}`]);
  });
}
