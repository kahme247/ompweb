import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render } = await import("@testing-library/react/pure.js");

const { ChatLiveTail } = await import("./ChatWindow-live-tail.tsx");
afterEach(cleanup);

const reply = {
  role: "assistant",
  provider: "p",
  model: "m",
  timestamp: 1_700_000_000_000,
  content: [{ type: "text", text: "Hello from the live reply" }],
};

function renderTail(isStreaming) {
  return render(React.createElement(ChatLiveTail, {
    streamingMessage: reply,
    isStreaming,
    liveTokensPerSecond: isStreaming ? 42 : undefined,
    pendingToolHeaders: [],
    deferredBash: [],
    pendingBash: null,
    toolResults: new Map(),
    modelNames: {},
    cwd: undefined,
    sessionId: "s",
    toolCallsDefaultCollapsed: true,
    expandThinkingByDefault: false,
    hideThinking: false,
  }));
}

test("a reply omp is still generating renders as live: speed shown, finished-reply actions hidden", () => {
  const { container } = renderTail(true);
  assert.ok(container.querySelector('[data-live="true"]'), "the live reply is marked live");
  assert.match(container.textContent, /42\.0 t\/s/);
  assert.equal(container.querySelector(".message-assistant-footer"), null);
});

test("a finished reply held until its saved row appears renders as finished", () => {
  const { container } = renderTail(false);
  assert.equal(container.querySelector('[data-live="true"]'), null);
  assert.doesNotMatch(container.textContent, /t\/s/);
  assert.ok(container.querySelector(".message-assistant-footer"), "copy actions are available once the reply finished");
});
