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

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
}

// globalThis so dev Fast Refresh doesn't wipe drafts mid-typing.
declare global {
  var __ompChatDrafts: Map<string, ChatDraft> | undefined;
}

const MAX_DRAFTS = 50;
const drafts: Map<string, ChatDraft> = (globalThis.__ompChatDrafts ??= new Map());

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.files.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function getDraftSummary(key: string): { text: string; hasAttachments: boolean } {
  const draft = drafts.get(key);
  if (!draft) return { text: "", hasAttachments: false };
  return {
    text: draft.value,
    hasAttachments: draft.images.length > 0 || draft.files.length > 0,
  };
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  if (drafts.size >= MAX_DRAFTS && !drafts.has(key)) {
    const oldestKey = drafts.keys().next().value;
    if (oldestKey) drafts.delete(oldestKey);
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}
