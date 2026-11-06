import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ChatInput } = await import("./ChatInput.tsx");
const { clearDraft, getDraft, recoverDraft, setDraft } = await import("@/lib/draft-store");

const KEY = "queue-attachments";
// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Same stand-in as ChatInput.clipboard-image.test.mjs: jsdom's FileReader
// brand-checks against its own realm's Blob; the composer only needs
// readAsDataURL -> `result`.
const previousFileReader = globalThis.FileReader;
class TestFileReader {
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
}

const overrides = [];
function override(target, key, replacement) {
  overrides.push({ target, key, original: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
}

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.FileReader = TestFileReader;
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  try {
    cleanup();
  } finally {
    clearDraft(KEY);
    localStorage.clear();
    delete window.matchMedia;
    globalThis.FileReader = previousFileReader;
    while (overrides.length) {
      const { target, key, original } = overrides.pop();
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
  }
});

/** A composer with an image and a text file attached through the picker path. */
async function renderWithAttachments({ queued = true, queueCallbacks = true, ...props } = {}) {
  const calls = [];
  // Images are the last argument of every queue callback, which resolves
  // false when omp refused the message.
  const record = (name) => async (message, ...rest) => {
    calls.push({ name, message, images: rest.at(-1) });
    const ok = await queued;
    return name === "onSend" ? { status: ok ? "accepted" : "rejected" } : ok;
  };
  const ref = React.createRef();
  const inputProps = {
    ref,
    draftKey: KEY,
    isStreaming: true,
    onSend: record("onSend"),
    onAbort: record("onAbort"),
    onSteer: queueCallbacks ? record("onSteer") : undefined,
    onFollowUp: queueCallbacks ? record("onFollowUp") : undefined,
    ...props,
  };
  const view = render(React.createElement(ChatInput, inputProps));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => {
    const draft = getDraft(KEY);
    assert.equal(draft?.images.length, 1, "the image is attached");
    assert.equal(draft?.files.length, 1);
  });
  return {
    calls,
    ref,
    rerender: (changes) => view.rerender(React.createElement(ChatInput, { ...inputProps, ...changes })),
  };
}

async function renderRunningWithAttachments(options) {
  return (await renderWithAttachments(options)).calls;
}

function assertQueuedWithAttachments(call, text) {
  assert.ok(call.message.startsWith(text), "typed text leads the message");
  assert.match(call.message, /Attached file: notes\.txt\n```[^\n]*\nhello\n```/, "text file is folded in");
  assert.deepEqual(call.images?.map((image) => [image.data, image.mimeType]), [[PNG, "image/png"]]);
}

test("Enter during a run queues a follow-up with the attached image and text file, then clears them", async () => {
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  // Queueing is the default submit-during-run behavior: it is what survives a
  // `!!` shell command owning the session (see lib/rpc-manager.ts).
  assert.equal(calls[0].name, "onFollowUp", "the default submit-during-run behavior queues");
  assertQueuedWithAttachments(calls[0], "look at this");
  await waitFor(() => assert.equal(getDraft(KEY), null));
});

test("a stored Steer preference still steers Enter during a run", async () => {
  localStorage.setItem("omp-web:submit-during-run", "steer");
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "an explicit stored choice stays a steer");
  assertQueuedWithAttachments(calls[0], "look at this");
});

test("attachments alone turn Stop into Queue, which queues them as a follow-up", async () => {
  const calls = await renderRunningWithAttachments();
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onFollowUp");
  assertQueuedWithAttachments(calls[0], "Attached file:");
});

test("a stored Steer preference turns the primary button into Steer, which steers like Enter", async () => {
  localStorage.setItem("omp-web:submit-during-run", "steer");
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  assert.equal(Boolean(screen.queryByRole("button", { name: /^queue$/i })), false, "the button no longer claims to queue");
  const steer = screen.getByRole("button", { name: /^steer$/i });
  assert.equal(steer.title, "Interrupt the current run and inject this message now");
  fireEvent.click(steer);
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "touch devices without Enter can steer");
  assertQueuedWithAttachments(calls[0], "look at this");
});

test("a queued web slash command is expanded and keeps the attachments", async () => {
  const { expandWebSlashCommand } = await import("@/lib/web-slash-commands");
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "/goal ship it");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "onFollowUp", "a slash command is held like any follow-up; the server sends it as a prompt");
  assertQueuedWithAttachments(calls[0], expandWebSlashCommand("/goal ship it").prompt);
});

test("a queued message stays in the composer until the outbox has it, and stays whole when refused", async () => {
  let refuse;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }], "not cleared before it is stored");
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  assert.equal(calls.length, 1, "a second click while it is being stored sends nothing");
  await act(async () => { refuse(); });
  assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }], "a refusal leaves text and attachments in place");
  assert.equal(getDraft(KEY)?.files.length, 1);
});

test("a queued message is not cleared once stored if the composer changed meanwhile", async () => {
  let store;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { store = () => resolve(true); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed meanwhile" } });
  await act(async () => { store(); });
  assert.equal(screen.getByRole("textbox").value, "typed meanwhile");
});

test("an outbox commit after unmount cannot clear a remounted composer's new text or attachments", async () => {
  let store;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { store = () => resolve(true); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  cleanup();
  render(React.createElement(ChatInput, { draftKey: KEY, outbox: true, isStreaming: false, onAbort() {}, onSend: async () => ({ status: "accepted" }) }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "new draft after remount" } });
  await act(async () => { store(); });
  assert.equal(screen.getByRole("textbox").value, "new draft after remount");
  assert.equal(getDraft(KEY)?.value, "new draft after remount");
  assert.equal(getDraft(KEY)?.images.length, 1);
  assert.equal(getDraft(KEY)?.files.length, 1);
});

// A text-only outbox Send whose IndexedDB commit is still pending; `store()` completes it.
async function sendTextPendingStore(text) {
  let store;
  const onSend = () => new Promise((resolve) => { store = () => resolve({ status: "accepted" }); });
  const ref = React.createRef();
  const props = { ref, draftKey: KEY, outbox: true, isStreaming: false, onAbort() {}, onSend };
  const view = render(React.createElement(ChatInput, props));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => assert.ok(store, "the send reached the outbox"));
  return { props, ref, view, store: () => act(async () => { store(); }) };
}

test("an equal-text clear-and-retype while the outbox commit is pending is newer input and survives", async () => {
  const { store } = await sendTextPendingStore("same text");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
  await store();
  assert.equal(screen.getByRole("textbox").value, "same text");
  assert.equal(getDraft(KEY)?.value, "same text");
});

