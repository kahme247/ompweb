import { readFile } from "node:fs/promises";
import { fetchMediaFromHosts } from "@/lib/hosts/session-index";
import { createThumbnail, existingThumbnail, imageMimeType, mediaFilePath, storeMediaCopy } from "@/lib/media-cache";

export const dynamic = "force-dynamic";

function image(body: Buffer, type: string, immutable = true): Response {
  // A view, not a copy: these buffers come from readFile/sharp, never a SharedArrayBuffer.
  return new Response(new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength), {
    headers: {
      "Content-Type": type,
      // Content-addressed: the bytes behind a hash never change.
      "Cache-Control": immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** GET /api/media/<sha256>[?thumb=1] — a tool-result image, or its small WebP preview. */
export async function GET(req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const thumb = new URL(req.url).searchParams.has("thumb");
  const cached = thumb ? existingThumbnail(hash) : null;
  const cachedBytes = cached ? await readIfPresent(cached) : null;
  if (cachedBytes) return image(cachedBytes, "image/webp");

  // The sweep can delete our copy between lookup and read once omp's blob is
  // complete; one more lookup then finds the blob.
  let bytes: Buffer | null = null;
  for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
    const file = mediaFilePath(hash);
    if (!file) break;
    bytes = await readIfPresent(file);
  }
  // A remote session's image: ask the linked hosts (only bytes that hash to `hash` come back).
  const remote = bytes ? null : await fetchMediaFromHosts(hash);
  if (remote) bytes = Buffer.from(remote.buffer, remote.byteOffset, remote.byteLength);
  if (!bytes) return new Response("Not found", { status: 404 });
  const type = imageMimeType(bytes);
  if (!type) return new Response("Not an image", { status: 415 });
  if (remote) {
    try {
      storeMediaCopy(hash, remote);
    } catch {
      // Disk trouble: still serve it, the next request asks again.
    }
  }
  if (thumb) {
    const preview = await createThumbnail(hash, bytes);
    if (preview) return image(preview, "image/webp");
    // Full image standing in for a preview: not cached, so a later preview can replace it.
    return image(bytes, type, false);
  }
  return image(bytes, type);
}
