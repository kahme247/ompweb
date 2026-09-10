import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { clearDraft, getDraft, getDraftSummary, setDraft } from "./draft-store.ts";

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
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
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
