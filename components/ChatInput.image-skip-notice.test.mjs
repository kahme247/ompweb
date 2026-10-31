import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");

const KEY = "hunt-silent-drop";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const previousFileReader = globalThis.FileReader;
class TestFileReader {
  result = null;
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
}

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.FileReader = TestFileReader;
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  try { cleanup(); } finally {
    clearDraft(KEY);
    localStorage.clear();
    delete window.matchMedia;
    globalThis.FileReader = previousFileReader;
  }
});

test("reports an oversized image dropped while another image is accepted", async () => {
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref, draftKey: KEY, isStreaming: false,
    onSend: async () => ({ status: "accepted" }),
    onAbort: async () => {},
  }));
  const small = new File([Buffer.from(PNG, "base64")], "small.png", { type: "image/png" });
  const big = new File([Buffer.alloc(5 * 1024 * 1024 + 1, 0)], "big.png", { type: "image/png" });
  await act(async () => { ref.current.addFiles([small, big]); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  const alerts = screen.queryAllByRole("alert");
  // A dropped file must be reported, not vanish.
  assert.equal(alerts.length, 1, `expected a skip notice for the oversized file, got ${alerts.length}`);
});

test("reports images dropped past the 10-image cap while some are accepted", async () => {
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref, draftKey: KEY, isStreaming: false,
    onSend: async () => ({ status: "accepted" }),
    onAbort: async () => {},
  }));
  const files = Array.from({ length: 11 }, (_, i) => new File([Buffer.from(PNG, "base64")], `img${i}.png`, { type: "image/png" }));
  await act(async () => { ref.current.addFiles(files); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 10));
  const alerts = screen.queryAllByRole("alert");
  // A dropped file must be reported, not vanish.
  assert.equal(alerts.length, 1, `expected a skip notice for the over-cap image, got ${alerts.length}`);
});
