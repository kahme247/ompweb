import { readdirSync, realpathSync, statSync, type Stats } from "node:fs";
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

const PLUGIN_LIST_TTL_MS = 30_000;
const noStore = { "cache-control": "no-store" };

let plugins: { at: number; list: PluginEntry[] } | null = null;
let pluginRead: Promise<PluginEntry[]> | null = null;
let cached: { fingerprint: string; current: Current } | null = null;

/** One `omp plugin list` at a time. A failed read keeps the last good list (members remove the plugins the manifest lacks, so never an empty one), retried after the same lifetime; with no list ever read it is an error. */
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
  pluginRead ??= readPluginList().finally(() => {
    pluginRead = null;
  });
  return pluginRead;
}

const statOrNull = (path: string): Stats | null => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

/**
 * Path, file identity (device, inode), size, modification and change time, and executable bit of every file `buildManifest` would read, following links, without
 * reading any content. Mirrors buildManifest's walk (skipped `.git` and `node_modules`, link loops, `.yaml` standing in
 * for an absent `.yml`); a read error here only leaves the file out, and buildManifest then reports it.
 */
function treeFingerprint(roots: Record<ConfigRoot, string>): string {
  const parts: string[] = [];
  const note = (path: string, stat: Stats) => parts.push(`${path}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.mode & 0o100}`);
  const walk = (dir: string, walking: Set<string>) => {
    let real: string;
    let names: string[];
    try {
      real = realpathSync(dir);
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (walking.has(real)) return;
    walking.add(real);
    for (const name of names) {
      if (name === ".git") continue;
      const source = join(dir, name);
      const stat = statOrNull(source);
      if (stat?.isDirectory()) {
        if (name !== "node_modules") walk(source, walking);
      } else if (stat?.isFile()) note(source, stat);
    }
    walking.delete(real);
  };
  for (const entry of MIRRORED) {
    const base = join(roots[entry.root], entry.path);
    if (entry.kind === "dir") {
      if (statOrNull(base)?.isDirectory()) walk(base, new Set());
      continue;
    }
    const sources = entry.root === "agent" && (entry.path === "config.yml" || entry.path === "models.yml") ? [base, base.replace(/\.yml$/, ".yaml")] : [base];
    for (const source of sources) {
      const stat = statOrNull(source);
      if (!stat?.isFile()) continue;
      note(source, stat);
      break;
    }
  }
  return parts.join("\n");
}

/** Rebuilt only when the fingerprint (files, agent environment, plugin list) differs from the last build's. Throws ClusterConfigError. */
export async function currentClusterConfig(): Promise<Current> {
  const roots = { agent: getAgentDir(), home: homedir() };
  const list = await pluginList();
  const { agentEnv } = loadWebServerSettings();
  const fingerprint = JSON.stringify([treeFingerprint(roots), agentEnv, list]);
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
