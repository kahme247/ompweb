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
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
  /** Finished uploads; unlike images and files they survive a reload (only their ids are stored). */
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
}

const MAX_DRAFTS = 50;
const STORAGE_PREFIX = "omp-draft-";
const UPLOADS_STORAGE_PREFIX = "omp-uploads-draft-";

function isDraftUpload(value: unknown): value is ChatDraftUpload {
  if (!value || typeof value !== "object") return false;
  const upload = value as Record<string, unknown>;
  return typeof upload.id === "string" && typeof upload.name === "string" && typeof upload.hostId === "string"
    && Number.isSafeInteger(upload.size) && (upload.size as number) >= 0;
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

export function hasUnsentDrafts(): boolean {
  return drafts.size > 0;
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeDraftRecovery(listener: (key: string, recovery: DraftRecovery) => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
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
  drafts.set(key, cloneDraft(draft));
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
