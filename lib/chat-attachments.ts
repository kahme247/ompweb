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

/** What the composer already holds (or has in flight) when a new batch lands. */
export interface TextAttachmentBudget {
  usedBytes: number;
  usedSlots: number;
}

export interface TextAttachmentSelection<T> {
  accepted: T[];
  /** Candidates dropped for exceeding the per-file cap. */
  tooLarge: number;
  /** Candidates dropped because the message's aggregate text budget was spent. */
  overBudget: number;
}

/**
 * Per-file, aggregate, and slot rules for text attachments — the single place
 * the composer and draft restore both enforce them. Candidates past the
 * remaining slots are dropped silently, matching the count cap handled by the
 * caller; a candidate too large on its own is reported before a budget miss so
 * the banner names the limit the user actually hit.
 */
export function selectTextAttachments<T extends { size: number }>(
  candidates: readonly T[],
  budget: TextAttachmentBudget,
): TextAttachmentSelection<T> {
  const accepted: T[] = [];
  const remainingSlots = Math.max(0, MAX_ATTACHED_TEXT_FILES - budget.usedSlots);
  let totalBytes = budget.usedBytes;
  let tooLarge = 0;
  let overBudget = 0;
  for (const candidate of candidates) {
    if (accepted.length >= remainingSlots) break;
    if (!Number.isFinite(candidate.size) || candidate.size > MAX_ATTACHED_TEXT_BYTES) {
      tooLarge++;
      continue;
    }
    if (totalBytes + candidate.size > MAX_TOTAL_ATTACHED_TEXT_BYTES) {
      overBudget++;
      continue;
    }
    totalBytes += candidate.size;
    accepted.push(candidate);
  }
  return { accepted, tooLarge, overBudget };
}

/** Banner text for a batch that produced no usable attachments. */
export function describeTextAttachmentSkip(
  selection: Pick<TextAttachmentSelection<unknown>, "tooLarge" | "overBudget">,
): string | null {
  if (selection.tooLarge > 0) {
    return `${selection.tooLarge} file(s) skipped: files up to ${formatAttachmentBytes(MAX_ATTACHED_TEXT_BYTES)} are supported.`;
  }
  if (selection.overBudget > 0) {
    return `${selection.overBudget} file(s) skipped: attachments are limited to ${formatAttachmentBytes(MAX_TOTAL_ATTACHED_TEXT_BYTES)} per message.`;
  }
  return null;
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

/** Add text-file contents to the prompt while keeping the attachment boundary clear. */
export function composeMessageWithTextAttachments(
  message: string,
  files: AttachedTextFileData[],
): string {
  if (files.length === 0) return message;
  const blocks = files.map((file) => {
    const fence = fenceForContent(file.content);
    return `Attached file: ${file.name}\n${fence}${languageForFile(file.name)}\n${file.content}\n${fence}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
