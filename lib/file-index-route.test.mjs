import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { mockBuiltin } from "../tests/mock-builtin.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "omp-file-index-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const { GET } = await import("../app/api/file-index/route.ts");
const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
const { getHost, flushLinkSamples } = await import("./hosts/hub.ts");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let root;

/** A committed git repo containing `files`, registered as a browsable root. */
function repo(name, files) {
  const dir = join(root, name);
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), "x\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(dir, "ignored.ts"), "x\n");
  git(root, ["init", dir]);
  git(dir, ["config", "user.email", "omp-web@example.invalid"]);
  git(dir, ["config", "user.name", "omp-web test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  return dir;
}

async function search(cwd, params) {
  const url = new URL("http://localhost/api/file-index");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const res = await GET(new Request(url.toString()));
  assert.equal(res.status, 200);
  return res.json();
}

const paths = (response) => (response.matches ?? []).map((m) => m.path);

test("file-index search behaves for a real git listing", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }

  root = mkdtempSync(join(tmpdir(), "omp-web-file-index-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const daemon = await linkLocalDaemon();
  await getHost("local").sessionOps.validateCwd(root);
  try {
    // --cached reports index entries even after the file leaves the working
    // tree, so these rows used to 404 the moment anyone opened them.
    const gone = repo("gone", ["keep.ts", "src/gone.ts"]);
    rmSync(join(gone, "src", "gone.ts"));
    assert.deepEqual(paths(await search(gone, { q: "gone", limit: 200 })), []);
    // ignored.ts is only absent when the git listing is still in use: the
    // readdir fallback knows nothing of .gitignore. Subtracting
    // --deleted must not cost the caller the whole git path.
    assert.deepEqual(paths(await search(gone, { q: "ignored", limit: 200 })), []);
    assert.deepEqual(paths(await search(gone, { q: "keep", limit: 200 })), ["keep.ts"]);

    // Directories score a ranking bonus, so dropping them after the limit used
    // to hand the whole budget to rows the caller throws away.
    const kind = repo("kind", ["src/other.ts", "src/deep/target.ts"]);
    assert.ok((await search(kind, { q: "src" })).matches.some((m) => m.isDir),
      "the @ menu still shows directories");
    assert.deepEqual(paths(await search(kind, { q: "src", kind: "file", limit: 1 })), ["src/other.ts"]);
    assert.equal((await search(kind, { q: "src", kind: "file", limit: 1 })).truncated, true);
    assert.deepEqual(
      paths(await search(kind, { q: "src", kind: "file", limit: 2 })),
      ["src/other.ts", "src/deep/target.ts"],
    );

    // A silent cap is the bug being guarded against: it has to say when it cut.
    const trunc = repo("trunc", Array.from({ length: 5 }, (_, i) => `mod${i}.ts`));
    for (const [limit, count, truncated] of [[2, 2, true], [5, 5, false], [200, 5, false]]) {
      const res = await search(trunc, { q: "mod", kind: "file", limit });
      assert.equal(res.matches.length, count, `limit ${limit}`);
      assert.equal(res.truncated, truncated, `limit ${limit}`);
    }
    // Junk, zero, fractions and overshoot all stay inside the allowed range.
    for (const limit of ["abc", "0", "-5", "12.5"]) {
      assert.equal((await search(trunc, { q: "mod", limit })).matches.length, 5, `limit ${limit}`);
    }
    assert.equal((await search(trunc, { q: "mod", kind: "file", limit: 3 })).matches.length, 3);

    // refresh=1 exists so a file written a moment ago is visible. Any rate
    // limit keyed on how recent the cached listing is defeats that, so this
    // must rebuild even though the entry above is milliseconds old.
    const fresh = repo("fresh", ["a.ts"]);
    assert.deepEqual(paths(await search(fresh, { q: "late", limit: 200 })), []);
    writeFileSync(join(fresh, "late.ts"), "x\n");
    assert.deepEqual(paths(await search(fresh, { q: "late", limit: 200 })), [],
      "without the flag the TTL cache answers");
    assert.deepEqual(paths(await search(fresh, { q: "late", limit: 200, refresh: 1 })), ["late.ts"]);
  } finally {
    daemon.drop();
    await daemon.workspace.stop();
    flushLinkSamples();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-index lists a non-git directory without hiding anything by name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-file-index-walk-"));
  const outside = mkdtempSync(join(tmpdir(), "omp-web-file-index-outside-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  for (const file of ["src/a.ts", "src/a.pyc", "build/out.js", "node_modules/pkg/index.js", ".DS_Store"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "x\n");
  }
  writeFileSync(join(outside, "secret.txt"), "x\n");
  try {
    symlinkSync(outside, join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }
  const daemon = await linkLocalDaemon();
  t.after(async () => { daemon.drop(); await daemon.workspace.stop(); flushLinkSamples(); });
  await getHost("local").sessionOps.validateCwd(dir);

  const { files } = await search(dir, {});
  assert.deepEqual(
    [...files].sort(),
    [".DS_Store", "build/out.js", "node_modules/pkg/index.js", "src/a.pyc", "src/a.ts"],
    "build output is listed and a symlinked directory is not followed out of cwd",
  );
});

test("the non-Git index skips file symlinks as well as directory symlinks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-file-index-file-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "keep.ts"), "x\n");
  try {
    symlinkSync(join(dir, "keep.ts"), join(dir, "linked.ts"), "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating file symlinks requires additional privileges on this platform");
      return;
    }
    throw error;
  }
  const { indexWorkspaceFiles } = await import("./file-index.ts?fresh=file-link");
  assert.deepEqual(await indexWorkspaceFiles(dir, "", 200, "file", true), { files: ["keep.ts"], truncated: false });
});

test("a pending non-Git index read lets an unrelated workspace request finish", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-file-index-responsive-"));
  writeFileSync(join(dir, "keep.ts"), "x\n");
  const sub = join(dir, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "inner.ts"), "x\n");
  const daemon = await linkLocalDaemon();
  t.after(async () => {
    daemon.drop(); await daemon.workspace.stop(); flushLinkSamples();
    rmSync(dir, { recursive: true, force: true });
  });
  await getHost("local").sessionOps.validateCwd(dir);
  const readSync = readdirSync;
  const { readdir: readAsync } = await import("node:fs/promises");
  let begin, release;
  const started = new Promise((resolve) => { begin = resolve; });
  const pendingRead = new Promise((resolve) => { release = resolve; });
  await mockBuiltin(t, "fs", {
    readdirSync(abs, options) {
      if (abs === sub) begin();
      return readSync(abs, options);
    },
  });
  await mockBuiltin(t, "node:fs/promises", {
    async readdir(abs, options) {
      if (abs === sub) { begin(); await pendingRead; }
      return readAsync(abs, options);
    },
  });
  const { indexWorkspaceFiles } = await import("./file-index.ts?fresh=responsive-walk");
  let finished = false;
  const scan = indexWorkspaceFiles(dir, "", 200, "file", true).then((listing) => {
    finished = true;
    return listing;
  });
  try {
    await Promise.race([started, scan.then(() => { throw new Error("The scan ended before the controlled directory read"); })]);
    const info = await getHost("local").workspaceOps.fileInfo({ segments: [join(dir, "keep.ts")], sessionId: null });
    assert.equal(info.ok, true);
    assert.equal(info.value.size, 2, "the daemon answers an unrelated file request");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "the daemon answers before the pending nested-directory read finishes");
  } finally {
    release();
    await scan;
  }
  assert.deepEqual(await scan, { files: ["keep.ts", "sub/inner.ts"], truncated: false });
});

