import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { act, cleanup, render, screen, waitFor, within } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { HostsConfig } = await import("./HostsConfig.tsx");

const originalWorker = globalThis.Worker;
// The event-stream transport keeps the first worker it was given for the whole file.
const workers = [];
class FakeWorker {
  onmessage = null;
  onerror = null;
  posted = [];
  constructor() { workers.push(this); }
  postMessage(message) { this.posted.push(message); }
}
afterEach(() => {
  cleanup();
  globalThis.Worker = originalWorker;
});

const member = (hostId) => ({ hostId, projectsRoot: `/srv/${hostId}/ompweb-cluster`, provisioned: true, draining: false });
const cluster = (...hostIds) => [{ id: "cluster", label: "Cluster", enabled: true, members: hostIds.map(member), projects: [] }];
const hostRow = (overrides = {}) => ({
  id: "local", label: "", status: "online", ompVersion: "1.0.0", platform: "linux",
  hostVersion: 9, serverVersion: 9, lastSeenAt: null, workspaceOps: ["gitOrigins"], ...overrides,
});
const linked = (id, label, overrides = {}) => hostRow({ id, label, allowAgentStart: false, shareCredentials: false, ...overrides });

/** `pools: null` makes GET /api/hosts fail and `"pending"` never answers it; `home: null` makes GET /api/home fail. Other requests go to `respond`. */
async function showHosts(t, { hosts, pools = [], home = "/home/andre", respond = async () => Response.json({ pools }) }) {
  const calls = [];
  let answered = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = init?.method ?? "GET";
    if (String(url) === "/api/hosts" && method === "GET") {
      if (pools === "pending") return new Promise(() => {});
      answered = true;
      return pools === null ? new Response("{}", { status: 500 }) : Response.json({ hosts: [], pools });
    }
    if (String(url).startsWith("/api/home?")) {
      calls.push({ method, url: String(url) });
      return home === null ? Response.json({ error: "Host offline" }, { status: 409 }) : Response.json({ home });
    }
    if (String(url).includes("/updates")) return Response.json({ ompweb: null, omp: null, operation: null });
    calls.push({ method, url: String(url), body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return respond(url, init);
  });
  globalThis.Worker = FakeWorker;
  render(createElement(HostsConfig));
  await waitFor(() => assert.ok(workers[0].posted.some((message) => message.op === "open" && message.channel.kind === "hosts")));
  const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
  act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts }) } }));
  await screen.findByRole("button", { name: "Rename This machine" });
  // Pools come from the snapshot request: wait until it was answered, then let its continuation apply the result.
  if (pools !== "pending") {
    await waitFor(() => assert.ok(answered));
    await act(async () => {});
  }
  const frame = (data) => act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify(data) } }));
  return { calls, frame, user: userEvent.setup() };
}

const rowOf = (name) => screen.getByRole("button", { name: `Rename ${name}` }).closest("li");
const clusterSwitch = (name) => screen.getByRole("switch", { name: `${name} is in the cluster` });
const reasonOf = (element) => element.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");

test("this machine's row names the master and has no switch, only while a cluster exists", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local", "h2") });
  const local = rowOf("This machine");
  assert.ok(within(local).getByText("Cluster master"));
  assert.equal(within(local).queryByRole("switch", { name: /in the cluster/ }), null);
});

test("without a cluster this machine's row has no master label", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: [] });
  assert.equal(screen.queryByText("Cluster master"), null);
  assert.equal(clusterSwitch("Laptop").disabled, false);
});