test("an equal-text clear-and-retype in a remounted composer survives the original commit", async () => {
  const { props, store } = await sendTextPendingStore("same text");
  cleanup();
  render(React.createElement(ChatInput, props));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
  await store();
  assert.equal(screen.getByRole("textbox").value, "same text");
  assert.equal(getDraft(KEY)?.value, "same text");
});
// A controlled textarea's DOM events flush synchronously (React restores controlled state at event end), so a DOM
// clear-and-retype always reaches the persist effect; only programmatic inputs (dictation, history, completions, the
// imperative handle) can be batched into an unflushed edit whose final value equals the sent one, and React then
// bails so the persist effect never writes the store. The edit recorded at input admission is what tells the pending
// commit its composer was touched. The sent message here is attachment-only, so its text is "".
async function sendAttachmentOnlyPendingStore() {
  let store;
  const ref = React.createRef();
  const props = {
    ref, draftKey: KEY, outbox: true, isStreaming: false, onAbort() {},
    onSend: () => new Promise((resolve) => { store = () => resolve({ status: "accepted" }); }),
  };
  render(React.createElement(ChatInput, props));
  await act(async () => { ref.current.addFiles([new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" })]); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
  await waitFor(() => assert.ok(store, "the send reached the outbox"));
  return { props, ref, store: () => act(async () => { store(); }) };
}
const programmaticEditEndingEqual = (ref) => act(async () => {
  ref.current.insertIfEmpty("tmp");
  ref.current.insertIfEmpty("");
});

test("a programmatic edit batched back to the sent text keeps the composer through the original commit", async () => {
  const { ref, store } = await sendAttachmentOnlyPendingStore();
  await programmaticEditEndingEqual(ref);
  await store();
  assert.equal(getDraft(KEY)?.images.length, 1, "touched composer is not consumed");
});

test("the same batched programmatic edit in a remounted composer keeps it through the original commit", async () => {
  const { props, store } = await sendAttachmentOnlyPendingStore();
  cleanup();
  const ref = React.createRef();
  render(React.createElement(ChatInput, { ...props, ref }));
  await programmaticEditEndingEqual(ref);
  await store();
  assert.equal(getDraft(KEY)?.images.length, 1, "touched composer is not consumed");
});


// What useAgentSession does for a confirmed native id change (Edit): free the source slot, write the (merged) target
// draft, then the live composer adopts the new key through `draftIdentityMove` without remounting.
async function moveIdentity(view, props, targetKey, destination) {
  const sourceDraft = getDraft(KEY);
  clearDraft(KEY);
  setDraft(targetKey, destination ? { ...sourceDraft, value: `${destination.value}\n\n${sourceDraft.value}` } : sourceDraft);
  await act(async () => {
    view.rerender(React.createElement(ChatInput, { ...props, draftKey: targetKey, draftIdentityMove: { from: KEY, to: targetKey, sourceDraft } }));
  });
}

test("a commit that lands after a confirmed identity move consumes the unchanged moved draft", async (t) => {
  const targetKey = `${KEY}:moved`;
  t.after(() => clearDraft(targetKey));
  const { props, view, store } = await sendTextPendingStore("same text");
  await moveIdentity(view, props, targetKey);
  assert.equal(screen.getByRole("textbox").value, "same text");
  await store();
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft(targetKey), null);
});

test("a commit after an identity move that merged an existing target draft leaves the merged draft", async (t) => {
  const targetKey = `${KEY}:merged`;
  t.after(() => clearDraft(targetKey));
  setDraft(targetKey, { value: "older target text", images: [], files: [] });
  const { props, view, store } = await sendTextPendingStore("same text");
  await moveIdentity(view, props, targetKey, getDraft(targetKey));
  const merged = screen.getByRole("textbox").value;
  assert.match(merged, /older target text/);
  await store();
  assert.equal(screen.getByRole("textbox").value, merged);
  assert.equal(getDraft(targetKey)?.value, merged);
});

test("precommit typing after an identity handoff never recreates the old key or evicts an unrelated draft at capacity", async (t) => {
  const targetKey = `${KEY}:capacity-target`;
  const otherKeys = Array.from({ length: 49 }, (_, index) => `${KEY}:capacity-other-${index}`);
  t.after(() => { for (const key of [targetKey, ...otherKeys]) clearDraft(key); });
  setDraft(otherKeys[0], { value: "oldest unrelated draft", images: [], files: [] });
  const { props, ref, view, store } = await sendTextPendingStore("same text");
  for (const key of otherKeys.slice(1)) setDraft(key, { value: key, images: [], files: [] });
  const sourceDraft = getDraft(KEY);
  act(() => {
    clearDraft(KEY);
    setDraft(targetKey, sourceDraft);
    ref.current.retargetPendingRecovery(KEY, targetKey);
  });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "newer input" } });
  assert.equal(getDraft(KEY), null, "the obsolete display key is not reinserted");
  assert.equal(getDraft(otherKeys[0])?.value, "oldest unrelated draft", "the capacity-neutral move stays capacity-neutral");
  await store();
  view.rerender(React.createElement(ChatInput, {
    ...props, draftKey: targetKey, draftIdentityMove: { from: KEY, to: targetKey, sourceDraft },
  }));
  assert.equal(screen.getByRole("textbox").value, "newer input");
  assert.equal(getDraft(targetKey)?.value, "newer input");
  for (const key of otherKeys) assert.ok(getDraft(key), `unrelated draft ${key} remains`);
});

for (const image of [false, true]) {
  test(`a newly admitted ${image ? "image" : "text file"} read survives the older send's ACK before the read completes`, async (t) => {
    const { ref, store } = await sendTextPendingStore("same text");
    let release;
    const content = image ? Uint8Array.from(Buffer.from(PNG, "base64")).buffer : "new file";
    const file = new File([image ? Buffer.from(PNG, "base64") : content], image ? "new.png" : "new.txt", {
      type: image ? "image/png" : "text/plain",
    });
    override(file, image ? "arrayBuffer" : "text", () => new Promise((resolve) => { release = resolve; }));
    t.after(() => release?.(content));
    act(() => { ref.current.addFiles([file]); });
    assert.equal(typeof release, "function", "the file was accepted and its read started");
    await store();
    await act(async () => { release(content); });
    await waitFor(() => assert.equal(image ? getDraft(KEY)?.images.length : getDraft(KEY)?.files.length, 1));
    assert.equal(screen.getByRole("textbox").value, "same text", "the newer attachment intent keeps the composer");
  });
}

for (const variant of ["unchanged", "newer", "handoff-newer", "merged"]) {
  test(`an earlier mount's commit after synchronous move handoff but before React retarget ${variant === "unchanged" ? "consumes the moved draft" : `preserves the ${variant} draft`}`, async (t) => {
    const targetKey = `${KEY}:handoff-${variant}`;
    t.after(() => clearDraft(targetKey));
    const { props, store } = await sendTextPendingStore("same text");
    cleanup();
    const ref = React.createRef();
    const view = render(React.createElement(ChatInput, { ...props, ref }));
    if (variant === "newer") {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
    }
    const sourceDraft = getDraft(KEY);
    const transferred = variant === "merged" ? { ...sourceDraft, value: "older target\n\nsame text" } : sourceDraft;
    // The hook completes the store transfer, then ChatWindow synchronously hands off the live ref. The prop commit
    // comes later: the ACK belongs to the original mount and can settle in this gap.
    act(() => {
      clearDraft(KEY);
      setDraft(targetKey, transferred);
      ref.current.retargetPendingRecovery(KEY, targetKey);
    });
    if (variant === "handoff-newer") {
      // The ref already names the moved identity, but the textarea and draftKey prop still name the old key.
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
    }
    await store();
    assert.equal(getDraft(targetKey)?.value ?? "", variant === "unchanged" ? "" : transferred.value);
    view.rerender(React.createElement(ChatInput, {
      ...props, ref, draftKey: targetKey, draftIdentityMove: { from: KEY, to: targetKey, sourceDraft },
    }));
    assert.equal(screen.getByRole("textbox").value, variant === "unchanged" ? "" : transferred.value);
    assert.equal(getDraft(targetKey)?.value ?? "", variant === "unchanged" ? "" : transferred.value);
  });
}

// The commit callback belongs to the first mount; the move is handed to the composer remounted on the same session.
test("a commit owned by an earlier mount consumes the unchanged draft moved under the remounted composer", async (t) => {
  const targetKey = `${KEY}:remount-moved`;
  t.after(() => clearDraft(targetKey));
  const { props, store } = await sendTextPendingStore("same text");
  cleanup();
  const view = render(React.createElement(ChatInput, props));
  await moveIdentity(view, props, targetKey);
  assert.equal(screen.getByRole("textbox").value, "same text");
  await store();
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft(targetKey), null);
});

test("input typed after the remount and move survives a commit owned by the earlier mount", async (t) => {
  const targetKey = `${KEY}:remount-moved-edited`;
  t.after(() => clearDraft(targetKey));
  const { props, store } = await sendTextPendingStore("same text");
  cleanup();
  const view = render(React.createElement(ChatInput, props));
  await moveIdentity(view, props, targetKey);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
  await store();
  assert.equal(screen.getByRole("textbox").value, "same text");
  assert.equal(getDraft(targetKey)?.value, "same text");
});

test("input after an identity move, even equal text, survives the old key's commit", async (t) => {
  const targetKey = `${KEY}:moved-edited`;
  t.after(() => clearDraft(targetKey));
  const { props, view, store } = await sendTextPendingStore("same text");
  await moveIdentity(view, props, targetKey);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
  await store();
  assert.equal(screen.getByRole("textbox").value, "same text");
  assert.equal(getDraft(targetKey)?.value, "same text");
});

test("input admitted before an identity move, even equal text, survives the old key's commit", async (t) => {
  const targetKey = `${KEY}:edited-moved`;
  t.after(() => clearDraft(targetKey));
  const { props, view, store } = await sendTextPendingStore("same text");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
  await moveIdentity(view, props, targetKey);
  await store();
  assert.equal(screen.getByRole("textbox").value, "same text");
  assert.equal(getDraft(targetKey)?.value, "same text");
});

