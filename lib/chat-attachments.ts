/**
 * Text-attachment budget.
 *
 * Nothing on the OMP side limits these: attached file contents are inlined
 * into the prompt as text, and OMP's RPC transport advertises (in its `ready`
 * frame) `maxFrameBytes` 1 MiB with chunked v2 frames reassembling up to
 * 64 MiB — omp/18.1.17 accepts a 3 MB logical command frame. The binding
 * ceilings are omp-web's own 8 MiB JSON request body
 * (`MAX_AGENT_COMMAND_REQUEST_BYTES`) and the model's context window, so the
 * budget is enforced on the aggregate rather than per file.
 */
export const MAX_TOTAL_ATTACHED_TEXT_BYTES = 4 * 1024 * 1024;
/** A lone file may fill the whole text budget. */
export const MAX_ATTACHED_TEXT_BYTES = MAX_TOTAL_ATTACHED_TEXT_BYTES;
export const MAX_ATTACHED_TEXT_FILES = 10;

const TEXT_FILE_EXTENSIONS: Record<string, true> = {
  txt: true,
  text: true,
  md: true,
  markdown: true,
  mdx: true,
};

export interface AttachedTextFileData {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

function getFileExtension(name: string): string {
  return name.toLowerCase().replace(/\\/g, "/").split("/").pop()?.split(".").pop() ?? "";
}

/** Human-readable limit for the composer banners ("512 KB" / "4 MB"). */
export function formatAttachmentBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** Size with one decimal for chips and the prompt ("37 B", "1.2 MB"). */
export function formatReferenceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[unit]}`;
}

/** What the composer already holds (or has in flight) when a new batch lands. */
export interface TextAttachmentBudget {
  usedBytes: number;
  usedSlots: number;
}

export interface TextAttachmentSelection<T> {
  /** Candidates that fit the inline budget and slots. */
  accepted: T[];
  /** Candidates too large, over the aggregate budget, or past the free slots:
   *  they cannot be inlined and are attached as path references instead. */
  overflow: T[];
}

/**
 * Per-file, aggregate, and slot rules when adding text attachments. Persisted
 * drafts bypass picker budgets so recovery never silently drops saved files.
 */
export function selectTextAttachments<T extends { size: number }>(
  candidates: readonly T[],
  budget: TextAttachmentBudget,
): TextAttachmentSelection<T> {
  const accepted: T[] = [];
  const overflow: T[] = [];
  const remainingSlots = Math.max(0, MAX_ATTACHED_TEXT_FILES - budget.usedSlots);
  let totalBytes = budget.usedBytes;
  for (const candidate of candidates) {
    if (accepted.length >= remainingSlots
      || !Number.isFinite(candidate.size)
      || candidate.size > MAX_ATTACHED_TEXT_BYTES
      || totalBytes + candidate.size > MAX_TOTAL_ATTACHED_TEXT_BYTES) {
      overflow.push(candidate);
      continue;
    }
    totalBytes += candidate.size;
    accepted.push(candidate);
  }
  return { accepted, overflow };
}

/** Decoded text that cannot be inlined: NUL bytes, or U+FFFD replacement
 *  characters left by mis-decoded binary (e.g. UTF-16 text read as UTF-8). */
export function isBinaryText(content: string): boolean {
  return content.includes("\u0000") || content.includes("\uFFFD");
}

/**
 * Path-reference attachments: files and folders uploaded through
 * `/api/attachments` that the model reads with its own tools. The caps bound
 * one upload batch (one chip); bytes travel in chunks of
 * `ATTACHMENT_CHUNK_BYTES` because Next.js buffers at most 10 MB of a request
 * body while `proxy.ts` runs (`proxyClientMaxBodySize`).
 */
export const MAX_ATTACHMENT_BATCH_FILES = 2000;
export const MAX_ATTACHMENT_BATCH_BYTES = 200 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024;

export type AttachmentReferenceKind = "file" | "folder";

export interface AttachmentReferenceData {
  batchId: string;
  kind: AttachmentReferenceKind;
  /** Display name: the file or folder name. */
  name: string;
  /** Absolute server path of the uploaded file or folder. */
  path: string;
  /** Total bytes. */
  size: number;
  fileCount: number;
}

export type AttachmentBatchLimit =
  | { code: "attachment_too_many_files"; limit: number }
  | { code: "attachment_batch_too_large"; limit: number };

/** The batch cap a selection exceeds, checked before any upload starts. */
export function exceededAttachmentBatchLimit(fileCount: number, totalBytes: number): AttachmentBatchLimit | null {
  if (fileCount > MAX_ATTACHMENT_BATCH_FILES) return { code: "attachment_too_many_files", limit: MAX_ATTACHMENT_BATCH_FILES };
  if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) return { code: "attachment_batch_too_large", limit: MAX_ATTACHMENT_BATCH_BYTES };
  return null;
}

export function isAttachmentReferenceData(value: unknown): value is AttachmentReferenceData {
  if (value === null || typeof value !== "object") return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.batchId === "string"
    && (reference.kind === "file" || reference.kind === "folder")
    && typeof reference.name === "string"
    && typeof reference.path === "string"
    && reference.path.length > 0
    && Number.isSafeInteger(reference.size) && (reference.size as number) >= 0
    && Number.isSafeInteger(reference.fileCount) && (reference.fileCount as number) >= 0;
}

export function isTextAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  return file.type === "text/plain"
    || file.type === "text/markdown"
    || TEXT_FILE_EXTENSIONS[getFileExtension(file.name)] === true;
}

function languageForFile(name: string): string {
  const extension = getFileExtension(name);
  if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown";
  return "text";
}

function fenceForContent(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestRun + 1));
}

function describeReference(reference: AttachmentReferenceData): string {
  const size = formatReferenceBytes(reference.size);
  if (reference.kind === "file") return `- ${reference.path} (file, ${size})`;
  // A Windows server returns backslash paths; end the folder with the same separator.
  const separator = /^[A-Za-z]:\\|^\\\\/.test(reference.path) ? "\\" : "/";
  const folderPath = reference.path.endsWith(separator) ? reference.path : `${reference.path}${separator}`;
  const files = `${reference.fileCount} ${reference.fileCount === 1 ? "file" : "files"}`;
  return `- ${folderPath} (folder, ${files}, ${size})`;
}

/**
 * The prompt sent for a composer: typed text, then inlined text files, then
 * one block listing the uploaded paths the model should read with its tools.
 */
export function composeMessageWithAttachments(
  message: string,
  files: readonly AttachedTextFileData[],
  references: readonly AttachmentReferenceData[] = [],
): string {
  if (files.length === 0 && references.length === 0) return message;
  const blocks = files.map((file) => {
    const fence = fenceForContent(file.content);
    return `Attached file: ${file.name}\n${fence}${languageForFile(file.name)}\n${file.content}\n${fence}`;
  });
  if (references.length > 0) {
    blocks.push([
      "Attached paths (uploaded by the user; read them with your tools as needed):",
      ...references.map(describeReference),
    ].join("\n"));
  }
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
