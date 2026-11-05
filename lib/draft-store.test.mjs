import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { beginDraftSubmission, clearDraft, consumeDraft, endDraftSubmission, getDraft, getDraftRevision, getDraftSummary, markDraftEdited, mergeRecoveredText, moveDraftSubmissions, setDraft, subscribeDraftConsumption } from "./draft-store.ts";

test("outbox consumption notifies matching drafts without clearing newer text, equal-text retypes or attachment payloads", () => {
  const key = "outbox-consumption";
  const original = { value: "sent", images: [{ data: "png", mimeType: "image/png" }], files: [] };
  const events = [];
  const unsubscribe = subscribeDraftConsumption((...args) => events.push(args));
  try {
    setDraft(key, original);
    const revision = getDraftRevision(key);
    setDraft(key, { ...original, value: "new typing" });
    consumeDraft(key, original, revision);
    assert.equal(getDraft(key).value, "new typing");
    assert.equal(events.length, 0);
    setDraft(key, original);
    consumeDraft(key, original, revision);
    assert.equal(getDraft(key).value, "sent", "an edit that restores the same content is still newer input");
    assert.equal(events.length, 0);
    clearDraft(key);
    setDraft(key, original);
    consumeDraft(key, original, revision);
    assert.equal(getDraft(key).value, "sent", "a cleared-and-retyped draft is a new revision");
    const current = getDraftRevision(key);
    setDraft(key, { ...original, uploads: [] });
    assert.equal(getDraftRevision(key), current, "rewriting identical content (hydration, navigation save) is not an edit");
    consumeDraft(key, original, current);
    assert.equal(getDraft(key), null);
    assert.equal(getDraftRevision(key), -1);
    assert.deepEqual(events, [[key, original]]);
  } finally {
    unsubscribe();
    clearDraft(key);
  }
});

test("an edit marked at admission invalidates an older consumption even when the content ends the same", () => {
  const key = "outbox-mark-edit";
  try {
    markDraftEdited(key);
    assert.equal(getDraftRevision(key), -1, "marking never creates a draft");
    setDraft(key, { value: "same", images: [], files: [] });
    const revision = getDraftRevision(key);
    markDraftEdited(key);
    setDraft(key, { value: "same", images: [], files: [] });
    consumeDraft(key, { value: "same", images: [], files: [] }, revision);
    assert.equal(getDraft(key)?.value, "same");
  } finally {
    clearDraft(key);
  }
});

test("a pending submission follows only its unchanged draft through a move and stops once ended", () => {
  const [from, to, merged] = ["sub-from", "sub-to", "sub-merged"];
  const sent = { value: "sent", images: [{ data: "png", mimeType: "image/png" }], files: [] };
  try {
    setDraft(from, sent);
    const followed = beginDraftSubmission(from);
    const ended = beginDraftSubmission(from);
    endDraftSubmission(ended);
    clearDraft(from);
    setDraft(to, { ...sent, uploads: [] });
    moveDraftSubmissions(from, to);
    assert.equal(followed.key, to);
    assert.equal(followed.revision, getDraftRevision(to));
    assert.equal(ended.key, from, "an ended submission is no longer tracked");
    consumeDraft(followed.key, followed.snapshot, followed.revision);
    assert.equal(getDraft(to), null);

    setDraft(from, sent);
    const edited = beginDraftSubmission(from);
    markDraftEdited(from);
    clearDraft(from);
    setDraft(to, sent);
    moveDraftSubmissions(from, to);
    assert.equal(edited.key, undefined, "an edited draft is let go of");

    setDraft(from, sent);
    const mergedInto = beginDraftSubmission(from);
    clearDraft(from);
    setDraft(merged, { ...sent, value: "older\n\nsent" });
    moveDraftSubmissions(from, merged);
    assert.equal(mergedInto.key, undefined, "a merged target draft is not the sent one");
    for (const each of [edited, mergedInto]) endDraftSubmission(each);
  } finally {
    for (const key of [from, to, merged]) clearDraft(key);
  }
});

