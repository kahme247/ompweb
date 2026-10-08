import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { InteractiveRequestPanel } = await jiti.import("./InteractiveRequestPanel.tsx");
afterEach(cleanup);

const request = { type: "extension_ui_request", id: "request-1", method: "editor", title: "Response needed" };

function harness(initial = {}) {
  const responses = [];
  let backHandler = null;
  const onMobileRequestChange = (handler) => { backHandler = handler; };
  const onRespond = (current, response) => responses.push({ id: current.id, ...response });
  let props = { request, mobile: true, ...initial };
  function Tree() {
    return React.createElement("section", { "data-request-viewport": "", tabIndex: -1, "aria-label": "Conversation" },
      React.createElement(InteractiveRequestPanel, { ...props, onRespond, onMobileRequestChange }),
      React.createElement("div", { style: { display: "none" }, "data-collapsed-composer": true },
        React.createElement("textarea", { "aria-label": "Composer draft", defaultValue: "do not change" })));
  }
  const view = render(React.createElement(Tree));
  return {
    ...view,
    responses,
    get backHandler() { return backHandler; },
    update(next) { props = { ...props, ...next }; view.rerender(React.createElement(Tree)); },
  };
}

test("request minimize/replay/reopen preserves the mounted draft independently of a collapsed composer", async () => {
  const view = harness();
  const textarea = screen.getByRole("textbox");
  assert.notEqual(document.activeElement, textarea);
  fireEvent.change(textarea, { target: { value: "keep request\nand second line" } });
  await act(() => view.backHandler());
  assert.equal(view.backHandler, null);
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(textarea.isConnected, true);
  const reopen = screen.getByRole("button", { name: "Open request" });
  assert.equal(reopen.closest("[data-collapsed-composer]"), null);
  assert.equal(document.activeElement, reopen, "minimizing returns focus to the real reopen button");
  assert.equal(screen.getByRole("status").textContent, "Response pending");
  view.update({ request: JSON.parse(JSON.stringify(request)) });
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(textarea.value, "keep request\nand second line");
  fireEvent.click(screen.getByRole("button", { name: "Open request" }));
  assert.equal(screen.getByRole("textbox"), textarea);
  assert.equal(textarea.value, "keep request\nand second line");
  assert.notEqual(document.activeElement, textarea);
  assert.equal(document.querySelector('[aria-label="Composer draft"]').value, "do not change");
  fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
  assert.deepEqual(view.responses, [{ id: "request-1", value: "keep request\nand second line" }]);
});

test("resize preserves request visibility and DOM, while new identity opens and resets the form", async () => {
  const view = harness();
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: "resize draft" } });
  view.update({ mobile: false });
  assert.equal(screen.getByRole("textbox"), textarea);
  assert.equal(textarea.value, "resize draft");
  assert.equal(view.backHandler, null);
  view.update({ mobile: true });
  assert.equal(screen.getByRole("textbox"), textarea);
  assert.equal(typeof view.backHandler, "function");
  await act(() => view.backHandler());
  view.update({ mobile: false });
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(textarea.value, "resize draft");
  assert.ok(screen.getByRole("button", { name: "Open request" }));
  view.update({ mobile: true, request: { ...request, id: "request-2", prefill: "new draft" } });
  assert.equal(screen.getByRole("textbox"), textarea);
  assert.equal(textarea.value, "new draft");
  assert.equal(typeof view.backHandler, "function");
  view.update({ request: null });
  assert.equal(view.backHandler, null);
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.queryByRole("status"), null);
  assert.equal(screen.queryByRole("button", { name: "Open request" }), null);
});

test("Escape minimizes a mobile request without responding or cancelling", () => {
  const view = harness();
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: "Escape keeps draft" } });
  fireEvent.keyDown(textarea, { key: "Escape" });
  assert.deepEqual(view.responses, []);
  assert.equal(view.backHandler, null);
  assert.equal(textarea.value, "Escape keeps draft");
  fireEvent.click(screen.getByRole("button", { name: "Open request" }));
  assert.equal(screen.getByRole("textbox"), textarea);
  assert.equal(textarea.value, "Escape keeps draft");
});

test("an opened workspace panel keeps focus and the pending answer intact", () => {
  const panel = document.createElement("button");
  panel.textContent = "Close file panel";
  document.body.append(panel);
  try {
    panel.focus();
    const view = harness({ obscured: true });
    assert.equal(document.activeElement, panel, "arrival must not steal the file panel's focus");
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "answer in progress" } });
    fireEvent.keyDown(panel, { key: "Escape" });
    assert.ok(screen.getByRole("dialog"), "panel Escape must not reduce the question");
    view.update({ obscured: false });
    assert.equal(document.activeElement, screen.getByRole("dialog"));
    assert.equal(screen.getByRole("textbox"), field);
    assert.equal(field.value, "answer in progress");
    assert.deepEqual(view.responses, []);
    view.unmount();
  } finally { panel.remove(); }
});

for (const action of ["Submit", "Cancel"]) {
  test(`mobile ${action} settlement returns focus to the conversation without reopening the composer`, () => {
    const view = harness();
    const conversation = screen.getByLabelText("Conversation");
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "My answer" } });
    const button = screen.getByRole("button", { name: action });
    button.focus();
    fireEvent.click(button);
    assert.deepEqual(view.responses, [{
      id: request.id,
      ...(action === "Submit" ? { value: "My answer" } : { cancelled: true }),
    }]);
    assert.equal(document.activeElement, button, "wait for successful settlement before restoring focus");
    // Mirror the hook clearing the request after a successful RPC response.
    view.update({ request: null });
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(screen.queryByRole("button", { name: "Open request" }), null);
    assert.ok(document.activeElement === conversation,
      `Expected conversation focus after ${action}, got ${document.activeElement?.tagName}`);
  });
}

for (const obscured of [false, true]) {
  test(`settlement preserves external control focus with obscured=${obscured}`, () => {
    const control = document.createElement("button");
    control.textContent = "Workspace control";
    document.body.append(control);
    try {
      const view = harness();
      const submit = screen.getByRole("button", { name: "Submit" });
      submit.focus();
      fireEvent.click(submit);
      view.update({ obscured });
      control.focus();
      view.update({ request: null });
      assert.ok(document.activeElement === control, "settlement must not steal toolbar or drawer focus");
    } finally { control.remove(); }
  });
}

test("a replacement question retains focus and leaving the conversation does not restore a detached target", () => {
  const view = harness();
  screen.getByRole("button", { name: "Submit" }).focus();
  view.update({ request: { ...request, id: "replacement" } });
  assert.ok(document.activeElement === screen.getByRole("dialog"));
  const conversation = screen.getByLabelText("Conversation");
  let restored = false;
  conversation.addEventListener("focus", () => { restored = true; });
  view.unmount();
  assert.equal(restored, false, "a removed conversation must not receive focus");
});

test("settlement and unmount unregister Back; an old request callback cannot minimize its replacement", async () => {
  const view = harness();
  const oldHandler = view.backHandler;
  view.update({ request: { ...request, id: "request-2" } });
  await act(() => oldHandler());
  assert.ok(screen.getByRole("dialog"));
  assert.equal(typeof view.backHandler, "function");
  view.update({ request: null });
  assert.equal(view.backHandler, null);
  view.update({ request: { ...request, id: "request-3" } });
  assert.equal(typeof view.backHandler, "function");
  view.unmount();
  assert.equal(view.backHandler, null);
});
