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

test("the one-time host token survives Escape; only Done closes it", async (t) => {
  // The hosts list rides the shared event-stream worker; a silent one keeps it idle.
  globalThis.Worker = FakeWorker;
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

test("this machine can be renamed but not revoked", async (t) => {
  globalThis.Worker = FakeWorker;
  const patches = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("/updates")) return Response.json(updateInfo());
    patches.push([init?.method, JSON.parse(init?.body ?? "null")]);
    return Response.json({});
  });
  render(createElement(HostsConfig));
  const row = (fields) => ({ status: "online", ompVersion: null, platform: null, lastSeenAt: null, hostVersion: null, serverVersion: 3, ...fields });
  const hosts = [row({ id: "local", label: "" }), row({ id: "h1", label: "Laptop", allowAgentStart: false })];
  await waitFor(() => assert.ok(workers[0].posted.some((message) => message.op === "open" && message.channel.kind === "hosts")));
  const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
  act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts }) } }));

  const localRow = (await screen.findByRole("button", { name: "Rename This machine" })).closest("li");
  assert.equal(within(localRow).queryByRole("button", { name: "Revoke" }), null);
  assert.ok(screen.getByRole("button", { name: "Rename Laptop" }).closest("li").textContent.includes("Revoke"));

  // An empty name is allowed here: it resets to the default.
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Rename This machine" }));
  await user.type(screen.getByPlaceholderText("This machine"), "Desk");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.deepEqual(patches, [["PATCH", { id: "local", label: "Desk" }]]));

  // With a custom name the card and its rename button use it.
  act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts: [row({ id: "local", label: "Desk" })] }) } }));
  await screen.findByRole("button", { name: "Rename Desk" });
});

test("an offline this-machine row says to start the service, with the server's install command", async (t) => {
  globalThis.Worker = FakeWorker;
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  render(createElement(HostsConfig));
  const row = (fields) => ({ id: "local", label: "", status: "offline", ompVersion: null, platform: null, lastSeenAt: null, hostVersion: null, serverVersion: 3, serverPlatform: "darwin", daemonManaged: true, ...fields });
  await waitFor(() => assert.ok(workers[0].posted.some((message) => message.op === "open" && message.channel.kind === "hosts")));
  const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
  const send = (hosts) => act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts }) } }));

  send([row({})]);
  const hint = await screen.findByText(/ompweb-host service/);
  assert.deepEqual([...hint.closest("li").querySelectorAll("code")].map((code) => code.textContent), ["ompweb launchd install", "ompweb host"]);
  assert.match(hint.closest("li").textContent, /in a terminal or with npx/);
  // The commands are copyable; the local row still has no Revoke.
  assert.equal(within(hint.closest("li")).queryByRole("button", { name: "Revoke" }), null);

  send([row({ serverPlatform: "linux" })]);
  assert.equal((await screen.findByText(/ompweb-host service/)).closest("li").querySelector("code").textContent, "ompweb systemd install");
  send([row({ serverPlatform: "win32" })]);
  assert.equal((await screen.findByText(/ompweb-host service/)).closest("li").querySelector("code").textContent, "ompweb-tray install");

  // Dev mode: offline by design, nothing to install.
  send([row({ daemonManaged: false })]);
  await waitFor(() => assert.equal(screen.queryByText(/ompweb-host service/), null));

  send([row({ status: "online", hostVersion: 2, serverVersion: 3 })]);
  await waitFor(() => assert.equal(screen.queryByText(/ompweb-host service/), null));
  // The daemon's protocol on its row, the web app's in the header; a needs-upgrade status already names both.
  assert.match(screen.getByRole("button", { name: "Rename This machine" }).closest("li").textContent, /link protocol v2/);
  screen.getByText("This web app expects link protocol v3.");
  send([row({ status: "needs-upgrade", hostVersion: 2, serverVersion: 3 })]);
  await waitFor(() => assert.doesNotMatch(screen.getByRole("button", { name: "Rename This machine" }).closest("li").textContent, /link protocol v2/));
});