test("getDraftSummary returns text and attachment presence without deep cloning", () => {
  const key = "test-session-draft-1";
  clearDraft(key);

  const emptySummary = getDraftSummary(key);
  assert.equal(emptySummary.text, "");
  assert.equal(emptySummary.hasAttachments, false);

  setDraft(key, {
    value: "Hello world",
    images: [{ data: "data:image/png;base64,AAA...", mimeType: "image/png" }],
    files: [{ name: "test.txt", mimeType: "text/plain", content: "file data", size: 9 }],
  });

  const summary = getDraftSummary(key);
  assert.equal(summary.text, "Hello world");
  assert.equal(summary.hasAttachments, true);

  const full = getDraft(key);
  assert.ok(full);
  assert.equal(full.value, "Hello world");
  assert.equal(full.images.length, 1);
  assert.equal(full.files.length, 1);

  clearDraft(key);
  assert.equal(getDraft(key), null);
});

test("evicted drafts stay evicted after a fresh document", () => {
  const saved = inFreshDocument([], `
    for (let i = 0; i < 60; i++) {
      setDraft("eviction-session-" + i, { value: "Draft " + i, images: [], files: [] });
    }
    const result = null;
  `);
  const restored = inFreshDocument(saved.storage, `
    const result = Array.from({ length: 60 }, (_, i) => getDraft("eviction-session-" + i)?.value ?? null);
  `);
  assert.deepEqual(restored.result, [
    ...Array(10).fill(null),
    ...Array.from({ length: 50 }, (_, i) => "Draft " + (i + 10)),
  ]);
});

test("empty and overflowing stored drafts are removed without affecting unrelated settings", () => {
  const overflow = [
    ["unrelated-setting", "keep"],
    ["omp-draft-empty", ""],
    ...Array.from({ length: 55 }, (_, i) => ["omp-draft-overflow-" + i, "Draft " + i]),
  ];
  const restored = inFreshDocument(overflow, `
    const result = [];
    for (let i = 0; i < 55; i++) {
      const key = "overflow-" + i;
      const draft = getDraft(key);
      if (draft) {
        result.push(draft.value);
        clearDraft(key);
      }
    }
  `);
  assert.equal(restored.result.length, 50);
  const cleared = inFreshDocument(restored.storage, `
    const result = Array.from({ length: 55 }, (_, i) => getDraft("overflow-" + i));
  `);
  assert.deepEqual(cleared.result, Array(55).fill(null));
  assert.deepEqual(cleared.storage, [["unrelated-setting", "keep"]]);
});

