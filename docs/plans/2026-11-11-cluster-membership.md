# Cluster membership — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings → Hosts puts a linked host in or out of the one cluster, whose master is this machine; joining turns the host's Git projects into cluster projects so their sessions are listed together.

**Architecture:** the existing pool data (`pools.json`, `clonePaths` bindings) already merges sessions by checkout path, so joining is a pure computation over the pool plus one new host operation that reports each project's Git origin. A per-host route runs it and saves once. The sidebar regroups a member's remaining projects under the cluster, and membership implies credential sharing.

**Tech Stack:** TypeScript; server on Bun; daemon modules on Node through `jiti`; React; tests `bun test --parallel`.

**Spec:** `docs/specs/2026-11-11-cluster-membership-design.md` (M1–M7). Read it first.

**Base:** `feat/shared-credentials`. Tasks 5 and 7 need that branch's tasks 4 (hub flag) and 7 (Settings toggle) merged in first; tasks 1–4 and 6 do not.

## Global Constraints

- Code keeps the word `pool`; only interface text says "cluster". Nothing is renamed.
- The cluster is `loadPools()[0]`. A created cluster has `id: "cluster"`, `label: "Cluster"`, `enabled: true`.
- This machine (`LOCAL_HOST_ID`, `"local"`) is always a member and never leaves. Its `projectsRoot` is `<home>/ompweb-cluster`, from the `home` workspace operation of its own daemon.
- A new member is `{ hostId, projectsRoot, provisioned: true, draining: false }`.
- A join or a leave is one `savePools` call. If anything fails before it, nothing is saved.
- Joining requires, of the host and of this machine when it is being added: status `online`, link protocol ≥ 9, and `gitOrigins` among its workspace operations.
- Same repository (M4): host lower-cased; user, scheme and port ignored; `host:path` read as `ssh://host/path`; trailing `/` and `.git` removed; the path compared case-sensitively.
- A member other than this machine always shares credentials; this is computed, never written to `hosts.json`. Unreadable `pools.json` refuses sessions.
- Daemon-loaded files (`lib/git-clone.ts`, `lib/pooled-projects.ts`, `lib/workspace-types.ts`, `lib/hosts/workspace-ops.ts`): relative imports only, no `Bun` global.
- Client code (`components/`, `hooks/`): no `AbortSignal.timeout`, `AbortSignal.any` or `Promise.withResolvers`.
- On this machine 17 tests fail on the untouched base (Git worktree, host update and resume-manifest tests). A failure outside that list is yours. New tests that need a Git repository use `git init` and `git remote add` only: no commits, which need a signing key here.
- Commit titles follow the log (`feat(hosts): …`). Commit and push after every task.

## Review Focus

1. A host joins while one of its projects has the same origin as a cluster project under another URL form (`git@github.com:a/b.git` against `https://github.com/a/b`) → one project, and a later session on that host is not refused with `pool_origin_mismatch`. (Tasks 1, 3)
2. The host answers `gitOrigins` for only some paths (a folder was deleted, or is not readable) → those projects are pinned; the join still succeeds. (Tasks 2, 3)
3. A host that left joins again → its old checkouts bind to the same cluster projects, no duplicate projects appear, and its pinned projects are pinned again. (Task 3)
4. `pools.json` was written by hand with a pool that lacks this machine → the next join adds it and moves its projects; a second pool in the file is left byte-for-byte alone. (Tasks 3, 4)
5. Two browser tabs: one joins a host, the other's sidebar still shows the host's own group → it regroups without a reload. (Task 4)

---

### Task 1: the same-repository rule

**Files:**
- Modify: `lib/git-clone.ts` (next to `cloneDirectoryName`), `lib/pooled-projects.ts` (the `remote.origin.url` check)
- Test: `lib/git-clone.test.mjs` (create if absent), the existing `lib/pooled-projects` test file

**Interfaces:**
- Produces: `export function repositoryKey(url: string): string | null` — `"<host>/<path>"`, or null for a URL `cloneDirectoryName` rejects.

