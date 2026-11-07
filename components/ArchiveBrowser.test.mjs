import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");


const {
  ArchiveBrowser,
  formatArchiveSize,
  formatArchiveRelativeTime,
  MetadataRow,
} = await import("./ArchiveBrowser.tsx");

test("formatArchiveSize formats bytes correctly", () => {
  assert.equal(formatArchiveSize(0), "0 B");
  assert.equal(formatArchiveSize(512), "512 B");
  assert.equal(formatArchiveSize(1024), "1.0 KB");
  assert.equal(formatArchiveSize(2048), "2.0 KB");
  assert.equal(formatArchiveSize(1024 * 1024), "1.0 MB");
  assert.equal(formatArchiveSize(5.5 * 1024 * 1024), "5.5 MB");
});

test("formatArchiveRelativeTime formats past times accurately", () => {
  const now = 1_700_000_000_000;
  const isoNow = new Date(now).toISOString();
  const iso5MinAgo = new Date(now - 5 * 60_000).toISOString();
  const iso2HoursAgo = new Date(now - 2 * 3600_000).toISOString();
  const iso3DaysAgo = new Date(now - 3 * 86400_000).toISOString();

  assert.equal(formatArchiveRelativeTime(isoNow, now), "now");
  assert.equal(formatArchiveRelativeTime(iso5MinAgo, now), "5m");
  assert.equal(formatArchiveRelativeTime(iso2HoursAgo, now), "2h");
  assert.equal(formatArchiveRelativeTime(iso3DaysAgo, now), "3d");
});

test("MetadataRow renders label and value", () => {
  function DummyIcon() {
    return React.createElement("span", { "data-testid": "dummy-icon" }, "icon");
  }

  const html = renderToStaticMarkup(
    React.createElement(MetadataRow, {
      icon: DummyIcon,
      label: "Directory",
      value: "/workspace/my-project",
      mono: true,
    }),
  );

  assert.match(html, /Directory/);
  assert.match(html, /\/workspace\/my-project/);
  assert.match(html, /data-testid="dummy-icon"/);
});

const originalWorker = globalThis.Worker;
afterEach(() => {
  cleanup();
  globalThis.Worker = originalWorker;
});

test("selecting a remote archive with a local key collision switches details and restores on its host", async (t) => {
  const workers = [];
  globalThis.Worker = class FakeWorker {
    onmessage = null;
    onerror = null;
    posted = [];
    constructor() { workers.push(this); }
    postMessage(message) { this.posted.push(message); }
  };
  const shared = {
    key: "same-session.jsonl.gz",
    id: "same-session",
    created: "2026-11-01T12:00:00Z",
    archivedAt: "2026-11-02T12:00:00Z",
    size: 1024,
    messageCount: 2,
    status: "complete",
  };
  const archives = [
    { ...shared, hostId: "local", name: "Local archive", cwd: "/local/project", firstMessage: "Local initial prompt" },
    { ...shared, hostId: "remote", name: "Remote archive", cwd: "/remote/project", firstMessage: "Remote initial prompt", messageCount: 17 },
  ];
  const restores = [];
  const restored = [];
  let closed = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "/api/sessions/archive");
    if (init?.method === "POST") {
      restores.push(JSON.parse(init.body));
      return Response.json({ ok: true, sessionId: shared.id });
    }
    return Response.json({ archives });
  });
  render(React.createElement(ArchiveBrowser, {
    open: true,
    onClose() { closed++; },
    onRestored(id) { restored.push(id); },
  }));
  await waitFor(() => assert.ok(workers[0]?.posted.some((message) => message.op === "open" && message.channel.kind === "hosts")));
  const hostStreams = workers.flatMap((worker) => worker.posted.filter((message) => message.op === "open"));
  assert.equal(hostStreams.length, 1, "host labels must reuse the shared hosts stream");
  const { id } = hostStreams[0];
  act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({
    hosts: [{ id: "local", label: "", status: "online" }, { id: "remote", label: "Build server", status: "online" }],
  }) } }));

  await screen.findByRole("heading", { name: "Local archive" });
  assert.equal(screen.getByText("Directory").parentElement.textContent, "Directory/local/project");
  screen.getByText("Local initial prompt");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Remote archive/ }));

  await screen.findByRole("heading", { name: "Remote archive" });
  assert.equal(screen.queryByRole("heading", { name: "Local archive" }), null);
  assert.equal(screen.getByText("Directory").parentElement.textContent, "Directory/remote/project");
  assert.equal(screen.getByText("Host").parentElement.textContent, "HostBuild server");
  assert.equal(screen.getByText("Messages").parentElement.textContent, "Messages17");
  screen.getByText("Remote initial prompt");
  assert.equal(screen.queryByText("Local initial prompt"), null);

  await user.click(screen.getByRole("button", { name: "Restore Session" }));
  await waitFor(() => assert.deepEqual(restores, [{ key: shared.key, hostId: "remote" }]));
  await waitFor(() => assert.deepEqual(restored, [shared.id]));
  assert.equal(closed, 1);
});

