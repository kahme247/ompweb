import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ChatInput } = await import("./ChatInput.tsx");
// Same specifiers as the component's own imports, so both see one draft store.
const { SessionItem } = await import("@/components/SessionSidebar-rows");
const { clearDraft, setDraft } = await import("@/lib/draft-store");

const session = (id) => ({ id, name: id, firstMessage: "", cwd: "/w", modified: new Date().toISOString() });
const row = (id) => React.createElement(SessionItem, { session: session(id), isSelected: false, onClick() {}, relativeTimeNow: Date.now() });
const mark = () => screen.queryByRole("img", { name: "Unsent draft" });

test("a session row marks unsent composer content and drops the mark once it is gone", () => {
  try {
    // A draft that exists before the row mounts (restored after a reload, a re-expanded project).
    setDraft("draft-a", { value: "half-written", images: [], files: [] });
    const { rerender } = render(row("draft-a"));
    assert.equal(mark()?.getAttribute("title"), "Unsent draft", "marked on first paint, with its tooltip");
    rerender(row("draft-b"));
    assert.equal(mark(), null, "a row follows its own session's draft only");
    act(() => setDraft("draft-b", { value: "", images: [], files: [], uploads: [{ id: "u", name: "a.bin", size: 1, hostId: "local" }] }));
    assert.ok(mark(), "an attachment-only draft counts");
    act(() => setDraft("draft-b", { value: "", images: [], files: [] }));
    assert.equal(mark(), null, "an emptied draft clears the mark, whatever other sessions hold");
  } finally {
    clearDraft("draft-a");
    clearDraft("draft-b");
    cleanup();
  }
});

test("a mounted session row follows composer typing, attachment-only drafts and sending", async () => {
  const user = userEvent.setup();
  const composer = React.createRef();
  const sent = [];
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = globalThis.matchMedia;
  try {
    render(React.createElement(React.Fragment, null,
      row("composer-draft"),
      React.createElement(ChatInput, {
        ref: composer, draftKey: "composer-draft", isStreaming: false,
        onAbort() {},
        async onSend(text) { sent.push(text); return { status: "accepted" }; },
      }),
    ));
    const input = screen.getByRole("textbox");
    assert.equal(mark(), null);
    await user.type(input, "half-written");
    assert.ok(mark(), "typing marks the mounted session row");
    await user.clear(input);
    assert.equal(mark(), null, "clearing the composer clears its mark");
    await act(async () => {
      composer.current.addFiles([new File(["attachment content"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => assert.ok(mark(), "a file without text marks the mounted row"));
    await user.click(input);
    await user.keyboard("{Enter}");
    await waitFor(() => assert.equal(mark(), null, "sending clears the mark"));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /attachment content/);
  } finally {
    cleanup();
    clearDraft("composer-draft");
    window.matchMedia = previousMatchMedia;
  }
});

test("session rows expose shareable links without selecting on modified or middle clicks", () => {
  let selections = 0;
  try {
    const { container } = render(React.createElement(SessionItem, {
      session: session("host:session/a?b#c"), isSelected: true,
      onClick() { selections += 1; }, relativeTimeNow: Date.now(),
    }));
    const link = screen.getByRole("link", { name: "host:session/a?b#c" });
    assert.equal(link.getAttribute("href"), "/?session=host%3Asession%2Fa%3Fb%23c");
    assert.equal(link.getAttribute("aria-current"), "true");
    const title = link.querySelector("span");
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      assert.equal(fireEvent.click(title, { button: 0, [modifier]: true }), true, modifier);
      assert.equal(selections, 0, "modified clicks must not bubble into row selection");
    }
    assert.equal(fireEvent(title, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })), true);
    assert.equal(fireEvent.contextMenu(title), true, "native Copy link stays available");
    assert.equal(selections, 0);
    assert.equal(fireEvent.click(title, { button: 0 }), false);
    assert.equal(selections, 1, "the anchor and row must not both select");
    fireEvent.click(container.querySelector(".session-item-row"), { button: 0 });
    assert.equal(selections, 2, "row padding still selects");
  } finally {
    cleanup();
  }
});

test("Delete on a session link opens confirmation and cancellation returns focus to the link", async () => {
  let selections = 0;
  try {
    render(React.createElement(SessionItem, {
      session: session("delete-link"), isSelected: false,
      onClick() { selections += 1; }, relativeTimeNow: Date.now(),
    }));
    const link = screen.getByRole("link", { name: "delete-link" });
    link.focus();
    assert.equal(fireEvent.keyDown(link, { key: "Delete" }), false);
    assert.ok(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => assert.equal(document.activeElement, link));
    assert.equal(selections, 0);
  } finally {
    cleanup();
  }
});
