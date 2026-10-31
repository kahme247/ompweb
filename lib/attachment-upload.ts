import {
  ATTACHMENT_CHUNK_BYTES,
  isAttachmentReferenceData,
  type AttachmentReferenceData,
  type AttachmentReferenceKind,
} from "./chat-attachments";

/**
 * Browser side of `/api/attachments`: declare a batch, send its bytes in
 * bounded multipart chunks, then complete it. Also turns folder picks and
 * dropped directories into upload entries with their relative paths.
 */

export interface AttachmentUploadEntry {
  /** Relative to the batch root; a folder's paths start with its name. */
  path: string;
  file: Blob;
}

export interface AttachmentUploadRequest {
  kind: AttachmentReferenceKind;
  name: string;
  entries: readonly AttachmentUploadEntry[];
}

export interface AttachmentChunkPart {
  path: string;
  offset: number;
  blob: Blob;
}

/** A folder whose files are listed lazily (directory traversal is async). */
export interface FolderAttachmentSource {
  name: string;
  /** Stops after `limit + 1` files so an oversized tree is not walked whole. */
  entries: (limit: number) => Promise<AttachmentUploadEntry[]>;
}

/** `serverError` is the route's own reason when it sent one; otherwise the UI
 *  shows a localized reason from `status` (undefined: malformed success body). */
export class AttachmentUploadError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number | undefined,
    readonly serverError?: string,
  ) {
    super(message);
  }
}

// Each part adds ~200 bytes of multipart headers; keep a request of tiny
// files well inside the route's overhead allowance.
const MAX_PARTS_PER_CHUNK = 500;

/** Group entries into requests of at most `chunkBytes` file bytes, splitting
 *  large files. Empty files need no part: the batch creates them. */
export function planAttachmentChunks(
  entries: readonly AttachmentUploadEntry[],
  chunkBytes = ATTACHMENT_CHUNK_BYTES,
  maxParts = MAX_PARTS_PER_CHUNK,
): AttachmentChunkPart[][] {
  const requests: AttachmentChunkPart[][] = [];
  let current: AttachmentChunkPart[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    let offset = 0;
    while (offset < entry.file.size) {
      if (currentBytes >= chunkBytes || current.length >= maxParts) {
        requests.push(current);
        current = [];
        currentBytes = 0;
      }
      const length = Math.min(entry.file.size - offset, chunkBytes - currentBytes);
      current.push({ path: entry.path, offset, blob: entry.file.slice(offset, offset + length) });
      currentBytes += length;
      offset += length;
    }
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON failures (proxies, crashes) are reported by status below.
  }
  if (!response.ok) {
    const payload = (body ?? {}) as { error?: unknown; code?: unknown };
    const serverError = typeof payload.error === "string" ? payload.error : undefined;
    throw new AttachmentUploadError(
      serverError ?? `Upload failed (HTTP ${response.status})`,
      typeof payload.code === "string" ? payload.code : undefined,
      response.status,
      serverError,
    );
  }
  return body;
}

export async function uploadAttachment(
  { kind, name, entries }: AttachmentUploadRequest,
  { fetchImpl = fetch, onProgress }: { fetchImpl?: typeof fetch; onProgress?: (uploadedBytes: number) => void } = {},
): Promise<AttachmentReferenceData> {
  const created = await requestJson(fetchImpl, "/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, name, files: entries.map((entry) => ({ path: entry.path, size: entry.file.size })) }),
  }) as { batchId?: unknown };
  if (typeof created?.batchId !== "string") throw new AttachmentUploadError("Upload failed: no batch id", undefined, undefined);
  const batchUrl = `/api/attachments/${encodeURIComponent(created.batchId)}`;
  let uploaded = 0;
  for (const parts of planAttachmentChunks(entries)) {
    const form = new FormData();
    for (const part of parts) {
      form.append("path", part.path);
      form.append("offset", String(part.offset));
      form.append("data", part.blob, "chunk");
    }
    await requestJson(fetchImpl, batchUrl, { method: "PUT", body: form });
    uploaded += parts.reduce((total, part) => total + part.blob.size, 0);
    onProgress?.(uploaded);
  }
  const reference = await requestJson(fetchImpl, batchUrl, { method: "POST" });
  if (!isAttachmentReferenceData(reference)) throw new AttachmentUploadError("Upload failed: malformed response", undefined, undefined);
  return reference;
}

/** A folder input (`webkitdirectory`) lists files with `webkitRelativePath`
 *  ("dataset/sub/a.csv"). Files without one (no folder support) stay loose. */
export function foldersFromDirectoryInput(files: readonly File[]): { folders: FolderAttachmentSource[]; looseFiles: File[] } {
  const grouped = new Map<string, AttachmentUploadEntry[]>();
  const looseFiles: File[] = [];
  for (const file of files) {
    const relativePath = file.webkitRelativePath;
    const slash = relativePath ? relativePath.indexOf("/") : -1;
    if (slash <= 0) {
      looseFiles.push(file);
      continue;
    }
    const name = relativePath.slice(0, slash);
    const group = grouped.get(name) ?? [];
    group.push({ path: relativePath, file });
    grouped.set(name, group);
  }
  const folders = [...grouped].map(([name, entries]): FolderAttachmentSource => ({
    name,
    entries: async () => entries,
  }));
  return { folders, looseFiles };
}

function readDirectoryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Walk a dropped directory (`webkitGetAsEntry`), depth first. */
export function folderFromDirectoryEntry(root: FileSystemDirectoryEntry): FolderAttachmentSource {
  return {
    name: root.name,
    async entries(limit) {
      const collected: AttachmentUploadEntry[] = [];
      const walk = async (directory: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
        const reader = directory.createReader();
        // readEntries returns the listing in batches until an empty one.
        for (let batch = await readDirectoryBatch(reader); batch.length > 0; batch = await readDirectoryBatch(reader)) {
          for (const child of batch) {
            if (collected.length > limit) return;
            const childPath = `${prefix}/${child.name}`;
            if (child.isDirectory) await walk(child as FileSystemDirectoryEntry, childPath);
            else if (child.isFile) collected.push({ path: childPath, file: await readEntryFile(child as FileSystemFileEntry) });
          }
        }
      };
      await walk(root, root.name);
      return collected;
    },
  };
}

/** Split a drop into plain files and directories. Must run inside the drop
 *  event: DataTransfer items are emptied once it returns. */
export function splitDroppedItems(dataTransfer: DataTransfer): { files: File[]; folders: FolderAttachmentSource[] } {
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
  if (items.length === 0 || typeof items[0].webkitGetAsEntry !== "function") {
    return { files: Array.from(dataTransfer.files), folders: [] };
  }
  const files: File[] = [];
  const folders: FolderAttachmentSource[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      folders.push(folderFromDirectoryEntry(entry as FileSystemDirectoryEntry));
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}
