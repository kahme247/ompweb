import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const { HostsConfig } = await createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, jsx: { runtime: "automatic" } }).import("./HostsConfig.tsx");

const originalWorker = globalThis.Worker;
afterEach(() => {
  cleanup();
  globalThis.Worker = originalWorker;
});

test("the one-time host token survives Escape; only Done closes it", async (t) => {
  // The hosts list rides the shared event-stream worker; a silent one keeps it idle.
  globalThis.Worker = class { onmessage = null; onerror = null; postMessage() {} };
  t.mock.method(globalThis, "fetch", async () => Response.json({ host: { id: "h1", label: "Laptop" }, token: "tok-once", command: "ompweb host login --url https://omp.test" }));
  render(createElement(HostsConfig));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add host" }));
  await user.type(screen.getByPlaceholderText("Build server"), "Laptop");
  await user.click(screen.getByRole("button", { name: "Create host" }));
  await screen.findByText("tok-once");

  await user.keyboard("{Escape}");
  // Escape and an outside press both reach onOpenChange(false).
  assert.ok(screen.queryByText("tok-once"), "Escape must not discard the only copy of the token");

  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => assert.equal(screen.queryByText("tok-once"), null));
});
