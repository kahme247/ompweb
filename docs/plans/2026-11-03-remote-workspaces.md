# Remote Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository instructions override the skill's review/delegation defaults: use one condensed adversarial review round, not a fresh review lane after every task.

**Goal:** Give local and remote workspaces the existing Explorer, file viewer, Git, worktree, directory-picker and clone behavior, with Explorer using the existing 2 GiB/file uploader.

**Architecture:** Every affected route resolves a Host and delegates filesystem/Git work to its daemon, including local. Add typed workspace operations beside session operations; reuse the existing uploader, path policy and browser event channel. Carry host identity on resources and pending actions, not just the selected chat.

**Tech Stack:** TypeScript, React, Bun HTTP server, Node `ompweb host` daemon through jiti, existing sequenced WebSocket links, `bun test --parallel` running existing `node:test` suites. No new dependency.

**Spec:** `docs/specs/2026-11-03-remote-workspaces-design.md` (approved, including the shared-uploader correction). Upload transport reference: `docs/specs/2026-11-02-file-uploads-design.md`.

## Global Constraints

- Code baseline: freshly fetched `upstream/main`. Planning snapshot: `3c2a31a5`; design checkpoint: `32fe0e34`. Implement in this task's external linked worktree; preserve other sessions' work. Before implementation, incorporate newer upstream changes without rewriting shared branches.
- `LINK_PROTOCOL_VERSION = 6`, `MIN_LINK_PROTOCOL_VERSION = 4`, `UPLOADS_SINCE_VERSION = 6`: retain them. Workspace advertisement and notifications are additive; unsupported operations are explicit, never direct-local fallback.
- Reuse `uploadFile`, `lib/uploads.ts` and `StagedUploads`. `MAX_UPLOAD_BYTES = 2 * 1024 ** 3`, `UPLOAD_WINDOW_BYTES = 2 * 1024 * 1024`; pieces are at most 256 KiB. Remove Explorer's legacy 25 MiB/file, 100 MiB/batch and whole-multipart path. The 20-files-per-message limit belongs only to prompts.
- Preserve 256 KiB text and 10 MiB image/DOCX preview limits, binary download/range semantics, hidden-item toggle, current search caps and truncation. No whole-file download cap.
- Read handles and abandoned clone jobs expire after two idle minutes. Uploads retain their existing retry/cancel/sweep behavior, not a new expiry. Workspace publications are never enrolled in session attachment retention.
- Daemon-loaded code uses relative imports and Node APIs only. Browser code uses neither `AbortSignal.timeout/any` nor `Promise.withResolvers`. Reuse shared primitives/icons; localize added user-facing strings in all three locale files.
- Main does not stat/resolve/open remote paths. Daemon roots derive from its own sessions/projects/grants. Keep credential exclusions, realpath containment and owning-session reference checks.
- No permanent tests for source text, op counts, wiring or mock echoes. Test observable authorization, bytes, state transitions, conflict precedence and isolation. Remove obsolete incidental-behavior assertions rather than re-pinning them.
- Implementers do not run build/lint/tests/formatters mid-flight. The integration owner runs the failing test before the implementation handoff and the focused proof afterward; full checks run once after integration. Follow TDD without concurrent suites racing shared fixtures.

## Review Focus

1. Identical file paths on different hosts, followed by a slow response after a chat switch: file tabs and pending uploads must keep their original owner (Tasks 2–4).
2. Destination created/swapped after upload inspection, or disk failure during replacement: no unauthorized write and no loss of the old file; lost success replies cannot overwrite twice (Task 3).
3. Empty files, exact preview boundaries, suffix ranges and a replaced/truncated file mid-download: correct HTTP/byte behavior without whole-file buffering (Task 1).
4. Main/daemon restarts and reconnects with active watches/clones/uploads: no orphan watcher, false completion, duplicate publication or fallback to another host (Tasks 3, 4, 6).
5. Old linked daemon, linked host without omp, Windows/UNC/tilde paths and dev beside production: feature capability is distinct from link availability; browsing does not grant content access (Tasks 1, 5, 6).

## File Ownership and Delivery

