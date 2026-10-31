import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  AttachmentError,
  createAttachmentBatch,
  maybePruneAttachmentBatches,
  parseAttachmentBatchRequest,
} from "@/lib/attachment-store";

export const dynamic = "force-dynamic";

// 2,000 paths of up to 1,024 characters each, plus JSON punctuation.
const MAX_BATCH_REQUEST_BYTES = 3 * 1024 * 1024;

/** POST { kind, name, files: [{ path, size }] } → 201 { batchId }. Every cap
 *  and path is checked here, before any file byte is uploaded. */
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await parseJsonWithinLimit<unknown>(request, MAX_BATCH_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Attachment manifest is too large", code: "attachment_manifest_too_large" }, { status: 413 });
      }
      return NextResponse.json({ error: "Invalid JSON body", code: "invalid_attachment" }, { status: 400 });
    }
    const batch = parseAttachmentBatchRequest(body);
    await maybePruneAttachmentBatches();
    return NextResponse.json(await createAttachmentBatch(batch), { status: 201 });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
