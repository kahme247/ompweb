import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");

const { ExtensionDialog } = await import("./ExtensionDialog.tsx");
afterEach(cleanup);

test("Ask editor preserves an answer on request replay and initializes the next request", async () => {
  const request = { type: "ui_request", id: 1, method: "editor", args: ["How should this work?"] };
  const responses = [];
  const onRespond = (current, value) => responses.push({ id: current.id, value });
  const dialog = (current) => React.createElement(ExtensionDialog, { request: current, onRespond, attached: true });
  const answer = "Keep my answer\nincluding this second line.";
  const view = render(dialog(request));
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: answer } });

    // Reconnecting SSE reparses the pending request into a fresh object.
    view.rerender(dialog(JSON.parse(JSON.stringify(request))));
    assert.equal(screen.getByRole("textbox").value, answer);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    assert.deepEqual(responses, [{ id: 1, value: answer }]);

    view.rerender(dialog({ ...request, id: 2 }));
    assert.equal(screen.getByRole("textbox").value, "");

    const nextRequest = { ...request, id: 3, args: ["How should this work?", "Suggested answer"] };
    view.rerender(dialog(nextRequest));
    assert.equal(screen.getByRole("textbox").value, "Suggested answer");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited suggestion" } });
    view.rerender(dialog(JSON.parse(JSON.stringify(nextRequest))));
    assert.equal(screen.getByRole("textbox").value, "Edited suggestion");

    view.rerender(dialog({ ...request, id: 4 }));
    assert.equal(screen.getByRole("textbox").value, "");
  } finally {
    view.unmount();
  }
});

test("question selection survives request replay but is cleared for the next question", async () => {
  const request = { type: "ui_request", id: 1, method: "select", args: ["Which approach?", ["First", { label: "Second", description: "the other one" }]] };
  const responses = [];
  const onRespond = (current, value) => responses.push({ id: current.id, value });
  const dialog = (current) => React.createElement(ExtensionDialog, { request: current, onRespond, attached: true });
  const view = render(dialog(request));
  try {
    fireEvent.click(screen.getByRole("button", { name: /^Second/ }));
    view.rerender(dialog(JSON.parse(JSON.stringify(request))));
    assert.equal(screen.getByRole("button", { name: /^Second/ }).getAttribute("aria-pressed"), "true");
    assert.equal(screen.getByRole("button", { name: "Next" }).disabled, false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // omp's select returns the chosen label, even for an option with a description.
    assert.deepEqual(responses, [{ id: 1, value: "Second" }]);

    view.rerender(dialog({ ...request, id: 2 }));
    assert.equal(screen.getByRole("button", { name: /^Second/ }).getAttribute("aria-pressed"), "false");
    assert.equal(screen.getByRole("button", { name: "Next" }).disabled, true);
  } finally {
    view.unmount();
  }
});

test("confirm answers true, and cancel answers with no value", async () => {
  const request = { type: "ui_request", id: "omp-web:abc", method: "confirm", args: ["Delete it?", "This cannot be undone."] };
  const responses = [];
  const onRespond = (current, value) => responses.push({ id: current.id, value });
  const view = render(React.createElement(ExtensionDialog, { request, onRespond, attached: true }));
  try {
    screen.getByText("This cannot be undone.");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    assert.deepEqual(responses, [{ id: "omp-web:abc", value: true }, { id: "omp-web:abc", value: undefined }]);
  } finally {
    view.unmount();
  }
});

test("approve offers omp's choices and answers with the chosen ExtensionApprovalAnswer", async () => {
  const request = {
    type: "ui_request",
    id: 7,
    method: "approve",
    args: [{
      full: "Run bash?\nrm -rf build",
      compact: "Run bash? rm -rf build",
      session: "Approve for this session",
      grants: [{ scope: "folder", label: "Approve Directory: ~/src", alwaysLabel: "Always Approve Directory: ~/src" }],
    }],
  };
  const responses = [];
  const onRespond = (_request, value) => responses.push(value);
  const view = render(React.createElement(ExtensionDialog, { request, onRespond, attached: true }));
  try {
    screen.getByText("Run bash?");
    screen.getByText("rm -rf build");
    for (const name of ["Allow", "Approve for this session", "Approve Directory: ~/src", "Always Approve Directory: ~/src", "Deny"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    assert.deepEqual(responses, ["once", "session", { grant: "folder", always: false }, { grant: "folder", always: true }, "deny"]);
    assert.equal(screen.queryByRole("button", { name: "Submit" }), null);
  } finally {
    view.unmount();
  }
});

test("omp's checkbox select shows which options are already checked", async () => {
  const request = {
    type: "ui_request",
    id: 1,
    method: "select",
    args: [
      "(2 selected) Choose enabled jobs",
      ["pytest", "go-quality", "lint", "Other (type your own)", "✓ Done selecting"],
      { selectionMarker: "checkbox", checkedIndices: [0, 1], markableCount: 3 },
    ],
  };
  const view = render(React.createElement(ExtensionDialog, { request, onRespond: () => {} }));
  try {
    // Accessible names carry the state; the visible glyph is aria-hidden.
    for (const name of ["pytest, checked", "go-quality, checked", "lint, not checked", "Other (type your own)", "✓ Done selecting"]) {
      screen.getByRole("button", { name });
    }
    assert.equal(screen.getByRole("button", { name: "pytest, checked" }).textContent, "☑pytest, checked");
    assert.equal(screen.getByRole("button", { name: "lint, not checked" }).textContent, "☐lint, not checked");
  } finally {
    view.unmount();
  }
});

test("attached checkbox select sends each toggle at once, so Done cannot replace it", async () => {
  const options = { selectionMarker: "checkbox", checkedIndices: [], markableCount: 2 };
  const request = { type: "ui_request", id: 2, method: "select", args: ["Choose enabled jobs", ["pytest", "lint", "✓ Done selecting"], options] };
  const responses = [];
  const dialog = (current) => React.createElement(ExtensionDialog, {
    request: current,
    onRespond: (answered, value) => {
      responses.push({ id: answered.id, value });
      return Promise.resolve(true);
    },
    attached: true,
  });
  const view = render(dialog(request));
  try {
    fireEvent.click(screen.getByRole("button", { name: "lint, not checked" }));
    assert.deepEqual(responses, [{ id: 2, value: "lint" }]);
    // omp takes one answer per request: the options are disabled until the next request arrives.
    assert.equal(screen.getByRole("button", { name: "pytest, not checked" }).disabled, true);
    fireEvent.click(screen.getByRole("button", { name: "pytest, not checked" }));
    assert.equal(responses.length, 1);

    // The next request carries the toggle; the action row waits for Next.
    view.rerender(dialog({ ...request, id: 3, args: [request.args[0], request.args[1], { ...options, checkedIndices: [1] }] }));
    fireEvent.click(screen.getByRole("button", { name: "✓ Done selecting" }));
    assert.equal(responses.length, 1);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    assert.deepEqual(responses[1], { id: 3, value: "✓ Done selecting" });
  } finally {
    view.unmount();
  }
});

test("a checkbox toggle that fails to send can be tried again", async () => {
  const request = {
    type: "ui_request",
    id: 4,
    method: "select",
    args: ["Choose enabled jobs", ["pytest", "✓ Done selecting"], { selectionMarker: "checkbox", checkedIndices: [], markableCount: 1 }],
  };
  const responses = [];
  const results = [false, true];
  const view = render(React.createElement(ExtensionDialog, {
    request,
    onRespond: (answered, value) => {
      responses.push({ id: answered.id, value });
      return Promise.resolve(results.shift());
    },
    attached: true,
  }));
  try {
    fireEvent.click(screen.getByRole("button", { name: "pytest, not checked" }));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "pytest, not checked" }).disabled, false));
    fireEvent.click(screen.getByRole("button", { name: "pytest, not checked" }));
    assert.deepEqual(responses, [{ id: 4, value: "pytest" }, { id: 4, value: "pytest" }]);
    assert.equal(screen.getByRole("button", { name: "pytest, not checked" }).disabled, true);
  } finally {
    view.unmount();
  }
});

