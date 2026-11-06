import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  ELSEWHERE_ACTIVE_WINDOW_MS,
  ELSEWHERE_REFRESH_MS,
  detectSessionOwner,
  getElsewhereSessions,
  refreshElsewhereSessions,
  resetElsewhereSessions,
  setElsewhereChangeNotifier,
  setElsewhereOwnershipContext,
} = await import("./session-owner.ts");
const { resetOmpProcessCache, setOmpProcessScanRunner } = await import("./omp-processes.ts");
const { readForeignRunningLists } = await import("./session-resume.ts");

const SESSION_ID = "01a17cd4-6f4c-7d5e-8a90-112233445566";
const dir = mkdtempSync(join(tmpdir(), "omp-web-session-owner-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

let fileCounter = 0;
/** A session file whose transcript ends in assistant text (a finished turn). */
function sessionFile({ exit = false } = {}) {
  fileCounter += 1;
  const path = join(dir, `2026-10-27_session-${fileCounter}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: SESSION_ID, cwd: dir, timestamp: "2026-10-27T10:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ];
  if (exit) lines.push({ type: "custom", customType: "session_exit", id: "x1", parentId: null, data: { reason: "dispose" } });
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

/** Process list output in the shape the host's scanner would emit. */
function processOutput(entries) {
  return process.platform === "win32"
    ? JSON.stringify(entries.map(({ pid, ppid, commandLine }) => ({ ProcessId: pid, ParentProcessId: ppid, CommandLine: commandLine })))
    : `${entries.map(({ pid, ppid, commandLine }) => `${pid} ${ppid ?? 1} 1000 ${commandLine}`).join("\n")}\n`;
}

test.afterEach(() => {
  setOmpProcessScanRunner(null);
  resetOmpProcessCache();
  resetElsewhereSessions();
  setElsewhereChangeNotifier(() => {});
  setElsewhereOwnershipContext(null);
});

test("a local live wrapper is never elsewhere", async () => {
  const file = sessionFile();
  assert.equal(await detectSessionOwner(SESSION_ID, file, { isLocal: () => true }), null);
});

test("another omp-web instance's running list outranks the transcript", async () => {
  const file = sessionFile();
  const elsewhere = await detectSessionOwner(SESSION_ID, file, {
    foreignLists: [{ pid: 1234, ids: [SESSION_ID] }],
    processes: [],
  });
  assert.equal(elsewhere?.kind, "omp-web");
  assert.equal(elsewhere?.source, "instance-list");
  assert.equal(elsewhere?.running, true);
  assert.equal(elsewhere?.active, true);
});

test("a live omp process started on the file owns it", async () => {
  const file = sessionFile();
  let calls = 0;
  setOmpProcessScanRunner(async () => {
    calls += 1;
    return processOutput([{ pid: 4242, commandLine: `omp.exe --mode rpc-ui --resume "${file}"` }]);
  });
  const elsewhere = await detectSessionOwner(SESSION_ID, file, { foreignLists: [] });
  assert.equal(calls, 1, "the detection ran the process scan");
  assert.equal(elsewhere?.kind, "terminal");
  assert.equal(elsewhere?.source, "process");
  assert.equal(elsewhere?.active, true);
  assert.equal(elsewhere?.running, false, "a finished transcript is owned but idle");
});

test("a stale child pid is excluded from the owner search", async () => {
  // The file is closed, so the transcript cannot explain anything: the only
  // signal is the process, and excluding its pid must clear it.
  const file = sessionFile({ exit: true });
  setOmpProcessScanRunner(async () => processOutput([{ pid: 4242, commandLine: `omp.exe --resume "${file}"` }]));
  assert.equal((await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }))?.source, "process");
  const elsewhere = await detectSessionOwner(SESSION_ID, file, { foreignLists: [], excludePids: [4242] });
  assert.equal(elsewhere, null);
});

test("an open transcript written just now is a weak foreign signal", async () => {
  const file = sessionFile();
  const elsewhere = await detectSessionOwner(SESSION_ID, file, { foreignLists: [], processes: [] });
  assert.equal(elsewhere?.kind, "terminal");
  assert.equal(elsewhere?.source, "transcript");
  assert.equal(elsewhere?.running, false);
  assert.equal(elsewhere?.active, true);
  assert.ok((elsewhere?.lastActivityAt ?? 0) > 0);
  // Integer epoch ms: the wire contract in docs/android/protocol.md §3.7, and a
  // `Long`-typed client rejects a fractional mtimeMs (breaks the whole frame).
  assert.ok(Number.isInteger(elsewhere?.lastActivityAt), `integer epoch ms, got ${elsewhere?.lastActivityAt}`);
});

test("a trailing session_exit clears the transcript signal", async () => {
  const file = sessionFile({ exit: true });
  assert.equal(await detectSessionOwner(SESSION_ID, file, { foreignLists: [], processes: [] }), null);
});

test("our own crash explains an exit-less transcript, not a foreign writer", async () => {
  const file = sessionFile();
  const elsewhere = await detectSessionOwner(SESSION_ID, file, {
    foreignLists: [],
    processes: [],
    ownCrashed: () => true,
  });
  assert.equal(elsewhere, null);
  // A live foreign process still wins over the local crash record.
  setOmpProcessScanRunner(async () => processOutput([{ pid: 777, commandLine: `omp.exe --resume "${file}"` }]));
  const owned = await detectSessionOwner(SESSION_ID, file, { foreignLists: [], processes: undefined, ownCrashed: () => true });
  assert.equal(owned?.source, "process");
});

test("a failing process scan degrades to the transcript signal", async () => {
  const file = sessionFile();
  setOmpProcessScanRunner(async () => {
    throw new Error("no powershell");
  });
  const elsewhere = await detectSessionOwner(SESSION_ID, file, { foreignLists: [] });
  assert.equal(elsewhere?.source, "transcript");
});

test("OMP_WEB_FOREIGN_SCAN=0 disables only the process scan", async () => {
  const file = sessionFile();
  const previous = process.env.OMP_WEB_FOREIGN_SCAN;
  process.env.OMP_WEB_FOREIGN_SCAN = "0";
  try {
    resetOmpProcessCache();
    // The foreign instance list needs no scan and stays authoritative.
    const listed = await detectSessionOwner(SESSION_ID, file, { foreignLists: [{ pid: 1, ids: [SESSION_ID] }] });
    assert.equal(listed?.source, "instance-list");
    // The transcript fallback still protects a recently written, exit-less file.
    const transcript = await detectSessionOwner(SESSION_ID, file, { foreignLists: [] });
    assert.equal(transcript?.source, "transcript");
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_FOREIGN_SCAN;
    else process.env.OMP_WEB_FOREIGN_SCAN = previous;
    resetOmpProcessCache();
  }
});

test("the snapshot keeps foreign sessions and drops transcript entries after the window", async () => {
  const file = sessionFile();
  setOmpProcessScanRunner(async () => processOutput([]));
  const refreshed = await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }]);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].id, SESSION_ID);
  assert.equal(refreshed[0].source, "transcript");
  assert.equal(getElsewhereSessions().length, 1);
  // A transcript-only signal expires with the activity window; no rescan needed.
  assert.equal(getElsewhereSessions(Date.now() + ELSEWHERE_ACTIVE_WINDOW_MS + 1).length, 0);
});

test("an idle foreign owner keeps its badge after its file stopped growing", async () => {
  // A terminal `omp --resume` that sits between turns holds the lease for
  // hours: the list must still report it, even though the transcript is silent
  // and therefore contributes nothing.
  const file = sessionFile({ exit: true });
  setOmpProcessScanRunner(async () => processOutput([{ pid: 6060, commandLine: `omp.exe --resume "${file}"` }]));
  const idleSince = Date.now() - ELSEWHERE_ACTIVE_WINDOW_MS - 60_000;
  const refreshed = await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: idleSince }]);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].source, "process");
  assert.equal(refreshed[0].active, true);
  assert.equal(refreshed[0].lastActivityAt, undefined, "an old file is not read for the tail");
});

test("a failing scan keeps a known process owner instead of clearing it", async () => {
  // A timeout is "unknown", not "no owner": the badge must survive until a scan
  // answers again, or one slow PowerShell would hide a live terminal omp for as
  // long as no file event triggers a refresh.
  const file = sessionFile({ exit: true });
  let fail = false;
  setOmpProcessScanRunner(async () => {
    if (fail) throw new Error("powershell timed out");
    return processOutput([{ pid: 6061, commandLine: `omp.exe --resume "${file}"` }]);
  });
  const idleSince = Date.now() - ELSEWHERE_ACTIVE_WINDOW_MS - 60_000;
  const first = await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: idleSince }]);
  assert.equal(first.length, 1);
  assert.equal(first[0].source, "process");

  fail = true;
  resetOmpProcessCache();
  const second = await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: idleSince }]);
  assert.equal(second.length, 1, "the known owner survives a failed scan");
  assert.equal(second[0].source, "process");
});

test("a stale file with no live owner is not elsewhere", async () => {
  // The same candidate shape as above without a process: an old transcript can
  // never be a live run, and the file is not read to guess otherwise.
  const file = sessionFile();
  setOmpProcessScanRunner(async () => processOutput([]));
  const refreshed = await refreshElsewhereSessions([
    { id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() - ELSEWHERE_ACTIVE_WINDOW_MS - 1 },
  ]);
  assert.deepEqual(refreshed, []);
});

test("refresh drops sessions this instance owns", async () => {
  const file = sessionFile();
  setOmpProcessScanRunner(async () => processOutput([]));
  const refreshed = await refreshElsewhereSessions(
    [{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }],
    { isLocal: () => true },
  );
  assert.deepEqual(refreshed, []);
  assert.deepEqual(getElsewhereSessions(), []);
});

test("a candidate of another host is never inspected by this machine's scan", async () => {
  // The same path can exist on a linked host: a local `omp` naming it must not
  // make that host's session look owned here.
  const file = sessionFile();
  setOmpProcessScanRunner(async () => processOutput([{ pid: 4243, commandLine: `omp.exe --resume "${file}"` }]));
  const refreshed = await refreshElsewhereSessions(
    [{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now(), hostId: "remote-box" }],
    { isLocal: () => false, ownCrashed: () => false },
  );
  assert.deepEqual(refreshed, []);
  // A session that moved to another host loses this machine's badge as well.
  setOmpProcessScanRunner(async () => processOutput([]));
  const local = await refreshElsewhereSessions(
    [{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }],
    { isLocal: () => false, ownCrashed: () => false },
  );
  assert.equal(local.length, 1, "the open transcript is elsewhere on this machine");
  const moved = await refreshElsewhereSessions(
    [{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now(), hostId: "remote-box" }],
    { isLocal: () => false, ownCrashed: () => false },
  );
  assert.deepEqual(moved, [], "a remote session must not keep a local badge");
});

test("without options a live wrapper in the registry counts as ours", async () => {
  // Daemon model: this server never spawns the child, so there is no pid to
  // exclude — the registry entry is what says "ours".
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[SESSION_ID, { isAlive: () => true }]]);
  try {
    const file = sessionFile();
    setOmpProcessScanRunner(async () => processOutput([{ pid: 4244, commandLine: `omp.exe --resume "${file}"` }]));
    assert.equal(await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }), null);
    // A wrapper that is no longer alive masks nothing: the same process is foreign.
    globalThis.__ompSessions = new Map([[SESSION_ID, { isAlive: () => false }]]);
    const elsewhere = await detectSessionOwner(SESSION_ID, file, { foreignLists: [] });
    assert.equal(elsewhere?.source, "process");
  } finally {
    globalThis.__ompSessions = previous;
  }
});

test("a child a host still lists during adoption counts as ours", async () => {
  // After a server restart the daemon lists the running child in its hello;
  // the wrapper registry learns it only when adoption finishes. Until then the
  // child's `--resume` line must not read as a foreign writer.
  const previousHub = globalThis.__ompHostHub;
  globalThis.__ompHostHub = {
    links: new Map([["local", { id: "local", channels: new Map([["ch-1", { sessionId: SESSION_ID, lost: false, orphaned: false }]]) }]]),
    changeListeners: new Set(),
    helloListeners: new Set(),
    frozen: false,
    uploadListeners: new Set(),
  };
  try {
    const file = sessionFile();
    setOmpProcessScanRunner(async () => processOutput([{ pid: 4343, commandLine: `omp.exe --resume "${file}"` }]));
    assert.equal(await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }), null);
    // A channel the daemon stopped listing is not a run any more.
    globalThis.__ompHostHub.links.get("local").channels.get("ch-1").lost = true;
    assert.equal((await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }))?.source, "process");
  } finally {
    globalThis.__ompHostHub = previousHub;
  }
});

test("without options the crash map explains a missing session_exit", async () => {
  const previousRegistry = globalThis.__ompSessions;
  const previousExited = globalThis.__ompExitedSessions;
  globalThis.__ompSessions = new Map();
  globalThis.__ompExitedSessions = new Map([[SESSION_ID, { id: SESSION_ID, at: Date.now() }]]);
  try {
    const file = sessionFile();
    setOmpProcessScanRunner(async () => processOutput([]));
    assert.equal(await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }), null);
  } finally {
    globalThis.__ompSessions = previousRegistry;
    globalThis.__ompExitedSessions = previousExited;
  }
});

test("a child of this machine's daemon is ours while its link is down (the restart window)", async () => {
  // After a web-server restart the daemon reconnects within seconds, but until
  // its hello arrives neither the wrapper registry nor the channel list knows
  // the run it kept. The scan then finds the child's own `--resume`, which must
  // not read as a foreign writer: the daemon's recorded pid is the exact signal.
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-owner-daemon-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousPort = process.env.OMP_WEB_PORT;
  const previousHub = globalThis.__ompHostHub;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OMP_WEB_PORT = "30177";
  mkdirSync(join(agentDir, "omp-web"), { recursive: true });
  // This test process stands in for the daemon: its pid is live, which is what
  // the record requires.
  const daemonPid = process.pid;
  writeFileSync(join(agentDir, "omp-web", "host.pid"), JSON.stringify({ pid: daemonPid, url: "http://127.0.0.1:30177", at: Date.now() }));
  const stubHub = (links) => {
    globalThis.__ompHostHub = { links, changeListeners: new Set(), helloListeners: new Set(), frozen: false, uploadListeners: new Set() };
  };
  // The link is down: no hello has listed anything yet.
  stubHub(new Map());
  try {
    const file = sessionFile();
    setOmpProcessScanRunner(async () => processOutput([{ pid: 6061, ppid: daemonPid, commandLine: `omp.exe --mode rpc-ui --resume "${file}"` }]));
    assert.equal(await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }), null);
    // A terminal `omp` beside it (another parent) is still a foreign owner.
    setOmpProcessScanRunner(async () => processOutput([
      { pid: 6061, ppid: daemonPid, commandLine: `omp.exe --resume "${file}"` },
      { pid: 6062, ppid: 4000, commandLine: `omp.exe --resume "${file}"` },
    ]));
    assert.equal((await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }))?.source, "process");
    // Once the link is up, the hello's channel list is the authority: the pid
    // record no longer hides a process (a child the daemon did not list is not ours).
    stubHub(new Map([["local", { id: "local", status: "online", channels: new Map() }]]));
    setOmpProcessScanRunner(async () => processOutput([{ pid: 6061, ppid: daemonPid, commandLine: `omp.exe --resume "${file}"` }]));
    assert.equal((await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }))?.source, "process");
  } finally {
    globalThis.__ompHostHub = previousHub;
    setOmpProcessScanRunner(null);
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousPort === undefined) delete process.env.OMP_WEB_PORT;
    else process.env.OMP_WEB_PORT = previousPort;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a foreign omp-web instance is read from the agent dir's running lists", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-owner-lists-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // A live process of ours is what makes the list count as "another instance".
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    child.kill();
    rmSync(agentDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  assert.ok(child.pid, "the helper process started");
  // Its own list (this pid) is never foreign; the helper's is.
  writeFileSync(join(agentDir, `omp-web-interrupted-sessions-${child.pid}.json`), JSON.stringify({ sessions: [{ id: SESSION_ID }] }));
  writeFileSync(join(agentDir, `omp-web-interrupted-sessions-${process.pid}.json`), JSON.stringify({ sessions: [{ id: "ours" }] }));
  const lists = readForeignRunningLists();
  assert.deepEqual(lists.map((list) => list.pid), [child.pid]);
  assert.deepEqual(lists[0].ids, [SESSION_ID]);
});

test("the snapshot tick re-checks ownership and notifies exactly once when it clears", async (t) => {
  // The file is already closed (trailing session_exit), so once the owning
  // process disappears nothing else can keep the entry alive.
  const file = sessionFile({ exit: true });
  let scans = 0;
  setOmpProcessScanRunner(async () => {
    scans += 1;
    // Owned on the first scan, gone afterwards (the terminal omp exited).
    return processOutput(scans === 1 ? [{ pid: 5150, commandLine: `omp.exe --resume "${file}"` }] : []);
  });
  // Mock the timers BEFORE the refresh arms its tick, so that timer is fake.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refreshed = await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }]);
  assert.equal(refreshed[0]?.source, "process");

  let notifications = 0;
  setElsewhereChangeNotifier(() => {
    notifications += 1;
  });
  // The tick was armed by the refresh above; one refresh interval later the
  // 10 s scan cache is long expired too, so it re-scans, finds nothing and
  // broadcasts the change.
  resetOmpProcessCache();
  t.mock.timers.tick(ELSEWHERE_REFRESH_MS + 1);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications, 1);
  assert.deepEqual(getElsewhereSessions(), []);
});

test("the snapshot tick uses the registered ownership context", async (t) => {
  // The tick fired without `isLocal`/`ownCrashed`/`excludePids`, so a chat this
  // instance had taken over (owner ended, the user sent, `?force=1`) stayed
  // "elsewhere" as long as our own child lived: that child still names the
  // original file on its `--resume`, and the original file is never written
  // again. The informed path already answered "ours" for the same state.
  const file = sessionFile({ exit: true });
  // The scan sees exactly one owner: our own child, naming the original file.
  setOmpProcessScanRunner(async () => processOutput([{ pid: 7777, commandLine: `omp.exe --resume "${file}"` }]));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }]);
  assert.equal(first[0]?.source, "process", "the foreign owner is reported first");
  // The foreign process ended and this instance owns the session now: the same
  // checks every route passes per call, registered for the caller-less tick.
  setElsewhereOwnershipContext({ isLocal: () => true });
  let notifications = 0;
  setElsewhereChangeNotifier(() => {
    notifications += 1;
  });
  resetOmpProcessCache();
  t.mock.timers.tick(ELSEWHERE_REFRESH_MS + 1);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(getElsewhereSessions(), [], "the tick must honour the ownership context");
  assert.equal(notifications, 1, "the cleared owner is broadcast");
});

test("the tick also excludes this instance's own child pids", async (t) => {
  // Same shape, only the pid list: a stale child command line is what made the
  // entry stick, so the registered pid provider must reach the scan match even
  // when `isLocal` does not (a moved-from file keeps the alias).
  const file = sessionFile({ exit: true });
  setOmpProcessScanRunner(async () => processOutput([{ pid: 4040, commandLine: `omp.exe --resume "${file}"` }]));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }]);
  assert.equal(getElsewhereSessions().length, 1);

  setElsewhereOwnershipContext({ excludePids: () => [4040] });
  resetOmpProcessCache();
  t.mock.timers.tick(ELSEWHERE_REFRESH_MS + 1);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(getElsewhereSessions(), [], "a stale child never owns a chat");
});

test("a live owner beyond the recent-candidate cap is still found", async () => {
  // The scan names its sessions, and those candidates are never cut off, so a
  // busy session tree cannot hide an idle-open foreign owner.
  const candidates = [];
  for (let i = 0; i < 100; i += 1) {
    candidates.push({
      id: `01a17cd4-6f4c-7d5e-9999-${String(i).padStart(12, "0")}`,
      sessionFile: sessionFile(),
      mtimeMs: Date.now(),
    });
  }
  const idleId = "01a17cd4-6f4c-7d5e-9999-999999999999";
  const idleFile = sessionFile({ exit: true });
  // Last in the list and silent for longer than the activity window.
  candidates.push({ id: idleId, sessionFile: idleFile, mtimeMs: Date.now() - ELSEWHERE_ACTIVE_WINDOW_MS - 60_000 });

  setOmpProcessScanRunner(async () => processOutput([{ pid: 8181, commandLine: `omp.exe --resume "${idleFile}"` }]));
  const refreshed = await refreshElsewhereSessions(candidates);

  const idle = refreshed.find((entry) => entry.id === idleId);
  assert.ok(idle, "the idle foreign owner is reported");
  assert.equal(idle.source, "process");
});

test("a child this server is still spawning counts as ours", async () => {
  // Cold start: the daemon already runs `omp --resume <file>` while the server
  // is still in `waitUntilReady()` (up to 120 s), so the wrapper registry is
  // empty and the server-side transport has `sessionId = null`. Without the
  // start lock the own child reads as a foreign writer: the agent GET answers
  // `elsewhere`, the list shows a badge and the next command gets a 409.
  const previousSessions = globalThis.__ompSessions;
  const previousLocks = globalThis.__ompStartLocks;
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = new Map([[SESSION_ID, Promise.resolve({ session: {}, realSessionId: SESSION_ID })]]);
  try {
    const file = sessionFile();
    setOmpProcessScanRunner(async () => processOutput([{ pid: 9090, commandLine: `omp.exe --mode rpc-ui --resume "${file}"` }]));
    assert.equal(await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }), null);
    // Once the start settles the lock is gone; the same process is then foreign
    // (a real second `omp --resume` beside our finished child).
    globalThis.__ompStartLocks = new Map();
    assert.equal((await detectSessionOwner(SESSION_ID, file, { foreignLists: [] }))?.source, "process");
  } finally {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompStartLocks = previousLocks;
  }
});

test("a listed process that already exited is not an owner", async () => {
  // The scan is cached for 10 s, so our own child that just died is still
  // listed with its `--resume` line. Blocking a retry on that row answered 409
  // for a session nobody ran any more. The row is injected directly (not via
  // the scan seam) so the real pid-liveness probe decides.
  const file = sessionFile({ exit: true });
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await exited;
  assert.ok(child.pid, "the helper process started and exited");
  const deadRow = [{ pid: child.pid, commandLine: `omp.exe --resume "${file}"` }];
  assert.equal(await detectSessionOwner(SESSION_ID, file, { foreignLists: [], processes: deadRow }), null);
  // A live pid on the same row is still the owner.
  const liveRow = [{ pid: process.pid, commandLine: `omp.exe --resume "${file}"` }];
  assert.equal((await detectSessionOwner(SESSION_ID, file, { foreignLists: [], processes: liveRow }))?.source, "process");
});

test("readSessionTailState reports the last integer mtime and a truncated window safely", async () => {
  const { readSessionTailState } = await import("./session-owner.ts");
  const file = sessionFile();
  const state = readSessionTailState(file);
  assert.ok(state);
  assert.equal(state.hasTrailingExit, false);
  assert.equal(state.looksActive, false, "assistant text ends the turn");
  assert.ok(Number.isInteger(state.mtimeMs));
  // A file that does not exist is not an error.
  assert.equal(readSessionTailState(join(dir, "missing.jsonl")), null);
});
