import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Binary files have no lines; a byte run of 0x3C is not a marker.
const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|zip|gz|exe|node)$/i;
const MAX_BYTES = 16 * 1024 * 1024;

// A merge resolved in the editor but committed with its markers typechecks,
// lints and passes every behavioural test, so nothing in CI notices it until a
// reviewer reads the file. This guard reads the tracked tree instead: the
// markers Git writes are exactly seven characters at the start of a line.
test("no tracked file carries a merge conflict marker", (t) => {
  let tracked;
  try {
    tracked = execFileSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    t.skip("git is not installed");
    return;
  }
  const files = tracked.split("\0").filter(Boolean);
  assert.ok(files.length > 100, `expected the tracked tree, got ${files.length} files`);
  const offenders = [];
  for (const file of files) {
    if (BINARY.test(file)) continue;
    const full = path.join(repo, file);
    let text;
    try {
      if (statSync(full).size > MAX_BYTES) continue;
      text = readFileSync(full, "utf8");
    } catch {
      // Deleted in the working tree but still in the index: the commit is what
      // ships, and `git diff` would show it. Nothing to scan here.
      continue;
    }
    // `<<<<<<< HEAD` and `>>>>>>> <ref>` are the two lines every conflict has;
    // a bare `=======` is not enough on its own (Markdown setext underlines).
    if (/^<{7}(?: |$)/m.test(text) || /^>{7}(?: |$)/m.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `conflict markers committed in: ${offenders.join(", ")}`);
});
