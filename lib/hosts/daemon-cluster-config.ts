// Host daemon only (Node, loaded through jiti): relative imports, `node:*` modules and the global fetch, no `Bun` global.
// A cluster member runs on the master's omp configuration (docs/specs/2026-11-11-cluster-configuration-design.md, K3-K6):
// a version is applied whole or not at all, and the member's own configuration waits in `own-config/` until it leaves.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { listPlugins } from "../omp/plugins-cli";
import { isRecord } from "../type-guards";
import { loadWebServerSettings, saveWebServerSettings } from "../web-settings";
import { CONFIG_LIMITS, isManagedPath, mergeLocalSettings, MIRRORED, type ConfigManifest, type ConfigRoot, type ManifestFile, type PluginEntry } from "./cluster-config";
import { HostOpError } from "./link-protocol";

export interface ConfigState { version: string | null; files: "none" | "current" | "failed"; plugins: "none" | "pending" | "current" | "failed"; error: string | null; missingCommands: string[] }

const API = "/api/hosts/cluster-config/";
const HASH_RE = /^[0-9a-f]{64}$/;
const LIST_MS = 60_000;
const INSTALL_MS = 300_000;
const UNINSTALL_MS = 120_000;
const TOGGLE_MS = 60_000;
// The manifest lists paths and hashes; a bundle at its 50 MiB limit is still far below this.
const MANIFEST_BYTES = 5_242_880;
// The mirrored entries, and the `.yaml` names omp reads when a `.yml` is absent: a member's own one waits in the backup
// under its own name, so the live tree holds only the manifest's `.yml`.
const ENTRIES: readonly { root: ConfigRoot; path: string }[] = [...MIRRORED, { root: "agent", path: "config.yaml" }, { root: "agent", path: "models.yaml" }];

/** A failure whose message is safe to report and log: paths and statuses, never content. */
class ApplyError extends Error {}
const fail = (reason: string): never => {
  throw new ApplyError(reason);
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const lastLine = (error: unknown) => messageOf(error).trim().split("\n").at(-1) ?? "";
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const removeAll = (path: string) => rmSync(path, { recursive: true, force: true });
/** Answers the topmost directory it created, if any. */
const makeDir = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });
const quietly = (step: () => void) => {
  try {
    step();
    return true;
  } catch {
    return false;
  }
};

/** `rename`, which moves a link as a link. It cannot cross filesystems: the reason then names the two directories. */
function move(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") fail(`${dirname(from)} and ${dirname(to)} are on different filesystems; cluster configuration needs them on one filesystem`);
    throw error;
  }
}

/** Written under a fresh name beside `path`, then renamed over it: never half a file, never written through a link at `path`. */
function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600) {
  makeDir(dirname(path));
  const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, data, { mode, flag: "wx" });
    chmodSync(temp, mode); // the umask may have narrowed it
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** JSON without the parser's own message, which quotes the input (the manifest and the backup hold secrets). */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} is not valid JSON`);
  }
}

const isPlugin = (p: unknown): p is PluginEntry =>
  isRecord(p) && (p.kind === "npm" || p.kind === "marketplace") && typeof p.id === "string" && /^[^-\s]\S*$/.test(p.id) && (p.version === null || typeof p.version === "string") && typeof p.enabled === "boolean";
const isFile = (f: unknown): f is ManifestFile =>
  isRecord(f) &&
  (f.root === "agent" || f.root === "home") &&
  typeof f.path === "string" &&
  typeof f.hash === "string" &&
  HASH_RE.test(f.hash) &&
  typeof f.size === "number" &&
  Number.isSafeInteger(f.size) &&
  f.size >= 0 &&
  f.size <= CONFIG_LIMITS.fileBytes &&
  typeof f.exec === "boolean";

