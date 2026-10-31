import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm } from "../components/LoginForm";

test("a password typed into the static sign-in form is in LoginForm's field once the bundle runs", async () => {
  window.history.replaceState(null, "", "/login");
  Object.defineProperty(globalThis, "location", { configurable: true, value: window.location });
  // What app/index.html's inline script puts in #root on /login (LoginForm.test.mjs keeps the two identical).
  document.body.innerHTML = `<div id="root">${renderToStaticMarkup(createElement(LoginForm))}</div>`;
  const staticField = document.querySelector("#root #web-password");
  staticField.value = "typed before the bundle";

  await act(async () => {
    await import("./client.tsx");
  });

  const field = document.querySelector("#root #web-password");
  assert.ok(field && field !== staticField, "LoginForm did not replace the static form");
  assert.equal(field.value, "typed before the bundle");
});
