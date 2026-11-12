import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../omp/paths";
import { listPlugins, runOmpCli } from "../omp/plugins-cli";
import { loadWebServerSettings } from "../web-settings";
import { isClusterMember } from "./cluster";
import { buildManifest, ClusterConfigError, MIRRORED, type ConfigManifest, type ConfigRoot, type PluginEntry } from "./cluster-config";
import { hostFromBearer } from "./host-bearer";
import { loadPools } from "./pools";
import { LOCAL_HOST_ID, type HostRecord } from "./registry";

// The master's current configuration, as the two routes under /api/hosts/cluster-config/ serve it to cluster members.

type Current = { manifest: ConfigManifest; content(hash: string): Uint8Array | null };

// Four 30 s sync ticks: a plugin installed or removed on the master reaches the members within about two minutes.
const PLUGIN_LIST_TTL_MS = 120_000;
const noStore = { "cache-control": "no-store" };

let plugins: { at: number; list: PluginEntry[] } | null = null;
let building: Promise<Current> | null = null;
let cached: { fingerprint: string; current: Current } | null = null;

/** A failed read keeps the last good list (members remove the plugins the manifest lacks, so never an empty one), retried after the same lifetime; with no list ever read it is an error. */
async function readPluginList(): Promise<PluginEntry[]> {
  try {
    plugins = { at: Date.now(), list: await listPlugins((args) => runOmpCli(args, 30_000)) };
  } catch {
    // Never omp's own output: it may name paths or settings.
    console.log(`[omp-web] cluster-config the plugin list cannot be read${plugins ? "; serving the last one read" : ""}`);
    if (!plugins) throw new ClusterConfigError("unreadable", "the plugin list cannot be read (omp plugin list failed)");
    plugins = { at: Date.now(), list: plugins.list };
  }
  return plugins.list;
}

function pluginList(): Promise<PluginEntry[]> {
  if (plugins && Date.now() - plugins.at < PLUGIN_LIST_TTL_MS) return Promise.resolve(plugins.list);
  return readPluginList();
}

/**
 * Path, file identity (device, inode), size, modification and change time, and executable bit of every file `buildManifest` would read, following links, without
 * reading any content. Mirrors buildManifest's walk (skipped `.git` and `node_modules`, link loops, `.yaml` standing in
 * for an absent `.yml`). A read error makes the fingerprint unlike any other, so buildManifest runs and reports it
 * instead of a cached manifest standing.
 */
async function treeFingerprint(roots: Record<ConfigRoot, string>): Promise<string> {
  const parts: string[] = [];
  // Missing as buildManifest counts it (a broken link included); any other error is unreadable.
  const statOrNull = (path: string): Promise<Stats | null> =>
    stat(path).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code ?? "")) parts.push(randomUUID());
      return null;
    });
  const note = (path: string, stat: Stats) => parts.push(`${path}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.mode & 0o100}`);
  const walk = async (dir: string, walking: Set<string>) => {
    let real: string;
    let names: string[];
    try {
      real = await realpath(dir);
      names = await readdir(dir);
    } catch {
      parts.push(randomUUID());
      return;
    }
    if (walking.has(real)) return;
    walking.add(real);
    // One directory's entries are stat'ed together; the descent stays in order, so the fingerprint is the sequential walk's.
    const stats = await Promise.all(names.map((name) => (name === ".git" ? null : statOrNull(join(dir, name)))));
    for (const [i, name] of names.entries()) {
      const source = join(dir, name);
      if (stats[i]?.isDirectory()) {
        if (name !== "node_modules") await walk(source, walking);
      } else if (stats[i]?.isFile()) note(source, stats[i]);
    }
    walking.delete(real);
  };
  for (const entry of MIRRORED) {
    const base = join(roots[entry.root], entry.path);
    if (entry.kind === "dir") {
      if ((await statOrNull(base))?.isDirectory()) await walk(base, new Set());
      continue;
    }
    const sources = entry.root === "agent" && (entry.path === "config.yml" || entry.path === "models.yml") ? [base, base.replace(/\.yml$/, ".yaml")] : [base];
    for (const source of sources) {
      const found = await statOrNull(source);
      if (!found?.isFile()) continue;
      note(source, found);
      break;
    }
  }
  return parts.join("\n");
}

/**
 * Rebuilt only when the fingerprint (files, agent environment, plugin list) differs from the last build's. One build at
 * a time: concurrent callers share its walk, its `omp plugin list` and its result. Throws ClusterConfigError.
 */
export function currentClusterConfig(): Promise<Current> {
  building ??= build().finally(() => {
    building = null;
  });
  return building;
}

async function build(): Promise<Current> {
  const roots = { agent: getAgentDir(), home: homedir() };
  const list = await pluginList();
  const { agentEnv } = loadWebServerSettings();
  const fingerprint = JSON.stringify([await treeFingerprint(roots), agentEnv, list]);
  if (cached?.fingerprint === fingerprint) return cached.current;
  const current = buildManifest(roots, { agentEnv, plugins: list });
  cached = { fingerprint, current };
  return current;
}

export async function clusterConfigVersion(): Promise<string> {
  return (await currentClusterConfig()).manifest.version;
}

export const configFail = (error: string, status: number) => Response.json({ error }, { status, headers: noStore });

/** The cluster member the bearer token names, or the refusal to answer with: 401, 503 (unreadable `hosts.json` or `pools.json`) or 403. */
export function admitClusterMember(request: Request): HostRecord | Response {
  const host = hostFromBearer(request);
  if (host instanceof Response) return host;
  try {
    // `local` is refused by id, whatever pools.json says.
    if (host.id === LOCAL_HOST_ID || !isClusterMember(loadPools(), host.id)) return configFail("Not a cluster member", 403);
  } catch {
    return configFail("The host pool configuration cannot be read", 503);
  }
  return host;
}

/** A ClusterConfigError answers 409 with its code; anything else 500 without detail. Paths may be logged, never content. */
export function configErrorResponse(hostId: string, error: unknown): Response {
  if (error instanceof ClusterConfigError) {
    console.log(`[omp-web] cluster-config ${hostId} ${error.code} ${error.message}`);
    return Response.json({ error: error.message, code: error.code }, { status: 409, headers: noStore });
  }
  console.log(`[omp-web] cluster-config ${hostId} failed (${error instanceof Error ? error.name : "unknown"})`);
  return configFail("The configuration cannot be served", 500);
}