test("the local name hint is the input's description, not part of its label", async (t) => {
  globalThis.Worker = FakeWorker;
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  render(createElement(HostsConfig));
  const row = { id: "local", label: "", status: "online", ompVersion: null, platform: null, lastSeenAt: null, hostVersion: 3, serverVersion: 3, serverPlatform: "linux", daemonManaged: true };
  await waitFor(() => assert.ok(workers[0].posted.some((message) => message.op === "open" && message.channel.kind === "hosts")));
  const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
  act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts: [row] }) } }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Rename This machine" }));
  // The label stays just "Name": the hint is not inside it.
  screen.getByRole("textbox", { name: "Name" });
  assert.equal(screen.getByRole("textbox").getAttribute("aria-describedby"), screen.getByText(/Leave empty/).id);
});

const software = (overrides = {}) => ({
  currentVersion: "1.0.0", availableVersion: "1.1.0", updateAvailable: true,
  canUpdate: true, blockedReason: null, updateCommand: "fixture update", ...overrides,
});
const updateInfo = (overrides = {}) => ({
  ompweb: software({ installMethod: "npm", protocolVersion: 3 }),
  omp: software({ updatesDisabled: false }),
  operation: null, ...overrides,
});
const hostRow = (overrides = {}) => ({
  id: "local", label: "", status: "online", ompVersion: "1.0.0", platform: "linux",
  hostVersion: 3, serverVersion: 3, lastSeenAt: null, ...overrides,
});
async function showHosts(hosts) {
  globalThis.Worker = FakeWorker;
  const view = render(createElement(HostsConfig));
  await waitFor(() => assert.ok(workers[0].posted.some((message) => message.op === "open" && message.channel.kind === "hosts")));
  const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
  act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts }) } }));
  return view;
}

test("local host shows both installed versions and a blocked candidate with its server reason", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return Response.json(updateInfo({
      ompweb: software({ installMethod: "npm", protocolVersion: 3, canUpdate: false, blockedReason: "Update the web server first: protocol 4 is not supported." }),
    }));
  });
  await showHosts([hostRow()]);
  const row = screen.getByRole("button", { name: "Rename This machine" }).closest("li");
  await within(row).findByText(/Update the web server first: protocol 4 is not supported\./);
  assert.ok(within(row).getByRole("button", { name: "Update ompweb host" }).disabled);
  assert.equal(within(row).getByRole("button", { name: "Update omp runtime" }).disabled, false);
  assert.match(row.textContent, /Current: 1\.0\.0/);
  assert.match(row.textContent, /Available: 1\.1\.0/);
  assert.deepEqual(urls, ["/api/hosts/local/updates"]);
});

test("remote daemon update requires closing host sessions and targets only that host; acceptance is not success", async (t) => {
  const posts = [];
  let operation = null;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init?.method === "POST") {
      posts.push([String(url), JSON.parse(init.body)]);
      operation = { id: "op1", target: "ompweb", version: "1.1.0", state: "running" };
      return Response.json({ accepted: true, operation }, { status: 202 });
    }
    return Response.json(updateInfo({
      operation,
      ...(operation?.state === "succeeded" ? { ompweb: software({ currentVersion: "1.1.0", availableVersion: null, updateAvailable: false, installMethod: "npm", protocolVersion: 3 }) } : {}),
    }));
  });
  const view = await showHosts([hostRow({ id: "h/remote", label: "Laptop", allowAgentStart: false })]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Update ompweb host" }));
  assert.equal(posts.length, 0);
  assert.match(screen.getByRole("dialog").textContent, /Close all sessions and stop subagents on Laptop first/i);
  assert.match(screen.getByRole("dialog").textContent, /restarts the host daemon/i);
  assert.match(screen.getByRole("dialog").textContent, /sessions will not resume automatically/i);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Update" }));
  await screen.findByText("Updating ompweb host to 1.1.0…");
  assert.deepEqual(posts, [["/api/hosts/h%2Fremote/updates", { target: "ompweb", version: "1.1.0" }]]);
  assert.equal(screen.queryByText("Update completed."), null);
  operation = { ...operation, state: "succeeded" };
  await screen.findByText("Update completed.", {}, { timeout: 3500 });
  screen.getByText("Current: 1.1.0");
  view.unmount();
});

