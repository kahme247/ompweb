import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // Typing "/" opens the slash menu, which scrolls its active row into view.
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  clearDraft("btw-draft");
  localStorage.clear();
  delete window.matchMedia;
  delete window.HTMLElement.prototype.scrollIntoView;
});

/** Every way the composer can hand text to the agent, recorded by name. */
function renderComposer(props) {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, args[0]]); return name === "onSend" ? { status: "accepted" } : true; };
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: "btw-draft",
    onAbort() {},
    onSend: record("onSend"),
    onSteer: record("onSteer"),
    onFollowUp: record("onFollowUp"),
    onPromptWithStreamingBehavior: record("onPromptWithStreamingBehavior"),
    onBuiltinCommand: async (text) => { calls.push(["onBuiltinCommand", text]); return { handled: true }; },
    ...props,
  }));
  return { calls, ref };
}

for (const isStreaming of [false, true]) {
  test(`/btw goes to the side-question command, never the agent, ${isStreaming ? "while a run streams" : "when idle"}`, async () => {
    const user = userEvent.setup();
    const { calls } = renderComposer({ isStreaming });
    await user.type(screen.getByRole("textbox"), "/btw what is 2+2");
    await user.keyboard("{Enter}");
    await waitFor(() => assert.deepEqual(calls, [["onBuiltinCommand", "/btw what is 2+2"]]));
    await waitFor(() => assert.equal(screen.getByRole("textbox").value, ""));
  });
}

test("/btw with an attachment is refused and keeps the draft and the attachment", async () => {
  const user = userEvent.setup();
  const { calls, ref } = renderComposer({ isStreaming: false });
  await act(async () => {
    ref.current.addFiles([new File(["notes"], "notes.txt", { type: "text/plain" })]);
  });
  await waitFor(() => assert.equal(getDraft("btw-draft")?.files.length, 1));
  await user.type(screen.getByRole("textbox"), "/btw what is this");
  await user.keyboard("{Enter}");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(calls, []);
  assert.equal(screen.getByRole("textbox").value, "/btw what is this");
  assert.equal(getDraft("btw-draft")?.files.length, 1);
});
