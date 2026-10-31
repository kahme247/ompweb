# Remote hosts: run omp sessions on other machines from one omp-web

## Goal

One omp-web drives omp sessions on several machines. Examples: work that must
run on a MacBook (its hardware, its files), or load spread over machines
without agents using SSH between them. An agent in one session can also start a
session on another machine.

Each machine keeps its own omp install, agent directory (`~/.omp/agent`),
sessions and credentials. Nothing is shared between machines; omp-web only
routes.

## Delivery

Full parity on remote hosts is the target. It ships in three sub-projects, each
with its own spec, plan and PR, merged to `main` when ready:

1. **Sessions (this spec, the MVP).** Daemon, link, host registry, routing,
   session list and history, live chat, notifications, starting sessions.
2. **Files, git and worktrees** on remote hosts.
3. **Config surfaces:** skills, plugins, MCP, `models.yml`, auth/login, usage,
   `omp update`, STT gateway.

The `Host` interface and the host-op channel defined here serve all three:
sub-projects 2 and 3 add ops, not new message shapes. Until a sub-project
lands, the UI labels the features it covers as unavailable on remote hosts
("Not available on remote hosts yet") instead of hiding remote hosts behind a
flag.

## Non-goals

- Correlating the same repository across hosts (merged "group by project"
  sidebar mode); planned for a later version, see Sidebar.
- Moving or syncing sessions between hosts.
- A higher-level session API on the daemon. omp's RPC is the protocol; the
  daemon passes it through unchanged.
- Changes to omp. omp has no remote mode (`omp --help`: `rpc`/`rpc-ui`/`acp`
  over stdio only), and none is needed.

## Architecture

```
Browser ─▶ main omp-web ──┬─ LocalHost ── spawn omp --mode rpc-ui (stdio)
                          │
                          └─ RemoteHost ◀── link (HTTP) ── ompweb host (daemon)
                                                            └─ spawn omp --mode rpc-ui
```

### Daemon: `ompweb host`

A subcommand of the existing `@kahme247/ompweb` package (`bin/omp-web.js`), so
it runs omp-web's own `lib/` server code on the remote machine.

- `ompweb host login --url <url>` reads the host token from stdin and saves
  `<agent dir>/omp-web/host.json` (mode 0600). The token is never an argv
  value, which `ps` would expose.
- `ompweb host` dials the saved URL and keeps the link up, reconnecting with
  exponential backoff (1 s doubling to 60 s, with jitter).
- `https://` is required. `http://` is accepted only for loopback addresses or
  with `--allow-http` (for example on a tailnet).
- It spawns `omp --mode rpc-ui` children on request and forwards their NDJSON
  both ways unchanged, tagged with a channel id.
- It answers host ops (below) by calling the existing `lib/` functions.
  There is no generic exec or file-read op. It loads that code with `jiti`,
  already a runtime dependency used by `bin/` to load `lib/*.ts`.
- omp children outlive a dropped link; their output is buffered (see Link).
- Auto-resume stays with the main omp-web, which already knows which sessions
  are mid-run. Its interrupted-session list records each session's `hostId`;
  remote entries are resumed once their host links again (see Rules →
  Reattach).

### Host hub (main omp-web)

`lib/hosts/hub.ts` accepts daemon links on `/api/hosts/link` and keeps a
`globalThis` registry `hostId → link`, the same pattern as `lib/rpc-manager.ts`
(survives hot reload).

### `Host` interface

`lib/hosts/host.ts` defines the one seam between omp-web and a machine:

- `spawnRpc(request) → { transport, cwd, fellBack, launchAdvisor }`: the host
  computes the spawn cwd fallback, project launch config, environment
  overrides and arguments on its own machine; `transport` is what `RpcProcess`
  writes to and reads from.
- `sessionFileExists(path)`, `invalidateSessionLists(path?)` and
  `autoApproveExtension()`: the remaining machine-local reads
  `AgentSessionWrapper` does today.
- `sessionOps`: the session-file operations (see Host ops).
- `status`: `online | offline | needs-upgrade | omp-missing`.

Two implementations:

- `LocalHost` (`id: "local"`, label "This machine"): today's behavior,
  `child_process.spawn` and direct `fs`.
- `RemoteHost`: the same calls over the link.

