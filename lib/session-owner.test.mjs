import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  ELSEWHERE_ACTIVE_WINDOW_MS,
  ELSEWHERE_REFRESH_MS,
  detectSessionOwner,
  getElsewhereSessions,
  refreshElsewhereSessions,
  resetElsewhereSessions,
  setElsewhereChangeNotifier,
  setElsewhereOwnershipContext,
} = await jiti.import("./session-owner.ts");
const { resetOmpProcessCache, setOmpProcessScanRunner } = await jiti.import("./omp-processes.ts");

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
  // The POSIX rows carry the uid column (`ps -eo pid=,uid=,args=`): the scan
  // drops rows without a numeric uid, and the same-user filter compares this
  // column against the server's own uid.
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return process.platform === "win32"
    ? JSON.stringify(entries.map(({ pid, commandLine }) => ({ ProcessId: pid, CommandLine: commandLine })))
    : `${entries.map(({ pid, commandLine }) => `${pid} ${uid} ${commandLine}`).join("\n")}\n`;
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

test("our own child's pid is excluded from the owner search", async () => {
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

test("a change that lands during an active refresh is queued, not dropped", async () => {
  // The file watcher refreshes per changed file. When two writes land while one
  // scan is running, the second caller used to receive the first pass's
  // snapshot — which predates its own file — and broadcast it, so the new owner
  // only appeared on the next event.
  const firstFile = sessionFile({ exit: true });
  const secondFile = sessionFile({ exit: true });
  const SECOND_ID = "01a17cd4-6f4c-7d5e-8a90-aabbccddeeff";
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let scans = 0;
  setOmpProcessScanRunner(async () => {
    scans += 1;
    if (scans === 1) await blocked;
    return processOutput([
      { pid: 7101, commandLine: `omp.exe --resume "${firstFile}"` },
      { pid: 7102, commandLine: `omp.exe --resume "${secondFile}"` },
    ]);
  });
  const idleSince = Date.now() - ELSEWHERE_ACTIVE_WINDOW_MS - 60_000;
  const active = refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: firstFile, mtimeMs: idleSince }]);
  // Arrives mid-scan: its id cannot be in the pass that is already running.
  const queued = refreshElsewhereSessions([{ id: SECOND_ID, sessionFile: secondFile, mtimeMs: idleSince }]);
  release();
  const [, second] = await Promise.all([active, queued]);
  assert.deepEqual(second.map((entry) => entry.id).sort(), [SECOND_ID, SESSION_ID].sort(), "the late caller's snapshot carries both sessions");
  assert.equal(second.find((entry) => entry.id === SECOND_ID)?.source, "process");
  assert.deepEqual(getElsewhereSessions().map((entry) => entry.id).sort(), [SECOND_ID, SESSION_ID].sort());
});

test("the snapshot tick uses the registered ownership context", async (t) => {
  // Rework N1: the tick fired without `isLocal`/`ownCrashed`/`excludePids`, so
  // a chat this instance had taken over (owner ended, the user sent, `?force=1`)
  // stayed "elsewhere" as long as our own child lived: that child still names
  // the original file on its `--resume`, and the original file is never written
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
  // Same shape, only the pid list: our own child's stale command line is what
  // made the entry stick, so the registered pid provider must reach the scan
  // match even when `isLocal` does not (a moved-from file keeps the alias).
  const file = sessionFile({ exit: true });
  setOmpProcessScanRunner(async () => processOutput([{ pid: 4040, commandLine: `omp.exe --resume "${file}"` }]));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }]);
  assert.equal(getElsewhereSessions().length, 1);

  setElsewhereOwnershipContext({ excludePids: () => [4040] });
  resetOmpProcessCache();
  t.mock.timers.tick(ELSEWHERE_REFRESH_MS + 1);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(getElsewhereSessions(), [], "our own child never owns a chat");
});

