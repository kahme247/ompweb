import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
const { act, cleanup, render, screen } = await import("@testing-library/react");

const { ChatInput } = await import("./ChatInput.tsx");
const { MAX_ATTACHED_IMAGE_BYTES } = await import("@/lib/image-attachments");

// jsdom implements neither object URLs nor the async Clipboard API, so both are
// modeled here. The object-URL stub records the composer/blob lifetime the way
// a real tab would leak it: every create needs a matching revoke.
const objectUrls = { created: [], revoked: [] };
let objectUrlCounter = 0;
const previousClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const previousMatchMedia = window.matchMedia;
const previousFileReader = globalThis.FileReader;
// setup-dom.mjs tears the DOM globals back down after this file's tests, so hold
// the window reference now rather than reading the global in the restore hook.
const domWindow = window;

// Node ships no global FileReader, and jsdom's one brand-checks against its own
// realm's Blob, so it refuses the Node Blob the clipboard stand-in produces.
// The composer only uses readAsDataURL -> `result` string, so model just that.
class TestFileReader {
  result = null;
  error = null;
  onload = null;
  onerror = null;

  readAsDataURL(blob) {
    setTimeout(() => {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
          this.onload?.();
        })
        .catch((error) => {
          this.error = error;
          this.onerror?.(error);
        });
    }, 0);
  }
}
globalThis.FileReader = TestFileReader;

// jsdom 29 ships no matchMedia, and the composer reads one at mount for the
// word-completion default (`(pointer: fine)`). Never match: desktop composer.
window.matchMedia = (media) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

URL.createObjectURL = function createObjectURL() {
  objectUrlCounter += 1;
  const url = `blob:omp-test/${objectUrlCounter}`;
  objectUrls.created.push(url);
  return url;
};
URL.revokeObjectURL = function revokeObjectURL(url) {
  objectUrls.revoked.push(url);
};

function setClipboard(clipboard) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: clipboard,
  });
}

/** A ClipboardItem stand-in: `types` is browser-reported, `getType` resolves a Blob. */
function clipboardImage(type, bytes) {
  return {
    types: [type],
    async getType(requested) {
      if (requested !== type) throw new Error(`unexpected clipboard type ${requested}`);
      return new Blob([new Uint8Array(bytes)], { type });
    },
  };
}

const PLUS_MENU = /More actions|chatInput\.plusMenu/;
const PASTE_ITEM = /Paste image|chatInput\.pasteImage/;
const FAILURE = /No image could be pasted|chatInput\.clipboardImageFailed/;
const SKIPPED = /skipped|chatInput\.attachmentImagesSkipped/;
// Any notice the composer raises about the batch it was handed.
const NOTICE = /No image could be pasted|skipped|chatInput\.(clipboardImageFailed|attachmentImagesSkipped)/;

function previews(container) {
  return [...container.querySelectorAll("img")].filter((img) => img.getAttribute("src")?.startsWith("blob:"));
}

async function pasteFromClipboard(
  container,
  settled = () => objectUrls.created.length > 0 || NOTICE.test(container.textContent ?? ""),
) {
  const trigger = screen.getByRole("button", { name: PLUS_MENU });
  await act(async () => { trigger.click(); });
  const item = screen.getByRole("menuitem", { name: PASTE_ITEM });
  await act(async () => { item.click(); });
  // The modeled FileReader settles on a macrotask followed by an async blob
  // read. The whole suite takes ~125s on the Windows runner, so a fixed sleep
  // is only long enough on an idle machine; poll for the batch to land instead.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    if (settled()) break;
  }
  return container;
}

function renderComposer() {
  return render(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      onFollowUp() {},
      isStreaming: false,
    }),
  ).container;
}

