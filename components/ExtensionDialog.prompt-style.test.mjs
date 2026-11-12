import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { ExtensionDialog } = await import("./ExtensionDialog.tsx");

function renderEditorTextarea(editorOptions) {
  const html = renderToStaticMarkup(React.createElement(ExtensionDialog, {
    request: { type: "ui_request", id: 1, method: "editor", args: ["Answer", null, null, editorOptions] },
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
  const textarea = renderEditorTextarea(undefined);
  assert.match(textarea, /font-family:var\(--font-mono\)/);
  assert.match(textarea, /font-size:13px/);
});

test("multi-line titles keep their line breaks", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionDialog, {
    request: { type: "ui_request", id: 2, method: "input", args: ["Question\n\nDetails"] },
    onRespond: () => {},
  }));
  assert.match(html, /<div style="[^"]*white-space:pre-wrap[^"]*">Question\n\nDetails<\/div>/);
});
