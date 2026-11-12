import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ExtensionDialog } = await import("./ExtensionDialog.tsx");

afterEach(cleanup);

function renderForm(html) {
  const responses = [];
  render(React.createElement(ExtensionDialog, {
    request: { type: "ui_request", id: 1, method: "formDialog", args: [html] },
    onRespond: (_request, value) => responses.push(value),
    attached: true,
  }));
  return responses;
}

const html = `<form>
  <p>Choose how to deploy. <script>window.pwned = true</script></p>
  <fieldset><legend>Database</legend>
    <label><input type="radio" name="db" value="sqlite"> SQLite</label>
    <label><input type="radio" name="db" value="pg" checked> Postgres</label>
  </fieldset>
  <fieldset><legend>Extras</legend>
    <label><input type="checkbox" name="extras" value="cache" checked> Cache</label>
    <label><input type="checkbox" name="extras" value="logs"> Logs</label>
    <label><input type="checkbox" name="extras" value="metrics" checked> Metrics</label>
  </fieldset>
  <label>Region <select name="region"><option>us</option><option value="eu" selected>Europe</option></select></label>
  <label>Replicas <input type="number" name="replicas" value="3"></label>
  <label>Notes <textarea name="notes">keep it</textarea></label>
  <img src="x" onerror="window.pwned = true"><button type="button" onclick="window.pwned = true">Do it</button>
</form>`;

test("a form submits its pre-checked and prefilled defaults untouched; checkbox groups give arrays", async () => {
  const user = userEvent.setup();
  const responses = renderForm(html);
  assert.ok(screen.getByText(/Choose how to deploy/), "paragraph text is shown");
  assert.ok(screen.getByText("Database"), "legend text is shown");
  assert.equal(screen.getByRole("radio", { name: /Postgres/ }).checked, true);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ data: { db: "pg", extras: ["cache", "metrics"], region: "eu", replicas: 3, notes: "keep it" } }]);
});

test("agent markup never becomes live HTML: scripts, handlers and buttons are dropped", () => {
  renderForm(html);
  const dialog = screen.getByRole("dialog");
  assert.equal(dialog.querySelector("script, img, [onerror], [onclick]"), null);
  assert.equal(screen.queryByRole("button", { name: "Do it" }), null);
  assert.equal(window.pwned, undefined);
});

test("changed answers are submitted, an unchecked radio group is omitted", async () => {
  const user = userEvent.setup();
  const responses = renderForm(`<form>
    <input type="radio" name="size" value="s" id="s"><label for="s">Small</label>
    <label><input type="checkbox" name="extras" value="a" checked> A</label>
    <label><input type="checkbox" name="extras" value="b"> B</label>
    <label><input type="checkbox" name="agree"> Agree</label>
  </form>`);
  await user.click(screen.getByRole("checkbox", { name: /A$/ }));
  await user.click(screen.getByRole("checkbox", { name: /B$/ }));
  await user.click(screen.getByRole("checkbox", { name: /Agree/ }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ data: { extras: ["b"], agree: "on" } }]);
});

test("a radio group's Other text is its value, and picking an option afterwards sets it aside", async () => {
  const user = userEvent.setup();
  const responses = renderForm(`<form><label><input type="radio" name="c" value="r"> Red</label><label><input type="radio" name="c" value="b"> Blue</label></form>`);
  const other = screen.getByRole("textbox", { name: /Other/ });
  await user.click(screen.getByRole("radio", { name: /Red/ }));
  await user.type(other, "  Green ");
  assert.equal(screen.getByRole("radio", { name: /Red/ }).checked, false, "typing drops the picked option");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ data: { c: "Green" } }]);
  await user.click(screen.getByRole("radio", { name: /Blue/ }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses[1], { data: { c: "b" } });
});

test("a checkbox group's Other text is appended to its array; blank adds nothing", async () => {
  const user = userEvent.setup();
  const responses = renderForm(`<form><label><input type="checkbox" name="x" value="a" checked> A</label><label><input type="checkbox" name="x" value="b"> B</label></form>`);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  await user.type(screen.getByRole("textbox", { name: /Other/ }), "mine");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ data: { x: ["a"] } }, { data: { x: ["a", "mine"] } }]);
});

test("no Other box when an option is already labelled Other or the group has one option", () => {
  renderForm(`<form><label><input type="radio" name="c" value="r"> Red</label><label><input type="radio" name="c" value="o"> Other</label><label><input type="checkbox" name="s"> Solo</label></form>`);
  assert.equal(screen.queryByRole("textbox"), null);
});

test("a required group is satisfied by its Other text", async () => {
  const user = userEvent.setup();
  const responses = renderForm(`<form><label><input type="radio" name="c" value="r" required> Red</label><label><input type="radio" name="c" value="b"> Blue</label></form>`);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [], "nothing answered yet");
  await user.type(screen.getByRole("textbox", { name: /Other/ }), "Green");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ data: { c: "Green" } }]);
});
