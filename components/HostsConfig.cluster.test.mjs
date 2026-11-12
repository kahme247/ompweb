import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { act, cleanup, render, screen, waitFor, within } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { HostsConfig } = await import("./HostsConfig.tsx");
const { toast } = await import("./ui/toast.tsx");

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
  id: "local", label: "", status: "online", ompVersion: "omp/15.13.1", platform: "linux",
  hostVersion: 9, serverVersion: 9, lastSeenAt: null, workspaceOps: ["gitOrigins"], ...overrides,
});
const linked = (id, label, overrides = {}) => hostRow({ id, label, allowAgentStart: false, shareCredentials: false, ...overrides });

/** `pools: null` makes GET /api/hosts fail, `"pending"` never answers it, and a promise answers it once settled (null failing); `home: null` makes GET /api/home fail. Other requests go to `respond`. */
async function showHosts(t, { hosts, pools = [], home = "/home/andre", respond = async () => Response.json({ pools }) }) {
  const calls = [];
  let snapshot;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = init?.method ?? "GET";
    if (String(url) === "/api/hosts" && method === "GET") {
      snapshot = init;
      if (pools === "pending") return new Promise(() => {});
      const answer = await pools;
      return answer === null ? new Response("{}", { status: 500 }) : Response.json({ hosts: [], pools: answer });
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
  // Settled once the snapshot is applied: every cluster switch is then enabled or says why not; while loading it is disabled without a reason.
  if (Array.isArray(pools) || pools === null) {
    await waitFor(() => assert.ok(screen.getAllByRole("switch", { name: /is in the cluster$/ }).every((toggle) => !toggle.disabled || toggle.hasAttribute("aria-describedby"))));
  }
  const frame = (data) => act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify(data) } }));
  return { calls, frame, snapshotAborted: () => snapshot?.signal?.aborted === true, user: userEvent.setup() };
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

test("a first pool without this machine gives its row no master label", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("h1") });
  assert.equal(screen.queryByText("Cluster master"), null);
});

const RESTART = "Restart the host service on this machine first";
for (const [label, local, pools, reason] of [
  ["offline", { status: "offline" }, [], RESTART],
  ["on protocol 8", { hostVersion: 8 }, cluster("h1"), RESTART],
  ["without gitOrigins", { workspaceOps: [] }, [], RESTART],
  // A restart does not update omp: the reason names what this machine needs.
  ["on an omp too old to share credentials", { ompVersion: "omp/15.13.0" }, [], "Update omp on This machine to 15.13.1 or newer first"],
]) {
  test(`while this machine must join too and is ${label}, a non-member cannot join and says why; a member can still leave`, async (t) => {
    await showHosts(t, { hosts: [hostRow(local), linked("h1", "Laptop"), linked("h2", "Desk")], pools });
    const desk = clusterSwitch("Desk");
    assert.equal(desk.disabled, true);
    assert.equal(reasonOf(desk), reason);
    if (pools.length) assert.equal(clusterSwitch("Laptop").disabled, false);
  });
}

test("once this machine is a member, its own readiness no longer blocks a join", async (t) => {
  await showHosts(t, { hosts: [hostRow({ status: "offline" }), linked("h1", "Laptop")], pools: cluster("local") });
  assert.equal(clusterSwitch("Laptop").disabled, false);
  assert.equal(clusterSwitch("Laptop").getAttribute("aria-describedby"), null);
});