test("runtime update explains existing sessions without forcing any session restart", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push([String(url), init?.method ?? "GET", init?.body]);
    if (init?.method === "POST") return Response.json({ accepted: true, operation: { id: "omp1", target: "omp", version: "1.1.0", state: "succeeded" } }, { status: 202 });
    return Response.json(updateInfo());
  });
  await showHosts([hostRow()]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Update omp runtime" }));
  assert.match(screen.getByRole("dialog").textContent, /existing sessions.*old runtime.*restart/i);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Update" }));
  await waitFor(() => assert.equal(requests.filter(([, method]) => method === "POST").length, 1));
  assert.deepEqual(requests.find(([, method]) => method === "POST"), ["/api/hosts/local/updates", "POST", JSON.stringify({ target: "omp", version: "1.1.0" })]);
});

test("offline and protocol-incompatible hosts render unavailable rows without requesting updates", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(url); return Response.json({}); });
  await showHosts([hostRow({ status: "offline" }), hostRow({ id: "old", label: "Old", status: "needs-upgrade", allowAgentStart: false })]);
  assert.equal(screen.getAllByText("ompweb host").length, 2);
  assert.equal(screen.getAllByText("omp runtime").length, 2);
  screen.getByText("Updates unavailable while this host is offline.");
  screen.getByText("This host daemon does not support updates. Upgrade it manually first.");
  assert.deepEqual(calls, []);
});

test("old daemon 501 stops checking and explains unsupported updates", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: "unknown operation", code: "unknown_op" }, { status: 501 });
  });
  await showHosts([hostRow()]);
  await screen.findByText("This host daemon does not support updates. Upgrade it manually first.");
  assert.ok(screen.getByRole("button", { name: "Check updates" }).disabled);
  assert.equal(calls, 1);
});

test("a failed manual check keeps known versions but never claims up to date", async (t) => {
  let fail = false;
  t.mock.method(globalThis, "fetch", async () => fail
    ? Response.json({ error: "Registry unavailable" }, { status: 503 })
    : Response.json(updateInfo({ ompweb: software({ updateAvailable: false, availableVersion: null }), omp: software({ updateAvailable: false, availableVersion: null }) })));
  await showHosts([hostRow()]);
  await screen.findAllByText("Up to date");
  fail = true;
  await userEvent.setup().click(screen.getByRole("button", { name: "Check updates" }));
  await screen.findByText(/Registry unavailable/);
  assert.equal(screen.queryByText("Up to date"), null);
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

for (const [lost, answer] of [
  ["a dropped connection", () => { throw new TypeError("Connection lost"); }],
  ["an offline host (503)", () => Response.json({ error: "Build box is offline", code: "host_offline" }, { status: 503 })],
  ["a timed-out host (504)", () => Response.json({ error: "Build box did not answer updateSoftware in time", code: "host_timeout" }, { status: 504 })],
]) {
  test(`after ${lost}, status is requested before another POST and shows the real failure`, async (t) => {
    const calls = [];
    let operation = null;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        // The host received the request and started the update; only its answer was lost.
        operation = { id: "lost", target: "omp", version: "1.1.0", state: "failed", error: "Install failed; restored previous runtime" };
        return answer();
      }
      return Response.json(updateInfo({ operation }));
    });
    await showHosts([hostRow()]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update omp runtime" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Update" }));
    await screen.findByText(/Install failed; restored previous runtime/, {}, { timeout: 3500 });
    assert.deepEqual(calls, ["GET", "POST", "GET"]);
  });
}

test("an unknown update outcome keeps Update disabled until a status read succeeds, then allows one fresh attempt", async (t) => {
  const methods = [];
  let statusAvailable = true;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") {
      statusAvailable = false;
      throw new TypeError("Connection lost");
    }
    if (!statusAvailable) return Response.json({ error: "host unreachable" }, { status: 503 });
    // The host never received the lost request: no operation, update still offered.
    return Response.json(updateInfo());
  });
  await showHosts([hostRow()]);
  const user = userEvent.setup();
  const updateButton = () => screen.getByRole("button", { name: "Update omp runtime" });
  assert.equal((await screen.findByRole("button", { name: "Update omp runtime" })).disabled, false);
  await user.click(updateButton());
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Update" }));

  await screen.findByText(/Could not check updates: host unreachable/, {}, { timeout: 3500 });
  screen.getByText("Check status with Retry before attempting another update.");
  assert.equal(updateButton().disabled, true);
  assert.equal(methods.filter((method) => method === "POST").length, 1);

  // Status polling keeps running while the outcome is unknown; Retry is disabled until it answers.
  assert.equal(screen.getByRole("button", { name: "Retry" }).disabled, true);
  statusAvailable = true;
  await waitFor(() => assert.equal(updateButton().disabled, false), { timeout: 3500 });
  assert.equal(screen.queryByText("Check status with Retry before attempting another update."), null);
  assert.equal(methods.filter((method) => method === "POST").length, 1);
});

