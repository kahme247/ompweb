import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
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
  assert.deepEqual([...localRow.querySelectorAll("button")].map((button) => button.textContent), ["Rename"]);
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
  assert.deepEqual([...hint.closest("li").querySelectorAll("button")].map((button) => button.textContent), ["Copy", "Copy", "Rename"]);

  send([row({ serverPlatform: "linux" })]);
  assert.equal((await screen.findByText(/ompweb-host service/)).closest("li").querySelector("code").textContent, "ompweb systemd install");
  send([row({ serverPlatform: "win32" })]);
  assert.equal((await screen.findByText(/ompweb-host service/)).closest("li").querySelector("code").textContent, "ompweb-tray install");

  // Dev mode: offline by design, nothing to install.
  send([row({ daemonManaged: false })]);
  await waitFor(() => assert.equal(screen.queryByText(/ompweb-host service/), null));

  send([row({ status: "online", hostVersion: 3 })]);
  await waitFor(() => assert.equal(screen.queryByText(/ompweb-host service/), null));
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