- [ ] **Step 1: Write the failing tests.**
  - `repositoryKey` gives `github.com/a/b` for `git@github.com:a/b.git`, `https://github.com/a/b`, `https://GitHub.com/a/b.git/`, `ssh://git@github.com/a/b.git` and `ssh://git@github.com:2222/a/b`.
  - It gives different keys for `https://github.com/a/c`, `https://gitlab.com/a/b` and `https://github.com/A/b`.
  - It gives null for `/srv/repo`, `file:///srv/repo` and `""`.
  - Preparation: a checkout whose only `origin` URL is `git@github.com:a/b.git` is accepted for a project registered as `https://github.com/a/b`; one with two `origin` URLs, and one whose URL is another repository, still fail with `pool_origin_mismatch`.
- [ ] **Step 2: Run** `bun test --parallel lib/git-clone.test.mjs <pooled-projects test>` — expected: the new tests fail.
- [ ] **Step 3: Implement.** The preparation check splits `git config --null --get-all remote.origin.url` on `\0`, requires exactly one value, and compares `repositoryKey` of it with `repositoryKey(origin)`; a null key never matches. Keep the existing comment on why `remote get-url` is not used.
- [ ] **Step 4: Run** the same command — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): match pool checkouts by repository, not by URL text`, push.

---

### Task 2: the `gitOrigins` host operation

**Files:**
- Modify: `lib/workspace-types.ts` (`WorkspaceOps`, and `WORKSPACE_OP_PARAMS` — append as the last entry), `lib/hosts/workspace-ops.ts`
- Test: the existing workspace-ops test file

**Interfaces:**
- Produces:

```ts
export interface GitOrigin { path: string; origin: string | null; mainCheckout: boolean }
// in WorkspaceOps:
gitOrigins(paths: string[]): Promise<OpResult<{ origins: GitOrigin[] }>>;
// in WORKSPACE_OP_PARAMS:
gitOrigins: ["paths"],
```

Behaviour: one answer per requested path, in order. At most 500 paths, else the operation fails with 400. `mainCheckout` is true when `<path>/.git` is a real directory (not a symlink) and `git rev-parse --show-toplevel` equals the path. `origin` is the single value of `git config --null --get-all remote.origin.url`, null for none or several. A path that is not an authorized workspace directory, does not exist or is not a repository answers `{ origin: null, mainCheckout: false }`; it never fails the whole operation.

- [ ] **Step 1: Write the failing tests** with temporary directories registered as projects: a repository with one `origin` → that URL and `true`; no remote → `null`, `true`; two `origin` URLs (`git remote set-url --add`) → `null`, `true`; a subfolder of a repository → `false`; a plain folder → `null`, `false`; a path that is not a project of this host → `null`, `false`; 501 paths → a failed result with status 400; the answer keeps the request's order.
- [ ] **Step 2: Run** the workspace-ops test file — expected: fail.
- [ ] **Step 3: Implement**, reusing `authorizeWorkspaceDirectory` and the file's existing Git helper.
- [ ] **Step 4: Run** it — expected: pass. `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(hosts): report the Git origin of a host's projects`, push.

---

### Task 3: join and leave as pure functions

**Files:**
- Create: `lib/hosts/cluster.ts`
- Test: `lib/hosts/cluster.test.mjs`

**Interfaces:**
- Consumes: `repositoryKey` (Task 1); `GitOrigin` (Task 2); `HostPool`, `PoolProject`, `isValidPoolOrigin`, `validatePools` (`./pools`); `ManagedProject` (`../types`); `LOCAL_HOST_ID`.
- Produces:

