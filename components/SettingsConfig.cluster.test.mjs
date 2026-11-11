import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, createElement } from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { SettingsConfig } = await import("./SettingsConfig");
const { PluginsConfig } = await import("./PluginsConfig");
afterEach(cleanup);

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const MEMBER_CWD = "/srv/h1/ompweb-cluster/app";
const MEMBER_SESSION = "member-session-1";
const NOTICE = "Cluster configuration: changes here apply to every member.";
const REMOTE = "Not available on remote hosts yet";

const settingsProps = {
  activeTab: "mcp",
  toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
  hideToolActivity: false, onHideToolActivityChange: noop,
  expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
  providerUsageVisible: false, onProviderUsageVisibleChange: noop,
  scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
  openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
  cwd: MEMBER_CWD, remoteHost: false, cluster: false, sessionId: MEMBER_SESSION,
  onModelsSaved: noop, onPluginsReloaded: noop,
  appUpdate: null, onRefreshAppUpdate: async () => null,
  onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
};

/** Every request, answered with an empty panel; MCP's live read says its one server is connected. */
function recordRequests(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    const path = String(url).split("?")[0];
    if (path === "/api/omp-settings") return Response.json({ settings: {} });
    if (path === "/api/mcp") {
      const inventory = [{ name: "demo", source: "User level", status: "configured", type: "stdio" }];
      return Response.json(String(url).includes("live=1") ? { servers: [], inventory, liveServers: [{ ...inventory[0], status: "connected" }] } : { servers: [], inventory });
    }
    if (path === "/api/skills") return Response.json({ skills: [] });
    if (path === "/api/agents") return Response.json({ agents: [] });
    if (path === "/api/plugins") return Response.json({ packages: [], totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 }, diagnostics: [] });
    return Response.json({});
  });
  return requests;
}
const mentions = (request, text) => [request.url, request.body ?? ""].some((part) => part.includes(text));

// What each panel asks on another member: never the member's workspace; only MCP names its session, to read the
// live status of the process running there, never to start one (`attach=1`).
const memberMcp = (live) => `/api/mcp?${new URLSearchParams({ sessionId: MEMBER_SESSION, attach: "1", live })}`;
const PANELS = { mcp: ["/api/mcp", [memberMcp("0"), memberMcp("1")]], skills: ["/api/skills", ["/api/skills"]], agents: ["/api/agents", ["/api/agents?"]] };

for (const [tab, [path, urls]] of Object.entries(PANELS)) {
  test(`a cluster session on another member shows the ${tab} panel at this machine's user level, under the notice`, async (t) => {
    const requests = recordRequests(t);
    render(createElement(SettingsConfig, { ...settingsProps, activeTab: tab, remoteHost: true, cluster: true }));
    assert.equal((await screen.findByText(NOTICE)).tagName, "P");
    await waitFor(() => assert.equal(requests.filter((request) => request.url.split("?")[0] === path).length, urls.length));
    await settle();
    assert.equal(screen.queryByText(REMOTE), null);
    assert.deepEqual(requests.filter((request) => request.url.split("?")[0] === path).map((request) => request.url), urls);
    assert.deepEqual(requests.filter((request) => mentions(request, MEMBER_CWD)), []);
    assert.deepEqual(requests.filter((request) => mentions(request, MEMBER_SESSION)).map((request) => request.url), tab === "mcp" ? urls : []);
  });
}

test("on another member MCP shows the session's live status read-only, the user-level MCP settings and no project editor", async (t) => {
  const requests = recordRequests(t);
  render(createElement(SettingsConfig, { ...settingsProps, activeTab: "mcp", remoteHost: true, cluster: true }));
  assert.ok(await screen.findByText("connected"));
  assert.ok(screen.getByText("MCP servers are changed in the master's configuration; this shows the session's live status."));
  assert.equal(screen.queryByText("Open a conversation to enable, disable, or reload MCP servers."), null);
  assert.equal(screen.getByRole("switch", { name: "Enable demo" }).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, true);
  assert.ok(screen.getByText("Load Project MCP Servers"));
  assert.equal(screen.queryByText("Project MCP Servers"), null);
  assert.deepEqual(requests.filter((request) => request.method !== "GET" && request.url.startsWith("/api/mcp")), []);
});

