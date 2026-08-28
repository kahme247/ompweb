import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { GET } = await jiti.import("../app/api/file-index/route.ts");
const { allowFileRoot } = await jiti.import("../lib/file-access.ts");
const { NextRequest } = await jiti.import("next/server");

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
  allowFileRoot(dir.replace(/\\/g, "/"));
  return dir;
}

async function search(cwd, params) {
  const url = new URL("http://localhost/api/file-index");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const res = await GET(new NextRequest(url.toString()));
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
  try {
    // --cached reports index entries even after the file leaves the working
    // tree, so these rows used to 404 the moment anyone opened them.
    const gone = repo("gone", ["keep.ts", "src/gone.ts"]);
    rmSync(join(gone, "src", "gone.ts"));
    assert.deepEqual(paths(await search(gone, { q: "gone", limit: 200 })), []);
    // ignored.ts is only absent when the git listing is still in use: the
    // readdir fallback knows IGNORED_NAMES, not .gitignore. Subtracting
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
    rmSync(root, { recursive: true, force: true });
  }
});
