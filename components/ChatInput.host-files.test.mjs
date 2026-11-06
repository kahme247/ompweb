import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
// Bind queries and input events to the isolated browser document before loading components.
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ChatInput } = await import("./ChatInput.tsx");
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