| Area | Owns | Files |
| --- | --- | --- |
| Shared workspace contract | Serializable request/results and named op parameters; no daemon implementations imported into browser | new `lib/workspace-types.ts`; `lib/hosts/host.ts`, `link-protocol.ts` |
| Daemon file service | Root discovery/grants, file operations and descriptor lifetime | new `lib/hosts/workspace-roots.ts`, `workspace-ops.ts`, `workspace-reads.ts`; `lib/file-authorization.ts`, `file-access.ts` |
| Existing file index | Move scanner/cache out of route without changing search behavior | new `lib/file-index.ts`; `app/api/file-index/route.ts` |
| Main routing | Host resolution, validated responses, HTTP headers/streams | `lib/api-utils.ts`, `app/api/files/[...path]/route.ts`, file-index and bash-output routes |
| Browser resource owner | Tab identity, links, queries, media URLs and stale-request fencing | `AppShell`, `TabBar`, `RightPanel`, `FileExplorer`, `FileViewer`, `MarkdownBody`, `ChatWindow`, `ChatInput`, `lib/types.ts`, `file-paths.ts` |
| Existing upload pipeline | Workspace destination publication only; existing transport unchanged | `lib/uploads.ts`, `lib/hosts/uploads.ts`, file POST route, `FileExplorer` |
| File watch | Daemon watcher lifecycle; existing browser file channel | new `lib/hosts/workspace-watch.ts`; `daemon.ts`, `hub.ts`, `event-stream-hub.ts`, `event-stream-protocol.ts` |
| Git/worktree | Existing helpers execute on owning daemon; host-local cache invalidation | `lib/git-changes.ts`, `github-repo.ts`, `worktree.ts`; workspace ops, routes, sidebar/panels |
| Directory/clone | Existing browsing helpers; daemon-owned child, cleanup and bounded progress | new `lib/hosts/workspace-clone.ts`; existing directory/clone routes and picker |

Tasks 1–4 form the first complete files PR. Do not merge a transport-only scaffold or claim file parity before all four are proven. Task 5 is the Git/worktree PR; Task 6 completes browsing/clone. Each PR updates its own changelog/docs and passes its changed paths. Shared hub/protocol/Host edits have one integration owner. Do not fan out workers editing those shared files concurrently.

## Shared Contract Decisions

Add these types in `lib/workspace-types.ts`; operation-specific extensions are owned by the tasks below:

```ts
interface WorkspaceFileRequest { segments: string[]; sessionId: string | null }
interface WorkspaceFileInfo {
  path: string; name: string; size: number; mtimeMs: number; isDirectory: boolean;
  language: string; mime: string; previewKind: "pdf" | "docx" | null;
}
interface WorkspaceDirectoryListing {
  path: string; entries: Array<{name: string; isDir: boolean; size: number; modified: string}>;
}
interface WorkspaceRead { id: string; info: WorkspaceFileInfo }
// FileIndexEntry comes from lib/file-fuzzy.ts.
type WorkspaceIndex = {files: string[]; truncated: boolean}
  | {matches: FileIndexEntry[]; truncated?: boolean};
```

`WorkspaceOps` methods return `Promise<OpResult<T>>`, using the existing `OpResult` from session ops. Add `Host.workspaceOps` and `Host.supportsWorkspaceOp(name: keyof WorkspaceOps): boolean`. `WORKSPACE_OP_PARAMS` maps each implemented method to its named arguments, as `SESSION_OP_PARAMS` does. Add its names to `HOST_OP_NAMES` without renaming existing session ops. Validate daemon arguments and main-side results; failures keep the existing typed host errors.

`hello.workspaceOps?: string[]` advertises implemented operation names; absent means unsupported. Filter to known names and bound the advertised list to the known registry size. Store the set on the hub link and expose `workspaceOps: string[]` on both local and linked host rows, for `GET /api/hosts` and its live channel. A linked `omp-missing` host still serves workspace operations. Unsupported workspace methods return 501 `workspace_unsupported`; existing composer upload version errors remain 426 with their existing codes.

Instantiate `createWorkspaceService(uploads: StagedUploads): {ops: WorkspaceOps; onDisconnect(): void; stop(): Promise<void>}` once inside `runHostDaemon`, passing its existing `uploads` instance. Task 4 adds the file-event emitter argument at that factory and its sole caller. `onDisconnect` closes read/watch resources, not staged uploads or running clone jobs; `stop` also cancels clone jobs. The daemon's existing `localHost` remains its spawn/session adapter: narrow its annotation to `Omit<Host, "workspaceOps" | "supportsWorkspaceOp">` rather than constructing another uploader/service just to satisfy main's Host seam. Update real Host fixtures structurally, without successful no-op implementations of the new operations.

Add `resolveWorkspaceHost(hostId: unknown, sessionId: string | null): Promise<{host: Host} | {response: Response}>` in `lib/api-utils.ts`. Omitted host plus omitted session selects local; session alone resolves its owner; both require agreement or 409 `workspace_host_mismatch`. Invalid IDs never become local. Use it in file HTTP routes and file subscriptions. Pass raw path segments/cwd to the daemon; do not normalize them with main's filesystem.