// Each process is a fresh document: retain only Web Storage, never module state.
function inFreshDocument(storage, action, setup = "") {
  const script = `
    const storage = new Map(JSON.parse(process.env.DRAFT_STORAGE));
    globalThis.sessionStorage = {
      get length() { return storage.size; },
      key: (index) => [...storage.keys()][index] ?? null,
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    };
    ${setup}
    const { setDraft, getDraft, getDraftSummary, clearDraft } =
      await import(${JSON.stringify(new URL("./draft-store.ts", import.meta.url).href)});
    ${action}
    console.log(JSON.stringify({ storage: [...storage], result }));
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, DRAFT_STORAGE: JSON.stringify(storage) },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("unsent text survives a fresh document, stays scoped, and cannot reappear after clearing", () => {
  const text = "  Unsent first line\n第二行 — café\n";
  const saved = inFreshDocument([], `
    setDraft("session-a", { value: ${JSON.stringify(text)}, images: [], files: [] });
    setDraft("new:/workspace-b", { value: "Another draft", images: [], files: [] });
    const result = null;
  `);
  const restored = inFreshDocument(saved.storage, `
    const result = [
      getDraft("session-a")?.value,
      getDraftSummary("new:/workspace-b").text,
      getDraft("session-c"),
    ];
    clearDraft("session-a");
    setDraft("new:/workspace-b", { value: "", images: [], files: [] });
  `);
  assert.deepEqual(restored.result, [text, "Another draft", null]);
  const cleared = inFreshDocument(restored.storage, `
    const result = [getDraft("session-a"), getDraft("new:/workspace-b")];
  `);
  assert.deepEqual(cleared.result, [null, null]);
});

test("only text survives navigation, including when an attachment-only draft replaces it", () => {
  const saved = inFreshDocument([], `
    setDraft("attachments", {
      value: "Keep text",
      images: [{ data: "data:image/png;base64,AAAA", mimeType: "image/png" }],
      files: [{ name: "notes.txt", mimeType: "text/plain", content: "File content", size: 12 }],
    });
    const result = getDraftSummary("attachments").hasAttachments;
  `);
  assert.equal(saved.result, true);
  const restored = inFreshDocument(saved.storage, `
    const result = getDraft("attachments");
    setDraft("attachments", {
      value: "",
      images: [{ data: "data:image/png;base64,AAAA", mimeType: "image/png" }],
      files: [],
    });
  `);
  assert.deepEqual(restored.result, { value: "Keep text", images: [], files: [] });
  const cleared = inFreshDocument(restored.storage, `
    const result = getDraft("attachments");
  `);
  assert.equal(cleared.result, null);
});

test("finished uploads survive a fresh document, with or without text, and clear with the draft", () => {
  const upload = { id: "0f0e0d0c-0b0a-4908-8706-050403020100", name: "data.zip", size: 12, hostId: "local" };
  const saved = inFreshDocument([["omp-uploads-draft-broken", "not json"]], `
    setDraft("with-text", { value: "See the file", images: [], files: [], uploads: [${JSON.stringify(upload)}] });
    setDraft("files-only", { value: "", images: [], files: [], uploads: [${JSON.stringify(upload)}] });
    const result = null;
  `);
  const restored = inFreshDocument(saved.storage, `
    const result = [getDraft("with-text"), getDraft("files-only"), getDraft("broken")];
    clearDraft("files-only");
  `);
  assert.deepEqual(restored.result, [
    { value: "See the file", images: [], files: [], uploads: [upload] },
    { value: "", images: [], files: [], uploads: [upload] },
    null,
  ]);
  const cleared = inFreshDocument(restored.storage, `
    const result = getDraft("files-only");
  `);
  assert.equal(cleared.result, null);
});

test("upload continuity: finished proof survives a fresh document without changing legacy uploads", () => {
  const upload = { id: "proof-upload", name: "private.zip", size: 12, hostId: "local", proof: "exact-completion-proof" };
  const legacy = { id: "legacy-upload", name: "legacy.zip", size: 8, hostId: "local" };
  const saved = inFreshDocument([], `
    setDraft("proof-reload", { value: "", images: [], files: [], uploads: [${JSON.stringify(upload)}, ${JSON.stringify(legacy)}] });
    const result = null;
  `);
  const restored = inFreshDocument(saved.storage, `
    const result = getDraft("proof-reload");
  `);
  assert.deepEqual(restored.result, { value: "", images: [], files: [], uploads: [upload, legacy] });
});

test("upload continuity: a changed proof is a newer draft and cannot be consumed by an old submission", () => {
  const key = "proof-draft-revision";
  const original = { value: "", images: [], files: [], uploads: [{ id: "same-id", name: "file.zip", size: 8, hostId: "local", proof: "first-proof" }] };
  try {
    setDraft(key, original);
    const revision = getDraftRevision(key);
    const changed = { ...original, uploads: [{ ...original.uploads[0], proof: "replacement-proof" }] };
    setDraft(key, changed);
    assert.notEqual(getDraftRevision(key), revision, "proof is part of the submitted attachment identity");
    consumeDraft(key, original, revision);
    assert.deepEqual(getDraft(key), changed, "an old durable commit must not clear the newly authorized draft");
  } finally {
    clearDraft(key);
  }
});

test("denied browser storage still allows in-memory editing and clearing", () => {
  const document = inFreshDocument([], `
    setDraft("blocked", { value: "Still editable", images: [], files: [] });
    const result = [getDraft("blocked")?.value];
    clearDraft("blocked");
    result.push(getDraft("blocked"));
  `, `
    Object.defineProperty(globalThis, "sessionStorage", {
      get() { throw new DOMException("Storage denied", "SecurityError"); },
    });
  `);
  assert.deepEqual(document.result, ["Still editable", null]);
});

test("a later recovery merges with an earlier one in order, unless the draft no longer starts with it", () => {
  assert.equal(mergeRecoveredText("typing", { text: "B" }), "B\n\ntyping");
  const replace = { lead: "B", fallback: "A" };
  assert.equal(mergeRecoveredText("B\n\ntyping", { text: "A\n\nB", replace }), "A\n\nB\n\ntyping");
  assert.equal(mergeRecoveredText("edited", { text: "A\n\nB", replace }), "A\n\nedited", "never re-adds text the user removed");
});
