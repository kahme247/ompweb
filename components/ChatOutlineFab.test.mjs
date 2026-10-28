import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatOutlineFab } = await jiti.import("./ChatOutlineFab.tsx");
const { extractPreviewText } = await jiti.import("./ChatMinimap.tsx");

test("ChatOutlineFab renders button when messages exist", () => {
  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  ];
  const scrollContainer = { current: null };
  const messageRefs = { current: [] };

  const html = renderToStaticMarkup(
    React.createElement(ChatOutlineFab, {
      messages,
      scrollContainer,
      messageRefs,
      nearBottom: false,
      isMobile: true,
    })
  );

  assert.match(html, /chat-outline-fab/);
  assert.match(html, /bottom:\s*60px/); // sits above bottom jump button when not nearBottom
  assert.match(html, /right:\s*16px/); // mobile right padding
});

test("ChatOutlineFab moves down to bottom: 16px when nearBottom is true", () => {
  const messages = [
    { role: "user", content: "first question" },
  ];
  const scrollContainer = { current: null };
  const messageRefs = { current: [] };

  const html = renderToStaticMarkup(
    React.createElement(ChatOutlineFab, {
      messages,
      scrollContainer,
      messageRefs,
      nearBottom: true,
      isMobile: false,
    })
  );

  assert.match(html, /chat-outline-fab/);
  assert.match(html, /bottom:\s*16px/); // drops to bottom 16px when nearBottom
  assert.match(html, /right:\s*48px/); // desktop right margin
});

test("ChatOutlineFab renders nothing when there are no messages", () => {
  const scrollContainer = { current: null };
  const messageRefs = { current: [] };

  const html = renderToStaticMarkup(
    React.createElement(ChatOutlineFab, {
      messages: [],
      scrollContainer,
      messageRefs,
      nearBottom: true,
      isMobile: true,
    })
  );

  assert.equal(html, "");
});

test("extractPreviewText strips injected skill instructions and extracts real user query", () => {
  const raw = `[IMPORTANT: User invoked the "donna-brain" skill; follow its instructions. Full skill below.]\n\n# Donna Brain — OKF capture\n\nUser: apa kabar donna?`;
  const preview = extractPreviewText({
    role: "user",
    content: raw,
  });
  assert.equal(preview, "apa kabar donna?");
});
