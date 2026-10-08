import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");
const { ToastProvider, toast } = await jiti.import("./ui/toast.tsx");
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

function mobileForm(request, onRespond = () => {}) {
  let minimized = false;
  let mobile = true;
  let current = request;
  let minimizeCount = 0;
  let view;
  const form = () => React.createElement("section", { "data-request-viewport": "" },
    React.createElement("button", {
      "data-extension-request-opener": "",
      "data-extension-request-reopen": "",
      onClick: () => { minimized = false; view.rerender(form()); },
    }, "Open request"),
    React.createElement(ExtensionDialog, {
      request: current,
      onRespond,
      attached: !mobile,
      mobile,
      minimized,
      onMinimize: () => { minimizeCount++; minimized = true; view.rerender(form()); },
    }),
  );
  view = render(form());
  return {
    view,
    replay(next = JSON.parse(JSON.stringify(current))) { current = next; view.rerender(form()); },
    resize(next) { mobile = next; view.rerender(form()); },
    get minimizeCount() { return minimizeCount; },
  };
}

for (const method of ["input", "editor"]) {
  test(`mobile ${method} opens without text focus and keeps its mounted draft across minimize, replay and resize`, () => {
    const responses = [];
    const request = { type: "extension_ui_request", id: `${method}-mobile-1`, method, title: "Your answer", prefill: "Suggestion" };
    const form = mobileForm(request, (_current, response) => responses.push(response));
    const panel = screen.getByRole("dialog");
    const field = screen.getByRole("textbox");
    assert.equal(document.activeElement, panel);
    fireEvent.change(field, { target: { value: "My unfinished answer" } });
    field.focus();
    form.resize(false);
    assert.equal(screen.getByRole("textbox"), field);
    assert.equal(document.activeElement, field, "desktop resize does not move focus");
    form.resize(true);
    assert.equal(document.activeElement, field, "mobile resize does not move focus");
    form.replay();
    assert.equal(document.activeElement, field);
    fireEvent.click(screen.getByRole("button", { name: "Minimize request" }));
    assert.equal(form.minimizeCount, 1);
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(field.isConnected, true, "minimizing hides rather than unmounts");
    assert.equal(document.activeElement, screen.getByRole("button", { name: "Open request" }));
    assert.deepEqual(responses, []);
    form.replay();
    assert.equal(screen.queryByRole("dialog"), null, "same-id replay does not reopen");
    form.resize(false);
    assert.equal(screen.queryByRole("dialog"), null, "resize does not reopen");
    form.resize(true);
    fireEvent.click(screen.getByRole("button", { name: "Open request" }));
    assert.equal(screen.getByRole("textbox"), field);
    assert.equal(field.value, "My unfinished answer");
    assert.equal(document.activeElement, panel);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    assert.deepEqual(responses, [{ value: "My unfinished answer" }]);
    form.replay({ ...request, id: `${method}-mobile-2`, prefill: "Fresh suggestion" });
    assert.equal(field.value, method === "editor" ? "Fresh suggestion" : "");
    assert.equal(document.activeElement, panel, "fresh mobile request never retains text focus");
  });
}

test("mobile select requires explicit submit and preserves the selected option until the next request", () => {
  const responses = [];
  const request = { type: "extension_ui_request", id: "mobile-choice-1", method: "select", title: "Choose", options: ["First", "Second"] };
  const form = mobileForm(request, (_current, response) => responses.push(response));
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  assert.deepEqual(responses, [], "choosing an option is not submission");
  const choice = screen.getByRole("button", { name: "Second" });
  fireEvent.click(screen.getByRole("button", { name: "Minimize request" }));
  form.replay();
  form.resize(false);
  fireEvent.click(screen.getByRole("button", { name: "Open request" }));
  assert.equal(screen.getByRole("button", { name: "Second" }), choice);
  assert.equal(choice.getAttribute("aria-pressed"), "true");
  form.resize(true);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  assert.deepEqual(responses, [{ value: "Second" }]);
  form.replay({ ...request, id: "mobile-choice-2" });
  assert.equal(choice.getAttribute("aria-pressed"), "false");
  assert.equal(screen.getByRole("button", { name: "Next" }).disabled, true);
});

