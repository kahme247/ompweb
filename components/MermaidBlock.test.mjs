import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MermaidBlock } = await import("./MermaidBlock.tsx");

// Simple sequenceDiagram for testing
const mermaidSrc = `sequenceDiagram
    Alice->>Bob: Hello
    Bob-->>Alice: Hi`;

test("MermaidBlock renders source by default", () => {
  const html = renderToStaticMarkup(
    React.createElement(MermaidBlock, { code: mermaidSrc }),
  );

  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, />(Preview|mermaidBlock\.preview)</);
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /mermaid-block-loading/);
});

test("MermaidBlock can render preview by default", () => {
  const html = renderToStaticMarkup(
    React.createElement(MermaidBlock, { code: mermaidSrc, defaultPreview: true }),
  );

  assert.match(html, />(Source|mermaidBlock\.source)</);
  assert.match(html, /mermaid-block-loading/);
  assert.doesNotMatch(html, /Alice/);
});

test("MermaidBlock with isStreaming falls back to source view", () => {
  const html = renderToStaticMarkup(
    React.createElement(MermaidBlock, { code: mermaidSrc, isStreaming: true, defaultPreview: true }),
  );

  assert.match(html, /disabled/);
  assert.match(html, />(Preview|mermaidBlock\.preview)</);
  assert.match(html, /Alice/);
  assert.match(html, /-&gt;&gt;/);
});

test("MermaidBlock renders empty graph without error", () => {
  const html = renderToStaticMarkup(
    React.createElement(MermaidBlock, { code: "graph TD", defaultPreview: true }),
  );

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block-loading/);
});

test("MermaidBlock handles Chinese characters in diagram", () => {
  const chineseMermaid = `sequenceDiagram
    participant PC as PC客户端
    PC->>SV: 请求登录`;

  const html = renderToStaticMarkup(
    React.createElement(MermaidBlock, { code: chineseMermaid, defaultPreview: true }),
  );

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block/);
});
