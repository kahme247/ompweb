import { getContentDisposition } from "./content-disposition";
import { getStreamSecurityHeaders } from "./file-types";
import type { Host } from "./hosts/host";
import { HostOpError, LINK_LIMITS } from "./hosts/link-protocol";
import type { WorkspaceRead } from "./workspace-types";

export function workspaceReadStream(host: Host, read: WorkspaceRead, start = 0, end = read.info.size - 1): ReadableStream<Uint8Array> {
  let offset = start;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await host.workspaceOps.closeFile(read.id).catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      if (offset > end) { await close(); controller.close(); return; }
      try {
        const length = Math.min(LINK_LIMITS.pieceBytes, end - offset + 1);
        const chunk = await host.workspaceOps.readFileChunk(read.id, offset, length);
        if (!chunk.ok) throw new HostOpError(chunk.status, chunk.code, chunk.error);
        if (chunk.value.byteLength !== length) throw new HostOpError(502, "host_bad_result", "The host sent an incomplete file chunk");
        if (closed) return;
        offset += length;
        controller.enqueue(chunk.value);
        if (offset > end) { await close(); controller.close(); }
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });
}

export function streamWorkspaceFile(host: Host, read: WorkspaceRead, contentType: string, rangeHeader: string | null, download = false): Response {
  const headers = {
    "Content-Type": contentType, "Cache-Control": "no-cache", "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(read.info.name, !download, "download"),
    ...getStreamSecurityHeaders(contentType),
  };
  if (!rangeHeader) return new Response(workspaceReadStream(host, read), { headers: { ...headers, "Content-Length": String(read.info.size) } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  let start = match?.[1] ? Number(match[1]) : 0;
  let end = match?.[2] ? Number(match[2]) : read.info.size - 1;
  if (match && !match[1] && match[2]) { start = Math.max(read.info.size - Number(match[2]), 0); end = read.info.size - 1; }
  if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= read.info.size) {
    void host.workspaceOps.closeFile(read.id).catch(() => {});
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${read.info.size}` } });
  }
  end = Math.min(end, read.info.size - 1);
  return new Response(workspaceReadStream(host, read, start, end), { status: 206, headers: {
    ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${read.info.size}`,
  } });
}

export async function readWorkspaceBytes(host: Host, read: WorkspaceRead, limit: number): Promise<Buffer> {
  try {
    if (read.info.size > limit) throw new HostOpError(413, "file_too_large_preview", "File too large for preview");
    const bytes = Buffer.allocUnsafe(read.info.size);
    let offset = 0;
    const reader = workspaceReadStream(host, read).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes.set(value, offset);
        offset += value.byteLength;
      }
    } finally { reader.releaseLock(); }
    return bytes;
  } finally { await host.workspaceOps.closeFile(read.id).catch(() => {}); }
}
