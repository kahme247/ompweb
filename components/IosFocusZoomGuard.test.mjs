import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, waitFor } = await import("@testing-library/react/pure.js");

const { IosFocusZoomGuard } = await import("./IosFocusZoomGuard.tsx");

const BASE = "width=device-width, initial-scale=1";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";

function device(t, userAgent, platform, maxTouchPoints) {
  for (const [key, value] of Object.entries({ userAgent, platform, maxTouchPoints })) {
    Object.defineProperty(navigator, key, { configurable: true, get: () => value });
    t.after(() => delete navigator[key]);
  }
}

// A viewport meta that replaces the original one later.
function replaceViewportMeta() {
  document.head.querySelector('meta[name="viewport"]')?.remove();
  const meta = document.createElement("meta");
  meta.name = "viewport";
  meta.content = BASE;
  document.head.append(meta);
}

const viewports = () => [...document.querySelectorAll('meta[name="viewport"]')].map((meta) => meta.content);

afterEach(() => {
  cleanup();
  document.head.replaceChildren();
});

for (const [name, userAgent, platform, touchPoints] of [
  ["iPhone", IPHONE, "iPhone", 5],
  ["iPadOS with a desktop user agent", MAC, "MacIntel", 5],
]) {
  test(`${name} caps viewport scale, including on a viewport meta that replaces it later`, async (t) => {
    device(t, userAgent, platform, touchPoints);
    replaceViewportMeta();
    render(React.createElement(IosFocusZoomGuard));
    assert.deepEqual(viewports(), [`${BASE}, maximum-scale=1`]);

    replaceViewportMeta();
    await waitFor(() => assert.deepEqual(viewports(), [`${BASE}, maximum-scale=1`]));
  });
}

for (const [name, userAgent, platform, touchPoints] of [
  ["Android", ANDROID, "Linux armv8l", 5],
  ["desktop Mac", MAC, "MacIntel", 0],
]) {
  test(`${name} keeps pinch-zoom: the viewport meta is never capped`, async (t) => {
    device(t, userAgent, platform, touchPoints);
    replaceViewportMeta();
    render(React.createElement(IosFocusZoomGuard));
    replaceViewportMeta();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(viewports(), [BASE]);
  });
}
