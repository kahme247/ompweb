import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { useSidebarHistory } = await jiti.import("@/hooks/useSidebarHistory");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installBrowser() {
  const listeners = new Map();
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  globalThis.document = { documentElement: {}, addEventListener() {}, removeEventListener() {} };
  globalThis.localStorage = { getItem: () => null };
  globalThis.requestAnimationFrame = () => 0;
  return () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of listeners.get("beforeunload") ?? []) fn(event);
    return event.defaultPrevented;
  };
}

function Guard() {
  // The actual history protocol is exercised in useSidebarHistory.test.mjs.
  // This mounts the same document guard with the real composer/draft store.
  useSidebarHistory({ active: false, ready: false, sidebarOpen: true, setSidebarOpen() {}, url: "" });
  return null;
}

const enter = { key: "Enter", nativeEvent: {}, preventDefault() {}, shiftKey: false };

test("no-key composer text survives minimization and warns on document exit until sent", async () => {
  const warnsOnExit = installBrowser();
  const ref = React.createRef();
  const sent = [];
  function Shell({ minimized = false }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement("div", { style: { display: minimized ? "none" : undefined } },
        React.createElement(ChatInput, { ref, onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false })),
    );
  }
  let renderer;
  try {
    await act(() => { renderer = TestRenderer.create(React.createElement(Shell)); });
    assert.equal(warnsOnExit(), false);
    await act(() => ref.current.insertText("unsent in a new composer"));
    assert.equal(warnsOnExit(), true);
    await act(() => renderer.update(React.createElement(Shell, { minimized: true })));
    assert.equal(warnsOnExit(), true);
    assert.equal(renderer.root.findByType("textarea").props.value, "unsent in a new composer");
    await act(() => renderer.root.findByType("textarea").props.onKeyDown(enter));
    assert.deepEqual(sent, ["unsent in a new composer"]);
    assert.equal(warnsOnExit(), false);
  } finally {
    await act(() => renderer?.unmount());
    clearDraft("new:unassigned");
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("attachment-only drafts stay protected across live draft-key changes and restore without warning on internal picks", async () => {
  const warnsOnExit = installBrowser();
  const ref = React.createRef();
  const sent = [];
  function Shell({ session }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement(ChatInput, { draftKey: session, ref, onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false }),
    );
  }
  let renderer;
  try {
    await act(() => { renderer = TestRenderer.create(React.createElement(Shell, { session: "draft-a" })); });
    await act(async () => {
      ref.current.addFiles([new File(["important attachment"], "notes.txt", { type: "text/plain" })]);
    });
    assert.equal(warnsOnExit(), true);
    await act(() => renderer.update(React.createElement(Shell, { session: "draft-b" })));
    assert.equal(renderer.root.findByType("textarea").props.value, "");
    assert.equal(getDraft("draft-a")?.files[0]?.content, "important attachment");
    assert.equal(warnsOnExit(), true);
    await act(() => renderer.update(React.createElement(Shell, { session: "draft-a" })));
    await act(() => renderer.root.findByType("textarea").props.onKeyDown(enter));
    assert.match(sent[0], /important attachment/);
    assert.equal(warnsOnExit(), false);
  } finally {
    await act(() => renderer?.unmount());
    clearDraft("draft-a");
    clearDraft("draft-b");
    delete globalThis.window;
    delete globalThis.document;
  }
});
