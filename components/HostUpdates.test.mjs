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
async function renderHost(t, host) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    if (init?.method === "POST") return Response.json({ accepted: true, operation: { state: "running", target: "ompweb", version: "0.7.1" } });
    return Response.json(info);
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