```ts
export const CLUSTER_ID = "cluster";
export const CLUSTER_LABEL = "Cluster";
export const CLUSTER_PROJECTS_DIR = "ompweb-cluster";
export class ClusterError extends Error { constructor(readonly code: "already_member" | "not_member" | "master_cannot_leave", message: string) }
export interface HostProjectFacts { project: ManagedProject; origin: string | null; mainCheckout: boolean }
export function clusterOf(pools: readonly HostPool[]): HostPool | undefined;
export function isClusterMember(pools: readonly HostPool[], hostId: string): boolean;
/** Adds one host and moves its projects (spec M3). Returns new pools; never mutates its input. */
export function joinCluster(pools: readonly HostPool[], member: { hostId: string; projectsRoot: string }, projects: readonly HostProjectFacts[], now: string, newId: () => string): HostPool[];
/** Removes one host (spec M6). Returns new pools. */
export function leaveCluster(pools: readonly HostPool[], hostId: string): HostPool[];
```

Rules the signatures do not fix:
- `joinCluster` with no pool creates the cluster first. Only `pools[0]` changes; other pools are returned as the same objects.
- A project moves when `mainCheckout`, `isValidPoolOrigin(origin)` and `repositoryKey(origin)` is not null. It binds to the cluster project with the same `repositoryKey`, unless that project already has a `clonePaths` entry for this host; then, and in every other case, the project is left alone (pinned).
- A created project: `id: newId()`, `name: cloneDirectoryName(origin)`, `origin`, `addedAt: project.addedAt ?? now`, and the host project's `hidden` (default `false`), `alias`, `sortOrder`, `pinOrder`, `launchConfig`.
- After binding, every member gets `clonePaths[member] ??= join(member.projectsRoot, project.id)` for every cluster project.
- `leaveCluster` removes the member and deletes its `clonePaths` entry from each project unless that path is `projectsRoot` or below it.
- Both results pass `validatePools`.

- [ ] **Step 1: Write the failing tests**, one per rule:
  - no pool → a cluster with the three constants and the member;
  - bind to an existing project by another URL form;
  - create, with each presentation field carried over and `name` from the origin;
  - pinned for: `origin: null`, an invalid origin (`/srv/x`), `mainCheckout: false`;
  - two checkouts of one repository on the host → the first is bound, `clonePaths` holds only it;
  - seeding: an earlier member gets `<its projectsRoot>/<new id>` for a created project, and the joining host gets `<its projectsRoot>/<id>` for a project it has no checkout of;
  - `already_member`;
  - a second pool in the input is returned unchanged (`===`);
  - the input array and its pools are not mutated (deep-equal to a clone taken before);
  - leave: member removed; a path outside `projectsRoot` unbound; a path inside it kept; `not_member`; `master_cannot_leave` for `local`;
  - join, leave, join again with the same facts → the same project ids and no additional project.