### Task 1: Host-owned authorized file HTTP service

**Files:** Create the contract/root/read/service/index modules listed above and `lib/hosts/workspace-files.integration.test.mjs`, `workspace-reads.test.mjs`. Modify Host/protocol/daemon/hub/local-host, `api-utils.ts`, `file-authorization.ts`, file and index routes, `app/api/home/route.ts`, `app/api/agent/[id]/bash-output/route.ts`. Adapt existing file-route, file-access, index, server and host fixtures to the daemon boundary. Update `CHANGELOG.md` for the files PR while implementing its surface.

**Interfaces:**

```ts
// lib/hosts/workspace-roots.ts, daemon only
getWorkspaceRoots(): Promise<Set<string>>;
grantWorkspaceRoot(path: string): void;
invalidateWorkspaceRoots(): void;
// lib/file-authorization.ts: make roots explicit at all callers, preserving shared policy
authorizeFileAccess(segments: string[], sessionId: string | null,
  allowSessionReference: boolean, roots: Set<string>): Promise<FileAccessDecision>;
// WorkspaceOps additions
home(): Promise<OpResult<{home: string}>>;
listFiles(input: WorkspaceFileRequest, showHidden: boolean): Promise<OpResult<WorkspaceDirectoryListing>>;
listFilesInRoot(input: WorkspaceFileRequest, root: string | null): Promise<OpResult<WorkspaceDirectoryListing>>;
fileInfo(input: WorkspaceFileRequest): Promise<OpResult<WorkspaceFileInfo>>;
readTextFile(input: WorkspaceFileRequest): Promise<OpResult<{content: string; language: string; size: number}>>;
openFile(input: WorkspaceFileRequest): Promise<OpResult<WorkspaceRead>>;
readFileChunk(id: string, offset: number, length: number): Promise<OpResult<Uint8Array>>;
closeFile(id: string): Promise<OpResult<null>>;
fileIndex(cwd: string, query: string, limit: number, kind: "all" | "file", refresh: boolean): Promise<OpResult<WorkspaceIndex>>;
readBashOutput(sessionId: string, path: string): Promise<OpResult<
  {tooLarge: true; size: number; maxBytes: number} | {tooLarge: false; output: string}>>;
openBashOutput(sessionId: string, path: string): Promise<OpResult<WorkspaceRead>>;
```

- [ ] **Step 1: Write behavioral regressions.** Actual daemon/HTTP fixtures prove `readTextFile` returns the owning host's bytes; outside-root listing/read and credential symlink escapes return 403; a valid same-host session reference grants read but not listing/write; a mismatched host/session returns 409. Explicit directory validation grants only its daemon. Include all-name lazy tree listings with root confinement, Git-ignore-aware search, bounded non-Git traversal and the existing 200-result/5,000-prefix distinction. Preserve the original listing wire contract while adding the root-confined capability.
- [ ] **Step 2: Run the new test before implementation.** `bun test --parallel lib/hosts/workspace-files.integration.test.mjs lib/hosts/workspace-reads.test.mjs` must fail on missing workspace service/observed remote read, not on fixture setup. Preserve that failure receipt.
- [ ] **Step 3: Implement roots and the service.** Root discovery reads this daemon's `listAllSessions()` and visible project registry, explicit validated grants, scratch directories and config/instruction roots. Invalidate after `validateCwd`, project add/update/hide and later worktree mutations. Keep main's `getAllowedFileRoots()` for unrelated config/import/skills routes; do not change those callers onto host ops. Reuse path policy with explicit roots; enforce exclusions on the resolved target and realpath. Node helpers must not invoke main's session-index/hub to discover roots.
- [ ] **Step 4: Implement descriptor-backed reads and HTTP cutover.** `workspace-reads.ts` owns descriptors by random read ID, closes idempotently, rejects invalid offsets/lengths and expires idle handles at 120,000 ms. A read request is positive and at most `LINK_LIMITS.pieceBytes`; main pulls only enough chunks for the selected range. Zero-byte files close without requesting a chunk; premature EOF errors the response. Keep one opened descriptor across path replacement. Extend daemon `answer` and hub `settle` to handle `readFileChunk` raw bytes, including size checks, without changing `readMedia`. Main preserves GET response shapes, Content-Disposition/CSP, 206/416/suffix handling and idle-timeout lifting. Convert DOCX only from bounded returned bytes. Extract index scanner/cache unchanged; its cache now resides on each daemon. For bash output use that host's `resolveBashOutputPath(path, tmpdir())`, owning-session reference check and `openRegularFileNoFollow`; `openBashOutput` registers the already validated handle, never reopens its pathname. `readBashOutput` retains `MAX_INLINE_BASH_OUTPUT_BYTES` (5 MiB); main maps its tooLarge variant to the existing 413/data body and success to `{success:true,data:{output}}`.
- [ ] **Step 5: Prove read lifecycle and boundaries.** In permanent tests assert text at 256 KiB is 200 and +1 is 413, empty download is 200 with zero bytes, valid suffix/range bytes are exact, invalid range is 416, and replacing the pathname after open does not splice a second file. Cancel closes the read; disconnect fails the response and cannot reopen on another host. Exercise a sparse >64 MiB file through real HTTP with streaming digest, not `arrayBuffer()`. Include malformed capability/result data and an old hello: sessions stay usable, workspace service is unsupported. Run the focused suites plus existing `lib/file-access.test.mjs`, `lib/files-list-hidden.test.mjs`, `lib/file-index-route.test.mjs`, `server/app.test.ts` with `--parallel` after integrating their fixture migrations.
- [ ] **Step 6: Commit the working service.** `feat(hosts): serve authorized workspace files through each daemon`. This is a verified internal checkpoint, not the completed files PR.

