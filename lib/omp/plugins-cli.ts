// Loaded by the host daemon too (Node, through jiti): relative imports and `node:*` modules only, no `Bun` global.
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Runs `omp <args>` and answers its stdout; rejects when omp is missing or fails, or when `signal` aborts it (the message is omp's own output, never more than its last 600 characters). */
export function runOmpCli(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) return Promise.reject(new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN."));
  const target = wrapWindowsScript(bin, args);
  // A .cmd launcher runs as cmd.exe, which dies alone when execFile's signal kills it: the abort kills the tree, omp included.
  const launcher = process.platform === "win32" && target.file === "cmd.exe";
  return new Promise((resolve, reject) => {
    const killTree = () => {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).once("error", () => child.kill());
    };
    const child = execFile(
      target.file,
      target.args,
      { timeout: timeoutMs, signal: launcher ? undefined : signal, maxBuffer: 16 * 1024 * 1024, env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }), windowsHide: true },
      (error, stdout, stderr) => {
        if (launcher) signal?.removeEventListener("abort", killTree);
        if (!error) return resolve(stdout);
        const detail = (stderr || stdout || error.message).replace(ANSI_RE, "").trim();
        reject(new Error(detail.slice(-600) || `omp ${args.join(" ")} failed`));
      },
    );
    if (!launcher || !signal) return;
    if (signal.aborted) killTree();
    else signal.addEventListener("abort", killTree, { once: true });
  });
}

interface OmpPluginList {
  npm?: { name: string; version?: unknown; enabled?: unknown; path?: unknown }[];
  marketplace?: { id: string; entries?: { scope?: string; version?: unknown; enabled?: boolean }[] }[];
}

/** The `dependencies` of omp's plugins package.json, beside the `node_modules` holding `plugin`; null when unreadable. */
async function declaredSources(plugin: { name: string; path?: unknown } | undefined): Promise<Record<string, unknown> | null> {
  if (typeof plugin?.path !== "string" || !plugin.path.endsWith(join("node_modules", plugin.name))) return null;
  try {
    const pkg = JSON.parse(await readFile(join(plugin.path, ...plugin.name.split("/").map(() => ".."), "..", "package.json"), "utf8"));
    return typeof pkg?.dependencies === "object" && pkg.dependencies !== null ? pkg.dependencies : null;
  } catch {
    return null;
  }
}

/** The installed plugins, from `omp plugin list --json`. A marketplace plugin counts by its first user-scope entry; one with none is skipped. A version that is not a string is null, and an npm plugin is enabled only with `enabled: true`, so one odd entry never makes members refuse the manifest. An npm plugin's `source` is its spec in omp's plugins package.json (null: none, a linked plugin), absent when that file cannot be read. A list of another shape rejects: it must never read as "no plugins", which members would apply by removing theirs. */
export async function listPlugins(run: (args: string[]) => Promise<string>): Promise<PluginEntry[]> {
  const list = parseJsonLoose<OmpPluginList>(await run(["plugin", "list", "--json"]));
  const named = (entry: unknown, key: "name" | "id") => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>)[key] === "string";
  if (!list || !Array.isArray(list.npm) || !Array.isArray(list.marketplace) || !list.npm.every((entry) => named(entry, "name")) || !list.marketplace.every((entry) => named(entry, "id"))) {
    throw new Error("`omp plugin list --json` did not print a plugin list.");
  }
  const sources = await declaredSources(list.npm.find((plugin) => typeof plugin.path === "string"));
  const plugins: PluginEntry[] = list.npm.map((plugin) => {
    const entry: PluginEntry = { kind: "npm", id: plugin.name, version: typeof plugin.version === "string" ? plugin.version : null, enabled: plugin.enabled === true };
    if (sources) entry.source = typeof sources[plugin.name] === "string" ? (sources[plugin.name] as string) : null;
    return entry;
  });
  for (const plugin of list.marketplace) {
    const entry = plugin.entries?.find((candidate) => candidate.scope === "user");
    if (entry) plugins.push({ kind: "marketplace", id: plugin.id, version: typeof entry.version === "string" ? entry.version : null, enabled: entry.enabled !== false });
  }
  return plugins;
}