test("a failing self-tick re-check is contained instead of crashing the server", async (t) => {
  // The tick is fire-and-forget: its promise had no rejection handler, so any
  // failing re-check (a throwing ownership callback from the other server
  // bundle, a rejecting scan) was an unhandled rejection — Node ends the whole
  // server on those.
  const file = sessionFile();
  setOmpProcessScanRunner(async () => processOutput([{ pid: 6161, commandLine: `omp.exe --resume "${file}"` }]));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }]);
  assert.equal(getElsewhereSessions().length, 1);

  setElsewhereOwnershipContext({
    isLocal: () => {
      throw new Error("ownership check failed");
    },
  });
  let notifications = 0;
  setElsewhereChangeNotifier(() => {
    notifications += 1;
  });
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    resetOmpProcessCache();
    t.mock.timers.tick(ELSEWHERE_REFRESH_MS + 1);
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  assert.deepEqual(rejections, [], "a failing self-tick must not surface as an unhandled rejection");
  assert.equal(notifications, 0, "a failed refresh has nothing to broadcast");
  assert.equal(getElsewhereSessions().length, 1, "the last good snapshot survives a failed refresh");
});

test("a live owner beyond the recent-candidate cap is still found", async () => {
  // Rework N6: the queue used to be `[...cached, ...candidates].slice(0, 80)`,
  // so with a busy session tree an idle-open foreign owner on a session that
  // sat past the cap was invisible. The scan names its sessions, and those
  // candidates are never cut off.
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

/**
 * A second, fully independent evaluation of these modules in the same process —
 * what Next.js does per server bundle (`lib/session-owner.ts` is compiled into
 * every route that imports it, and into the SSE mux). jiti with `moduleCache`
 * off gives fresh module bindings, so module-local state stays invisible across
 * the split just like in the real server.
 */
async function moduleInstance() {
  const fresh = createJiti(import.meta.url, {
    alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
    moduleCache: false,
  });
  return {
    owner: await fresh.import("./session-owner.ts"),
    processes: await fresh.import("./omp-processes.ts"),
  };
}

test("the ownership context reaches a tick running in another module instance", async (t) => {
  // Rework N1: the context used to be a module-local `let`, so registering it
  // from rpc-manager's bundle left the tick's copy empty — the tick re-detected
  // a chat this instance had taken over (its own child still names the original
  // file on `--resume`) as foreign, for as long as the child lived. Single-
  // instance tests could not see that; these two evaluations can.
  const tickSide = await moduleInstance();
  const routeSide = await moduleInstance();
  assert.notEqual(
    tickSide.owner.setElsewhereOwnershipContext,
    routeSide.owner.setElsewhereOwnershipContext,
    "the two evaluations must be separate module instances",
  );

  // The file is recent and has no trailing `session_exit`, so even a tick that
  // cannot see our scan seam still re-detects *a* signal and keeps the entry:
  // the assertion below fails on a module-local context instead of passing by a
  // scan miss.
  const file = sessionFile();
  tickSide.processes.setOmpProcessScanRunner(async () => processOutput([
    { pid: 7171, commandLine: `omp.exe --resume "${file}"` },
  ]));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = await tickSide.owner.refreshElsewhereSessions([{ id: SESSION_ID, sessionFile: file, mtimeMs: Date.now() }]);
  assert.equal(first[0]?.source, "process", "the foreign owner is reported first");

  // This instance took the session over (the user forced a send): the route
  // side registers the checks every route passes per call. That registration
  // happens in a different module copy, in the same process.
  routeSide.owner.setElsewhereOwnershipContext({ isLocal: () => true });
  let notifications = 0;
  tickSide.owner.setElsewhereChangeNotifier(() => {
    notifications += 1;
  });
  tickSide.processes.resetOmpProcessCache();
  t.mock.timers.tick(ELSEWHERE_REFRESH_MS + 1);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    tickSide.owner.getElsewhereSessions(),
    [],
    "the tick must see the context registered by the other module instance",
  );
  assert.equal(notifications, 1, "the cleared owner is broadcast");
});
