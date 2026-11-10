import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
// Bind queries and input events to the isolated browser document before loading components.
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ChatInput } = await import("./ChatInput.tsx");
const { WorkspaceFileContext } = await import("@/lib/workspace-file-context");
const savedFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = savedFetch; localStorage.clear(); delete window.matchMedia; });

test("file suggestions change hosts even when cwd and typed query stay the same", async () => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (request) => {
    const url = new URL(String(request), "http://localhost");
    if (url.pathname === "/api/file-index") {
      const host = url.searchParams.get("hostId");
      return Response.json({ files: [host === "host-a" ? "alpha.txt" : host === "host-b" ? "beta.txt" : "wrong-host.txt"], truncated: false });
    }
    return Response.json({ jobs: [] });
  };
  const props = { draftKey: "host-file-suggestions", cwd: "/same", isStreaming: false, onSend: async () => ({ status: "accepted" }), onAbort() {} };
  const view = render(React.createElement(ChatInput, { ...props, uploadHostId: "host-a" }));
  const input = view.container.querySelector("textarea");
  await userEvent.setup({ document }).type(input, "@");
  await waitFor(() => assert.ok(view.container.textContent.includes("alpha.txt")));
  view.rerender(React.createElement(ChatInput, { ...props, uploadHostId: "host-b" }));
  await waitFor(() => assert.ok(view.container.textContent.includes("beta.txt")));
  assert.ok(!view.container.textContent.includes("alpha.txt"));
});

test("file suggestions retain session authority and reset across same-host sessions", async () => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (request) => {
    const url = new URL(String(request), "http://localhost");
    if (url.pathname !== "/api/file-index") return Response.json({ jobs: [] });
    const session = url.searchParams.get("sessionId");
    return Response.json({ files: [session === "first" ? "first-owner.txt" : session === "second" ? "second-owner.txt" : "central-decoy.txt"], truncated: false });
  };
  const props = { draftKey: "session-file-suggestions", cwd: "/same", uploadHostId: "host-a", isStreaming: false, onSend: async () => ({ status: "accepted" }), onAbort() {} };
  const composer = (sessionId) => React.createElement(WorkspaceFileContext.Provider, { value: { hostId: "host-a", cwd: "/same", sessionId } }, React.createElement(ChatInput, props));
  const view = render(composer("first"));
  await userEvent.setup({ document }).type(view.container.querySelector("textarea"), "@");
  await waitFor(() => assert.ok(view.container.textContent.includes("first-owner.txt")));
  assert.ok(!view.container.textContent.includes("central-decoy.txt"));
  view.rerender(composer("second"));
  await waitFor(() => assert.ok(view.container.textContent.includes("second-owner.txt")));
  assert.ok(!view.container.textContent.includes("first-owner.txt"));
  assert.ok(!view.container.textContent.includes("central-decoy.txt"));
});