test("unmount aborts an outstanding host update check", async (t) => {
  let signal;
  t.mock.method(globalThis, "fetch", (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  });
  const view = await showHosts([hostRow()]);
  await waitFor(() => assert.ok(signal));
  view.unmount();
  assert.equal(signal.aborted, true);
});

test("idle host checks stop, and a manual check bypasses cached release data", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return Response.json(updateInfo());
  });
  await showHosts([hostRow()]);
  await screen.findByRole("button", { name: "Update omp runtime" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  assert.deepEqual(urls, ["/api/hosts/local/updates"]);
  await userEvent.setup().click(screen.getByRole("button", { name: "Check updates" }));
  await waitFor(() => assert.deepEqual(urls, ["/api/hosts/local/updates", "/api/hosts/local/updates?force=1"]));
});

test("reconnect polling is bounded and requires a status check before any retry", async (t) => {
  const now = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, "now", () => now() + offset);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(updateInfo({ operation: { id: "running", target: "ompweb", version: "1.1.0", state: "running" } }));
  });
  await showHosts([hostRow()]);
  await screen.findByText("Updating ompweb host to 1.1.0…");
  offset = 5 * 60 * 1000 + 1;
  await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  screen.getByText(/Stopped waiting after 5 minutes/);
  assert.ok(screen.getByRole("button", { name: "Update ompweb host" }).disabled);
  assert.equal(calls, 1);
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

test("unavailable discovery retains versions advertised by the host", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unknown_op", code: "unknown_op" }, { status: 501 }));
  await showHosts([hostRow({ ompwebVersion: "0.6.7", ompVersion: "20.0.1" })]);
  await screen.findByText("This host daemon does not support updates. Upgrade it manually first.");
  screen.getByText("Current: 0.6.7");
  screen.getByText("Current: 20.0.1");
});

test("per-software discovery failure or unknown installed version never claims up to date", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(updateInfo({
    ompweb: software({ availableVersion: null, updateAvailable: false, canUpdate: false, blockedReason: "Registry metadata could not be loaded", installMethod: "npm", protocolVersion: 3 }),
    omp: software({ currentVersion: null, availableVersion: null, updateAvailable: false, canUpdate: false, updatesDisabled: false }),
  })));
  await showHosts([hostRow()]);
  await screen.findByText(/Registry metadata could not be loaded/);
  assert.equal(screen.queryByText("Up to date"), null);
});

test("a registry version that is not newer is not shown as an available candidate", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(updateInfo({
    ompweb: software({ currentVersion: "18.14.0", availableVersion: "18.14.0", updateAvailable: false, canUpdate: false, installMethod: "npm", protocolVersion: 3 }),
    omp: software({ currentVersion: "20.1.0-beta.1", availableVersion: "20.0.9", updateAvailable: false, canUpdate: false, updatesDisabled: false }),
  })));
  await showHosts([hostRow()]);
  await screen.findByText("Current: 18.14.0");
  screen.getByText("Current: 20.1.0-beta.1");
  assert.equal(screen.getAllByText("Up to date").length, 2);
  assert.equal(screen.queryByText(/^Available:/), null);
  assert.equal(screen.queryByRole("button", { name: /^Update (ompweb host|omp runtime)$/ }), null);
});

test("resident-session blocking stays readable with a disabled daemon update and allows runtime updates", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(updateInfo({
    ompweb: software({ canUpdate: false, blockedReason: "Close all sessions on Laptop before updating the host daemon.", installMethod: "npm", protocolVersion: 3 }),
  })));
  await showHosts([hostRow({ id: "laptop", label: "Laptop", allowAgentStart: false })]);
  await screen.findByText(/Close all sessions on Laptop before updating the host daemon/);
  assert.ok(screen.getByRole("button", { name: "Update ompweb host" }).disabled);
  assert.equal(screen.getByRole("button", { name: "Update omp runtime" }).disabled, false);
});
