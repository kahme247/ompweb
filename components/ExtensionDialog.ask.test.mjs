import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");

afterEach(cleanup);

const color = {
  id: "color",
  question: "Pick a color",
  header: "Color",
  options: [{ label: "Red" }, { label: "Green", description: "Calm" }, { label: "Blue" }],
  recommended: 1,
};
const size = { id: "size", question: "Pick a size", options: [{ label: "S" }, { label: "M" }] };
const extras = {
  id: "extras",
  question: "Extras?",
  multi: true,
  options: [{ label: "Cheese" }, { label: "Ham" }, { label: "Egg" }],
  recommended: 2,
};

function renderAsk(questions) {
  const responses = [];
  render(React.createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "ask-1", method: "ask", questions },
    onRespond: (_request, response) => responses.push(response),
    attached: true,
  }));
  return responses;
}

test("single-select renders radios with the recommended option marked and preselected; multi renders checkboxes", () => {
  renderAsk([color, extras]);
  const colorGroup = screen.getByRole("group", { name: /Pick a color/ });
  const radios = colorGroup.querySelectorAll('input[type="radio"]');
  assert.equal(radios.length, 3);
  assert.equal(colorGroup.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, true);
  assert.match(screen.getByRole("radio", { name: /Green/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("radio", { name: /Red/ }).checked, false);

  const extrasGroup = screen.getByRole("group", { name: /Extras\?/ });
  assert.equal(extrasGroup.querySelectorAll('input[type="checkbox"]').length, 3);
  assert.equal(extrasGroup.querySelectorAll('input[type="radio"]').length, 0);
  // Multi-select marks its recommendation but does not preselect it.
  assert.match(screen.getByRole("checkbox", { name: /Egg/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("checkbox", { name: /Egg/ }).checked, false);
});

test("Submit stays disabled until every single-select question is answered", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color, size, extras]);
  const submit = screen.getByRole("button", { name: "Submit" });
  assert.equal(submit.disabled, true, "size has no recommendation and no answer yet");
  await user.click(submit);
  assert.deepEqual(responses, []);

  const sizeOther = screen.getByRole("group", { name: /Pick a size/ }).querySelector("textarea");
  await user.type(sizeOther, "   ");
  assert.equal(submit.disabled, true, "blank Other is not an answer");
  await user.clear(sizeOther);
  await user.click(screen.getByRole("radio", { name: "M" }));
  assert.equal(submit.disabled, false, "empty multi-select does not block submit");
});

test("submit sends answers in question order: single choice, multi choices in option order, trimmed Other", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color, extras, size]);
  await user.click(screen.getByRole("checkbox", { name: /Egg/ }));
  await user.click(screen.getByRole("checkbox", { name: /Cheese/ }));
  await user.type(screen.getByRole("group", { name: /Extras\?/ }).querySelector("textarea"), "  pickles  ");
  await user.click(screen.getByRole("radio", { name: "S" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{
    answers: [
      { id: "color", selectedOptions: ["Green"] },
      { id: "extras", selectedOptions: ["Cheese", "Egg"], customInput: "pickles" },
      { id: "size", selectedOptions: ["S"] },
    ],
  }]);
});

test("single-select Other replaces the radio choice, and picking a radio clears Other", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  await user.type(other, " Teal ");
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, false);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] });

  await user.click(screen.getByRole("radio", { name: "Red" }));
  assert.equal(other.value, "");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: ["Red"] }] });
});

test("Cancel answers cancelled", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ cancelled: true }]);
});

test("mobile ask preserves all choices and Other drafts across minimize, replay and breakpoints, then resets a fresh request", () => {
  let request = { type: "extension_ui_request", id: "mobile-ask-1", method: "ask", questions: [color, extras, size] };
  let mobile = true;
  let minimized = false;
  const responses = [];
  let view;
  const form = () => React.createElement(ExtensionDialog, {
    request,
    mobile,
    minimized,
    attached: !mobile,
    onMinimize: () => { minimized = true; view.rerender(form()); },
    onRespond: (_request, response) => responses.push(response),
  });
  view = render(form());
  const otherFields = screen.getAllByRole("textbox");
  fireEvent.click(screen.getByRole("radio", { name: "Red" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Egg/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Cheese/ }));
  fireEvent.change(otherFields[1], { target: { value: "  pickles  " } });
  fireEvent.change(otherFields[2], { target: { value: "  XL  " } });
  fireEvent.click(screen.getByRole("button", { name: "Minimize request" }));
  assert.equal(screen.queryByRole("dialog"), null);
  request = JSON.parse(JSON.stringify(request));
  view.rerender(form());
  assert.equal(screen.queryByRole("dialog"), null, "same-id replay stays minimized");
  mobile = false;
  view.rerender(form());
  mobile = true;
  view.rerender(form());
  minimized = false;
  view.rerender(form());
  assert.deepEqual(screen.getAllByRole("textbox"), otherFields, "same mounted fields survive every presentation");
  assert.equal(otherFields[1].value, "  pickles  ");
  assert.equal(otherFields[2].value, "  XL  ");
  assert.equal(screen.getByRole("radio", { name: "Red" }).checked, true);
  assert.equal(screen.getByRole("checkbox", { name: /Egg/ }).checked, true);
  assert.equal(screen.getByRole("checkbox", { name: /Cheese/ }).checked, true);
  assert.equal(document.activeElement, screen.getByRole("dialog"));
  assert.deepEqual(responses, []);
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [
    { id: "color", selectedOptions: ["Red"] },
    { id: "extras", selectedOptions: ["Cheese", "Egg"], customInput: "pickles" },
    { id: "size", selectedOptions: [], customInput: "XL" },
  ] }]);
  request = { ...request, id: "mobile-ask-2" };
  view.rerender(form());
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, true);
  assert.equal(screen.getByRole("checkbox", { name: /Egg/ }).checked, false);
  assert.equal(screen.getByRole("checkbox", { name: /Cheese/ }).checked, false);
  assert.deepEqual(screen.getAllByRole("textbox").map((field) => field.value), ["", "", ""]);
  assert.equal(screen.getByRole("button", { name: "Submit" }).disabled, true);
});
