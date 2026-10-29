import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const { LocalDaemonBanner, LOCAL_DAEMON_BANNER_DISMISSED_KEY } = await createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, jsx: { runtime: "automatic" } }).import("./LocalDaemonBanner.tsx");

const originalWorker = globalThis.Worker;
const workers = [];
class FakeWorker {
  onmessage = null;
  onerror = null;
  posted = [];
  constructor() { workers.push(this); }
  postMessage(message) { this.posted.push(message); }
}
beforeEach(() => { globalThis.Worker = FakeWorker; localStorage.clear(); });
afterEach(() => {
  cleanup();
  globalThis.Worker = originalWorker;
});

const local = (fields) => ({ id: "local", label: "", status: "offline", ompVersion: null, platform: null, lastSeenAt: null, hostVersion: null, serverVersion: 3, serverPlatform: "linux", daemonManaged: true, ...fields });
const send = (hosts) => {
  const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
  act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts }) } }));
};
const opens = () => workers[0]?.posted.filter((message) => message.op === "open").length ?? 0;
// The event-stream transport keeps its first worker, so a new mount shows up as one more open.
const mount = async () => {
  const before = opens();
  render(createElement(LocalDaemonBanner));
  await waitFor(() => assert.ok(opens() > before));
};
const text = /needs the ompweb-host service/;

test("the install banner appears after 90 s offline, once: dismissing it keeps it away", async (t) => {
  await mount();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  send([local({})]);
  act(() => t.mock.timers.tick(89_999));
  assert.equal(screen.queryByText(text), null);
  act(() => t.mock.timers.tick(1));
  assert.ok(screen.getByText(text).textContent.startsWith("This machine needs the ompweb-host service. Install it with:"));
  assert.equal(screen.getByRole("status").querySelector("code").textContent, "ompweb systemd install");

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  assert.equal(screen.queryByText(text), null);
  assert.ok(localStorage.getItem(LOCAL_DAEMON_BANNER_DISMISSED_KEY));

  cleanup();
  t.mock.timers.reset(); // waitFor needs real timers
  await mount();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  send([local({})]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);
});

test("the live region stays mounted while the banner is hidden", async () => {
  await mount();
  send([local({})]);
  assert.ok(screen.getByRole("status"));
  assert.equal(screen.getByRole("status").childElementCount, 0);
});

test("no banner when the daemon links within 90 s, or has linked before, or in dev mode", async (t) => {
  await mount();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  send([local({})]);
  act(() => t.mock.timers.tick(30_000));
  send([local({ status: "online", hostVersion: 3 })]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);

  // A daemon that linked earlier and dropped is the offline banner's job, not an install hint.
  send([local({ hostVersion: 3 })]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);

  // Dev mode: this machine is offline by design.
  send([local({ daemonManaged: false })]);
  act(() => t.mock.timers.tick(200_000));
  assert.equal(screen.queryByText(text), null);
});