- [ ] **Step 2: Run** `bun test --parallel lib/hosts/cluster.test.mjs` — expected: fail, module not found.
- [ ] **Step 3: Implement** `lib/hosts/cluster.ts`.
- [ ] **Step 4: Run** it — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): compute cluster joins and leaves`, push.

---

### Task 4: the join and leave requests

**Files:**
- Create: `app/api/hosts/[id]/cluster/route.ts`
- Modify: `server/routes.ts` (import and `"hosts/[id]/cluster"` entry), `lib/hosts/hub.ts` (the `hosts` channel payload), `hooks/useHostRows.ts`
- Test: `lib/hosts/cluster-route.test.mjs`, the existing `useHostRows` test if there is one

**Interfaces:**
- Consumes: Task 3's functions; `loadPools`, `savePools`; `getHost`, `getHostLinkProtocol`, `notifyHostsChange`; `listProjectsAllHosts` (`lib/hosts/session-index.ts`); `Host.workspaceOps.gitOrigins`, `.home`, `Host.supportsWorkspaceOp`; `abortBrokerRequests` (`lib/omp/auth-broker.ts`).
- Produces: `PUT /api/hosts/<id>/cluster` with JSON `{ "projectsRoot": "<absolute path>" }` → 200 `{ pools }`; `DELETE /api/hosts/<id>/cluster` → 200 `{ pools }`. Follow `app/api/hosts/[id]/updates/route.ts` for the origin check, the content type, the bounded body and the `{ error, code }` answers.

`PUT`, in order:
1. Unknown host, or `local` → 404 `unknown_host` (this machine is never joined by request).
2. `projectsRoot` not a string that passes the pool's absolute-root rule → 400 `invalid_projects_root`.
3. `loadPools()` throws → 503 `pool_storage_unavailable`.
4. Preconditions for the host, and for `local` when the cluster is missing or lacks it. Each failure is 409: `host_offline`; `host_upgrade_required` (protocol below 9, or no `gitOrigins`) for a linked host, `host_restart_required` for `local`.
5. For each host being added, `local` first: its facts are the projects `listProjectsAllHosts()` returns for that `hostId` without a `poolId`, sent to `gitOrigins`; then `joinCluster`. A failed operation → its status and code, nothing saved.
6. One `savePools`, `notifyHostsChange()`, answer.

`DELETE`: `leaveCluster` → 409 with the `ClusterError` code; one `savePools`; `abortBrokerRequests(id)` when the host's own `shareCredentials` is false; `notifyHostsChange()`.

The `hosts` channel payload gains `pools` (omitted when `pools.json` cannot be read), and `useHostRows` applies it when it is an array, so an open sidebar regroups (Review Focus 5).

- [ ] **Step 1: Write the failing tests** with a temporary agent directory and fake hosts whose `gitOrigins` and `home` are scripted:
  - first join → `pools.json` has one pool, members `local` then the host, `local`'s `projectsRoot` is `<home>/ompweb-cluster`, and both hosts' Git projects are cluster projects;
  - each 4xx/5xx above, with its code, and `pools.json` byte-identical afterwards;
  - `gitOrigins` rejecting for the second host → nothing saved, although `local` was computed first;
  - exactly one `savePools` per successful request (spy);
  - a pre-existing pool without `local` → `local` added on the next join; a second pool in the file unchanged;
  - leave → member gone; `abortBrokerRequests` called when `shareCredentials` is false and not when it is true; `local` → 409 `master_cannot_leave`;
  - the `hosts` channel frame after a join carries the new `pools`.
- [ ] **Step 2: Run** `bun test --parallel lib/hosts/cluster-route.test.mjs server/routes.test.ts` — expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run typecheck` — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): join and leave the cluster from the API`, push.

---

### Task 5: members share credentials

**Files:**
- Modify: `lib/hosts/cluster.ts`, `lib/hosts/hub.ts` (`RemoteHost.spawnRpc`), `app/api/hosts/broker/[...path]/route.ts` (`admit`)
- Test: `lib/hosts/cluster.test.mjs`, `lib/hosts/hub-v7.test.mjs`, `lib/hosts/broker-route.test.mjs`

**Interfaces:**
- Produces: `export function sharesCredentials(record: { id: string; shareCredentials: boolean }, pools: readonly HostPool[]): boolean` — false for `local`; otherwise the record's flag or `isClusterMember`.

Both callers replace their read of `record.shareCredentials` with `sharesCredentials(record, loadPools())`. A `loadPools()` that throws refuses: `spawnRpc` rejects with 503 `pool_storage_unavailable`, `admit` answers 503.

- [ ] **Step 1: Write the failing tests:** the function's four cases; a member with its own flag off gets `launch.shareCredentials === true` from `spawnRpc` and is admitted by the broker route; `local` as a member is not; with an unreadable `pools.json` both refuse with 503 and no process is started.
- [ ] **Step 2: Run** the three files — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test --parallel lib/hosts` — expected: no failure outside the baseline list.
- [ ] **Step 5: Commit** `feat(hosts): cluster members use the master's provider logins`, push.

---

### Task 6: sidebar

**Files:**
- Modify: `lib/project-ordering.ts` (`projectTargetId`, `groupProjectsByHost`), `components/SessionSidebar.tsx` (the `hostList` memo and the group loop that computes `member` and `canAdd`)
- Test: the existing `lib/project-ordering` and `components/SessionSidebar-helpers` test files

**Interfaces:**
- Produces:

