import { NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ATTACHMENT_CHUNK_BYTES } from "@/lib/chat-attachments";
import {
  AttachmentError,
  completeAttachmentBatch,
  writeAttachmentChunks,
  type AttachmentChunk,
} from "@/lib/attachment-store";

export const dynamic = "force-dynamic";

// Multipart boundaries and part headers are not file bytes, but are bounded too.
const MAX_CHUNK_REQUEST_BYTES = ATTACHMENT_CHUNK_BYTES + 1024 * 1024;

type Params = { params: Promise<{ batchId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AttachmentError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

/** PUT multipart repeated (path, offset, data) parts → 200 { ok: true }. */
export async function PUT(request: Request, { params }: Params) {
  try {
    const { batchId } = await params;
    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_CHUNK_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Attachment chunk is too large", code: "attachment_chunk_too_large" }, { status: 413 });
      }
      return NextResponse.json({ error: "Invalid multipart body", code: "invalid_attachment" }, { status: 400 });
    }
    const paths = formData.getAll("path");
    const offsets = formData.getAll("offset");
    const data = formData.getAll("data");
    if (paths.length !== offsets.length || paths.length !== data.length) {
      return NextResponse.json({ error: "Each chunk needs a path, an offset and data", code: "invalid_attachment" }, { status: 400 });
    }
    const chunks: AttachmentChunk[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const chunkPath = paths[index];
      const offset = offsets[index];
      const blob = data[index];
      if (typeof chunkPath !== "string" || typeof offset !== "string" || !/^\d+$/.test(offset) || typeof blob === "string") {
        return NextResponse.json({ error: "Malformed attachment chunk", code: "invalid_attachment" }, { status: 400 });
      }
      chunks.push({ path: chunkPath, offset: Number(offset), data: new Uint8Array(await blob.arrayBuffer()) });
    }
    await writeAttachmentChunks(batchId, chunks);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST → 200 { batchId, kind, name, path, size, fileCount } once every byte arrived. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { batchId } = await params;
    return NextResponse.json(await completeAttachmentBatch(batchId));
  } catch (error) {
    return errorResponse(error);
  }
}
