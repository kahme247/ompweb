import assert from "node:assert/strict";
import test from "node:test";

const {
  isOmpProcess,
  parsePosixProcessList,
  parseWindowsProcessList,
  resumeArguments,
  sessionIdsNamedByProcesses,
} = await import("./omp-processes.ts");

const A = "11111111-2222-4333-8444-0000000000a1";
const B = "22222222-3333-4444-8555-0000000000b2";

/** The values a command line's resume flags carry, without the flag names. */
const values = (commandLine) => resumeArguments(commandLine).map((argument) => argument.value);

test("every documented resume flag is recognised: --resume, --restore, -r, with = or a space", () => {
  for (const commandLine of [
    `omp --resume ${A}`,
    `omp --resume=${A}`,
    `omp -r ${A}`,
    `omp -r=${A}`,
    `omp -r${A}`,
    `omp --restore ${A}`,
    `omp --restore=${A}`,
  ]) {
    assert.deepEqual(values(commandLine), [A], commandLine);
  }
  // A path value, quoted as Windows reports it and bare as `ps` reports it.
  assert.deepEqual(values('omp --resume "C:\\Users\\x\\sessions\\2026-01-01_abc.jsonl"'), ["C:\\Users\\x\\sessions\\2026-01-01_abc.jsonl"]);
  assert.deepEqual(values("omp --resume /home/x/.omp/sessions/p/2026-01-01_abc.jsonl"), ["/home/x/.omp/sessions/p/2026-01-01_abc.jsonl"]);
  // Not a resume flag: a longer flag that merely starts with the marker, and a marker inside another token.
  assert.deepEqual(values("omp --resume-mode fast"), []);
  assert.deepEqual(values("omp --no-resume x"), []);
  assert.deepEqual(values("omp --restore-all x"), []);
  assert.deepEqual(values("omp --model -r"), []);
});

test("a resume flag with no value, or one that is the next flag, carries nothing", () => {
  assert.deepEqual(values("omp --resume"), []);
  assert.deepEqual(values("omp --resume --model x"), []);
  assert.deepEqual(values("omp -r --model x"), []);
});

test("only an omp process can own a session: grep -r and rm -r are not writers", () => {
  const rows = parsePosixProcessList([
    `200 1 1000 /usr/bin/grep -r ${A} /tmp`,
    `201 1 1000 rm -r ${A}`,
    `202 1 1000 omp --resume ${A}`,
  ].join("\n"));
  assert.deepEqual(rows.map(isOmpProcess), [false, false, true]);
  // The non-omp rows alone must name nothing: a set that also contains the omp row cannot tell the two apart.
  assert.deepEqual([...sessionIdsNamedByProcesses(rows.slice(0, 2), [{ id: A }])], [], "grep -r and rm -r are not writers");
  assert.deepEqual([...sessionIdsNamedByProcesses(rows, [{ id: A }])], [A], "the omp row names the session");
});

test("a shim-launched omp on Windows is recognised by its command line, not only by its image name", () => {
  const rows = parseWindowsProcessList(JSON.stringify([
    { ProcessId: 300, ParentProcessId: 1, Name: "cmd.exe", CommandLine: "cmd.exe /c C:\\bin\\omp.cmd --resume " + A },
    { ProcessId: 301, ParentProcessId: 300, Name: "node.exe", CommandLine: "node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@oh-my-pi\\cli.js --resume " + A },
    { ProcessId: 302, ParentProcessId: 1, Name: "node.exe", CommandLine: "node C:\\app\\server.js --resume " + A },
    { ProcessId: 303, ParentProcessId: 1, Name: "omp.exe", CommandLine: "omp.exe --resume " + A },
  ]));
  assert.deepEqual(rows.map(isOmpProcess), [true, true, false, true]);
  assert.deepEqual([...sessionIdsNamedByProcesses([rows[2]], [{ id: A }])], [], "an unrelated node process naming --resume is not omp");
  assert.deepEqual([...sessionIdsNamedByProcesses(rows, [{ id: A }])], [A]);
});

test("a unique id prefix names the session; an ambiguous or too-short prefix does not", () => {
  const C = "11111111-9999-4333-8444-0000000000c3";
  const candidates = [{ id: A }, { id: B }, { id: C }];
  const named = (value) => [...sessionIdsNamedByProcesses([{ pid: 200, commandLine: `omp --resume ${value}` }], candidates)];
  assert.deepEqual(named("11111111-2222"), [A], "a unique prefix is how omp's --resume takes an id");
  assert.deepEqual(named("11111111"), [], "an ambiguous prefix leaves omp to pick: no session is claimed");
  assert.deepEqual(named("11"), [], "too short to attribute a writer");
  assert.deepEqual(named("22222222"), [B]);
  // A path that merely starts with the prefix is not a prefix match.
  assert.deepEqual(named("/tmp/11111111"), []);
});

test("a value that names a session file still matches by path and by basename", () => {
  const file = "/home/x/.omp/sessions/p/2026-01-01_abc.jsonl";
  const named = sessionIdsNamedByProcesses([{ pid: 200, commandLine: `omp --resume ${file}` }], [{ id: A, sessionFile: file }]);
  assert.deepEqual([...named], [A]);
  // A copy of the file elsewhere still matches by basename, as before.
  const copied = sessionIdsNamedByProcesses([{ pid: 200, commandLine: "omp --resume /other/place/2026-01-01_abc.jsonl" }], [{ id: A, sessionFile: file }]);
  assert.deepEqual([...copied], [A]);
});

test("a dead row is skipped; a live second writer on the same file still owns it", () => {
  const processes = [
    { pid: 200, commandLine: `omp --resume ${A}` },
    { pid: 201, commandLine: `omp --resume ${A}` },
  ];
  // The first row is a cached scan entry for a process that already exited.
  assert.deepEqual([...sessionIdsNamedByProcesses(processes, [{ id: A }], { isAlive: (pid) => pid === 201 })], [A]);
  assert.deepEqual([...sessionIdsNamedByProcesses(processes, [{ id: A }], { isAlive: () => false })], []);
});
