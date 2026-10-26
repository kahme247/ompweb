import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { FileViewer } = await jiti.import("./FileViewer.tsx");

const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
afterEach(async () => {
  // The viewer's lazy chunks resolve after the assertions; let them land before jsdom closes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.Worker = originalWorker;
  delete window.matchMedia;
});

// Relative links and images resolve against the Markdown file's directory, so the same
// document behaves differently inside the session's workspace (/ws) and outside it.
const GUIDE = [
  "# Guide",
  "![diagram](img/rel.png) ![cdn](//cdn.example/x.png)",
  "[other](other.md) [docs](https://example.com/docs) [top](#guide) [inside](/ws/src/a.ts)",
].join("\n\n");

async function renderPreview(filePath, opened) {
  globalThis.fetch = async (url) => {
    const body = String(url).startsWith("/api/git/") ? { supported: false } : { content: GUIDE, language: "markdown", size: GUIDE.length };
    return { ok: true, json: async () => body };
  };
  // The file watch rides the shared event-stream worker; a silent one keeps it idle.
  globalThis.Worker = class { onmessage = null; onerror = null; postMessage() {} };
  // jsdom ships no matchMedia; the viewer reads the color scheme at mount.
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const view = render(React.createElement(FileViewer, {
    filePath,
    cwd: "/ws",
    sourceSessionId: "s1",
    onOpenFile: (file) => opened.push(file),
  }));
  await waitFor(() => assert.ok(view.container.querySelector(".markdown-file-preview h1")));
  return view;
}

test("preview links never navigate omp-web away, and unservable images show their alt text", async () => {
  const opened = [];
  const { container, getByText } = await renderPreview("/var/tmp/out/docs/guide.md", opened);

  // Assertions compare plain values: a failing assert that prints a jsdom node can exhaust memory.
  // The relative link cannot be opened here: plain text, not an anchor the browser would follow.
  const other = getByText("other");
  assert.equal(other.closest("a")?.outerHTML ?? null, null);
  assert.equal(other.getAttribute("title"), "other.md");

  // Web links open a new tab; in-page anchors stay; openable paths open in the panel.
  assert.equal(getByText("docs").closest("a").getAttribute("target"), "_blank");
  assert.equal(getByText("top").closest("a").getAttribute("href"), "#guide");
  assert.equal(fireEvent.click(getByText("inside"), { button: 0 }), false);
  assert.deepEqual(opened, ["/ws/src/a.ts"]);

  // No request for /img/rel.png against the app origin: the alt text stands in.
  // A protocol-relative image is a web URL and still loads.
  assert.equal(container.querySelector('img[alt="diagram"]')?.outerHTML ?? null, null);
  assert.equal(getByText("diagram").getAttribute("title"), "img/rel.png");
  assert.equal(container.querySelector('img[alt="cdn"]')?.getAttribute("src"), "//cdn.example/x.png");
});

test("relative links and images in a workspace Markdown file still open and load", async () => {
  const opened = [];
  const { container, getByText } = await renderPreview("/ws/docs/guide.md", opened);

  assert.match(container.querySelector('img[alt="diagram"]')?.getAttribute("src") ?? "", /^\/api\/files\/.*img\/rel\.png\?.*sessionId=s1/);
  assert.equal(fireEvent.click(getByText("other"), { button: 0 }), false);
  assert.deepEqual(opened, ["/ws/docs/other.md"]);
});
