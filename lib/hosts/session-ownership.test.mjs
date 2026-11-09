import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { detectSessionOwnership, readSessionTailState, OWNERSHIP_ACTIVE_WINDOW_MS } = await import("./session-ownership.ts");
const { listOmpProcesses, parsePosixProcessList, resetOmpProcessCache, sameUserProcesses } = await import("./omp-processes.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");

// The uid a fixture must use: the one this process runs as, never a literal. On Windows `process.getuid` does not exist,
// and the scan keeps every row (the documented process-identity limit).
const RUNNING_UID = typeof process.getuid === "function" ? process.getuid() : null;

const scratch = mkdtempSync(join(tmpdir(), "omp-web-ownership-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let fixture = 0;
/** A throwaway agent dir with one session file; `records` are the JSONL lines after the header. */
function withSession(run, { records = [], ageMs = 0 } = {}) {
  fixture += 1;
  const id = `00000000-0000-4000-8000-${String(fixture).padStart(12, "0")}`;
  const agentDir = join(scratch, `agent-${fixture}`);
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, "2026-01-01_fixture.jsonl");
  const lines = [
    { type: "session", version: 3, id, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
    ...records,
  ];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    utimesSync(file, at, at);
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  return Promise.resolve(run({ id, file })).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
  });
}

/** A process row as `ps` reports it, owned by the running uid unless one is given. */
function row(pid, { ppid = 1, commandLine = "", uid = RUNNING_UID } = {}) {
  return uid === null ? { pid, ppid, commandLine } : { pid, ppid, commandLine, uid };
}

/** A scan answer; `processes` are already parsed rows (resume targets are computed by the caller's scan). */
function scanOf(processes, { ok = true, enabled = true } = {}) {
  return async () => ({ processes, ok, enabled });
}

/** A fixture's pids do not exist on this machine: the ownership check confirms a scan hit against the OS, so a test
 *  that wants a live writer says so explicitly. */
const alive = () => true;

const midTurn = [
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "do it" } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", provider: "t", model: "m", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] } },
];
const settled = [
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "do it" } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", provider: "t", model: "m", content: [{ type: "text", text: "done" }], stopReason: "end" } },
];
const exitRecord = { type: "custom", customType: "session_exit", id: "x1", parentId: "a1" };

test("a live foreign omp owns the file while idle; the tail only says whether it is mid-turn", () => withSession(async ({ id, file }) => {
  const processes = [row(200, { commandLine: `omp --resume ${file}` })];
  const running = await detectSessionOwnership([id], { scan: scanOf(processes), isAlive: alive });
  assert.equal(running.ok, true);
  assert.deepEqual(running.value, [{ id, owner: "foreign", running: true, source: "process", lastActivityAt: running.value[0].lastActivityAt }]);

  // The same live process, but the transcript settled: ownership stays, activity does not.
  const idle = await detectSessionOwnership([id], { scan: scanOf(processes), isAlive: alive, now: () => Date.now() + 1 });
  assert.equal(idle.value[0].owner, "foreign");
  // A trailing session_exit closes the turn even while the process lives.
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" })}\n${[...settled, exitRecord].map((line) => JSON.stringify(line)).join("\n")}\n`);
  const exited = await detectSessionOwnership([id], { scan: scanOf(processes), isAlive: alive });
  assert.equal(exited.value[0].owner, "foreign", "an idle writer still owns the file");
  assert.equal(exited.value[0].running, false);
}, { records: midTurn }));

test("a stale or closed transcript is not an owner and not activity", () => withSession(async ({ id, file }) => {
  const stale = await detectSessionOwnership([id], { scan: scanOf([]), now: () => Date.now() + OWNERSHIP_ACTIVE_WINDOW_MS + 1 });
  assert.deepEqual(stale.value, [{ id, owner: "none", running: false, lastActivityAt: stale.value[0].lastActivityAt }], "no source: the tail contributed nothing");

  // Fresh but closed by omp: no process, trailing exit -> nothing runs it.
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" })}\n${[...settled, exitRecord].map((line) => JSON.stringify(line)).join("\n")}\n`);
  const closed = await detectSessionOwnership([id], { scan: scanOf([]) });
  assert.equal(closed.value[0].owner, "none");
  assert.equal(closed.value[0].running, false);
}));