test("an untouched remounted draft, and one only navigated away and back, is consumed by its commit", async () => {
  const { props, store } = await sendTextPendingStore("same text");
  cleanup();
  const view = render(React.createElement(ChatInput, props));
  assert.equal(screen.getByRole("textbox").value, "same text", "hydrated, not typed");
  view.rerender(React.createElement(ChatInput, { ...props, draftKey: `${KEY}:elsewhere` }));
  view.rerender(React.createElement(ChatInput, props));
  assert.equal(screen.getByRole("textbox").value, "same text");
  await store();
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft(KEY), null);
});

for (const stored of [true, false]) {
  test(`an idle Send through the outbox clears only once ${stored ? "stored" : "refused: never"}`, async () => {
    let answer;
    const user = userEvent.setup();
    const calls = await renderRunningWithAttachments({ isStreaming: false, outbox: true, queued: new Promise((resolve) => { answer = resolve; }) });
    await user.type(screen.getByRole("textbox"), "look at this");
    await user.keyboard("{Enter}");
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].name, "onSend");
    assert.equal(getDraft(KEY)?.images.length, 1, "kept until the outbox has it");
    await act(async () => { answer(stored); });
    if (stored) await waitFor(() => assert.equal(getDraft(KEY), null));
    else {
      assert.equal(screen.getByRole("textbox").value, "look at this");
      assert.equal(getDraft(KEY)?.images.length, 1);
    }
  });
}

for (const { label, fill, oversized } of [
  { label: "sendable composed request", fill: "x", oversized: false },
  { label: "oversized composed request", fill: '"', oversized: true },
]) {
  test(`merged text drafts past picker count and byte budgets survive persistence and remount (${label})`, async () => {
    const {
      MAX_ATTACHED_TEXT_FILES, MAX_TOTAL_ATTACHED_TEXT_BYTES, selectTextAttachments,
    } = await import("@/lib/chat-attachments");
    const count = Math.floor(MAX_ATTACHED_TEXT_FILES / 2) + 1;
    const fileBytes = Math.floor(MAX_TOTAL_ATTACHED_TEXT_BYTES * 0.75 / count);
    const makeFiles = (origin) => Array.from({ length: count }, (_, index) => {
      const name = `${origin}-${index}.txt`;
      const content = `${name}\n${fill.repeat(fileBytes - name.length - 1)}`;
      return { name, mimeType: "text/plain", content, size: Buffer.byteLength(content) };
    });
    const sourceFiles = makeFiles("source");
    const targetFiles = makeFiles("target");
    for (const files of [sourceFiles, targetFiles]) {
      assert.deepEqual(selectTextAttachments(files, { usedBytes: 0, usedSlots: 0 }).accepted, files,
        "each pre-relocation draft fits the unchanged picker limits");
    }
    // Seed the source + existing-target merge supplied by Edit relocation;
    // exercise the real composer hydration and persistence, not the hook here.
    const files = [...sourceFiles, ...targetFiles];
    assert.ok(files.length > MAX_ATTACHED_TEXT_FILES);
    assert.ok(files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHED_TEXT_BYTES);
    const images = [{ data: PNG, mimeType: "image/png" }, { data: PNG, mimeType: "image/png" }];
    const initialValue = "recovered edit\n\npre-existing target";
    setDraft(KEY, { value: initialValue, images, files });
    const calls = [];
    const mount = () => render(React.createElement(ChatInput, {
      draftKey: KEY, isStreaming: false, onAbort() {},
      onSend: async (message, sentImages) => {
        calls.push({ message, images: sentImages });
        return { status: "accepted" };
      },
    }));
    const assertRecovered = (value) => {
      assert.deepEqual(getDraft(KEY), { value, images, files }, "every file retains its exact contents in the persisted draft");
      assert.equal(screen.getByRole("textbox").value, value);
      for (const file of files) assert.equal(screen.getByTitle(file.name).textContent, file.name);
      assert.equal(document.querySelectorAll("img").length, images.length);
    };
    let view = mount();
    assertRecovered(initialValue);
    const newerValue = `${initialValue}\nnewer typing`;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: newerValue } });
    assertRecovered(newerValue);
    view.unmount();
    view = mount();
    assertRecovered(newerValue);

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    if (oversized) {
      // JSON escaping makes these individually picker-valid files exceed the
      // outgoing request budget. The guard must reject without clearing them.
      assert.match((await screen.findByRole("alert")).textContent, /too large to send/i);
      assert.deepEqual(calls, []);
      assertRecovered(newerValue);
      view.unmount();
      mount();
      assertRecovered(newerValue);
    } else {
      await waitFor(() => assert.equal(calls.length, 1));
      const expectedMessage = [newerValue, ...files.map((file) => `Attached file: ${file.name}\n\`\`\`text\n${file.content}\n\`\`\``)].join("\n\n");
      assert.equal(calls[0].message, expectedMessage, "sending includes every source and target file, despite the picker caps");
      assert.deepEqual(calls[0].images.map(({ data, mimeType }) => ({ data, mimeType })), images);
      await waitFor(() => assert.equal(getDraft(KEY), null));
    }
  });
}

test("malformed recovered text files are filtered without discarding valid neighboring files", () => {
  const valid = { name: "valid.txt", mimeType: "text/plain", content: "keep exactly", size: 12 };
  setDraft(KEY, {
    value: "recovered", images: [],
    files: [null, {}, { ...valid, content: null }, { ...valid, size: -1 }, { ...valid, size: Infinity }, valid],
  });
  render(React.createElement(ChatInput, {
    draftKey: KEY, isStreaming: false, onAbort() {}, onSend: async () => ({ status: "accepted" }),
  }));
  assert.deepEqual(getDraft(KEY)?.files, [valid]);
  assert.equal(screen.getByTitle(valid.name).textContent, valid.name);
});

test("recovered images past the attachment cap all stay in the composer", async () => {
  const { MAX_ATTACHED_IMAGES } = await import("@/lib/image-attachments");
  const { recoverDraft } = await import("@/lib/draft-store");
  await renderRunningWithAttachments();
  const recovered = Array.from({ length: MAX_ATTACHED_IMAGES }, () => ({ data: PNG, mimeType: "image/png" }));
  await act(async () => { recoverDraft(KEY, { text: "", images: recovered }); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, MAX_ATTACHED_IMAGES + 1));
  assert.equal(document.querySelectorAll("img").length >= MAX_ATTACHED_IMAGES + 1, true, "every image has a preview to remove");
});

// Keep the real useDictation hook: only browser capture and the STT job API
// are controlled. Polls expose status; only the owner's claim returns text
// and the send intent, matching the server job boundary.
function installPendingDictation({ holdUpload = false, holdClaim = false, after = "send" } = {}) {
  const uploads = [];
  const polls = [];
  const claims = [];
  let done = false;
  const recorders = [];
  let trackStops = 0;
  let releaseUpload;
  const uploadReady = holdUpload ? new Promise((resolve) => { releaseUpload = resolve; }) : Promise.resolve();
  let releaseClaim;
  const claimReady = holdClaim ? new Promise((resolve) => { releaseClaim = resolve; }) : Promise.resolve();
  class TestMediaRecorder {
    state = "inactive";
    mimeType = "audio/webm";
    constructor() { recorders.push(this); }
    start() { this.state = "recording"; }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    requestData() {
      this.ondataavailable?.({ data: new Blob(["spoken audio"], { type: this.mimeType }) });
    }
    stop() {
      this.state = "inactive";
      this.requestData();
      this.onstop?.();
    }
  }
  override(navigator, "mediaDevices", {
    getUserMedia: async () => ({ getTracks: () => [{ stop() { trackStops += 1; } }] }),
  });
  override(window, "MediaRecorder", TestMediaRecorder);
  override(globalThis, "MediaRecorder", TestMediaRecorder);
  override(globalThis, "Audio", class {
    paused = true;
    currentTime = 0;
    duration = 1;
    constructor(src) { this.src = src; }
    pause() { this.paused = true; this.onpause?.(); }
    async play() { this.paused = false; this.onplay?.(); }
  });
  // jsdom has no canvas renderer; waveform drawing is outside this regression.
  override(window.HTMLCanvasElement.prototype, "getContext", () => null);
  const response = (body, status = 200) => ({ ok: true, status, json: async () => body });
  override(globalThis, "fetch", async (url, init) => {
    const target = new URL(url, window.location.href);
    const method = init?.method ?? "GET";
    if (target.pathname === "/api/stt" && method === "GET" && target.searchParams.has("scope")) {
      return response({ jobs: [] });
    }
    if (target.pathname === "/api/stt" && method === "POST") {
      uploads.push({
        after: init.body.get("after"),
        owner: init.body.get("owner"),
        scope: init.body.get("scope"),
        file: init.body.get("file"),
      });
      await uploadReady;
      return response({ jobId: "edit-pending-job" }, 202);
    }
    if (target.pathname === "/api/stt/edit-pending-job" && method === "GET") {
      const status = done ? "done" : "pending";
      polls.push(status);
      return response({ status });
    }
    if (target.pathname === "/api/stt/edit-pending-job" && method === "DELETE" && target.searchParams.has("claim")) {
      const claim = { token: target.searchParams.get("claim"), owner: target.searchParams.get("owner") };
      claims.push(claim);
      await claimReady;
      return response({
        status: "done",
        text: "transcribed words",
        after: claim.owner === uploads[0]?.owner ? after : undefined,
      });
    }
    throw new Error(`Unexpected dictation request: ${method} ${url}`);
  });
  return {
    uploads, polls, claims, recorders,
    get trackStops() { return trackStops; },
    releaseUpload: () => releaseUpload?.(),
    releaseClaim: () => releaseClaim?.(),
    complete: () => { done = true; },
  };
}

