import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { act, cleanup, render, screen } = await import("@testing-library/react/pure.js");
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
