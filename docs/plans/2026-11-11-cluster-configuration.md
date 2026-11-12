# Cluster configuration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every cluster member runs its sessions with the master's omp configuration; a change on the master reaches the members without any action on them.

**Architecture:** the master describes its configuration as a manifest of files addressed by content hash, with a version that is the hash of the manifest. A member's daemon pulls the manifest and the files it lacks over two host-token routes, applies them into its own omp directory after backing up what was there, and reports its state. The hub puts the master's version on every session start for a member, so the daemon applies first or refuses; placement skips members that are not current.

**Tech Stack:** TypeScript; server on Bun; daemon modules on Node through `jiti`; `yaml` for `config.yml`; tests `bun test --parallel --timeout 30000`.

**Spec:** `docs/specs/2026-11-11-cluster-configuration-design.md` (K1–K7). Read it first.

**Base:** needs `feat/cluster-membership` complete (join and leave route, `lib/hosts/cluster.ts` with `isClusterMember` and `sharesCredentials`) and `feat/shared-credentials` complete (the broker route's host-token check, `SpawnRequest.credentialsServer`, the daemon's authenticated fetch). Merge both before Task 1.

## Global Constraints

- `LINK_PROTOCOL_VERSION = 10`, `MIN_LINK_PROTOCOL_VERSION = 4` (literal one-line exports: the deploy script `sed`s them). Joining the cluster then requires protocol 10.
- Daemon-loaded files (`lib/hosts/daemon*.ts`, `lib/hosts/cluster-config.ts`, `lib/omp/plugins-cli.ts`, and their `lib/` imports): relative imports only, no `Bun` global.
- Limits: 5 MiB (`5_242_880` bytes) per file, 50 MiB (`52_428_800`) per bundle. Directories named `node_modules` or `.git` are left out.
- The master reads through symbolic links (its configuration may be linked from another directory); a member never writes through one: an existing link at a managed path is moved to the backup as it is.
- A member writes files with mode 0600, or 0700 when the master's file is executable by its owner, to a temporary name in the same directory, then renames.
- A manifest path is relative, uses `/`, has no empty, `.` or `..` segment, and lies at or under one entry of `MIRRORED`; a member rejects any other path before touching the disk.
- Never log a token, a secret, a file's content or an environment value. Paths and hashes may be logged.
- A member that has never applied a version never starts a cluster session with its own configuration: it applies or refuses.
- Facts confirmed on omp 18.18.6: `config.yml` holds nested keys (`python: { interpreter }`); `omp plugin list --json` answers `{ "npm": [...], "marketplace": [...] }`; `omp plugin install` accepts `name@version`.
- On this machine some tests fail on the untouched base (list in the workspace's `baseline-main-failures.txt`). A failure outside that list is yours.
- Commit titles follow the log (`feat(hosts): …`). Commit and push after every task.

## Review Focus

1. The master's `skills`, `agents`, `hooks`, `config.yml` and `mcp.json` are symbolic links into another repository → the manifest contains their contents, not nothing. (Task 1)
2. The master's configuration changes while a member is downloading → the member ends on one consistent version, the old or the new, never a mix. (Tasks 2, 3)
3. Two sessions start at the same moment on a member that is behind → one apply, both wait for it, both start. (Tasks 3, 4)
4. An apply fails half-way (disk full, a file that cannot be written) → the member's previous configuration is back in place and the start is refused with the reason. (Task 3)
5. A host leaves, then joins again → its own configuration came back exactly on leaving, and joining backs it up again without mixing in mirrored files. (Task 3)

---

### Task 1: the manifest

**Files:**
- Create: `lib/hosts/cluster-config.ts`
- Test: `lib/hosts/cluster-config.test.mjs`

**Interfaces:**
- Produces:

```ts
export const CONFIG_LIMITS = { fileBytes: 5_242_880, bundleBytes: 52_428_800 };
export type ConfigRoot = "agent" | "home";
/** Mirrored entries: files and directories, relative to the omp agent directory or to the home directory. */
export const MIRRORED: readonly { root: ConfigRoot; path: string; kind: "file" | "dir" }[];
/** `config.yml` key paths a member keeps for itself (spec K2). A path covers everything below it. */
export const LOCAL_SETTINGS: readonly (readonly string[])[];
export interface ManifestFile { root: ConfigRoot; path: string; hash: string; size: number; exec: boolean }
export interface PluginEntry { kind: "npm" | "marketplace"; id: string; version: string | null; enabled: boolean }
export interface ConfigManifest { version: string; files: ManifestFile[]; agentEnv: Record<string, string>; plugins: PluginEntry[] }
export class ClusterConfigError extends Error { constructor(readonly code: "file_too_large" | "bundle_too_large" | "invalid_settings" | "invalid_path", message: string) }
/** Reads the mirrored entries under the two roots. `content(hash)` returns the bytes of a manifest file. */
export function buildManifest(roots: Record<ConfigRoot, string>, extra: { agentEnv: Record<string, string>; plugins: PluginEntry[] }): { manifest: ConfigManifest; content(hash: string): Uint8Array | null };
export function stripLocalSettings(masterYaml: string): string;
export function mergeLocalSettings(masterYaml: string, ownYaml: string | null): string;
export function isManagedPath(root: ConfigRoot, path: string): boolean;
```

`MIRRORED`, exact:
- agent, files: `config.yml`, `models.yml`, `mcp.json`, `.mcp.json`, `AGENTS.md`, `RULES.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, `secrets.yml`, `.env`
- agent, directories: `skills`, `agents`, `rules`, `instructions`, `commands`, `prompts`, `hooks`, `extensions`, `tools`
- home, directory: `.agents/skills`

`LOCAL_SETTINGS`, exact: `shellPath`; `python.interpreter`; `browser`; `worktree.base`; `plan.autosaveDir`; `shellMinimizer.settingsPath`; `mnemopi.dbPath`; `workspace.additionalDirectories`; `skills.customDirectories`; `extensions`; `images.urls`; `providers.tinyModelDevice`; `providers.tinyModelDtype`; `tts`; `stt`; `tui`; `terminal`; `lsp`; `auth.broker`.

Rules:
- A missing entry is skipped. Where the master has `config.yaml` or `models.yaml` and no `.yml`, its content is mirrored under the `.yml` path.
- The `config.yml` entry's content is `stripLocalSettings(file)`; its hash and size are of that. A file that is not a YAML map → `invalid_settings`.
- `hash` is the SHA-256 hex of the content. `version` is the SHA-256 hex of the canonical JSON of `{ files, agentEnv, plugins }` with `files` sorted by root then path, `plugins` by kind then id, and `agentEnv` keys sorted.
- `mergeLocalSettings` returns the master's document with, for each `LOCAL_SETTINGS` path present in the member's own document, that value set. Use the `yaml` `Document` API (`parseDocument`, `setIn`, `deleteIn`), as `lib/omp/settings-config.ts` does.

- [ ] **Step 1: Write the failing tests** in a temporary directory tree:
  - every `MIRRORED` entry present → all files listed, sorted; a nested file under `skills/x/SKILL.md` has path `skills/x/SKILL.md`;
  - `skills` being a symbolic link to a directory elsewhere, and `mcp.json` a link to a file → their contents are in the manifest; a link that points back into its own parent (a cycle) does not hang and is skipped;
  - `node_modules` and `.git` directories are left out at any depth;
  - a 5 MiB + 1 byte file → `file_too_large`, its path in the message; many files summing over 50 MiB → `bundle_too_large`;
  - an executable file has `exec: true`;
  - `config.yaml` only → listed as `config.yml`;
  - `stripLocalSettings` removes each `LOCAL_SETTINGS` path and nothing else (`python.interpreter` goes, `python.other` stays; `browser` goes whole);
  - `mergeLocalSettings(master, own)`: the member's `shellPath` and `browser` survive, the master's `modelRoles` wins, a key only the member has outside `LOCAL_SETTINGS` is gone; `own` null → the stripped master;
  - `version` is stable for the same input and changes when a file's content, the `exec` bit, one `agentEnv` value, or one plugin's `enabled` changes;
  - `content(hash)` returns the bytes; an unknown hash → null;
  - `isManagedPath`: `skills/a/b` true; `skills/../x`, `/etc/passwd`, `sessions/x`, `skills//a`, `` false.
- [ ] **Step 2: Run** `bun test --parallel --timeout 30000 lib/hosts/cluster-config.test.mjs` — expected: fail, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it — expected: pass. `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hosts): describe the master's omp configuration as a manifest`, push.

---

### Task 2: the master's current configuration and its two routes

**Files:**
- Create: `lib/omp/plugins-cli.ts`, `lib/hosts/cluster-config-server.ts`, `lib/hosts/host-bearer.ts`, `app/api/hosts/cluster-config/manifest/route.ts`, `app/api/hosts/cluster-config/file/[hash]/route.ts`
- Modify: `app/api/plugins/route.ts` (use `plugins-cli.ts` for the list), `app/api/hosts/broker/[...path]/route.ts` (use `host-bearer.ts`), `proxy.ts` (`UNGATED`), `server/routes.ts`
- Test: `lib/hosts/cluster-config-route.test.mjs`, `lib/web-auth.test.mjs`, `lib/omp/plugins-cli.test.mjs`

**Interfaces:**
- Consumes: Task 1; `isClusterMember` (`lib/hosts/cluster.ts`); `loadPools`; `hostForToken`, `HostRegistryUnreadableError`; `loadWebServerSettings`; `getAgentDir`.
- Produces:

```ts
// lib/omp/plugins-cli.ts (daemon-safe)
export function listPlugins(run: (args: string[]) => Promise<string>): Promise<PluginEntry[]>; // `omp plugin list --json`; npm: id = name, version, enabled; marketplace: id, version and enabled of its first user-scope entry
export function runOmpCli(args: string[], timeoutMs: number): Promise<string>;                  // execFile of resolveOmpBin(); rejects when omp is missing
// lib/hosts/host-bearer.ts
export function hostFromBearer(request: Request): HostRecord | Response;                         // 401 unknown token, 503 unreadable registry; never 401 for an unreadable registry
// lib/hosts/cluster-config-server.ts
export function currentClusterConfig(): Promise<{ manifest: ConfigManifest; content(hash: string): Uint8Array | null }>; // throws ClusterConfigError
export function clusterConfigVersion(): Promise<string>;
```

`currentClusterConfig` rebuilds only when something changed: it keeps the last result with a fingerprint (path, size and modification time of every file under the mirrored entries after following links, the `agentEnv` record, the plugin list) and reuses it while the fingerprint is equal. The plugin list is read at most every 30 s.

Routes, both `GET`, both outside the password gate (`UNGATED` gains the prefix `api\/hosts\/cluster-config\/`), both in this order: `hostFromBearer`; the host is not `local` and `isClusterMember(loadPools(), host.id)`, else 403 `Not a cluster member`; unreadable `pools.json` → 503.
- `manifest` → 200 with the manifest as JSON, `cache-control: no-store`; a `ClusterConfigError` → 409 `{ error, code }`.
- `file/<hash>`: `hash` must be 64 lower-case hex characters, else 404; bytes of that hash from the current configuration, `content-type: application/octet-stream`; a hash not in the current manifest → 404.

- [ ] **Step 1: Write the failing tests:**
  - `plugins-cli`: the empty answer `{"npm":[],"marketplace":[]}`; one npm and one marketplace entry mapped as above; output with text before the first `{`; a missing omp rejects;
  - routes: no token and an unknown token → 401; a linked host that is not a member → 403; the `local` record's token → 403; unreadable `hosts.json` or `pools.json` → 503; a member gets the manifest, and each listed file by hash with the right bytes; a well-formed hash that is not in the manifest → 404; `../x` and a 63-character hash → 404; a master file over the limit → 409 `file_too_large` on the manifest;
  - a file changed on disk → the next manifest has another version and the old hash answers 404;
  - an unchanged tree → the second call does not re-read file contents (count reads through an injected reader);
  - `web-auth`: `/api/hosts/cluster-config/manifest` is `"public"` for the gate; `/api/hosts/cluster-configx` is not;
  - the broker route's existing tests still pass with `hostFromBearer`.
- [ ] **Step 2: Run** the three test files, `lib/hosts/broker-route.test.mjs` and `server/routes.test.ts` — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — expected: pass. `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hosts): serve the master's configuration to cluster members`, push.

---

### Task 3: applying on a member

**Files:**
- Create: `lib/hosts/daemon-cluster-config.ts`
- Test: `lib/hosts/daemon-cluster-config.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`ConfigManifest`, `isManagedPath`, `mergeLocalSettings`, `MIRRORED`); `listPlugins` (Task 2); `saveWebServerSettings`, `loadWebServerSettings` (`lib/web-settings.ts`).
- Produces:

```ts
export interface ConfigState { version: string | null; files: "none" | "current" | "failed"; plugins: "none" | "pending" | "current" | "failed"; error: string | null; missingCommands: string[] }
export function createClusterConfig(deps: {
  roots(): Record<ConfigRoot, string>;
  stateDir(): string;                                   // <agent dir>/omp-web
  fetch(serverUrl: string, path: string): Promise<Response>; // authenticated by the caller; path starts with /api/hosts/cluster-config/
  runOmp(args: string[], timeoutMs: number): Promise<string>;
  commandExists(command: string): Promise<boolean>;
  onState(state: ConfigState): void;
  log(message: string): void;
}): {
  /** Resolves once the files of `version` are applied; rejects with HostOpError(409, "cluster_config_failed", reason) otherwise. Concurrent calls share one apply. */
  ensure(version: string, serverUrl: string): Promise<void>;
  /** Leaving the cluster: put the member's own configuration back. */
  restore(): Promise<void>;
  state(): ConfigState;
  stop(): Promise<void>;
};
```

Layout under `stateDir()`: `cluster-config/state.json` (`{ version, plugins }`), `cluster-config/objects/<hash>`, `cluster-config/stage/`, `cluster-config/trash/`, `own-config/` (the backup: `agent/…`, `home/…`, `agent-env.json`, `plugins.json`).

`ensure`, in order:
1. The applied version equals `version` → done.
2. Fetch the manifest. Apply the version the manifest carries, even if it is newer than the one asked for. Reject any file path for which `isManagedPath` is false.
3. Download each file whose hash is not in `objects/` and verify its SHA-256; a 404 means the master changed meanwhile: fetch the manifest again, once.
4. First apply only: move the member's own version of every `MIRRORED` entry into `own-config/` (rename; missing ones are noted as absent), save its `agentEnv` and its plugin list there.
5. Build the complete new tree in `stage/`: every file from `objects/`, with `config.yml` as `mergeLocalSettings(master, own-config's config.yml)`.
6. Swap each `MIRRORED` entry: the live one moves to `trash/`, the staged one into place. If any step fails, move back what was swapped, clear `stage/`, reject. Then empty `trash/`, write the mirrored `agentEnv` with `saveWebServerSettings`, write `state.json`, and report the state.
7. After the files, without delaying the caller: bring the plugins in line (`omp plugin install <name>@<version>` for a missing npm plugin, `install <id>` for a missing marketplace one, `uninstall` for one the master lacks, `enable`/`disable` to match), then report `plugins: "current"` or `"failed"` with omp's last line; and report `missingCommands`: the `command` of every server in the mirrored `mcp.json` for which `commandExists` is false.

`restore`: remove every `MIRRORED` entry, move the backup's entries back, restore its `agentEnv`, bring the plugins back to the backed-up list (failures logged and reported, not thrown), delete `cluster-config/` and `own-config/`, report the empty state. Without a backup it does nothing.

- [ ] **Step 1: Write the failing tests** with temporary roots, a scripted `fetch` serving a manifest built by Task 1, and a scripted `runOmp`:
  - first apply: files appear with mode 0600 (0700 for `exec`), a nested directory is created, `own-config/` holds the member's previous files, `state()` is `files: "current"`;
  - a member file inside a mirrored directory that the master does not have is gone from the live tree and present in the backup;
  - `config.yml` keeps the member's `shellPath` and takes the master's other keys;
  - `agentEnv` in the member's `omp-web-settings.json` equals the manifest's;
  - a second `ensure` with the applied version fetches nothing;
  - two concurrent `ensure` calls → one manifest fetch;
  - a manifest with `path: "../x"` or `root: "agent", path: "sessions/a"` → rejected with `cluster_config_failed`, nothing written;
  - a downloaded file whose hash does not match → rejected, live tree unchanged;
  - a 404 for a file, then a new manifest → the new version is applied;
  - a failure injected at the third swap → the live tree equals the tree before the call (compare every file), the call rejects, `state().files` is `"failed"` with the reason;
  - a second version applied → no second backup; the backup is still the member's original;
  - an existing symbolic link at a managed path is moved to the backup as a link and nothing is written through it;
  - plugins: one to install, one to remove, one to disable → the three commands run in that order after `ensure` resolved; a failing install → `plugins: "failed"`, `error` set, `files` still `"current"`;
  - `missingCommands` lists the MCP command that `commandExists` denies;
  - `restore`: the live tree equals the original byte for byte, modes included; the state is empty; a later `ensure` makes a fresh backup; `restore` twice is harmless.
- [ ] **Step 2: Run** `bun test --parallel --timeout 30000 lib/hosts/daemon-cluster-config.test.mjs` — expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it — expected: pass. `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hosts): apply the master's configuration on a cluster member`, push.

---

### Task 4: link protocol 10 and the wiring

**Files:**
- Modify: `lib/hosts/link-protocol.ts`, `lib/hosts/host.ts`, `lib/hosts/hub.ts`, `lib/hosts/daemon.ts`, `lib/hosts/daemon-channels.ts`, `app/api/hosts/[id]/cluster/route.ts`, `instrumentation.node.ts`
- Test: `lib/hosts/hub-v7.test.mjs`, `lib/hosts/daemon-runtime.test.mjs`, `lib/hosts/daemon-channels.test.mjs`, `lib/hosts/cluster-route.test.mjs`, the fixtures that pin the server's version as 9

**Interfaces:**
- Consumes: Tasks 2 and 3; `sharesCredentials`, `isClusterMember`; `SpawnRequest.credentialsServer`; the daemon's authenticated fetch in `lib/hosts/daemon-broker.ts`.
- Produces:

```ts
export const LINK_PROTOCOL_VERSION = 10;
export const CLUSTER_CONFIG_SINCE_VERSION = 10;
// SpawnRequest gains (hub → daemon, v10): the master's configuration version this process must run with.
configVersion?: string;
// Up message, unsequenced and never replayed, like `capacity`:
{ type: "config_state"; state: ConfigState }
// Host op: { op: "clusterConfig", args: { action: "apply", version: string } | { action: "restore" } } → { state: ConfigState }
// LinkedHostRow gains:
clusterConfig?: ConfigState & { current: boolean };
```

Hub:
- `RemoteHost.spawnRpc`, for a host that is a cluster member and not `local`, on an open that can start a process: a daemon below protocol 10 → 426 `host_upgrade_required` ("Update ompweb on <label> to use it in the cluster"); `clusterConfigVersion()` throwing → 409 `cluster_config_invalid` with the error's message; otherwise the launch gets `configVersion`.
- `config_state` is stored per link when `hostVersion ≥ 10`; `current` is `state.version === the master's version && state.files === "current" && state.plugins === "current"`; a change calls `notifyHostsChange()`.
- A timer started from `instrumentation.node.ts` runs every 30 s while a cluster exists: for each online member whose reported version differs from the master's, send `clusterConfig` `apply`. A failing master configuration is logged once per version.

Daemon:
- One `createClusterConfig` per daemon. Its `fetch` uses the link whose URL is given, with that link's current token and `redirect: "error"`; `onState` queues `config_state` on every link of protocol 10 or newer.
- The `spawn` dependency, after the credentials checks: a launch with `configVersion` and no `credentialsServer` → 409 `cluster_config_failed`; otherwise `await config.ensure(launch.configVersion, launch.credentialsServer)` before `spawnRpc`.
- `ChannelTable.open` passes `configVersion` through only when it is a string of 64 hex characters, and drops it otherwise. `spawnLegacy` drops it. The resume manifest never stores it: a recovered session starts with the version already applied.
- The `clusterConfig` op: `apply` → `ensure(version, <the URL of the link that sent the op>)` then the state; `restore` → `restore()` then the state.

Join and leave route:
- The join precondition is protocol 10. After the save, the route sends `clusterConfig` `apply` to the joined host and to no other, waits at most 60 s, and answers 200 either way; the state shows a failure.
- Leaving sends `clusterConfig` `restore` after the save, and answers 200 with `restoreError` set when it failed.

- [ ] **Step 1: Write the failing tests:**
  - hub: a member at v10 gets `launch.configVersion`; a non-member does not; a member at v9 → 426, nothing sent; a pure join (`expectedChannel`) is neither refused nor given a version; an invalid master configuration → 409 `cluster_config_invalid`, nothing sent; a `config_state` frame updates the row and `current`; the timer sends `apply` only to members that are behind;
  - daemon channels: `configVersion: "x"` is dropped, a 64-hex value is kept; `spawnLegacy` drops it;
  - daemon runtime: an open with a version the member lacks applies it, then starts omp; a failing apply starts no process and answers `cluster_config_failed`; two opens at once → one apply; the `clusterConfig` op with `restore`; `host-running.json` holds no `configVersion`;
  - route: join sends `apply` to the joined host; a host at v9 → 409 `host_upgrade_required`; leave sends `restore`; a failing restore still removes the member and reports `restoreError`.
- [ ] **Step 2: Run** `bun test --parallel --timeout 30000 lib/hosts` — expected: the new tests fail.
- [ ] **Step 3: Implement.** Update only the fixtures that pin the server's own version as 9.
- [ ] **Step 4: Run** `bun test --parallel --timeout 30000 lib/hosts app server components bin` — expected: no failure outside the baseline list. `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hosts): link protocol v10 keeps cluster members on the master's configuration`, push.

---

### Task 5: placement skips members that are not current

**Files:**
- Modify: `lib/hosts/pools.ts` (`PoolHostSnapshot`, `selectPoolHost`), `lib/hosts/pool-starts.ts` (where the snapshots are built), `lib/hosts/hub.ts` (a getter)
- Test: `lib/hosts/pool-selection.test.mjs`, `lib/hosts/pool-starts.test.mjs`

**Interfaces:**
- Produces: `PoolHostSnapshot.configCurrent: boolean`; `export function isHostConfigCurrent(hostId: string): boolean` in `hub.ts` (always true for `local`).

`selectPoolHost` skips a member whose snapshot has `configCurrent === false`, next to its `draining` check. When no member is eligible only for that reason, the 503 `pool_unavailable` message says that the members are still receiving the cluster's configuration.

- [ ] **Step 1: Write the failing tests:** two members, one not current → the other is chosen whatever its load; none current → `pool_unavailable` with that message; `local` is current without any report; existing selection tests pass with `configCurrent: true` added to their snapshots.
- [ ] **Step 2: Run** the two test files — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): place cluster sessions only on members with the current configuration`, push.

---

### Task 6: Settings

**Files:**
- Modify: `components/HostsConfig.tsx`, `components/AppShell.tsx`, `components/SettingsConfig.tsx`, `lib/i18n/locales/en.json`, `ja.json`, `zh-CN.json`
- Test: `components/HostsConfig.cluster.test.mjs`, the existing Settings component tests

**Interfaces:**
- Consumes: `LinkedHostRow.clusterConfig` (Task 4); `useHostRows()`; `isClusterMember`.

Behaviour:
- **Hosts.** A member's row shows one line under its details: `configCurrent`; `configUpdating` (files or plugins not yet current and no error); `configFailed` with the error text; and, when the list is not empty, `configMissing` with the commands joined by ", ". The join confirmation gains the note `joinConfigNote`.
- **Panels.** Today `remoteHost` (in `AppShell`, from the session's host) replaces the MCP, Skills, Plugins and Agents panels with "Not available on remote hosts yet". For a session or project of the cluster whose node is a member other than this machine, the panels are shown instead, in cluster mode: they act on the master's user-level configuration, their project-level parts are hidden, and a line at the top says `clusterConfigNotice`. They are given the master's default working directory (`GET /api/default-cwd` without a host). If a route refuses that directory in its allowed-roots check, change that route to accept a request without `cwd` for its user-level operations; do not widen the allowed roots. A standalone remote host keeps today's message.
- The Models and settings tabs get the same `clusterConfigNotice` for a cluster session.

Strings (keys `hostsConfig.<name>` unless noted):

| name | en | ja | zh-CN |
|---|---|---|---|
| `configCurrent` | Configuration: same as the master | 設定: マスターと同じ | 配置：与主节点一致 |
| `configUpdating` | Configuration: updating… | 設定: 更新中… | 配置：正在更新… |
| `configFailed` | Configuration: failed — {reason} | 設定: 失敗 — {reason} | 配置：失败 — {reason} |
| `configMissing` | Not installed on this host: {commands} | このホストに未インストール: {commands} | 该主机上未安装：{commands} |
| `joinConfigNote` | Its omp configuration (settings, models, MCP servers, skills, plugins, rules) is replaced by this machine's until it leaves; its own is kept and put back then. | この omp 設定（設定、モデル、MCP サーバー、スキル、プラグイン、ルール）は、離脱するまでこのマシンのものに置き換えられます。元の設定は保存され、離脱時に戻されます。 | 其 omp 配置（设置、模型、MCP 服务器、技能、插件、规则）在离开前将替换为本机的配置；它自己的配置会被保留并在离开时恢复。 |
| `settings.clusterConfigNotice` | Cluster configuration: changes here apply to every member. | クラスター設定: ここでの変更はすべてのメンバーに適用されます。 | 集群配置：此处的更改适用于所有成员。 |

- [ ] **Step 1: Write the failing tests:** each of the four status lines from a row's `clusterConfig`; no line for a standalone host; the join dialog shows `joinConfigNote`; for a cluster session on another member the four panels render with the notice and send their requests without the member's `cwd`; for a standalone remote host the old message stays; for a cluster session on this machine nothing changes except the notice.
- [ ] **Step 2: Run** them — expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test --parallel --timeout 30000 components lib/i18n`, `npm run typecheck`, `npm run lint` — expected: no failure outside the baseline list, no lint error.
- [ ] **Step 5: Commit** `feat(settings): show and edit the cluster's configuration`, push.

---

### Task 7: documentation

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/specs/2026-10-28-remote-hosts-design.md`

Content, from the spec, in plain prose: what is mirrored and what is not (K1, "Not goals"); the settings that stay the member's own (K2); when a member applies and what happens when it cannot (K3, K4); plugins (K5); the backup and what leaving restores (K6); the security note and the limits, in full; the reverse-proxy sentence for `/api/hosts/cluster-config/` (as for `/api/hosts/broker/`); `AGENTS.md`: the file map entries for the new files, the rules under "Remote hosts" (protocol 10, `configVersion`, `config_state`, the `clusterConfig` op, never persisted in the resume manifest), the gate exemption; the remote-hosts specification's version rule gains `10: open.launch.configVersion, config_state, the clusterConfig op`.

- [ ] **Step 1:** Write it.
- [ ] **Step 2:** Check every statement against the code it describes; list the file you checked for each in the report.
- [ ] **Step 3: Commit** `docs(hosts): document the cluster's shared configuration`, push.

---

### Task 8: end-to-end proof (throwaway, nothing committed)

Two temporary home directories and a free port, the installed omp, no real login. Master home `A` gets: `config.yml` with `shellPath`, a `modelRoles` entry and `browser.headless`; `models.yml` with one local-only provider; `skills/probe/SKILL.md`; `agents/probe.md`; `hooks` as a symbolic link to a directory outside the agent directory with one file; `mcp.json` with one server whose command is `definitely-not-installed`. Host home `B` gets its own `config.yml` with another `shellPath` and another `modelRoles`, and its own `skills/own/SKILL.md`.

- [ ] **Step 1:** Build; start the server on `A` and the daemons; link `B`; join it to the cluster.
- [ ] **Step 2:** Expected after the join: `B`'s `skills/probe/SKILL.md`, `agents/probe.md`, `hooks/<file>` and `models.yml` equal `A`'s; `B`'s `skills/own` is gone from the live tree and present under `own-config/`; `B`'s `config.yml` has `B`'s `shellPath`, `A`'s `modelRoles`, and no `browser.headless` from `A`; `GET /api/hosts` shows `B` current, with `definitely-not-installed` as missing.
- [ ] **Step 3:** Change `A`'s `models.yml`; start a session on `B` within 5 s (before the 30 s timer). Expected: the session starts and `B`'s `models.yml` already equals the new one.
- [ ] **Step 4:** Make one `A` file 6 MiB. Expected: a new session on `B` is refused with `cluster_config_invalid` naming the file; a session on `A` starts. Remove the file; the next session on `B` starts.
- [ ] **Step 5:** Leave the cluster. Expected: `B`'s agent directory equals its state before step 1, compared file by file, modes included.
- [ ] **Step 6:** Stop everything, delete both homes, report each expectation as met or not with the evidence.

The live run on the Proxmox hosts stays with the user.
