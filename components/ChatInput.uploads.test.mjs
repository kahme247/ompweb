import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react");

const { ChatInput } = await import("./ChatInput.tsx");
const { MAX_TOTAL_ATTACHED_IMAGE_BYTES } = await import("@/lib/image-attachments");
const { UPLOAD_ID_RE } = await import("@/lib/upload-limits");

// Composer uploads (docs/specs/2026-11-02-file-uploads-design.md U2). No shared worker in jsdom, so uploads take the
// HTTP routes, answered here: POST opens at 0, each PUT is acked through its end once `gate` resolves.
const previousFetch = globalThis.fetch;
const requests = [];
let gate = Promise.resolve();
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  requests.push({ url: String(url), method, body: init.body });
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url === "/api/uploads" && method === "POST") return json({ received: 0 });
  if (String(url).startsWith("/api/uploads/") && method === "PUT") {
    await gate;
    const offset = Number(new URL(String(url), "https://omp.test/").searchParams.get("offset"));
    return json({ received: offset + init.body.size, done: true });
  }
  return json({});
};

// jsdom has no object URLs and the composer reads matchMedia at mount.
URL.createObjectURL = () => "blob:omp-test/preview";
URL.revokeObjectURL = () => {};
const domWindow = window;
const previousMatchMedia = window.matchMedia;
window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

after(() => {
  globalThis.fetch = previousFetch;
  if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia;
  else delete domWindow.matchMedia;
});
afterEach(() => {
  cleanup();
  requests.length = 0;
  gate = Promise.resolve();
});

const SEND = /^(Send|chatInput\.send)$/;
const UPLOADING = /1 uploading|chatInput\.uploadsPending/;
const AS_FILE_NOTICE = /too large to send inline|chatInput\.imagesAsFile/;
const SWITCH_TO_INLINE = /Switch to Inline|chatInput\.imageSwitchToInline/;

function renderComposer(draftKey, sent) {
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
  }));
  return ref;
}

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