`RpcProcess` (`lib/omp/rpc-process.ts`) takes its transport from the host
instead of spawning itself. `AgentSessionWrapper`, the event-stream hub,
notifications, the queue and `/btw` are unchanged: they see frames, wherever
the process runs.

### Host registry

`<agent dir>/omp-web/hosts.json`, mode 0600, written atomically (temp file +
rename, like `lib/project-registry.ts`). Each record: `id`, `label`,
`tokenHash` (`sha256` hex), `createdAt`, `lastSeenAt`,
`allowAgentStart` (bool, default `false`). The built-in `local` host is not
stored.

Settings → Hosts lists hosts with status, omp version and last seen; adds a
host (shows the token once, with the `ompweb host login` command to run);
renames; revokes; toggles `allowAgentStart`.

### Routing

Every `SessionInfo` carries `hostId`. API routes resolve `id → host` once
(`resolveSessionHostOr404`, replacing `resolveSessionPathOr404`) and call that
host's `sessionOps` with the session id; the host resolves the file path
itself, so main never sends a remote path. A session whose host is unknown
(revoked) is not listed. Session ids are UUIDs, but a sessions directory
copied between machines repeats them: an id present on several hosts is
listed once, under "This machine" if it is local, else under the first host
by label.

## Link protocol

omp-web runs under `next start` with no custom server (`bin/omp-web.js`), and
Next route handlers cannot accept WebSocket upgrades. The link therefore uses
two HTTP legs and a hello, all opened by the daemon (which also works behind NAT):

- **Hello** `POST /api/hosts/link` with the `x-omp-web-hello: 1` header: the
  daemon's `hello` in the body; main answers `{helloId}`.
- **Downlink** `GET /api/hosts/link` naming that `helloId` in the
  `x-omp-web-hello` header: a long-lived NDJSON response, main → daemon.
- **Uplink** `POST /api/hosts/link`: batched NDJSON, daemon → main, flushed
  every 16 ms or at 256 KB.
- All three carry `Authorization: Bearer <host token>`, and the route verifies
  it before reading any body: 401 when no host record matches, 503 when the
  host registry cannot be read (a daemon that sees 401 stops its omp
  children; it retries any 5xx). `proxy.ts` does not run for
  `/api/hosts/link` and its subpaths (its matcher excludes exactly those):
  Next buffers a proxied request body and silently truncates it past 10 MB,
  below the link's upload limits.

### Messages

One JSON object per line. Every message except `hello`, `welcome`, `ping` and
`pong` carries a per-direction sequence number `seq`, and every uplink POST and
`hello` carries `ack` (the highest downlink `seq` the daemon applied); every
POST response carries `ack` (the highest uplink `seq` main applied). Each side
keeps unacknowledged messages, resends them after a reconnect, and drops any
`seq` it already applied, so no line is lost or applied twice when a leg
breaks mid-write. stdin lines omp has not received would otherwise vanish.

`hello` goes in the body of its own POST, never in a header: it lists every
live channel, and a reverse proxy's header buffers (nginx: 8 KB by default)
would cut it to a few dozen channels, then 431 every redial while the children
run on. Main keeps one hello per host and answers its random `helloId`; the
downlink GET names it, and main takes the hello at that GET, so it opens one
downlink once (a replayed or late GET, or one after `offlineMs`, gets 400 and
the daemon posts a new hello). The version is checked on the hello POST; the
replacement of an older link and the new `nonce` happen when the GET opens the
downlink. An uplink POST carries its `ack` in the `x-omp-web-ack` header. Main
decodes a whole POST before applying any of it.
A `hello` with `ack: 0` comes from a daemon that has applied no downlink
message, so it has sent no sequenced uplink message either (each one answers
a downlink message): main restarts its uplink window for that host. Main
numbers downlink messages above the daemon's `ack`, so a restarted main and
a running daemon never reuse a `seq`.

Each `welcome` carries a fresh random `nonce` naming that link. Every uplink
POST and blob upload sends it in the `x-omp-web-link` header, and main answers
409, before reading the body (and again if the link changed while the body
arrived), when it is not the current link's. Without it a replaced daemon's
late POST would land in the uplink window a newer daemon's `hello` just
restarted, and main would drop that daemon's first messages as duplicates.
On 409 the daemon keeps the messages and sends them after the next
`welcome`.

