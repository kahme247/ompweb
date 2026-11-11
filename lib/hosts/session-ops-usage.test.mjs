import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { sessionOps, USAGE_PAGE_LIMITS } = await import("./session-ops.ts");
const { getSessionsDir } = await import("../omp/paths.ts");
const { invalidateSessionFileListCache } = await import("../omp/session-files.ts");
const { USAGE_PARSER_VERSION } = await import("../usage-service.ts");

const STARTED = Date.parse("2026-01-01T00:00:00.000Z");

function assistant(id, input, offset) {
  return {
    type: "message",
    id,
    timestamp: new Date(STARTED + offset).toISOString(),
    message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input, output: 10, cost: { total: 0.25 } } },
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
  invalidateSessionFileListCache();
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
    Object.assign(USAGE_PAGE_LIMITS, savedLimits);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionFileListCache();
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

test("artifact transcripts are read as usage of the session that owns them", () => withUsageAgentDir(async ({ alpha, subagent, advisor }) => {
  const result = await sessionOps.readUsageRecords([{ session: alpha, paths: [alpha, subagent, advisor] }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.missing, []);
  assert.deepEqual(result.value.unread, []);
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
  assert.deepEqual(result.value.unread, []);
}));

test("a transcript deleted since the index comes back missing", () => withUsageAgentDir(async ({ alpha, subagent }) => {
  rmSync(subagent);
  const result = await sessionOps.readUsageRecords([{ session: alpha, paths: [alpha, subagent] }]);
  assert.deepEqual(result.value.files.map((file) => file.path), [alpha]);
  assert.deepEqual(result.value.missing, [subagent]);
}));

test("a page over its byte limit returns the rest as unread, per request", () => withUsageAgentDir(async ({ alpha, subagent, advisor, beta }) => {
  USAGE_PAGE_LIMITS.bytes = 1;
  const requests = [{ session: alpha, paths: [alpha, subagent, advisor] }, { session: beta, paths: [beta] }];
  const first = await sessionOps.readUsageRecords(requests);
  assert.equal(first.ok, true);
  assert.deepEqual(first.value.files.map((file) => file.path), [alpha]);
  assert.deepEqual(first.value.unread, [{ session: alpha, paths: [subagent, advisor] }, { session: beta, paths: [beta] }]);

  const read = [alpha];
  let pending = first.value.unread;
  while (pending.length > 0) {
    const page = await sessionOps.readUsageRecords(pending);
    assert.equal(page.value.files.length, 1, "each page still makes progress");
    read.push(page.value.files[0].path);
    pending = page.value.unread;
  }
  assert.deepEqual(read, [alpha, subagent, advisor, beta]);
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
