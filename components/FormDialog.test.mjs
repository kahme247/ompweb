import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
const { FormDialog } = await import("./FormDialog.tsx");
afterEach(cleanup);

function mount(html) {
  const responses = [];
  const view = render(React.createElement(React.Fragment, null,
    React.createElement(FormDialog, { html, formId: "test-form", onSubmit: (data) => responses.push(data) }),
    React.createElement("button", { type: "submit", form: "test-form" }, "Send"),
  ));
  const form = view.container.querySelector("form");
  return { ...view, form, responses, submit: () => fireEvent.submit(form) };
}

test("submits native defaults with exact scalar, numeric, array and hidden values", () => {
  const { responses } = mount(`<form>
    <label><input type="radio" name="plan" value="basic" checked>Basic</label>
    <label><input type="radio" name="plan" value="pro">Pro</label>
    <input type="checkbox" name="features" value="a" checked>
    <input type="checkbox" name="features" value="a" checked>
    <input type="checkbox" name="features" value="b">
    <input type="checkbox" name="accepted" value="yes" checked>
    <input type="checkbox" name="omitted" value="no">
    <input name="count" type="number" min="2" value="3">
    <input name="level" type="range" min="0" max="10" value="4">
    <label>Title<input name="title" required value="Hello"></label>
    <textarea name="notes" readonly>Keep me</textarea>
    <input type="hidden" name="secret" value="echo">
    <input name="__proto__" value="safe">
    <select name="choice"><option value="one">One</option><option selected value="two">Two</option></select>
    <select name="many" multiple><option selected value="x">X</option><option selected value="x">X again</option><option disabled selected value="bad">Bad</option></select>
    <input name="disabled" value="bad" disabled>
    <fieldset disabled><input name="fieldset" value="bad"></fieldset>
  </form>`);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  assert.equal(responses.length, 1);
  assert.deepEqual({ ...responses[0] }, {
    plan: "basic", features: ["a"], accepted: "yes", count: 3, level: 4,
    title: "Hello", notes: "Keep me", secret: "echo", ["__proto__"]: "safe",
    choice: "two", many: ["x"],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(responses[0], "__proto__"), true);
  assert.equal(screen.getByRole("textbox", { name: "Title" }).required, true);
});

test("single-option multiple select is scalar and unchosen multi-groups are empty arrays", () => {
  const { submit, responses } = mount(`<select name="one" multiple><option selected value="only">Only</option></select>
    <select name="empty" multiple><option value="a">A</option><option value="b">B</option></select>
    <input type="checkbox" name="checks" value="a"><input type="checkbox" name="checks" value="b">`);
  submit();
  assert.deepEqual({ ...responses[0] }, { one: "only", empty: [], checks: [] });
});

test("required checkbox groups accept any option rather than requiring every checkbox", () => {
  const { form, submit, responses } = mount(`<input type="checkbox" name="checks" value="a" required>
    <input type="checkbox" name="checks" value="b" required>`);
  submit();
  assert.equal(responses.length, 0);
  assert.equal(form.checkValidity(), false);
  fireEvent.click(form.querySelector('input[value="b"]'));
  assert.equal(form.checkValidity(), true);
  submit();
  assert.deepEqual({ ...responses[0] }, { checks: ["b"] });
});

test("Other replaces a radio answer, preserves its draft, and cannot equal a listed option", () => {
  const { container, submit, responses } = mount(`<fieldset><legend>Plan</legend>
    <label><input type="radio" name="plan" value="basic" required checked>Basic</label>
    <label><input type="radio" name="plan" value="pro">Pro</label></fieldset>`);
  const other = container.querySelector('[data-other-choice]');
  const text = container.querySelector('[data-other-text]');
  fireEvent.click(other);
  submit();
  assert.equal(responses.length, 0);
  fireEvent.input(text, { target: { value: "custom" } });
  submit();
  assert.deepEqual({ ...responses[0] }, { plan: "custom" });
  fireEvent.click(screen.getByRole("radio", { name: "Pro" }));
  assert.equal(text.disabled, true);
  submit();
  assert.deepEqual({ ...responses[1] }, { plan: "pro" });
  fireEvent.click(other);
  assert.equal(text.value, "custom");
  fireEvent.input(text, { target: { value: "basic" } });
  submit();
  assert.equal(responses.length, 2);
});

test("checkbox Other adds exactly one custom array member and satisfies group required", () => {
  const { container, submit, responses } = mount(`<input type="checkbox" name="checks" value="a" required>
    <input type="checkbox" name="checks" value="b">`);
  fireEvent.click(container.querySelector('[data-other-choice]'));
  fireEvent.input(container.querySelector('[data-other-text]'), { target: { value: "custom" } });
  submit();
  assert.deepEqual({ ...responses[0] }, { checks: ["custom"] });
  fireEvent.click(container.querySelector('input[value="b"]'));
  submit();
  assert.deepEqual({ ...responses[1] }, { checks: ["b", "custom"] });
});

test("keeps native numeric and text constraints before emitting a response", () => {
  const { form, submit, responses } = mount(`<label>Count<input name="count" type="number" min="2" max="4" value="1"></label>
    <label>Email<input name="email" type="email" required></label>
    <input name="code" pattern="[A-Z]{2}" minlength="2" maxlength="2" value="AB">
    <input name="site" type="url" value="https://example.test">`);
  submit();
  assert.equal(responses.length, 0);
  const count = screen.getByRole("spinbutton", { name: "Count" });
  assert.equal(count.validity.rangeUnderflow, true);
  fireEvent.input(count, { target: { value: "2" } });
  fireEvent.input(screen.getByRole("textbox", { name: "Email" }), { target: { value: "bad" } });
  submit();
  assert.equal(responses.length, 0);
  fireEvent.input(screen.getByRole("textbox", { name: "Email" }), { target: { value: "a@example.test" } });
  assert.equal(form.querySelector('[name="code"]').minLength, 2);
  assert.equal(form.querySelector('[name="code"]').maxLength, 2);
  submit();
  assert.deepEqual({ ...responses[0] }, { count: 2, email: "a@example.test", code: "AB", site: "https://example.test" });
});

test("sanitizes before rendering and removes submission, navigation and ownership capabilities", () => {
  const { container, form, submit, responses } = mount(`<form id="outside" action="https://evil.test" onsubmit="alert(1)">
    <script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.test"></iframe>
    <img src="javascript:alert(1)" onerror="alert(1)" style="display:none">
    <img src="data:text/html,evil"><img src="https://example.test/safe.png" alt="safe">
    <a href="javascript:alert(1)" onclick="alert(1)">Link</a>
    <input name="ok" value="yes" form="outside" formaction="https://evil.test" autofocus style="color:red" onclick="alert(1)">
    <input type="image" src="https://evil.test/submit"><button formaction="https://evil.test">Leak</button>
    <form action="https://evil.test"><input name="nested" value="kept"></form>
    <input name="reportValidity" value="safe"><input name="elements" value="safe">
  </form>`);
  assert.equal(container.querySelectorAll("form").length, 1);
  assert.equal(container.querySelector("script,style,iframe,button[formaction],input[type=image]"), null);
  assert.equal(container.querySelector("[onclick],[onerror],[onsubmit],[style],[autofocus],[formaction],[action]"), null);
  assert.equal(container.querySelector('a[href]'), null);
  assert.equal(container.querySelector('img[src^="javascript:"],img[src^="data:text"]'), null);
  assert.equal(container.querySelector('img[alt="safe"]').getAttribute("src"), "https://example.test/safe.png");
  assert.equal(form.querySelector('[name="ok"]').form, form);
  assert.equal(document.activeElement, document.body);
  submit();
  assert.deepEqual({ ...responses[0] }, { ok: "yes", nested: "kept", reportValidity: "safe", elements: "safe" });
});

test("required radio groups allow a complete Other answer but reject no choice", () => {
  const { container, form, submit, responses } = mount(`<input type="radio" name="plan" value="a" required>
    <input type="radio" name="plan" value="b">`);
  assert.equal(form.checkValidity(), false);
  submit();
  assert.equal(responses.length, 0);
  fireEvent.click(container.querySelector("[data-other-choice]"));
  assert.equal(form.checkValidity(), false);
  fireEvent.input(container.querySelector("[data-other-text]"), { target: { value: "custom" } });
  assert.equal(form.checkValidity(), true);
  submit();
  assert.deepEqual({ ...responses[0] }, { plan: "custom" });
});

test("disabled options retain group cardinality without becoming successful values", () => {
  const { submit, responses } = mount(`<input type="checkbox" name="checks" value="a" disabled checked required>
    <input type="checkbox" name="checks" value="b">
    <select name="many" multiple><option value="a" disabled selected>A</option><option value="b" selected>B</option></select>`);
  submit();
  assert.deepEqual({ ...responses[0] }, { checks: [], many: ["b"] });
});

test("Other's native FormData marker cannot collide with a real option value", () => {
  const { container, submit, responses } = mount(`<input type="checkbox" name="checks" value="__omp_other__" checked>
    <input type="checkbox" name="checks" value="__omp_other___">`);
  fireEvent.click(container.querySelector("[data-other-choice]"));
  fireEvent.input(container.querySelector("[data-other-text]"), { target: { value: "custom" } });
  submit();
  assert.deepEqual({ ...responses[0] }, { checks: ["__omp_other__", "custom"] });
});