test("ExtensionDialog masks sensitive input and toggles visibility", async () => {
  const request = { type: "ui_request", id: 1, method: "input", args: ["Enter API Key", "sk-..."] };
  const dialog = (current) => React.createElement(ExtensionDialog, { request: current, onRespond: () => {}, attached: true });
  const view = render(dialog(request));
  try {
    const input = view.getByPlaceholderText("sk-...");
    assert.equal(input.type, "password");
    assert.equal(input.getAttribute("autocomplete"), "off");
    assert.equal(input.getAttribute("data-1p-ignore"), "true");

    const toggle = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    assert.equal(input.type, "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    assert.equal(input.type, "password");

    // explicit secret: false does not mask even if title contains sensitive words
    view.rerender(dialog({ ...request, id: 2, args: ["Enter API Key", "sk-...", { secret: false }] }));
    const plainInput = view.getByPlaceholderText("sk-...");
    assert.equal(plainInput.type, "text");
    assert.equal(screen.queryByRole("button", { name: "Show password" }), null);

    // explicit secret: true masks regardless of title
    view.rerender(dialog({ type: "ui_request", id: 3, method: "input", args: ["Random prompt", null, { secret: true }] }));
    const maskedInput = view.container.querySelector("input");
    assert.ok(maskedInput);
    assert.equal(maskedInput.type, "password");

    // plural prompt test: "Enter your credentials"
    view.rerender(dialog({ type: "ui_request", id: 4, method: "input", args: ["Enter your credentials"] }));
    const pluralInput = view.container.querySelector("input");
    assert.ok(pluralInput);
    assert.equal(pluralInput.type, "password");
  } finally {
    view.unmount();
  }
});
