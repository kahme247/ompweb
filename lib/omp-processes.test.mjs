import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  FOREIGN_SCAN_TTL_MS,
  foreignScanEnabled,
  listOmpProcesses,
  matchSessionOwner,
  parsePosixProcessList,
  parseWindowsProcessList,
  resetOmpProcessCache,
  resumeArguments,
  sameUserProcesses,
  sessionIdsNamedByProcesses,
  setOmpProcessScanRunner,
} = await jiti.import("./omp-processes.ts");

const SESSION_ID = "8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e63";
const SESSION_FILE = `C:\\Users\\user\\.omp\\agent\\sessions\\-Desktop-project\\2026-10-21T12-08-21-139Z_${SESSION_ID}.jsonl`;

test("windows process list parses an array, a single object and garbage", () => {
  const array = parseWindowsProcessList(JSON.stringify([
    { ProcessId: 10, CommandLine: "omp.exe --mode rpc-ui" },
    { ProcessId: 11, CommandLine: null },
  ]));
  assert.deepEqual(array, [
    { pid: 10, commandLine: "omp.exe --mode rpc-ui" },
    { pid: 11, commandLine: "" },
  ]);
  // ConvertTo-Json emits a bare object for exactly one match.
  assert.deepEqual(parseWindowsProcessList(JSON.stringify({ ProcessId: 7, CommandLine: "omp.exe" })), [
    { pid: 7, commandLine: "omp.exe" },
  ]);
  assert.deepEqual(parseWindowsProcessList("not json"), []);
  assert.deepEqual(parseWindowsProcessList(""), []);
  assert.deepEqual(parseWindowsProcessList('[{"ProcessId":0,"CommandLine":"x"}]'), []);
});

test("posix process list parses pid, uid and the full command line", () => {
  assert.deepEqual(parsePosixProcessList("  123  1000 omp --resume /home/x/a.jsonl\n  456   501 /usr/bin/omp\nbroken\n  7 user omp\n"), [
    { pid: 123, uid: 1000, commandLine: "omp --resume /home/x/a.jsonl" },
    { pid: 456, uid: 501, commandLine: "/usr/bin/omp" },
  ]);
});

test("only this user's processes are trusted as owners", () => {
  // `ps -e` lists every user's processes; a foreign command line that merely
  // prints `--resume <id>` must not make the session look taken.
  const scanned = parsePosixProcessList([
    "  900  1000 omp --resume sess-a",
    "  901  1001 omp --resume sess-b",
    "  902  1001 python3 -c pass --resume sess-a",
  ].join("\n"));
  assert.deepEqual(sameUserProcesses(scanned, 1000).map((process) => process.pid), [900]);
  assert.equal(matchSessionOwner(sameUserProcesses(scanned, 1000), { sessionId: "sess-b" }), undefined);
  assert.deepEqual(sameUserProcesses(scanned, 1001).map((process) => process.pid), [901, 902]);
  // An OS without uids (Windows) cannot filter, so every scanned process stays.
  assert.deepEqual(sameUserProcesses(scanned, null).map((process) => process.pid), [900, 901, 902]);
});

test("resume arguments cover quoted, unquoted-with-spaces, = and id forms", () => {
  assert.deepEqual(resumeArguments('omp --mode rpc-ui --resume "C:\\a b\\file.jsonl"'), ["C:\\a b\\file.jsonl"]);
  assert.deepEqual(resumeArguments("omp --resume=C:\\x\\y.jsonl"), ["C:\\x\\y.jsonl"]);
  const spaced = resumeArguments("omp --resume C:\\Project Alpha\\file.jsonl --foo");
  assert.ok(spaced.includes("C:\\Project Alpha\\file.jsonl"), `spaced path missing: ${JSON.stringify(spaced)}`);
  // `ps` loses the quoting, so the space-joined tokens are offered as well —
  // but only up to a flag, never the whole rest of the command line.
  assert.ok(spaced.includes("C:\\Project"), "the first token is offered");
  assert.ok(!spaced.includes("C:\\Project Alpha\\file.jsonl --foo"), "joining stops at the next flag");
  // A different flag that merely starts with --resume is not a resume argument.
  assert.deepEqual(resumeArguments("omp --resumeX nope"), []);
  assert.deepEqual(resumeArguments("omp --mode rpc-ui"), []);
});

