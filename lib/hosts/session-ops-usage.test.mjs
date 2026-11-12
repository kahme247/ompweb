import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

// Installed before the ops load: chmod cannot make a path unreadable when the tests run as root.
const realFs = { ...await import("fs") };
const NO_FAULT = { readdir: null, stat: null, open: null, read: null, code: "EACCES" };
const fault = { ...NO_FAULT };
const cutShort = new Set();
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
  openSync(file, ...args) {
    if (file === fault.open) throw Object.assign(new Error("file cannot be opened"), { code: fault.code });
    const fd = realFs.openSync(file, ...args);
    if (file === fault.read) cutShort.add(fd);
    return fd;
  },
  // `fault.read`: every byte arrives, then the read that would have found the end of the file fails.
  readSync(fd, ...args) {
    const bytes = realFs.readSync(fd, ...args);
    if (bytes === 0 && cutShort.delete(fd)) throw Object.assign(new Error("read failed"), { code: fault.code });
    return bytes;
  },
}));

const unreadable = (result, what) => assert.deepEqual([result.ok, result.status, result.code], [false, 500, "usage_unreadable"], what);

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
    Object.assign(fault, NO_FAULT);
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
  test(`a directory or transcript that fails with ${code} fails the usage ops instead of reading as gone or empty`, () => withUsageAgentDir(async ({ alpha, subagent, advisor }) => {
    const requests = [{ session: alpha, paths: [alpha, subagent, advisor] }];
    for (const directory of [getSessionsDir(), dirname(alpha), dirname(subagent), dirname(advisor)]) {
      Object.assign(fault, NO_FAULT, { readdir: directory, code });
      unreadable(await sessionOps.listUsageTranscripts(false), `index with ${directory} unreadable`);
      unreadable(await sessionOps.readUsageRecords(requests), `read with ${directory} unreadable`);
    }
    Object.assign(fault, NO_FAULT, { stat: subagent, code });
    unreadable(await sessionOps.listUsageTranscripts(false), "index with a transcript that cannot be examined");
    unreadable(await sessionOps.readUsageRecords(requests), "read of a transcript that cannot be examined");
    Object.assign(fault, NO_FAULT, { open: advisor, code });
    unreadable(await sessionOps.readUsageRecords(requests), "read of a transcript that cannot be opened");
    Object.assign(fault, NO_FAULT, { read: advisor, code });
    unreadable(await sessionOps.readUsageRecords(requests), "read of a transcript that fails before its end");
    Object.assign(fault, NO_FAULT, { open: alpha, code });
    unreadable(await sessionOps.readUsageRecords([{ session: alpha, paths: [advisor] }]), "read of an artifact whose session cannot be opened");

    Object.assign(fault, NO_FAULT);
    const { files } = (await sessionOps.readUsageRecords(requests)).value;
    assert.deepEqual(files.map((file) => [file.path, file.records.length]), [[alpha, 1], [subagent, 1], [advisor, 1]], "no failed read was kept");
  }));
}

test("a listed directory that goes away, or a path that is no directory, fails the usage ops", () => withUsageAgentDir(async ({ alpha, subagent, advisor }) => {
  for (const directory of [getSessionsDir(), dirname(alpha), dirname(subagent), dirname(advisor)]) {
    Object.assign(fault, NO_FAULT, { readdir: directory, code: "ENOENT" });
    unreadable(await sessionOps.listUsageTranscripts(false), `index with ${directory} gone while it is still there`);
  }
  for (const directory of [getSessionsDir(), dirname(subagent)]) {
    Object.assign(fault, NO_FAULT, { readdir: directory, code: "ENOTDIR" });
    unreadable(await sessionOps.listUsageTranscripts(false), `index with ${directory} or a parent of it no directory`);
  }
}));

test("a sessions root or artifacts directory that links to nothing fails the usage ops", { skip: process.platform === "win32" }, () => withUsageAgentDir(async ({ agentDir, alpha, subagent }) => {
  const artifacts = dirname(subagent);
  rmSync(artifacts, { recursive: true });
  symlinkSync(join(agentDir, "unmounted"), artifacts);
  unreadable(await sessionOps.listUsageTranscripts(false), "index with an artifacts directory linking to nothing");
  unreadable(await sessionOps.readUsageRecords([{ session: alpha, paths: [alpha] }]), "read with an artifacts directory linking to nothing");
  rmSync(artifacts);
  assert.equal((await sessionOps.listUsageTranscripts(false)).ok, true);

  const root = getSessionsDir();
  renameSync(root, join(agentDir, "moved"));
  symlinkSync(join(agentDir, "unmounted"), root);
  unreadable(await sessionOps.listUsageTranscripts(false), "index with a sessions root linking to nothing");
}));