after(() => {
  if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia;
  else delete domWindow.matchMedia;
  if (previousFileReader) globalThis.FileReader = previousFileReader;
  else delete globalThis.FileReader;
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    setClipboard(undefined);
    if (previousClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", previousClipboard);
    } else {
      delete globalThis.navigator.clipboard;
    }
    // The object-URL stubs stay installed for the whole file: restoring them
    // after the first test would leave later tests with no createObjectURL at
    // all, and every read would die inside the reader callback.
    objectUrls.created.length = 0;
    objectUrls.revoked.length = 0;
  }
});

test("attaches a clipboard image through the shared composer attachment path", async () => {
  setClipboard({ read: async () => [clipboardImage("image/png", 8)] });
  const container = await pasteFromClipboard(renderComposer());

  assert.equal(previews(container).length, 1, "one preview for the pasted image");
  assert.equal(objectUrls.created.length, 1);
  assert.doesNotMatch(container.textContent, FAILURE);
  // The menu closes on tap, so the item is no longer offered.
  assert.equal(screen.queryByRole("menuitem", { name: PASTE_ITEM }), null);
});

test("keeps the pasted image inside the same byte cap as the file picker", async () => {
  setClipboard({ read: async () => [clipboardImage("image/png", MAX_ATTACHED_IMAGE_BYTES + 1)] });
  const container = await pasteFromClipboard(renderComposer());

  // Rejected before any preview URL exists, exactly like an oversized drop.
  assert.equal(previews(container).length, 0);
  assert.equal(objectUrls.created.length, 0);
  assert.match(container.textContent, SKIPPED);
});

test("reports a clean failure when the clipboard holds no image", async () => {
  setClipboard({ read: async () => [{ types: ["text/plain"], async getType() { return new Blob(["hi"]); } }] });
  const container = await pasteFromClipboard(renderComposer());

  assert.equal(previews(container).length, 0);
  assert.match(container.textContent, FAILURE);
});

test("hides the item where the browser cannot read images from the clipboard", async () => {
  // `navigator.clipboard` exists only in a secure context. On a plain-http LAN
  // session the item could only ever produce the failure banner, so the plus
  // menu hides it rather than offering a dead end.
  setClipboard(undefined);
  renderComposer();
  const trigger = screen.getByRole("button", { name: PLUS_MENU });
  await act(async () => { trigger.click(); });

  assert.equal(screen.queryByRole("menuitem", { name: PASTE_ITEM }), null);
  // Only this entry is hidden; attaching a file is unaffected.
  assert.ok(screen.getAllByRole("menuitem").length > 0, "the rest of the plus menu still renders");
});

test("reports a clean failure when the clipboard read is denied", async () => {
  // The item is offered, but Chrome's clipboard-read permission can still be
  // denied per origin; the rejection must not escape the tap.
  setClipboard({ read: async () => { throw new DOMException("Read permission denied.", "NotAllowedError"); } });
  const container = await pasteFromClipboard(renderComposer());

  assert.equal(previews(container).length, 0);
  assert.equal(objectUrls.created.length, 0);
  assert.match(container.textContent, FAILURE);
});

test("keeps one oversized clipboard image from displacing an in-range one", async () => {
  setClipboard({
    read: async () => [
      clipboardImage("image/png", MAX_ATTACHED_IMAGE_BYTES + 1),
      clipboardImage("image/png", 8),
    ],
  });
  const container = await pasteFromClipboard(renderComposer());

  assert.equal(previews(container).length, 1, "only the in-range image is attached");
  assert.equal(objectUrls.created.length, 1);
});

test("revokes pasted image previews on unmount", async () => {
  setClipboard({ read: async () => [clipboardImage("image/png", 8)] });
  const view = render(
    React.createElement(ChatInput, { async onSend() { return { status: "accepted" }; }, onAbort() {}, onFollowUp() {}, isStreaming: false }),
  );
  await pasteFromClipboard(view.container);
  assert.equal(objectUrls.created.length, 1);

  await act(async () => { view.unmount(); });

  assert.deepEqual(objectUrls.revoked, objectUrls.created);
});
