import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteLoadingFallback } from "./RouteLoadingFallback";

const indexHtml = () => readFile(new URL("../app/index.html", import.meta.url), "utf8");

test("app/index.html carries the RouteLoadingFallback markup in #root", async () => {
  const html = (await indexHtml()).replace(/>\s+</g, "><");
  const rootStart = html.indexOf('<div id="root"');
  assert.notEqual(rootStart, -1, "no #root");
  assert.ok(html.indexOf(renderToStaticMarkup(createElement(RouteLoadingFallback))) > rootStart, "the static skeleton differs from the component");
});

test("the static skeleton stays on app pages and is gone on /login before any bundle runs", async () => {
  const html = await indexHtml();
  for (const [url, shown] of [["http://localhost/", true], ["http://localhost/?session=x", true], ["http://localhost/login?next=%2F", false]]) {
    // Inline scripts only: JSDOM loads neither the stylesheet nor the module script.
    const { window } = new JSDOM(html, { url, runScripts: "dangerously" });
    assert.equal(window.document.querySelector("#root .route-fallback") !== null, shown, url);
    window.close();
  }
});