/** The master's manifest, checked whole before anything touches the disk. */
function checkManifest(value: unknown): ConfigManifest {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !HASH_RE.test(value.version) ||
    !Array.isArray(value.files) ||
    !value.files.every(isFile) ||
    !isRecord(value.agentEnv) ||
    !Object.values(value.agentEnv).every((v) => typeof v === "string") ||
    !Array.isArray(value.plugins) ||
    !value.plugins.every(isPlugin)
  ) {
    return fail("the master's manifest is malformed");
  }
  const manifest = value as unknown as ConfigManifest;
  let total = 0;
  for (const file of manifest.files) {
    if (!isManagedPath(file.root, file.path)) fail(`the manifest names ${file.root}:${JSON.stringify(file.path)}, which is not a mirrored path`);
    total += file.size;
  }
  if (total > CONFIG_LIMITS.bundleBytes) fail(`the manifest exceeds ${CONFIG_LIMITS.bundleBytes} bytes`);
  return manifest;
}

/** The body, refused as soon as it passes `limit` bytes. */
async function readBody(res: Response, limit: number, tooLong: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      fail(tooLong);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Whether a member's own settings file is something `mergeLocalSettings` can keep values from. */
function readsAsMap(yaml: string): boolean {
  try {
    const doc = parseDocument(yaml);
    const value: unknown = doc.errors.length === 0 ? doc.toJS() : false;
    return value === null || value === undefined || isRecord(value);
  } catch {
    return false;
  }
}

/** The member's own settings in `dir`: `.yml` before `.yaml`, as omp reads them. */
function ownSettings(dir: string): { path: string; yaml: string } | null {
  for (const name of ["config.yml", "config.yaml"]) {
    const path = join(dir, name);
    try {
      return { path, yaml: readFileSync(path, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

export function createClusterConfig(deps: {
  roots(): Record<ConfigRoot, string>;
  stateDir(): string; // <agent dir>/omp-web
  fetch(serverUrl: string, path: string): Promise<Response>; // authenticated by the caller; path starts with /api/hosts/cluster-config/
  runOmp(args: string[], timeoutMs: number): Promise<string>;
  commandExists(command: string): Promise<boolean>;
  onState(state: ConfigState): void;
  log(message: string): void;
}) {
  let applied: { version: string; plugins: PluginEntry[] } | null = null;
  let files: ConfigState["files"] = "none";
  let plugins: ConfigState["plugins"] = "none";
  let filesError: string | null = null;
  let pluginsError: string | null = null;
  let missingCommands: string[] = [];
  let stopped = false;
  // Restores called and not yet finished: behind one, the applied version no longer counts.
  let restoring = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Promise<void>>();

  const state = (): ConfigState => ({ version: applied?.version ?? null, files, plugins, error: filesError ?? pluginsError, missingCommands: [...missingCommands] });
  const report = () => deps.onState(state());
  const dirs = () => {
    const cc = join(deps.stateDir(), "cluster-config");
    return { cc, objects: join(cc, "objects"), stage: join(cc, "stage"), trash: join(cc, "trash"), stateFile: join(cc, "state.json"), own: join(deps.stateDir(), "own-config") };
  };
  /** Applies, restores and plugin jobs run one at a time in call order: a restore never races an apply or its plugins. */
  const enqueue = (job: () => Promise<void>) => {
    const run = queue.then(job);
    queue = run.catch(() => undefined);
    return run;
  };
  const installedPlugins = () => listPlugins((args) => deps.runOmp(args, LIST_MS));

  function failure(error: unknown, what: string): HostOpError {
    if (error instanceof HostOpError) return error; // reported where it was raised
    const reason = messageOf(error);
    files = "failed";
    filesError = reason;
    report();
    deps.log(`cluster-config: ${what} failed: ${reason}`);
    return new HostOpError(409, "cluster_config_failed", reason);
  }

  /** The applied files are the asked version's: a failure of another version no longer counts. */
  function current() {
    if (files === "current" && filesError === null) return;
    files = "current";
    filesError = null;
    report();
  }

  async function fetchManifest(serverUrl: string): Promise<ConfigManifest> {
    const res = await deps.fetch(serverUrl, `${API}manifest`);
    if (!res.ok) {
      await res.body?.cancel();
      fail(`the master answered ${res.status} for the manifest`);
    }
    const body = await readBody(res, MANIFEST_BYTES, `the manifest is longer than ${MANIFEST_BYTES} bytes`);
    return checkManifest(parseJson(body.toString("utf8"), "the manifest"));
  }

  /** Every file of `manifest` in `objects/`, verified before it enters; false when the master no longer has one (404). */
  async function download(serverUrl: string, manifest: ConfigManifest): Promise<boolean> {
    const { objects } = dirs();
    for (const file of manifest.files) {
      const target = join(objects, file.hash);
      if (exists(target)) continue;
      const res = await deps.fetch(serverUrl, `${API}file/${file.hash}`);
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 404) return false;
        fail(`the master answered ${res.status} for ${file.path}`);
      }
      const bytes = await readBody(res, file.size, `${file.path} is longer than the manifest says`);
      if (createHash("sha256").update(bytes).digest("hex") !== file.hash) fail(`${file.path} does not match its hash`);
      writeAtomic(target, bytes);
    }
    return true;
  }

  function mergedSettings(master: string, own: { path: string; yaml: string } | null): string {
    if (own && !readsAsMap(own.yaml)) deps.log(`cluster-config: ${own.path} cannot be read as settings; this host's own machine-specific settings were not kept`);
    return mergeLocalSettings(master, own?.yaml ?? null);
  }

  /**
   * Steps 4-6. The first apply moves the member's own entries into `own-config/` where later ones move the previous
   * version to `trash/`. The backup, the swaps, the agent environment and `state.json` are one transaction: on any
   * failure everything moved is put back, so the member keeps exactly what it had. A backup without `state.json` (a
   * stop in the middle, or a failure that could not put everything back) is put back before the next apply.
   */
  function install(manifest: ConfigManifest, ownPlugins: PluginEntry[] | null) {
    const d = dirs();
    const roots = deps.roots();
    const first = ownPlugins !== null;
    const aside = first ? d.own : d.trash;
    // A link above an entry (`~/.agents`) would take the member's files and the master's somewhere else: refused before anything moves.
    for (const entry of ENTRIES) {
      for (let path = dirname(entry.path); path !== "."; path = dirname(path)) {
        const dir = join(roots[entry.root], path);
        if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${dir} is a symbolic link; cluster configuration needs a real directory there: replace the link with a directory`);
      }
    }
    const undo: (() => void)[] = [];
    let previousState: Buffer | null = null;
    try {
      removeAll(d.stage);
      removeAll(d.trash);
      // Step 5. On the first apply the member's settings are still live, about to become the backup.
      const own = ownSettings(first ? roots.agent : join(d.own, "agent"));
      let settings = false;
      for (const file of manifest.files) {
        const bytes = readFileSync(join(d.objects, file.hash));
        const isSettings = file.root === "agent" && file.path === "config.yml";
        settings ||= isSettings;
        writeAtomic(join(d.stage, file.root, file.path), isSettings ? mergedSettings(bytes.toString("utf8"), own) : bytes, file.exec ? 0o700 : 0o600);
      }
      // Without a master config.yml the member still keeps its machine-specific keys (K2).
      if (!settings && own) writeAtomic(join(d.stage, "agent", "config.yml"), mergedSettings("", own));

      const previousEnv = loadWebServerSettings().agentEnv;
      if (first) {
        // absent.json last: once it exists, entries may have moved, and a restore puts them back.
        writeAtomic(join(d.own, "plugins.json"), JSON.stringify(ownPlugins));
        writeAtomic(join(d.own, "agent-env.json"), JSON.stringify(previousEnv));
        // Absent entries, and their missing parents, are noted: a restore removes them.
        const absent: [ConfigRoot, string][] = [];
        for (const entry of ENTRIES) {
          for (let path = entry.path; path !== "."; path = dirname(path)) if (!exists(join(roots[entry.root], path))) absent.push([entry.root, path]);
        }
        writeAtomic(join(d.own, "absent.json"), JSON.stringify(absent));
      } else {
        // Until the new state.json no version counts as applied, so a stop during the swaps leaves a backup to put back.
        previousState = readFileSync(d.stateFile);
        rmSync(d.stateFile);
      }
      // Step 6. Renames move links as links: nothing is ever written through one.
      for (const entry of ENTRIES) {
        const live = join(roots[entry.root], entry.path);
        const staged = join(d.stage, entry.root, entry.path);
        if (exists(live)) {
          const away = join(aside, entry.root, entry.path);
          makeDir(dirname(away));
          move(live, away);
          undo.push(() => move(away, live));
        }
        if (exists(staged)) {
          const created = makeDir(dirname(live));
          if (created) undo.push(() => removeAll(created));
          move(staged, live);
          undo.push(() => removeAll(live));
        }
      }
      saveWebServerSettings({ agentEnv: manifest.agentEnv });
      undo.push(() => saveWebServerSettings({ agentEnv: previousEnv }));
      writeAtomic(d.stateFile, JSON.stringify({ version: manifest.version, plugins: manifest.plugins }));
    } catch (error) {
      const saved = previousState;
      const intact = undo.reverse().map(quietly).every(Boolean) && (saved === null || quietly(() => writeAtomic(d.stateFile, saved)));
      quietly(() => removeAll(d.stage));
      if (!intact) {
        // What could not be put back stays where it was moved; the member's own files are all in the backup.
        applied = null;
        fail(`${messageOf(error)}; the previous files could not all be put back: the next apply, or leaving the cluster, first restores this host's own configuration from ${d.own}`);
      }
      if (first) {
        // absent.json first: a backup without it holds nothing that was moved.
        quietly(() => rmSync(join(d.own, "absent.json"), { force: true }));
        quietly(() => removeAll(d.own));
      }
      quietly(() => removeAll(d.trash));
      throw error;
    }
  }

  /** Steps 1-6. Answers the plugin list to bring in line, or null when nothing new was applied. */
  async function applyFiles(version: string, serverUrl: string): Promise<PluginEntry[] | null> {
    if (stopped) fail("the host daemon is stopping");
    if (applied?.version === version) {
      current();
      return null;
    }
    const d = dirs();
    // An apply or a restore that stopped half-way: the member's own configuration goes back first, so the new backup takes it.
    if (exists(d.own) && !exists(d.stateFile)) await restoreNow();
    // A file the master no longer has means its configuration changed since the manifest: one more try with the new one.
    let manifest = await fetchManifest(serverUrl);
    if (manifest.version !== applied?.version && !(await download(serverUrl, manifest))) {
      manifest = await fetchManifest(serverUrl);
      if (manifest.version !== applied?.version && !(await download(serverUrl, manifest))) fail("the master's configuration changed during the download");
    }
    if (manifest.version === applied?.version) {
      current();
      return null;
    }
    let ownPlugins: PluginEntry[] | null = null;
    if (!exists(d.own)) {
      try {
        ownPlugins = await installedPlugins();
      } catch (error) {
        fail(`this host's plugins cannot be listed: ${lastLine(error)}`);
      }
    }
    install(manifest, ownPlugins);

    applied = { version: manifest.version, plugins: manifest.plugins };
    files = "current";
    filesError = null;
    plugins = "pending";
    try {
      removeAll(d.trash);
      removeAll(d.stage);
      const keep = new Set(manifest.files.map((file) => file.hash));
      if (exists(d.objects)) for (const name of readdirSync(d.objects)) if (!keep.has(name)) removeAll(join(d.objects, name));
    } catch (error) {
      deps.log(`cluster-config: cleaning up after the apply failed (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    report();
    return manifest.plugins;
  }

  /** omp's plugins in line with `target`: installs, then removals, then enabled states. Answers the first failure's last line of omp output. */
  async function reconcile(target: PluginEntry[]): Promise<string | null> {
    let failed: string | null = null;
    const run = async (args: string[], timeoutMs: number) => {
      if (stopped) return;
      try {
        await deps.runOmp(["plugin", ...args], timeoutMs);
      } catch (error) {
        failed ??= lastLine(error);
        deps.log(`cluster-config: omp plugin ${args.join(" ")} failed`);
      }
    };
    const key = (plugin: PluginEntry) => `${plugin.kind}:${plugin.id}`;
    try {
      let have = new Map((await installedPlugins()).map((plugin) => [key(plugin), plugin]));
      const wanted = new Set(target.map(key));
      let installed = false;
      for (const plugin of target) {
        const present = have.get(key(plugin));
        if (present && (plugin.kind !== "npm" || plugin.version === null || present.version === plugin.version)) continue;
        // A marketplace plugin cannot be pinned to a version.
        await run(["install", plugin.kind === "npm" && plugin.version !== null ? `${plugin.id}@${plugin.version}` : plugin.id], INSTALL_MS);
        installed = true;
      }
      for (const plugin of have.values()) if (!wanted.has(key(plugin))) await run(["uninstall", plugin.id], UNINSTALL_MS);
      // Whether a fresh install starts enabled is omp's choice: read it back.
      if (installed && !stopped) have = new Map((await installedPlugins()).map((plugin) => [key(plugin), plugin]));
      for (const plugin of target) {
        const present = have.get(key(plugin));
        if (present && present.enabled !== plugin.enabled) await run([plugin.enabled ? "enable" : "disable", plugin.id], TOGGLE_MS);
      }
    } catch (error) {
      failed ??= lastLine(error);
    }
    return failed;
  }

  /** The `command` of every server in the mirrored MCP files that this host lacks. Diagnostic only. */
  async function missingMcpCommands(): Promise<string[]> {
    const commands = new Set<string>();
    for (const name of ["mcp.json", ".mcp.json"]) {
      let servers: unknown;
      try {
        servers = JSON.parse(readFileSync(join(deps.roots().agent, name), "utf8")).mcpServers;
      } catch {
        continue; // absent or unreadable: omp reports it itself
      }
      if (!isRecord(servers)) continue;
      for (const server of Object.values(servers)) if (isRecord(server) && typeof server.command === "string" && server.command.trim()) commands.add(server.command.trim());
    }
    const missing: string[] = [];
    for (const command of commands) if (!(await deps.commandExists(command))) missing.push(command);
    return missing;
  }

  /** Step 7, in the queue after the files and without the caller waiting for it. */
  async function syncPlugins(target: PluginEntry[]) {
    const failed = await reconcile(target);
    const missing = await missingMcpCommands().catch(() => missingCommands);
    if (stopped) return; // cut short: still pending, and run again from state.json at the next start
    plugins = failed === null ? "current" : "failed";
    pluginsError = failed;
    missingCommands = missing;
    report();
  }

  /**
   * Puts the member's own configuration back. Run again after it stopped half-way, it finishes: `absent.json` goes once
   * every entry is back, the rest of the backup once the plugins are.
   */
  async function restoreNow() {
    const d = dirs();
    if (!exists(d.own)) return;
    if (stopped) throw failure(new Error("the host daemon is stopping"), "restoring");
    const roots = deps.roots();
    let ownPlugins: PluginEntry[] | null = null;
    try {
      // Before anything moves: from here on no version counts as applied, now or after a restart.
      applied = null;
      rmSync(d.stateFile, { force: true });
      // Without absent.json nothing is to move: the backup stopped before its first move, or its entries are back already.
      const absentFile = join(d.own, "absent.json");
      if (exists(absentFile)) {
        const absent = parseJson(readFileSync(absentFile, "utf8"), "the backup's absent.json") as [ConfigRoot, string][];
        for (const entry of ENTRIES) {
          const live = join(roots[entry.root], entry.path);
          const saved = join(d.own, entry.root, entry.path);
          // Neither saved nor absent: never moved (an apply stopped before it), or already put back.
          if (exists(saved)) {
            removeAll(live);
            makeDir(dirname(live));
            move(saved, live);
          } else if (absent.some(([root, path]) => root === entry.root && path === entry.path)) removeAll(live);
        }
        // Parents an apply created; rmdir leaves one that has since gained other content.
        for (const [root, path] of absent) if (!ENTRIES.some((entry) => entry.root === root && entry.path === path)) quietly(() => rmdirSync(join(roots[root], path)));
        saveWebServerSettings({ agentEnv: parseJson(readFileSync(join(d.own, "agent-env.json"), "utf8"), "the backup's agent-env.json") as Record<string, string> });
        rmSync(absentFile);
      }
      const pluginsFile = join(d.own, "plugins.json");
      if (exists(pluginsFile)) ownPlugins = parseJson(readFileSync(pluginsFile, "utf8"), "the backup's plugins.json") as PluginEntry[];
    } catch (error) {
      throw failure(error, "restoring");
    }
    const failed = ownPlugins ? await reconcile(ownPlugins) : null;
    files = "none";
    filesError = null;
    missingCommands = [];
    if (stopped) {
      // The plugins were cut short: the backup's list stays, and the next start finishes them.
      plugins = "pending";
      pluginsError = null;
      report();
      deps.log("cluster-config: stopped while putting this host's own plugins back; the next start finishes it");
      throw new HostOpError(409, "cluster_config_failed", "the host daemon stopped before this host's own plugins were back; its next start finishes it");
    }
    try {
      removeAll(d.own);
      removeAll(d.cc);
    } catch (error) {
      throw failure(error, "restoring");
    }
    plugins = failed === null ? "none" : "failed";
    pluginsError = failed;
    report();
  }

  // At the start: a version applied before reruns its plugin job, which a stop may have cut short; a backup without
  // one (an apply or a restore stopped half-way) is put back.
  let saved: unknown = null;
  try {
    saved = JSON.parse(readFileSync(dirs().stateFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.log("cluster-config: state.json cannot be read; no version counts as applied");
  }
  if (isRecord(saved) && typeof saved.version === "string" && Array.isArray(saved.plugins) && saved.plugins.every(isPlugin)) {
    const target = saved.plugins;
    applied = { version: saved.version, plugins: target };
    files = "current";
    plugins = "pending";
    enqueue(() => syncPlugins(target)).catch((error) => deps.log(`cluster-config: ${messageOf(error)}`));
  } else if (exists(dirs().own)) {
    plugins = "pending";
    enqueue(restoreNow).catch((error) => deps.log(`cluster-config: ${messageOf(error)}`));
  }

  return {
    /** Resolves once the files of `version` are applied; rejects with HostOpError(409, "cluster_config_failed", reason) otherwise. Concurrent calls share one apply. */
    ensure(version: string, serverUrl: string): Promise<void> {
      // Behind a pending restore nothing counts as applied: the call waits its turn, then applies again.
      if (restoring === 0) {
        if (applied?.version === version) {
          current();
          return Promise.resolve();
        }
        const shared = inflight.get(version);
        if (shared) return shared;
      }
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      inflight.set(version, promise);
      enqueue(async () => {
        let target: PluginEntry[] | null;
        try {
          target = await applyFiles(version, serverUrl);
        } catch (error) {
          reject(failure(error, "applying"));
          return;
        } finally {
          if (inflight.get(version) === promise) inflight.delete(version);
        }
        resolve();
        // Still in the queue: a later restore waits for the plugins, the caller does not.
        if (target) await syncPlugins(target);
      }).catch((error) => deps.log(`cluster-config: ${messageOf(error)}`));
      return promise;
    },
    /** Leaving the cluster: put the member's own configuration back. */
    restore(): Promise<void> {
      restoring++;
      return enqueue(restoreNow).finally(() => {
        restoring--;
      });
    },
    state,
    async stop(): Promise<void> {
      stopped = true;
      await queue;
    },
  };
}