test("file-index truncates a directory-heavy fallback without losing collected files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-file-index-dir-cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "template"));
  writeFileSync(join(dir, "keep.ts"), "x\n");
  const entries = readdirSync(dir, { withFileTypes: true });
  const directory = entries.find((entry) => entry.isDirectory());
  const file = entries.find((entry) => entry.isFile());
  // Virtualize the wide directory so this regression needs no 50,000-directory fixture.
  const directories = Array.from({ length: 50_000 }, (_, i) =>
    Object.assign(Object.create(directory), { name: `dir${i}` }));
  let directoryReads = 0;
  const { readdir: readRealDirectory } = await import("node:fs/promises");
  await mockBuiltin(t, "node:fs/promises", {
    async readdir(abs, options) {
      if (abs === dir) { directoryReads++; return [file, ...directories]; }
      if (dirname(abs) === dir) { directoryReads++; return []; }
      return readRealDirectory(abs, options);
    },
  });
  const { GET: cappedGET } = await import("../app/api/file-index/route.ts?fresh=directory-cap");
  const daemon = await linkLocalDaemon();
  t.after(async () => { daemon.drop(); await daemon.workspace.stop(); flushLinkSamples(); });
  await getHost("local").sessionOps.validateCwd(dir);
  const url = new URL("http://localhost/api/file-index");
  url.searchParams.set("cwd", dir);
  const response = await cappedGET(new Request(url));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { files: ["keep.ts"], truncated: true });
  assert.equal(directoryReads, 50_000, "directory visits, including the root, stay within the walk bound");
  url.searchParams.set("q", "keep");
  url.searchParams.set("kind", "file");
  const searchResponse = await cappedGET(new Request(url));
  assert.equal(searchResponse.status, 200);
  assert.deepEqual(await searchResponse.json(), {
    matches: [{ path: "keep.ts", isDir: false }],
    truncated: true,
  });
});
