/**
 * The attachment budget shared by the composer and the agent routes.
 *
 * Next 16.3 buffers a request body in `proxy.ts` before the route handler runs
 * and rejects anything past its 10 MB default, so the whole JSON command has to
 * stay under that ceiling. Everything below is derived from it: the request cap
 * leaves margin under the proxy boundary, and the aggregate image cap leaves
 * room for base64's 4/3 inflation plus the prompt text inside the request cap.
 *
 * Browser-safe by construction (no Node imports): the composer preflights the
 * exact prompt it is about to send with the same numbers the routes enforce.
 */

/** Complete JSON body accepted by POST /api/agent/[id] and /api/agent/new. */
export const MAX_AGENT_COMMAND_REQUEST_BYTES = 8 * 1024 * 1024;
/** Decoded bytes of all images in one message (~6.7 MiB once base64-encoded). */
export const MAX_TOTAL_ATTACHED_IMAGE_BYTES = 5 * 1024 * 1024;
/** Decoded bytes of a single image; a lone image may fill the whole budget. */
export const MAX_ATTACHED_IMAGE_BYTES = MAX_TOTAL_ATTACHED_IMAGE_BYTES;
export const MAX_ATTACHED_IMAGES = 10;

/** `{"type":"image","data":"","mimeType":""},` plus slack for the mime type. */
const IMAGE_ENTRY_OVERHEAD_BYTES = 96;
/** Command type, streaming behavior, and the surrounding JSON object. */
const COMMAND_ENVELOPE_BYTES = 256;

export interface Base64ImageAttachment {
  data: string;
  mimeType: string;
}

function megabytes(bytes: number): number {
  return bytes / (1024 * 1024);
}

function isBase64DataChar(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

export function getBase64DecodedByteLength(data: string): number | null {
  if (!data || data.length % 4 !== 0) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const dataEnd = data.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64DataChar(data.charCodeAt(index))) return null;
  }
  for (let index = dataEnd; index < data.length; index += 1) {
    if (data[index] !== "=") return null;
  }
  return (data.length / 4) * 3 - padding;
}

function getImageByteLengthWithinLimits(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const image = value as Partial<Base64ImageAttachment>;
  if (typeof image.data !== "string" || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
    return null;
  }
  const bytes = getBase64DecodedByteLength(image.data);
  return bytes !== null && bytes <= MAX_ATTACHED_IMAGE_BYTES ? bytes : null;
}

export function isBase64ImageWithinLimits(value: unknown): value is Base64ImageAttachment {
  return getImageByteLengthWithinLimits(value) !== null;
}

/** Count, per-image, and aggregate rules — the part the composer preflight and
 * the RPC layer must agree on. Wire-shape checks stay in `validateAgentImages`. */
function validateImageBudget(images: readonly unknown[]): string | null {
  if (images.length > MAX_ATTACHED_IMAGES) {
    return `A message can include at most ${MAX_ATTACHED_IMAGES} images`;
  }
  let totalBytes = 0;
  for (const image of images) {
    const bytes = getImageByteLengthWithinLimits(image);
    if (bytes === null) {
      return `Each image must be valid base64 image data of ${megabytes(MAX_ATTACHED_IMAGE_BYTES)}MB or smaller`;
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_ATTACHED_IMAGE_BYTES) {
    return `Attached images must total ${megabytes(MAX_TOTAL_ATTACHED_IMAGE_BYTES)}MB or less`;
  }
  return null;
}

/** Return an API-safe error for prompt, steering, and follow-up image arrays. */
export function validateAgentImages(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "images must be an array";
  for (const image of value) {
    if (!image || typeof image !== "object" || (image as { type?: unknown }).type !== "image") {
      return "Each attachment must be an image";
    }
  }
  return validateImageBudget(value);
}

/** UTF-8 size of a string once JSON-escaped. */
function jsonStringByteLength(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Size of the JSON command body an outgoing prompt produces. Base64 data is
 * ASCII and needs no escaping, so it is measured by length instead of being
 * re-serialized. */
export function getAgentRequestByteLength(message: string, images: readonly Base64ImageAttachment[] = []): number {
  let bytes = COMMAND_ENVELOPE_BYTES + jsonStringByteLength(message);
  for (const image of images) {
    bytes += IMAGE_ENTRY_OVERHEAD_BYTES + image.data.length + jsonStringByteLength(image.mimeType);
  }
  return bytes;
}

/** Preflight for the composer: reject a prompt the agent routes would refuse,
 * before any optimistic UI state or input clearing happens. */
export function validateOutgoingPrompt(
  message: string,
  images: readonly Base64ImageAttachment[] = [],
): string | null {
  const imageError = validateImageBudget(images);
  if (imageError) return imageError;
  if (getAgentRequestByteLength(message, images) > MAX_AGENT_COMMAND_REQUEST_BYTES) {
    return `This message is too large to send: keep it under ${megabytes(MAX_AGENT_COMMAND_REQUEST_BYTES)}MB including attachments.`;
  }
  return null;
}