test("a restore refused by an offline host names that host and why it blocks the restore", async (t) => {
  const { toast } = await import("./ui/toast.tsx");
  const errors = [];
  t.mock.method(toast, "error", (message) => { errors.push(message); });
  globalThis.Worker = class FakeWorker { postMessage() {} };
  const archive = { key: "kept.jsonl.gz", id: "kept", hostId: "local", name: "Kept", cwd: "/local", firstMessage: "", created: "2026-11-01T12:00:00Z",
    archivedAt: "2026-11-02T12:00:00Z", size: 10, messageCount: 1, status: "complete" };
  t.mock.method(globalThis, "fetch", async (_url, init) => init?.method === "POST"
    ? Response.json({ error: "Laptop is offline", code: "host_offline", hostOffline: true, host: "Laptop" }, { status: 503 })
    : Response.json({ archives: [archive] }));
  render(React.createElement(ArchiveBrowser, { open: true, onClose() {}, onRestored() {} }));
  await screen.findByRole("heading", { name: "Kept" });
  await userEvent.setup().click(screen.getByRole("button", { name: "Restore Session" }));
  await waitFor(() => assert.deepEqual(errors, [
    "Failed to restore session: Laptop is offline. Restoring needs every registered host online, to check that the session is not active on one of them.",
  ]));
});

test("capture evidence cannot be restored or alias the replacement archive's selectable target", async (t) => {
  globalThis.Worker = class FakeWorker { postMessage() {} };
  const base = { hostId: "local", cwd: "/local", firstMessage: "", created: "2026-11-01T12:00:00Z", archivedAt: "2026-11-02T12:00:00Z", size: 10, messageCount: 1 };
  const capture = { ...base, key: "kept.jsonl.gz.11111111-2222-4333-8444-555555555555.restore-consume", id: "capture-a", name: "Captured A", restorePending: true };
  const replacement = { ...base, key: "kept.jsonl.gz", id: "replacement-b", name: "Replacement B" };
  const posts = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return Response.json({ ok: true, sessionId: replacement.id });
    }
    return Response.json({ archives: [capture, replacement] });
  });
  render(React.createElement(ArchiveBrowser, { open: true, onClose() {}, onRestored() {} }));
  await screen.findByRole("heading", { name: "Captured A" });
  const user = userEvent.setup();
  const blocked = screen.getByRole("button", { name: "Restore Session" });
  assert.equal(screen.queryByRole("button", { name: "Restoring…" }), null, "capture evidence does not imply that an operation is running");
  assert.equal(blocked.disabled, true);
  await user.click(blocked);
  assert.deepEqual(posts, []);
  await user.click(screen.getByRole("button", { name: /Replacement B/ }));
  await screen.findByRole("heading", { name: "Replacement B" });
  const restore = screen.getByRole("button", { name: "Restore Session" });
  assert.equal(restore.disabled, false);
  await user.click(restore);
  await waitFor(() => assert.deepEqual(posts, [{ key: replacement.key, hostId: "local" }]));
});