for (const [label, row, reason] of [
  ["offline", { status: "offline" }, "The host is offline"],
  ["a protocol below 9", { hostVersion: 8 }, "Update ompweb on this host first"],
  ["no gitOrigins operation", { workspaceOps: [] }, "Update ompweb on this host first"],
  ["flagged needs-upgrade by the hub", { status: "needs-upgrade", hostVersion: 8 }, "Update ompweb on this host first"],
  ["without omp (its own status text is the reason)", { status: "omp-missing" }, "omp not installed"],
]) {
  test(`a host that is ${label} cannot join and says why`, async (t) => {
    await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop", row)], pools: cluster("local") });
    const toggle = clusterSwitch("Laptop");
    assert.equal(toggle.disabled, true);
    assert.equal(reasonOf(toggle), reason);
  });
}

test("when the pools cannot be loaded every switch is disabled with poolsUnavailable, members included", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop"), linked("h2", "Desk")], pools: null });
  for (const name of ["Laptop", "Desk"]) {
    const toggle = clusterSwitch(name);
    assert.equal(toggle.disabled, true);
    assert.equal(reasonOf(toggle), "The cluster configuration could not be loaded");
  }
});

test("a member can always leave: offline or outdated never disables its switch", async (t) => {
  await showHosts(t, {
    hosts: [hostRow(), linked("h1", "Laptop", { status: "offline" }), linked("h2", "Desk", { hostVersion: 7, workspaceOps: [] })],
    pools: cluster("local", "h1", "h2"),
  });
  for (const name of ["Laptop", "Desk"]) {
    const toggle = clusterSwitch(name);
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(toggle.getAttribute("aria-describedby"), null);
  }
});

test("a member's provider-login toggle is on and disabled, described by the reason", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop"), linked("h2", "Desk")], pools: cluster("local", "h1") });
  const forced = screen.getByRole("switch", { name: "Use this server's provider logins on Laptop" });
  assert.equal(forced.getAttribute("aria-checked"), "true");
  assert.equal(forced.disabled, true);
  assert.equal(reasonOf(forced), "On while the host is in the cluster");
  const other = screen.getByRole("switch", { name: "Use this server's provider logins on Desk" });
  assert.equal(other.getAttribute("aria-checked"), "false");
  assert.equal(other.disabled, false);
});

