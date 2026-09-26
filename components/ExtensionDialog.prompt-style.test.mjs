import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");

function renderEditorTextarea(extra) {
  const html = renderToStaticMarkup(React.createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "r1", method: "editor", title: "Answer", ...extra },
    onRespond: () => {},
    attached: true,
  }));
  const textarea = html.match(/<textarea[^>]*>/)?.[0];
  assert.ok(textarea, "editor request renders a textarea");
  return textarea;
}

test("promptStyle editor (ask 'Other' answer) uses the chat font, not monospace", () => {
  const textarea = renderEditorTextarea({ promptStyle: true });
  assert.match(textarea, /font-family:inherit/);
  assert.match(textarea, /font-size:var\(--chat-font-size\)/);
});

test("plain editor requests keep the monospace code font", () => {
  const textarea = renderEditorTextarea({});
  assert.match(textarea, /font-family:var\(--font-mono\)/);
  assert.match(textarea, /font-size:13px/);
});
