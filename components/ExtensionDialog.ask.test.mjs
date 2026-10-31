import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ExtensionDialog } = await import("./ExtensionDialog.tsx");

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
  assert.equal(colorGroup.querySelectorAll('input[type="radio"]').length, 4, "three options and Other");
  assert.equal(colorGroup.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, true);
  assert.match(screen.getByRole("radio", { name: /Green/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("radio", { name: /Red/ }).checked, false);

  const extrasGroup = screen.getByRole("group", { name: /Extras\?/ });
  assert.equal(extrasGroup.querySelectorAll('input[type="checkbox"]').length, 4, "three options and Other");
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

test("typing in Other chooses it and replaces the radio choice", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  const other = screen.getByRole("radio", { name: "Other: type your own answer" });
  await user.type(screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea"), " Teal ");
  assert.equal(other.checked, true);
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, false);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] });
});

test("the Other text stays when another option is chosen and counts again when Other is", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  const field = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  const other = screen.getByRole("radio", { name: "Other: type your own answer" });
  await user.type(field, "Teal");
  await user.click(screen.getByRole("radio", { name: "Red" }));
  assert.equal(field.value, "Teal", "the typed text outlives the choice");
  assert.equal(other.checked, false);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: ["Red"] }] }, "an unchosen Other is not sent");

  await user.click(other);
  assert.equal(document.activeElement, field, "choosing Other puts the cursor in its text");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] });
});

test("going back into the kept Other text chooses Other again", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  const field = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  await user.type(field, "Teal");
  await user.click(screen.getByRole("radio", { name: "Red" }));
  await user.click(field);
  assert.equal(screen.getByRole("radio", { name: "Other: type your own answer" }).checked, true);
  assert.equal(screen.getByRole("radio", { name: "Red" }).checked, false);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] }]);
});

test("a chosen but blank Other blocks single-select Submit, and clearing the text unchooses it", async () => {
  const user = userEvent.setup();
  renderAsk([size]);
  const other = screen.getByRole("radio", { name: "Other: type your own answer" });
  const field = screen.getByRole("group", { name: /Pick a size/ }).querySelector("textarea");
  await user.click(other);
  assert.equal(screen.getByRole("button", { name: "Submit" }).disabled, true);
  await user.type(field, "XL");
  assert.equal(screen.getByRole("button", { name: "Submit" }).disabled, false);
  await user.clear(field);
  assert.equal(other.checked, false);
});

test("multi-select Other is a checkbox alongside the options, and unchecking keeps its text", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([extras]);
  const other = screen.getByRole("checkbox", { name: "Other: type your own answer" });
  const field = screen.getByRole("group", { name: /Extras\?/ }).querySelector("textarea");
  await user.click(screen.getByRole("checkbox", { name: /Cheese/ }));
  await user.type(field, "Pickles");
  assert.equal(screen.getByRole("checkbox", { name: /Cheese/ }).checked, true, "multi keeps its choices");
  await user.click(other);
  assert.equal(other.checked, false);
  assert.equal(field.value, "Pickles");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [{ id: "extras", selectedOptions: ["Cheese"] }] }]);
});

test("Cancel answers cancelled", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ cancelled: true }]);
});