### Task 2: Host-scoped Explorer, file tabs, links and suggestions

**Files:** Modify `components/AppShell.tsx`, `components/TabBar.tsx`, `components/RightPanel.tsx`, `components/FileExplorer.tsx`, `components/FileViewer.tsx`, `components/MarkdownBody.tsx`, `components/MessageView.tsx`, `components/ChatWindow.tsx`, `components/ChatInput.tsx`, `hooks/useAgentSession.ts`, `hooks/useAgentSession-stream.ts`, `lib/rpc-manager.ts`, `lib/types.ts`, `lib/file-paths.ts` and `lib/workspace-types.ts`. `components/AppShell-layout.tsx` only needs a change if its workspace fallback actually carries the new context; it does not own file-resource state. Add `components/FileViewer.hosts.test.mjs` and `components/FileExplorer.hosts.test.mjs`; extend existing AppShell/markdown-link/bash-output suites only for observable ownership behavior.

**Interfaces:** Extend the existing in-memory `Tab` interface in `components/TabBar.tsx` with required `hostId: string` and `sourceCwd: string | null`, preserving `sourceSessionId`. Migrate all creators/fixtures; do not retain an ownerless Tab variant. Explorer/Git panel props also require their host ID. Add shared `WorkspaceFileSource = {hostId: string; cwd: string | null; sessionId: string | null}` and migrate the existing top-level open callback to `(filePath: string, fileName: string, source: WorkspaceFileSource) => void`, without an old-signature overload. FileViewer and its diff/relative-link context use the tab's stored host/cwd, not the selected chat. File API URLs include owning host/session for every read/meta/preview/download. Task 1's home operation replaces the old global home cache; tilde expansion is host-owned.

- [ ] **Step 1: Write ownership regressions.** Render two files of the same path on different host identities; keep both tabs and distinct contents. Switch chat while the first read is pending; its response cannot change the second host's file. A relative markdown/image link, tilde link and download stay on their source host. Cross-session `open_file` confirmation after navigation still opens on its origin host/cwd, not the current chat; remote bash output is read/downloaded from its owning session. Toggle Show hidden items during an old listing request; stale results cannot restore the old listing mode. Mention/reveal from an A-owned tab while Explorer/composer is on B must not insert/reveal A's path on B.
- [ ] **Step 2: Run focused tests red.** `bun test --parallel components/FileViewer.hosts.test.mjs components/FileExplorer.hosts.test.mjs` must expose current path-only deduplication/hostless URLs.
- [ ] **Step 3: Thread ownership end to end.** Deduplicate tabs and key caches by normalized host + path; reuse existing host/path helpers. Carry originating host/cwd in `CrossSessionHostToolCall` from the emitting wrapper and in pending confirmations, and migrate hook open callbacks. Bash-output generation guards include session/host identity; its server route resolves the owning session, never main's temp directory. Chat markdown images get the same source context as links. Composer index base/query cache and GitHub context dependencies include host. Abort/fence old-owner continuations; retain existing listing generations, hidden preference, lazy rows and Edit identity-move mounting. Disable cross-host mention/reveal with a localized reason rather than retargeting the active composer/Explorer; copy/download still use the tab's owner. Remove file/Explorer gates only when connected, leaving later Git/worktree/config gates intact. Content-addressed tool media (`/api/media/<hash>`) already uses host hash lookup and is not migrated into workspace-path APIs.
- [ ] **Step 4: Prove the UI.** Green focused tests, then a real browser with two isolated hosts: tree listing, text/image/PDF, downloaded bytes, relative links and @ suggestions. Keep host A's file tab while selecting host B; prove the tab and its URLs still address A. Browser console must stay clean. Live browser checks, not new source-text or prop-forwarding assertions, prove this slice.
- [ ] **Step 5: Commit.** `feat(explorer): keep workspace files and suggestions scoped to their host`.

