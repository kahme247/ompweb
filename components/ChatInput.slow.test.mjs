import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const enModule = await jiti.import("@/lib/i18n/locales/en.json");
const en = enModule.default ?? enModule;

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.matchMedia;
});

function renderSlow(props) {
  const changes = [];
  render(React.createElement(ChatInput, {
    onSend() {},
    onAbort() {},
    isStreaming: false,
    slowModeSupported: true,
    slowModeScope: "session",
    onSlowModeChange: (enabled) => { changes.push(enabled); },
    ...props,
  }));
  return { changes, button: screen.getByRole("button", { name: en["chatInput.slowLabel"] }) };
}

for (const enabled of [true, false]) {
  test(`clicking the ${enabled ? "pressed" : "unpressed"} Slow toggle asks for ${!enabled}`, async () => {
    const user = userEvent.setup();
    const { changes, button } = renderSlow({ slowModeEnabled: enabled });
    assert.equal(button.getAttribute("aria-pressed"), String(enabled));
    await user.click(button);
    assert.deepEqual(changes, [!enabled]);
  });
}

test("the Slow toggle is disabled and inert while a run streams", async () => {
  const user = userEvent.setup();
  const { changes, button } = renderSlow({ slowModeEnabled: false, isStreaming: true });
  assert.equal(button.disabled, true);
  await user.click(button);
  assert.deepEqual(changes, []);
});

test("the Slow tooltip states the scope omp reports", () => {
  const titles = {};
  for (const scope of ["global", "session", undefined]) {
    const { button } = renderSlow({ slowModeScope: scope });
    titles[String(scope)] = button.getAttribute("title");
    cleanup();
  }
  assert.equal(titles.global, en["chatInput.slowTitleGlobal"]);
  assert.equal(titles.session, en["chatInput.slowTitleSession"]);
  assert.notEqual(titles.global, titles.session);
  // A supported model without a reported scope never claims a shared setting.
  assert.equal(titles.undefined, en["chatInput.slowTitleSession"]);
});