test("a transcript deleted between its stamp and its read comes back missing", () => withUsageAgentDir(async ({ alpha, subagent, advisor }) => {
  Object.assign(fault, NO_FAULT, { open: subagent, code: "ENOENT" });
  const result = await sessionOps.readUsageRecords([{ session: alpha, paths: [alpha, subagent, advisor] }]);
  assert.deepEqual(result.value.files.map((file) => file.path), [alpha, advisor]);
  assert.deepEqual(result.value.missing, [subagent]);
}));

const weigh = (record) => Buffer.byteLength(JSON.stringify(record));
/** The serialized size of the one record `path` holds. */
const recordSize = async (session, path) => weigh((await sessionOps.readUsageRecords([{ session, paths: [path] }])).value.files[0].records[0]);

test("an answer at its byte limit leaves the rest out; asking for the rest again reads all of it", () => withUsageAgentDir(async ({ alpha, subagent, advisor, beta }) => {
  // Room for any one of the four records, never for two.
  USAGE_PAGE_LIMITS.bytes = Math.max(await recordSize(alpha, alpha), await recordSize(alpha, subagent), await recordSize(alpha, advisor), await recordSize(beta, beta));
  let pending = [{ session: alpha, paths: [alpha, subagent, advisor] }, { session: beta, paths: [beta] }];
  const read = [];
  while (pending.length > 0) {
    const page = await sessionOps.readUsageRecords(pending);
    assert.equal(page.ok, true);
    assert.deepEqual(page.value.files.map((file) => [file.records.length, file.more ?? false]), [[1, false]], "each answer still makes progress");
    assert.deepEqual(page.value.missing, []);
    read.push(page.value.files[0].path);
    pending = pending
      .map(({ session, paths }) => ({ session, paths: paths.filter((path) => !read.includes(path)) }))
      .filter((request) => request.paths.length > 0);
  }
  assert.deepEqual(read, [alpha, subagent, advisor, beta]);
}));

test("a transcript too large for one answer goes out in slices, each the last file of its answer", () => withUsageAgentDir(async ({ alpha, beta }) => {
  writeTranscript(beta, [
    { type: "session", id: "beta", cwd: "/work/alpha", timestamp: new Date(STARTED).toISOString() },
    ...[1, 2, 3, 4, 5].map((input) => assistant(`b${input}`, input, 1000 * input)),
  ]);
  USAGE_PAGE_LIMITS.bytes = 2 * await recordSize(beta, beta);
  const answer = async (skip) => {
    const page = (await sessionOps.readUsageRecords([{ session: beta, paths: [beta], skip }, { session: alpha, paths: [alpha] }])).value;
    return page.files.map((file) => [file.path, file.records.map((record) => record.input), file.more ?? false]);
  };
  assert.deepEqual(await answer(undefined), [[beta, [1, 2], true]]);
  assert.deepEqual(await answer(2), [[beta, [3, 4], true]]);
  assert.deepEqual(await answer(4), [[beta, [5], false]], "the last slice leaves no room for the next transcript");
  assert.deepEqual(await answer(5), [[beta, [], false], [alpha, [100], false]]);
  assert.deepEqual(await answer(99), [[beta, [], false], [alpha, [100], false]]);
}));

test("answers are bounded by what their records weigh serialized; a record no answer could carry is left out", () => withUsageAgentDir(async ({ beta }) => {
  const long = (id, input, model) => ({ ...assistant(id, input, 1000 * input), message: { role: "assistant", provider: "anthropic", model, usage: { input, output: 10, cost: { total: 0.25 } } } });
  const model = "m".repeat(5000);
  writeTranscript(beta, [
    { type: "session", id: "beta", cwd: "/work/alpha", timestamp: new Date(STARTED).toISOString() },
    long("b1", 1, model), long("b2", 2, model), long("b3", 3, "x".repeat(40_000)), long("b4", 4, model),
  ]);
  // Two of the long records, and nowhere near the 40 000 characters of the third.
  const limit = 2 * await recordSize(beta, beta);
  USAGE_PAGE_LIMITS.bytes = limit;
  const answers = [];
  for (let skip = 0, more = true; more; skip += answers.at(-1).records.length) {
    const [file] = (await sessionOps.readUsageRecords([{ session: beta, paths: [beta], skip }])).value.files;
    answers.push(file);
    more = file.more === true;
  }
  assert.deepEqual(answers.map((file) => file.records.map((record) => record.input)), [[1, 2], [4]]);
  for (const file of answers) assert.ok(weigh(file.records) <= limit + 16, "no answer outgrows the limit");
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
  for (const requests of [undefined, {}, [alpha], [{ session: alpha }], [{ session: 1, paths: [] }], [{ session: alpha, paths: [1] }], [{ session: alpha, paths: [alpha], skip: -1 }], [{ session: alpha, paths: [alpha], skip: 1.5 }]]) {
    const result = await sessionOps.readUsageRecords(requests);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, "invalid_request");
  }
}));
