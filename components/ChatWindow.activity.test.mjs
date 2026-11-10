import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";

const { render, fireEvent, cleanup } = await import("@testing-library/react/pure.js");
const { renderActivityPieces } = await import("./ChatWindow-transcript-group-row.tsx");
const { CommittedTranscript } = await import("./ChatWindow.tsx");
const { collectToolResults, isGroupAnchor } = await import("../lib/chat-transcript-plan.ts");
afterEach(cleanup);

const call = (id, name = "bash") => ({ type: "toolCall", toolCallId: id, toolName: name, input: { command: id } });
const assistant = (content) => ({ role: "assistant", provider: "p", model: "m", content });

test("folded activity keeps tool calls from separate messages as separate entries", () => {
  const thinking = { type: "thinking", thinking: "plan" };
  const messages = [
    { role: "user", content: "go" },
    assistant([call("a")]),
    assistant([thinking, call("b"), call("c")]),
    { role: "custom", customType: "developer", content: "notice", display: true },
    assistant([call("d")]),
  ];
  const pieces = [
    { index: 1, blocks: messages[1].content },
    { index: 2, blocks: messages[2].content },
    { index: 3 },
    { index: 4, blocks: messages[4].content },
  ];
  const calls = [];
  renderActivityPieces(messages, pieces, (idx, options) => { calls.push({ idx, options }); return null; });

  // One entry per piece, in order: nothing merged across messages, and the
  // parallel calls of message 2 stay together with their thinking block.
  assert.deepEqual(calls.map(({ idx }) => idx), [1, 2, 3, 4]);
  assert.deepEqual(
    calls.map(({ options }) => options.messageOverride?.content.map((b) => b.toolCallId ?? b.type)),
    [["a"], ["thinking", "b", "c"], undefined, ["d"]],
  );
  assert.deepEqual(calls[1].options.sourceBlockIndices, [0, 1, 2]);
  assert.equal(new Set(calls.map(({ idx, options }) => `${options.keyPrefix}-${idx}`)).size, calls.length);
});

const text = value => ({ type: "text", text: value });
const taskMessages = final => [
  { role: "user", content: "Check the build" },
  assistant([text("Checking the dependencies."), call("check", "read")]),
  { role: "toolResult", toolCallId: "check", content: [text("Dependencies loaded")] },
  assistant([text("Running the checks.")]),
  { ...assistant([text("The checks passed.")]), stopReason: "stop", ...final },
];

function transcriptProps(messages, overrides = {}) {
  const visibleRefIndexByMessage = new Map();
  let lastAnchorIdx = -1;
  messages.forEach((message, index) => {
    if (isGroupAnchor(message)) lastAnchorIdx = index;
    if (message.role === "user" || message.role === "assistant") visibleRefIndexByMessage.set(index, visibleRefIndexByMessage.size);
  });
  return {
    messages, entryIds: messages.map((_, index) => `entry-${index}`),
    conversationMeta: { toolResultsMap: collectToolResults(messages), lastAnchorIdx, visibleRefIndexByMessage },
    messageRefs: { current: [] }, isStreaming: false, streamingHasOutput: false, sessionBusy: false, isCompacting: false, externalRunActive: false,
    isNew: false, forkingEntryId: null, editingEntryId: null, handleFork: () => {}, handleEdit: async () => true,
    modelNames: { "p:m": "Test model" }, messageCwd: undefined, sessionId: "test-session", toolCallsDefaultCollapsed: true,
    hideToolActivity: true, neverFoldActivity: false, showToolCallsUnfolded: false, expandThinkingByDefault: false, hideThinkingBlock: false, searchQuery: "", visibleCount: 50, nearBottom: true,
    sentinelRef: { current: null }, handleLoadMoreClick: () => {}, ...overrides,
  };
}

