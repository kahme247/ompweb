import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { workspaceHarness } from "../lib/hosts/workspace-test-helper.mjs";
// The real uploader uses HTTP fallback against the real server/Node daemon, not a simulated upload response.
const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react/pure.js");
const { FileExplorer } = await import("./FileExplorer.tsx");
const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker };
let harness;
afterEach(async () => {
  cleanup();
  await harness?.close();
  harness = undefined;
  globalThis.fetch = original.fetch;
  globalThis.Worker = original.Worker;
  globalThis.SharedWorker = original.SharedWorker;
  delete window.matchMedia;
});

async function mount() {
  harness = await workspaceHarness();
  const owner = await harness.startHost();
  await owner.host.sessionOps.validateCwd(owner.project);
  globalThis.Worker = undefined;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const progress = { received: false, cancelled: false };
  globalThis.fetch = async (request, options) => {
    const url = new URL(typeof request === "string" ? request : request.url, harness.url);
    const response = await original.fetch(url, options);
    if (url.pathname.startsWith("/api/uploads/") && options?.method === "PUT" && response.ok) {
      const ack = await response.clone().json();
      if (ack.received > 0 && !ack.done) progress.received = true;
    }
    if (url.pathname.startsWith("/api/uploads/") && options?.method === "DELETE" && response.status === 204) progress.cancelled = true;
    return response;
  };
  const view = render(React.createElement(FileExplorer, { hostId: owner.id, cwd: owner.project, onOpenFile() {} }));
  await waitFor(() => assert.equal(view.container.querySelector('[role="tree"]').getAttribute("aria-busy"), "false"));
  return { owner, view, progress };
}

test("Explorer publishes a file beyond the legacy 25 MiB cap through the real staged uploader", async () => {
  const { owner, view } = await mount();
  const size = 26 * 1024 * 1024;
  const bytes = Buffer.alloc(size, 0x5a);
  const file = new File([bytes], "large.bin", { type: "application/octet-stream" });
  fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [file] } });
  await waitFor(() => assert.ok(view.container.querySelector('[data-file-path$="/large.bin"]')), { timeout: 20000 });
  const target = join(owner.project, "large.bin");
  assert.equal(statSync(target).size, size);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  assert.equal(digest.digest("hex"), createHash("sha256").update(bytes).digest("hex"));
});

test("cancelling an in-flight Explorer upload does not publish a partial target", async () => {
  const { owner, view, progress } = await mount();
  const file = new File([Buffer.alloc(16 * 1024 * 1024, 0x31)], "cancelled.bin", { type: "application/octet-stream" });
  fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [file] } });
  await waitFor(() => assert.equal(progress.received, true), { timeout: 5000 });
  fireEvent.click(view.getByRole("button", { name: "Cancel", exact: true }));
  await waitFor(() => assert.equal(progress.cancelled, true), { timeout: 5000 });
  await waitFor(() => assert.equal(view.queryByRole("button", { name: "Cancel", exact: true }) === null, true));
  assert.equal(existsSync(join(owner.project, "cancelled.bin")), false);
});
