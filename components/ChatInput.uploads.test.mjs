import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");

const { ChatInput } = await import("./ChatInput.tsx");
const { MAX_TOTAL_ATTACHED_IMAGE_BYTES } = await import("@/lib/image-attachments");
const { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_MESSAGE, UPLOAD_ID_RE } = await import("@/lib/upload-limits");
const { getDraft } = await import("@/lib/draft-store");
const { openEventStream } = await import("@/lib/event-stream");

// Composer uploads (docs/specs/2026-11-02-file-uploads-design.md U2). No shared worker in jsdom, so uploads take the
// HTTP routes, answered here: POST opens at 0, each PUT is acked through its end once `gate` resolves, or fails with
// `failNextPut` when set.
const previousFetch = globalThis.fetch;
const requests = [];
let gate = Promise.resolve();
let failNextPut = null;
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  requests.push({ url: String(url), method, body: init.body, signal: init.signal });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === "/api/uploads" && method === "POST") return json({ received: 0 });
  if (String(url).startsWith("/api/uploads/") && method === "PUT") {
    await gate;
    if (failNextPut) {
      const failure = failNextPut;
      failNextPut = null;
      if (failure instanceof Error) throw failure;
      const { status, code } = failure;
      return json({ error: code, code }, status);
    }
    const offset = Number(new URL(String(url), "https://omp.test/").searchParams.get("offset"));
    return json({ received: offset + init.body.size, done: true });
  }
  return json({});
};

// Same stand-in as ChatInput.queue-attachments.test.mjs: jsdom's FileReader brand-checks against its own realm's Blob.
const previousFileReader = globalThis.FileReader;
globalThis.FileReader = class {
  result = null;
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
};

// jsdom has no object URLs and the composer reads matchMedia at mount.
URL.createObjectURL = () => "blob:omp-test/preview";
URL.revokeObjectURL = () => {};
const domWindow = window;
const previousMatchMedia = window.matchMedia;
window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

after(() => {
  globalThis.fetch = previousFetch;
  globalThis.FileReader = previousFileReader;
  if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia;
  else delete domWindow.matchMedia;
});
afterEach(() => {
  cleanup();
  requests.length = 0;
  gate = Promise.resolve();
  failNextPut = null;
});

const SEND = /^(Send|chatInput\.send)$/;
const UPLOADING = /1 uploading|chatInput\.uploadsPending/;
const AS_FILE_NOTICE = /too large to send inline|chatInput\.imagesAsFile/;
const SWITCH_TO_INLINE = /Switch to Inline|chatInput\.imageSwitchToInline/;
const SWITCH_TO_FILE = /Switch to As file|chatInput\.imageSwitchToFile/;
const WAITING = /Waiting for 1 upload|chatInput\.uploadsWaiting/;
const FAILED_BLOCK = /1 upload\(s\) failed|chatInput\.uploadsFailedBlock/;
const UPLOAD_FAILED = /Upload failed|chatInput\.uploadFailed/;
const RETRY = /^(Retry upload|chatInput\.uploadRetry)$/;
const RECONNECTING = /Reconnecting…|chatInput\.uploadReconnecting/;
const REMOVE_FILE = /^(Remove file|chatInput\.removeFile)$/;
const TOO_LARGE = /skipped: files up to 2 GB|chatInput\.attachmentUploadTooLarge/;
const UPLOAD_LIMIT = /at most 20 files|chatInput\.attachmentUploadLimit/;
// 1x1 transparent PNG: fits the inline budget.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function renderComposer(draftKey, sent, props = {}) {
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey,
    onSend: async (...args) => {
      sent.push(args);
      return { status: "accepted" };
    },
    onAbort() {},
    isStreaming: false,
    ...props,
  }));
  return ref;
}

/** Small, but with NUL bytes: never inlined as text, so it goes As file. */
function binaryFile(name) {
  return new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])], name, { type: "application/zip" });
}

/** Holds every PUT until the returned release runs. */
function holdUploads() {
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  return () => act(async () => { release(); });
}

/** The upload opened for `name` (its POST body), once it was. */
function opened(name) {
  return waitFor(() => {
    const request = requests.find((each) => each.method === "POST" && JSON.parse(each.body).name === name);
    assert.ok(request, `${name} was opened`);
    return JSON.parse(request.body);
  });
}

/** The PUT carrying `id`'s bytes, once it was sent. */
function putOf(id) {
  return waitFor(() => {
    const request = requests.find((each) => each.method === "PUT" && each.url.startsWith(`/api/uploads/${id}?`));
    assert.ok(request, "its bytes were sent");
    return request;
  });
}

