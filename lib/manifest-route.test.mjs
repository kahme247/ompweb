import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("the manifest icons come from the package dir, not the working directory", async (t) => {
  const packageDir = mkdtempSync(path.join(tmpdir(), "omp-web-manifest-"));
  const previous = process.env.OMP_WEB_PACKAGE_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previous;
    rmSync(packageDir, { recursive: true, force: true });
  });
  mkdirSync(path.join(packageDir, "public"));
  writeFileSync(path.join(packageDir, "public", "icon-192.png"), "small");
  writeFileSync(path.join(packageDir, "public", "icon.png"), "large");
  // The launcher sets OMP_WEB_PACKAGE_DIR; the server's working directory is wherever ompweb was started.
  process.env.OMP_WEB_PACKAGE_DIR = packageDir;
  // The route reads the icons when it loads, so it is imported after the variable is set.
  const { GET } = await import("../app/api/manifest/route.ts");
  const { icons } = await GET(new Request("http://localhost/api/manifest")).json();
  assert.deepEqual(icons.map((icon) => atob(icon.src.slice("data:image/png;base64,".length))), ["small", "large"]);
});
