import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");
afterEach(cleanup);

test("Ask editor preserves an answer on request replay and initializes the next request", async () => {
  const request = {
    type: "extension_ui_request",
    id: "answer-1",
    method: "editor",
    title: "How should this work?",
  };
  const responses = [];
  const onRespond = (current, response) => responses.push({ id: current.id, ...response });
  const dialog = (current) => React.createElement(ExtensionDialog, { request: current, onRespond, attached: true });
  const answer = "Keep my answer\nincluding this second line.";
  const view = render(dialog(request));
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: answer } });

    // Reconnecting SSE reparses the pending request into a fresh object.
    view.rerender(dialog(JSON.parse(JSON.stringify(request))));
    assert.equal(screen.getByRole("textbox").value, answer);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    assert.deepEqual(responses, [{ id: "answer-1", value: answer }]);

    view.rerender(dialog({ ...request, id: "answer-2" }));
    assert.equal(screen.getByRole("textbox").value, "");

    const nextRequest = { ...request, id: "answer-3", prefill: "Suggested answer" };
    view.rerender(dialog(nextRequest));
    assert.equal(screen.getByRole("textbox").value, "Suggested answer");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited suggestion" } });
    view.rerender(dialog(JSON.parse(JSON.stringify(nextRequest))));
    assert.equal(screen.getByRole("textbox").value, "Edited suggestion");

    view.rerender(dialog({ ...request, id: "answer-4" }));
    assert.equal(screen.getByRole("textbox").value, "");
  } finally {
    view.unmount();
  }
});

test("question selection survives request replay but is cleared for the next question", async () => {
  const request = {
    type: "extension_ui_request",
    id: "choice-1",
    method: "select",
    title: "Which approach?",
    options: ["First", "Second"],
  };
  const responses = [];
  const onRespond = (current, response) => responses.push({ id: current.id, ...response });
  const dialog = (current) => React.createElement(ExtensionDialog, { request: current, onRespond, attached: true });
  const view = render(dialog(request));
  try {
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    view.rerender(dialog(JSON.parse(JSON.stringify(request))));
    assert.equal(screen.getByRole("button", { name: "Second" }).getAttribute("aria-pressed"), "true");
    assert.equal(screen.getByRole("button", { name: "Next" }).disabled, false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    assert.deepEqual(responses, [{ id: "choice-1", value: "Second" }]);

    view.rerender(dialog({ ...request, id: "choice-2" }));
    assert.equal(screen.getByRole("button", { name: "Second" }).getAttribute("aria-pressed"), "false");
    assert.equal(screen.getByRole("button", { name: "Next" }).disabled, true);
  } finally {
    view.unmount();
  }
});
