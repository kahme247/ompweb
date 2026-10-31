import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { McpConfig } = await import("./McpConfig.tsx");
afterEach(cleanup);

test("MCP switches persist the named action and reload without sending a model prompt", async (t) => {
  let disabled = true;
  const actions = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options?.method === "PATCH") {
      const action = JSON.parse(options.body);
      actions.push(action);
      if (action.action === "enable") disabled = false;
      return Response.json({ success: true });
    }
    const inventory = [{ name: "demo", source: "User level", sourcePath: "/fixture/mcp.json", status: disabled ? "disabled" : "configured", type: "stdio" }];
    return Response.json({ servers: [], inventory, liveServers: inventory });
  });
  render(createElement(McpConfig, { cwd: null, sessionId: "fixture-session" }));
  const toggle = await screen.findByRole("switch", { name: "Enable demo" });
  await waitFor(() => assert.equal(toggle.disabled, false));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await userEvent.setup().click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.deepEqual(actions[0], { sessionId: "fixture-session", action: "enable", name: "demo" });
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, false));
  await userEvent.setup().click(screen.getByRole("button", { name: "Reload MCP" }));
  await waitFor(() => assert.equal(actions.length, 2));
  assert.deepEqual(actions[1], { sessionId: "fixture-session", action: "reload" });
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, false));
});

test("MCP management cannot mutate configuration without a selected session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ inventory: [{ name: "demo", source: "User level", status: "configured" }] }));
  render(createElement(McpConfig, { cwd: null }));
  assert.equal((await screen.findByRole("switch", { name: "Enable demo" })).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, true);
});