for (const isStreaming of [false, true]) {
  for (const edit of ["unchanged", "newer text", "equal-text retype"]) {
    test(`automatic dictated ${isStreaming ? "queue" : "send"} ${edit === "unchanged" ? "clears after durable acceptance" : `preserves ${edit} through delayed acceptance`}`, async () => {
      const dictation = installPendingDictation({ after: isStreaming ? "followup" : "send" });
      const user = userEvent.setup();
      let accept;
      const stored = new Promise((resolve) => { accept = resolve; });
      const submissions = [];
      const submit = (name) => async (message, images) => {
        submissions.push({ name, message, images });
        await stored;
        return name === "onSend" ? { status: "accepted" } : true;
      };
      await renderWithAttachments({
        outbox: true,
        isStreaming,
        queueCallbacks: isStreaming,
        onSend: submit("onSend"),
        ...(isStreaming ? { onFollowUp: submit("onFollowUp") } : {}),
      });
      await user.type(screen.getByRole("textbox"), "draft prefix");
      await user.click(screen.getByRole("button", { name: "Start dictation" }));
      await user.click(isStreaming
        ? screen.getByRole("button", { name: /^queue$/i })
        : await screen.findByTitle("Transcribe and send"));
      await waitFor(() => assert.equal(dictation.uploads.length, 1));
      dictation.complete();
      await waitFor(() => assert.equal(submissions.length, 1), { timeout: 3000 });
      assert.equal(submissions[0].name, isStreaming ? "onFollowUp" : "onSend");
      assertQueuedWithAttachments(submissions[0], "draft prefix transcribed words");
      const textbox = screen.getByRole("textbox");
      assert.equal(textbox.value, "draft prefix transcribed words", "the draft remains until storage accepts it");
      assert.equal(getDraft(KEY)?.images.length, 1);
      assert.equal(getDraft(KEY)?.files.length, 1);
      if (edit !== "unchanged") {
        fireEvent.change(textbox, { target: { value: "" } });
        fireEvent.change(textbox, { target: { value: edit === "newer text" ? "typed after dictation" : "draft prefix transcribed words" } });
      }
      const beforeAcceptance = getDraft(KEY);
      await act(async () => { accept(); await stored; });
      if (edit === "unchanged") {
        assert.equal(textbox.value, "", "durably stored dictation must not remain available to submit again");
        assert.equal(getDraft(KEY), null, "the sent draft and its attachments are consumed");
        assert.equal(screen.queryByRole("button", { name: /remove image/i }), null);
        assert.equal(screen.queryByTitle("notes.txt"), null);
      } else {
        assert.equal(textbox.value, beforeAcceptance.value);
        assert.deepEqual(getDraft(KEY), beforeAcceptance, "the newer draft retains its text and both attachments");
      }
      assert.equal(submissions.length, 1, "storage completion never resubmits");
    });
  }
}

for (const { label, queueCallbacks } of [
  { label: "idle composer", queueCallbacks: false },
  { label: "queue callbacks available", queueCallbacks: true },
]) {
  test(`an after:send transcript finishing during Edit stays in the draft until explicit send (${label})`, async () => {
    const dictation = installPendingDictation();
    const user = userEvent.setup();
    const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks });
    await user.type(screen.getByRole("textbox"), "keep this draft");
    const beforeTranscript = getDraft(KEY);

    await user.click(screen.getByRole("button", { name: "Start dictation" }));
    await user.click(await screen.findByTitle("Transcribe and send"));
    await waitFor(() => assert.equal(dictation.uploads.length, 1));
    const [upload] = dictation.uploads;
    assert.equal(upload.after, "send", "the real hook uploads the chosen completion action");
    assert.equal(upload.scope, KEY);
    assert.ok(upload.owner);
    assert.equal(upload.file.type, "audio/webm");
    assert.ok(upload.file.size > 0, "audio crosses the recorder/upload boundary");
    await waitFor(() => assert.equal(dictation.polls[0], "pending"), { timeout: 3000 });

    // Edit is not a model run: leave isStreaming false while the job completes.
    rerender({ submissionBlocked: true });
    dictation.complete();
    const finalText = "keep this draft transcribed words";
    const expectedDraft = { ...beforeTranscript, value: finalText };
    await waitFor(() => {
      assert.equal(screen.getByRole("textbox").value, finalText);
      assert.deepEqual(getDraft(KEY), expectedDraft, "text, image and text-file attachments survive");
    }, { timeout: 3000 });
    assert.equal(dictation.claims.length, 1, "delivery comes through the real hook's claim request");
    assert.ok(dictation.claims[0].token);
    assert.equal(dictation.claims[0].owner, upload.owner);
    assert.deepEqual(calls, [], "neither a prompt nor any queue callback may run while Edit is pending");
    assert.equal(screen.getByRole("button", { name: /^send$/i }).disabled, true);

    if (!queueCallbacks) {
      await user.click(screen.getByRole("textbox"));
      await user.keyboard("{Enter}");
      assert.deepEqual(calls, [], "keyboard submit also respects the pending Edit");
      assert.equal(screen.getByRole("textbox").value, finalText);
      assert.deepEqual(getDraft(KEY), expectedDraft);
    }

    rerender({ submissionBlocked: false });
    assert.deepEqual(calls, [], "unblocking must not replay the saved automatic send choice");
    assert.equal(screen.getByRole("button", { name: /^send$/i }).disabled, false);
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].name, "onSend");
    assertQueuedWithAttachments(calls[0], finalText);
    await waitFor(() => assert.equal(getDraft(KEY), null));
    assert.equal(screen.getByRole("textbox").value, "");
  });
}

test("an image-only send refused by another tab's Edit returns its attachment", async () => {
  const ref = React.createRef();
  const calls = [];
  render(React.createElement(ChatInput, {
    ref, draftKey: KEY, isStreaming: false, onAbort() {},
    onSend: async (message, images) => { calls.push({ message, images }); return { status: "rejected" }; },
  }));
  await act(async () => { ref.current.addFiles([new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" })]); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  await userEvent.setup().click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].message, "");
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(document.querySelectorAll("img").length, 1, "the restored image is visible, not merely stored");
});

test("a refused ordinary send restores text, file contents and images ahead of newer typing", async () => {
  let refuse;
  const user = userEvent.setup();
  const { calls } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  await user.type(screen.getByRole("textbox"), "original question");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  await user.type(screen.getByRole("textbox"), "typed meanwhile");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY).value, `${calls[0].message}\n\ntyped meanwhile`);
  assert.equal(screen.getByRole("textbox").value, getDraft(KEY).value);
  assertQueuedWithAttachments(calls[0], "original question");
});

test("a refused ordinary send recovers only into its originating session draft", async (t) => {
  const otherKey = "ordinary-send-other-session";
  t.after(() => clearDraft(otherKey));
  let refuse;
  const user = userEvent.setup();
  const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  await user.type(screen.getByRole("textbox"), "original session");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  rerender({ draftKey: otherKey });
  await user.type(screen.getByRole("textbox"), "other conversation");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY).value, calls[0].message);
  assert.equal(screen.getByRole("textbox").value, "other conversation");
  assert.equal(getDraft(otherKey).value, "other conversation");
  assert.deepEqual(getDraft(otherKey).images, []);
});

