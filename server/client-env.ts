import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// Build-time constants for the browser bundle; the build script and the dev server use the same values.
export function clientEnv(root: string) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  // public/event-stream-worker.js is served as-is (not bundled). SharedWorkers
  // are keyed by URL, so hash its content into the URL: a changed worker gets a
  // fresh instance instead of tabs attaching to a stale copy still running.
  const eventStreamWorkerVersion = createHash("sha256")
    .update(readFileSync(path.join(root, "public", "event-stream-worker.js")))
    .digest("hex")
    .slice(0, 12);
  return {
    OMP_WEB_PUBLIC_APP_VERSION: version,
    OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION: eventStreamWorkerVersion,
  };
}
