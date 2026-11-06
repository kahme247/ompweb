# One host daemon, several web servers — design

Date: 2026-11-06. Branch: `docs/multi-server-host` (on `main` 3b6243c5).
Builds on: `docs/specs/2026-10-28-remote-hosts-design.md` ("Protocol versions and compatibility"), `docs/specs/2026-10-29-local-daemon-design.md` (adoption), `docs/specs/2026-10-31-websocket-link-design.md` (D3, D6, D7).

## Why

A change to the web app can only be tried on real sessions by deploying it over production. A second web server on the same agent dir either sees no sessions (the daemon links one server at a time) or, when it takes the daemon over, takes this machine away from production: production shows the host offline, anything that talks to production for this machine fails (pr-watcher deliveries, agent tools), and the taking server's idle timers stop sessions a production tab is showing.

Goal: one `ompweb host` daemon per machine serves two or more web servers at the same time. Both show the same sessions, live and in step, and either can drive any of them. Testing a web change then means starting a second web server, not moving or copying sessions.

Not a goal: two daemons on one agent dir, or two daemons sharing one omp process. There stays exactly one daemon per machine and one omp process per session.

## Decisions

### M1. Links

- `<agent dir>/omp-web/host.json` keeps `{url, token}` (what a v6 daemon reads) and gains `links: [{url, token}, …]`. The top-level pair is the primary link; a missing `links` means `[{url, token}]`.
- A web server writes only its own entry, keyed by URL (`ensureLocalHostLink`); it never rewrites another server's entry, and it writes the top-level pair only when the file has none. `ompweb host login --add <url>` adds an entry on a remote host; `login` alone keeps today's meaning (replace the primary).
- The daemon keeps one link per entry: its own socket, uplink and downlink sequence windows, outbox, `LinkSender`, unacked window, ping and protocol version. The per-socket state that is closure-local in `runHostDaemon` today moves into a `Link` object; ops, channels and uploads are shared.
- The daemon re-reads `host.json` when it changes (file watch, plus the existing re-read after a link loss) and opens or closes links to match. A link whose server is down redials with backoff up to 30 s; loopback keeps its 3 s ceiling only for the primary.
- A 4409 (replaced) or revoke (1000, 401) ends that link only. The daemon exits only when its last link is revoked.
- All links of a daemon use the token of the machine's `local` record (local daemon) or the host record of each server's own registry (remote host). Nothing changes in `hosts.json`.

### M2. Shared processes

- One channel table for the daemon. Every line an omp process prints is queued on every link that has joined that channel (M3), in the order omp printed it. A link's backlog never delays another link.
- The hello lists every channel to every link (`{ch, sessionId, cwd, pending}` as today). A v7 server joins the listed channels it has wrappers for, or adopts them as today; it no longer kills a listed channel it cannot adopt (M6 decides stops).
- After a channel starts or acquires its authoritative session identity, `channels_changed {channels}` carries the same listing to every v7 link. This lets a server discover background runs after its initial hello, even without a tab opening that session.
- A successful handshake sends a fresh listing to cover channels created after the hello snapshot. Listings announce additions; only an authoritative hello or an explicit exit removes a joined transport. Passive joins carry `expectedChannel` and cannot cold-spawn a channel that has already ended.
- The per-channel buffer cap (32 MB) is per link: past it, that link gets `resync {ch}` and the others are untouched.

### M3. Joining a session