```ts
export type PoolMembers = readonly { id: string; members: readonly { hostId: string }[] }[];
/** `pool:<id>` for a pool project and for a project of a host that is a member of `pools[0]`; else the host id. */
export function projectTargetId(project: { poolId?: string; hostId?: string }, pools?: PoolMembers): string;
export function groupProjectsByHost<T extends { hostId?: string; poolId?: string }>(projects: T[], hosts: { id: string; label: string }[], pools?: PoolMembers): { host: { id: string; label: string }; projects: T[] }[];
```

Within the cluster's group, pool projects keep their order and come first; the members' own projects follow. Each of those rows shows its node's name (the host label; the localized name for this machine) as a small label beside the project name, with an accessible name. A member host has no group. With no pool, every result is what it is today.

- [ ] **Step 1: Write the failing tests:** a member's non-pool project → `pool:cluster`; a standalone host's → its host id; `local` as a member → `pool:cluster`; `groupProjectsByHost` returns no group for members and orders the cluster group as above; without `pools` the existing expectations still hold; the row of a pinned project renders the node's name.
- [ ] **Step 2: Run** the two test files — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test --parallel lib components` — expected: no failure outside the baseline list.
- [ ] **Step 5: Commit** `feat(sidebar): list a cluster member's own projects under the cluster`, push.

---

### Task 7: the Settings switch, strings and documentation

**Files:**
- Modify: `components/HostsConfig.tsx`, `lib/i18n/locales/en.json`, `ja.json`, `zh-CN.json`, `README.md`, `AGENTS.md`, `CHANGELOG.md`
- Test: `components/HostsConfig.cluster.test.mjs`

**Interfaces:**
- Consumes: `useHostRows()` (`hosts`, `pools`); the two requests of Task 4; `GET /api/home?hostId=<id>` for the folder's default; the row fields `status`, `hostVersion`, `workspaceOps`.

Behaviour:
- This machine's row shows the `clusterMaster` label when a cluster exists, and no switch.
- A linked host's row has the switch. It is disabled, with the reason as its description, when the host is offline (`joinOffline`), speaks a protocol below 9 or lacks `gitOrigins` (`joinUpgrade`), or the pools could not be loaded (`poolsUnavailable`). A member's switch is never disabled for these reasons: leaving always works.
- On → a dialog with the folder field (prefilled `<home>/ompweb-cluster`, required, absolute), the two notes and `joinConfirm`; a refused request shows the server's message and keeps the dialog open.
- Off → a `ConfirmDialog` with `leaveTitle`, `leaveDescription`, `leaveConfirm`.
- A member's "Use this server's provider logins" toggle is shown on and disabled, described by `shareForced`.

Strings (keys `hostsConfig.<name>`):

