import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import React from "react";
import test, { afterEach } from "node:test";
// DOM and browser fakes must exist before importing Testing Library and the component.
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { FileViewer } = await import("./FileViewer.tsx");
const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.Worker = originalWorker; delete window.matchMedia; });
function browser() {
  globalThis.Worker = class { onmessage = null; onerror = null; postMessage() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
const props = (hostId) => ({ filePath: "/same/report.txt", cwd: "/same", hostId });

test("a file viewer renders bytes from its owning host", async () => {
  browser();
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/git/")) return Response.json({ supported: false });
    const host = new URL(String(url), "http://localhost").searchParams.get("hostId");
    return Response.json({ content: host === "host-a" ? "Alpha document" : "Wrong machine", language: "text", size: 14 });
  };
  const view = render(React.createElement(FileViewer, props("host-a")));
  await waitFor(() => assert.ok(view.container.textContent.includes("Alpha document")));
});

test("an older read cannot replace the same path after its host changes", async () => {
  browser();
  let releaseAlpha;
  let started;
  const alphaStarted = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/git/")) return Response.json({ supported: false });
    const host = new URL(String(url), "http://localhost").searchParams.get("hostId");
    if (host === "host-b") return Response.json({ content: "Beta document", language: "text", size: 13 });
    started();
    return { ok: true, json: () => new Promise((resolve) => { releaseAlpha = () => resolve({ content: "Late alpha", language: "text", size: 10 }); }) };
  };
  const view = render(React.createElement(FileViewer, props("host-a")));
  await alphaStarted;
  view.rerender(React.createElement(FileViewer, props("host-b")));
  await waitFor(() => assert.ok(view.container.textContent.includes("Beta document")));
  releaseAlpha();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(view.container.textContent.includes("Beta document"));
  assert.ok(!view.container.textContent.includes("Late alpha"));
});