test("a refused first send follows its promoted conversation rather than the old new-chat draft", async (t) => {
  const promotedKey = "promoted-first-send";
  t.after(() => clearDraft(promotedKey));
  let refuse;
  const submitted = [];
  const { rerender } = await renderWithAttachments({
    isStreaming: false, queueCallbacks: false,
    onSend: async (message) => { submitted.push(message); return new Promise((resolve) => { refuse = () => resolve({ status: "rejected", recoveryKey: promotedKey }); }); },
  });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "first question");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(submitted.length, 1));
  rerender({ draftKey: promotedKey });
  await act(async () => { refuse(); });
  await waitFor(() => assert.equal(getDraft(promotedKey)?.value, submitted[0]));
  assert.deepEqual(getDraft(promotedKey).images, [{ data: PNG, mimeType: "image/png" }]);
  assert.equal(screen.getByRole("textbox").value, submitted[0]);
  assert.equal(getDraft(KEY), null, "the original new-chat draft must not resurrect this payload later");
});

test("a superseded send result cannot restore a prompt that was already processed", async () => {
  let supersede;
  const submitted = [];
  await renderWithAttachments({
    isStreaming: false, queueCallbacks: false,
    onSend: async (message) => { submitted.push(message); return new Promise((resolve) => { supersede = () => resolve({ status: "superseded" }); }); },
  });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "already processed");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(submitted.length, 1));
  await user.type(screen.getByRole("textbox"), "next draft");
  await act(async () => { supersede(); });
  assert.equal(screen.getByRole("textbox").value, "next draft");
  assert.equal(getDraft(KEY).value, "next draft");
  assert.deepEqual(getDraft(KEY).images, []);
});

for (const hops of [1, 2]) {
  test(`a held successful queue Edit recovers once into its confirmed owner after ${hops} move(s)`, async (t) => {
    const targetKeys = Array.from({ length: hops }, (_, index) => `${KEY}:queue-edit-target-${index}`);
    t.after(() => targetKeys.forEach(clearDraft));
    const nativeQueue = ["removed question"];
    const removedImages = [{ data: PNG, mimeType: "image/png" }];
    const removals = [];
    let releaseResponse;
    const response = new Promise((resolve) => { releaseResponse = () => resolve(removedImages); });
    const sent = [];
    const { ref, rerender } = await renderWithAttachments({
      queuedMessages: { followUp: [...nativeQueue], steering: [] },
      onRemoveQueuedMessage: (text, queue) => {
        removals.push({ text, queue });
        assert.equal(nativeQueue.shift(), text, "native removal succeeds before its HTTP response arrives");
        return response;
      },
      onSend: async (message, images) => {
        sent.push({ message, images });
        return { status: "accepted" };
      },
    });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "source draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    assert.deepEqual(nativeQueue, []);
    assert.deepEqual(removals, [{ text: "removed question", queue: "followUp" }]);
    // The queue is already empty and the turn idle, so history Edit is legal.
    let currentKey = KEY;
    for (const targetKey of targetKeys) {
      const sourceDraft = getDraft(currentKey);
      const movedDraft = currentKey === KEY ? { ...sourceDraft, value: `${sourceDraft.value}\n\nolder target draft` } : sourceDraft;
      clearDraft(currentKey);
      setDraft(targetKey, movedDraft);
      ref.current.retargetPendingRecovery(currentKey, targetKey);
      rerender({
        isStreaming: false,
        queuedMessages: { followUp: [], steering: [] },
        draftKey: targetKey,
        draftIdentityMove: { from: currentKey, to: targetKey, sourceDraft },
      });
      currentKey = targetKey;
    }
    assert.equal(screen.getByRole("textbox"), textbox, "Edit does not remount the composer");
    fireEvent.change(textbox, { target: { value: `${textbox.value}\nnewer target typing` } });
    await act(async () => {
      ref.current.addFiles([
        new File([Buffer.from(PNG, "base64")], "newer.png", { type: "image/png" }),
        new File(["newer file"], "newer.txt", { type: "text/plain" }),
      ]);
    });
    await waitFor(() => assert.equal(getDraft(currentKey)?.images.length, 2));
    const beforeResponse = getDraft(currentKey);
    const expected = {
      ...beforeResponse,
      value: `removed question\n\n${beforeResponse.value}`,
      images: [...removedImages, ...beforeResponse.images],
    };
    await act(async () => { releaseResponse(); await response; });
    await waitFor(() => assert.deepEqual(getDraft(currentKey), expected));
    assert.equal(textbox.value, expected.value);
    assert.equal(screen.getAllByRole("button", { name: /remove image/i }).length, 3);
    assert.equal(sessionStorage.getItem(`omp-draft-${currentKey}`), expected.value);
    for (const abandonedKey of [KEY, ...targetKeys.slice(0, -1)]) {
      assert.equal(getDraft(abandonedKey), null, "recovery must not resurrect an abandoned owner");
    }
    assert.deepEqual(nativeQueue, [], "recovery does not requeue the removed message");
    assert.equal(removals.length, 1, "native removal is never retried");
    assert.deepEqual(sent, [], "recovery does not implicitly submit");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(sent.length, 1));
    assert.ok(sent[0].message.startsWith(expected.value));
    assert.match(sent[0].message, /Attached file: notes\.txt/);
    assert.match(sent[0].message, /Attached file: newer\.txt/);
    assert.deepEqual(sent[0].images.map(({ data, mimeType }) => ({ data, mimeType })), expected.images);
    assert.equal(getDraft(currentKey), null);
  });
}

for (const hops of [1, 2]) {
  test(`a queue Edit response before the move commit recovers only into its confirmed owner after ${hops} move(s)`, async (t) => {
    const targetKeys = Array.from({ length: hops }, (_, index) => `${KEY}:pre-commit-target-${index}`);
    t.after(() => targetKeys.forEach(clearDraft));
    const removedImages = [{ data: PNG, mimeType: "image/png" }];
    const nativeQueue = ["removed question"];
    let releaseResponse;
    const response = new Promise((resolve) => { releaseResponse = () => resolve(removedImages); });
    const sent = [];
    let removals = 0;
    const { ref, rerender } = await renderWithAttachments({
      queuedMessages: { followUp: [...nativeQueue], steering: [] },
      onRemoveQueuedMessage: (text, queue) => {
        assert.equal(queue, "followUp");
        assert.equal(nativeQueue.shift(), text);
        removals += 1;
        return response;
      },
      onSend: async (message, images) => {
        sent.push({ message, images });
        return { status: "accepted" };
      },
    });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "source draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    assert.deepEqual(nativeQueue, []);
    let currentKey = KEY;
    let expected;
    for (const [index, targetKey] of targetKeys.entries()) {
      const sourceDraft = getDraft(currentKey);
      const movedDraft = index === 0 ? {
        value: `${sourceDraft.value}\n\nolder target draft`,
        images: [...sourceDraft.images, { data: PNG, mimeType: "image/png" }],
        files: [...sourceDraft.files, { name: "older.txt", content: "older file", mimeType: "text/plain", size: 10 }],
      } : sourceDraft;
      const finalMove = index === targetKeys.length - 1;
      await act(async () => {
        // The hook transfers persistence, then ChatWindow's confirmed callback
        // advances captured recovery ownership, with no intervening await.
        clearDraft(currentKey);
        setDraft(targetKey, movedDraft);
        ref.current.retargetPendingRecovery(currentKey, targetKey);
        if (finalMove) {
          releaseResponse();
          await response;
          expected = {
            ...movedDraft,
            value: `removed question\n\n${movedDraft.value}`,
            images: [...removedImages, ...movedDraft.images],
          };
          assert.deepEqual(getDraft(targetKey), expected, "HTTP success recovers before the new identity renders");
          assert.equal(getDraft(currentKey), null, "the old key stays absent before hydration");
          assert.equal(textbox.value, sourceDraft.value, "retargeting does not change the live composer early");
        }
        rerender({
          isStreaming: false,
          queuedMessages: { followUp: [], steering: [] },
          draftKey: targetKey,
          draftIdentityMove: { from: currentKey, to: targetKey, sourceDraft },
        });
      });
      currentKey = targetKey;
    }
    await waitFor(() => assert.deepEqual(getDraft(currentKey), expected));
    assert.equal(screen.getByRole("textbox"), textbox, "confirmed moves retain the composer");
    assert.equal(textbox.value, expected.value);
    assert.equal(screen.getAllByRole("button", { name: /remove image/i }).length, expected.images.length);
    assert.equal(sessionStorage.getItem(`omp-draft-${currentKey}`), expected.value);
    for (const abandonedKey of [KEY, ...targetKeys.slice(0, -1)]) {
      assert.equal(getDraft(abandonedKey), null, "hydration must not resurrect an abandoned owner");
    }
    assert.equal(removals, 1);
    assert.deepEqual(nativeQueue, []);
    assert.deepEqual(sent, []);
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(sent.length, 1));
    assert.ok(sent[0].message.startsWith(expected.value));
    assert.match(sent[0].message, /Attached file: notes\.txt/);
    assert.match(sent[0].message, /Attached file: older\.txt/);
    assert.deepEqual(sent[0].images.map(({ data, mimeType }) => ({ data, mimeType })), expected.images);
    assert.equal(getDraft(currentKey), null);
  });
}

