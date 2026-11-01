export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the allowed size");
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/** Read the complete wire body, bounding chunked requests too, where
 * Content-Length is unavailable or false. */
export async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      size += value.byteLength;
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read UTF-8 JSON input without allowing chunked bodies to bypass the limit. */
export async function parseJsonWithinLimit<T>(request: Request, maxBytes: number): Promise<T> {
  const bytes = await readBodyWithinLimit(request, maxBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
}

/** Parse multipart data only after constraining the complete wire body. */
export async function parseFormDataWithinLimit(request: Request, maxBytes: number): Promise<FormData> {
  if (!request.body) return request.formData();
  const bytes = await readBodyWithinLimit(request, maxBytes);
  const contentType = request.headers.get("content-type");
  const headers = contentType ? { "content-type": contentType } : undefined;
  return new Response(new Blob([bytes]), { headers }).formData();
}
