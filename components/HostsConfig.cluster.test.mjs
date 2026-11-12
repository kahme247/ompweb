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
  hostVersion: 10, serverVersion: 10, lastSeenAt: null, workspaceOps: ["gitOrigins"], ...overrides,
});
const linked = (id, label, overrides = {}) => hostRow({ id, label, allowAgentStart: false, shareCredentials: false, ...overrides });

/** `pools: null` makes GET /api/hosts fail, `"pending"` never answers it, a promise answers it once settled (null failing), and a function
 * is asked on every request (null failing); `home: null` makes GET /api/home fail. Other requests go to `respond`. */
async function showHosts(t, { hosts, pools = [], home = "/home/andre", respond = async () => Response.json({ pools }) }) {
  const calls = [];
  let snapshot;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = init?.method ?? "GET";
    if (String(url) === "/api/hosts" && method === "GET") {
      snapshot = init;
      if (pools === "pending") return new Promise(() => {});
      const answer = await (typeof pools === "function" ? pools() : pools);
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
  if (Array.isArray(pools) || pools === null || typeof pools === "function") {
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
  assert.ok(within(dialog).getByText(/Its Git projects that match a cluster repository or can be added as one become cluster projects, unless they are inside or contain the cluster folder/));
  assert.ok(within(dialog).getByText(/Laptop will use this machine's provider logins/));
  assert.ok(within(dialog).getByText("It receives this machine's omp configuration (settings, models, MCP servers, skills, plugins, rules), API keys and environment values included, in place of its own until it leaves; its own is kept and put back then."));
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
    if (says) assert.match(note.textContent, /unless they are inside or contain the ompweb-cluster folder in its home folder.*any member with capacity \(currently Linux hosts only\)/);
  });
}

for (const [code, message] of [["cluster_changed", "The cluster changed during the join; try again"], ["host_in_other_cluster", "Laptop runs another server's cluster configuration; it must leave that cluster first"]]) {
  test(`a refused join (${code}) shows the server's message and keeps the dialog open`, async (t) => {
    const { user } = await showHosts(t, {
      hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local"),
      respond: async () => Response.json({ error: message, code }, { status: 409 }),
    });
    await user.click(clusterSwitch("Laptop"));
    const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
    await waitFor(() => assert.notEqual(within(dialog).getByLabelText(/Folder on Laptop/).value, ""));
    await user.click(within(dialog).getByRole("button", { name: "Add to cluster" }));
    assert.equal((await within(dialog).findByRole("alert")).textContent, message);
    assert.ok(screen.getByRole("dialog", { name: "Add Laptop to the cluster?" }));
  });
}

/** A join or leave whose answer is lost: the server saved it or not, and the reload after it answers or fails. */
const LOST = [["saved", true, true], ["not saved", false, true], ["of unknown outcome, the reload failing", true, false]];
const UNKNOWN = "Whether the change was saved is unknown (Failed to fetch); the cluster could not be reloaded to check.";

for (const [label, saved, reloads] of LOST) {
  test(`a join whose answer is lost, ${label}, shows what the reload finds before Add is enabled again`, async (t) => {
    const pools = cluster("local");
    let reloadFails = false;
    const { user } = await showHosts(t, {
      hosts: [hostRow(), linked("h1", "Laptop")], pools: () => (reloadFails ? null : pools),
      respond: async () => {
        if (saved) pools[0].members.push(member("h1"));
        reloadFails = !reloads;
        throw new TypeError("Failed to fetch");
      },
    });
    await user.click(clusterSwitch("Laptop"));
    const dialog = await screen.findByRole("dialog", { name: "Add Laptop to the cluster?" });
    await waitFor(() => assert.notEqual(within(dialog).getByLabelText(/Folder on Laptop/).value, ""));
    const confirm = within(dialog).getByRole("button", { name: "Add to cluster" });
    await user.click(confirm);
    if (saved && reloads) {
      // Done after all: no error, and no join offered again.
      await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
      assert.equal(clusterSwitch("Laptop").getAttribute("aria-checked"), "true");
      return;
    }
    assert.equal((await within(dialog).findByRole("alert")).textContent, reloads ? "Failed to fetch" : UNKNOWN);
    await waitFor(() => assert.equal(confirm.disabled, false));
  });
}

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
  assert.ok(within(dialog).getByText(/The cluster keeps the projects it gained from Laptop; hide any you do not want\. Laptop gets its own omp configuration back\./));
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(calls.some((call) => call.method === "DELETE"), false);

  await user.click(clusterSwitch("Laptop"));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.method === "DELETE"), { method: "DELETE", url: "/api/hosts/h1/cluster", body: undefined }));
});

test("a leave whose own configuration could not be put back says so and why", async (t) => {
  const errors = [];
  t.mock.method(toast, "error", (message) => { errors.push(message); });
  const { user } = await showHosts(t, {
    hosts: [hostRow(), linked("h1", "Laptop")], pools: cluster("local", "h1"),
    respond: async () => Response.json({ pools: cluster("local"), restoreError: "omp-web/own-config/agent is not readable" }),
  });
  await user.click(clusterSwitch("Laptop"));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
  await waitFor(() => assert.deepEqual(errors, ["Laptop left the cluster, but its own omp configuration could not be put back: omp-web/own-config/agent is not readable. It is retried automatically while the host is linked."]));
});