### Task 3: Explorer reuses the 2 GiB upload pipeline

**Files:** Modify `lib/hosts/uploads.ts`, `lib/uploads.ts`, workspace contract/service, daemon/hub, `app/api/files/[...path]/route.ts`, `components/FileExplorer.tsx`, locales and affected upload fixtures. Create `lib/hosts/workspace-upload.test.mjs` and extend `lib/uploads.test.mjs` plus Explorer ownership tests. Reuse `lib/file-upload.ts` conflict types/checks and existing `lib/upload-limits.ts`; do not create another transport helper.

**Interfaces:**

```ts
interface WorkspaceUploadResult { path: string; name: string; skipped: boolean }
// WorkspaceOps additions
inspectUploads(directory: string, names: string[]): Promise<OpResult<UploadTargetInspection>>;
publishUpload(id: string, directory: string, name: string,
  conflict: UploadConflictStrategy): Promise<OpResult<WorkspaceUploadResult>>;
// lib/uploads.ts: main's owner/host checks before requesting workspace publication
publishWorkspaceUpload(id: string, owner: string, hostId: string,
  directory: string, name: string, conflict: UploadConflictStrategy): Promise<WorkspaceUploadResult>;
```

File POST retains `type=upload-check` with its 1 MiB bounded JSON; `type=upload&conflict=...` becomes bounded JSON `{hostId?, uploads: [{id, name}]}` rather than multipart bytes. Per-file publication yields the existing `{uploaded, skipped, errors}` batch outcome and 207 on mixed errors. Validate distinct names using the destination machine's Windows/case rules. Main must not inspect target paths locally.

- [ ] **Step 1: Write publication regressions.** Stage through the real uploader, then publish into an authorized directory. Assert exact bytes, same-owner/host enforcement, incomplete upload refusal, invalid/path-traversal names, directory/symlink target refusal and each conflict choice. Create a target after inspection: `error` rejects and `skip` preserves its bytes. Fail the copy/publication before commit: the old overwrite target remains intact. Lose the success reply, change the destination afterward, retry: the receipt answers the original result without replacing that later file again. A different destination/strategy for that upload ID conflicts.
- [ ] **Step 2: Run red.** `bun test --parallel lib/hosts/workspace-upload.test.mjs lib/uploads.test.mjs` must fail on the missing authorized publication, not re-prove the existing uploader.
- [ ] **Step 3: Add publication where staging lives.** Add `StagedUploads.publish(id: string, directory: string, name: string, conflict: UploadConflictStrategy): Promise<WorkspaceUploadResult>` under its per-ID `control` serialization; the workspace service delegates to its existing shared instance. Workspace publication and session attach are mutually exclusive destinations. Add a disjoint workspace receipt in metadata; update start/replay/abort/sweep parsing so a published receipt cannot become a new `.part` or a session attachment. Main retains enough owner registration to repeat a lost-reply publication safely; do not `forgetUploads` before the caller has its receipt. Use the existing 10-minute long-copy deadline for this workspace method, not the ordinary 30-second op timer.
- [ ] **Step 4: Preserve existing files during commit.** Prepare complete bytes in a private exclusive sibling on the destination filesystem; cross-device copy streams without whole-file allocation. Authorize and recheck the canonical destination immediately before commit. For `error`/`skip`, an exclusive publish must resolve the race atomically; for explicit overwrite, replace the regular-file target atomically without unlinking it first. Refuse unsupported safe replacement rather than deleting the old file. Record the prepared candidate identity before replacement and the committed receipt afterward; uncertain interrupted publication is reconciled against that candidate or fails 409 `upload_publish_uncertain`, never blindly overwrites again. Cleanup removes only owned staging, never a replacement file. Keep workspace receipts outside session-retention enrollment.
- [ ] **Step 5: Migrate Explorer.** Use existing `uploadFile(file, capturedHostId, onProgress, id, onReconnecting)` and `UploadHandle`; batch conflict inspection precedes bounded/sequential staging/publication. Preserve explicit overwrite/skip dialogs and per-file results; cancellation removes only pending staging, never an already published workspace file. Host/cwd switch cannot retarget work or apply results to the newly selected tree. Remove multipart `file.arrayBuffer()`/legacy byte caps and obsolete tests. Existing uploader still owns retry, WS/SSE fallback, durable abort and backpressure.
- [ ] **Step 6: Prove large-file behavior.** Green publication tests and existing composer upload suites. Browser smoke in both WS and SSE modes uploads a >25 MiB file and a >100 MiB batch to local and remote destinations; stream SHA-256 on destination files. Test 2 GiB acceptance and +1 refusal using sparse files/declared sizes without allocating 2 GiB, and exercise cancellation/reconnect with smaller real content. Do not claim a real 2 GiB transfer unless one was actually run. Verify `abort`/sweep removes receipt/staging but never published workspace data or composer attachments.
- [ ] **Step 7: Commit.** `feat(explorer): publish workspace uploads through the shared large-file uploader`.