for (const [label, row, reason] of [
  ["offline", { status: "offline" }, "The host is offline"],
  ["a protocol below 9", { hostVersion: 8 }, "Update ompweb on this host first"],
  ["no gitOrigins operation", { workspaceOps: [] }, "Update ompweb on this host first"],
  ["flagged needs-upgrade by the hub", { status: "needs-upgrade", hostVersion: 8 }, "Update ompweb on this host first"],
  // Members always share credentials; the daemon refuses that below omp 15.13.1, and on an omp it cannot read.
  ["on an omp too old to share credentials", { ompVersion: "omp/15.13.0" }, "Update omp on Laptop to 15.13.1 or newer first"],
  ["on an unknown omp", { ompVersion: "omp/next" }, "Update omp on Laptop to 15.13.1 or newer first"],
  ["on an outdated daemon and an old omp (the daemon first)", { hostVersion: 8, ompVersion: "omp/15.13.0" }, "Update ompweb on this host first"],
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
  assert.ok(within(dialog).getByText(/Its Git projects that match a cluster repository or can be added as one become cluster projects/));
  assert.ok(within(dialog).getByText(/Laptop will use this machine's provider logins/));
  assert.equal(calls.some((call) => call.method === "PUT"), false);

  await user.click(within(dialog).getByRole("button", { name: "Add to cluster" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.method === "PUT"), { method: "PUT", url: "/api/hosts/h1/cluster", body: { projectsRoot: "/home/andre/ompweb-cluster" } }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});

for (const [label, pools, says] of [["no cluster", [], true], ["a first pool without this machine", cluster("h2"), true], ["this machine a member", cluster("local"), false]]) {
  test(`with ${label} the join dialog ${says ? "says" : "does not say"} that this machine joins too`, async (t) => {
    const { user } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools });
    await user.click(clusterSwitch("Laptop"));
    const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
    const note = within(dialog).queryByText(/^This machine joins too: its Git projects that match a cluster repository or can be added as one become cluster projects/);
    assert.equal(note !== null, says);
    if (says) assert.match(note.textContent, /any member with capacity \(currently Linux hosts only\)/);
  });
}

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

test("a join whose answer is lost reloads the cluster before the dialog is enabled again: the saved membership shows, the error stays", async (t) => {
  const pools = cluster("local");
  const { user } = await showHosts(t, {
    hosts: [hostRow(), linked("h1", "Laptop")], pools,
    // The server saved the join; its answer never arrived.
    respond: async () => { pools[0].members.push(member("h1")); throw new TypeError("Failed to fetch"); },
  });
  await user.click(clusterSwitch("Laptop"));
  const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
  await waitFor(() => assert.notEqual(within(dialog).getByLabelText(/Folder on Laptop/).value, ""));
  const confirm = within(dialog).getByRole("button", { name: "Add to cluster" });
  await user.click(confirm);
  assert.equal((await within(dialog).findByRole("alert")).textContent, "Failed to fetch");
  await waitFor(() => assert.equal(confirm.disabled, false));
  // The dialog hides the page from the accessibility tree.
  assert.equal(screen.getByRole("switch", { name: "Laptop is in the cluster", hidden: true }).getAttribute("aria-checked"), "true");
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
  assert.ok(within(dialog).getByText(/The cluster keeps the projects it gained from Laptop; hide any you do not want\./));
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(calls.some((call) => call.method === "DELETE"), false);

  await user.click(clusterSwitch("Laptop"));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.method === "DELETE"), { method: "DELETE", url: "/api/hosts/h1/cluster", body: undefined }));
});

test("a leave whose answer is lost reloads the cluster before Remove is enabled again: the saved membership shows, the error stays", async (t) => {
  const errors = [];
  t.mock.method(toast, "error", (message) => { errors.push(message); });
  const pools = cluster("local", "h1");
  const { user } = await showHosts(t, {
    hosts: [hostRow(), linked("h1", "Laptop")], pools,
    // The server saved the leave; its answer never arrived.
    respond: async () => { pools[0].members.pop(); throw new TypeError("Failed to fetch"); },
  });
  await user.click(clusterSwitch("Laptop"));
  const remove = within(await screen.findByRole("dialog", { name: "Remove Laptop from the cluster?" })).getByRole("button", { name: "Remove" });
  await user.click(remove);
  await waitFor(() => assert.deepEqual(errors, ["Failed to fetch"]));
  await waitFor(() => assert.equal(remove.disabled, false));
  assert.equal(screen.getByRole("switch", { name: "Laptop is in the cluster", hidden: true }).getAttribute("aria-checked"), "false");
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

for (const [label, late] of [["answers", []], ["fails", null]]) {
  test(`a hosts frame with pools wins over an initial request that ${label} later`, async (t) => {
    const answer = Promise.withResolvers();
    const { frame, snapshotAborted } = await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop")], pools: answer.promise });
    frame({ hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local", "h1") });
    await waitFor(() => assert.equal(clusterSwitch("Laptop").getAttribute("aria-checked"), "true"));
    await waitFor(() => assert.ok(snapshotAborted(), "the outdated request is cancelled"));
    await act(async () => {
      answer.resolve(late);
      await answer.promise;
    });
    assert.equal(clusterSwitch("Laptop").getAttribute("aria-checked"), "true");
    assert.equal(clusterSwitch("Laptop").disabled, false);
    assert.equal(screen.queryByText("Could not load hosts. Retrying…"), null);
  });
}

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
