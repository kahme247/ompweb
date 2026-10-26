import type { ChatDraftFile, ChatDraftImage } from "@/lib/draft-store";
import type { AttachedTextFileData } from "@/lib/chat-attachments";
import { isBase64ImageWithinLimits } from "@/lib/image-attachments";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

export type AttachedTextFile = AttachedTextFileData;

export function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

export function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

/** Every image comes back, even past MAX_ATTACHED_IMAGES (recovered queue
 *  messages can exceed it); sending enforces the cap, so the user chooses. */
export function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .map(draftImageToAttachedImage);
}

export function textFileToDraftFile(file: AttachedTextFile): ChatDraftFile {
  return { name: file.name, mimeType: file.mimeType, content: file.content, size: file.size };
}

/** Recovery and Edit relocation can merge individually valid drafts past picker
 *  budgets. Keep every well-formed file; sending validates the composed request,
 *  not the picker file-count or text-byte limits. */
export function draftFilesToAttachedFiles(files: ChatDraftFile[] | undefined): AttachedTextFile[] {
  return (files ?? []).filter((file) => file !== null && typeof file === "object"
    && typeof file.name === "string"
    && typeof file.mimeType === "string"
    && typeof file.content === "string"
    && Number.isFinite(file.size)
    && file.size >= 0);
}

export function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}
