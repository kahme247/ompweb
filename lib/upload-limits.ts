/**
 * Wire limits for `POST /api/files/[...path]?type=upload`, shared by the route,
 * `next.config.ts` and the clients (web `components/FileExplorer.tsx`, the
 * Android `FileTransfer`).
 *
 * `experimental.proxyClientMaxBodySize` is the pre-auth body buffer: Next reads
 * and buffers every proxied request body up to that size *before* `proxy.ts`
 * can answer 401, so it is an unauthenticated memory budget (an anonymous
 * `POST` of N bytes costs N bytes of server memory until the body is read).
 * It therefore sits just above [MAX_UPLOAD_FILE_BYTES] + multipart framing, not
 * above a whole selection: one request carries at most
 * [MAX_UPLOAD_REQUEST_FILE_BYTES] of file bytes, and a larger selection is
 * uploaded as several requests (`batchUploadFiles`). [MAX_UPLOAD_TOTAL_BYTES]
 * is the budget of one such selection across those requests; the server cannot
 * see across requests, so each side enforces its half.
 */
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
/** File bytes one request may carry (also enforced by the route, per request). */
export const MAX_UPLOAD_REQUEST_FILE_BYTES = 25 * 1024 * 1024;
/** One user selection uploads at most this much, in `MAX_UPLOAD_REQUEST_FILE_BYTES` batches. */
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
/** Multipart boundaries, part headers and file names are not file bytes, but must be bounded too. */
export const MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
/** Body limit of one upload request: the route's parse cap and the proxy's pre-auth buffer. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_REQUEST_FILE_BYTES + MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES;

/**
 * Split one selection into requests of at most `maxBytes` file bytes. A single
 * file larger than the cap keeps a batch of its own: the server answers its
 * unchanged per-file 413 instead of the batch silently dropping it.
 */
export function batchUploadFiles<T extends { size: number }>(
  files: readonly T[],
  maxBytes: number = MAX_UPLOAD_REQUEST_FILE_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const file of files) {
    if (current.length > 0 && currentBytes + file.size > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