const deleted = (id) => requests.some((each) => each.method === "DELETE" && each.url === `/api/uploads/${id}`);
const chipOf = (name) => screen.getByText(name).parentElement;
const pressEnter = () => act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); });

test("a .zip becomes a file chip, uploads on attach, and its id goes with the prompt", async () => {
  const sent = [];
  const ref = renderComposer("uploads-zip", sent);
  const zip = new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])], "data.zip", { type: "application/zip" });
  await act(async () => { ref.current.addFiles([zip]); });
  await waitFor(() => assert.ok(screen.getByText("data.zip"), "a file chip, not a refusal"));
  const send = await waitFor(() => {
    const button = screen.getByRole("button", { name: SEND });
    assert.equal(button.disabled, false, "Send waits for the upload");
    return button;
  });
  await act(async () => { send.click(); });

  const opened = requests.find((request) => request.method === "POST");
  const { id, name, size, host } = JSON.parse(opened.body);
  assert.match(id, UPLOAD_ID_RE);
  assert.deepEqual([name, size, host], ["data.zip", zip.size, "local"]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], ["", undefined, [id]], "no images, the upload's id");
});

test("an image over the inline budget goes As file with a notice, and Send waits for its upload", async () => {
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const ref = renderComposer("uploads-image", sent);
  const image = new File([new Uint8Array(MAX_TOTAL_ATTACHED_IMAGE_BYTES + 1)], "big.png", { type: "image/png" });
  await act(async () => { ref.current.addFiles([image]); });

  assert.match(screen.getByRole("status").textContent, AS_FILE_NOTICE);
  const toggle = screen.getByRole("button", { name: SWITCH_TO_INLINE });
  assert.equal(toggle.disabled, true, "too large to switch back to Inline");
  const opened = await waitFor(() => {
    const request = requests.find((each) => each.method === "POST");
    assert.ok(request);
    return JSON.parse(request.body);
  });
  assert.deepEqual([opened.name, opened.size], ["big.png", image.size]);
  await waitFor(() => assert.equal(screen.getByRole("button", { name: UPLOADING }).disabled, true));

  await act(async () => { release(); });
  await waitFor(() => assert.equal(screen.getByRole("button", { name: SEND }).disabled, false));
  await act(async () => { screen.getByRole("button", { name: SEND }).click(); });
  assert.deepEqual(sent[0][2], [opened.id]);
});

test("Enter refuses to send while an upload is in flight, and while one failed", async () => {
  const release = holdUploads();
  const sent = [];
  const ref = renderComposer("uploads-enter", sent);
  await act(async () => { ref.current.addFiles([binaryFile("data.zip")]); });
  await putOf((await opened("data.zip")).id);

  await pressEnter();
  assert.match(screen.getByRole("alert").textContent, WAITING);
  assert.equal(sent.length, 0, "no send while it uploads");

  // A full disk: waiting cannot fix it, so the chip fails instead of resuming by itself.
  failNextPut = { status: 507, code: "upload_write_failed" };
  await release();
  await waitFor(() => assert.match(chipOf("data.zip").textContent, UPLOAD_FAILED));
  await pressEnter();
  assert.match(screen.getByRole("alert").textContent, FAILED_BLOCK);
  assert.equal(sent.length, 0, "no send while one failed");
});

test("a queued steer or follow-up during a run waits for uploads too", async () => {
  const calls = [];
  const record = (name) => async () => { calls.push(name); return true; };
  holdUploads();
  const ref = renderComposer("uploads-queue", [], {
    isStreaming: true,
    onSteer: record("onSteer"),
    onFollowUp: record("onFollowUp"),
    onPromptWithStreamingBehavior: record("onPromptWithStreamingBehavior"),
  });
  await act(async () => { ref.current.addFiles([binaryFile("data.zip")]); });
  await putOf((await opened("data.zip")).id);

  await pressEnter();
  assert.match(screen.getByRole("alert").textContent, WAITING);
  assert.deepEqual(calls, [], "nothing queued while it uploads");
});

test("removing a chip aborts its upload in flight, or discards a finished one", async () => {
  const ref = renderComposer("uploads-remove", []);
  await act(async () => { ref.current.addFiles([binaryFile("done.zip")]); });
  const done = await opened("done.zip");
  await waitFor(() => assert.equal(screen.getByRole("button", { name: SEND }).disabled, false));

  const release = holdUploads();
  await act(async () => { ref.current.addFiles([binaryFile("busy.zip")]); });
  const busy = await opened("busy.zip");
  const put = await putOf(busy.id);
  await act(async () => { within(chipOf("busy.zip")).getByRole("button", { name: REMOVE_FILE }).click(); });
  assert.equal(put.signal.aborted, true, "its bytes stop");
  assert.ok(deleted(busy.id), "the host drops what it staged");
  assert.equal(screen.queryByText("busy.zip"), null);

  await act(async () => { within(chipOf("done.zip")).getByRole("button", { name: REMOVE_FILE }).click(); });
  assert.ok(deleted(done.id), "a finished upload is discarded on its host");
  assert.equal(screen.queryByText("done.zip"), null);
  await release();
});

