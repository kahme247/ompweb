import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");

const { MarkdownBody } = await import("./MarkdownBody.tsx");
const { MessageView } = await import("./MessageView.tsx");
const { AgentLinkContext } = await import("../lib/agent-links.ts");

afterEach(cleanup);

test("clicking an agent:// link opens it in-app with nested-then-base candidates", () => {
  const opened = [];
  const { container } = render(
    React.createElement(AgentLinkContext.Provider, { value: (ids) => opened.push(ids) },
      React.createElement(MarkdownBody, null, "See agent://Parent/Child.")),
  );
  const link = container.querySelector('a[href="agent://Parent/Child"]');

  assert.equal(fireEvent.click(link, { button: 0 }), false, "click default must be prevented");
  assert.equal(fireEvent(link, new window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })), false, "middle-click default must be prevented");
  assert.deepEqual(opened, [["Parent.Child", "Parent"]]);
});

test("a read of an agent:// handle opens the subagent from its tool row without toggling the row", () => {
  const opened = [];
  const openedFiles = [];
  const renderRow = (path) => render(
    React.createElement(AgentLinkContext.Provider, { value: (ids) => opened.push(ids) },
      React.createElement(MessageView, {
        onOpenFile: (file) => openedFiles.push(file),
        message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path } }] },
      })),
  );

  const { container, getByRole } = renderRow("agent://Parent/Child");
  const trigger = container.querySelector("[aria-expanded]");
  const expanded = trigger.getAttribute("aria-expanded");
  fireEvent.click(getByRole("link"));
  fireEvent.keyDown(getByRole("link"), { key: "Enter" });
  assert.deepEqual(opened, [["Parent.Child", "Parent"], ["Parent.Child", "Parent"]]);
  assert.equal(trigger.getAttribute("aria-expanded"), expanded);
  cleanup();

  assert.equal(renderRow("agent://all").queryByRole("link"), null, "the broadcast address is never linked");
  assert.deepEqual(openedFiles, []);
});