for (const [responseBeforeCommit, movedBeforeNavigation] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`a pending queue Edit ignores another identity's move${movedBeforeNavigation ? " even when its old key is reused" : " after genuine navigation"} with recovery ${responseBeforeCommit ? "before" : "after"} commit`, async (t) => {
    const originalTarget = `${KEY}:queue-original-target`;
    const navigationKey = movedBeforeNavigation ? KEY : `${KEY}:queue-unrelated`;
    const unrelatedTarget = `${KEY}:queue-unrelated-target`;
    t.after(() => [originalTarget, navigationKey, unrelatedTarget].forEach(clearDraft));
    const removedImages = [{ data: PNG, mimeType: "image/png" }];
    let releaseResponse;
    const response = new Promise((resolve) => { releaseResponse = () => resolve(removedImages); });
    let removals = 0;
    const { ref, rerender } = await renderWithAttachments({
      queuedMessages: { followUp: ["removed question"], steering: [] },
      onRemoveQueuedMessage: () => { removals += 1; return response; },
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "original conversation" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const sourceDraft = getDraft(KEY);
    let recoveryKey = KEY;
    if (movedBeforeNavigation) {
      clearDraft(KEY);
      setDraft(originalTarget, sourceDraft);
      ref.current.retargetPendingRecovery(KEY, originalTarget);
      rerender({
        draftKey: originalTarget,
        draftIdentityMove: { from: KEY, to: originalTarget, sourceDraft },
        queuedMessages: { followUp: [], steering: [] },
      });
      recoveryKey = originalTarget;
    }
    rerender({ draftKey: navigationKey, queuedMessages: { followUp: [], steering: [] } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "unrelated conversation" } });
    const unrelatedDraft = getDraft(navigationKey);
    await act(async () => {
      clearDraft(navigationKey);
      setDraft(unrelatedTarget, unrelatedDraft);
      ref.current.retargetPendingRecovery(navigationKey, unrelatedTarget);
      if (responseBeforeCommit) {
        releaseResponse();
        await response;
        assert.equal(getDraft(navigationKey), null, "a different identity's pre-commit recovery cannot recreate this source");
        assert.deepEqual(getDraft(unrelatedTarget), unrelatedDraft);
      }
      rerender({
        draftKey: unrelatedTarget,
        draftIdentityMove: { from: navigationKey, to: unrelatedTarget, sourceDraft: unrelatedDraft },
        queuedMessages: { followUp: [], steering: [] },
      });
    });
    if (!responseBeforeCommit) await act(async () => { releaseResponse(); await response; });
    await waitFor(() => assert.deepEqual(getDraft(recoveryKey), {
      ...sourceDraft,
      value: "removed question\n\noriginal conversation",
      images: [...removedImages, ...sourceDraft.images],
    }));
    assert.equal(screen.getByRole("textbox").value, "unrelated conversation");
    assert.deepEqual(getDraft(unrelatedTarget), unrelatedDraft, "navigation cannot hijack pending recovery");
    assert.equal(getDraft(navigationKey), null, "the unrelated move source stays absent");
    if (movedBeforeNavigation) assert.equal(getDraft(KEY), null);
    assert.equal(removals, 1);
  });
}

test("held text and image reads finish exactly once in the confirmed Edit target, persist and send there", async (t) => {
  const targetKey = `${KEY}:held-reads-target`;
  t.after(() => clearDraft(targetKey));
  const { MAX_ATTACHED_IMAGES } = await import("@/lib/image-attachments");
  const { MAX_ATTACHED_TEXT_FILES } = await import("@/lib/chat-attachments");
  const user = userEvent.setup();
  const { calls, ref, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false });
  await user.type(screen.getByRole("textbox"), "source draft");
  const textbox = screen.getByRole("textbox");
  let releaseText;
  let releaseImage;
  const text = new File(["late text"], "late.txt", { type: "text/plain" });
  const image = new File([Buffer.from(PNG, "base64")], "late.png", { type: "image/png" });
  override(text, "text", () => new Promise((resolve) => { releaseText = resolve; }));
  override(image, "arrayBuffer", () => new Promise((resolve) => { releaseImage = resolve; }));
  t.after(() => {
    releaseText?.("late text");
    releaseImage?.(Uint8Array.from(Buffer.from(PNG, "base64")).buffer);
  });
  act(() => { ref.current.addFiles([text, image]); });
  assert.equal(typeof releaseText, "function", "the actual text read is held");
  assert.equal(typeof releaseImage, "function", "the actual FileReader image read is held");

  const sourceDraft = getDraft(KEY);
  // Merging an existing target fills the picker slots while the already
  // admitted reads are held. Their reservations must survive that merge.
  const targetFiles = Array.from({ length: MAX_ATTACHED_TEXT_FILES - 1 }, (_, index) => ({
    name: `target-${index}.txt`, mimeType: "text/plain", content: "target", size: 6,
  }));
  const movedDraft = {
    value: "source draft\n\ntarget draft",
    files: [...sourceDraft.files, ...targetFiles],
    images: Array.from({ length: MAX_ATTACHED_IMAGES }, () => ({ data: PNG, mimeType: "image/png" })),
  };
  clearDraft(KEY);
  setDraft(targetKey, movedDraft);
  const sent = [];
  const movedProps = {
    draftKey: targetKey,
    draftIdentityMove: { from: KEY, to: targetKey },
    onSend: async (message, images) => {
      sent.push({ message, images });
      return { status: "accepted" };
    },
  };
  rerender(movedProps);
  assert.equal(screen.getByRole("textbox"), textbox, "the composer stays mounted");
  assert.equal(textbox.value, movedDraft.value);
  assert.equal(getDraft(targetKey).files.length, MAX_ATTACHED_TEXT_FILES, "neither held read was released before migration");
  assert.equal(getDraft(targetKey).images.length, MAX_ATTACHED_IMAGES);
  await act(async () => {
    releaseText("late text");
    releaseImage(Uint8Array.from(Buffer.from(PNG, "base64")).buffer);
  });
  await waitFor(() => {
    assert.deepEqual(getDraft(targetKey)?.files.map((file) => file.name), ["notes.txt", ...targetFiles.map((file) => file.name), "late.txt"]);
    assert.equal(getDraft(targetKey)?.images.length, MAX_ATTACHED_IMAGES + 1);
  });
  assert.equal(getDraft(KEY), null, "late reads must not resurrect the source draft");
  const persisted = getDraft(targetKey);
  // Actual navigation still isolates input, and reopening restores the target.
  rerender({ draftKey: KEY });
  assert.equal(screen.getByRole("textbox").value, "");
  rerender(movedProps);
  assert.deepEqual(getDraft(targetKey), persisted);
  cleanup();
  render(React.createElement(ChatInput, { ...movedProps, isStreaming: false }));
  assert.equal(screen.getByRole("textbox").value, persisted.value, "a fresh composer restores the migrated text");
  assert.deepEqual(getDraft(targetKey), persisted, "remount preserves the recovered overflow and every file");
  assert.equal(screen.getAllByRole("button", { name: /remove image/i }).length, MAX_ATTACHED_IMAGES + 1);
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  assert.equal((await screen.findByRole("alert")).textContent, `A message can include at most ${MAX_ATTACHED_IMAGES} images`);
  assert.deepEqual(sent, [], "an over-cap draft never reaches the target send handler");
  assert.deepEqual(calls, [], "an over-cap draft never reaches the source send handler");
  assert.equal(screen.getByRole("textbox").value, persisted.value);
  assert.deepEqual(getDraft(targetKey), persisted, "refusal loses no recovered text, images or files");
  await user.click(screen.getAllByRole("button", { name: /remove image/i })[0]);
  const sendable = { ...persisted, images: persisted.images.slice(1) };
  await waitFor(() => assert.deepEqual(getDraft(targetKey), sendable));
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(calls, [], "the source session's send handler is never invoked");
  assert.match(sent[0].message, /^source draft\n\ntarget draft/);
  for (const file of persisted.files) {
    const section = `Attached file: ${file.name}\n\`\`\`text\n${file.content}\n\`\`\``;
    assert.equal(sent[0].message.split(`Attached file: ${file.name}\n`).length - 1, 1, `${file.name} is included exactly once`);
    assert.ok(sent[0].message.includes(section), `${file.name} retains its exact content`);
  }
  assert.deepEqual(sent[0].images.map(({ data, mimeType }) => ({ data, mimeType })), sendable.images);
  await waitFor(() => assert.equal(getDraft(targetKey), null));
});

