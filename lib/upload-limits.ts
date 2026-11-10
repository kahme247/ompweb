// Composer upload limits and the upload id form (docs/specs/2026-11-02-file-uploads-design.md). Pure: the browser,
// the main server and the host daemon all import it (the daemon through jiti: no `@/` imports).

/** Largest file one upload may carry. */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
/** Most uploads one prompt may attach. */
export const MAX_UPLOADS_PER_MESSAGE = 20;
/** Bytes of one upload a sender keeps in flight beyond the host's last ack (spec U4). */
export const UPLOAD_WINDOW_BYTES = 2 * 1024 * 1024;
/** An upload the host's acks do not advance for this long has stalled: the worker fails it, and the tab resumes it. */
export const UPLOAD_STALL_MS = 120_000;
/** An upload id: a client-made UUID v4, lowercase. */
export const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 12.3 MB: decimal units, as file managers show sizes. The chip and the prompt block must agree. */
export function formatUploadSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Sent uploads are deleted after this many days unless the setting says otherwise (the media cache's 30-day sweep, lib/media-cache.ts). */
export const DEFAULT_UPLOAD_RETENTION_DAYS = 30;
/** `uploadRetentionDays` (web setting) and the `setUploadRetention` op's `days`: `null` keeps sent uploads for ever. */
export function isUploadRetentionDays(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3650);
}