test("running outputs stay visible, then normal completion folds progress and preserves the actual final reply", () => {
  const props = transcriptProps(taskMessages(), { sessionBusy: true });
  const view = render(React.createElement(CommittedTranscript, props));
  assert.ok(view.getByText("Checking the dependencies."));
  assert.ok(view.getByText("Running the checks."));
  assert.equal(view.getAllByText("Test model").length, 1);
  assert.equal(view.container.querySelectorAll(".assistant-output-latest").length, 1);
  assert.equal(view.queryByText("Final reply"), null, "a stop frame alone does not end a still-running task");

  view.rerender(React.createElement(CommittedTranscript, { ...props, sessionBusy: false }));
  const fold = view.getByRole("button", { name: /Task progress.*2 outputs.*1 tool call/ });
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.equal(view.queryByText("Checking the dependencies."), null);
  assert.ok(view.getByText("The checks passed."));
  assert.ok(view.getByText("Final reply"));
  assert.equal(view.getAllByText("Test model").length, 1);
  const progressRef = props.conversationMeta.visibleRefIndexByMessage.get(1);
  assert.equal(props.messageRefs.current[progressRef], fold.parentElement);

  for (let cycle = 0; cycle < 2; cycle += 1) {
    fireEvent.click(fold);
    assert.equal(fold.getAttribute("aria-expanded"), "true");
    assert.ok(view.getByText("Checking the dependencies."));
    assert.ok(view.getByText("Running the checks."));
    assert.ok(props.messageRefs.current[progressRef].textContent.includes("Checking the dependencies."));
    const tools = view.getByRole("button", { name: /Process details.*tool call/ });
    fireEvent.click(tools);
    fireEvent.click(view.container.querySelector(".activity-row-trigger"));
    assert.ok(view.getByText("Dependencies loaded"));
    fireEvent.click(fold);
    assert.equal(view.queryByText("Checking the dependencies."), null);
    assert.equal(props.messageRefs.current[progressRef], fold.parentElement);
  }
});

test("errors, interruptions, truncated and unknown endings keep progress open", () => {
  for (const stopReason of ["error", "aborted", "length", undefined]) {
    const final = { stopReason, ...(stopReason === "error" ? { errorMessage: "Provider failed" } : {}) };
    const view = render(React.createElement(CommittedTranscript, transcriptProps(taskMessages(final))));
    assert.ok(view.getByText("Checking the dependencies."));
    assert.equal(view.queryByText("Task progress"), null);
    assert.equal(view.queryByText("Final reply"), null);
    if (stopReason === "error") assert.ok(view.getByRole("alert"));
    if (stopReason === "aborted") assert.ok(view.getByRole("status"));
    view.unmount();
  }
});

test("a continuing task unfolds and folds again on its next final reply", () => {
  const messages = taskMessages();
  const view = render(React.createElement(CommittedTranscript, transcriptProps(messages)));
  fireEvent.click(view.getByRole("button", { name: /Task progress/ }));
  assert.ok(view.getByText("Checking the dependencies."));
  const continued = [...messages, assistant([text("Checking one more case.")])];
  view.rerender(React.createElement(CommittedTranscript, transcriptProps(continued, { sessionBusy: true })));
  assert.ok(view.getByText("Checking the dependencies."));
  assert.ok(view.getByText("Checking one more case."));
  const completed = [...continued, { ...assistant([text("All cases checked.")]), stopReason: "stop" }];
  view.rerender(React.createElement(CommittedTranscript, transcriptProps(completed)));
  assert.equal(view.queryByText("Checking the dependencies."), null);
  assert.equal(view.getByRole("button", { name: /Task progress/ }).getAttribute("aria-expanded"), "false");
  assert.ok(view.getByText("All cases checked."));
});

test("streaming text removes the highlight from the previous committed output", () => {
  const props = transcriptProps(taskMessages({ stopReason: "toolUse" }), { sessionBusy: true, isStreaming: true, streamingHasOutput: true });
  const view = render(React.createElement(CommittedTranscript, props));
  assert.equal(view.container.querySelectorAll(".assistant-output-latest").length, 0);
  assert.ok(view.getByText("Running the checks."));
});

test("an empty aborted response remains visible and never folds the preceding progress", () => {
  const messages = taskMessages({ content: [], stopReason: "aborted" });
  const view = render(React.createElement(CommittedTranscript, transcriptProps(messages)));
  assert.ok(view.getByText("Checking the dependencies."));
  assert.ok(view.getByRole("status"));
  assert.equal(view.queryByText("Task progress"), null);
});

test("search and unfolded activity preferences keep earlier outputs accessible", () => {
  for (const overrides of [{ searchQuery: "dependencies" }, { expandThinkingByDefault: true }, { showToolCallsUnfolded: true }, { neverFoldActivity: true }]) {
    const view = render(React.createElement(CommittedTranscript, transcriptProps(taskMessages(), overrides)));
    assert.ok(view.getByText("Checking the dependencies."));
    assert.equal(view.queryByText("Task progress"), null);
    view.unmount();
  }
});