### Task 4: Daemon-owned file watch and completed files cutover

**Files:** Create `lib/hosts/workspace-watch.ts` and `workspace-watch.test.mjs`; modify protocol/daemon/hub/workspace service, `lib/event-stream-protocol.ts`, `event-stream-hub.ts`, FileViewer's existing `watchFile`, host rows and `hooks/useHostRows.ts` if its parser needs the advertised names. Extend hub/worker integration tests only for lifetime/authorization behaviors. Update `CHANGELOG.md`, `README.md`, `README.ja.md`, `README.zh-CN.md` and repository architecture guidance as needed to describe completed files behavior.

**Interfaces:** `WorkspaceOps.watchFile(id: string, epoch: string, input: WorkspaceFileRequest): Promise<OpResult<WorkspaceFileInfo>>`, `unwatchFile(id: string, epoch: string): Promise<OpResult<null>>`. Add sequenced uplink `workspace_file {seq, id, epoch, event}` where event is the existing change/error payload. Add `hostId?: string` to the existing file channel. Hub subscription ownership maps `(hostId, id, epoch)` to the authorized consumer; the daemon cannot name browser channel IDs. Unwatch/close are idempotent.

- [ ] **Step 1: Write lifecycle regressions.** Authorized real daemon watch observes a save; outside-root and cross-host session watches fail. Burst saves produce the final mtime/size. Save during an outage then reconnect: the fresh stat updates the viewer before it reports connected. A late old-epoch event after tab close or new subscription does nothing. Closing one browser file tab leaves another host's same-path watcher untouched.
- [ ] **Step 2: Run red.** `bun test --parallel lib/hosts/workspace-watch.test.mjs lib/event-stream-hub.test.mjs` must expose the missing daemon lifetime path.
- [ ] **Step 3: Move watch ownership.** Use the same daemon authorization as reads, `fs.watch`, mtime/size deduplication and existing 50 ms trailing stat. Clear daemon watches/timers when their socket ownership ends; main reconnect creates new epochs after reauthorization. Register main routing before starting the op so immediate events cannot fall into a gap; obtain a fresh authoritative stat before publishing connected. Host loss puts the file consumer into reconnecting/error state, without replacing its path with local. Close/unmount/unsubscribe settles pending starts and ignores late continuations. Do not add another browser connection.
- [ ] **Step 4: Finish the files PR proof.** Green focused and affected existing suites; real browser edit/reload, tab close, socket replacement, main restart and daemon restart. Local daemon stopped and dev local offline both show unavailable, never hidden local reads. Old daemon shows the upgrade hint while its sessions still work. Inspect raw HTML/media responses for unchanged security headers. Ensure no affected file/index/bash-output/watch route opens disk on main; keep out-of-scope config readers unchanged. Run the shared final gates below; then request the single condensed review for this PR, open it, register pr-watcher and follow repository CI/bot rules.
- [ ] **Step 5: Commit.** `feat(files): watch workspace changes on their owning daemon`.

### Task 5: Git and worktrees on the owning host

**Files:** Modify workspace types/service/registry, `lib/worktree.ts`, `app/api/git/{status,diff}/route.ts`, `app/api/github-repo/route.ts`, `app/api/worktrees/route.ts`, `components/SessionSidebar.tsx`, `RightPanel.tsx`, `WorktreesPanel.tsx`, `GitChangesPanel.tsx`, `ChatWindow.tsx`, and their helpers/tests. Add `lib/hosts/workspace-git.test.mjs` and `workspace-worktrees.integration.test.mjs`. Reuse `git-changes`, `github-repo`, `projectIdentityKey` and worktree helpers, not a second Git implementation.

**Interfaces:** Add these async methods to WorkspaceOps; use existing `GitStatusResponse`, `GitFileDiffResponse` and `WorktreeInfo` as type-only imports.

