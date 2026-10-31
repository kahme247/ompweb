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

The link is **one WebSocket per host** at `/api/hosts/link`, opened by the
daemon (which also works behind NAT). The full design, with the decisions, wire
format, close codes and limits, is `docs/specs/2026-10-31-websocket-link-design.md`;
this section is the summary. Before v4 the link was two HTTP legs (a hello POST,
an NDJSON downlink GET, uplink POSTs and a blob POST) because the server then ran
under `next start`, which cannot accept upgrades; those legs are gone.

- **Transport.** The daemon dials `ws://` or `wss://` plus its saved server URL
  plus `/api/hosts/link` with `Authorization: Bearer <host token>`. **Text
  frames** carry the JSON messages: one message per frame from main, one or more
  newline-separated messages per frame from the daemon (the uplink batch,
  flushed every 16 ms or at 256 KB). **Binary frames** carry large op results
  (daemon → main only, below).
- **Auth before the upgrade.** `proxy.ts` reports the route as ungated; the
  route checks the bearer token before `server.upgrade`: 401 when no host
  record matches, 503 when the host registry cannot be read (a daemon that sees
  401 stops its omp children; it retries any 5xx) and 503 while the server is
  shutting down. An authenticated request that is not an upgrade gets 426. The
  token is checked once per socket; revoking a host closes its socket (1000),
  and the daemon's redial is refused 401.
- **Refusal diagnosis.** A daemon's built-in `WebSocket` does not expose the
  status of a refused upgrade, so when a dial closes before `open` the daemon
  sends one plain `GET /api/hosts/link` with the same token and acts on that
  status: 401 revokes (stop the children, exit 1), 503 redials, anything else
  is logged with a hint (a reverse proxy not forwarding `Upgrade`/`Connection`,
  or an older server) and redialed with backoff.

### Messages

One JSON object per line. Every message except `hello`, `welcome`, `ack`,
`ping` and `pong` carries a per-direction sequence number `seq`. An `ack {ack}`
message carries the highest `seq` the sender applied from the other side:
it is the first line of every daemon → main frame (`ack` = highest downlink
`seq` applied), and main answers every uplink frame with exactly one `ack` (the
highest uplink `seq` it applied). The `hello` carries `ack` too. Each side keeps
unacknowledged messages, resends them after a reconnect, and drops any `seq` it
already applied, so no line is lost or applied twice when the socket breaks
mid-write. stdin lines omp has not received would otherwise vanish.

The daemon keeps **one uplink text frame in flight**: it sends the next only
after main's `ack` for the previous. A drop clears that; everything unacked is
sent again after the next `welcome`. Main decodes a whole frame before applying
any of it.

The daemon's first text frame on a new socket is its `hello`, alone. It lists
every live channel, so it can be large; as a frame body it is not subject to
header buffers. Main checks `v`, applies the hello (closing an older socket of
this host, reattaching, adopting or killing channels, resending its outbox) and
answers `welcome`. A frame belongs to the socket it arrived on: main ignores
frames from a socket that is no longer the host's link.
A `hello` with `ack: 0` comes from a daemon that has applied no downlink
message, so it has sent no sequenced uplink message either (each one answers
a downlink message): main restarts its uplink window for that host. Main
numbers downlink messages above the daemon's `ack`, so a restarted main and
a running daemon never reuse a `seq`.

**Downlink pacing.** Main paces the downlink from its outbox: it sends the unsent
sequenced lines in `seq` order until the socket's `send` reports backpressure,
then sends the rest on the socket's `drain`. A daemon that stops reading
(asleep, stopped, on a slow link) is waited for, not closed, and a resend after
a redial is paced the same way. The outbox therefore holds the unacked backlog in
server memory until the daemon acknowledges it. The send-buffer limit
(16 MiB) is only a backstop: past it the socket is closed and the unacked
messages go again after the redial.

| Message | Direction | Purpose |
|---|---|---|
| `hello {v, ompVersion, platform, home, autoApproveExtension, ack, channels[{ch, sessionId, cwd, pending}]}` | up | Handshake; `channels` lists live omp children from before a reconnect. `ompVersion` is `null` when `omp` is not found. |
| `welcome {v, hostId}` | down | Accepted. |
| `stdin {ch, line}` | down | One raw omp NDJSON line. |
| `stdout {ch, line}` | up | One raw omp NDJSON line. |
| `stderr {ch, chunk}` | up | Child stderr, for the existing logging. |
| `kill {ch, force}` | down | Stop a child: `force: false` terminates its process tree, `true` kills it. |
| `exit {ch, code, signal}` | up | Child exited. |
| `resync {ch}` | up | Buffered output for `ch` was dropped. |
| `req {id, op, args}` | down | Host op request. |
| `res {id, ok, result \| error}`; `res {id, ok: true, blob: {bytes}}` | up | Host op result; the second form names bytes sent earlier in a binary frame. |
| `ack {ack}` | both | Highest `seq` applied from the other side; unsequenced. |
| `ping` / `pong` | both | Liveness: main pings every 15 s; each side drops the link after 30 s without a frame. |

A binary frame is `byte 0` = the UTF-8 length *n* of the request id (1 to 255),
then the id, then the result bytes (media bytes for `readMedia`, else the UTF-8
JSON of the result). The daemon sends it before the `res` that names it; the
one socket keeps that order.

### Close codes

