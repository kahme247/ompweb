import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";
const { McpConfig } = await createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, jsx: { runtime: "automatic" } }).import("./McpConfig.tsx");
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

function mcpServers(cwd) {
  if (cwd === "/proj-a") return [{ name: "alpha", config: { type: "stdio", command: "alpha-cmd", args: [] } }];
  if (cwd === "/proj-b") return [{ name: "beta", config: { type: "stdio", command: "beta-cmd", args: [] } }];
  return [];
}

test("MCP editor must not keep project A's server after switching to project B", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const cwd = new URL(String(url), "http://x").searchParams.get("cwd");
    return Response.json({ servers: mcpServers(cwd), path: cwd ? `${cwd}/.omp/mcp.json` : null });
  });
  const view = render(createElement(McpConfig, { cwd: "/proj-a" }));
  await screen.findByText("alpha");
  await userEvent.setup().click(screen.getByText("alpha"));
  assert.equal(screen.getByDisplayValue("alpha").tagName, "INPUT");
  view.rerender(createElement(McpConfig, { cwd: "/proj-b" }));
  await screen.findByText("beta");
  // No server is selected in project B, so the editor must be blank; the
  // stale name/JSON from project A must not survive the workspace switch
  // (saving it would create project A's server verbatim in project B).
  const nameInput = document.querySelector("input.mcp-config-input");
  assert.equal(nameInput.value, "");
  assert.equal(document.querySelector("textarea.mcp-config-input").value.includes("alpha-cmd"), false);
});

test("MCP editor blanks when the selected server disappears from the same workspace", async (t) => {
  let servers = mcpServers("/proj-a");
  t.mock.method(globalThis, "fetch", async () => Response.json({ servers, path: "/proj-a/.omp/mcp.json" }));
  render(createElement(McpConfig, { cwd: "/proj-a" }));
  await screen.findByText("alpha");
  await userEvent.setup().click(screen.getByText("alpha"));
  assert.equal(screen.getByDisplayValue("alpha").tagName, "INPUT");
  // The server was deleted elsewhere; a refresh must not leave its editor
  // behind to be saved back into the project.
  servers = [];
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh live MCP status" }));
  await waitFor(() => assert.equal(document.querySelector("input.mcp-config-input").value, ""));
  assert.equal(document.querySelector("textarea.mcp-config-input").value.includes("alpha-cmd"), false);
});