for (const includeRecovery of [false, true]) {
  test(`same-batch reads and claimed transcript survive Edit exactly once${includeRecovery ? " with source recovery already transferred" : ""}`, async (t) => {
    const targetKey = `${KEY}:same-batch-${includeRecovery}`;
    t.after(() => clearDraft(targetKey));
    const { MAX_ATTACHED_IMAGES } = await import("@/lib/image-attachments");
    const { MAX_ATTACHED_TEXT_FILES } = await import("@/lib/chat-attachments");
    const dictation = installPendingDictation({ holdClaim: true });
    t.after(() => dictation.releaseClaim());
    const user = userEvent.setup();
    const { calls, ref, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false });
    await user.type(screen.getByRole("textbox"), "source draft");
    await user.click(screen.getByRole("button", { name: "Start dictation" }));
    await user.click(await screen.findByTitle("Transcribe and send"));
    await waitFor(() => assert.equal(dictation.uploads.length, 1));
    dictation.complete();
    await waitFor(() => assert.equal(dictation.claims.length, 1), { timeout: 3000 });
    rerender({ submissionBlocked: true });

    let releaseText;
    let releaseImage;
    const text = new File(["boundary text"], "boundary.txt", { type: "text/plain" });
    const image = new File([Buffer.from(PNG, "base64")], "boundary.png", { type: "image/png" });
    override(text, "text", () => new Promise((resolve) => { releaseText = resolve; }));
    override(image, "arrayBuffer", () => new Promise((resolve) => { releaseImage = resolve; }));
    t.after(() => {
      releaseText?.("boundary text");
      releaseImage?.(Uint8Array.from(Buffer.from(PNG, "base64")).buffer);
    });
    act(() => { ref.current.addFiles([text, image]); });
    assert.equal(typeof releaseText, "function");
    assert.equal(typeof releaseImage, "function");

    const targetFiles = Array.from({ length: MAX_ATTACHED_TEXT_FILES - 1 }, (_, index) => ({
      name: `older-${index}.txt`, mimeType: "text/plain", content: `older ${index}`, size: 7,
    }));
    const sent = [];
    let sourceDraft;
    let transferred;
    let movedProps;
    await act(async () => {
      if (includeRecovery) {
        recoverDraft(KEY, { text: "already recovered", images: [{ data: PNG, mimeType: "image/png" }] });
      }
      sourceDraft = getDraft(KEY);
      transferred = {
        value: `${sourceDraft.value}\n\nolder target draft`,
        images: [
          ...sourceDraft.images,
          ...Array.from({ length: MAX_ATTACHED_IMAGES - sourceDraft.images.length }, () => ({ data: PNG, mimeType: "image/png" })),
        ],
        files: [...sourceDraft.files, ...targetFiles],
      };
      releaseText("boundary text");
      releaseImage(Uint8Array.from(Buffer.from(PNG, "base64")).buffer);
      dictation.releaseClaim();
      // Let the real reader/claim promise chains queue their state updates,
      // without letting React commit them before the identity transition.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(getDraft(KEY), sourceDraft, "the transfer snapshot is still older than the queued completions");
      clearDraft(KEY);
      setDraft(targetKey, transferred);
      movedProps = {
        draftKey: targetKey,
        draftIdentityMove: { from: KEY, to: targetKey, sourceDraft },
        onSend: async (message, images) => {
          sent.push({ message, images });
          return { status: "accepted" };
        },
      };
      rerender({ ...movedProps, submissionBlocked: true });
    });
    // Bun appends ";charset=utf-8" to a text File's type, so the type is pinned by its prefix.
    const mimeType = getDraft(targetKey)?.files.at(-1)?.mimeType ?? "";
    assert.ok(mimeType.startsWith("text/plain"), mimeType);
    const expected = {
      value: `${sourceDraft.value} transcribed words\n\nolder target draft`,
      images: [...transferred.images, { data: PNG, mimeType: "image/png" }],
      files: [...transferred.files, { name: "boundary.txt", mimeType, content: "boundary text", size: text.size }],
    };
    assert.equal(screen.getByRole("textbox").value, expected.value, "new source text wins without overwriting older target text");
    assert.deepEqual(getDraft(targetKey), expected, "only completions missing from the source transfer are added");
    assert.equal(sessionStorage.getItem(`omp-draft-${targetKey}`), expected.value);
    assert.equal(getDraft(KEY), null, "the completed source never reappears");
    assert.equal(dictation.uploads.length, 1);
    assert.equal(dictation.claims.length, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, [], "the claim's automatic send stays blocked");

    rerender({ draftKey: KEY });
    assert.equal(screen.getByRole("textbox").value, "", "real navigation remains isolated");
    rerender(movedProps);
    assert.deepEqual(getDraft(targetKey), expected, "the consumed move marker cannot apply a second merge");
    cleanup();
    render(React.createElement(ChatInput, { ...movedProps, isStreaming: false }));
    assert.equal(screen.getByRole("textbox").value, expected.value);
    assert.deepEqual(getDraft(targetKey), expected, "reopening restores every boundary completion exactly once");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    assert.equal((await screen.findByRole("alert")).textContent, `A message can include at most ${MAX_ATTACHED_IMAGES} images`);
    assert.deepEqual(sent, [], "identity migration cannot bypass the outgoing image cap");
    assert.deepEqual(getDraft(targetKey), expected);
    await user.click(screen.getAllByRole("button", { name: /remove image/i })[0]);
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(sent.length, 1));
    assert.ok(sent[0].message.startsWith(expected.value));
    assert.equal(sent[0].message.split("transcribed words").length - 1, 1);
    for (const file of expected.files) {
      const section = `Attached file: ${file.name}\n\`\`\`text\n${file.content}\n\`\`\``;
      assert.equal(sent[0].message.split(`Attached file: ${file.name}\n`).length - 1, 1);
      assert.ok(sent[0].message.includes(section));
    }
    assert.deepEqual(sent[0].images.map(({ data, mimeType }) => ({ data, mimeType })), expected.images.slice(1));
    assert.deepEqual(calls, [], "only the target send callback runs");
    assert.equal(dictation.uploads.length, 1);
    assert.equal(dictation.claims.length, 1);
    await waitFor(() => assert.equal(getDraft(targetKey), null));
  });
}

