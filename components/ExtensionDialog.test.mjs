import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("Ask editor preserves an answer on request replay and initializes the next request", async () => {
  const request = {
    type: "extension_ui_request",
    id: "answer-1",
    method: "editor",
    title: "How should this work?",
  };
  const responses = [];
  const onRespond = (current, response) => responses.push({ id: current.id, ...response });
  const render = (current) => React.createElement(ExtensionDialog, { request: current, onRespond, attached: true });
  const answer = "Keep my answer\nincluding this second line.";
  let renderer;
  try {
    await act(() => { renderer = TestRenderer.create(render(request)); });
    await act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: answer } }));

    // Reconnecting SSE reparses the pending request into a fresh object.
    await act(() => renderer.update(render(JSON.parse(JSON.stringify(request)))));
    assert.equal(renderer.root.findByType("textarea").props.value, answer);
    await act(() => renderer.root.findByType("textarea").props.onKeyDown({ key: "Enter", ctrlKey: true }));
    assert.deepEqual(responses, [{ id: "answer-1", value: answer }]);

    await act(() => renderer.update(render({ ...request, id: "answer-2" })));
    assert.equal(renderer.root.findByType("textarea").props.value, "");

    const nextRequest = { ...request, id: "answer-3", prefill: "Suggested answer" };
    await act(() => renderer.update(render(nextRequest)));
    assert.equal(renderer.root.findByType("textarea").props.value, "Suggested answer");
    await act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: "Edited suggestion" } }));
    await act(() => renderer.update(render(JSON.parse(JSON.stringify(nextRequest)))));
    assert.equal(renderer.root.findByType("textarea").props.value, "Edited suggestion");

    await act(() => renderer.update(render({ ...request, id: "answer-4" })));
    assert.equal(renderer.root.findByType("textarea").props.value, "");
  } finally {
    await act(() => renderer?.unmount());
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
  const render = (current) => React.createElement(ExtensionDialog, { request: current, onRespond, attached: true });
  let renderer;
  const choice = () => renderer.root.findAllByType("button").find((button) => button.props.children === "Second");
  const next = () => renderer.root.findAllByType("button").find((button) => button.props.disabled !== undefined);
  try {
    await act(() => { renderer = TestRenderer.create(render(request)); });
    await act(() => choice().props.onClick());
    await act(() => renderer.update(render(JSON.parse(JSON.stringify(request)))));
    assert.equal(choice().props["aria-pressed"], true);
    assert.equal(next().props.disabled, false);
    await act(() => next().props.onClick());
    assert.deepEqual(responses, [{ id: "choice-1", value: "Second" }]);

    await act(() => renderer.update(render({ ...request, id: "choice-2" })));
    assert.equal(choice().props["aria-pressed"], false);
    assert.equal(next().props.disabled, true);
  } finally {
    await act(() => renderer?.unmount());
  }
});