| name | en | ja | zh-CN |
|---|---|---|---|
| `clusterMaster` | Cluster master | クラスターのマスター | 集群主节点 |
| `inCluster` | In the cluster | クラスターに参加 | 加入集群 |
| `inClusterAria` | {name} is in the cluster | {name} をクラスターに参加させる | {name} 加入集群 |
| `joinTitle` | Add {name} to the cluster? | {name} をクラスターに追加しますか？ | 将 {name} 加入集群？ |
| `joinFolder` | Folder on {name} for the cluster's checkouts | クラスターのチェックアウトを置く {name} 上のフォルダー | {name} 上用于存放集群检出的文件夹 |
| `joinProjectsNote` | Its Git projects become cluster projects, and their sessions are listed together with the other members'. Projects without a Git remote stay on {name}. | このホストの Git プロジェクトはクラスターのプロジェクトになり、セッションは他のメンバーのものと一緒に表示されます。Git リモートのないプロジェクトは {name} に残ります。 | 该主机的 Git 项目将成为集群项目，其会话与其他成员的会话一起列出。没有 Git 远程的项目保留在 {name} 上。 |
| `joinCredentialsNote` | {name} will use this machine's provider logins and can read their access tokens and stored API keys. | {name} はこのマシンのプロバイダーログインを使用し、アクセストークンと保存済みの API キーを読み取れます。 | {name} 将使用本机的提供商登录，并可读取其访问令牌和已保存的 API 密钥。 |
| `joinConfirm` | Add to cluster | クラスターに追加 | 加入集群 |
| `leaveTitle` | Remove {name} from the cluster? | {name} をクラスターから外しますか？ | 将 {name} 移出集群？ |
| `leaveDescription` | It gets no new cluster sessions. Its own projects are listed under {name} again. Sessions the cluster started there stay under the cluster's projects. | 新しいクラスターセッションは割り当てられなくなります。このホスト自身のプロジェクトは再び {name} の下に表示されます。クラスターがそこで開始したセッションはクラスターのプロジェクトに残ります。 | 它将不再接收新的集群会话。它自己的项目会重新列在 {name} 下。集群在其上启动的会话仍保留在集群项目中。 |
| `leaveConfirm` | Remove | 外す | 移出 |
| `joinOffline` | The host is offline | ホストはオフラインです | 主机离线 |
| `joinUpgrade` | Update ompweb on this host first | 先にこのホストの ompweb を更新してください | 请先更新该主机上的 ompweb |
| `poolsUnavailable` | The cluster configuration could not be loaded | クラスター設定を読み込めませんでした | 无法加载集群配置 |
| `shareForced` | On while the host is in the cluster | クラスター参加中は常にオン | 主机在集群中时始终开启 |

Documentation: `README.md` "Transparent host pools" (one cluster with this machine as master, the switch, what joining and leaving do, pinned projects, members' logins; correct the sentence that says existing workspaces of members stay under their host); `AGENTS.md` (file map for the new files, the cluster rules under "Remote hosts"); `CHANGELOG.md`.

- [ ] **Step 1: Write the failing tests:** the master's row; each disabled reason; on → dialog with the prefilled folder → confirm sends `PUT /api/hosts/<id>/cluster` with `{ projectsRoot }`; a 409 keeps the dialog open and shows the message; off → confirm sends `DELETE`; a member's share toggle is on and disabled.
- [ ] **Step 2: Run** it — expected: fail.
- [ ] **Step 3: Implement**; write the documentation.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test` — expected: no failure outside the baseline list.
- [ ] **Step 5: Commit** `feat(hosts): cluster switch in Settings`, then `docs(hosts): document cluster membership`, push.

---

### Task 8: end-to-end proof (throwaway, nothing committed)

Two temporary home directories, a free port, the installed `omp`. Host `b` gets three folders registered as projects: `repo-a` (`git init`, origin `git@github.com:probe/a.git`), `repo-b` (origin `https://github.com/probe/b`) and `plain` (no Git). The server's home gets `repo-a2` with origin `https://github.com/probe/a`.

- [ ] **Step 1:** `npm run build`; start the server and `ompweb host` for both homes as `scripts/smoke.ts` does; link `b`.
- [ ] **Step 2:** `PUT /api/hosts/<b>/cluster` with `b`'s folder. Expected: 200; `pools.json` has one pool with members `local` and `b`; one project for `probe/a` bound to both checkouts; one for `probe/b` bound on `b` and seeded under `<home>/ompweb-cluster/<id>` for `local`.
- [ ] **Step 3:** `GET /api/projects`. Expected: the two cluster projects, and `plain` with `hostId` `b` and no `poolId`.
- [ ] **Step 4:** Start a session in `repo-a` on `b`. Expected: `GET /api/sessions` lists it with the `probe/a` project key, and the server log shows a `broker <b>` request although `b`'s own sharing flag is off.
- [ ] **Step 5:** `DELETE /api/hosts/<b>/cluster`. Expected: `b` is not a member; `repo-a` and `repo-b` are listed as `b`'s projects again; the session of step 4 is under `b`; `probe/a` is still a cluster project through `local`.
- [ ] **Step 6:** Stop both processes, delete both homes, report each expectation as met or not.

The live run on the Proxmox hosts stays with the user.
