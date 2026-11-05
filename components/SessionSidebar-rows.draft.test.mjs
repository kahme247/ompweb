import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { act, cleanup, render, screen } = await import("@testing-library/react/pure.js");
// Same specifiers as the component's own imports, so both see one draft store.
const { SessionItem } = await import("@/components/SessionSidebar-rows");
const { clearDraft, setDraft } = await import("@/lib/draft-store");

const session = { id: "draft-row", name: "Draft row", firstMessage: "", cwd: "/w", modified: new Date().toISOString() };

test("a session row marks unsent composer content and drops the mark once it is gone", () => {
  render(React.createElement(SessionItem, { session, isSelected: false, onClick() {}, relativeTimeNow: Date.now() }));
  const mark = () => screen.queryByRole("img", { name: "Unsent draft" });
  try {
    assert.equal(mark(), null);
    act(() => setDraft(session.id, { value: "", images: [], files: [], uploads: [{ id: "u", name: "a.bin", size: 1, hostId: "local" }] }));
    assert.ok(mark(), "an attachment-only draft counts");
    act(() => setDraft("other-session", { value: "elsewhere", images: [], files: [] }));
    act(() => setDraft(session.id, { value: "", images: [], files: [] }));
    assert.equal(mark(), null, "an emptied draft clears the mark, whatever other sessions hold");
  } finally {
    clearDraft(session.id);
    clearDraft("other-session");
    cleanup();
  }
});