| Code | Sent by | When | Daemon reaction |
|---|---|---|---|
| 1000 | main | host revoked | redial, refused 401, diagnosis: stop children, exit 1 |
| 1001 | main | shutting down | redial with backoff |
| 1007 | main | a frame with a malformed line or bad envelope (nothing in it is applied) | log, redial, resend |
| 1008 | main | first frame binary, not JSON, or not a decodable `hello` | log, redial |
| 1009 | main or Bun | frame over its size limit | log, redial |
| 4409 | main | a newer socket of this host said hello | exit 0 |
| 4426 | main | hello `v` outside the supported range; reason `{"serverVersion":N}` | log which side to update, exit 1 |
| 1006, other | | drop or watchdog | redial with backoff |

### Rules

- **Version.** `v` is an integer, bumped on any incompatible change (2: the
  hello moved from the GET header into a POST body; 3: the hello carries
  `autoApproveExtension` and each channel its `cwd` and `pending`; 4: the link
  is one WebSocket, `ack` is a message and `replaced` and `welcome.nonce` are
  gone). Main links daemons from `MIN_LINK_PROTOCOL_VERSION` (4) up to its own
  `LINK_PROTOCOL_VERSION` (4); its `welcome` carries the version the link
  speaks (see "Protocol versions and compatibility"). A hello whose `v` is
  outside that range (checked on the raw JSON before decoding) gets close 4426
  with reason `{"serverVersion":4}`; the daemon exits 1, telling which side to
  update ("update ompweb on this host", or "this host's ompweb is newer than
  the server's: update ompweb on the server" when `serverVersion` is below its
  own); Settings → Hosts shows "needs upgrade (host vN, server vM)" unless the
  host has a healthy socket.
- **Identity.** The host is the record whose `tokenHash` matches. Nothing the
  daemon sends selects or changes its identity.
- **One link per host.** A hello on a new socket with the same token closes the
  old socket with 4409 (the old daemon exits). A revoked host is refused at the
  upgrade (401) and, if its socket was already open, at the hello (close 1000).
  Two daemons must never run competing `omp --resume` children against one
  agent directory.
- **Buffering.** While the uplink is down, the daemon buffers each child's
  output up to 8 MB per channel. On overflow it drops that channel's buffer
  and queues `resync {ch}`, which reaches main with the first uplink frame that
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
  successful `readMedia` result, is sent in a binary frame (above) before its
  `res`, in the same socket, instead of inside a text frame; the `res` line
  then carries `blob: {bytes}` and no `result`.
- **Limits.** An uplink text frame is capped at 16 MiB (the daemon's batch cap;
  main closes 1009 above it), a single message line at 8 MiB (an over-limit
  `stdout` line is dropped and replaced by `resync {ch}`) and a binary frame at
  64 MiB plus its header (the daemon refuses a larger result with 413
  `result_too_large`). Main's send buffer holds 16 MiB, a backstop behind the
  downlink pacing above. **Known slow-link limit:** a single multi-MiB line
  that takes longer than `offlineMs` to arrive makes main treat the link as
  dropped and resend it; the line is retried each time, so a link slower than
  roughly 280 KiB/s cannot deliver an 8 MiB line.

### Protocol versions and compatibility

- **A released version changes only compatibly.** Compatible means both: every
  message the newer side can send is valid for an older receiver, and every
  message the older side can send is valid for a newer receiver. Anything else
  needs a new `LINK_PROTOCOL_VERSION`.
  - Compatible: a sender starting to always include a field the receiver
    already accepts as optional; adding an optional field (decoders ignore
    fields they do not know); adding a message type that receivers ignore when
    unknown.
  - Not compatible: making a field the receiver requires optional for
    senders; changing a field's type or meaning; a receiver starting to
    require a field older senders may omit.
  - Receivers tolerate what they do not know: an unknown message type (valid
    envelope: a string `type` and, where the direction numbers messages, a
    non-negative safe-integer `seq`) is skipped, its `seq` still applied and
    acked so it is never resent and later messages are not blocked. A known
    type arriving the wrong way (`stdout` on the downlink) is skipped and acked
    the same way. Each side logs an unknown type once per link (at most 16
    distinct types, escaped and cut to 64 characters) and a wrong-way message
    each time (at most 16 per link). An unknown host op in a `req` is answered `res {ok: false, error:
    {status: 501, code: "unknown_op"}}`, which main surfaces as a 501
    `HostOpError` so callers can fall back. A sender must not rely on a newer
    message being understood unless the version (or, later, a capability) says
    so. Tolerance starts with v3: a daemon older than that is strict (an
    unknown type or op makes it refuse the line).
- **Older versions stay supported** from the next version on, until supporting
  one becomes too much of a maintenance burden; dropping one is an explicit
  decision (raising `MIN_LINK_PROTOCOL_VERSION`, which is 4 today: the
  WebSocket link links only v4). In practice main keeps at least version N-1.
  For an older daemon main decodes its hello into today's shape and sends only
  messages that version understands. A daemon on a dropped version gets 426
  (a POST) or close 4426 (a hello frame); an update-only mode for it is
  planned, separately.
- **Upgrade order: web app first, then hosts.** Main supports older daemons; a
  daemon is not required to support a newer main, and one newer than main gets
  close 4426.
  `hostVersion` (Settings → Hosts) is the version a linked daemon speaks,
  so Settings can later show "update available" for one behind the server.
- **v4 (the WebSocket link) dropped v3** before any release; from the next
  version on, main keeps N-1. A v3 daemon POSTs its hello to
  `/api/hosts/link`; main answers that POST 426 with both versions (and never
  links it), so the old daemon logs "update ompweb on this host" and exits 1.
  A v4 daemon dialing an older server gets an upgrade refusal and keeps
  redialing (backoff up to 60 s) with a hint, so it links once the server is
  updated. Update the server first, then its hosts.

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
