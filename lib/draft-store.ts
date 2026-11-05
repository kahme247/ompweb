export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraftFile {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

/** A finished upload staged on `hostId` (docs/specs/2026-11-02-file-uploads-design.md U2). */
export interface ChatDraftUpload {
  id: string;
  name: string;
  size: number;
  hostId: string;
  proof?: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
  /** Finished uploads; unlike images and files their metadata survives a reload. */
  uploads?: ChatDraftUpload[];
}

/** Content to put back in a composer. `replace` merges a later recovery with
 *  an earlier one in order: while the draft still starts with `lead` (the
 *  earlier block), it becomes `text`; otherwise only `fallback` is prepended.
 *  `images` are appended to the draft's attachments. */
export interface DraftRecovery {
  text: string;
  replace?: { lead: string; fallback: string };
  images?: ChatDraftImage[];
  uploads?: ChatDraftUpload[];
}

/** The `{ data, mimeType }` images in an omp RPC payload; anything else is dropped. */
export function toDraftImages(value: unknown): ChatDraftImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image: unknown) => (
    image && typeof image === "object" && "data" in image && "mimeType" in image
      && typeof image.data === "string" && typeof image.mimeType === "string"
      ? [{ data: image.data, mimeType: image.mimeType }]
      : []
  ));
}

export function mergeRecoveredText(current: string, { text, replace }: DraftRecovery): string {
  if (!text) return current;
  if (replace && current.startsWith(replace.lead)) return text + current.slice(replace.lead.length);
  const lead = replace ? replace.fallback : text;
  return current ? `${lead}\n\n${current}` : lead;
}

// globalThis so dev Fast Refresh doesn't wipe drafts mid-typing.
declare global {
  var __ompChatDrafts: Map<string, ChatDraft> | undefined;
  var __ompChatDraftListeners: Set<() => void> | undefined;
  var __ompChatDraftRecoveryListeners: Set<(key: string, recovery: DraftRecovery) => void> | undefined;
  var __ompChatDraftConsumptionListeners: Set<(key: string, snapshot: ChatDraft) => void> | undefined;
  var __ompChatDraftRevisions: { byKey: Map<string, number>; last: number } | undefined;
  var __ompChatDraftSubmissions: Set<DraftSubmission> | undefined;
}

const MAX_DRAFTS = 50;
const STORAGE_PREFIX = "omp-draft-";
const UPLOADS_STORAGE_PREFIX = "omp-uploads-draft-";

function isDraftUpload(value: unknown): value is ChatDraftUpload {
  if (!value || typeof value !== "object") return false;
  const upload = value as Record<string, unknown>;
  return typeof upload.id === "string" && typeof upload.name === "string" && typeof upload.hostId === "string"
    && Number.isSafeInteger(upload.size) && (upload.size as number) >= 0
    && (upload.proof === undefined || typeof upload.proof === "string");
}

const drafts: Map<string, ChatDraft> = (globalThis.__ompChatDrafts ??= readStoredDrafts());

function readStoredDrafts(): Map<string, ChatDraft> {
  const stored = new Map<string, ChatDraft>();
  try {
    // Snapshot keys: removing overflow can change Storage's enumeration order.
    const storageKeys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    for (const storageKey of storageKeys) {
      if (!storageKey?.startsWith(STORAGE_PREFIX)) continue;
      if (stored.size >= MAX_DRAFTS) {
        sessionStorage.removeItem(storageKey);
        continue;
      }
      const value = sessionStorage.getItem(storageKey);
      if (value) {
        stored.set(storageKey.slice(STORAGE_PREFIX.length), { value, images: [], files: [] });
      } else {
        sessionStorage.removeItem(storageKey);
      }
    }
    // A draft's uploads, under their own key: with its text, or alone.
    for (const storageKey of storageKeys) {
      if (!storageKey?.startsWith(UPLOADS_STORAGE_PREFIX)) continue;
      const key = storageKey.slice(UPLOADS_STORAGE_PREFIX.length);
      let uploads: unknown;
      try {
        uploads = JSON.parse(sessionStorage.getItem(storageKey) ?? "");
      } catch {
        uploads = null;
      }
      const draft = stored.get(key) ?? (stored.size < MAX_DRAFTS ? { value: "", images: [], files: [] } : null);
      if (!draft || !Array.isArray(uploads) || !uploads.every(isDraftUpload) || uploads.length === 0) {
        sessionStorage.removeItem(storageKey);
        continue;
      }
      stored.set(key, { ...draft, uploads });
    }
  } catch {
    // Storage may be unavailable (SSR or browser policy); keep drafts in memory.
  }
  return stored;
}