| Message | Direction | Purpose |
|---|---|---|
| `hello {v, ompVersion, platform, home, ack, channels[{ch, sessionId}]}` | up | Handshake; `channels` lists live omp children from before a reconnect. `ompVersion` is `null` when `omp` is not found. |
| `welcome {v, hostId, nonce}` | down | Accepted; `nonce` names this link. |
| `stdin {ch, line}` | down | One raw omp NDJSON line. |
| `stdout {ch, line}` | up | One raw omp NDJSON line. |
| `stderr {ch, chunk}` | up | Child stderr, for the existing logging. |
| `kill {ch, force}` | down | Stop a child: `force: false` terminates its process tree, `true` kills it. |
| `exit {ch, code, signal}` | up | Child exited. |
| `resync {ch}` | up | Buffered output for `ch` was dropped. |
| `req {id, op, args}` | down | Host op request. |
| `res {id, ok, result \| error}` | up | Host op result. |
| `replaced` | down | A newer link with this token took over; the daemon exits. |
| `ping` / `pong` | both | Liveness, every 15 s. |

### Rules

- **Version.** `v` is an integer bumped on any incompatible change (2: the
  hello moved from the GET header into a POST body). On a mismatch the link
  request gets 426 with both versions, and so does a v1 daemon's GET carrying
  its hello in the header; the daemon exits with "upgrade omp-web on this
  host"; Settings → Hosts shows "needs upgrade (host vN, server vM)". A hello
  POST answered 400, 404, 405 or 409 without a `helloId` comes from an older
  main (v1 answers a POST without a link nonce 409): the daemon logs "the
  server runs an older ompweb: upgrade it" and exits 1 instead of redialing.
- **Identity.** The host is the record whose `tokenHash` matches. Nothing the
  daemon sends selects or changes its identity.
- **One link per host.** A new link with the same token replaces the old one,
  which receives `replaced`. Two daemons must never run competing
  `omp --resume` children against one agent directory.
- **Buffering.** While the uplink is down, the daemon buffers each child's
  output up to 8 MB per channel. On overflow it drops that channel's buffer
  and queues `resync {ch}`, which reaches main with the first uplink POST that
  gets through, ahead of the channel's later output; main then runs the
  existing `get_state` reconcile for that session. On main, output that
  arrives before the session reads its channel is held for it up to the same
  8 MB; past that main kills the child (`kill {force: true}`) rather than hold
  more, and what was held is still delivered.
