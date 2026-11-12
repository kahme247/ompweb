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
    request: { type: "extension_ui_request", id: "form-1", method: "form", html },
    onRespond: (_request, response) => responses.push(response),
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