test("mobile Escape minimizes without responding, while Cancel and Confirm remain explicit responses", () => {
  const responses = [];
  const form = mobileForm({ type: "extension_ui_request", id: "mobile-confirm", method: "confirm", title: "Continue?", message: "Check this first" }, (_current, response) => responses.push(response));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", isComposing: true });
  assert.equal(form.minimizeCount, 0, "IME Escape does not minimize");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  assert.equal(form.minimizeCount, 1);
  assert.deepEqual(responses, []);
  fireEvent.click(screen.getByRole("button", { name: "Open request" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ cancelled: true }]);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  assert.deepEqual(responses, [{ cancelled: true }, { confirmed: true }]);
});

test("mobile isolation stays inside the conversation and leaves toolbar and panels available", () => {
  const outside = document.createElement("button");
  const alreadyInert = document.createElement("div");
  alreadyInert.setAttribute("inert", "existing");
  document.body.append(outside, alreadyInert);
  const overflow = document.body.style.overflow;
  document.body.style.overflow = "clip";
  try {
    const form = mobileForm({ type: "extension_ui_request", id: "mobile-isolation", method: "input", title: "Isolated" });
    const reopen = screen.getByRole("button", { name: "Open request" });
    assert.equal(reopen.hasAttribute("inert"), true, "sibling inside the chat is isolated");
    assert.equal(outside.hasAttribute("inert"), false, "toolbar and panel siblings remain available");
    assert.equal(document.body.style.overflow, "clip");
    fireEvent.click(screen.getByRole("button", { name: "Minimize request" }));
    assert.equal(reopen.hasAttribute("inert"), false);
    assert.equal(outside.hasAttribute("inert"), false);
    assert.equal(alreadyInert.getAttribute("inert"), "existing");
    assert.equal(document.body.style.overflow, "clip");
    fireEvent.click(reopen);
    assert.equal(outside.hasAttribute("inert"), false);
    form.resize(false);
    assert.equal(outside.hasAttribute("inert"), false, "attached desktop releases isolation");
    form.resize(true);
    assert.equal(outside.hasAttribute("inert"), false);
    form.view.unmount();
    assert.equal(outside.hasAttribute("inert"), false);
    assert.equal(alreadyInert.getAttribute("inert"), "existing");
    assert.equal(document.body.style.overflow, "clip");
  } finally {
    outside.remove();
    alreadyInert.remove();
    document.body.style.overflow = overflow;
  }
});

test("mobile isolation covers conversation siblings that mount while the question is open", async () => {
  const conversation = document.createElement("section");
  conversation.setAttribute("data-request-viewport", "");
  document.body.append(conversation);
  const outside = document.createElement("button");
  document.body.append(outside);
  let view;
  const form = () => React.createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "late-sibling", method: "input", title: "Late" },
    mobile: true,
    onRespond: () => {},
    onMinimize: () => {},
  });
  try {
    view = render(form(), { container: conversation });
    const late = document.createElement("div");
    late.textContent = "mounted after open";
    await act(() => conversation.append(late));
    assert.equal(late.hasAttribute("inert"), true, "a sibling added after opening is isolated too");
    assert.equal(outside.hasAttribute("inert"), false, "toolbar siblings outside the conversation stay available");
    view.unmount();
    assert.equal(late.hasAttribute("inert"), false, "isolation is released on unmount");
  } finally {
    view?.unmount();
    conversation.remove();
    outside.remove();
  }
});

test("mobile questions leave real toast notifications accessible and dismissible", async () => {
  const view = render(React.createElement(ToastProvider));
  view.rerender(React.createElement(ToastProvider, null,
    React.createElement(ExtensionDialog, {
      request: { type: "extension_ui_request", id: "toast-isolation", method: "input", title: "Your answer" },
      mobile: true,
      onRespond: () => {},
      onMinimize: () => {},
    })));
  let closed = false;
  let id;
  try {
    await act(() => {
      id = toast.error("Answer could not be delivered", "Please retry", { timeout: 0, onClose: () => { closed = true; } });
    });
    const notification = await screen.findByText("Answer could not be delivered");
    assert.equal(notification.closest("[inert]"), null, "notifications must not inherit modal isolation");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    assert.equal(closed, true);
    assert.ok(screen.getByRole("dialog", { name: "Your answer" }));
  } finally {
    await act(() => toast.close(id));
    view.unmount();
  }
});

