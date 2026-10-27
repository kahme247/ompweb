import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { manifestHref } = await import("./manifest-theme.ts");

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
  // The route reads the icons when it loads, so it is imported after the variable is set (and the tests below reuse it).
  const { GET } = await import("../app/api/manifest/route.ts");
  const { icons } = await GET(new Request("http://localhost/api/manifest")).json();
  assert.deepEqual(icons.map((icon) => atob(icon.src.slice("data:image/png;base64,".length))), ["small", "large"]);
});

// Chrome refreshes an installed app's manifest without cookies, so the color
// must survive the trip through the link URL the page renders.
const manifestJson = async (url, headers = {}) => {
  const { GET } = await import("../app/api/manifest/route.ts");
  return GET(new Request(url, { headers })).json();
};
const manifestColor = async (hex, cookie) => {
  const { theme_color, background_color } = await manifestJson(`http://localhost${manifestHref(hex)}`, cookie ? { cookie } : {});
  // theme_color tints the system bars; background_color shows through an edge-to-edge navigation bar.
  assert.equal(background_color, theme_color);
  return theme_color;
};

test("manifest colors follow the theme in the manifest link, with no cookie needed", async () => {
  assert.equal(await manifestColor("F2F0EA"), "#F2F0EA");
  assert.equal(await manifestColor("0a0a0c"), "#0a0a0c");
});

test("manifest colors ignore a missing or malformed theme", async () => {
  assert.equal(await manifestColor(undefined), "#000000");
  assert.equal(await manifestColor(undefined, "omp-theme-color=F2F0EA"), "#000000", "the link, not the cookie, carries the color");
  for (const value of ["zzzzzz", "#abcdef", "abcde", "abcdef0", "abcdef\"}"]) {
    assert.equal(manifestHref(value), "/api/manifest", value);
    const { theme_color } = await manifestJson(`http://localhost/api/manifest?theme=${encodeURIComponent(value)}`);
    assert.equal(theme_color, "#000000", value);
  }
});