- **Reattach.** On `hello`, main reattaches every listed `ch` to its
  `AgentSessionWrapper` and kills (`kill`) listed channels it has no wrapper
  for (orphans of a main restart). A wrapper whose channel is missing from
  `hello` gets a synthesized `process_exit`. A wrapper whose host link is down
  is in a "transport down" state, never "process exited"; its idle
  (`IDLE_DESTROY_MS`) and disconnect (`DISCONNECT_DESTROY_MS`) timers pause
  until the link returns. With `autoResumeSessions` on, a session that was
  mid-run when its channel went missing or was killed as an orphan is
  restarted on that host (after the orphan's `exit`) and sent `RESUME_PROMPT`,
  as local sessions are after a restart.
- **Large results.** An op result whose JSON exceeds 1 MB, and every
  successful `readMedia` result, is sent as raw bytes to
  `POST /api/hosts/link/blob/<reqId>` instead of inside NDJSON; the `res` line
  then carries `blob: {bytes}` and no `result`.
- **Limits.** Uplink batches are capped at 16 MB and blob uploads at 64 MB;
  over-limit requests get 413. A single `stdout` line over 8 MB is dropped and
  replaced by `resync {ch}`.

## Host ops (this sub-project)

Every op name is in one allow-list shared by both sides; the daemon rejects
anything else. Session ops take the session id and run the file-reading part
of today's route handlers, moved into `lib/hosts/session-ops.ts`, which
`LocalHost` calls directly and the daemon calls for `RemoteHost`. Live-wrapper
parts of those routes stay on main.

| Op | Moved from |
|---|---|
| `listSessions` | `listAllSessions()` (`lib/session-reader.ts`) |
| `readSession {id, options}` | `GET /api/sessions/[id]` |
| `readContext {id, leafId, options}` | `GET /api/sessions/[id]/context` |
| `readThinking {id, entryId, block}` | `GET /api/sessions/[id]/entries/[entryId]/thinking` |
| `readSessionState {id}` | `GET /api/sessions/[id]/state` |
| `readSubagentHistory {id}` | `GET /api/sessions/[id]/subagents` |
| `readSubagentTranscript {id, subagentId, mode, cursor}` | `GET /api/sessions/[id]/subagents/[subagentId]` |
| `renameSessionFile {id, title}` | `PATCH /api/sessions/[id]` on-disk fallback |
| `deleteSession {id}` | `DELETE /api/sessions/[id]` |
| `archiveSession {id}` | `POST /api/sessions/[id]/archive` |
| `exportSession {id}` | `GET /api/sessions/[id]/export` |
| `readMedia {hash}` | `mediaFilePath()` (`lib/media-cache.ts`) |
| `listProjects` / `addProject {path}` / `updateProject {path, updates}` / `hideProject {path}` | `/api/projects` |
| `validateCwd {path}` | `/api/cwd/validate` |
| `spawn {ch, cwd, sessionFile, toolNames, advisor}` | `startRpcSession` spawn |
| `sessionFileExists {path}` / `invalidateSessionLists {path}` | `AgentSessionWrapper` |

Op timeout: 30 s, then 504 naming the host.

## Data flow

- **Sidebar list.** Main calls `listSessions` on each online host and caches
  each host's list separately (30 s TTL, matching the local list cache). An
  `agent_end`, `session_info_update`, compaction or rename on a host
  invalidates only that host's cache. An offline host keeps its last list.
- **Open a session.** Resolve `id → host`, call `host.sessionOps.readSession`.
- **Send a message.** `startRpcSession()` asks the session's host for a
  transport (`host.spawnRpc`); everything above `RpcProcess` is unchanged.
- **Images.** On a local miss, `/api/media/<hash>` asks each online remote
  host for `readMedia {hash}`, accepts the first answer whose sha256 equals
  the hash, and stores it in the main omp-web's media directory, so later
  requests are local. No host id rides in image URLs.
- **Host status.** A new `hosts` event-stream channel publishes host status
  changes (sidebar dots, Settings → Hosts). Each wrapper on a host also emits
  a `host_status {status}` frame on its `session` channel when the link drops
  or returns, which drives the offline banner.
- **Live events.** Unchanged: the `running`, `session`, `notifications` and
  `host-tools` channels carry wrapper frames regardless of host.

## Sidebar

- **This version:** grouped by host. "This machine" comes first, then each
  remote host in label order. Each group header shows the host label and a
  status dot (online, offline, needs upgrade, omp missing) and collapses.
  Inside a group the sidebar works as today: projects, sessions, sort, pins.
  Project pins and sort order are per host.
- **Offline host:** its group shows the last known list dimmed. Opening its
  sessions and starting new ones there are disabled, with the reason in a
  tooltip.
- **New session:** the new-session screen gets a host picker beside the
  workspace picker; workspaces list from the chosen host.
- **Later version (out of scope):** an optional "group by project" mode that
  merges the same repository across hosts and marks each session with a host
  badge. The `hostId` on every `SessionInfo` is what it needs.

## Security

**Trust model.** The main omp-web can start omp, with full tool access, on
every linked host. Control of the main server or of a host token is a shell on
that machine. That is inherent to the feature and the same exposure the main
machine already has. The rules below limit anything beyond it.

- Host tokens are 32 random bytes (base64url). Only `sha256(token)` is
  stored; the token is shown once. Revoking deletes the record and closes the
  open link immediately.
- The daemon stores its token in a 0600 file, never in argv.
- The daemon requires `https://` except for loopback or `--allow-http`.
- Daemon input to main is untrusted data:
  - Remote paths never reach main's local filesystem. Every path is scoped to
    a `hostId` and resolved only by that host.
  - Blob hashes must match `^[0-9a-f]{64}$`; image bytes pass the existing
    magic-byte check in `/api/media/[hash]`.
  - Size limits from Link → Limits apply.
  - Remote omp output goes through the same sanitizing as local output.
  - A remote host's session export (`/api/sessions/[id]/export`) is always
    served as an attachment, never `inline`: its HTML would otherwise run on
    main's origin.
- `sessionFileExists` and `invalidateSessionLists` accept only paths inside
  the daemon's sessions directory; `spawn` accepts a `sessionFile` only from
  the same directory.
- The sessions MVP has no file-reading op. Its other path arguments
  (`validateCwd`, the project ops, the `spawn` cwd) choose where work starts,
  which is what they do locally too, and the trust model already gives main a
  shell through `spawn`. The daemon-side allowed-roots check (roots computed
  on the daemon's machine from its session cwds and project registry, never
  trusting a path because main sent it) arrives with the file and git ops of
  sub-project 2, which are the ops it protects.

## Agent-initiated sessions

omp-web already answers three agent tools itself (`list_sessions`,
`new_session`, `send_to_session` in `lib/agent-tools.ts`, gated by the
`agentToolsEnabled` web setting). They are extended, not duplicated:

- `new_session` gains an optional `host` (id or label; omitted means the
  calling session's own host, so this machine for a local caller).
- `list_sessions` covers every host and names each session's host.
- `send_to_session` reaches a session on any host.

The calls arrive over a session omp-web already owns, so they need no new
credential and cannot be reached from outside omp-web. Each call carries the
calling session's host (`sourceHostId`).

**Guard:** creating a session on a remote host whose `allowAgentStart` is
`false` (the default) first shows a `confirm` request through the existing
extension-UI flow ("Start a session on <host> in <cwd>?"), which also raises
the existing input-needed notification. Declining returns an error result to
the agent. A local caller keeps today's behavior: it starts and messages
sessions here without asking.

A caller on a remote host is untrusted by this machine: a prompt-injected
agent on a laptop must not drive the main machine. When it targets any other
host, through `new_session` or `send_to_session`, it gets the same confirm
unless the target host allows agent starts; this machine as the target always
asks ("Send a message from a session on <host> to session <id> on
<host>?" for a send). Starting a session on its own host follows that host's
`allowAgentStart`; messaging a session on its own host needs no confirm.

## Error handling

| Failure | Behavior |
|---|---|
| No `pong` for 30 s | Host is offline. Its sessions show a banner: "<host> is offline. The run continues there; it reconnects automatically." Sends refused before they leave return 503 `{hostOffline: true, delivery: "refused"}`; the composer keeps the draft and shows a toast. A prompt whose ack the dropped link lost returns `delivery: "unknown"`: it may still run once the host reconnects, so the composer drops the draft and the toast says so. A fresh chat's 503 carries the `sessionId` it spawned when the link dropped after the spawn; the chat adopts it, so a retry starts no second session. |
| Link returns, children alive | Wrappers reattach; `get_state` reconcile runs; `resync` channels reconcile too. |
| Daemon restarted, children gone | Synthesized `process_exit` per missing channel, which raises the existing "Run failed" notification. With `autoResumeSessions` on, main restarts sessions that were mid-run and sends `RESUME_PROMPT` (Rules → Reattach). |
| Second daemon with the same token | Newest link wins; the old daemon receives `replaced` and exits. |
| Host op over 30 s | 504 naming the host; the sidebar keeps that host's last list. |
| Version mismatch | 426; host status `needs-upgrade`. |
| `omp` missing on the host | Host status `omp-missing`; new sessions there are disabled. |
| Host revoked while sessions run | Link closed; its wrappers are destroyed; its sessions leave the list. The omp children on that machine are killed by the daemon when it sees the 401 on reconnect. |

## Testing

`node:test` `.mjs` files beside the code, as in the rest of the repository.

- **Unit:**
  - link message encode/decode and size limits
  - token generation, hashing, verification; revoke closes the link
  - host hub: reattach, `replaced`, offline after missed pongs, missing
    channel → `process_exit`
  - `RemoteHost` + `RpcProcess` over an in-memory link
  - buffer overflow → `resync` → reconcile
  - remote path scoping and blob-hash validation
  - `new_session` remote confirm gate, with `allowAgentStart` on and off
- **Integration:** a real `ompweb host` process with its own `HOME` (a second
  "machine") linked to the dev server on loopback. Start a session, stream a
  reply, cut the link, reconnect, check reattach and that no frame is lost or
  duplicated.
- **Manual acceptance:** a MacBook linked over `https://ai-web.brait.dev`.
  Start a session there from the VM's UI; close the lid during a run; reopen;
  the run state is correct and the session finishes.

## Documentation

- `AGENTS.md`: a "Remote hosts" section (Host interface, link protocol rules,
  one-link-per-host, transport-down vs exited), and new files in the file map.
- `DESIGN.md`: the `Host` seam in the porting contract.
- `README.md`: how to link a machine (`ompweb host login`, `ompweb host`,
  running it as a service).
- `CHANGELOG.md` entry.
