import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { ExtensionDialog } = await import("./ExtensionDialog.tsx");
afterEach(cleanup);

function mount(extra = {}, attached = true) {
  const responses = [];
  const request = { type: "extension_ui_request", id: "whole-form", method: "form", html: '<form><label>Name<input name="name" required value="Ada"></label></form>', ...extra };
  const view = render(React.createElement(ExtensionDialog, { request, attached, onRespond: (req, response) => responses.push({ id: req.id, ...response }) }));
  return { ...view, responses, request };
}

for (const attached of [true, false]) {
  test(`whole form submits data without opt-in state (${attached ? "attached" : "overlay"})`, () => {
    const { responses } = mount({}, attached);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    assert.deepEqual(responses.map(response => ({ ...response, data: { ...response.data } })), [{ id: "whole-form", data: { name: "Ada" } }]);
  });
}

test("form Cancel does not submit defaults", () => {
  const { responses } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ id: "whole-form", cancelled: true }]);
});

test("expired replay answers timedOut exactly once, retaining absolute deadline across replay", async () => {
  const { responses, request, rerender } = mount({ expiresAt: Date.now() - 1, timeout: 60_000 });
  await waitFor(() => assert.deepEqual(responses, [{ id: "whole-form", cancelled: true, timedOut: true }]));
  rerender(React.createElement(ExtensionDialog, { request: { ...request }, attached: true, onRespond: (req, response) => responses.push({ id: req.id, ...response }) }));
  assert.equal(responses.length, 1);
});

test("changing request cancels the previous timeout", async () => {
  const { responses, rerender } = mount({ timeout: 20 });
  rerender(React.createElement(ExtensionDialog, { request: { type: "extension_ui_request", id: "new-form", method: "form", html: '<input name="text" value="new">' }, attached: true, onRespond: (req, response) => responses.push({ id: req.id, ...response }) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  assert.deepEqual(responses, []);
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.map(response => ({ ...response, data: { ...response.data } })), [{ id: "new-form", data: { text: "new" } }]);
});

test("a refused form reply keeps the values available for retry", async () => {
  let attempts = 0;
  const request = { type: "extension_ui_request", id: "retry-form", method: "form", html: '<input name="text" value="keep">' };
  render(React.createElement(ExtensionDialog, { request, attached: true, onRespond: async () => { attempts++; return false; } }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit" })); });
  assert.equal(attempts, 1);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit" })); });
  assert.equal(attempts, 2);
  assert.equal(screen.getByRole("textbox").value, "keep");
});