test("a fresh transcript without a process is an activity hint, never an owner", () => withSession(async ({ id }) => {
  const result = await detectSessionOwnership([id], { scan: scanOf([]) });
  assert.equal(result.value[0].owner, "none", "activity is not ownership: a send must not be blocked by it");
  assert.equal(result.value[0].running, true);
  assert.equal(result.value[0].source, "transcript");
}, { records: midTurn }));

test("a file that exists but cannot be read leaves activity unknown, not false", () => withSession(async ({ id }) => {
  const result = await detectSessionOwnership([id], { scan: scanOf([]), tail: () => null });
  assert.equal(result.value[0].owner, "none", "a successful scan still answers ownership");
  assert.equal("running" in result.value[0], false, "an unreadable tail cannot make `running: false` a fact");
  assert.equal(result.value[0].source, undefined);
  assert.equal(typeof result.value[0].lastActivityAt, "number", "the stat still says when it was written");
}, { records: midTurn }));

test("a failed or switched-off scan is unknown, never none, and claims no activity", () => withSession(async ({ id }) => {
  for (const scan of [scanOf([], { ok: false }), scanOf([], { enabled: false })]) {
    const result = await detectSessionOwnership([id], { scan });
    assert.equal(result.value[0].owner, "unknown");
    assert.equal("running" in result.value[0], false, "activity is unknown too, not false");
    assert.equal(result.value[0].source, undefined);
  }
}, { records: midTurn }));

test("the daemon's own children are ours: spawning, adopted, idle and running", () => withSession(async ({ id }) => {
  let scans = 0;
  const scan = async () => { scans += 1; throw new Error("a daemon-owned session must not need a process scan"); };
  for (const running of [true, false, undefined]) {
    const result = await detectSessionOwnership([id], { channel: () => ({ owned: true, running }), scan });
    assert.equal(result.value[0].owner, "daemon");
    assert.equal(result.value[0].source, "process");
    if (running === undefined) assert.equal("running" in result.value[0], false, "a channel that cannot say leaves activity unknown");
    else assert.equal(result.value[0].running, running);
  }
  assert.equal(scans, 0);
}, { records: midTurn }));

test("own children are excluded from the foreign scan by transport pid and by the Windows cmd.exe parent chain", () => withSession(async ({ id, file }) => {
  // 100 is a child of this daemon (its transport id); 101 is the real omp below a cmd.exe wrapper, one hop further.
  const own = [row(100, { ppid: 999, commandLine: `cmd.exe /c omp.cmd --resume ${file}` }), row(101, { ppid: 100, commandLine: `omp --resume ${file}` })];
  const ours = await detectSessionOwnership([id], { scan: scanOf(own), excludePids: () => [100], isAlive: alive });
  assert.equal(ours.value[0].owner, "none", "the daemon's own child never reads as a foreign writer");

  // A process outside that tree that names the same file is the foreign writer.
  const foreign = await detectSessionOwnership([id], { scan: scanOf([...own, row(200, { ppid: 1, commandLine: `omp --resume ${file}` })]), excludePids: () => [100], isAlive: alive });
  assert.equal(foreign.value[0].owner, "foreign");
}));

test("one bounded scan answers the whole batch, in request order", () => withSession(async ({ id, file }) => {
  let scans = 0;
  const other = "11111111-2222-4333-8444-555555555555";
  const result = await detectSessionOwnership([other, id, other], {
    scan: async () => { scans += 1; return { processes: [row(200, { commandLine: `omp --resume ${file}` })], ok: true, enabled: true }; },
    isAlive: alive,
  });
  assert.equal(scans, 1, "one ps/PowerShell call per host, not one per id");
  assert.deepEqual(result.value.map((entry) => [entry.id, entry.owner]), [[other, "none"], [id, "foreign"], [other, "none"]]);
}));

