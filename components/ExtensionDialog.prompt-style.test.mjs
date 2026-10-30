import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { ExtensionDialog } = await import("./ExtensionDialog.tsx");

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

test("multi-line titles keep their line breaks", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "r2", method: "input", title: "Question\n\nDetails" },
    onRespond: () => {},
  }));
  assert.match(html, /<div style="[^"]*white-space:pre-wrap[^"]*">Question\n\nDetails<\/div>/);
});
