import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TaskBlock, CompletionBlock, SubagentModel, SubagentTranscriptRow } = await jiti.import("./SubagentTranscriptDialog.tsx");

test("shows the provider-qualified model and reasoning effort split from the resolved model", () => {
  const html = renderToStaticMarkup(React.createElement(SubagentModel, {
    resolvedModel: "anthropic/claude-sonnet-5-5:high",
  }));
  assert.match(html, /<dt[^>]*>model<\/dt><dd[^>]*>anthropic\/claude-sonnet-5-5<\/dd>/);
  assert.match(html, /<dt[^>]*>effort<\/dt><dd[^>]*>high<\/dd>/);
});

test("renders nothing when no resolved model is known", () => {
  assert.equal(renderToStaticMarkup(React.createElement(SubagentModel, {})), "");
});

test("splits the max effort level and keeps a non-effort suffix in the model id", () => {
  const max = renderToStaticMarkup(React.createElement(SubagentModel, { resolvedModel: "m:max" }));
  assert.match(max, /<dt[^>]*>model<\/dt><dd[^>]*>m<\/dd>/);
  assert.match(max, /<dt[^>]*>effort<\/dt><dd[^>]*>max<\/dd>/);
  const tagged = renderToStaticMarkup(React.createElement(SubagentModel, { resolvedModel: "p/m:free" }));
  assert.match(tagged, /<dt[^>]*>model<\/dt><dd[^>]*>p\/m:free<\/dd>/);
  assert.doesNotMatch(tagged, />effort</);
});

test("renders the task as markdown with its label", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, {
    task: "# Target\nReview the changes.",
  }));
  assert.match(html, /Task/);
  assert.match(html, /Target/);
  assert.match(html, /Review the changes\./);
});

test("renders nothing for an empty task", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBlock, { task: "" }));
  assert.equal(html, "");
});

test("renders plain-text completion with its label", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "Everything passes.",
    truncated: false,
  }));
  assert.match(html, /Result/);
  assert.match(html, /Everything passes\./);
  assert.doesNotMatch(html, /Output truncated/);
});

test("renders structured JSON completions as key/value rows", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"overall_correctness":"incorrect","explanation":"x"}',
    truncated: false,
  }));
  assert.match(html, /overall_correctness/);
  assert.match(html, />incorrect</);
  assert.match(html, /explanation/);
  assert.match(html, />x</);
});

test("renders single-value JSON completions with unescaped line breaks", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: '{"report":"Line one\\nLine two"}',
    truncated: false,
  }));
  assert.match(html, /Line one\nLine two/);
  assert.doesNotMatch(html, /\\n/);
});

test("shows the truncation note when the output was capped", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: "partial",
    truncated: true,
  }));
  assert.match(html, /Output truncated/);
});

test("shows an empty state when no completion exists yet", () => {
  const html = renderToStaticMarkup(React.createElement(CompletionBlock, {
    completion: null,
    truncated: false,
  }));
  assert.match(html, /No output yet/);
});

test("transcript rows cap tool-call input at the same 400-char budget as text", () => {
  const big = "x".repeat(5000);
  const html = renderToStaticMarkup(React.createElement(SubagentTranscriptRow, {
    message: { role: "assistant", content: [{ type: "toolCall", toolName: "edit", input: { patch: big } }] },
  }));
  assert.match(html, /edit/);
  assert.ok(html.length < 1000, `tool-call row must not render unbounded input JSON (got ${html.length} chars)`);
  assert.doesNotMatch(html, new RegExp(`x{1000}`));
});