const listeners = (globalThis.__ompChatDraftListeners ??= new Set<() => void>());
const recoveryListeners = (globalThis.__ompChatDraftRecoveryListeners ??= new Set<(key: string, recovery: DraftRecovery) => void>());
const consumptionListeners = (globalThis.__ompChatDraftConsumptionListeners ??= new Set<(key: string, snapshot: ChatDraft) => void>());
const revisions = (globalThis.__ompChatDraftRevisions ??= { byKey: new Map<string, number>(), last: 0 });
const submissions = (globalThis.__ompChatDraftSubmissions ??= new Set<DraftSubmission>());

export function hasUnsentDrafts(): boolean {
  return drafts.size > 0;
}

/** Whether `key` holds unsent text or attachments (empty drafts are never stored). */
export function hasDraft(key: string): boolean {
  return drafts.has(key);
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeDraftRecovery(listener: (key: string, recovery: DraftRecovery) => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

/** Records an edit at input admission, before it reaches `setDraft`: batched React updates can end with the same
 *  content and never write the store, which would otherwise hide a clear-and-retype from `consumeDraft`. */
export function markDraftEdited(key: string): void {
  markSubmissionsEdited(key);
  if (drafts.has(key)) revisions.byKey.set(key, ++revisions.last);
}

/** A submission waiting for its durable commit, owned by this store (not by the composer mount that sent it, which may
 *  be gone by the time the commit lands). `key` follows a confirmed identity move of the unchanged draft and is
 *  cleared when the draft merged into another or was edited first; `edited` records any edit since it was sent. */
export interface DraftSubmission { key: string | undefined; snapshot: ChatDraft | null; revision: number; edited: boolean }

/** Starts tracking the draft at `key`. Every submission MUST be ended (`endDraftSubmission`) once its commit settles,
 *  whether it was stored, refused or failed. */
export function beginDraftSubmission(key: string | undefined): DraftSubmission {
  const submission: DraftSubmission = { key, snapshot: key ? getDraft(key) : null, revision: key ? getDraftRevision(key) : -1, edited: false };
  submissions.add(submission);
  return submission;
}

export function endDraftSubmission(submission: DraftSubmission): void {
  submissions.delete(submission);
}

function markSubmissionsEdited(key: string): void {
  for (const submission of submissions) if (submission.key === key) submission.edited = true;
}

/** The hook moved `from`'s draft to `to` for a confirmed identity change (not navigation). Pending submissions follow
 *  it only while its content is still exactly what they sent and nothing edited it; otherwise they let go of it. */
export function moveDraftSubmissions(from: string, to: string): void {
  const moved = drafts.get(to);
  for (const submission of submissions) {
    if (submission.key !== from) continue;
    if (submission.edited || !submission.snapshot || !moved || !isSameDraft(moved, submission.snapshot)) submission.key = undefined;
    else {
      submission.key = to;
      submission.revision = getDraftRevision(to);
    }
  }
}

/** Edit generation of a key's draft: bumps on every content change (not on a same-content rewrite such as hydration or
 *  a navigation save), so a clear-and-retype of equal text is a different revision. -1 when there is no draft; a draft
 *  restored from sessionStorage and never edited since is 0. */
export function getDraftRevision(key: string): number {
  return drafts.has(key) ? revisions.byKey.get(key) ?? 0 : -1;
}

/** Content equality by field, without re-encoding attachment payloads; absent and empty `uploads` are equal. */
export function isSameDraft(a: ChatDraft | undefined, b: ChatDraft): boolean {
  if (!a || a.value !== b.value || a.images.length !== b.images.length || a.files.length !== b.files.length) return false;
  const uploadsA = a.uploads ?? [];
  const uploadsB = b.uploads ?? [];
  return uploadsA.length === uploadsB.length
    && a.images.every((image, i) => image.data === b.images[i].data && image.mimeType === b.images[i].mimeType)
    && a.files.every((file, i) => file.name === b.files[i].name && file.mimeType === b.files[i].mimeType && file.content === b.files[i].content && file.size === b.files[i].size)
    && uploadsA.every((upload, i) => upload.id === uploadsB[i].id && upload.name === uploadsB[i].name && upload.size === uploadsB[i].size && upload.hostId === uploadsB[i].hostId && upload.proof === uploadsB[i].proof);
}

/** A durable outbox commit consumes only the draft it was sent from: the same edit revision AND unchanged content
 *  (also after a composer remount). Any later edit, even one that restores the same text, keeps the draft. */
export function consumeDraft(key: string, snapshot: ChatDraft, revision: number): void {
  if (getDraftRevision(key) !== revision || !isSameDraft(drafts.get(key), snapshot)) return;
  clearDraft(key);
  for (const listener of consumptionListeners) listener(key, snapshot);
}

export function subscribeDraftConsumption(listener: (key: string, snapshot: ChatDraft) => void): () => void {
  consumptionListeners.add(listener);
  return () => { consumptionListeners.delete(listener); };
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
    ...(draft.uploads?.length ? { uploads: draft.uploads.map((upload) => ({ ...upload })) } : {}),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.files.length === 0 && !draft.uploads?.length;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function recoverDraft(key: string, recovery: DraftRecovery): void {
  if (key) {
    const draft = getDraft(key) ?? { value: "", images: [], files: [] };
    setDraft(key, {
      ...draft,
      value: mergeRecoveredText(draft.value, recovery),
      images: [...draft.images, ...(recovery.images ?? [])],
      uploads: [...(draft.uploads ?? []), ...(recovery.uploads ?? [])],
    });
  }
  // Publish the recovery intent separately: ordinary persistence must not
  // reapply it, and the mounted composer may have React updates still queued.
  for (const listener of recoveryListeners) listener(key, recovery);
}

export function getDraftSummary(key: string): { text: string; hasAttachments: boolean } {
  const draft = drafts.get(key);
  if (!draft) return { text: "", hasAttachments: false };
  return {
    text: draft.value,
    hasAttachments: draft.images.length > 0 || draft.files.length > 0 || Boolean(draft.uploads?.length),
  };
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  if (drafts.size >= MAX_DRAFTS && !drafts.has(key)) {
    const oldestKey = drafts.keys().next().value;
    if (oldestKey !== undefined) clearDraft(oldestKey);
  }
  const next = cloneDraft(draft);
  if (!isSameDraft(drafts.get(key), next)) {
    revisions.byKey.set(key, ++revisions.last);
    markSubmissionsEdited(key);
  }
  drafts.set(key, next);
  try {
    // Persist only text: attachment payloads can exhaust the tab's storage quota.
    if (draft.value) sessionStorage.setItem(STORAGE_PREFIX + key, draft.value);
    else sessionStorage.removeItem(STORAGE_PREFIX + key);
    if (draft.uploads?.length) sessionStorage.setItem(UPLOADS_STORAGE_PREFIX + key, JSON.stringify(draft.uploads));
    else sessionStorage.removeItem(UPLOADS_STORAGE_PREFIX + key);
  } catch {
    // Preserve the in-memory draft if storage is unavailable or full.
  }
  for (const listener of listeners) listener();
}

export function clearDraft(key: string): void {
  const deleted = drafts.delete(key);
  revisions.byKey.delete(key);
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + key);
    sessionStorage.removeItem(UPLOADS_STORAGE_PREFIX + key);
  } catch {
    // Storage may be unavailable.
  }
  if (deleted) {
    for (const listener of listeners) listener();
  }
}