const configState = (fields = {}) => ({ version: "a".repeat(64), files: "current", plugins: "current", error: null, missingCommands: [], owned: true, current: true, ...fields });
const configLines = (name) => within(rowOf(name)).queryAllByText(/^(Configuration:|Not installed on this host:|Update ompweb on this host first)/).map((line) => line.textContent);

for (const [label, overrides, lines] of [
  ["current", { clusterConfig: configState() }, ["Configuration: same as the master"]],
  ["updating", { clusterConfig: configState({ plugins: "pending", current: false }) }, ["Configuration: updating…"]],
  ["not reported yet", {}, ["Configuration: updating…"]],
  ["failed", { clusterConfig: configState({ files: "failed", error: "the master answered 500 for the manifest", current: false }) }, ["Configuration: failed — the master answered 500 for the manifest"]],
  ["held by another server", { clusterConfig: configState({ owned: false, current: false }) }, ["Configuration: held by another ompweb server; remove it from that server's cluster first"]],
  ["current, with commands it lacks", { clusterConfig: configState({ missingCommands: ["uvx", "docker"] }) }, ["Configuration: same as the master", "Not installed on this host: uvx, docker"]],
  ["below link protocol 10, never reporting", { hostVersion: 9 }, ["Update ompweb on this host first"]],
  ["offline, with its last report", { status: "offline", clusterConfig: configState({ missingCommands: ["uvx"] }) }, []],
  ["offline, never reported", { status: "offline" }, []],
]) {
  test(`a member's row states its configuration: ${label}`, async (t) => {
    await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop", overrides)], pools: cluster("local", "h1") });
    assert.deepEqual(configLines("Laptop"), lines);
  });
}

const MASTER_ERROR = { code: "file_too_large", message: "rules/big.md is 6000000 bytes, over the 5242880 byte limit" };
const masterErrors = () => screen.queryAllByText(/^Members cannot get this machine's configuration/).map((line) => line.textContent);

test("a master configuration the members cannot get is said once, above the member rows, until it works again", async (t) => {
  const hosts = [hostRow(), linked("h1", "Laptop"), linked("h2", "Desk")];
  const { frame } = await showHosts(t, { hosts, pools: cluster("local", "h1", "h2") });
  assert.deepEqual(masterErrors(), []);
  frame({ hosts, masterConfigError: MASTER_ERROR });
  assert.deepEqual(masterErrors(), [`Members cannot get this machine's configuration: ${MASTER_ERROR.message}`]);
  const [line] = screen.getAllByText(/^Members cannot get/);
  assert.ok(line.compareDocumentPosition(rowOf("Laptop")) & 4, "before the rows");
  frame({ hosts });
  assert.deepEqual(masterErrors(), []);
});

test("without linked members the master configuration error is not shown", async (t) => {
  const hosts = [hostRow(), linked("h1", "Laptop")];
  const { frame } = await showHosts(t, { hosts, pools: cluster("local") });
  frame({ hosts, masterConfigError: MASTER_ERROR });
  assert.deepEqual(masterErrors(), []);
});

test("while members cannot get this machine's configuration, no member row says it is updating", async (t) => {
  const hosts = [hostRow(), linked("h1", "Laptop"), linked("h2", "Desk", { clusterConfig: configState({ plugins: "pending", current: false }) })];
  const { frame } = await showHosts(t, { hosts, pools: cluster("local", "h1", "h2") });
  assert.deepEqual([configLines("Laptop"), configLines("Desk")], [["Configuration: updating…"], ["Configuration: updating…"]]);
  frame({ hosts, masterConfigError: MASTER_ERROR });
  assert.deepEqual([configLines("Laptop"), configLines("Desk")], [[], []]);
});

test("a standalone host shows no configuration line, even with a report", async (t) => {
  await showHosts(t, { hosts: [hostRow(), linked("h1", "Laptop", { clusterConfig: configState({ owned: false, missingCommands: ["uvx"] }) })], pools: cluster("local") });
  assert.deepEqual(configLines("Laptop"), []);
  assert.deepEqual(configLines("This machine"), []);
});

for (const [label, saved, reloads] of LOST) {
  test(`a leave whose answer is lost, ${label}, shows what the reload finds before Remove is enabled again`, async (t) => {
    const errors = [];
    t.mock.method(toast, "error", (message) => { errors.push(message); });
    const pools = cluster("local", "h1");
    let reloadFails = false;
    const { user } = await showHosts(t, {
      hosts: [hostRow(), linked("h1", "Laptop")], pools: () => (reloadFails ? null : pools),
      respond: async () => {
        if (saved) pools[0].members.pop();
        reloadFails = !reloads;
        throw new TypeError("Failed to fetch");
      },
    });
    await user.click(clusterSwitch("Laptop"));
    const remove = within(await screen.findByRole("dialog", { name: "Remove Laptop from the cluster?" })).getByRole("button", { name: "Remove" });
    await user.click(remove);
    if (saved && reloads) {
      // Done after all: no error, and no leave offered again.
      await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
      assert.equal(clusterSwitch("Laptop").getAttribute("aria-checked"), "false");
      assert.deepEqual(errors, []);
      return;
    }
    await waitFor(() => assert.deepEqual(errors, [reloads ? "Failed to fetch" : UNKNOWN]));
    await waitFor(() => assert.equal(remove.disabled, false));
  });
}
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
