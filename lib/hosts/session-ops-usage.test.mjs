import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

// Installed before the ops load: chmod cannot make a path unreadable when the tests run as root.
const realFs = { ...await import("fs") };
const fault = { readdir: null, stat: null, code: "EACCES" };
mock.module("fs", () => ({
  ...realFs,
  readdirSync(directory, ...args) {
    if (directory === fault.readdir) throw Object.assign(new Error("directory unreadable"), { code: fault.code });
    return realFs.readdirSync(directory, ...args);
  },
  statSync(file, ...args) {
    if (file === fault.stat) throw Object.assign(new Error("file unreadable"), { code: fault.code });
    return realFs.statSync(file, ...args);
  },
}));

const { sessionOps, USAGE_PAGE_LIMITS } = await import("./session-ops.ts");
const { getSessionsDir } = await import("../omp/paths.ts");
const { USAGE_PARSER_VERSION } = await import("../usage-service.ts");

const STARTED = Date.parse("2026-01-01T00:00:00.000Z");

function assistant(id, input, offset, usage = { cost: { total: 0.25 } }) {
  return {
    type: "message",
    id,
    timestamp: new Date(STARTED + offset).toISOString(),
    message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input, output: 10, ...usage } },
  };
}

function writeTranscript(path, lines) {
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/**
 * Agent dir with two sessions: `alpha` has a subagent transcript, an empty
 * artifact and an advisor transcript; `beta` has one request.
 */
async function withUsageAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-ops-usage-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const savedLimits = { ...USAGE_PAGE_LIMITS };
  try {
    const projectDir = join(getSessionsDir(), "-work-alpha");
    mkdirSync(projectDir, { recursive: true });
    const alpha = join(projectDir, "2026-01-01_alpha.jsonl");
    writeTranscript(alpha, [
      { type: "session", id: "alpha", cwd: "/work/alpha", timestamp: new Date(STARTED).toISOString() },
      assistant("a1", 100, 1000),
    ]);
    const artifacts = join(projectDir, "2026-01-01_alpha");
    mkdirSync(join(artifacts, "Sub"), { recursive: true });
    const subagent = join(artifacts, "Sub.jsonl");
    writeTranscript(subagent, [
      { type: "session", id: "sub-own-id", cwd: "/elsewhere", timestamp: new Date(STARTED + 500).toISOString() },
      assistant("s1", 200, 2000),
    ]);
    const advisor = join(artifacts, "Sub", "__advisor.jsonl");
    writeTranscript(advisor, [assistant("v1", 300, 3000)]);
    writeFileSync(join(artifacts, "Empty.jsonl"), "");
    const beta = join(projectDir, "2026-01-02_beta.jsonl");
    writeTranscript(beta, [
      { type: "session", id: "beta", cwd: "/work/alpha", timestamp: new Date(STARTED).toISOString() },
      assistant("b1", 400, 4000),
    ]);
    await run({ agentDir, alpha, subagent, advisor, beta });
  } finally {
    Object.assign(fault, { readdir: null, stat: null, code: "EACCES" });
    Object.assign(USAGE_PAGE_LIMITS, savedLimits);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("the usage index lists each session with its artifact transcripts and skips empty files", () => withUsageAgentDir(async ({ alpha, subagent, advisor, beta }) => {
  const result = await sessionOps.listUsageTranscripts(true);
  assert.equal(result.ok, true);
  assert.equal(result.value.parserVersion, USAGE_PARSER_VERSION);
  const listed = Object.fromEntries(result.value.sessions.map(({ session, transcripts }) => [session, transcripts.map((t) => t.path).sort()]));
  assert.deepEqual(listed, { [alpha]: [alpha, subagent, advisor].sort(), [beta]: [beta] });
  for (const { transcripts } of result.value.sessions) {
    for (const stamp of transcripts) {
      assert.ok(stamp.size > 0 && Number.isFinite(stamp.mtimeMs), `${stamp.path} is stamped`);
    }
  }
}));

test("a host without a sessions directory has an empty usage index", () => withUsageAgentDir(async () => {
  rmSync(getSessionsDir(), { recursive: true });
  assert.deepEqual(await sessionOps.listUsageTranscripts(false), { ok: true, value: { parserVersion: USAGE_PARSER_VERSION, sessions: [] } });
}));

test("artifact transcripts are read as usage of the session that owns them", () => withUsageAgentDir(async ({ alpha, subagent, advisor }) => {
  const result = await sessionOps.readUsageRecords([{ session: alpha, paths: [alpha, subagent, advisor] }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.missing, []);
  const byPath = new Map(result.value.files.map((file) => [file.path, file]));
  assert.deepEqual([...byPath.keys()], [alpha, subagent, advisor]);
  for (const [path, input] of [[alpha, 100], [subagent, 200], [advisor, 300]]) {
    const [record] = byPath.get(path).records;
    assert.equal(record.input, input);
    assert.equal(record.sessionId, "alpha");
    assert.equal(record.sessionCwd, "/work/alpha");
    assert.equal(record.sessionStarted, STARTED);
    assert.equal(record.cost, 0.25);
  }
}));

test("paths a session does not list come back missing and are never read", () => withUsageAgentDir(async ({ agentDir, alpha, beta }) => {
  const outside = join(agentDir, "outside.jsonl");
  writeTranscript(outside, [assistant("x1", 1, 0)]);
  const result = await sessionOps.readUsageRecords([
    { session: alpha, paths: [beta, "/etc/hosts", outside, `${alpha}/../2026-01-02_beta.jsonl`] },
    { session: outside, paths: [outside] },
    { session: "/etc/hosts", paths: ["/etc/hosts"] },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.files, []);
  assert.deepEqual(result.value.missing, [beta, "/etc/hosts", outside, `${alpha}/../2026-01-02_beta.jsonl`, outside, "/etc/hosts"]);
}));

test("a transcript deleted since the index comes back missing", () => withUsageAgentDir(async ({ alpha, subagent }) => {
  rmSync(subagent);
  const result = await sessionOps.readUsageRecords([{ session: alpha, paths: [alpha, subagent] }]);
  assert.deepEqual(result.value.files.map((file) => file.path), [alpha]);
  assert.deepEqual(result.value.missing, [subagent]);
}));

for (const code of ["EACCES", "EIO"]) {
  test(`a directory or transcript that fails with ${code} fails the usage ops instead of reading as gone`, () => withUsageAgentDir(async ({ alpha, subagent, advisor }) => {
    const requests = [{ session: alpha, paths: [alpha, subagent, advisor] }];
    const unreadable = (result, what) => assert.deepEqual([result.ok, result.status, result.code], [false, 500, "usage_unreadable"], what);
    for (const directory of [getSessionsDir(), dirname(alpha), dirname(subagent), dirname(advisor)]) {
      Object.assign(fault, { readdir: directory, stat: null, code });
      unreadable(await sessionOps.listUsageTranscripts(false), `index with ${directory} unreadable`);
      unreadable(await sessionOps.readUsageRecords(requests), `read with ${directory} unreadable`);
    }
    Object.assign(fault, { readdir: null, stat: subagent, code });
    unreadable(await sessionOps.listUsageTranscripts(false), "index with a transcript that cannot be examined");
    unreadable(await sessionOps.readUsageRecords(requests), "read of a transcript that cannot be examined");

    Object.assign(fault, { readdir: null, stat: null });
    assert.deepEqual((await sessionOps.readUsageRecords(requests)).value.files.map((file) => file.path), [alpha, subagent, advisor]);
  }));
}

test("a page over its byte limit leaves the rest out; asking for the rest again reads all of it", () => withUsageAgentDir(async ({ alpha, subagent, advisor, beta }) => {
  USAGE_PAGE_LIMITS.bytes = 1;
  let pending = [{ session: alpha, paths: [alpha, subagent, advisor] }, { session: beta, paths: [beta] }];
  const read = [];
  while (pending.length > 0) {
    const page = await sessionOps.readUsageRecords(pending);
    assert.equal(page.ok, true);
    assert.equal(page.value.files.length, 1, "each page still makes progress");
    assert.deepEqual(page.value.missing, []);
    read.push(page.value.files[0].path);
    pending = pending
      .map(({ session, paths }) => ({ session, paths: paths.filter((path) => !read.includes(path)) }))
      .filter((request) => request.paths.length > 0);
  }
  assert.deepEqual(read, [alpha, subagent, advisor, beta]);
}));

test("a refreshed index drops the prices earlier reads were answered with", () => withUsageAgentDir(async ({ agentDir, beta }) => {
  // No provider-reported cost: the price comes from models.yml.
  writeTranscript(beta, [
    { type: "session", id: "beta", cwd: "/work/alpha", timestamp: new Date(STARTED).toISOString() },
    assistant("b1", 1_000_000, 4000, { output: 0 }),
  ]);
  const price = (input) => writeFileSync(join(agentDir, "models.yml"), JSON.stringify({
    providers: { anthropic: { models: [{ id: "claude-sonnet-4-5", cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 } }] } },
  }));
  const cost = async () => (await sessionOps.readUsageRecords([{ session: beta, paths: [beta] }])).value.files[0].records[0].cost;

  price(2);
  await sessionOps.listUsageTranscripts(true);
  assert.equal(await cost(), 2);
  price(5);
  await sessionOps.listUsageTranscripts(false);
  assert.equal(await cost(), 2, "an unchanged transcript keeps its cached records");
  await sessionOps.listUsageTranscripts(true);
  assert.equal(await cost(), 5);
}));

test("malformed usage arguments are 400 invalid_request", () => withUsageAgentDir(async ({ alpha }) => {
  for (const refresh of [undefined, "true", 1]) {
    const result = await sessionOps.listUsageTranscripts(refresh);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, "invalid_request");
  }
  for (const requests of [undefined, {}, [alpha], [{ session: alpha }], [{ session: 1, paths: [] }], [{ session: alpha, paths: [1] }]]) {
    const result = await sessionOps.readUsageRecords(requests);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, "invalid_request");
  }
}));
