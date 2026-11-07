// `local://` URL semantics for open_file, pinned to omp's own local-protocol.ts as installed (omp 18.15:
// `extractRelativePath` takes the authority as written and decodes the joined path once, then
// `validateRelativePath`): what omp would write a file to is what ompweb opens, and nothing omp refuses is accepted.
import assert from "node:assert/strict";
import test from "node:test";

const { isLocalUri, parseLocalUri } = await import("./local-uri.ts");

const relative = (uri, platform) => {
  const parsed = parseLocalUri(uri, platform);
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
  // Query and fragment are not part of the path, nested or not; a `?` or `#` in a name must be encoded.
  assert.equal(relative("local://note.md?x=1#frag"), "note.md");
  assert.equal(relative("local://dir/n.md?x=1"), "dir/n.md");
  assert.equal(relative("local://dir/sub/n.md#frag"), "dir/sub/n.md");
  assert.equal(relative("local://a%3Fb%23c.md"), "a?b#c.md");
  // The authority is decoded once with the rest, as omp 18.3.1+ does: `%25` is a literal percent, never a second decode.
  assert.equal(relative("local://100%25.md"), "100%.md");
  assert.equal(relative("local://50%25-off.md"), "50%-off.md");
  assert.equal(relative("local://%25"), "%");
  assert.equal(relative("local://a%2541.md"), "a%41.md");
  assert.equal(relative("local://dir/a%2541.md"), "dir/a%41.md");
});

test("a colon in a name is a name on POSIX, as omp reads it", () => {
  assert.equal(relative("local://a:1.md", "linux"), "a:1.md");
  assert.equal(relative("local://dir/a:1.md", "darwin"), "dir/a:1.md");
});

test("a double-encoded dot segment is a literal directory name, not traversal", () => {
  assert.equal(relative("local://%252e%252e/x"), "%2e%2e/x");
  assert.equal(relative("local://dir/%252e%252e/x"), "dir/%2e%2e/x");
});

test("dots inside or after a name are an ordinary name, as in omp", () => {
  assert.equal(relative("local://a..b.md"), "a..b.md");
  assert.equal(relative("local://dir/file..md"), "dir/file..md");
  assert.equal(relative("local://dir/b.."), "dir/b..");
  assert.equal(relative("local://.hidden"), ".hidden");
  assert.equal(relative("local://dir/.hidden"), "dir/.hidden");
});

test("refuses traversal in every encoding omp refuses", () => {
  for (const uri of [
    "local://../x",
    "local://a/../../x",
    "local://a/..",
    "local://%2e%2e/x",
    "local://..%2fx",
    "local://a%2F..%2Fb",
    "local://..%5Cx",
    "local://a\\..\\b",
    "local:///../x",
    // omp also refuses a name whose segment merely starts with `..` (its `normalized.startsWith("..")` / `includes("/..")`).
    "local://..hidden.md",
    "local://a/..b",
    "local://...",
    "local://....//x",
    "local://./..b",
    "local://a/./..b",
    "local://%2e%2ehidden.md",
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
    "local://%5Cserver%5Cshare%5Cf",
  ]) {
    const parsed = parseLocalUri(uri);
    assert.equal(parsed.ok, false, `${uri} must be refused`);
    assert.match(parsed.error, /absolute/i);
  }
});

test("on Windows a drive-letter prefix is absolute too, with or without a separator", () => {
  for (const uri of ["local://C:%5CWindows%5Cwin.ini", "local://C:/Windows/win.ini", "local://c:win.ini"]) {
    const parsed = parseLocalUri(uri, "win32");
    assert.equal(parsed.ok, false, `${uri} must be refused on win32`);
    assert.match(parsed.error, /absolute/i);
  }
  // The same name is an ordinary file name elsewhere.
  assert.equal(relative("local://c:win.ini", "linux"), "c:win.ini");
  assert.equal(relative("local://C:/Windows/win.ini", "linux"), "C:/Windows/win.ini");
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
