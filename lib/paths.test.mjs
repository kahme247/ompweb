import assert from "node:assert/strict";
import test from "node:test";

const { isWindowsAbsolutePath, normalizeForComparison, samePath } = await import("./paths.ts");
const { projectIdentityKey } = await import("./paths.ts");

test("detects Windows absolute paths and UNC paths", () => {
  assert.equal(isWindowsAbsolutePath("C:\\Users\\me"), true);
  assert.equal(isWindowsAbsolutePath("d:/projects"), true);
  assert.equal(isWindowsAbsolutePath("\\\\server\\share\\dir"), true);
  assert.equal(isWindowsAbsolutePath("//server/share/dir"), true);
  assert.equal(isWindowsAbsolutePath("/home/user"), false);
  assert.equal(isWindowsAbsolutePath("relative/path"), false);
});

test("normalizes paths for comparison with platform-specific case folding", () => {
  assert.equal(normalizeForComparison("C:\\Projects\\MyProject\\", "win32"), "c:\\projects\\myproject");
  assert.equal(normalizeForComparison("c:/projects/myproject", "win32"), "c:\\projects\\myproject");
  assert.equal(normalizeForComparison("/Users/Me/Projects/", "darwin"), "/Users/Me/Projects");
  assert.equal(normalizeForComparison("/Users/Me/Projects", "darwin"), "/Users/Me/Projects");
});

test("samePath compares paths accurately across slash styles and casing", () => {
  if (process.platform === "win32") {
    assert.equal(samePath("C:\\Projects\\App", "c:/projects/app/"), true);
    assert.equal(samePath("C:\\Projects\\App", "C:\\Projects\\Other"), false);
  } else {
    assert.equal(samePath("/home/user/app", "/home/user/app/"), true);
    assert.equal(samePath("/home/user/App", "/home/user/app"), false);
  }
});

test("projectIdentityKey matches normalizeForComparison", () => {
  assert.equal(projectIdentityKey("C:\\Foo\\Bar\\", "win32"), "c:\\foo\\bar");
  assert.equal(projectIdentityKey("/foo/bar/", "linux"), "/foo/bar");
});