test("the batch is bounded and validated at the host boundary", () => withSession(async ({ id }) => {
  assert.equal((await detectSessionOwnership("nope", { scan: scanOf([]) })).status, 400);
  assert.equal((await detectSessionOwnership(["", id], { scan: scanOf([]) })).status, 400);
  const tooMany = Array.from({ length: 257 }, () => id);
  const rejected = await detectSessionOwnership(tooMany, { scan: scanOf([]) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "invalid_session_ids");
  const full = await detectSessionOwnership(Array.from({ length: 256 }, () => id), { scan: scanOf([]) });
  assert.equal(full.ok, true);
  assert.equal(full.value.length, 256);
}));

test("uid comes from the running process: same-user rows are kept, other-user rows dropped", async () => {
  const kept = row(200, { commandLine: "omp --resume a" });
  const dropped = row(201, { commandLine: "omp --resume b", uid: RUNNING_UID === null ? null : RUNNING_UID + 1 });
  const raw = [kept, dropped]
    .map((process) => `${process.pid} ${process.ppid} ${process.uid ?? 0} ${process.commandLine}`)
    .join("\n");
  const parsed = parsePosixProcessList(raw);
  const keptRows = sameUserProcesses(parsed, RUNNING_UID);
  if (RUNNING_UID === null) {
    // Windows: `process.getuid` does not exist, so the scan cannot tell users apart and keeps every row. That is the
    // documented process-identity limit, not an other-user exclusion.
    assert.deepEqual(keptRows.map((process) => process.pid), [200, 201]);
    return;
  }
  assert.deepEqual(keptRows.map((process) => process.pid), [200]);
  assert.deepEqual(parsed.map((process) => process.pid), [200, 201], "the other user's row was in the scan and got dropped");
  // And through the real scan boundary: the injected runner's rows are filtered by the running uid.
  resetOmpProcessCache();
  const scan = await listOmpProcesses({ platform: "linux", uid: RUNNING_UID, run: async () => raw });
  assert.deepEqual(scan.processes.map((process) => process.pid), [200]);
});

test("a scan that cannot run is unknown, and the next call retries instead of caching the failure", async () => {
  resetOmpProcessCache();
  let calls = 0;
  // win32: the scan runs the injected runner instead of resolving an absolute `ps` first.
  const failing = await listOmpProcesses({ platform: "win32", run: async () => { calls += 1; throw new Error("PowerShell missing"); } });
  assert.deepEqual(failing, { processes: [], ok: false, enabled: true });
  assert.equal(calls, 1);
  // Nothing was cached: the next caller asks again, and this one succeeds.
  const recovered = await listOmpProcesses({ platform: "win32", run: async () => { calls += 1; return JSON.stringify({ ProcessId: 200, ParentProcessId: 1, CommandLine: "omp --resume x" }); } });
  assert.equal(calls, 2);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.processes.map((process) => process.pid), [200]);
});

test("OMP_WEB_FOREIGN_SCAN=0 reports the scan as switched off, which the detector answers as unknown", () => withSession(async ({ id }) => {
  const previous = process.env.OMP_WEB_FOREIGN_SCAN;
  process.env.OMP_WEB_FOREIGN_SCAN = "0";
  try {
    const scan = await listOmpProcesses();
    assert.deepEqual(scan, { processes: [], ok: true, enabled: false });
    const result = await detectSessionOwnership([id], { scan: async () => scan });
    assert.equal(result.value[0].owner, "unknown");
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_FOREIGN_SCAN;
    else process.env.OMP_WEB_FOREIGN_SCAN = previous;
  }
}));

test("the tail reads a trailing session_exit as closed and a running tool as active", () => withSession(async ({ file }) => {
  const active = readSessionTailState(file);
  assert.equal(active?.looksActive, true);
  assert.equal(active?.hasTrailingExit, false);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "x", cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" })}\n${[...settled, exitRecord].map((line) => JSON.stringify(line)).join("\n")}\n`);
  const closed = readSessionTailState(file);
  assert.equal(closed?.looksActive, false);
  assert.equal(closed?.hasTrailingExit, true);
  assert.equal(Number.isInteger(closed?.mtimeMs), true, "epoch ms are integers: a fractional mtime breaks typed clients");
}, { records: midTurn }));