test("Retry on a failed chip resumes the same upload, then the chip finishes", async () => {
  failNextPut = { status: 507, code: "upload_write_failed" };
  const sent = [];
  const ref = renderComposer("uploads-retry", sent);
  await act(async () => { ref.current.addFiles([binaryFile("data.zip")]); });
  const { id } = await opened("data.zip");
  const retry = await waitFor(() => within(chipOf("data.zip")).getByRole("button", { name: RETRY }));

  requests.length = 0;
  const release = holdUploads();
  await act(async () => { retry.click(); });
  assert.equal((await opened("data.zip")).id, id, "resumed under the same id");
  await waitFor(() => assert.ok(screen.getByRole("button", { name: UPLOADING })));
  await release();
  await waitFor(() => assert.equal(screen.getByRole("button", { name: SEND }).disabled, false));
  assert.equal(within(chipOf("data.zip")).queryByRole("button", { name: RETRY }), null);
  await act(async () => { screen.getByRole("button", { name: SEND }).click(); });
  assert.deepEqual(sent[0][2], [id]);
});

test("a reconnecting chip identifies a network failure instead of a generic upload failure", async () => {
  failNextPut = new TypeError("Failed to fetch");
  const ref = renderComposer("uploads-network-error", []);
  await act(async () => { ref.current.addFiles([binaryFile("network.zip")]); });
  await waitFor(() => assert.match(chipOf("network.zip").textContent, RECONNECTING));
  assert.match(chipOf("network.zip").title, /network error/i);
  assert.equal(within(chipOf("network.zip")).queryByRole("button", { name: RETRY }), null);
  await act(async () => { within(chipOf("network.zip")).getByRole("button", { name: REMOVE_FILE }).click(); });
});

test("an image switches Inline -> As file -> Inline, and switching back aborts its upload", async () => {
  const release = holdUploads();
  const ref = renderComposer("uploads-switch", []);
  await act(async () => { ref.current.addFiles([new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" })]); });
  const toFile = await waitFor(() => screen.getByRole("button", { name: SWITCH_TO_FILE }));

  await act(async () => { toFile.click(); });
  const { id } = await opened("dot.png");
  const put = await putOf(id);
  const toInline = screen.getByRole("button", { name: SWITCH_TO_INLINE });
  assert.equal(toInline.disabled, false, "small enough to go back Inline");

  await act(async () => { toInline.click(); });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: SWITCH_TO_FILE })));
  assert.equal(put.signal.aborted, true, "its bytes stop");
  assert.ok(deleted(id), "the host drops what it staged");
  assert.equal(screen.getByRole("button", { name: SEND }).disabled, false, "nothing left to wait for");
  await release();
});

test("an image sent As file shows that it is reconnecting, without hovering", async () => {
  const { ImageChip } = await import("./ChatInput-uploads.tsx");
  const upload = { id: "u", name: "dot.png", size: 8, hostId: "local", file: null, received: 4, status: "uploading", error: "This machine is offline", previewUrl: null };
  const props = { previewUrl: null, canSwitch: true, onSwitch() {}, onRemove() {} };
  const { rerender } = render(React.createElement(ImageChip, { ...props, upload }));
  assert.ok(screen.getByRole("img", { name: RECONNECTING }));
  rerender(React.createElement(ImageChip, { ...props, upload: { ...upload, error: null } }));
  assert.equal(screen.queryByRole("img", { name: RECONNECTING }), null, "gone once the host answers");
});

test(`only ${MAX_UPLOADS_PER_MESSAGE} files attach to one message`, async () => {
  const ref = renderComposer("uploads-count", []);
  const files = Array.from({ length: MAX_UPLOADS_PER_MESSAGE + 1 }, (_, index) => binaryFile(`f${index}.zip`));
  await act(async () => { ref.current.addFiles(files); });
  await waitFor(() => assert.match(screen.getByRole("alert").textContent, UPLOAD_LIMIT));
  assert.equal(screen.getAllByRole("button", { name: REMOVE_FILE }).length, MAX_UPLOADS_PER_MESSAGE);
  assert.equal(requests.filter((each) => each.method === "POST").length, MAX_UPLOADS_PER_MESSAGE);
});

