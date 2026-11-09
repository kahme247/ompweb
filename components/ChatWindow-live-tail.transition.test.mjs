import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";

const { render, fireEvent, cleanup } = await import("@testing-library/react/pure.js");
const { ChatLiveTail } = await import("./ChatWindow-live-tail.tsx");
afterEach(cleanup);

test("first streamed text preserves a manually opened thinking block", () => {
  const thinking = { type: "thinking", thinking: "Checking the details" };
  const message = { role: "assistant", provider: "p", model: "m", timestamp: 1, content: [thinking] };
  const props = {
    streamingMessage: message, isStreaming: true, previousOutputModel: null,
    pendingToolHeaders: [], deferredBash: [], pendingBash: null, toolResults: new Map(),
    modelNames: {}, cwd: undefined, sessionId: undefined,
    toolCallsDefaultCollapsed: true, expandThinkingByDefault: false, hideThinking: false,
  };
  const view = render(React.createElement(ChatLiveTail, props));
  fireEvent.click(view.getByRole("button", { name: /Thinking/ }));
  assert.ok(view.getByText("Checking the details"));
  view.rerender(React.createElement(ChatLiveTail, {
    ...props,
    streamingMessage: { ...message, content: [thinking, { type: "text", text: "First answer" }] },
  }));
  assert.ok(view.getByText("Checking the details"));
  assert.ok(view.getByText("First answer"));
});
