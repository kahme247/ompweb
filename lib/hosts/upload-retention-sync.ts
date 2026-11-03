// Main's side of upload retention (docs/specs/2026-11-02-file-uploads-design.md, U6): every daemon is told the
// `uploadRetentionDays` setting when it links and when the setting changes. No `next/*` or `@/` imports.
import { loadWebServerSettings } from "../web-settings";
import { listHosts, onHostHello, setHostUploadRetention } from "./hub";
import { HostOpError } from "./link-protocol";
import { LOCAL_HOST_ID } from "./registry";

function send(hostId: string, days: number | null): void {
  // Nothing awaits it, and an unhandled rejection stops the server (instrumentation.node.ts).
  setHostUploadRetention(hostId, days).catch((error: unknown) => {
    // 501: a daemon from before the op keeps what it has. 503: offline, the next hello tells it.
    if (error instanceof HostOpError && (error.status === 501 || error.status === 503)) return;
    console.warn(`[omp-web] could not set the upload retention on host ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** The setting changed: tell this machine's daemon and every linked host's. */
export function pushUploadRetention(days: number | null): void {
  for (const hostId of [LOCAL_HOST_ID, ...listHosts().map((host) => host.id)]) send(hostId, days);
}

/** From now on every daemon that says hello is told the current setting. Returns the unsubscribe. */
export function startUploadRetentionSync(): () => void {
  return onHostHello((hostId) => send(hostId, loadWebServerSettings().uploadRetentionDays));
}