test("a PDF goes As file even when its bytes decode as text; a JSON file stays inline", async () => {
  const ref = renderComposer("uploads-pdf", []);
  const pdf = new File(["%PDF-1.4 plain ascii body"], "doc.pdf", { type: "application/pdf" });
  const json = new File(['{"a":1}'], "data.json", { type: "application/json" });
  await act(async () => { ref.current.addFiles([pdf, json]); });
  await opened("doc.pdf");
  await waitFor(() => assert.ok(screen.getByText("data.json"), "the JSON chip"));
  assert.deepEqual(requests.filter((each) => each.method === "POST").map((each) => JSON.parse(each.body).name), ["doc.pdf"]);
});

test("a PDF filename with no MIME type goes As file instead of inline text", async () => {
  const ref = renderComposer("uploads-pdf-empty-mime", []);
  const pdf = new File(["%PDF-1.4 plain ascii body"], "report.PDF");
  const json = new File(['{"a":1}'], "data.json", { type: "application/json" });
  await act(async () => { ref.current.addFiles([pdf, json]); });
  await opened(pdf.name);
  await waitFor(() => assert.ok(screen.getByText("data.json"), "the JSON chip"));
  assert.deepEqual(requests.filter((each) => each.method === "POST").map((each) => JSON.parse(each.body).name), [pdf.name]);
});

test("a file over 2 GiB is refused, its sibling attaches", async () => {
  const ref = renderComposer("uploads-size", []);
  const huge = binaryFile("disk.iso");
  Object.defineProperty(huge, "size", { value: MAX_UPLOAD_BYTES + 1 });
  await act(async () => { ref.current.addFiles([huge, binaryFile("ok.zip")]); });
  await opened("ok.zip");
  assert.match(screen.getByRole("alert").textContent, TOO_LARGE);
  assert.equal(screen.queryByText("disk.iso"), null);
  assert.deepEqual(requests.filter((each) => each.method === "POST").map((each) => JSON.parse(each.body).name), ["ok.zip"]);
});

test("a draft keeps finished uploads only, and restores them as done chips", async () => {
  const key = "uploads-draft";
  const ref = renderComposer(key, []);
  await act(async () => { ref.current.addFiles([binaryFile("done.zip")]); });
  const done = await opened("done.zip");
  await waitFor(() => assert.equal(screen.getByRole("button", { name: SEND }).disabled, false));
  holdUploads();
  await act(async () => { ref.current.addFiles([binaryFile("busy.zip")]); });
  await putOf((await opened("busy.zip")).id);
  assert.deepEqual(getDraft(key)?.uploads, [{ id: done.id, name: "done.zip", size: done.size, hostId: "local" }], "the one in flight is not kept");

  cleanup();
  const sent = [];
  renderComposer(key, sent);
  assert.equal(screen.queryByText("busy.zip"), null);
  assert.equal(within(chipOf("done.zip")).queryByRole("button", { name: RETRY }), null, "done: nothing to retry");
  assert.equal(screen.queryByRole("progressbar"), null);
  await act(async () => { screen.getByRole("button", { name: SEND }).click(); });
  assert.deepEqual(sent[0][2], [done.id]);
});

test("a stall the worker reports shows Reconnecting… and resumes by itself under the same id", async () => {
  // The browser-link path: a fake shared worker, switched to `ws`, answers the upload with the worker's stall error.
  let port;
  globalThis.SharedWorker = class {
    constructor() {
      port = this.port = { posted: [], postMessage(message) { this.posted.push(message); }, onmessage: null, start() {} };
    }
  };
  openEventStream({ kind: "running" });
  delete globalThis.SharedWorker;
  port.onmessage({ data: { transport: "ws" } });
  try {
    const ref = renderComposer("uploads-stall", []);
    await act(async () => { ref.current.addFiles([binaryFile("data.zip")]); });
    const upload = await waitFor(() => {
      const message = port.posted.find((each) => each.op === "upload");
      assert.ok(message);
      return message;
    });
    await act(async () => { port.onmessage({ data: { up: upload.id, error: { status: 504, code: "upload_stalled", message: "The upload stalled" } } }); });
    await waitFor(() => assert.match(chipOf("data.zip").textContent, RECONNECTING));
    assert.equal(within(chipOf("data.zip")).queryByRole("button", { name: RETRY }), null, "no Retry while it waits");
    const again = await waitFor(() => {
      const starts = port.posted.filter((each) => each.op === "upload" && each.id === upload.id);
      assert.equal(starts.length, 2, "started again after the back-off");
      return starts[1];
    }, { timeout: 3_000 });
    await act(async () => { port.onmessage({ data: { up: again.id, received: 8, done: true } }); });
    await waitFor(() => assert.equal(screen.getByRole("button", { name: SEND }).disabled, false));
    assert.doesNotMatch(chipOf("data.zip").textContent, RECONNECTING);
  } finally {
    port.onmessage({ data: { transport: "sse" } });
  }
});
