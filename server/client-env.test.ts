import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { clientEnv } from "./client-env";

const root = path.join(import.meta.dir, "..");

test("clientEnv carries the package version and the worker content hash", () => {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const workerHash = createHash("sha256").update(readFileSync(path.join(root, "public", "event-stream-worker.js"))).digest("hex").slice(0, 12);
  assert.deepEqual(clientEnv(root), {
    OMP_WEB_PUBLIC_APP_VERSION: version,
    OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION: workerHash,
  });
});
