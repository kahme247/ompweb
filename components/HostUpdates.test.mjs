import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HostUpdates } from "./HostUpdates";

const endpoint = "/api/hosts/box/updates";
const info = {
  ompweb: { currentVersion: "0.7.0", availableVersion: "0.7.1", updateAvailable: true, canUpdate: true, blockedReason: null, updateCommand: "npm install -g @kahme247/ompweb", installMethod: "npm", protocolVersion: 12 },
  omp: { currentVersion: "18.20.0" },
  operation: null,
};

/** Render the real host row and record every request it sends. */
async function renderHost(t, host, ompweb = {}) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    if (init?.method === "POST") return Response.json({ accepted: true, operation: { state: "running", target: "ompweb", version: "0.7.1" } });
    return Response.json({ ...info, ompweb: { ...info.ompweb, ...ompweb } });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(createElement(HostUpdates, { host }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, requests };
}

const button = (root, label) => [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === label);

test("an upgrade-only legacy host can check for and submit an ompweb update", async (t) => {
  const { container, requests } = await renderHost(t, { id: "box", label: "Box", status: "needs-upgrade", upgradeOnly: true, ompVersion: "omp/18.20.0", ompwebVersion: "0.7.0" });
  assert.equal(requests[0]?.url, endpoint, "the status is read on mount");
  assert.equal(button(container, "Check updates").disabled, false);

  await act(async () => button(container, "Check updates").click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(requests.some((request) => request.url === `${endpoint}?force=1` && request.method === "GET"), requests.map((request) => request.url).join(", "));

  act(() => button(container, "Update").click());
  const confirm = [...document.querySelectorAll(".dialog-actions button")].find((candidate) => candidate.textContent.trim() === "Update");
  assert.ok(confirm, "the update confirmation did not open");
  await act(async () => confirm.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const post = requests.find((request) => request.method === "POST");
  assert.ok(post, "the update was not submitted");
  assert.deepEqual(JSON.parse(post.body), { target: "ompweb", version: "0.7.1" });
});

test("a connected maintenance API can update a compatible host while its application connection is offline", async (t) => {
  const { container, requests } = await renderHost(t, { id: "box", label: "Box", status: "offline", apiVersion: 1, hostVersion: 12, ompwebVersion: "0.7.0" });
  assert.equal(requests[0]?.url, endpoint);
  assert.equal(button(container, "Check updates").disabled, false);
  assert.ok(button(container, "Update"));
});

test("an ordinary incompatible host cannot be checked or updated", async (t) => {
  const { container, requests } = await renderHost(t, { id: "box", label: "Box", status: "needs-upgrade", ompVersion: "omp/18.20.0", ompwebVersion: "0.6.0" });
  assert.deepEqual(requests, [], "an unavailable host must not be read");
  const check = button(container, "Check updates");
  assert.equal(check.disabled, true);
  act(() => check.click());
  assert.equal(button(container, "Update"), undefined);
  assert.ok(container.textContent.includes("This host daemon does not support updates"), container.textContent);
  assert.deepEqual(requests, []);
});

test("an offline host stays unavailable", async (t) => {
  const { container, requests } = await renderHost(t, { id: "box", label: "Box", status: "offline", ompVersion: "omp/18.20.0", ompwebVersion: "0.7.0" });
  assert.deepEqual(requests, []);
  assert.equal(button(container, "Check updates").disabled, true);
  assert.ok(container.textContent.includes("Updates unavailable while this host is offline."), container.textContent);
});

const modern = { id: "box", label: "Box", status: "online", apiVersion: 1, hostVersion: 12, ompwebVersion: "0.7.0" };
const blocked = { canUpdate: false, canForceUpdate: true, blockedReason: "Sessions are running on this host" };
const posts = (requests) => requests.filter((request) => request.method === "POST");
// A closing dialog may linger briefly; the newest one is the one on screen.
const dialogButton = (label) => [...document.querySelectorAll(".dialog-actions button")].filter((candidate) => candidate.textContent.trim() === label).at(-1);

test("a normally blocked host offers a distinct Force update that posts nothing until confirmed", async (t) => {
  const { container, requests } = await renderHost(t, modern, blocked);
  assert.equal(button(container, "Update").disabled, true, "a blocked host cannot be updated normally");
  const force = button(container, "Force update");
  assert.ok(force && !force.disabled);

  act(() => force.click());
  assert.ok(dialogButton("Terminate sessions and update"), "the forced update asks for explicit termination consent");
  assert.deepEqual(posts(requests), [], "opening the confirmation must not submit");

  act(() => dialogButton("Cancel").click());
  assert.deepEqual(posts(requests), [], "cancelling must not submit");

  act(() => button(container, "Force update").click());
  await act(async () => dialogButton("Terminate sessions and update").click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(posts(requests).length, 1);
  assert.deepEqual(JSON.parse(posts(requests)[0].body), { target: "ompweb", version: "0.7.1", force: true });
});

test("force is never inferred from a blocker's wording", async (t) => {
  const { container } = await renderHost(t, modern, { canUpdate: false, blockedReason: "Sessions are running on this host" });
  assert.equal(button(container, "Force update"), undefined);
  assert.ok(container.textContent.includes("Blocked: Sessions are running on this host"));
});

test("a host that can be updated normally offers no force and the normal payload carries no force flag", async (t) => {
  const { container, requests } = await renderHost(t, modern, { canForceUpdate: true });
  assert.equal(button(container, "Force update"), undefined, "force is only offered when the normal update is blocked");
  act(() => button(container, "Update").click());
  await act(async () => dialogButton("Update").click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(JSON.parse(posts(requests)[0].body), { target: "ompweb", version: "0.7.1" });
});

test("a forced update outlives the old 5-minute wait, and giving up later only asks for a status check", async (t) => {
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  const requests = [];
  let posted = false;
  const running = { id: "op", target: "ompweb", version: "0.7.1", state: "running", force: true };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    if (init?.method === "POST") { posted = true; return Response.json({ accepted: true, operation: running }); }
    return Response.json({ ...info, ompweb: { ...info.ompweb, ...blocked }, operation: posted ? running : null });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    Date.now = realNow;
  });
  const settle = (ms) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  await act(async () => { root.render(createElement(HostUpdates, { host: modern })); });
  await settle(20);

  act(() => button(container, "Force update").click());
  await act(async () => dialogButton("Terminate sessions and update").click());
  await settle(20);
  assert.equal(posts(requests).length, 1);

  skewMs = 6 * 60_000; // past the old 5-minute limit, inside the 15-minute lease
  await settle(1200);
  assert.ok(container.textContent.includes("Updating ompweb host to 0.7.1"), container.textContent);
  assert.ok(!container.textContent.includes("Stopped waiting"), "gave up inside the backend lease");

  skewMs = 21 * 60_000; // beyond the wait
  await settle(1200);
  assert.ok(container.textContent.includes("Stopped waiting for this host to report"), container.textContent);
  assert.ok(container.textContent.includes("Check status with Retry"));
  assert.ok(button(container, "Force update").disabled, "no second Force until status is re-read");
  assert.ok(button(container, "Update").disabled);
  assert.equal(posts(requests).length, 1, "giving up never resubmits");
});
