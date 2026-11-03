import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ChatInput } = await import("./ChatInput.tsx");
const { clearDraft } = await import("@/lib/draft-store");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  clearDraft("shell-draft");
  localStorage.clear();
  delete window.matchMedia;
});

function renderComposer(sendStatus) {
  const calls = [];
  const record = (name) => async (text) => { calls.push([name, text]); return name === "onSend" ? { status: sendStatus } : true; };
  render(React.createElement(ChatInput, {
    draftKey: "shell-draft",
    isStreaming: true,
    onAbort() {},
    onSend: record("onSend"),
    onSteer: record("onSteer"),
    onFollowUp: record("onFollowUp"),
    onPromptWithStreamingBehavior: record("onPromptWithStreamingBehavior"),
  }));
  return calls;
}

test("a `!` command typed during a run is sent as a shell command, never queued as text", async () => {
  const user = userEvent.setup();
  const calls = renderComposer("accepted");
  await user.type(screen.getByRole("textbox"), "!git status");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.deepEqual(calls, [["onSend", "!git status"]]));
  await waitFor(() => assert.equal(screen.getByRole("textbox").value, ""));
});

test("a `!` command refused during a run goes back to the draft", async () => {
  const user = userEvent.setup();
  const calls = renderComposer("rejected");
  await user.type(screen.getByRole("textbox"), "!git status");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(screen.getByRole("textbox").value, "!git status"));
  assert.deepEqual(calls, [["onSend", "!git status"]]);
});
