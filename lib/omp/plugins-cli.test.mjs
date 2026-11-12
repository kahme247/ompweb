import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "omp-web-plugins-cli-test-"));
const previousBin = process.env.OMP_WEB_OMP_BIN;
process.env.OMP_WEB_OMP_BIN = join(scratch, "missing-omp");
after(() => {
  if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
  else process.env.OMP_WEB_OMP_BIN = previousBin;
  rmSync(scratch, { recursive: true, force: true });
});
const { listPlugins, runOmpCli } = await import("./plugins-cli.ts");

const answering = (output) => async (args) => {
  assert.deepEqual(args, ["plugin", "list", "--json"]);
  return output;
};

test("the empty answer lists nothing", async () => {
  assert.deepEqual(await listPlugins(answering('{"npm":[],"marketplace":[]}')), []);
});

test("an npm entry and a marketplace entry are mapped; a missing enabled means enabled", async () => {
  const output = JSON.stringify({
    npm: [{ name: "omp-foo", version: "1.2.3", path: join(scratch, "unread", "node_modules", "omp-foo"), enabled: false }],
    marketplace: [
      { id: "bar@market", entries: [{ scope: "project", version: "9.9.9", enabled: false }, { scope: "user", version: "2.0.0" }] },
      { id: "only-project@market", entries: [{ scope: "project", version: "1.0.0" }] },
      { id: "off@market", entries: [{ scope: "user", version: "3.0.0", enabled: false }] },
    ],
  });
  assert.deepEqual(await listPlugins(answering(output)), [
    { kind: "npm", id: "omp-foo", version: "1.2.3", enabled: false },
    { kind: "marketplace", id: "bar@market", version: "2.0.0", enabled: true },
    { kind: "marketplace", id: "off@market", version: "3.0.0", enabled: false },
  ]);
});

test("text before the first brace is skipped", async () => {
  assert.deepEqual(await listPlugins(answering('Checking plugins...\n{"npm":[{"name":"p","version":"1.0.0","enabled":true}],"marketplace":[]}')), [
    { kind: "npm", id: "p", version: "1.0.0", enabled: true },
  ]);
});

test("an entry with odd fields is kept with a string-or-null version and a boolean enabled; npm is enabled only by true", async () => {
  const output = JSON.stringify({
    npm: [{ name: "no-fields" }, { name: "odd", version: 2, enabled: "yes" }, { name: "null-version", version: null, enabled: true }],
    marketplace: [{ id: "odd@market", entries: [{ scope: "user", version: 3 }] }],
  });
  assert.deepEqual(await listPlugins(answering(output)), [
    { kind: "npm", id: "no-fields", version: null, enabled: false },
    { kind: "npm", id: "odd", version: null, enabled: false },
    { kind: "npm", id: "null-version", version: null, enabled: true },
    { kind: "marketplace", id: "odd@market", version: null, enabled: true },
  ]);
});

test("an npm plugin carries its spec from the plugins package.json beside node_modules; a linked one has none", async () => {
  const dir = join(scratch, "plugins");
  const modules = join(dir, "node_modules");
  mkdirSync(modules, { recursive: true });
  const spec = "github:andrebrait/superpowers#0957644820429601727cf9cf78baac3e8f62ba4f";
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@scope/tool": "1.6.2", superpowers: spec } }));
  const output = JSON.stringify({
    npm: [
      { name: "@scope/tool", version: "1.6.2", path: join(modules, "@scope", "tool"), enabled: true },
      { name: "superpowers", version: "7.0.2", path: join(modules, "superpowers"), enabled: true },
      { name: "linked", path: join(modules, "linked"), enabled: true },
    ],
    marketplace: [],
  });
  assert.deepEqual(await listPlugins(answering(output)), [
    { kind: "npm", id: "@scope/tool", version: "1.6.2", enabled: true, source: "1.6.2" },
    { kind: "npm", id: "superpowers", version: "7.0.2", enabled: true, source: spec },
    { kind: "npm", id: "linked", version: null, enabled: true, source: null },
  ]);
});

