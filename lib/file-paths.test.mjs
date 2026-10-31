import assert from "node:assert/strict";
import test from "node:test";

const {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  normalizeFilePathSlashes,
} = await import("./file-paths.ts");

test("normalizeFilePathSlashes keeps drive and UNC roots absolute", () => {
  assert.equal(normalizeFilePathSlashes("C:\\Users\\me\\file.txt"), "C:/Users/me/file.txt");
  assert.equal(normalizeFilePathSlashes("\\\\server\\share\\dir"), "//server/share/dir");
  assert.equal(normalizeFilePathSlashes("plain/path"), "plain/path");
});

test("encodeFilePathForApi preserves the UNC prefix through URL segments", () => {
  // `\\\\server\\share\\dir` must round-trip: the route joins the segments and
  // calls isWindowsAbsolutePath, which accepts `//` — so the encoded form must
  // keep the leading `//` folded into the first segment.
  const encoded = encodeFilePathForApi("\\\\server\\share\\dir\\file.txt");
  const segments = encoded.split("/").map(decodeURIComponent);
  assert.equal(segments[0], "//server");
  assert.deepEqual(segments, ["//server", "share", "dir", "file.txt"]);
  // Reconstructing the route's join → isWindowsAbsolutePath check must see UNC.
  const joined = segments.join("/");
  assert.ok(joined.startsWith("//server/share/dir/file.txt"));
});

test("encodeFilePathForApi still encodes ordinary and drive paths", () => {
  assert.equal(encodeFilePathForApi("C:\\Users\\me\\a b.txt"), "C%3A/Users/me/a%20b.txt");
  assert.equal(encodeFilePathForApi("a/b/c.txt"), "a/b/c.txt");
});

test("getFileName and getFileDirectory handle drive and UNC roots", () => {
  assert.equal(getFileName("C:\\Users\\me\\file.txt"), "file.txt");
  assert.equal(getFileDirectory("C:\\Users\\me\\file.txt"), "C:/Users/me");
  assert.equal(getFileName("\\\\server\\share\\dir\\file.txt"), "file.txt");
});
