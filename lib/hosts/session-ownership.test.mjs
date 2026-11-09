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
  // An empty batch is a caller bug, not an empty answer: the spec promises 400.
  const empty = await detectSessionOwnership([], { scan: scanOf([]) });
  assert.equal(empty.status, 400);
  const tooMany = Array.from({ length: 257 }, () => id);
  const rejected = await detectSessionOwnership(tooMany, { scan: scanOf([]) });
  assert.equal(rejected.ok, false);
  // One code for one condition, matching the dispatch's 400 `invalid_request`.
  assert.equal(rejected.code, "invalid_request");
  const full = await detectSessionOwnership(Array.from({ length: 256 }, () => id), { scan: scanOf([]) });
  assert.equal(full.ok, true);
  assert.equal(full.value.length, 256);
}));

test("both platform scan shapes parse and filter: POSIX drops another uid, Windows keeps every row and narrows by name", async () => {
  // The POSIX shape is exercised on every host (the daemon picks the parser by platform, so a Windows-only run would
  // otherwise never reach `parsePosixProcessList`). The uid is this process's own, never a literal.
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const other = uid + 1;
  const posixRaw = [
    `${200} ${1} ${uid} omp --resume a`,
    `${201} ${1} ${other} omp --resume b`,
    `${202} ${1} ${uid} /usr/bin/grep -r a /tmp`,
  ].join("\n");
  const parsed = parsePosixProcessList(posixRaw);
  assert.deepEqual(parsed.map((process) => process.pid), [200, 201, 202], "every row parsed, including the other user's");
  assert.deepEqual(sameUserProcesses(parsed, uid).map((process) => process.pid), [200, 202], "the other user's row is dropped");
  // Through the real scan boundary: the injected runner's rows are filtered by the uid the daemon passes.
  resetOmpProcessCache();
  const posixScan = await listOmpProcesses({ platform: "linux", uid, psBin: "/bin/ps", run: async () => posixRaw });
  assert.equal(posixScan.ok, true);
  assert.deepEqual(posixScan.processes.map((process) => process.pid), [200, 202]);

  // No absolute `ps` is "unknown", never a fallback to PATH.
  resetOmpProcessCache();
  const noPs = await listOmpProcesses({ platform: "linux", uid, psBin: null, run: async () => posixRaw });
  assert.deepEqual(noPs, { processes: [], ok: false, enabled: true });

  // The Windows shape: `process.getuid` does not exist there, so the scan keeps every row — the documented
  // process-identity limit — and narrows by process name instead.
  resetOmpProcessCache();
  const windowsRaw = JSON.stringify([
    { ProcessId: 300, ParentProcessId: 1, Name: "omp.exe", CommandLine: "omp.exe --resume a" },
    { ProcessId: 301, ParentProcessId: 1, Name: "node.exe", CommandLine: "node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@oh-my-pi\\cli.js --resume b" },
    { ProcessId: 302, ParentProcessId: 1, Name: "cmd.exe", CommandLine: "cmd.exe /c C:\\bin\\omp.cmd --resume c" },
  ]);
  const windowsScan = await listOmpProcesses({ platform: "win32", uid: null, run: async () => windowsRaw });
  assert.equal(windowsScan.ok, true);
  assert.deepEqual(windowsScan.processes.map((process) => process.pid), [300, 301, 302], "no uid filter on Windows: every row is kept");
  assert.deepEqual(windowsScan.processes.map((process) => process.name), ["omp.exe", "node.exe", "cmd.exe"]);
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

test("a stale scan row is not an owner: the liveness probe is what discards a process that already exited", () => withSession(async ({ id, file }) => {
  // A scan is cached for 10 s, so it still lists a terminal `omp` that exited a moment ago. The default probe (no
  // `isAlive` injected) must discard it, or a closed session stays blocked for the rest of the TTL.
  const processes = [row(2147483000, { commandLine: `omp --resume ${file}` })];
  const stale = await detectSessionOwnership([id], { scan: scanOf(processes) });
  assert.equal(stale.value[0].owner, "none", "a dead pid in a cached scan is not a live writer");
  // The same row with a live pid (this process) is the writer: the probe, not the row, decides.
  const live = await detectSessionOwnership([id], { scan: scanOf([row(process.pid, { commandLine: `omp --resume ${file}` })]) });
  assert.equal(live.value[0].owner, "foreign");
}, { records: midTurn }));

test("a tail window that parsed no complete record leaves activity unknown, not idle", () => withSession(async ({ id, file }) => {
  // One 200 KiB record fills the 64 KiB window: the partial first line is dropped and nothing parses. The transcript's
  // end is not in the window, so `running: false` would be a fact the inspection cannot establish.
  const header = { type: "session", version: 3, id, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" };
  const huge = { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: "x".repeat(200 * 1024) } };
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(huge)}\n`);
  const tail = readSessionTailState(file);
  assert.equal(tail?.records, 0, "the window holds one oversized record and parses nothing");
  const result = await detectSessionOwnership([id], { scan: scanOf([]) });
  assert.equal(result.value[0].owner, "none");
  assert.equal("running" in result.value[0], false, "an unparsed window cannot say the turn ended");
  assert.equal(result.value[0].source, undefined);
}, { records: midTurn }));

test("an id whose file does not resolve is still matched by the process that names it", () => withSession(async ({ id }) => {
  // The stale-list-cache case: a foreign `omp` created this session after the 30 s list cache was warmed, so
  // `resolveSessionPath` returns null. Before the scan saw only resolved files, this answered a definite `none`.
  const fresh = "99999999-8888-4777-8666-555555555555";
  const { listAllSessions } = await import("../session-reader.ts");
  await listAllSessions();
  assert.equal(await (await import("../session-reader.ts")).resolveSessionPath(fresh), null, "the id has no resolvable file");
  const result = await detectSessionOwnership([id, fresh], {
    scan: scanOf([row(200, { commandLine: `omp --resume ${fresh}` })]),
    isAlive: alive,
  });
  assert.deepEqual(result.value.map((entry) => [entry.id, entry.owner]), [[id, "none"], [fresh, "foreign"]],
    "an unresolvable file must never turn a named writer into `none`");
}));

test("a daemon-owned session reports last activity from its channel's file", () => withSession(async ({ id, file }) => {
  const result = await detectSessionOwnership([id], {
    channel: () => ({ owned: true, running: false, sessionFile: file }),
    scan: async () => { throw new Error("a daemon-owned session must not need a process scan"); },
  });
  assert.equal(result.value[0].owner, "daemon");
  assert.equal(typeof result.value[0].lastActivityAt, "number", "the contract promises last activity whenever it can be read");
  // A channel that knows no file (a legacy spawn before get_state) still answers ownership without activity.
  const unknownFile = await detectSessionOwnership([id], { channel: () => ({ owned: true }) });
  assert.equal("lastActivityAt" in unknownFile.value[0], false);
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