test("legacy desktop overlay keeps Escape and backdrop cancellation", () => {
  const responses = [];
  const view = render(React.createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "desktop-overlay", method: "confirm", title: "Continue?" },
    onRespond: (_current, response) => responses.push(response),
  }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  assert.deepEqual(responses, [{ cancelled: true }]);
  fireEvent.mouseDown(view.container.firstElementChild);
  assert.deepEqual(responses, [{ cancelled: true }, { cancelled: true }]);
});

test("visual-only keyboard resize and pan preserve the answer and release sizing outside mobile", () => {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = new window.EventTarget();
  Object.assign(viewport, { height: 915, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.hasAttribute("data-request-viewport") ? { top: 0, bottom: 2000 } : rect.call(this);
  };
  const responses = [];
  const form = mobileForm({ type: "extension_ui_request", id: "keyboard", method: "input", title: "Answer" },
    (_request, response) => responses.push(response));
  const field = screen.getByRole("textbox");
  const wrapper = screen.getByRole("dialog").parentElement;
  const sizing = () => [wrapper.style.getPropertyValue("--request-viewport-height"), wrapper.style.getPropertyValue("--request-viewport-top")];
  try {
    fireEvent.change(field, { target: { value: "Keep while typing" } });
    field.focus();
    const layoutHeight = window.innerHeight;
    viewport.height = 390;
    fireEvent(viewport, new window.Event("resize"));
    assert.equal(window.innerHeight, layoutHeight, "the keyboard did not resize the layout viewport");
    assert.deepEqual(sizing(), ["390px", "0px"]);
    viewport.offsetTop = 45;
    fireEvent(viewport, new window.Event("scroll"));
    assert.deepEqual(sizing(), ["390px", "45px"]);
    assert.equal(document.activeElement, field);
    assert.equal(field.value, "Keep while typing");
    assert.deepEqual(responses, []);

    fireEvent.click(screen.getByRole("button", { name: "Minimize request" }));
    viewport.height = 500;
    fireEvent(viewport, new window.Event("resize"));
    assert.deepEqual(sizing(), ["", ""], "hidden panel stops tracking the viewport");
    fireEvent.click(screen.getByRole("button", { name: "Open request" }));
    assert.deepEqual(sizing(), ["500px", "45px"]);
    form.resize(false);
    fireEvent(viewport, new window.Event("scroll"));
    assert.deepEqual(sizing(), ["", ""], "desktop sizing is not constrained by mobile geometry");
    form.resize(true);
    viewport.height = 915;
    viewport.offsetTop = 0;
    fireEvent(viewport, new window.Event("resize"));
    assert.deepEqual(sizing(), ["915px", "0px"]);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    assert.deepEqual(responses, [{ value: "Keep while typing" }]);
    form.view.unmount();
    viewport.height = 300;
    fireEvent(viewport, new window.Event("resize"));
    assert.deepEqual(sizing(), ["", ""]);
  } finally {
    form.view.unmount();
    HTMLElement.prototype.getBoundingClientRect = rect;
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete window.visualViewport;
  }
});

test("a question starts below the toolbar and ends above the visual keyboard", () => {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = new window.EventTarget();
  Object.assign(viewport, { height: 420, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.hasAttribute("data-request-viewport") ? { top: 96, bottom: 800 } : rect.call(this);
  };
  try {
    const form = mobileForm({ type: "extension_ui_request", id: "toolbar-bounds", method: "input", title: "Answer" });
    const wrapper = screen.getByRole("dialog").parentElement;
    assert.equal(wrapper.style.getPropertyValue("--request-viewport-top"), "96px");
    assert.equal(wrapper.style.getPropertyValue("--request-viewport-height"), "324px");
    assert.equal(screen.getByRole("dialog").getAttribute("aria-modal"), null);
    form.view.unmount();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete window.visualViewport;
  }
});

test("the conversation root never shows a focus ring when the request hands it focus", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const rule = css.match(/\[data-request-viewport\]:focus,\s*\[data-request-viewport\]:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /outline:\s*none/);
});