```ts
interface WorkspaceWorktrees {
  projectRoot: string; projectKey: string; isGit: boolean; isTopLevel: boolean;
  currentWorktreePath: string | null; worktrees: WorktreeInfo[];
}
gitStatus(cwd: string): Promise<OpResult<GitStatusResponse>>;
gitDiff(cwd: string, path: string): Promise<OpResult<GitFileDiffResponse>>;
githubRepo(cwd: string): Promise<OpResult<{repo: string | null}>>;
listWorktrees(cwd: string): Promise<OpResult<WorkspaceWorktrees>>;
addWorktree(cwd: string, branch: string): Promise<OpResult<{path: string; branch: string}>>;
removeWorktree(cwd: string, path: string, force: boolean): Promise<OpResult<null>>;
```

- [ ] **Step 1: Write actual-repository regressions.** One daemon temp repository returns its own modified file and patch, resolves its remote and lists/creates a worktree. Dirty removal is 409 `worktree_dirty` with `dirty:true`; explicit force removes only a matched linked worktree. Main worktree, unrelated path and symlink escape are refused. New worktree is immediately readable on that host; another host is not granted it. A delayed worktree list after host switching cannot replace the current selector.
- [ ] **Step 2: Run red.** `bun test --parallel lib/hosts/workspace-git.test.mjs lib/hosts/workspace-worktrees.integration.test.mjs` fails before route migration.
- [ ] **Step 3: Route existing helpers through the daemon.** Authorize cwd/path on daemon; preserve status/diff output and git time/buffer limits. Worktree grant/invalidation moves to the owning daemon wrapper rather than calling main's root-grant helper from `worktree.ts`; main invalidates only `invalidateHostSessionList(host.id)`. Make grant/check changes at actual helper callers identified with LSP. Preserve branch validation, removed-worktree inference, samePath Windows handling and main-worktree protection.
- [ ] **Step 4: Enable all clients.** Add host to route params/bodies, cache and pending-action keys in sidebar, Git panels, FileViewer diff, GitHub context and new-session selector. Remove only these remote gates. A switch changes the selected new-session workspace on that host, not the open chat or another host's Explorer. Pass owning host to home lookup. Preserve dirty confirmation and disable destructive controls during their own operation.
- [ ] **Step 5: Verify and publish the Git/worktree PR.** Green new tests plus `lib/git-changes.test.mjs`, `lib/github-repo.test.mjs`, `lib/worktree.test.mjs` and affected sidebar tests. Browser: status, diff, create/select and dirty remove/force on a disposable repo. Include Windows path spellings and detached HEAD tests. Update changelog/guidance, run final gates, commit `feat(hosts): route Git and worktrees through the workspace daemon`, then the single condensed review/PR/watcher workflow.

### Task 6: Directory browsing, default workspaces and clone lifecycle

**Files:** Create `lib/hosts/workspace-clone.ts`, `workspace-clone.test.mjs` and `workspace-directories.test.mjs`. Modify workspace types/service, daemon/hub, `app/api/cwd/{browse,validate}/route.ts`, `home/route.ts`, `default-cwd/route.ts`, `projects/clone/route.ts`, `DirectoryPicker.tsx`, `AppShell.tsx`, `SessionSidebar.tsx` and locales. Reuse `directory-browser.ts`, `git-clone.ts`, project operations and sanitized command environment.

**Interfaces:** Add the following types and async WorkspaceOps methods; `BrowsableDirectory` comes from `lib/directory-browser.ts` as a type-only import. Clone progress types live with the existing pure helpers in `lib/git-clone.ts`.

```ts
type WorkspaceDirectoryBrowse =
  | {path: string; parentPath: string | null; directories: BrowsableDirectory[]}
  | {path: ""; parentPath: null; directories: []; drives: BrowsableDirectory[]};
type CloneFrame =
  | {type: "output"; text: string}
  | {type: "done"; path: string}
  | {type: "cancelled"; path: string}
  | {type: "error"; error: string; code: string};
interface CloneProgress { cursor: number; reset: boolean; frames: CloneFrame[]; terminal: boolean }
browseDirectories(path: string | null): Promise<OpResult<WorkspaceDirectoryBrowse>>;
defaultCwd(): Promise<OpResult<{cwd: string}>>;
startClone(id: string, parent: string, url: string): Promise<OpResult<{id: string}>>;
readClone(id: string, cursor: number): Promise<OpResult<CloneProgress>>;
cancelClone(id: string): Promise<OpResult<CloneProgress>>;
```

