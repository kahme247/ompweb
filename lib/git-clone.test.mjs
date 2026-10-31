import assert from "node:assert/strict";
import test from "node:test";

const { appendProgress, cloneDirectoryName } = await import("./git-clone.ts");

test("cloneDirectoryName derives git's directory name from https and ssh URLs", () => {
  assert.equal(cloneDirectoryName("https://github.com/kahme247/ompweb.git"), "ompweb");
  assert.equal(cloneDirectoryName("https://user:token@gitlab.example.com/group/sub/repo/"), "repo");
  assert.equal(cloneDirectoryName("git@github.com:kahme247/ompweb.git"), "ompweb");
  assert.equal(cloneDirectoryName("gh:owner/repo"), "repo");
  assert.equal(cloneDirectoryName("ssh://git@host:2222/srv/repo.git"), "repo");
  assert.equal(cloneDirectoryName("  git@host:repo  "), "repo");
  assert.equal(cloneDirectoryName("git@host:/srv/git/repo.git"), "repo");
  assert.equal(cloneDirectoryName("https://h/o/r.git?x=1#f"), "r");
});

test("cloneDirectoryName rejects non-https/ssh transports and unsafe names", () => {
  for (const url of [
    "",
    "http://github.com/o/r.git",
    "file:///tmp/repo",
    "ext::sh$IFS-c$IFS'touch$IFS/x'/x",
    "--upload-pack=touch /tmp/pwned",
    "/tmp/repo",
    "C:\\repos\\repo",
    "C:/repos/repo",
    "https://h/o/..\\..\\evil",
    "https://h/o/a$b",
    "https://github.com/o/r extra",
    "https://github.com/o/..",
    "https://github.com/",
  ]) {
    assert.equal(cloneDirectoryName(url), null, url);
  }
});

test("appendProgress applies carriage returns across chunks", () => {
  let log = appendProgress("", "Cloning into 'repo'...\n");
  log = appendProgress(log, "Receiving objects:  10% (1/10)\r");
  log = appendProgress(log, "Receiving objects:  50% (5/10)\r");
  assert.equal(log, "Cloning into 'repo'...\nReceiving objects:  50% (5/10)\r");
  log = appendProgress(log, "Receiving objects: 100% (10/10), done.\nResolving deltas: 100%\n");
  assert.equal(log, "Cloning into 'repo'...\nReceiving objects: 100% (10/10), done.\nResolving deltas: 100%\n");
});

test("appendProgress keeps only the latest 200 lines", () => {
  const log = appendProgress("", Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n"));
  const lines = log.split("\n");
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "line 50");
});
