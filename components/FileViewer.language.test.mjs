import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react/pure.js");

const { FileViewer } = await import("./FileViewer.tsx");

const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
afterEach(async () => {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    cleanup();
  });
  globalThis.fetch = originalFetch;
  globalThis.Worker = originalWorker;
  delete window.matchMedia;
});

const PATCH = "--- a/x\n+++ b/x\n-old\n+new\n";

function setup() {
  globalThis.fetch = async (url) => {
    const body = String(url).startsWith("/api/git/") ? { supported: false } : { content: PATCH, language: "text", size: PATCH.length };
    return { ok: true, json: async () => body };
  };
  globalThis.Worker = class { onmessage = null; onerror = null; postMessage() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

const props = (filePath) => ({ filePath, hostId: "local", cwd: "/ws", sourceSessionId: "s1" });

test("the language picker highlights a file whose extension maps to no grammar, and resets for the next file", async () => {
  setup();
  const view = render(React.createElement(FileViewer, props("/ws/change.txt")));
  const picker = await waitFor(() => {
    const select = view.container.querySelector('[role="combobox"].file-viewer-language-select');
    assert.ok(select);
    return select;
  });
  assert.equal(picker.textContent, "Auto (text)");
  assert.equal(view.container.querySelector(".file-source-view .token"), null);

  fireEvent.click(picker);
  const list = await waitFor(() => within(document.body).getByRole("listbox"));
  const option = within(list).getByRole("option", { name: "diff", exact: true });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => assert.ok(view.container.querySelector(".file-source-view .token")));

  // Leaving the tab and coming back to the same file keeps the pick.
  view.rerender(React.createElement(FileViewer, { ...props("/ws/change.txt"), active: false }));
  view.rerender(React.createElement(FileViewer, props("/ws/change.txt")));
  await waitFor(() => assert.ok(view.container.querySelector(".file-source-view .token")));
  assert.equal(view.container.querySelector('[role="combobox"].file-viewer-language-select').textContent, "diff");

  view.rerender(React.createElement(FileViewer, props("/ws/other.txt")));
  await waitFor(() => assert.equal(view.container.querySelector(".file-source-view .token"), null));
  assert.equal(view.container.querySelector('[role="combobox"].file-viewer-language-select').textContent, "Auto (text)");
});
