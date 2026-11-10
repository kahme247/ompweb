import assert from "node:assert/strict";
import test from "node:test";

const {
  isOmpProcess,
  listOmpProcesses,
  parsePosixProcessList,
  parseWindowsProcessList,
  resetOmpProcessCache,
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

test("the omp entry is anchored at argv[0] or after a launcher, never a token that merely appears later", () => {
  // Each of these names a session id *and* the token `omp` somewhere, but the program is grep/cp: the id is an
  // argument of that program, not a resume target. These are the shapes that made a background `grep -r` refuse a send.
  const impostors = [
    `grep -r 1111 lib/omp`,
    `grep -r 1111 /home/me/omp`,
    `grep -r 1111 --exclude-dir=omp .`,
    `cp -r 1111 /home/me/omp`,
    `omp-web --resume ${A}`,
    `C:\\bin\\fake-omp.cmd --resume ${A}`,
    `/home/me/omp/foo --resume ${A}`,
    `node C:\\app\\server.js --resume ${A}`,
    `grep -r omp lib/`,
  ];
  for (const commandLine of impostors) {
    assert.equal(isOmpProcess({ pid: 200, commandLine }), false, commandLine);
    assert.deepEqual([...sessionIdsNamedByProcesses([{ pid: 200, commandLine }], [{ id: A }])], [], commandLine);
  }
  // The accepted shapes: the image itself, and the program a known launcher runs.
  const owners = [
    `omp --resume ${A}`,
    `omp.exe --resume ${A}`,
    `/usr/local/bin/omp --resume ${A}`,
    `cmd.exe /c C:\\bin\\omp.cmd --resume ${A}`,
    `cmd.exe /d /s /c "C:\\bin\\omp.cmd --resume ${A}"`,
    `node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@oh-my-pi\\cli.js --resume ${A}`,
    `sh -c "omp --resume ${A}"`,
    `bash -lc "omp --resume ${A}"`,
    `env FOO=1 nice -n 5 omp --resume ${A}`,
  ];
  for (const commandLine of owners) {
    assert.equal(isOmpProcess({ pid: 200, commandLine }), true, commandLine);
    assert.deepEqual([...sessionIdsNamedByProcesses([{ pid: 200, commandLine }], [{ id: A }])], [A], commandLine);
  }
  // `grep -r` with the *full* id is the reviewer's original counterexample: the token is an argument, and a full id
  // needs no prefix rule to match, so only the anchoring keeps it out.
  const full = `grep -r ${A} lib/omp`;
  assert.equal(isOmpProcess({ pid: 200, commandLine: full }), false);
  assert.deepEqual([...sessionIdsNamedByProcesses([{ pid: 200, commandLine: full }], [{ id: A }])], []);
});

test("the POSIX scan asks ps for -ww, so a clipped args column cannot hide a resume value", async () => {
  // `args` is the last `ps` column: with `COLUMNS` exported (tmux, some CI wrappers) a long command line is clipped and
  // the row reads as naming no session — the false `none` this scan exists to prevent. `-ww` overrides the environment.
  resetOmpProcessCache();
  const calls = [];
  const scan = await listOmpProcesses({
    platform: "linux",
    uid: 1000,
    psBin: "/bin/ps",
    run: async (file, args) => {
      calls.push({ file, args });
      return `200 1 1000 omp --resume ${A}\n`;
    },
  });
  assert.equal(scan.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/bin/ps");
  assert.ok(calls[0].args.includes("-ww"), `ps must be asked for -ww, got ${JSON.stringify(calls[0].args)}`);
  assert.deepEqual(calls[0].args.filter((arg) => arg.startsWith("-eo")), ["-eo"], "the column spec is unchanged");
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

test("a launcher's quoted command string is walked as a command line, not basename-matched as a whole", () => {
  // `sh -c "<command string>"` keeps the whole string as one token. Matching a basename against that token read its
  // *last* word as the program: `grep -r <id> lib/omp` ends in `omp`, so a background grep became a foreign owner.
  const impostors = [
    `sh -c "grep -r ${A} lib/omp"`,
    `bash -c "grep -r ${A} lib/omp"`,
    `bash -lc "grep -r ${A} src/omp"`,
    `sh -c "grep -r ${A} /home/me/omp"`,
    `cmd.exe /c "grep -r ${A} C:\\src\\omp"`,
    `sh -c "grep -r 1111 lib/omp"`,
    `zsh -c "tar -r ${A} /backup/omp"`,
    `bash -c "cp -r ${A} /home/me/omp"`,
    `sh -c "grep -r ${A} node_modules/@oh-my-pi/cli"`,
    // A path-rooted program whose *argument* ends in `omp` is the same mistake: the program is the first path, and a
    // later argument is not a continuation of it.
    `sh -c "/bin/cat /home/me/omp"`,
    `sh -c "/usr/bin/grep -r ${A} /home/me/omp"`,
    `sh -c "/bin/cp ${A} /home/me/omp"`,
    `sh -c "/bin/echo omp"`,
  ];
  for (const commandLine of impostors) {
    assert.equal(isOmpProcess({ pid: 200, commandLine }), false, commandLine);
    assert.deepEqual([...sessionIdsNamedByProcesses([{ pid: 200, commandLine }], [{ id: A }])], [], commandLine);
  }
  // The real shapes that carry a program path with spaces must still be recognised: the quoted path is the program,
  // and the flags after it are its arguments.
  const owners = [
    `sh -c "omp --resume ${A}"`,
    `sh -c "/usr/local/bin/omp --resume ${A}"`,
    `sh -c "./omp --resume ${A}"`,
    `sh -c "C:\\bin\\omp.cmd --resume ${A}"`,
    `cmd.exe /c "C:\\Program Files\\omp\\omp.cmd" --resume ${A}`,
    `cmd.exe /d /s /c "C:\\Program Files\\omp\\omp.cmd --resume ${A}"`,
    `sh -c "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@oh-my-pi\\cli.js --resume ${A}"`,
    `sh -c "/opt/my tools/omp --resume ${A}"`,
    `sh -c "/usr/bin/env FOO=1 omp --resume ${A}"`,
  ];
  for (const commandLine of owners) {
    assert.equal(isOmpProcess({ pid: 200, commandLine }), true, commandLine);
    assert.deepEqual([...sessionIdsNamedByProcesses([{ pid: 200, commandLine }], [{ id: A }])], [A], commandLine);
  }
});

test("the Windows scan keeps a quoted grep out and a quoted program path in, through the CIM rows", () => {
  // CIM reports the command line with its quoting intact, so the shell wrapper's command string arrives as one token
  // here too: the same discrimination must hold on the path the daemon actually reads on Windows.
  const rows = parseWindowsProcessList(JSON.stringify([
    { ProcessId: 400, ParentProcessId: 1, Name: "cmd.exe", CommandLine: `cmd.exe /c "grep -r ${A} C:\\src\\omp"` },
    { ProcessId: 401, ParentProcessId: 1, Name: "cmd.exe", CommandLine: `cmd.exe /c "C:\\Program Files\\omp\\omp.cmd" --resume ${A}` },
    { ProcessId: 402, ParentProcessId: 1, Name: "cmd.exe", CommandLine: `cmd.exe /d /s /c "C:\\Program Files\\omp\\omp.cmd --resume ${A}"` },
    { ProcessId: 403, ParentProcessId: 1, Name: "sh.exe", CommandLine: `sh -c "grep -r ${A} lib/omp"` },
  ]));
  assert.deepEqual(rows.map(isOmpProcess), [false, true, true, false]);
  assert.deepEqual([...sessionIdsNamedByProcesses([rows[0], rows[3]], [{ id: A }])], [], "a quoted grep names no session");
  assert.deepEqual([...sessionIdsNamedByProcesses(rows, [{ id: A }])], [A], "the spaced install path still owns it");
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
