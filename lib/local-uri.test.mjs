// `local://` URL semantics for open_file, pinned to omp's own local-protocol.ts
// (`extractRelativePath` + `validateRelativePath`): what omp would write a file
// to is what ompweb opens, and nothing omp refuses is ever accepted.
import assert from "node:assert/strict";
import test from "node:test";

const { isLocalUri, parseLocalUri } = await import("./local-uri.ts");

const relative = (uri) => {
  const parsed = parseLocalUri(uri);
  assert.equal(parsed.ok, true, `${uri} should parse: ${parsed.ok ? "" : parsed.error}`);
  return parsed.relative;
};

test("names a file under the session's local directory, as omp resolves it", () => {
  assert.equal(relative("local://note.md"), "note.md");
  assert.equal(relative("local://nested/name with spaces.md"), "nested/name with spaces.md");
  assert.equal(relative("local://nested/name%20with%20spaces.md"), "nested/name with spaces.md");
  // An empty host is omp's `local:///x` form: still relative to the local root.
  assert.equal(relative("local:///note.md"), "note.md");
  assert.equal(relative("LOCAL://Note.md"), "Note.md");
  // Query and fragment are not part of the path; a `?` or `#` in a name must be encoded.
  assert.equal(relative("local://note.md?x=1#frag"), "note.md");
  assert.equal(relative("local://a%3Fb%23c.md"), "a?b#c.md");
  // omp decodes the host segment twice (rawHost, then the joined path) and the rest once.
  assert.equal(relative("local://a%2541.md"), "aA.md");
  assert.equal(relative("local://dir/a%2541.md"), "dir/a%41.md");
});

test("refuses traversal in every encoding omp refuses", () => {
  for (const uri of [
    "local://../x",
    "local://a/../../x",
    "local://a/..",
    "local://%2e%2e/x",
    "local://..%2fx",
    "local://%252e%252e/x",
    "local://a%2F..%2Fb",
    "local://..%5Cx",
    "local://a\\..\\b",
    "local:///../x",
  ]) {
    const parsed = parseLocalUri(uri);
    assert.equal(parsed.ok, false, `${uri} must be refused`);
    assert.match(parsed.error, /traversal|\.\./i);
  }
});

test("refuses an absolute suffix, POSIX or Windows", () => {
  for (const uri of [
    "local://%2Fetc%2Fpasswd",
    "local:///%2Fetc/passwd",
    "local://C:%5CWindows%5Cwin.ini",
    "local://C:/Windows/win.ini",
    "local://c:win.ini",
    "local://%5Cserver%5Cshare%5Cf",
  ]) {
    const parsed = parseLocalUri(uri);
    assert.equal(parsed.ok, false, `${uri} must be refused`);
    assert.match(parsed.error, /absolute/i);
  }
});

test("refuses an empty path, a broken encoding and a NUL byte", () => {
  assert.equal(parseLocalUri("local://").ok, false);
  assert.equal(parseLocalUri("local:///").ok, false);
  assert.match(parseLocalUri("local://%E0%A4%A").error, /encoding/i);
  assert.equal(parseLocalUri("local://x%00.md").ok, false);
});

test("only a local:// URL is a local URL; other schemes and plain paths are not", () => {
  assert.equal(isLocalUri("local://note.md"), true);
  assert.equal(isLocalUri("LOCAL://note.md"), true);
  for (const other of [
    "skill://x/SKILL.md",
    "agent://1",
    "file:///etc/passwd",
    "https://example.com/local://x",
    "local:note.md",
    "xlocal://note.md",
    " local://note.md",
    "/etc/passwd",
    "docs/local://x",
    "C:\\work\\note.md",
  ]) {
    assert.equal(isLocalUri(other), false, `${other} is not a local URL`);
    assert.equal(parseLocalUri(other).ok, false);
  }
});
