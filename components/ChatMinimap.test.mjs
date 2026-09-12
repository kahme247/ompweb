import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatMinimap, extractPreviewText, getBarWidth } = await jiti.import("./ChatMinimap.tsx");

test("extractPreviewText extracts clean text from user string content", () => {
  const preview = extractPreviewText({
    role: "user",
    content: "move Explorer to right panel",
  });
  assert.equal(preview, "move Explorer to right panel");
});

test("extractPreviewText cleans markdown formatting, code fences, and extra whitespace", () => {
  const preview = extractPreviewText({
    role: "user",
    content: "## Refactor Minimap\n```ts\nconst a = 1;\n```\n  Can we simplify the context bar?  ",
  });
  assert.equal(preview, "Refactor Minimap Can we simplify the context bar?");
});

test("extractPreviewText truncates excessively long prompts with ellipsis", () => {
  const longPrompt = "This is a very long prompt that exceeds sixty characters and should be truncated with an ellipsis cleanly";
  const preview = extractPreviewText({
    role: "user",
    content: longPrompt,
  });
  assert.ok(preview.length <= 60);
  assert.ok(preview.endsWith("…"));
});

test("getBarWidth produces organic widths matching the visual design", () => {
  assert.equal(getBarWidth("short", true, false), 24); // active is always prominent
  assert.equal(getBarWidth("short", false, true), 22); // hovered is slightly wider
  assert.equal(getBarWidth("hi", false, false), 10); // short text
  assert.equal(getBarWidth("move Explorer to panel", false, false), 14); // medium text
  assert.equal(getBarWidth("can we refactor the rpc process connection logic", false, false), 18); // long text
});

test("renders minimal context navigation rail with interactive buttons for user prompts", () => {
  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "user", content: "move Explorer to right panel" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];

  const scrollContainer = { current: null };
  const messageRefs = { current: [] };

  const html = renderToStaticMarkup(
    React.createElement(ChatMinimap, {
      messages,
      scrollContainer,
      messageRefs,
    })
  );

  assert.match(html, /role="navigation"/);
  assert.match(html, /aria-label="Chat context navigation"/);
  assert.match(html, /aria-label="Jump to: first question"/);
  assert.match(html, /aria-label="Jump to: move Explorer to right panel"/);
});

test("renders nothing when messages list is empty", () => {
  const scrollContainer = { current: null };
  const messageRefs = { current: [] };

  const html = renderToStaticMarkup(
    React.createElement(ChatMinimap, {
      messages: [],
      scrollContainer,
      messageRefs,
    })
  );

  assert.equal(html, "");
});

test("falls back to assistant messages when no user prompts exist", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "Welcome to the agent" }] },
    { role: "assistant", content: [{ type: "text", text: "Ready for tasks" }] },
  ];

  const scrollContainer = { current: null };
  const messageRefs = { current: [] };

  const html = renderToStaticMarkup(
    React.createElement(ChatMinimap, {
      messages,
      scrollContainer,
      messageRefs,
    })
  );

  assert.match(html, /aria-label="Jump to: Welcome to the agent"/);
  assert.match(html, /aria-label="Jump to: Ready for tasks"/);
});
