import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * lib/event-stream-worker.ts bundled for the browser: one classic script (a SharedWorker or dedicated Worker loads it
 * without `type: "module"`), wrapped so its names stay out of the worker's global scope. Served at
 * /event-stream-worker.js: written to dist/ by the build, from memory by the dev server.
 */
export async function buildEventStreamWorker(root: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [path.join(root, "lib", "event-stream-worker.ts")], target: "browser", format: "iife", minify: true, throw: false });
  if (!result.success) throw new AggregateError(result.logs, "Could not bundle lib/event-stream-worker.ts");
  return result.outputs[0].text();
}

// Build-time constants for the browser bundle; the build script and the dev server use the same values.
export function clientEnv(root: string, worker: string) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  let commitHash = "";
  let commitDate = "";
  try {
    const entries = Object.entries(process.env);
    const env = Object.fromEntries(entries.filter(([name]) => !name.toUpperCase().startsWith("GIT_") || /^GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)$/i.test(name)));
    // Preserve explicit ownership trust, not config that could redirect the repository.
    const count = Number(process.env.GIT_CONFIG_COUNT);
    let safeDirectories = 0;
    for (let i = 0; Number.isSafeInteger(count) && i < Math.min(count, entries.length); i++) {
      if (process.env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() !== "safe.directory") continue;
      const value = process.env[`GIT_CONFIG_VALUE_${i}`];
      if (value === undefined) continue;
      env[`GIT_CONFIG_KEY_${safeDirectories}`] = "safe.directory";
      env[`GIT_CONFIG_VALUE_${safeDirectories}`] = value;
      safeDirectories++;
    }
    if (safeDirectories > 0) env.GIT_CONFIG_COUNT = String(safeDirectories);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!git("rev-parse", "--show-prefix") && !git("tag", "--points-at", "HEAD")) {
      [commitHash, commitDate] = git("log", "-1", "--no-show-signature", "--format=%H%n%cs").split("\n");
    }
  } catch {
    // Source archives and installed packages need not have Git metadata or Git installed.
  }
  // SharedWorkers are keyed by URL, so the worker bundle's hash goes into its URL: a changed worker gets a fresh
  // instance instead of tabs attaching to a stale copy still running.
  const eventStreamWorkerVersion = createHash("sha256").update(worker).digest("hex").slice(0, 12);
  return {
    OMP_WEB_PUBLIC_APP_VERSION: version,
    OMP_WEB_PUBLIC_COMMIT_HASH: commitHash,
    OMP_WEB_PUBLIC_COMMIT_DATE: commitDate,
    OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION: eventStreamWorkerVersion,
  };
}