test("a linked plugin listed first outside node_modules does not hide the others' specs", async () => {
  const dir = join(scratch, "plugins-linked-first");
  const modules = join(dir, "node_modules");
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { superpowers: "github:andrebrait/superpowers" } }));
  const output = JSON.stringify({
    npm: [
      { name: "linked", version: "0.1.0", path: join(scratch, "elsewhere", "linked"), enabled: true },
      { name: "superpowers", version: "7.0.2", path: join(modules, "superpowers"), enabled: true },
    ],
    marketplace: [],
  });
  assert.deepEqual(await listPlugins(answering(output)), [
    { kind: "npm", id: "linked", version: "0.1.0", enabled: true, source: null },
    { kind: "npm", id: "superpowers", version: "7.0.2", enabled: true, source: "github:andrebrait/superpowers" },
  ]);
});

test("with only linked plugins, each outside node_modules has no spec; one without a path stays unknown", async () => {
  const output = JSON.stringify({
    npm: [
      { name: "linked", version: "0.1.0", path: join(scratch, "elsewhere", "linked"), enabled: true },
      { name: "pathless", version: "1.0.0", enabled: true },
    ],
    marketplace: [],
  });
  assert.deepEqual(await listPlugins(answering(output)), [
    { kind: "npm", id: "linked", version: "0.1.0", enabled: true, source: null },
    { kind: "npm", id: "pathless", version: "1.0.0", enabled: true },
  ]);
});

test("a list of the wrong shape rejects instead of meaning no plugins", async () => {
  for (const output of [
    "{}", "[]", '{"npm":[]}', '{"marketplace":[]}', '{"npm":{},"marketplace":[]}',
    '{"npm":[{"version":"1.0.0","enabled":true}],"marketplace":[]}',
    '{"npm":[],"marketplace":[{"entries":[]}]}',
    '{"npm":[null],"marketplace":[]}',
  ]) {
    await assert.rejects(listPlugins(answering(output)), /plugin list/, output);
  }
});

test("output that is not a plugin list rejects", async () => {
  await assert.rejects(listPlugins(answering("no plugins here")));
});

// Before "a missing omp rejects": resolveOmpBin remembers a missing binary for 30 s, and a present one while it exists.
test("an aborted signal ends a running omp", async (t) => {
  // Never exits by itself: it notes its PID, then waits for its stdin to end, and nobody ends it.
  const pidFile = join(scratch, "waiting-omp.pid");
  const source = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`;
  const waiting = join(scratch, process.platform === "win32" ? "waiting-omp.cmd" : "waiting-omp");
  if (process.platform === "win32") {
    // Windows cannot spawn a shebang script: a .cmd launcher, which wrapWindowsScript routes through cmd.exe.
    writeFileSync(`${waiting}.cjs`, source);
    writeFileSync(waiting, `@"${process.execPath.replaceAll("%", "%%")}" "${waiting.replaceAll("%", "%%")}.cjs" %*\r\n`);
  } else writeFileSync(waiting, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  process.env.OMP_WEB_OMP_BIN = waiting;
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  };
  let pid = 0;
  t.after(() => {
    process.env.OMP_WEB_OMP_BIN = join(scratch, "missing-omp");
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(waiting);
  });
  const abort = new AbortController();
  const running = runOmpCli(["plugin", "install", "slow"], 600_000, abort.signal);
  running.catch(() => {}); // asserted below, after the PID is known
  const deadline = Date.now() + 15_000;
  while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8"))) {
    assert.ok(Date.now() < deadline, "the stub omp started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  pid = Number(readFileSync(pidFile, "utf8"));
  abort.abort();
  await assert.rejects(running);
  // The omp process itself, not only a launcher in front of it (cmd.exe on Windows).
  while (alive(pid)) {
    assert.ok(Date.now() < deadline, "the aborted omp is gone");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("a missing omp rejects", async () => {
  await assert.rejects(runOmpCli(["plugin", "list", "--json"], 5_000), /omp binary not found/);
});
