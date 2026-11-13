import assert from "node:assert/strict";
import test from "node:test";

const { appendProgress, cloneDirectoryName, repositoryKey } = await import("./git-clone.ts");

test("cloneDirectoryName derives git's directory name from https and ssh URLs", () => {
  assert.equal(cloneDirectoryName("https://github.com/ompweb-dev/ompweb.git"), "ompweb");
  assert.equal(cloneDirectoryName("https://user:token@gitlab.example.com/group/sub/repo/"), "repo");
  assert.equal(cloneDirectoryName("git@github.com:ompweb-dev/ompweb.git"), "ompweb");
  assert.equal(cloneDirectoryName("gh:owner/repo"), "repo");
  assert.equal(cloneDirectoryName("ssh://git@host:2222/srv/repo.git"), "repo");
  assert.equal(cloneDirectoryName("  git@host:repo  "), "repo");
  assert.equal(cloneDirectoryName("git@host:/srv/git/repo.git"), "repo");
  assert.equal(cloneDirectoryName("https://h/o/r.git?x=1#f"), "r");
});

test("repositoryKey identifies one repository across URL spellings", () => {
  for (const url of [
    "git@github.com:a/b.git",
    "https://github.com/a/b",
    "https://GitHub.com/a/b.git/",
    "ssh://git@github.com/a/b.git",
    "ssh://git@github.com:2222/a/b",
  ]) assert.equal(repositoryKey(url), "github.com/a/b", url);
});

test("repositoryKey keeps different repositories apart", () => {
  const keys = ["https://github.com/a/b", "https://github.com/a/c", "https://gitlab.com/a/b", "https://github.com/A/b"].map(repositoryKey);
  assert.equal(new Set(keys).size, 4);
});

test("repositoryKey is null exactly where cloneDirectoryName is", () => {
  for (const url of ["/srv/repo", "file:///srv/repo", ""]) {
    assert.equal(cloneDirectoryName(url), null, url);
    assert.equal(repositoryKey(url), null, url);
  }
});

test("repositoryKey maps scp absolute and ssh absolute paths to one key", () => {
  assert.equal(repositoryKey("host:/srv/x"), "host/srv/x");
  assert.equal(repositoryKey("ssh://host/srv/x"), "host/srv/x");
});

test("repositoryKey rejects URLs a parser could read as another host or path", () => {
  for (const url of [
    "https://evil.com#@github.com/a/b",
    "https://127.0.0.1:1?@github.com/a/b",
    "https://evil.com\\@github.com/a/b",
    "https://:1/a/b",
    "ssh://:22/a/b",
    "https://github.com/a/../c/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b#frag",
    "https://user:pw@github.com/a/b",
    "https://user@github.com/a/b",
    "-oProxyCommand:touch/x",
    "https://github.com/a%2Fb",
    "https://github.com/a b",
    "/srv/repo",
    "file:///srv/repo",
    "",
  ]) assert.equal(repositoryKey(url), null, url);
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

test("progress without line breaks stays bounded and retains the newest complete Unicode text", () => {
  const log = appendProgress("old output\n", "😀".repeat(200000) + "😀tail!");
  assert.ok(log.length <= 256 * 1024, "one unbroken output line must not grow the browser log indefinitely");
  assert.ok(log.endsWith("😀tail!"));
  const first = log.charCodeAt(0);
  assert.ok(first < 0xdc00 || first > 0xdfff, "clipping must not expose half of a surrogate pair");
});