for (const state of ["active", "paused", "reviewing"]) {
  test(`confirmed Edit preserves ${state} capture and uploads its retained audio under the target owner`, async (t) => {
    const targetKey = `${KEY}:capture-${state}`;
    t.after(() => clearDraft(targetKey));
    const dictation = installPendingDictation({ after: null });
    const user = userEvent.setup();
    const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false });
    await user.type(screen.getByRole("textbox"), "retained draft");
    await user.click(screen.getByRole("button", { name: "Start dictation" }));
    const [recorder] = dictation.recorders;
    if (state === "paused") await user.click(screen.getByRole("button", { name: "Pause recording" }));
    if (state === "reviewing") await user.click(screen.getByRole("button", { name: "Stop recording" }));
    const expectedState = state === "active" ? "recording" : state === "paused" ? "paused" : "inactive";
    assert.equal(recorder.state, expectedState);
    const stopsBeforeMove = dictation.trackStops;
    const movedDraft = getDraft(KEY);
    clearDraft(KEY);
    setDraft(targetKey, movedDraft);
    rerender({ draftKey: targetKey, draftIdentityMove: { from: KEY, to: targetKey } });
    assert.equal(dictation.recorders.length, 1, "migration does not recreate capture");
    assert.equal(recorder.state, expectedState);
    assert.equal(dictation.trackStops, stopsBeforeMove, "migration does not stop the microphone");
    if (state === "paused") {
      await user.click(screen.getByRole("button", { name: "Resume recording" }));
      assert.equal(recorder.state, "recording");
    }
    if (state !== "reviewing") await user.click(screen.getByRole("button", { name: "Stop recording" }));
    await user.click(screen.getByRole("button", { name: "Transcribe", exact: true }));
    await waitFor(() => assert.equal(dictation.uploads.length, 1));
    assert.equal(dictation.uploads[0].scope, targetKey, "the original recorder callback uses the confirmed live owner");
    assert.equal(await dictation.uploads[0].file.text(), state === "paused" ? "spoken audiospoken audio" : "spoken audio",
      "the original capture's flushed chunks, not an empty replacement, are uploaded");
    dictation.complete();
    await waitFor(() => assert.equal(getDraft(targetKey)?.value, "retained draft transcribed words"), { timeout: 3000 });
    assert.deepEqual(getDraft(targetKey).images, movedDraft.images);
    assert.deepEqual(getDraft(targetKey).files, movedDraft.files);
    assert.equal(getDraft(KEY), null);
    assert.equal(dictation.claims.length, 1);
    assert.deepEqual(calls, [], "conversion alone does not submit the draft");
  });
}

for (const holdUpload of [false, true]) {
  test(`confirmed Edit retains ${holdUpload ? "an in-flight upload" : "an uploaded transcription job"} and delivers once into the target`, async (t) => {
    const targetKey = `${KEY}:uploaded-${holdUpload}`;
    t.after(() => clearDraft(targetKey));
    const dictation = installPendingDictation({ holdUpload });
    const user = userEvent.setup();
    const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false });
    await user.type(screen.getByRole("textbox"), "keep this draft");
    await user.click(screen.getByRole("button", { name: "Start dictation" }));
    await user.click(await screen.findByTitle("Transcribe and send"));
    await waitFor(() => assert.equal(dictation.uploads.length, 1));
    if (!holdUpload) await waitFor(() => assert.equal(dictation.polls[0], "pending"), { timeout: 3000 });
    assert.equal(dictation.uploads[0].scope, KEY, "the existing job keeps its server scope");
    const movedDraft = getDraft(KEY);
    clearDraft(KEY);
    setDraft(targetKey, movedDraft);
    const sent = [];
    const movedProps = {
      draftKey: targetKey, draftIdentityMove: { from: KEY, to: targetKey },
      onSend: async (message, images) => {
        sent.push({ message, images });
        return { status: "accepted" };
      },
    };
    rerender({ ...movedProps, submissionBlocked: true });
    dictation.releaseUpload();
    dictation.complete();
    await waitFor(() => assert.equal(getDraft(targetKey)?.value, "keep this draft transcribed words"), { timeout: 3000 });
    assert.equal(dictation.uploads.length, 1, "identity migration never reuploads the recording");
    assert.equal(dictation.claims.length, 1, "the original job is claimed only once");
    assert.equal(dictation.claims[0].owner, dictation.uploads[0].owner);
    assert.ok(dictation.claims[0].token);
    assert.deepEqual(getDraft(targetKey).images, movedDraft.images);
    assert.deepEqual(getDraft(targetKey).files, movedDraft.files);
    assert.equal(getDraft(KEY), null);
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, [], "the pending Edit gate still suppresses after:send");
    rerender({ ...movedProps, submissionBlocked: false });
    assert.deepEqual(sent, [], "unblocking does not replay automatic delivery");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(sent.length, 1));
    assert.deepEqual(calls, [], "explicit send uses the target callback, never the source callback");
    assertQueuedWithAttachments(sent[0], "keep this draft transcribed words");
    await waitFor(() => assert.equal(getDraft(targetKey), null));
  });
}

test("drops candidates expanding beyond per-file and aggregate limits post-read", async () => {
  const { MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES } = await import("@/lib/chat-attachments");
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: "budget-check-test",
    isStreaming: false,
    onSend: async () => ({ status: "accepted" }),
  }));

  // Mock readAttachmentText expansion behavior by providing a file whose read text expands past MAX_ATTACHED_TEXT_BYTES
  // In jsdom / test environment, File.text() returns the file content
  const hugeContent = "A".repeat(MAX_ATTACHED_TEXT_BYTES + 100);
  const hugeFile = new File([hugeContent], "huge.txt", { type: "text/plain" });
  // Override size on the File object so it passes initial selectTextAttachments (pre-read)
  Object.defineProperty(hugeFile, "size", { value: 100, configurable: true });

  await act(async () => {
    ref.current.addFiles([hugeFile]);
  });

  await waitFor(() => {
    const draft = getDraft("budget-check-test");
    assert.equal(draft?.files?.length ?? 0, 0, "oversized post-read file is rejected");
  });

  // Now test aggregate budget enforcement post-read
  const fitsBytes = Math.floor(MAX_TOTAL_ATTACHED_TEXT_BYTES * 0.6);
  const file1Content = "B".repeat(fitsBytes);
  const file1 = new File([file1Content], "file1.txt", { type: "text/plain" });
  Object.defineProperty(file1, "size", { value: 100, configurable: true });

  const file2Content = "C".repeat(fitsBytes);
  const file2 = new File([file2Content], "file2.txt", { type: "text/plain" });
  Object.defineProperty(file2, "size", { value: 100, configurable: true });

  await act(async () => {
    ref.current.addFiles([file1, file2]);
  });

  await waitFor(() => {
    const draft = getDraft("budget-check-test");
    assert.equal(draft?.files?.length, 1, "only file fitting within aggregate limit is retained");
    assert.equal(draft.files[0].name, "file1.txt");
  });
test("a second Enter must not invoke a pending slash builtin twice; success clears unchanged text", async (t) => {
  override(window.HTMLElement.prototype, "scrollIntoView", () => {});
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  t.after(async () => { await act(async () => { finish({ handled: true }); }); });
  const builtinCalls = [];
  const user = userEvent.setup();
  render(React.createElement(ChatInput, {
    draftKey: KEY,
    isStreaming: false,
    onAbort() {},
    onSend: async () => ({ status: "accepted" }),
    onBuiltinCommand: (message) => {
      builtinCalls.push(message);
      return pending;
    },
  }));
  const textbox = screen.getByRole("textbox");
  await user.type(textbox, "/goal ship it");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(builtinCalls.length, 1));
  assert.equal(textbox.value, "/goal ship it", "the builtin has not completed");
  await user.keyboard("{Enter}");
  assert.deepEqual(builtinCalls, ["/goal ship it"], "repeated Enter must not execute the pending builtin again");
  await act(async () => { finish({ handled: true }); });
  await waitFor(() => assert.equal(textbox.value, ""));
  assert.equal(getDraft(KEY), null, "success clears the unchanged builtin draft");
});

test("a completed slash builtin must not erase an attachment added while its callback was pending", async (t) => {
  override(window.HTMLElement.prototype, "scrollIntoView", () => {});
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  t.after(async () => { await act(async () => { finish({ handled: true }); }); });
  const builtinCalls = [];
  const ref = React.createRef();
  const user = userEvent.setup();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: KEY,
    isStreaming: false,
    onAbort() {},
    onSend: async () => ({ status: "accepted" }),
    onBuiltinCommand: (message) => {
      builtinCalls.push(message);
      return pending;
    },
  }));
  const textbox = screen.getByRole("textbox");
  await user.type(textbox, "/goal keep this draft");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.deepEqual(builtinCalls, ["/goal keep this draft"]));
  await act(async () => {
    ref.current.addFiles([
      new File(["added while pending"], "pending.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.files[0]?.name, "pending.txt"));
  const changedDraft = getDraft(KEY);
  assert.equal(changedDraft.files[0].content, "added while pending");
  await act(async () => { finish({ handled: true }); });
  assert.equal(textbox.value, "/goal keep this draft", "an attachment change preserves the composer text too");
  assert.deepEqual(getDraft(KEY), changedDraft, "builtin completion must not erase the newly attached file");
});
