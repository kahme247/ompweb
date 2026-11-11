// Loaded by the host daemon too (Node, through jiti): relative imports and `node:*` modules only, no `Bun` global.
import { execFile } from "node:child_process";
import type { PluginEntry } from "../hosts/cluster-config";
import { createChildProcessEnvironment } from "../project-command-env";
import { resolveOmpBin, wrapWindowsScript } from "./omp-cli";

export const ANSI_RE = /\x1B\[[0-9;]*m/g;

/** Parse `--json` stdout, tolerating stray non-JSON lines before the payload. */
export function parseJsonLoose<T>(stdout: string): T | null {
  const cleaned = stdout.replace(ANSI_RE, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start)) as T;
  } catch {
    return null;
  }
}

/** Runs `omp <args>` and answers its stdout; rejects when omp is missing or fails (the message is omp's own output, never more than its last 600 characters). */
export function runOmpCli(args: string[], timeoutMs: number): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) return Promise.reject(new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN."));
  const target = wrapWindowsScript(bin, args);
  return new Promise((resolve, reject) => {
    execFile(
      target.file,
      target.args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }), windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const detail = (stderr || stdout || error.message).replace(ANSI_RE, "").trim();
        reject(new Error(detail.slice(-600) || `omp ${args.join(" ")} failed`));
      },
    );
  });
}

interface OmpPluginList {
  npm?: { name: string; version: string; enabled: boolean }[];
  marketplace?: { id: string; entries?: { scope?: string; version?: string; enabled?: boolean }[] }[];
}

/** The installed plugins, from `omp plugin list --json`. A marketplace plugin counts by its first user-scope entry; one with none is skipped. */
export async function listPlugins(run: (args: string[]) => Promise<string>): Promise<PluginEntry[]> {
  const list = parseJsonLoose<OmpPluginList>(await run(["plugin", "list", "--json"]));
  if (!list) throw new Error("Could not parse `omp plugin list --json` output.");
  const plugins: PluginEntry[] = (list.npm ?? []).map((plugin) => ({ kind: "npm", id: plugin.name, version: plugin.version, enabled: plugin.enabled }));
  for (const plugin of list.marketplace ?? []) {
    const entry = plugin.entries?.find((candidate) => candidate.scope === "user");
    if (entry) plugins.push({ kind: "marketplace", id: plugin.id, version: entry.version ?? null, enabled: entry.enabled !== false });
  }
  return plugins;
}
