import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/manifest/route.ts");
const { manifestHref } = await jiti.import("./manifest-theme.ts");

// Chrome refreshes an installed app's manifest without cookies, so the color
// must survive the trip through the link URL the page renders.
const manifestColor = async (hex, cookie) => {
  const headers = cookie ? { cookie } : {};
  const { theme_color, background_color } = await route.GET(new NextRequest(`http://localhost${manifestHref(hex)}`, { headers })).json();
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
    const { theme_color } = await route.GET(new NextRequest(`http://localhost/api/manifest?theme=${encodeURIComponent(value)}`)).json();
    assert.equal(theme_color, "#000000", value);
  }
});
