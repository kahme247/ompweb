import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");
const { MAX_ATTACHED_TEXT_BYTES } = await jiti.import("@/lib/chat-attachments");

const KEY = "attachment-references";
const OTHER_KEY = "attachment-references-other";
const PDF_BYTES = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x00, 0x01);

const previousFetch = globalThis.fetch;
afterEach(() => {
  try {
    cleanup();
  } finally {
    clearDraft(KEY);
    clearDraft(OTHER_KEY);
    localStorage.clear();
    delete window.matchMedia;
    globalThis.fetch = previousFetch;
  }
});
beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

/** In-memory /api/attachments. `holdCompletion(name?)` keeps the final POST
 *  open for that batch name (every batch when omitted). */
function installAttachmentServer() {
  const batches = new Map();
  const requests = [];
  const holds = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url === "/api/attachments" && method === "POST") {
      const batchId = `00000000-0000-4000-8000-${String(batches.size).padStart(12, "0")}`;
      batches.set(batchId, JSON.parse(init.body));
      return Response.json({ batchId }, { status: 201 });
    }
    const batchId = decodeURIComponent(String(url).split("/").pop());
    const batch = batches.get(batchId);
    if (!batch) return Response.json({ error: "Attachment not found", code: "attachment_not_found" }, { status: 404 });
    if (method === "PUT") return Response.json({ ok: true });
    const hold = holds.get(batch.name) ?? holds.get("*");
    if (hold) await hold;
    return Response.json({
      batchId,
      kind: batch.kind,
      name: batch.name,
      path: `/srv/attachments/${batchId}/${batch.name}`,
      size: batch.files.reduce((total, file) => total + file.size, 0),
      fileCount: batch.files.length,
    });
  };
  return {
    batches,
    requests,
    holdCompletion(name = "*") {
      const { promise, resolve } = Promise.withResolvers();
      holds.set(name, promise);
      return () => { holds.delete(name); resolve(); };
    },
  };
}

function renderComposer(props = {}) {
  const sent = [];
  const ref = React.createRef();
  const inputProps = {
    ref,
    draftKey: KEY,
    isStreaming: false,
    onSend: async (message) => {
      sent.push(message);
      return { status: "accepted" };
    },
    onAbort() {},
    ...props,
  };
  const view = render(React.createElement(ChatInput, inputProps));
  return { sent, ref, rerender: (changes) => view.rerender(React.createElement(ChatInput, { ...inputProps, ...changes })) };
}

