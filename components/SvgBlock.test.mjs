import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// SvgBlock parses at render time with the browser globals; jsdom provides
// them on window, so expose them before importing the component.
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;

const { SvgBlock, parseSvgMarkup } = await import("./SvgBlock.tsx");
const { markdownCodeRenderer } = await import("./MarkdownCode.tsx");

const validSvg = `<svg viewBox="0 0 420 90" font-family="system-ui, sans-serif">
  <text x="0" y="18" font-size="13" fill="var(--muted)">svg block renders inline</text>
  <rect x="0" y="30" width="400" height="46" rx="6" fill="none" stroke="var(--border)"/>
</svg>`;

test("parseSvgMarkup keeps a valid svg and normalizes its root", () => {
  const markup = parseSvgMarkup(validSvg);
  assert.match(markup, /<svg[^>]*viewBox="0 0 420 90"/);
  assert.match(markup, /max-width:100%;height:auto/);
  assert.match(markup, /fill="currentColor"/);
  assert.match(markup, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // Theme-variable fills survive sanitization.
  assert.match(markup, /fill="var\(--muted\)"/);
});

test("parseSvgMarkup strips script, event handlers, foreignObject, style and javascript hrefs", () => {
  const markup = parseSvgMarkup(`<svg viewBox="0 0 10 10" onload="alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink">
    <script>alert(2)</script>
    <style>rect { fill: red; }</style>
    <foreignObject><div>evil</div></foreignObject>
    <a href="javascript:alert(3)"><text>x</text></a>
    <a xlink:href="data:text/html,&lt;script&gt;alert(4)&lt;/script&gt;"><text>y</text></a>
    <rect width="10" height="10" />
  </svg>`);
  assert.doesNotMatch(markup, /<script/);
  assert.doesNotMatch(markup, /onload/);
  assert.doesNotMatch(markup, /foreignObject/);
  assert.doesNotMatch(markup, /<style/);
  assert.doesNotMatch(markup, /javascript:/);
  assert.doesNotMatch(markup, /data:text\/html/);
  assert.match(markup, /<rect/);
});

test("parseSvgMarkup keeps an explicit root fill instead of forcing currentColor", () => {
  const markup = parseSvgMarkup(`<svg viewBox="0 0 10 10" fill="red"><rect width="10" height="10" /></svg>`);
  assert.match(markup, /fill="red"/);
  assert.doesNotMatch(markup, /fill="currentColor"/);
});

test("parseSvgMarkup returns null for malformed markup and non-svg roots", () => {
  assert.equal(parseSvgMarkup(`<svg viewBox="0 0 10 10"><rect`), null);
  assert.equal(parseSvgMarkup(`<html><body>not svg</body></html>`), null);
  assert.equal(parseSvgMarkup(``), null);
});

test("SvgBlock renders a valid fence inline with theme aliases on the wrapper", () => {
  const html = renderToStaticMarkup(React.createElement(SvgBlock, { code: validSvg }));
  assert.match(html, /markdown-svg-block/);
  assert.match(html, /<svg[^>]*viewBox="0 0 420 90"/);
  assert.match(html, /--muted:var\(--text-muted\)/);
  assert.doesNotMatch(html, /markdown-code-block/);
});

test("SvgBlock falls back to the code block for malformed svg", () => {
  const html = renderToStaticMarkup(React.createElement(SvgBlock, { code: `<svg viewBox="0 0 10 10"><rect` }));
  assert.match(html, /markdown-code-block/);
  assert.match(html, />svg</);
});

test("markdown code renderer dispatches svg to SvgBlock and leaves mermaid and json alone", () => {
  const Code = markdownCodeRenderer({});
  const svgHtml = renderToStaticMarkup(
    React.createElement(Code, { className: "language-svg", children: validSvg }),
  );
  assert.match(svgHtml, /markdown-svg-block/);

  const mermaidHtml = renderToStaticMarkup(
    React.createElement(Code, { className: "language-mermaid", children: "graph TD\n  A-->B" }),
  );
  assert.match(mermaidHtml, />(Preview|mermaidBlock\.preview)</);
  assert.doesNotMatch(mermaidHtml, /markdown-svg-block/);

  const jsonHtml = renderToStaticMarkup(
    React.createElement(Code, { className: "language-json", children: `{\n  "a": 1\n}` }),
  );
  assert.match(jsonHtml, /markdown-code-block/);
  assert.match(jsonHtml, />json</);
});