test("joining asks for the folder, prefilled from the host's home, and sends it", async (t) => {
  const { calls, user } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local") });
  await user.click(clusterSwitch("Laptop"));
  const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
  const folder = within(dialog).getByLabelText("Folder on Laptop for the cluster's checkouts");
  await waitFor(() => assert.equal(folder.value, "/home/andre/ompweb-cluster"));
  assert.deepEqual(calls.filter((call) => call.url.startsWith("/api/home")), [{ method: "GET", url: "/api/home?hostId=h1" }]);
  assert.ok(within(dialog).getByText(/Its Git projects become cluster projects/));
  assert.ok(within(dialog).getByText(/Laptop will use this machine's provider logins/));
  assert.equal(calls.some((call) => call.method === "PUT"), false);

  await user.click(within(dialog).getByRole("button", { name: "Add to cluster" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.method === "PUT"), { method: "PUT", url: "/api/hosts/h1/cluster", body: { projectsRoot: "/home/andre/ompweb-cluster" } }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});

test("a refused join shows the server's message and keeps the dialog open", async (t) => {
  const { user } = await showHosts(t, {
    hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local"),
    respond: async () => Response.json({ error: "The cluster changed during the join; try again", code: "cluster_changed" }, { status: 409 }),
  });
  await user.click(clusterSwitch("Laptop"));
  const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
  await waitFor(() => assert.notEqual(within(dialog).getByLabelText(/Folder on Laptop/).value, ""));
  await user.click(within(dialog).getByRole("button", { name: "Add to cluster" }));
  assert.equal((await within(dialog).findByRole("alert")).textContent, "The cluster changed during the join; try again");
  assert.ok(screen.getByRole("dialog", { name: "Add Laptop to the cluster?" }));
});

test("without a home folder the field starts empty and stays required; the dialog still opens", async (t) => {
  const { calls, user } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local"), home: null });
  await user.click(clusterSwitch("Laptop"));
  const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
  await waitFor(() => assert.equal(calls.filter((call) => call.url.startsWith("/api/home")).length, 1));
  const folder = within(dialog).getByLabelText(/Folder on Laptop/);
  assert.equal(folder.value, "");
  assert.equal(within(dialog).getByRole("button", { name: "Add to cluster" }).disabled, true);
});

test("a relative folder is refused in the dialog without a request", async (t) => {
  const { calls, user } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local") });
  await user.click(clusterSwitch("Laptop"));
  const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
  const folder = within(dialog).getByLabelText(/Folder on Laptop/);
  await waitFor(() => assert.notEqual(folder.value, ""));
  await user.clear(folder);
  await user.type(folder, "ompweb-cluster");
  await user.click(within(dialog).getByRole("button", { name: "Add to cluster" }));
  assert.equal(calls.some((call) => call.method === "PUT"), false);
  assert.ok(within(dialog).getByRole("alert"));
  assert.ok(screen.getByRole("dialog", { name: "Add Laptop to the cluster?" }));
});

test("leaving is confirmed, then sends DELETE", async (t) => {
  const { calls, user } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local", "h1") });
  await user.click(clusterSwitch("Laptop"));
  const dialog = await screen.findByRole("dialog", { name: "Remove Laptop from the cluster?" });
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(calls.some((call) => call.method === "DELETE"), false);

  await user.click(clusterSwitch("Laptop"));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.method === "DELETE"), { method: "DELETE", url: "/api/hosts/h1/cluster", body: undefined }));
});

test("while the pools load, every switch and share toggle is disabled and nothing is sent", async (t) => {
  const { calls, user } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop"), linked("h2", "Desk", { shareCredentials: true })], pools: "pending" });
  for (const name of ["Laptop", "Desk"]) {
    const toggle = clusterSwitch(name);
    assert.equal(toggle.disabled, true);
    assert.equal(toggle.getAttribute("aria-describedby"), null, "no error text while still loading");
    const share = screen.getByRole("switch", { name: `Use this server's provider logins on ${name}` });
    assert.equal(share.disabled, true);
    assert.equal(share.getAttribute("aria-describedby"), null);
    await user.click(toggle);
    await user.click(share);
  }
  assert.deepEqual(calls.filter((call) => call.method !== "GET"), []);
  assert.equal(screen.queryByRole("dialog"), null);
});

test("when the pools failed to load, share toggles are disabled with poolsUnavailable", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: null });
  const share = screen.getByRole("switch", { name: "Use this server's provider logins on Laptop" });
  assert.equal(share.disabled, true);
  assert.equal(reasonOf(share), "The cluster configuration could not be loaded");
});

test("a hosts frame that carries pools recovers from a failed first request", async (t) => {
  const { frame } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: null });
  assert.equal(clusterSwitch("Laptop").disabled, true);
  frame({ hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local") });
  await waitFor(() => assert.equal(clusterSwitch("Laptop").disabled, false));
  assert.equal(clusterSwitch("Laptop").getAttribute("aria-describedby"), null);
  assert.equal(screen.getByRole("switch", { name: "Use this server's provider logins on Laptop" }).disabled, false);
});

test("a frame that removes a member returns its share toggle to the stored flag", async (t) => {
  const { frame } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local", "h1") });
  const share = () => screen.getByRole("switch", { name: "Use this server's provider logins on Laptop" });
  assert.equal(share().getAttribute("aria-checked"), "true");
  assert.equal(share().disabled, true);
  frame({ hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local") });
  await waitFor(() => assert.equal(share().getAttribute("aria-checked"), "false"));
  assert.equal(share().disabled, false);
  assert.equal(share().getAttribute("aria-describedby"), null);
});

test("the folder field is required", async (t) => {
  const { user } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local") });
  await user.click(clusterSwitch("Laptop"));
  const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
  assert.equal(within(dialog).getByLabelText(/Folder on Laptop/).required, true);
});