test("on another member a new agent can only be the user's", async (t) => {
  recordRequests(t);
  render(createElement(SettingsConfig, { ...settingsProps, activeTab: "agents", remoteHost: true, cluster: true }));
  const [create] = await screen.findAllByRole("button", { name: "New agent" });
  await waitFor(() => assert.equal(create.disabled, false));
  await userEvent.setup().click(create);
  assert.ok(await screen.findByRole("option", { name: "user" }));
  assert.equal(screen.queryByRole("option", { name: "project" }), null);
});

test("on another member the Skills panel installs only for the user", async (t) => {
  recordRequests(t);
  render(createElement(SettingsConfig, { ...settingsProps, activeTab: "skills", remoteHost: true, cluster: true }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Add custom skill" }));
  assert.ok(await screen.findByRole("button", { name: "global" }));
  assert.equal(screen.queryByRole("button", { name: "project" }), null);
  assert.ok(screen.getByText("→ ~/.agents/skills/"));
});

for (const tab of Object.keys(PANELS)) {
  test(`a standalone remote host keeps the ${tab} panel's old message and asks nothing`, async (t) => {
    const requests = recordRequests(t);
    render(createElement(SettingsConfig, { ...settingsProps, activeTab: tab, remoteHost: true, cluster: false }));
    await screen.findByText(REMOTE);
    await settle();
    assert.equal(screen.queryByText(NOTICE), null);
    assert.deepEqual(requests.filter((request) => request.url.split("?")[0] === PANELS[tab][0]), []);
  });
}

test("a cluster session on this machine changes nothing but the notice", async (t) => {
  const asked = {};
  for (const cluster of [false, true]) {
    const requests = recordRequests(t);
    render(createElement(SettingsConfig, { ...settingsProps, activeTab: "mcp", remoteHost: false, cluster }));
    await waitFor(() => assert.ok(requests.some((request) => request.url.startsWith("/api/mcp?"))));
    await settle();
    assert.equal(screen.queryByText(NOTICE) !== null, cluster);
    assert.equal(screen.queryByText("Project MCP Servers") !== null, true);
    asked[cluster] = requests.find((request) => request.url.startsWith("/api/mcp?")).url;
    cleanup();
    t.mock.restoreAll();
  }
  assert.equal(asked.true, asked.false);
  assert.equal(asked.true, `/api/mcp?${new URLSearchParams({ cwd: MEMBER_CWD, sessionId: MEMBER_SESSION, live: "0" })}`);
});

for (const tab of ["models", "safety"]) {
  test(`the ${tab} tab, which edits the mirrored configuration, shows the notice for a cluster session only`, async (t) => {
    recordRequests(t);
    render(createElement(SettingsConfig, { ...settingsProps, activeTab: tab, remoteHost: true, cluster: true }));
    assert.ok(await screen.findByText(NOTICE));
    cleanup();
    render(createElement(SettingsConfig, { ...settingsProps, activeTab: tab, remoteHost: true, cluster: false }));
    await settle();
    assert.equal(screen.queryByText(NOTICE), null);
  });
}

for (const tab of ["general", "system"]) {
  test(`the ${tab} tab, which is this browser's or this server's own, never shows the notice`, async (t) => {
    recordRequests(t);
    render(createElement(SettingsConfig, { ...settingsProps, activeTab: tab, remoteHost: true, cluster: true }));
    await settle();
    assert.ok(screen.getByRole("tabpanel"));
    assert.equal(screen.queryByText(NOTICE), null);
  });
}

test("without a workspace the Plugins panel works at the user level: no cwd, global installs only", async (t) => {
  const requests = recordRequests(t);
  render(createElement(PluginsConfig, { embedded: true, cwd: null, sessionId: null, onClose: noop }));
  const source = await screen.findByRole("textbox", { name: "Source" });
  assert.deepEqual(requests.map((request) => request.url), ["/api/plugins"]);
  assert.ok(screen.getByText("~/.omp/plugins"));
  assert.equal(screen.queryByRole("button", { name: "project" }), null);
  const user = userEvent.setup();
  await user.type(source, "npm:demo");
  await user.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => assert.equal(requests.length, 2));
  const { cwd, ...install } = JSON.parse(requests[1].body);
  assert.equal(cwd ?? null, null);
  assert.deepEqual(install, { action: "install", source: "npm:demo", scope: "global" });
});
