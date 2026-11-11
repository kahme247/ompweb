import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { sessionOps } = await import("./session-ops.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");
const hub = await import("./hub.ts");
const { linkHost, linkLocalDaemon } = await import("./link-driver.test-helper.mjs");

const FIRST_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "11111111-2222-4333-8444-555555555556";
const MISSING_ID = "11111111-2222-4333-8444-555555555557";
const FOURTH_ID = "11111111-2222-4333-8444-555555555558";

async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-daemon-search-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const paths = [FIRST_ID, OTHER_ID].map((id) => {
    const file = join(projectDir, `2026-01-01_${id}.jsonl`);
    const lines = [
      { type: "session", version: 3, id, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z", title: "Template review" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Review the rendering workflow" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: `Use ${id === FIRST_ID ? "Jinja2" : "jinja2"} templates with a kubernetes deployment.` }] } },
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "Thanks, that is complete." } },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return file;
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  globalThis.__ompSessionContentSearchCache = undefined;
  try {
    return await run(paths);
  } finally {
    hub.flushLinkSamples();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    globalThis.__ompSessionContentSearchCache = undefined;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("daemon search finds middle-of-transcript Jinja only in the requested session over the link", () => withAgentDir(async ([firstPath, otherPath]) => {
  const link = await linkLocalDaemon();
  try {
    const result = await hub.getHost("local").sessionOps.searchSessionBatch("Jinja", [FIRST_ID]);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.value), [FIRST_ID]);
    assert.ok(result.value[FIRST_ID] > 0);
    assert.equal(globalThis.__ompSessionContentSearchCache.has(firstPath), true);
    assert.equal(globalThis.__ompSessionContentSearchCache.has(otherPath), false, "unrequested transcripts are not extracted");
  } finally {
    link.drop();
  }
}));

test("daemon search matches case-insensitively but ranks matching capitalization higher", () => withAgentDir(async () => {
  for (const [query, preferred, other] of [["Jinja", FIRST_ID, OTHER_ID], ["jinja", OTHER_ID, FIRST_ID]]) {
    const result = await sessionOps.searchSessionBatch(query, [FIRST_ID, OTHER_ID]);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.value).sort(), [FIRST_ID, OTHER_ID]);
    assert.ok(result.value[other] > 0);
    assert.ok(result.value[preferred] > result.value[other]);
  }
}));

test("daemon search reuses fuzzy scoring and keeps cached text across requested batches", () => withAgentDir(async ([firstPath, otherPath]) => {
  const first = await sessionOps.searchSessionBatch("kubernetis", [FIRST_ID]);
  assert.equal(first.ok, true);
  assert.deepEqual(Object.keys(first.value), [FIRST_ID]);
  assert.ok(first.value[FIRST_ID] > 0);
  const cached = globalThis.__ompSessionContentSearchCache.get(firstPath);

  const other = await sessionOps.searchSessionBatch("kubernetis", [OTHER_ID]);
  assert.equal(other.ok, true);
  assert.deepEqual(Object.keys(other.value), [OTHER_ID]);
  assert.ok(other.value[OTHER_ID] > 0);
  assert.equal(globalThis.__ompSessionContentSearchCache.get(firstPath), cached);
  assert.ok(globalThis.__ompSessionContentSearchCache.has(otherPath));

  assert.deepEqual(await sessionOps.searchSessionBatch("kubernetis", [FIRST_ID]), first);
  assert.equal(globalThis.__ompSessionContentSearchCache.get(firstPath), cached);
}));

test("daemon search accepts both limits and omits valid but missing ids", () => withAgentDir(async () => {
  const result = await sessionOps.searchSessionBatch(`Jinja${" ".repeat(495)}`, [FIRST_ID, OTHER_ID, MISSING_ID, FOURTH_ID]);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), [FIRST_ID, OTHER_ID]);
  assert.deepEqual(await sessionOps.searchSessionBatch("Jinja", []), { ok: true, value: {} });
  assert.deepEqual(await sessionOps.searchSessionBatch("", [FIRST_ID]), { ok: true, value: {} });
}));

test("daemon search rejects invalid query and batch inputs before session IO", () => withAgentDir(async () => {
  for (const [query, ids] of [
    [null, [FIRST_ID]],
    [42, [FIRST_ID]],
    ["x".repeat(501), [FIRST_ID]],
    ["Jinja", undefined],
    ["Jinja", FIRST_ID],
    ["Jinja", Array(5).fill(FIRST_ID)],
    ["Jinja", [FIRST_ID, "../../other"]],
    ["Jinja", [null]],
    ["Jinja", [42]],
  ]) {
    const result = await sessionOps.searchSessionBatch(query, ids);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(globalThis.__piSessionListCache, undefined, "invalid requests never list sessions");
    assert.equal(globalThis.__ompSessionContentSearchCache, undefined, "invalid requests never extract transcripts");
  }
}));

test("hub accepts only bounded requested score maps and preserves older-host failures", () => withAgentDir(async () => {
  const link = await linkHost("Search scores");
  const ops = hub.getHost(link.id).sessionOps;
  const answer = async (result, ids = [FIRST_ID]) => {
    const pending = ops.searchSessionBatch("Jinja", ids);
    const req = await link.next();
    assert.equal(req.op, "searchSessionBatch");
    assert.deepEqual(req.args, { query: "Jinja", ids });
    await link.answer(req, result);
    return pending;
  };
  try {
    for (const value of [null, [], { [OTHER_ID]: 1 }, { [FIRST_ID]: -1 }, { [FIRST_ID]: "1" }, { [FIRST_ID]: null }]) {
      await assert.rejects(answer({ ok: true, value }), (error) => error.status === 502 && error.code === "host_bad_result");
    }
    // A valid JSON number can overflow to Infinity without being serialized back to null.
    const overflow = ops.searchSessionBatch("Jinja", [FIRST_ID]);
    const overflowReq = await link.next();
    const rejectedOverflow = assert.rejects(overflow, (error) => error.status === 502 && error.code === "host_bad_result");
    link.socket.frame(`{"type":"ack","ack":${link.ack}}\n{"type":"res","seq":${++link.upSeq},"id":${JSON.stringify(overflowReq.id)},"ok":true,"result":{"ok":true,"value":{"${FIRST_ID}":1e309}}}\n`);
    await rejectedOverflow;

    const ids = [FIRST_ID, OTHER_ID, MISSING_ID, FOURTH_ID, "11111111-2222-4333-8444-555555555559"];
    await assert.rejects(answer({ ok: true, value: Object.fromEntries(ids.map((id) => [id, 1])) }, ids), (error) => error.status === 502 && error.code === "host_bad_result");
    const valid = { ok: true, value: { [FIRST_ID]: 0 } };
    assert.deepEqual(await answer(valid), valid);
    const failure = { ok: false, status: 400, code: "invalid_request", error: "Invalid search batch" };
    assert.deepEqual(await answer(failure), failure);

    const pending = ops.searchSessionBatch("Jinja", [FIRST_ID]);
    const req = await link.next();
    const refused = assert.rejects(pending, (error) => error.status === 501 && error.code === "unknown_op");
    await link.post({ type: "res", id: req.id, ok: false, error: { status: 501, code: "unknown_op", message: "Unknown host op" } });
    await refused;
  } finally {
    link.drop();
  }
}));