test("a binary file becomes an uploaded path reference that the sent prompt lists", async () => {
  const server = installAttachmentServer();
  const user = userEvent.setup();
  const { sent, ref } = renderComposer();
  await act(async () => {
    ref.current.addFiles([new File([PDF_BYTES], "report.pdf", { type: "application/pdf" })]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.references?.length, 1));
  const [reference] = getDraft(KEY).references;
  assert.equal(reference.name, "report.pdf");
  assert.equal(reference.kind, "file");
  assert.deepEqual(getDraft(KEY).files, [], "binary content is never inlined");
  assert.deepEqual([...server.batches.values()][0], { kind: "file", name: "report.pdf", files: [{ path: "report.pdf", size: 6 }] });
  assert.ok(screen.getByText("report.pdf"));
  assert.equal(screen.queryByRole("alert"), null, "nothing is reported as skipped");

  await user.type(screen.getByRole("textbox"), "Summarize");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal(
    sent[0],
    `Summarize\n\nAttached paths (uploaded by the user; read them with your tools as needed):\n- ${reference.path} (file, 6 B)`,
  );
  await waitFor(() => assert.equal(getDraft(KEY), null), "sending clears the reference with the draft");
});

test("text too large to inline is uploaded instead of skipped", async () => {
  installAttachmentServer();
  const { ref } = renderComposer();
  await act(async () => {
    ref.current.addFiles([
      new File(["x".repeat(MAX_ATTACHED_TEXT_BYTES + 1)], "huge.log", { type: "text/plain" }),
      new File(["small"], "small.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => {
    assert.deepEqual(getDraft(KEY)?.references?.map((item) => item.name), ["huge.log"]);
    assert.deepEqual(getDraft(KEY)?.files.map((file) => file.name), ["small.txt"]);
  });
});

test("a folder upload shows its file count, holds back sending until done, and survives navigation", async () => {
  const server = installAttachmentServer();
  const release = server.holdCompletion();
  const user = userEvent.setup();
  const { sent, ref, rerender } = renderComposer();
  const folder = {
    name: "dataset",
    entries: async () => [
      { path: "dataset/a.csv", file: new File(["1,2"], "a.csv") },
      { path: "dataset/sub/b.bin", file: new File([PDF_BYTES], "b.bin") },
    ],
  };
  act(() => { ref.current.addFolders([folder]); });
  assert.ok(await screen.findByRole("status", { name: "Uploading dataset" }));
  await user.type(screen.getByRole("textbox"), "look");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  assert.match((await screen.findByRole("alert")).textContent, /still uploading/);
  assert.deepEqual(sent, [], "a send during the upload is refused");

  await act(async () => { release(); });
  await waitFor(() => assert.equal(getDraft(KEY)?.references?.length, 1));
  assert.equal(screen.queryByRole("alert"), null, "the refusal clears once the upload lands");
  assert.deepEqual([...server.batches.values()][0].files, [
    { path: "dataset/a.csv", size: 3 },
    { path: "dataset/sub/b.bin", size: 6 },
  ]);
  assert.ok(screen.getByText("dataset/"));
  assert.ok(screen.getByText("2 files · 9 B"));

  // Switching away and back restores the chip from the draft.
  rerender({ draftKey: OTHER_KEY });
  assert.equal(screen.queryByText("dataset/"), null);
  rerender({ draftKey: KEY });
  assert.ok(screen.getByText("dataset/"));

  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(sent.length, 1));
  const [batchId] = server.batches.keys();
  assert.ok(sent[0].endsWith(`- /srv/attachments/${batchId}/dataset/ (folder, 2 files, 9 B)`), sent[0]);
});

test("the still-uploading refusal stays until the last upload lands", async () => {
  const server = installAttachmentServer();
  const releaseFast = server.holdCompletion("fast");
  const releaseSlow = server.holdCompletion("slow");
  const user = userEvent.setup();
  const { sent, ref } = renderComposer();
  const folder = (name) => ({ name, entries: async () => [{ path: `${name}/a.txt`, file: new File(["abc"], "a.txt") }] });
  act(() => { ref.current.addFolders([folder("fast"), folder("slow")]); });
  assert.ok(await screen.findByRole("status", { name: "Uploading slow" }));
  await user.type(screen.getByRole("textbox"), "look");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  assert.match((await screen.findByRole("alert")).textContent, /still uploading/);

  await act(async () => { releaseFast(); });
  await waitFor(() => assert.equal(getDraft(KEY)?.references?.length, 1));
  assert.match(screen.getByRole("alert").textContent, /still uploading/, "another upload is still running");

  await act(async () => { releaseSlow(); });
  await waitFor(() => assert.equal(getDraft(KEY)?.references?.length, 2));
  assert.equal(screen.queryByRole("alert"), null);
  assert.deepEqual(sent, []);
});

test("removing a reference chip drops it from the prompt", async () => {
  installAttachmentServer();
  const user = userEvent.setup();
  const { sent, ref } = renderComposer();
  await act(async () => {
    ref.current.addFiles([new File([PDF_BYTES], "drop.zip", { type: "application/zip" })]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.references?.length, 1));
  await user.click(screen.getByRole("button", { name: "Remove attachment" }));
  assert.equal(getDraft(KEY), null);
  await user.type(screen.getByRole("textbox"), "plain");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.deepEqual(sent, ["plain"]));
});

test("a failed upload reports the server's reason", async () => {
  globalThis.fetch = async () => Response.json({ error: "Invalid attachment name: bad", code: "invalid_attachment" }, { status: 400 });
  const { ref } = renderComposer();
  await act(async () => {
    ref.current.addFiles([new File([PDF_BYTES], "bad.bin", { type: "application/octet-stream" })]);
  });
  assert.equal((await screen.findByRole("alert")).textContent, "Could not upload bad.bin: Invalid attachment name: bad");
  assert.equal(getDraft(KEY), null);
});

test("an upload failure without a server reason names the HTTP status", async () => {
  globalThis.fetch = async () => new Response("Bad Gateway", { status: 502 });
  const { ref } = renderComposer();
  await act(async () => {
    ref.current.addFiles([new File([PDF_BYTES], "gateway.bin", { type: "application/octet-stream" })]);
  });
  assert.equal((await screen.findByRole("alert")).textContent, "Could not upload gateway.bin: the server responded with HTTP 502");
});

test("Add folder in the plus menu uploads the picked folder as one reference", async () => {
  const server = installAttachmentServer();
  const user = userEvent.setup();
  renderComposer();
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("menuitem", { name: /add folder/i }));
  assert.equal(screen.queryByRole("menu"), null, "choosing the item closes the menu");
  // A webkitdirectory pick lists every file with its path under the folder.
  const picked = (relativePath, content) => {
    const file = new File([content], relativePath.split("/").pop());
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
    return file;
  };
  await user.upload(document.querySelector("input[webkitdirectory]"), [
    picked("photos/a.jpg", PDF_BYTES),
    picked("photos/raw/b.cr2", "xyz"),
  ]);
  await waitFor(() => assert.equal(getDraft(KEY)?.references?.length, 1));
  assert.deepEqual([...server.batches.values()], [{
    kind: "folder",
    name: "photos",
    files: [{ path: "photos/a.jpg", size: 6 }, { path: "photos/raw/b.cr2", size: 3 }],
  }]);
  assert.ok(screen.getByText("photos/"));
});