test("a hostile 128 KB command line stays bounded and matches in under 50 ms", () => {
  const hostile = `omp --resume ${" ".repeat(64 * 1024)}${"a ".repeat(80_000)}`;
  assert.ok(hostile.length > 128 * 1024);
  const started = performance.now();
  const values = resumeArguments(hostile);
  matchSessionOwner([{ pid: 1, commandLine: hostile }], { sessionId: SESSION_ID, sessionFile: SESSION_FILE });
  const elapsed = performance.now() - started;
  assert.ok(values.length <= 8 * 8, `candidate count is capped, got ${values.length}`);
  assert.ok(elapsed < 50, `the parse took ${elapsed} ms`);
});

test("session matching accepts path, basename, id, separators and rejects other pids", () => {
  const owners = [
    { pid: 900, commandLine: `omp --mode rpc-ui --cwd C:\\x --resume "${SESSION_FILE}"` },
  ];
  assert.deepEqual(matchSessionOwner(owners, { sessionId: SESSION_ID, sessionFile: SESSION_FILE }), owners[0]);
  // Forward slashes in the process list (a POSIX/WSL-style command line).
  assert.deepEqual(
    matchSessionOwner([{ pid: 901, commandLine: `omp --resume ${SESSION_FILE.replace(/\\/g, "/")}` }], { sessionId: SESSION_ID, sessionFile: SESSION_FILE }),
    { pid: 901, commandLine: `omp --resume ${SESSION_FILE.replace(/\\/g, "/")}` },
  );
  // Same basename, different root (network drive, another home).
  assert.deepEqual(
    matchSessionOwner([{ pid: 902, commandLine: `omp --resume /mnt/c/other/2026-10-21T12-08-21-139Z_${SESSION_ID}.jsonl` }], { sessionId: SESSION_ID, sessionFile: SESSION_FILE }),
    { pid: 902, commandLine: `omp --resume /mnt/c/other/2026-10-21T12-08-21-139Z_${SESSION_ID}.jsonl` },
  );
  // Id only.
  assert.deepEqual(
    matchSessionOwner([{ pid: 903, commandLine: `omp --resume ${SESSION_ID}` }], { sessionId: SESSION_ID, sessionFile: SESSION_FILE }),
    { pid: 903, commandLine: `omp --resume ${SESSION_ID}` },
  );
  // Our own child names the old file on its command line: excluded by pid.
  assert.equal(matchSessionOwner(owners, { sessionId: SESSION_ID, sessionFile: SESSION_FILE, excludePids: [900] }), undefined);
  // A process without --resume never owns a session.
  assert.equal(matchSessionOwner([{ pid: 904, commandLine: "omp __omp_worker_daemon_broker" }], { sessionId: SESSION_ID, sessionFile: SESSION_FILE }), undefined);
  // A different session.
  assert.equal(matchSessionOwner(owners, { sessionId: "other-id", sessionFile: "C:\\x\\2026-01-01_other-id.jsonl" }), undefined);
});

test("the scan names the sessions it owns, so no candidate list cap hides one", () => {
  const candidates = [
    { id: SESSION_ID, sessionFile: SESSION_FILE },
    { id: "8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e64" },
    { id: "8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e65", sessionFile: "C:\\sessions\\2026-10-20_8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e65.jsonl" },
  ];
  const processes = [
    // The original file path, in the other separator form.
    { pid: 910, commandLine: `omp --resume ${SESSION_FILE.replace(/\\/g, "/")}` },
    // An id only (no file in the list for it).
    { pid: 911, commandLine: "omp --resume 8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e64" },
    // A basename that matches the third candidate.
    { pid: 912, commandLine: "omp --resume /mnt/elsewhere/2026-10-20_8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e65.jsonl" },
    // A session the list does not know: nothing to report.
    { pid: 913, commandLine: "omp --resume /mnt/elsewhere/2026-01-01_00000000-0000-0000-0000-000000000000.jsonl" },
    // No --resume, never an owner.
    { pid: 914, commandLine: "omp __omp_worker_daemon_broker" },
  ];
  for (const process of processes) process.resumeTargets = resumeArguments(process.commandLine);
  const ids = [...sessionIdsNamedByProcesses(processes, candidates)].sort();
  assert.deepEqual(ids, [`8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e64`, `8f3c1d2a-4b5c-4d6e-8f70-1a2b3c4d5e65`, SESSION_ID].sort());
});

