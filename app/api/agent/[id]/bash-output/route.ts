import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  MAX_INLINE_BASH_OUTPUT_BYTES,
  openRegularFileNoFollow,
  readUtf8FileWithinLimit,
  resolveBashOutputPath,
} from "@/lib/bash-output";
import { isBashOutputPathReferencedBySession } from "@/lib/session-file-references";

// GET /api/agent/[id]/bash-output?path=<absPath>[&download=1]
// Serves the full output of a bash execution whose session entry recorded a
// `fullOutputPath` temp file. Inline display is size-limited (413 when the
// file exceeds MAX_INLINE_BASH_OUTPUT_BYTES); `download=1` streams the file
// without buffering it. Access requires the session to actually reference the
// path — a path alone is never enough.
export async function GET(
  _req: Request,
  { params, disableIdleTimeout }: { params: Promise<{ id: string }>; disableIdleTimeout: () => void }
) {
  const { id } = await params;
  let path: string | null = null;
  let download = false;
  try {
    const url = new URL(_req.url);
    path = url.searchParams.get("path");
    download = url.searchParams.get("download") === "1";
  } catch {
    return Response.json({ error: "invalid url" }, { status: 400 });
  }

  if (!path) {
    return Response.json({ error: "path required" }, { status: 400 });
  }

  const resolved = resolveBashOutputPath(path, tmpdir());
  if (!resolved) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }

  if (!await isBashOutputPathReferencedBySession(resolved, id)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    if (download) {
      const { handle } = await openRegularFileNoFollow(resolved);
      const stream = Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>;
      disableIdleTimeout();
      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"bash-output.log\"",
          "Cache-Control": "no-store",
        },
      });
    }

    const result = await readUtf8FileWithinLimit(resolved);
    if (result.tooLarge) {
      return Response.json({
        error: `Full output is too large to display (limit ${MAX_INLINE_BASH_OUTPUT_BYTES} bytes)`,
        data: { size: result.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES },
      }, { status: 413 });
    }
    return Response.json({ success: true, data: { output: result.content } });
  } catch {
    return Response.json({ error: "full output unavailable" }, { status: 404 });
  }
}