- New op `open {sessionId | null, launch: {cwd, recordedCwd, sessionFile, toolNames, advisor, spawnModel}}` replaces `spawn` for v7 links:
  - A running channel for `sessionId` (matched on `PendingRequests.sessionId`): the link joins it. The result carries `ch`, `joined: true`, the channel's open blocking requests (`pending`, as in the hello) and, when an assistant message is streaming, that message whole (M5).
  - None: the daemon spawns with `launch` (today's `localHost.spawnRpc`), records `launch` on the channel (M7) and returns `joined: false`. Concurrent `open`s for one session share the spawn.
  - `sessionId: null` always spawns (a new chat).
- `open` also accepts optional `expectedChannel`, `replaceAdvisor` and `preparing`. An expected-channel join must match the existing running channel or fail without spawning. An explicit Advisor preference may atomically replace only an idle, unprotected child; busy children retain their mode. A command open's preparation handoff protects startup and the first send against a competing replacement, and transfers into normal command accounting.
- The result reports `advisorSpawned`, the actual native spawn flag including workspace-forced Advisor mode, rather than inferring it from the requesting server's preference.
- Only a native `session-persistence` move keeps old identity aliases; deliberate fork/new/switch transitions drop them. Copy-on-write may retain the original file, so its existence alone does not distinguish a move from a fork. Aliases route continuation commands; delete/archive still target the requested stored session id and never silently delete a different id.
- A joining link receives every line printed after the `open` result, and none before it; the result and the first line go out under the same sender key, so the order holds.
- `close {ch}`: the link leaves the channel (no more lines). It does not stop the process.

### M4. Commands and replies

- The daemon assigns each link an id (`l1`, `l2`, …, never reused while the daemon runs) and sends it in its hello on that link (`link: {id, notifier}`).
- The daemon records the `id` of every command a link writes to a channel's stdin. A `response` whose `id` it recorded goes only to that link, and the record is dropped. A `response` with an unknown or absent id goes to every joined link. Command ids are already unique per server (`RpcProcess` prefixes each with a random `w<uuid8>-`), so servers need no change; the daemon's own commands use the prefix `d:` and their replies go to no link.
- Commands from several links reach omp in arrival order. omp serializes prompts and queues follow-ups itself; the queue, run state, `/btw`, todos and subagents reach every link through omp's own output and snapshots, so both UIs show one conversation. A prompt sent from one server appears on the other exactly like one sent there: omp echoes it as a user message, and nothing marks which server sent it.

### M5. Rejoin at any point

Three layers, none of which keeps a session's history in the daemon:

1. A dropped link that comes back gets its unacked lines resent from its last ack (today's link resume, per link), while they fit that link's per-channel cap (M2). A link whose entry leaves `host.json` is closed and its backlog dropped.
2. A long drop, a `resync` or a new server rebuilds: history from the session file (session ops through the daemon), current state from `get_state`, `get_subagents` and `get_btw_history` (sent by that server, answered to it alone, M4), and open dialogs and tool calls from `pending` (M3).
3. Mid-message: the daemon keeps each channel's open assistant message, rebuilt from omp's deltas with `lib/message-delta.ts` (keyed by `messageId`; cleared on `message_end`, `agent_end` and process exit). A link that joins or resyncs while a message streams first gets one whole `message_update` for it, then the deltas that follow. omp stays on delta updates whatever any server does; a server never switches the event filter (M8).

### M6. Lifecycle in the daemon

The daemon decides when a process stops; the two web-server timers in `lib/rpc-manager.ts` (`DISCONNECT_DESTROY_MS`, `IDLE_DESTROY_MS`) no longer run for v7 hosts.

- **Interest.** Each server sends `interest {ch, on, preparing}` (sequenced, hub → daemon) when its state changes: on while it has a tab attached to the session (an `onEvent` listener) or a command of its own unanswered; `preparing` protects command preparation such as a slow upload attachment before prompt stdin exists. A link that drops keeps its interest for 2 min (`DISCONNECT_GRACE_MS`), so a restarting server keeps the sessions its tabs show.
  Every successful re-open reasserts current interest/preparation, including after the disconnect grace expired. Explicit close clears its preparation handoff; a dropped socket retains the bounded grace.
  Only the command its open asked for inherits the open's preparation handoff; another command's preparation never ends it.
- **History-edit lease.** Before its preflight, an edit takes the channel's lease with the `editLease {ch, on}` op, which answers 409 `session_busy` while another link holds it, so a competing editor fails before it reads anything. The holder keeps it through postflight; the daemon answers the other links' history mutations (`HISTORY_MUTATING_COMMANDS`) with `session_busy` until the holder releases it, its link drops or it closes. Reads are never fenced.
- **Startup.** The daemon waits up to `LINK_LIMITS.channelReadyMs` (120 s, the legacy wrapper's allowance) for `ready`, and the hub's `open` deadline adds the op timeout to it.
- **Run state.** The daemon reads it from the process's output: a run starts at `agent_start` and ends at a terminal `agent_end`; background work ends at `session_settled`. A command is in flight from its stdin line until its `response`.
- **Stops**, each logged with its reason:
  - abandoned: no link has interest, no run, no background work and no command in flight, for 2 min (`OMP_WEB_DISCONNECT_DESTROY_MS` keeps its meaning and its `0`);
  - idle: no run, background work, command, startup, blocking request or command preparation for 10 min, whatever the tab interest;
  - asked: a server's explicit `kill {ch}` (delete, reload, omp update). Failure to attach/reconcile a server closes that server's membership, never the shared process.
- A stop is a kill escalating to force after 5 s, as today, and every joined link gets the channel's `exit`.
- A link going down never stops a process; neither does a link going away for good (its interest ends after the grace).

### M7. Resume after a daemon restart

- A web server restart needs no resume: the processes keep running under the daemon and the server rejoins them (M2). Only a daemon restart or crash ends them.
- The daemon keeps `<agent dir>/omp-web/host-running.json` (0600, atomic write): the sessions with a run or background work in flight, each with its `launch`. It writes it when a run starts or settles (at most once per second) and freezes it when the daemon stops, so processes ending during a stop count as interrupted.
- On start, when `autoResumeSessions` is on (read from `<agent dir>/omp-web-settings.json`, as the server reads it), the daemon takes the file (rename, as `lib/session-resume.ts` claims its list today), spawns each listed session once with its `launch` and sends `RESUME_PROMPT` itself, under its own command id prefix `d:` (replies go to no link). Servers that link see the resumed run like any other. One sender, however many servers link.
- The claimed file stays until every resume has settled (`retireClaim`): resumed sessions go back into the running manifest, and any whose resume failed stay in this daemon's claim, which a later start takes once this daemon's pid answers ESRCH. A crash mid-recovery therefore loses nothing. An entry whose session file is gone is skipped, not fatal. A session with an unreconciled `session-persistence` move is left out of the file until `get_state` names its new id and file.
- `lib/session-resume.ts`'s per-pid lists and `resumeOnHostLink` remain only for v6 hosts and are deleted with v6 support.

### M8. Startup settings

- The daemon sends the process-wide settings once, right after spawning: `negotiate_protocol`, `set_event_filter {events: null, messageUpdates: "delta"}`, `set_subagent_subscription`, `set_ask_dialog`, with command ids prefixed `d:`, so their replies go to no link (M4). A v7 server skips them when it opens or joins.
- Servers keep sending the per-server reads (`get_state`, `get_subagents`, `get_btw_history`) and their own commands.
- A daemon whose omp rejects delta updates keeps full updates for the process; every v7 server reads both (as today).

### M9. Shared requests

- **Dialogs** (blocking `extension_ui_request`): every joined link gets the request, so it shows on every UI. The daemon forwards the first `extension_ui_response` for an id to omp, drops later ones, and sends every other joined link the cancel omp itself would send (`extension_ui_request` with `method: "cancel"`, `targetId`), which closes their dialog through the existing code.
- **Tool calls.** omp executes normal tools once on the host; their progress and results fan out to every joined link. Only web-supplied callbacks (`host_tool_call`, `host_uri_request`: browser `open_url`, `notify`, `open_file`, and server `list_sessions` / `new_session` / `send_to_session`) need an executor selection: choose the last prompt/steer/follow-up sender if eligible, otherwise the earliest-linked registrant. Once dispatched, keep the same executor across reconnects: losing a socket is not proof that its action did not happen, so never blindly re-execute on another server. Only undispatched calls may choose another registrant. Registrations arrive as `host_tools {ch, tools, schemes}` (`schemes`: `{scheme, writable}`); the daemon supplies their validated union to omp. A tool call is eligible only on a server registering exactly the definition omp was advertised when it made the call, and a URI write only on a writable registration. With no registrant a call waits in the daemon. The single callback result goes back to omp; the execution frames and committed result reach both UIs.
- **Message admission.** When a link writes a message command (`prompt`, `steer`, `follow_up`, `abort_and_prompt`), the daemon first puts a `peer_message_command` stdout line in every other member's output. A server's echo proof for its own message is ambiguous once such a marker arrived, so a peer's identical echo never confirms it.
- **Automatic titles** are requested only by the notifier link's server; manual renames are unaffected.
- **Notifications**: the daemon marks one link as notifier (`link.notifier` in the hello, then sequenced `notifier {on}` on change): the earliest-linked v7 link that is up. Only the notifier publishes (`notification-hub.ts`); every server shows the shared history. A v6 link always publishes.
- **Session lists**: when a session file changes in a way that invalidates the daemon's list (`invalidateSessionLists`, renames, titles, deletes, new sessions), the daemon sends `sessions_changed` to every link, which drops that host's 30 s list cache on each server.

### M10. Compatibility

- `LINK_PROTOCOL_VERSION` 7, `MIN_LINK_PROTOCOL_VERSION` stays 4. v7 adds `hello.link`, the ops `open` and `close`, and the messages `interest`, `host_tools`, `notifier`, `channels_changed` and `sessions_changed`.
- A v6 link to a v7 daemon behaves exactly as today: `spawn`, its own timers and startup settings, kills of unadopted channels. It sees only the channels it spawned, and no other link joins them. Its replies go to it alone. A session never gets two processes: a v6 `spawn` for a session a v7 link's channel runs, or a v7 `open` for one a v6 channel runs, is refused with 409 `session_running_elsewhere`.
- A v7 server keeps linking v4–v6 daemons with today's behaviour (one link, server-side lifecycle).
- Shared files of the agent dir stay shared: `omp-web-settings.json`, `projects.json`, `hosts.json`, the notification store. A staging server's settings change applies to production too; that is accepted.

## Rollout

1. Release the v7 server and daemon together. Deploy the web server first (it links today's v6 daemon unchanged), then schedule the initial daemon restart with the user while the host has no active or unsettled sessions: a v6 daemon has no `host-running.json` to recover. Subsequent v7 daemon restarts use M7's tested recovery. Remote hosts update from Settings → Hosts under the same initial-upgrade precondition.
2. Start an additional compatible web server; local bootstrap adds its own link, while remote hosts use `ompweb host login --add --url <url>` with the token on stdin. Stopping or unregistering that server must not restart the primary or the daemon. Deployment-specific automation lives outside this repository.
3. Existing clients of the primary continue using its URL: the primary no longer loses the host when the additional web server connects.

## Testing

- Daemon tests with two fake hubs: output order and sender-only replies, including chunked responses; whole streaming message on join; first dialog answer and cancellation on the other link; last-active callback selection with no duplicate action after link loss; interest, preparation protection and grace periods; single resume; notifier handoff; list invalidation; legacy isolation.
- Integration (`npm run smoke` extended): one real daemon, two real servers. A prompt sent on A shows as a user message on B; a dialog answered on B closes on A; restarting A keeps the process and B's view; B joining mid-stream renders the open message; the process stops only after both drop interest.
- Compatibility: a v6 server against the v7 daemon, and a v7 server against a v6 daemon, pass today's host tests.
- Live, at a time agreed with the user: production and staging on one session, each item above checked.

## Planning clarifications for review

The implementation plan corrects four details discovered against the current source: command correlation uses the existing RPC ids (the prefix is not a constructor option); a dispatched callback cannot safely be retried elsewhere; preparation/background work must protect host idle cleanup; and the first upgrade cannot recover a manifest the old daemon never wrote. These are included in the plan-review gate, not permission to deploy or change production now.