- [ ] **Step 1: Write directory/clone regressions.** Host home, `~`, parent/child and Windows drive navigation address the selected host. Browsing alone does not grant a file read; successful validate/selection grants its canonical cwd. Default scratch directory is created/granted only there. Deterministic clone lifecycle tests use a controllable child executable that creates files, emits progress and waits for cancellation; assert actual process exit and filesystem cleanup, not echoed spawn arguments. Existing target refuses 409 and survives. A separate smoke uses real Git with an allowed HTTPS/SSH repository; never weaken the production protocol allow-list to permit `file://` for a test.
- [ ] **Step 2: Run red.** `bun test --parallel lib/hosts/workspace-directories.test.mjs lib/hosts/workspace-clone.test.mjs` fails on missing operations.
- [ ] **Step 3: Move browsing/default cwd and complete client ownership.** Reuse Task 1's home operation and route. Other directory operations use the owning daemon's existing directory helpers and os/path APIs. Thread host into browse/default-cwd requests and URL-restored cwd validation. Enable picker Go/Clone for capable remote hosts; its host prop must include ID, not just the display name. A Clone here click validates/selects its parent through the existing host-aware cwd route before clone creation; merely navigating there grants nothing. Add optional `projectKey?: string` to `SessionOps.validateCwd` results: new daemons calculate it using their own platform. Main uses that value, or the existing platform-independent `comparableProjectPath` on the canonical returned root for an older daemon; never call main-platform `projectIdentityKey` on a remote Windows root.
- [ ] **Step 4: Move clone execution/cleanup into a daemon job.** Extract the route's actual process-group/taskkill cancellation and sanitized Git env. Reserve target exclusively; retain its original identity and only clean up the owned target, never a pre-existing path or a replacement. `startClone` returns promptly; `readClone` waits at most 1,000 ms. Keep a 256 KiB progress ring with byte cursors, explicit reset when the consumer fell behind and terminal result separate from evictable output. A two-minute unobserved job cancels; terminal pages remain readable for two minutes. Cancellation resolves only after process exit and cleanup; cleanup failure remains an explicit error. Main streams existing NDJSON and maps HTTP cancel to the captured host/job. A link gap yields uncertainty, not a fabricated cancellation; a new daemon's unknown job never means done. Keep registration as the existing host project op after confirmed `done`.
- [ ] **Step 5: Verify and publish completion.** Green focused tests and existing directory/git-clone suites. Browser navigate/validate/clone/cancel on local and remote disposable hosts; exercise main restart, daemon loss, late cancellation, bounded progress rollover and old daemon hints. Run final gates, update changelog/guidance and commit `feat(hosts): browse and clone workspaces on their owning daemon`. Complete the single condensed review/PR/watcher workflow and check only proven issue items.

## Final Gates (for each complete PR, once after integration)

1. Run `npm run typecheck && npm run lint && npm test && npm run build && npm run smoke`; capture actual output. Retain `--parallel` for every multi-file Bun subset. No permanent claim of a passed suite without this PR head's result. New imported source modules do not need copied runtime assets; if extraction introduces one, update binary/package copy lists and exercise the packaged/binary smoke mode too.
2. Exercise the actual browser surfaces and Node daemon with throwaway HOME, host registry, projects and Git repositories. Use separate machines/filesystem namespaces for the identical-absolute-path case; do not simulate a remote by reading main's copy. Do not stop/reconfigure production daemons. Report an unavailable live Windows host separately from deterministic Windows-path coverage.
3. Check all eight spec acceptance scenarios against the completed tasks. Remove throwaway smoke scaffolds. Update docs/changelog for real completed behavior; keep config/archive/transcript-search gates and parent issue open for their separate work.
4. Dispatch one `reviewer` with the spec, plan, current diff and observed checks: condense contract, correctness/hostile input, test honesty and over-engineering into one adversarial round. Fix verified findings; re-run affected proof. No four-lane fan-out and no Copilot requests.
5. Open the upstream PR only after review fixes, register `pr-watcher` immediately, and follow its updates for CI and bot reviews. Verify base-repository permissions and each bot's current availability before requesting Codex/CodeRabbit. Never merge automatically or deploy without the required authorization. Preserve commits on the writable fork's WIP ref at every approval/wait handoff.

## Planning Self-Review

- Scope maps to Tasks 1–4 (all files, uploads, suggestions, watches), Task 5 (Git/worktree) and Task 6 (directory/clone); global compatibility and out-of-scope boundaries apply to each.
- No new upload transport or copied session-file fallback remains. Workspace publication is the sole new write destination.
- All new interface names are defined above their consumers. Async WorkspaceOps return the shared OpResult envelope; upload publication's main-facing helper unwraps it for HTTP use.
- Each task includes a concrete negative/boundary behavior, a failing-before/passing-after command and actual changed-path smoke proof. Final gates are cross-surface acceptance, not another implementation task.
- These are planned checks, not executed implementation results. The written plan must be reviewed and an execution method selected before product edits begin.
