# One host daemon, several web servers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one `ompweb host` daemon links several web servers at once; all of them show and drive the same sessions, and the daemon owns each omp process's lifecycle.

**Architecture:** the daemon's per-socket state moves into a `DaemonLink` (one per `host.json` entry); channels, ops and uploads stay shared. Output fans out to the links that joined a channel; replies go back by recorded command id. Lifecycle (interest, stops, resume, startup settings) and shared requests (dialogs, web tool callbacks, notifier) move into daemon-side modules. The hub speaks link v7 to new daemons and keeps today's code path for v4–v6.

**Tech Stack:** TypeScript; daemon modules run on Node through `jiti` (no `@/` imports, no Bun APIs); server on Bun; tests `bun test --parallel`.

**Spec:** `docs/specs/2026-11-06-multi-server-host-design.md` (M1–M10).

## Global Constraints

- `LINK_PROTOCOL_VERSION = 7`, `MIN_LINK_PROTOCOL_VERSION = 4` (literal one-line exports: the deploy script `sed`s them).
- Daemon-loaded files (`lib/hosts/daemon*.ts`, `link-protocol.ts`, `local-host.ts`, `session-ops.ts`, every new `lib/hosts/*` module the daemon imports, and their `lib/` imports): relative imports only, no `Bun` global.
- Abandoned stop: 2 min (`OMP_WEB_DISCONNECT_DESTROY_MS`, `0` disables). Idle stop: 10 min. Link interest grace after a drop: 2 min (`DISCONNECT_GRACE_MS`). Kill escalates to force after 5 s.
- Per-link, per-channel output buffer cap: 32 MB (today's channel cap), overflow → `resync {ch}` on that link only.
- Redial backoff ceiling: 30 s; 3 s only for the primary loopback link.
- Daemon command ids: prefix `d:`. Link ids: `l1`, `l2`, … never reused within a daemon run.
- `host.json` and `host-running.json`: mode 0600, temp file + rename.
- Refusal code for a second process on one session: 409 `session_running_elsewhere`.
- Existing behavioural suites must pass; update fixtures only for deliberate v7 contracts, never weaken assertions to accommodate regressions. Run tests with `--parallel`.
- No production service, daemon or DNS changes during implementation. The first v6 → v7 daemon upgrade requires a quiescent host: the old daemon has not written `host-running.json`, so do not promise automatic recovery from a manifest that does not exist.
- An already-dispatched web callback is never reassigned after a link loss: its action might already have happened. Keep it pending for its original link to reconnect; only an undispatched callback may select another executor.

## Review Focus

1. Two servers send commands to one channel within the same 16 ms flush → omp gets both in arrival order, each reply reaches only its sender, and neither server sees the other's reply as its own. (Task 4)
2. Two web servers start at once and both rewrite `host.json` → neither entry is lost. (Task 2: read-modify-write under an exclusive lock file.)
3. A v6 server and a v7 server ask for the same session → exactly one omp process; the second gets 409 `session_running_elsewhere`. (Task 4)
4. A link resyncs or joins while a dialog is open and a message is streaming → it gets the dialog (pending) and the whole message before the next delta, and answering the dialog there closes it on the other link. (Tasks 5, 8)
5. The daemon restarts while a run is in flight and both servers relink → the session resumes once, with one resume prompt, and both UIs show the resumed run. (Task 7)

---
## File ownership and dependencies

- `daemon-link.ts` owns one connection's delivery state; `daemon.ts` coordinates the links, shared ops and process table. Preserve the existing transport, upload and update-safety contracts.
- `daemon-channels.ts` owns the shared channel table, membership and command correlation. `stream-snapshot.ts`, `channel-lifecycle.ts`, `host-resume.ts` and `shared-requests.ts` own the separately tested state transitions named below; do not introduce service interfaces or factories around them.
- `host-login.ts` owns configuration mutation. `hub.ts` and `rpc-manager.ts` adapt the server to host-owned lifecycle; `host.ts` and `rpc-transport.ts` carry that capability without class identity checks.
- Tasks 1–2 establish the wire/configuration contracts; 3–8 build the daemon; 9 connects the server; 10 proves the complete system; 11 documents it. Task 12 is a separate operational cutover after release and user approval.
- Preserve the current linked worktree and the approved spec branch. Before implementation, fetch the latest `upstream/main`, inspect intervening changes and update the task branch without editing the primary checkout.

### Clarifications included in this plan review

See the spec's final section: correlate using existing RPC ids; never repeat an ambiguously completed web callback; preserve preparation/background-work protection in the host timers; schedule the first v6 → v7 restart only on a quiescent host. No operational change is authorized by this planning commit.


### Task 1: Link protocol v7 messages

**Files:**
- Modify: `lib/hosts/link-protocol.ts` (version constants, `HelloMessage`, `DownMessage`, `UpMessage`, `HOST_OP_NAMES`, encoders/decoders)
- Test: `lib/hosts/link-protocol.test.mjs`

**Interfaces:**
- Produces:
  - hello (daemon → hub) gains optional `link?: { id: string; notifier: boolean }`.
  - Export `OpenChannelRequest = { sessionId: string | null; launch: SpawnRequest }` and `OpenChannelResult = { ch: string; joined: boolean; pending: string[] | null; streaming: string | null; cwd: string; fellBack: boolean; launchAdvisor: boolean; autoApproveExtension: boolean }`. Reuse `SpawnRequest` from `lib/hosts/host.ts`: `sessionFile: string`, optional `toolNames?: string[]` and `spawnModel?: string`, not new nullable variants. `streaming` is one whole `message_update` line or null. Add `"open"` and `"close"` to `HOST_OP_NAMES`; `close` args are `{ ch: string }`, result `{}`.
  - Down (hub → daemon), sequenced: `{ type: "interest"; ch: string; on: boolean; preparing: boolean }`, `{ type: "host_tools"; ch: string; tools: unknown[]; schemes: string[] }`. `on` and `preparing` carry a full per-link channel state; keep local counters for concurrent preparation so one completion cannot clear another lease.
  - Up (daemon → hub), sequenced: `{ type: "notifier"; on: boolean }`, `{ type: "sessions_changed" }`.

- [ ] **Step 1:** Add codec tests using the new message shapes as fixtures: `assert.deepEqual(decodeDown(encodeLine(interest)), interest)` and the equivalent up-message cases. `decodeDown` must reject `on: "true"` for `interest`; missing required fields and malformed `hello.link` must fail. Preserve existing unknown-message/sequence handling, without pretending the new decoder is an old v6 implementation.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/link-protocol.test.mjs`; expect the new tests to fail.
- [ ] **Step 3:** Implement the types, codecs and constants.
- [ ] **Step 4:** Run the same command; expect PASS.
- [ ] **Step 5:** Commit `feat(hosts): link protocol v7 messages for several servers`.

### Task 2: `host.json` holds several links

**Files:**
- Modify: `lib/hosts/host-login.ts`, `lib/hosts/local-bootstrap.ts`, `lib/hosts/host-cli.ts`, `instrumentation.node.ts` (await asynchronous bootstrap)
- Test: `lib/hosts/host-login.test.mjs` (create), `lib/hosts/local-bootstrap.test.mjs`

**Interfaces:**
- Produces in `host-login.ts`:
  - `type HostLink = { url: string; token: string }`
  - `readHostLinks(): HostLink[]` — `links` if present, else `[{url, token}]` from the top level, else `[]`; URLs trimmed of trailing `/`.
  - `addHostLink(link: HostLink): Promise<void>` — upserts by URL; writes the top-level pair only when the file has none.
  - `removeHostLink(url: string): Promise<void>` — removes the entry; never removes the top-level pair (a v6 daemon's link). An explicit empty `links` array stays empty: only an absent array falls back to the top-level pair.
  - Configuration writers use one read-modify-write lock (`host.json.lock`, created with `wx`, asynchronous retry every 50 ms up to 5 s, removed in `finally`). Store the owner pid, recover a lock only after proving its owner exited, and leave unreadable configuration untouched. Never busy-wait or block the Node event loop.
  - `loginHost` retains replacement semantics; migrate its callers to the same asynchronous, locked writer so it cannot overwrite a concurrent add.
- `ensureLocalHostLink` becomes asynchronous and calls `addHostLink` for its own URL instead of `loginHost`; preserve token validation and the protection against overwriting a remote primary. Update every caller to await it.
- `ompweb host login --add --url <url>` adds a link, still reading its token from stdin. Add `ompweb host logout --url <url>` to call `removeHostLink`; no token on argv.

- [ ] **Step 1:** Tests: legacy file → one link; two concurrent writer child processes → both entries retained with the primary unchanged; explicit empty list → no links; remove a secondary → primary preserved; unknown keys preserved; malformed config → failure without replacement; dead-owner lock → recover; live-owner lock → bounded timeout. Extend bootstrap tests to assert staging never overwrites production's primary.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/host-login.test.mjs lib/hosts/local-bootstrap.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(hosts): host.json lists several servers`.

### Task 3: One `DaemonLink` per server (behaviour-preserving refactor)

**Files:**
- Create: `lib/hosts/daemon-link.ts`
- Modify: `lib/hosts/daemon.ts`, `lib/hosts/host-cli.ts`
- Test: `lib/hosts/daemon.test.mjs` (existing suite, unchanged), plus `lib/hosts/daemon-links.test.mjs` (create)

**Interfaces:**
- Produces `class DaemonLink` in `daemon-link.ts`: constructor `(login: HostLink, id: string, deps: LinkDeps)`; methods `start(): void`, `stop(): Promise<void>`, `isUp(): boolean`, and `queue(...)` preserving the current daemon queue's typed `Unsequenced<UpMessage>` arguments and `number | null` result. Preserve the existing byte counters, send pacing, stats and binary-result ordering rather than recreating them differently.
- `LinkDeps` owns the cross-boundary callbacks: `hello(link: DaemonLink, replay: boolean): string`, `handleDown(link: DaemonLink, message: DownMessage | UnknownMessage): void`, `onEnd(link: DaemonLink, reason: "revoked" | "replaced" | "version"): void`, `log(message: string): void`. Per-link configuration carries `allowHttp` and `primary`; enforce the existing HTTPS/loopback trust boundary.
- Change `runHostDaemon` and `host-cli.ts` together to read `readHostLinks()` instead of receiving one URL/token. Keep `Map<string, DaemonLink>` keyed by URL; reconcile on a debounced directory watch (200 ms) and link failures. Invalid reloads leave running links intact. Include `id`, `notifier` and current channel listings in each hello. For an older server's version refusal, negotiate a mutually supported version before classifying the link as incompatible; a v7 hello sent unchanged to a v6 server is rejected today. Revocation, replacement, stats, request results and binary frames belong to their source link. Track upload progress by link, upload id and attempt so another link's retry cannot receive the wrong acknowledgement.

- [ ] **Step 1:** New tests: two fake hubs receive distinct link ids; adding/removing one entry changes only that socket; malformed reload preserves both; 4409/401 on one does not stop the other or its child; a version refusal negotiates v6 where supported. Retain update-busy protection across all shared children/spawns and upload tests proving acks/results stay with their initiating link.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/daemon.test.mjs lib/hosts/daemon-links.test.mjs`; expect the new file to fail, the old to pass.
- [ ] **Step 3:** Move the state and the socket functions (`connect`, `keepLinked`, `flush`, `nextUnit`, `acked`, `scheduleFlush`, `sendStats`, `unauthorized`, `followLogin`) into `DaemonLink`; keep ops and channels in `daemon.ts`.
- [ ] **Step 4:** Rerun; expect both PASS.
- [ ] **Step 5:** Commit `refactor(hosts): one DaemonLink per server in host.json`.

### Task 4: Shared channels, joining and reply routing

**Files:**
- Create: `lib/hosts/daemon-channels.ts`
- Modify: `lib/hosts/daemon.ts`
- Test: `lib/hosts/daemon-channels.test.mjs` (create)

**Interfaces:**
- Consumes: `DaemonLink.queue` (Task 3), the `open`/`close` ops (Task 1).
- Produces `class ChannelTable`:
  - `open(link: DaemonLink, args: OpenChannelRequest): Promise<OpenChannelResult>` — matches the canonical session identity, including aliases from legal session moves. Concurrent opens share one spawn. Legacy-owned sessions are refused with `new HostOpError(409, "session_running_elsewhere", "...")`.
  - `spawnLegacy(link: DaemonLink, args: SpawnRequest & { ch: string }): Promise<Omit<OpenChannelResult, "ch" | "joined" | "pending" | "streaming">>` — preserves the old wire response and caller-supplied channel id; any already-running canonical session is reused only where the old protocol permits it, otherwise refused, never duplicated.
  - `close(link: DaemonLink, ch: string): void`, `stdin(link: DaemonLink, ch: string, line: string): void`, `kill(link: DaemonLink, ch: string, force: boolean): void`. Check membership before stdin, interest, tools, close or kill; a guessed channel id is not permission.
  - `members(ch: string): DaemonLink[]`; hello channel listing includes v7 channels for v7 links and only owned legacy channels for legacy links.
- Decode logical stdout frames through the existing `RpcFrameDecoder`, retaining the physical `rpc_chunk` lines until routing is known. A chunked response must be sent only to its request's link, never fanned out before its id is decoded. Reuse this one decoded-frame path for snapshots, lifecycle and pending requests; regexes over physical lines cannot identify base64-encoded events.
- Record command ids before writing stdin. Route responses to their recorded link, consume `d:` responses internally, and broadcast session events. Prevent duplicate outstanding ids from overwriting another link's mapping. Retire stale correlation state when a request/channel closes; dropped-link replies must not be broadcast to the remaining links.
- Publish the `open` result before releasing that member's later output; buffer only the join interval. Preserve sequence order under per-link overflow: do not remove already-numbered outbox records and create an unfillable sequence gap.

- [ ] **Step 1:** Tests: two commands in the same flush retain stdin arrival order and reply ownership; a >1 MiB chunked `get_state` response reaches only A; `d:` replies reach nobody; join sees pending requests and only subsequent deltas; concurrent/aliased opens spawn once; both legacy/v7 collision directions get 409; unknown channel writes fail; overflowing B resyncs only B without sequence gaps.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/daemon-channels.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement; `daemon.ts` routes `spawn`, `open`, `close`, `stdin`, `kill` through the table.
- [ ] **Step 4:** Rerun plus `lib/hosts/daemon.test.mjs`; expect PASS.
- [ ] **Step 5:** Commit `feat(hosts): channels shared by every linked server`.

### Task 5: The streaming message on join and resync

**Files:**
- Create: `lib/hosts/stream-snapshot.ts`
- Modify: `lib/hosts/daemon-channels.ts`
- Test: `lib/hosts/stream-snapshot.test.mjs` (create)

**Interfaces:**
- Produces `class StreamSnapshot`: `note(frame: RpcFrameRecord): void`, `whole(): string | null`, `clear(): void`. Consume decoded logical frames from Task 4, not a second raw-line decoder; use `applyMessageDelta` and `withStreamedArguments` from `lib/message-delta.ts`.
- `open` puts `whole()` in `OpenChannelResult.streaming`. Resync supplies a new snapshot with an ordered boundary so deltas already represented by the snapshot are not appended twice.

- [ ] **Step 1:** Tests: start plus text/tool deltas produce exact rebuilt content; chunked starts/updates use the same path; message end/terminal agent end/exit clear state; an unplaceable delta never produces guessed content; join and overflow during streaming produce neither duplicate nor missing text.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/stream-snapshot.test.mjs lib/hosts/daemon-channels.test.mjs`; expect the new cases to fail.
- [ ] **Step 3:** Implement `StreamSnapshot` and the ordered join/resync handoff.
- [ ] **Step 4:** Rerun the same command; expect PASS.
- [ ] **Step 5:** Commit `feat(hosts): the daemon replays the streaming message to a joining server`.

### Task 6: Lifecycle and startup settings in the daemon

**Files:**
- Create: `lib/hosts/channel-lifecycle.ts`
- Modify: `lib/hosts/daemon-channels.ts`, `lib/hosts/daemon.ts`
- Test: `lib/hosts/channel-lifecycle.test.mjs` (create)

**Interfaces:**
- Produces `class ChannelLifecycle` per v7 channel with `noteStdout(frame: RpcFrameRecord): void`, `noteStdin(frame: RpcFrameRecord): void`, `setInterest(linkId: string, on: boolean): void`, `linkDown(linkId: string): void`, `linkGone(linkId: string): void`, and `dispose(): void`. Inject time/timers through one constructor parameter for deterministic boundary tests; its stop callback receives `"abandoned" | "idle"`.
- Consume Task 4's decoded frames. Track agent execution, native settlement/background work, unanswered requests and command preparation separately: no timer may kill an unsettled run or a blocking dialog. Preserve pending upload-attachment preparation via a host activity lease reported before attachment starts, not just after prompt stdin. Both timers require no run/background work, startup or protected work. Disconnect grace starts at link loss; abandoning starts when the final interest actually expires.
- After spawn, await bounded `negotiate_protocol` before relying on chunk decoding or startup settings. Then send delta filtering, subagent events and ask-dialog mode once with `d:` ids. Retain full-update fallback when omp rejects or emits incompatible deltas; servers must not independently change the child's filter.
- Legacy channels get no lifecycle object (their server keeps its timers).

- [ ] **Step 1:** Boundary tests with an injected clock: abandonment at 2 min but not one tick before; B's interest protects against A disconnect; reconnect replaces the old grace timer; active run, background settlement, blocking dialog, startup and attachment preparation each prevent both stops; the idle backstop fires at 10 min only after protected work ends; env `0` disables abandonment only. Negotiation precedes settings, daemon replies stay private and older omp full updates remain usable.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/channel-lifecycle.test.mjs lib/hosts/daemon-channels.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement the transitions and host activity lease, with cleanup on all release/error/exit paths.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(hosts): the daemon decides when an omp process stops`.

### Task 7: Resume after a daemon restart

**Files:**
- Create: `lib/hosts/host-resume.ts`
- Modify: `lib/hosts/daemon.ts`, `lib/hosts/channel-lifecycle.ts` (run start/settle callbacks)
- Test: `lib/hosts/host-resume.test.mjs` (create)

**Interfaces:**
- Consumes: `loadWebServerSettings().autoResumeSessions` from `lib/web-settings.ts` through a Node-safe import graph. Move `RESUME_PROMPT` to the Node-safe resume module and update its existing importers.
- Export `type HostResumeEntry = { sessionId: string; launch: SpawnRequest }`. `HostResumeTracker` has `recordRunning(entries: HostResumeEntry[]): void`, `freeze(): void`, `takeRunning(): HostResumeEntry[]`, `dispose(): void`; use an instance, not a module-global tracker that can mix test hosts. Write the first run transition immediately, coalesce subsequent changes to at most once per second, and flush on orderly shutdown before freezing.
- On startup claim the file atomically, validate ids and launch paths against the owning host's session root, and spawn each entry once through the same spawn fence used by `open`. Await startup settings before sending `RESUME_PROMPT` with a daemon-owned id. Malformed manifests must never spawn arbitrary paths or be silently overwritten.
- Initial v6 → v7 migration: require no active/unsettled sessions before restarting the old daemon; it cannot produce the new manifest. Subsequent v7 restarts use the tested manifest path. Keep live timing/notifications as an explicit deployment gate.

- [ ] **Step 1:** Tests: run start/settle update the manifest; orderly freeze flushes pending writes and survives child exits; malformed/outside-root entries do not spawn; one claim yields one resume prompt even when two links open the session concurrently; settings-off discards stale recovery rather than replaying it later.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/host-resume.test.mjs lib/hosts/daemon-channels.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement recovery and the initial-upgrade precondition.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(hosts): the daemon resumes interrupted sessions once`.

### Task 8: Dialogs, web tool callbacks, notifier, session-list changes

**Files:**
- Create: `lib/hosts/shared-requests.ts`
- Modify: `lib/hosts/daemon-channels.ts`, `lib/hosts/daemon.ts`
- Test: `lib/hosts/shared-requests.test.mjs` (create)

**Interfaces:**
- Produces `class SharedRequests` per v7 channel:
  - Dialogs: blocking `extension_ui_request` goes to every member (unchanged fan-out). `answer(linkId, line)`: the first `extension_ui_response` for an id goes to stdin; later ones are dropped; every other member gets `{"type":"extension_ui_request","method":"cancel","targetId":<id>}`.
  - Web tool callbacks: `setTools(linkId: string, tools: unknown[], schemes: string[]): void`; validate definitions with the same schema as existing tool registration. Merge registrations by name, update omp only on actual union changes, and remove registrations when a link leaves. Use the last prompt/steer/follow-up sender if eligible, otherwise the earliest-linked eligible server. Hold undispatched calls until an executor exists. Once dispatched, retain its executor across reconnects; do not re-execute it elsewhere after an ambiguous link loss. Native `tool_execution_*` events/results still fan out to every member, regardless of callback executor.
- Notifier: the daemon keeps `notifierId` = earliest-linked up v7 link; hello carries `link.notifier`; changes send sequenced `notifier {on}`.
- `sessions_changed` is queued to every link after the `invalidateSessionLists` op and after any op of `session-ops.ts` that changes session files (rename, title, delete, archive).

- [ ] **Step 1:** Tests: dialog answer from B reaches stdin once and closes A's dialog; an answer after native cancellation is ignored; last prompter receives a callback once; loss after dispatch does not execute it on A; no registrant holds it until registration; both links receive the single committed tool result; malformed registrations fail; union removal works; notifier handoff selects one publisher; rename invalidates both lists. Calls already executing on a server are not cancelled and retried merely because its socket drops.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/shared-requests.test.mjs lib/hosts/daemon-channels.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement shared request state and the notifier/list messages.
- [ ] **Step 4:** Rerun; expect PASS.
- [ ] **Step 5:** Commit `feat(hosts): dialogs, tool callbacks and notifications across servers`.

### Task 9: The web server speaks v7

**Files:**
- Modify: `lib/hosts/hub.ts`, `lib/hosts/host.ts`, `lib/omp/rpc-transport.ts`, `lib/rpc-manager.ts`, `lib/notification-hub.ts`, `lib/hosts/session-index.ts`, `lib/session-resume.ts`, `instrumentation.node.ts`, and `lib/agent-command.ts` for preparation leases.
- Test: `lib/hosts/hub.test.mjs`, `lib/rpc-manager.test.mjs`; locate the additional existing adoption/reaper suites before editing and run that set.

**Interfaces:**
- Consumes: Task 1 messages; the daemon behaviour of Tasks 4–8.
- Produces:
  - Extend `SpawnResult` and the transport capability with host-owned-lifecycle metadata, joined-channel pending requests and streaming snapshot. `RemoteHost.spawnRpc` uses `open` for v7, obtains the daemon's channel id before registering the transport, and holds/replays subsequent frames without a result/output race. Keep the old preallocated-channel path for legacy hosts.
  - Add optional `RpcTransport` methods `setInterest(on: boolean): void`, `setHostTools(tools: unknown[], schemes: string[]): Promise<void>`, `close(): void` and `setPreparing(on: boolean): void`; a capability flag distinguishes v7. Use optional capabilities, never `instanceof RemoteRpcTransport`. Local wrapper cleanup uses `close`; only explicit restart/delete/stop requests may kill the shared process.
  - Disable all server-owned idle/disconnect/startup-filter logic on the v7 path, including adoption, restart and delta-recovery fallback. Report interest when tab listeners or pending commands change and preparation before uploads/other fenced work. Reuse daemon snapshots on resync instead of switching a shared process to full updates.
  - For v7 hello entries, join/adopt wrappers so background runs still feed sidebar state and the designated notification detector with no tabs open. Failure to reconcile or wrapper disposal closes only this link's membership; it must never call `killOrphan` or kill a process another server is using.
  - Export `isNotifier(hostId: string): boolean` from `hub.ts` (true for legacy hosts) and gate automatic notification publication at `AgentSessionWrapper.publishNotifications`, where host identity is available. Do not gate user-requested test notifications or infer a host id from a `NotificationEvent` that does not carry one.
  - Handle `sessions_changed` in `hub.ts` by dropping that host's list cache and issuing the existing list-change notification. Filter only v7 hosts out of web-server resume manifests; preserve legacy-host recovery.

- [ ] **Step 1:** Tests: new/joined/adopted/restarted v7 wrappers send no child-global startup commands; no last-tab detach or reconciliation failure kills the shared child; stream resync uses daemon snapshot; preparation protects slow attachment work; background sessions are observed without tabs; only the notifier publishes automatic events; legacy path retains existing behaviour.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/hub.test.mjs lib/rpc-manager.test.mjs` plus the located adoption/reaper suites; expect the new cases to fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`; expect PASS. Run `npm run typecheck && npm run lint`; expect clean.
- [ ] **Step 5:** Commit `feat(hosts): web servers share a v7 daemon`.

### Task 10: Two servers, one daemon, end to end

**Files:**
- Modify: `lib/hosts/link-integration.test.mjs` (new cases), `scripts/smoke.ts` (`--second-server` starts a second built server on the same throwaway HOME)
- Test: same

- [ ] **Step 1:** Extend the existing fake-omp integration harness with two independent server processes and separate ports on one throwaway HOME. Assert prompt A → user message on B; queue/abort B → same state on A; dialog B → closes A; long/chunked tool output identical on both; A restart preserves child pid and B's stream; mid-message B join has exact text; only final interest release permits reap. Use a fake v6 peer speaking the old wire contract, not nonexistent old-server fixtures.
- [ ] **Step 2:** Run `bun test --parallel lib/hosts/link-integration.test.mjs`; expect PASS (the behaviour exists after Task 9; failures here are bugs to fix in the owning task's files).
- [ ] **Step 3:** `npm run build && npm run smoke -- --second-server`; expect both servers to list the session the daemon serves.
- [ ] **Step 4:** Commit `test(hosts): two servers on one daemon end to end`.

### Task 11: Documentation

**Files:**
- Modify: `AGENTS.md` ("Remote hosts", "Local daemon", "RPC session lifecycle", "Auto-resume after a restart", "Link protocol versions"), `CHANGELOG.md`, `docs/specs/2026-10-28-remote-hosts-design.md` (version list).

- [ ] **Step 1:** Describe: one daemon, several links from `host.json`; the daemon owns stops and resume for v7; reply routing by command id; notifier; v6 isolation and the 409; `ompweb host login --add`.
- [ ] **Step 2:** Commit `docs(hosts): several servers on one daemon`.

**Whole-branch gate before publication or deployment:** run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run smoke -- --second-server` on the integrated head. Exercise both rendered browser views against the throwaway two-server setup: send from each view, observe matching messages/tool results, answer one dialog and verify both close, reconnect one view without disturbing the other. Then request one condensed `reviewer` round covering contract, hostile correctness, test honesty and unnecessary complexity. Resolve findings, run affected proof once more, publish the implementation PR and register pr-watcher. CI/bot reviews follow repository policy. No production cutover occurs until the release is verified and the user approves its timing.


### Task 12: Enable a second web server after the verified release

**Files:** no additional product files; deployment-specific automation belongs
to the deployment environment, not this repository.

- [ ] **Step 1:** Verify the installed daemon and both web servers support shared-host v7. Upgrade the first legacy daemon only in an agreed quiescent window.
- [ ] **Step 2:** Register the additional server through bootstrap or `ompweb host login --add --url <url>` (token from stdin), keeping the primary connected. Remove it with `ompweb host logout --url <url>`, without restarting the primary or daemon.
- [ ] **Step 3:** In the deployment environment, confirm both views drive one session, then stop/rejoin one server while the other remains usable. Keep environment-specific scripts and service policy outside this upstream repository.