test("posix scans run ps from an absolute system path, never from PATH", async () => {
  const seen = [];
  setOmpProcessScanRunner(async (file, args) => {
    seen.push({ file, args });
    return "1 1000 omp --resume x\n";
  });
  try {
    const scan = await listOmpProcesses({ platform: process.platform, uid: 1000 });
    if (process.platform === "win32") return;
    if (!existsSync("/bin/ps") && !existsSync("/usr/bin/ps")) {
      // No absolute ps: "unknown" (the snapshot keeps a known owner), and no
      // PATH lookup ever happened.
      assert.deepEqual(scan, { processes: [], ok: false, enabled: true });
      assert.equal(seen.length, 0);
      return;
    }
    assert.equal(scan.ok, true);
    assert.ok(isAbsolute(seen[0].file), `ps must be an absolute system path, got ${seen[0].file}`);
    assert.ok(seen[0].args.includes("pid=,uid=,args="), "the scan asks ps for the uid column");
  } finally {
    setOmpProcessScanRunner(null);
    resetOmpProcessCache();
  }
});

test("the scan is cached for FOREIGN_SCAN_TTL_MS and can be disabled", async () => {
  let calls = 0;
  let now = 1_000_000;
  setOmpProcessScanRunner(async () => {
    calls += 1;
    return JSON.stringify([{ ProcessId: 42, CommandLine: "omp.exe --mode rpc-ui" }]);
  });
  try {
    const first = await listOmpProcesses({ platform: "win32", now: () => now });
    assert.equal(first.processes.length, 1);
    now += FOREIGN_SCAN_TTL_MS - 1;
    await listOmpProcesses({ platform: "win32", now: () => now });
    assert.equal(calls, 1, "within the TTL the cached scan is reused");
    now += 2;
    await listOmpProcesses({ platform: "win32", now: () => now });
    assert.equal(calls, 2, "after the TTL the process table is scanned again");
  } finally {
    setOmpProcessScanRunner(null);
    resetOmpProcessCache();
  }
  assert.equal(foreignScanEnabled({ OMP_WEB_FOREIGN_SCAN: "0" }), false);
  assert.equal(foreignScanEnabled({}), true);
});

test("concurrent callers share one scan and the resume arguments are computed once", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  setOmpProcessScanRunner(async () => {
    calls += 1;
    await gate;
    return JSON.stringify([{ ProcessId: 77, CommandLine: 'omp.exe --resume "C:\\a b\\file.jsonl"' }]);
  });
  try {
    const first = listOmpProcesses({ platform: "win32" });
    const second = listOmpProcesses({ platform: "win32" });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1, "one in-flight scan serves every caller");
    assert.equal(a.processes.length, 1);
    assert.equal(b.processes.length, 1);
    assert.deepEqual(a.processes[0].resumeTargets, ["C:\\a b\\file.jsonl"]);
  } finally {
    setOmpProcessScanRunner(null);
    resetOmpProcessCache();
  }
});

test("a failing scan is reported as unknown, never as 'no processes'", async () => {
  setOmpProcessScanRunner(async () => {
    throw new Error("powershell missing");
  });
  try {
    const failed = await listOmpProcesses({ platform: "win32" });
    assert.deepEqual(failed, { processes: [], ok: false, enabled: true });
  } finally {
    setOmpProcessScanRunner(null);
    resetOmpProcessCache();
  }
  const previous = process.env.OMP_WEB_FOREIGN_SCAN;
  process.env.OMP_WEB_FOREIGN_SCAN = "0";
  try {
    resetOmpProcessCache();
    // Disabled is not a failure: the other ownership signals stay in charge.
    assert.deepEqual(await listOmpProcesses(), { processes: [], ok: true, enabled: false });
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_FOREIGN_SCAN;
    else process.env.OMP_WEB_FOREIGN_SCAN = previous;
    resetOmpProcessCache();
  }
});
