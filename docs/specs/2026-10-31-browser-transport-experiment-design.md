# Browser transport experiment (SSE + HTTP vs WebSockets) — design

Date: 2026-10-31. Branch: `feat/browser-ws` (stacked on `feat/ws-link`, #347). Plan: `docs/plans/2026-10-31-browser-transport-experiment.md`.
Builds on: AGENTS.md "Live event stream: one socket per browser", "Queued messages are omp-owned", "Running state + reconciliation", "RPC session lifecycle"; `docs/specs/2026-10-31-websocket-link-design.md` (the host link's WebSocket, whose `Bun.serve` `websocket` handler this shares).

## Goal

An A/B experiment for the browser's live transport. Today one SharedWorker (`public/event-stream-worker.js`) holds one SSE stream (`GET /api/events`) carrying every tab's channel frames; subscriptions and every action are HTTP requests. This adds **WebSocket transports** behind a server-side switch, in three socket-assignment modes, measures all four transports with the same instrumentation, and stores the numbers on the server, so the user can use the phone, switch networks and ask the agent to flip the transport, and the agent compares p50/p95 without the user copying anything.

| transport | sockets | question it answers |
|---|---|---|
| `sse` (default) | 1 EventSource + HTTP requests | today's baseline |
| `ws-client` | 1 socket per browser, every channel and session | fewest connections; all sessions share one ordered pipe |
| `ws-session` | 1 general socket + 1 per active session | full isolation between sessions; most connections |
| `ws-pool` | 1..`maxSockets` sockets, sized from the active sessions | isolation per bucket at a bounded connection count |

SSE + HTTP stays the default and keeps working unchanged.

Non-goals: replacing SSE; moving any API besides the agent command path and channel (un)subscribe to a socket; WebSocket compression; working around head-of-line blocking (it is measured); closing a socket when its session cookie is invalidated (limitation below); a metrics UI.

## Decisions

### D1. The switch

- Web settings in `omp-web-settings.json` (`lib/web-settings.ts`):
  - `browserTransport: "sse" | "ws-client" | "ws-session" | "ws-pool"`, default `"sse"`; any other value reads as `"sse"` (the experiment's earlier `"websocket"` value included: no alias).
  - `browserTransportPerSocket`: sessions per pool socket, integer 1–64, default 4.
  - `browserTransportMaxSockets`: most pool sockets, integer 1–16, default 16.
  - Out-of-range or non-integer stored values read as the default. `GET /api/web-settings` returns all three; `PUT` validates each key it carries (400 `invalid_settings`). Settings → Interface & Behavior: a four-option select, plus the two numbers while `ws-pool` is selected.
- **Live switch: push.** A `PUT` that changes any of the three calls `broadcastBrowserTransport(state)` (`lib/event-stream-hub.ts`), which writes `{type:"transport", transport, perSocket, maxSockets}` on every open connection, SSE and WebSocket. Every `hello` carries the same three fields, so a worker that was disconnected during a flip, or one that just started, converges on its next hello. A `PUT` that changes nothing broadcasts nothing, and the worker ignores a frame equal to its current state: the switch is idempotent. A worker always starts in SSE mode and switches on its first hello (one wasted SSE handshake per worker start in WebSocket modes; not counted in any metric).
- **Editing the file** works only after an omp-web restart (the settings are cached in `globalThis`, as today); the HTTP call is the supported flip.
- **The agent's flip command** (production, port 30185; the trusted header is the one `pr-watcher` uses, verified: its SHA-256 matches `OMP_WEB_TRUSTED_HEADER_SHA256`; a request without `Origin` skips the origin check):

  ```bash
  curl -sS -X PUT http://127.0.0.1:30185/api/web-settings \
    -H "x-omp-web-auth: $(sed -n 's/^OMP_WEB_TRUSTED_HEADER_SECRET=//p' /opt/omp-deployment/pr-watcher.env)" \
    -H 'content-type: application/json' \
    -d '{"browserTransport":"ws-pool","browserTransportPerSocket":4,"browserTransportMaxSockets":16}'
  # or {"browserTransport":"sse"} / {"browserTransport":"ws-client"} / {"browserTransport":"ws-session"}
  ```

  The response is the saved settings object; every open browser switches within one round trip.

### D2. Sockets and their assignment

Every browser socket is **multi-session**: frames already name their subscription, and commands name their session (D4), so any socket can carry any channel and any session's commands. The three WebSocket modes are only a worker-side policy, `socketKeyFor(sessionId | null) → key`, where `null` stands for every non-session channel (`running`, `notifications`, `host-tools`, `hosts`, `file`):

| mode | non-session channels | session `s` (its `session` channel and its commands) |
|---|---|---|
| `ws-client` | `client` | `client` |
| `ws-session` | `general` | `session:<s>` |
| `ws-pool` | `pool:0` | `pool:<rank(s, N)>` |

The worker (same SharedWorker; the dedicated-Worker fallback unchanged, so on Chrome for Android each tab has its own worker, sockets and pool) dials a socket lazily, the first time its key is needed, at `GET /api/events/ws` (no query). Everything else stays HTTP in every mode: `GET /api/agent/[id]` (reconcile/state polls, 8 call sites), `POST /api/agent/new`, bash-output, file, settings, the metrics POST and the clock probe.

**Active sessions** (this worker): sessions with a live `session` subscription or an unanswered command. Background sessions that no tab shows stay on the non-session `running` channel.

**ws-pool sizing.** N = clamp(ceil(active / `perSocket`), 1, `maxSockets`).
- Grows immediately when the target exceeds N.
- Shrinks only when the target has stayed below N for `SESSION_LINGER_MS` = 30 s (hysteresis: a timer starts when the target first drops below N; any recompute with a target ≥ N cancels it; when it fires, N becomes the target of that moment). A settings change applies its new N at once in both directions.
- `rank(s, N)` is rendezvous (highest-random-weight) hashing: the index `i` in `[0, N)` with the highest `score(i, s) = fmix32(fnv1a(i + ":" + s))` (lowest `i` on a tie). Growing N to N+1 moves only the sessions whose top score is the new index (about 1/(N+1) of them, all to the new socket); shrinking moves only the sessions of the removed indices, each to its next-best. Plain hash-mod-N would be enough for a fixed N, but with N following the session count it would move about N/(N+1) of the sessions on every change. Rendezvous is about ten lines and needs no ring.
- Non-session channels stay on `pool:0`; sessions ranked 0 share it.

**Linger.** A socket with no subscription and no unanswered command closes at once if it is `general` (like the EventSource today), or if the current policy can no longer produce its key (a pool index ≥ N, a key of another mode). Any other socket lingers 30 s, so tab switches reuse it.

**Moves (make-before-break).** When the policy changes (a ws→ws mode switch, a pool resize, a settings change), every subscription whose key changes is moved:
1. `sub` on the new socket (dialed if needed); the old socket keeps delivering.
2. On the new socket's `open` for it: the tab gets CONNECTING then OPEN (the reconnect it already handles; the channel replays its snapshot), `unsub` goes to the old socket, and frames still arriving there for it are ignored.
3. A `refused` or `end` from the new socket cancels the move; the subscription stays where it was and moves at the next policy change.

Commands: a session's unanswered commands sit on one socket (`connForCommand`: the socket holding them, else `socketKeyFor(session)`), so they reach omp in the tab's order across a move. Unsent ones move with their session, all together; once one of them is sent, the session's later commands wait behind it on that socket until it is answered, and only then follow the session to its new socket. If that socket drops first, the resend rule (D5) applies on the session's current socket, the session's commands moved in order. Two cases keep no such guarantee (Limitations): `connForCommand` looks only at the current sockets, so after a WebSocket → SSE → WebSocket round trip a command still on a socket draining from before the round trip is not found and a newer command of its session can reach omp first; and two policy changes that return within one round trip (A→B→A) can send `sub`, `unsub`, `sub` to one socket, so a stream gets a second `open` with no CONNECTING between and its snapshot replays twice.

`sse` ↔ any WebSocket mode keeps the plain switch (D5 "Mode switch"), not moves.

### D3. Server side

- **Upgrade route** `app/api/events/ws/route.ts`, table key `"events/ws"`. It goes through `handle()` like every gated route, so `proxy()` applies the password gate (session cookie or trusted header) and the API origin check **before** the handler calls `upgrade()`. A request that does not upgrade gets 426. The upgrade binds no session (the experiment's earlier `?session=` binding is gone). Limitation: the socket stays authorized after logout or a password change until it closes.
- **Socket data** `{ kind: "browser", connection: EventStreamConnection | null }` (`BrowserSocketData`, `lib/browser-socket.ts`). `server/app.ts` composes one `websocket` handler: `ws.data.kind === "browser"` goes to `browserSocket`, anything else to `hostLinkSocket` (unchanged). Bun's limits are per server, so browser sockets inherit the link's `maxPayloadLength` (64 MiB + 256), `backpressureLimit` (16 MiB, close on exceed), `idleTimeout` 120 s and `sendPings`; the browser handler enforces its own frame cap below.
- **One `EventStreamConnection` per socket**, transport-agnostic through a `FrameSink`. `new EventStreamConnection(signal)` keeps the SSE sink and its `stream`; `new EventStreamConnection(undefined, sink)` serves a socket. Channels, coalescing (`message_update` latest-wins while the peer is behind: SSE `desiredSize < 0`, socket `getBufferedAmount() > 256 KiB`, flushed on `drain`), `end`, and per-subscription failure isolation are shared code.
- **Shared command function.** `runAgentCommand(id, body, advisor): Promise<Response>` in `lib/agent-command.ts` holds what `POST /api/agent/[id]` does after parsing. The route parses and calls it; the socket handler calls it with the frame's `session`, `command` and `advisor` and sends `{status, body: await response.json()}`. One implementation, identical replies.
- **Dedupe** by `(session, rid)`: `globalThis.__ompBrowserCommands`. A known key joins the in-flight run or replays the settled reply (`deduped: true`). Entries expire `DEDUPE_WINDOW_MS` = 120 s after they settle; at most 500 (oldest settled dropped first). Scoped to the session, not the socket, so a resend on another socket of the same server dedupes. Lost on a server restart; D5 never resends a non-idempotent command to a different server.
- **Handler safety.** A throw or rejection in any browser socket handler closes that socket (1011) and is logged; it never reaches `uncaughtException` and never touches host links.

### D4. Wire format

**SSE (unchanged except additive fields):** every frame gains an `id: <server ms>` line (`event:`, `id:`, `data:`) carrying the emit time; consumers read it as `event.lastEventId`. `hello` gains `serverId` (random per process), `transport`, `perSocket`, `maxSockets`. The `transport` control frame is ignored by an old worker (`handleControl` finds no subscription for it).

**WebSocket, server → client:** text frames `"<name> <server ms>\n<json>"`, split at the first newline without parsing the payload:

| name | payload | meaning |
|---|---|---|
| `mux` | `MuxControlFrame`: `hello {connectionId, serverId, transport, perSocket, maxSockets}`, `open {sub}`, `end {sub}`, `refused {sub, status, error, code}`, `transport {transport, perSocket, maxSockets}` | control; `refused` replaces the failed POST answer |
| `s<n>` | the channel payload, exactly as SSE `data:` | one subscription's frame |
| `ack` | `{rid}` | the command frame arrived; `at` = receive time |
| `reply` | `{rid, status, body, deduped?}` | `status`/`body` exactly as the HTTP route answers; `at` = reply time |
| `ping` | `{}` | server heartbeat every `WS_HEARTBEAT_MS` = 10 s |
| `pong` | `{c}` | answer to a client clock ping |

**WebSocket, client → server:** one JSON object per text frame:
`{t:"sub", id, channel}` (id matches `SUBSCRIPTION_ID_RE`, channel through `parseEventStreamChannel`), `{t:"unsub", id}`, `{t:"cmd", rid, session, advisor, command}`, `{t:"ping", c}`. A `cmd` whose `session` is not a string of 1–512 chars is acked and answered `reply` 400 `invalid_event_stream_request` (the socket stays). Unparsable JSON, an unknown `t` or a bad `rid` (not a string of 1–64 chars) closes 1007; a frame over `MAX_AGENT_COMMAND_REQUEST_BYTES` + 64 KiB closes 1009 (the worker refuses oversize commands locally with the route's 413 `request_too_large` first, so this is a backstop). Request ids are unique per worker (random), so `ack`/`reply` match by `rid` on a multi-session socket.

Per-socket order: on the fast path `runAgentCommand` reaches `existing.send()` before its first await, so commands on one socket reach omp in send order (HTTP gives no such guarantee). Not engineered further.

### D5. Reconnect, liveness and resend (per socket, the same rules for every socket and mode)

- **Heartbeat.** Server `ping` every 10 s. The client answers each `ping` with a clock `ping` (and sends one on `open`). A socket with no frame for `WS_SILENCE_MS` = 25 s is given up: closed, its subscriptions report CONNECTING, it reconnects.
- **Reconnect.** Per socket, backoff 1 s doubling to 30 s, reset by a `hello`. On `hello` the worker re-sends `sub` for every subscription of that socket; channels replay their snapshot on subscribe (the SSE catch-up semantics, reused).
- **Wake.** Tabs forward `online`, `navigator.connection` `change` and `visibilitychange` to the worker (`{op:"wake"}`). `online`/`network`: every socket is closed and reconnected at once, in parallel, no backoff. `visible`: every open socket gets a clock ping; one with no frame within `VISIBLE_PROBE_MS` = 3 s is reconnected; sockets waiting in backoff dial now. In SSE mode wake is only recorded (SSE behaviour unchanged).
- **Commands.** Each command carries `rid` (the tab's request id) and `session`. The worker sends it on `socketKeyFor(session)` once that socket has had its `hello`; a command not sent within `SEND_DEADLINE_MS` = 15 s answers 503 `transport_unavailable` (never left the browser). After sending, an `ack` must arrive within 10 000 + bytes / 32 ms (bytes = this command plus what was buffered ahead of it; 32 KB/s floor); a miss is a **silent hang**: recorded, the socket is reconnected (trigger `hang`). Only the ack is timed: the reply may take as long as the command takes.
- **Resend at most once, same `rid`, on the session's current socket:**
  - idempotent (`type` starts with `get_`, or `predict_word`): resent;
  - anything else: resent only when the new socket's `hello.serverId` equals the one it was sent under (same process, so the dedupe map holds it); otherwise, or on a second loss, it answers 503 `transport_lost` ("the connection dropped before the answer arrived; it may have run").
  - Refinement of "resend only idempotent commands": with the server's `(session, rid)` dedupe and the `serverId` check, resending a non-idempotent command cannot run it twice, and it turns a lost reply on a flaky link into a normal answer instead of an uncertain error.
- **Mode switch** `sse` ↔ WebSocket. To SSE: subscriptions move to the EventSource at once; sockets stop taking new commands, a command not yet sent answers `{http: true}` (the tab POSTs it), and sockets close when their sent commands settle (one that drops meanwhile answers `transport_lost`). To a WebSocket mode: the EventSource closes and every subscription joins its socket. A `cmd` that reaches a worker in SSE mode (a tab not yet told) is answered `{http: true}`; the tab sends it over HTTP. Between WebSocket modes: moves (D2).
- The SSE path keeps its behaviour: no silence detection, no wake action, EventSource's own reconnect, `POST /api/events` subscriptions.

### D6. Measurement (same in every transport, stored on the server)

Clock: offset = `serverNow − (c0 + c1) / 2`, RTT = `c1 − c0` (NTP-style); a sample with a negative RTT (the device clock stepped back mid-ping) is dropped. WebSocket: every socket's `ping`/`pong` (on `open` and in answer to each server `ping`, every 10 s). SSE: three sequential `GET /api/transport-metrics` (`{now}`) after each `hello`, then one every 10 s while that connection lasts, so every transport refreshes its clock as often. The worker keeps **one clock** for every connection, event and action in every mode: the lowest-RTT sample among the last 20 that are at most 5 minutes old (the newest always counts), so a device clock step ages out and the clock's systematic error is common to all modes and cancels in comparisons. A connection's first frame that arrives before the worker has any clock (in SSE the first snapshot usually beats the first probe's answer) is held and recorded once the first clock arrives, with that clock.

Every sample carries: `metric`; `transport` (the mode); `pool` (N in `ws-pool`, else `null`); `socket` (the key: `sse`, `http` for an HTTP command, a socket key, or `worker` for samples tied to no connection); `conn` (its kind: `sse`, `http`, `general`, `session`, `client`, `pool`, `worker`); `sockets` (sockets the worker holds, open or dialing; 1 in SSE mode while the EventSource exists); `clientId` (localStorage `omp-web:transport-client-id`); `effectiveType` (`navigator.connection.effectiveType` or `null`); `visible` (any tab of this worker visible). The server adds `serverAt` and `ua` (≤ 200 chars).

| metric | fields | recorded by |
|---|---|---|
| `action` | `req, type, session, via ("ws"\|"http"), status, outcome ("ok"\|"error"\|"lost"\|"unavailable"), attempts, deduped, bytes, behindBytes, behindSameBytes, behindOtherBytes, replyBehindOtherBytes, sentAt, recvAt, repliedAt, gotAt, offset, offsetRtt` | tab (`lib/agent-client.ts`), every command (a POST that gets no response: `status: 0`, `outcome: "error"`). HTTP: `x-omp-received-at` (stamped once the body is read, as the WS `ack` is after its whole frame: proxies stream uploads through) and `x-omp-replied-at` response headers; WS: `ack`/`reply` times. The tab sends the command's `type` with the `cmd`, so the worker never parses a body |
| `event` | `channel, at, gotAt, offset, offsetRtt, bytes, behindSameBytes, behindOtherBytes` | worker, at most one per connection per second (frames with `behindOtherBytes > 0` always); a connection's first frame before the worker's first clock is held for it (see Clock) |
| `reconnect` | `trigger ("error"\|"close"\|"silence"\|"hang"\|"online"\|"network"\|"visible"), dropAt, startAt, firstFrameAt, batch, effectiveTypeBefore` | worker; `startAt` = last wake within 60 s before the drop, else the drop; ends at the first `open` or channel frame after the re-subscribe; `batch` = sockets whose reconnect started within ±2 s of this one (how many reconnected together); `effectiveTypeBefore` = the effective type before that wake (`effectiveType` is the one after) |
| `rebalance` | `reason ("grow"\|"shrink"\|"setting"\|"mode"), fromPool, toPool, fromSockets, toSockets, active, moved, movedOther, settledMs` | worker, every policy change that moves at least one subscription or resizes the pool; `moved` = sessions whose socket changed (churn), `movedOther` = non-session subscriptions moved, `settledMs` = until the last move's `open` |
| `hang` | `req, type, via, bytes, waitedMs` | WS: missed ack (worker); HTTP: the tab's same-formula timer fired before the response (HTTP unchanged otherwise). Not the same quantity (receipt vs completion): the summary classifies them (below) |
| `dropped` | `count` | worker, when its buffer overflowed |

**Cross-session blocking** (isolation between sessions sharing a pipe):
- Downlink, every transport: per connection the worker keeps the frames ≥ `LARGE_FRAME_BYTES` = 64 KiB it received in the last 30 s as `{owner, bytes, at, gotAt}` (owner = the subscription's session id for a `session` channel or a command reply, else `app`). For a frame F, `behindOtherBytes` = Σ bytes of logged frames G with `G.owner ≠ F.owner`, `G.at ≤ F.at`, G arrived before F, and `G.gotAt + offset > F.at` (G was still arriving when F was written); `behindSameBytes` the same with `G.owner = F.owner`, G ≠ F. On a WebSocket `reply`, the same sum is the action's `replyBehindOtherBytes`; an HTTP reply shares the SSE stream's HTTP/2 connection, so the worker computes its `replyBehindOtherBytes` from the EventSource's log (`at` = `repliedAt`) when the tab's sample arrives. Needs a clock: `null` before one exists. Residual asymmetry: a large HTTP reply is not itself logged (the worker sees it only after it arrived), so an SSE frame behind one reads clear where a socket frame behind a large WS reply reads `other`/`same`.
- Uplink: WS `behindBytes` = `ws.bufferedAmount` at send; `behindSameBytes`/`behindOtherBytes` = body bytes of earlier commands on this socket still waiting for their ack, of the same/another session, each capped at `behindBytes`. HTTP: `behindBytes` = `behindSameBytes` = this tab's unanswered POSTs of the same session; `behindOtherBytes` = of other sessions. fetch reports no upload progress and the server's receive time comes only with the response, so a POST counts until answered (even once its body is in, while the server runs it); the summary's 64 KiB floor (below) is what makes HTTP and WS comparable: a small command in flight ahead is never blocking in either.

Derived by the summary: `totalMs = gotAt − sentAt`, `serverMs = repliedAt − recvAt`, `transportMs = totalMs − serverMs` (clock-free), `upMs = recvAt − (sentAt + offset)`, event `ms = gotAt + offset − at`, reconnect `ms = firstFrameAt − startAt`, `fromDropMs = firstFrameAt − dropAt`.

Transport of samples: tabs post samples to the worker (`{op:"metric"}`; never constructs a worker just for that); the worker buffers (cap 2000, oldest dropped and counted) and flushes `POST /api/transport-metrics {samples}` every 30 s or at 200 (in a task of its own, never on the path that recorded the 200th sample, such as a frame's delivery), over HTTP in every mode; a failed POST keeps the buffer. A dedicated worker loses ≤ 30 s of samples when its tab closes. The route accepts ≤ 256 KiB and ≤ 1000 samples, keeps plain objects with a string `metric` (≤ 32 chars) whose JSON is ≤ 4 KiB, and appends JSONL to `<agent dir>/omp-web/transport-metrics.jsonl`, renamed to `.jsonl.1` (replacing it) once over 20 MiB (≤ 40 MiB on disk).

Summary: `bun scripts/transport-metrics.ts [--since 2h|<ISO>] [--until <ISO>] [--client <id>] [--file <path>]` prints, per transport (`sse`, `ws-client`, `ws-session`, `ws-pool`):
- count/p50/p95/max of action `totalMs`, `transportMs`, `upMs` (all and per type);
- event ms per channel and conn kind;
- reconnect ms and `fromDropMs` per trigger family, with mean `batch`, so the rows line up across transports: `error/close` (EventSource `error`; a socket's `close`, `silence`, `hang`: how a socket notices the dead connection an EventSource reports as `error`), `network (type changed)` / `network (same type)` (`effectiveTypeBefore ≠ effectiveType` or not: `navigator.connection` `change` also fires on RTT or downlink drift, when WS redials healthy sockets and SSE does nothing), `online/visible`;
- `isolation event ms` (event ms) and `isolation action ms` (`transportMs`: the server's time differs by command type, not by what the pipe carried), keyed `other` (`behindOtherBytes` or `replyBehindOtherBytes` ≥ 64 KiB), `same` (`behindSameBytes` ≥ 64 KiB), `clear` (every field measured, all below) or `unknown` (a field `null`, e.g. a reply without a clock), the same floor in every transport; and the abort-behind-upload split (`type` starts with `abort`, `behindBytes > 0`);
- `sockets` and `pool size` distributions, `clock offsetRtt` (the RTT of the clock behind each event and action sample: its error bound), and `rebalance` rows per reason (count, p50/p95/max of `moved`, `settledMs`);
- counts of hangs (and how many were answered later), each classified `stalled` (a WS missed ack; an HTTP hang whose action's `transportMs ≥ waitedMs`: the transport alone took the ack formula's time), `slow command` (an HTTP hang the server's time made late) or `unclassified` (an HTTP hang without its action's times); resends (`attempts > 1`), deduped, outcomes;
- a client table (id, samples, effective types, `ua`).

## Properties to measure, not engineer

- **Full duplex.** An upload on a socket (client → server) does not delay incoming events on that socket; it delays later client → server messages on it. Same session: Stop during an image upload (the abort-behind-upload split). Other sessions: in `ws-client` every session shares the pipe, in `ws-pool` the sessions of one bucket do, in `ws-session` none; `isolation action ms` measures it. Downlink: a large frame (a session's snapshot after a resubscribe, a big tool result) delays every later frame on the same pipe, including other sessions' and the SSE stream's; `isolation event ms` measures it in every transport.
- **Connection cost.** Production: the browser reaches omp-web through Traefik (public traffic passes pfSense HAProxy first; LAN and tailnet clients reach Traefik directly). Over an HTTP/2 connection the SSE stream and every request share one TCP+TLS connection. Whether a WebSocket can ride that connection (RFC 8441, WebSocket over HTTP/2) through this chain is **unverified**; if it cannot, every WebSocket is its own HTTP/1.1 TCP+TLS connection: `ws-client` 1, `ws-session` 1 + active sessions, `ws-pool` N ≤ `maxSockets` handshakes per (re)connect. Which one happens is to be checked (for example the request protocol in Traefik's access log), not assumed.
- **Parallel reconnect serializes in the browser.** RFC 6455 §4.1 allows one connection in CONNECTING per host:port; Chromium enforces it (`net/socket/websocket_endpoint_lock_manager`). After a network switch the sockets reconnect "in parallel" but their handshakes queue; per-socket reconnect time vs `batch` shows the cost per mode. Browsers cap WebSockets per profile in the hundreds (not verified here), far above the expected counts.
- **Churn** of `ws-pool` (`rebalance.moved` per change) and the cost of a move (`settledMs`, plus the snapshot it replays, which shows up as cross-session blocking on the new socket).
- Head-of-line blocking of a large prompt on its own socket; per-socket command order; dedicated-worker sockets and pools per tab on Android.

## Limitations

- Socket authorization is checked once at upgrade (D3).
- Settings file edits need a restart (D1).
- WebSocket modes start with one SSE handshake per worker start (D1).
- Command order across a move is kept (D2), except after a WebSocket → SSE → WebSocket round trip while a command is still on a draining socket.
- Two policy changes that return within one round trip (A→B→A) can open a stream twice; its snapshot replays twice (D2).
- Each worker sizes its own pool; two browsers of one user hold two pools.
- HTTP hang samples cannot tell a slow command from a stalled request until the response arrives; the summary separates hangs answered later.
- Downlink blocking attribution depends on the clock offset (± RTT/2) and only counts frames ≥ 64 KiB.
- Bun's WebSocket limits are server-wide (D3).

## Acceptance

1. With the settings absent or `browserTransport: "sse"`, every existing test passes; the only edited assertions are the extended `hello`, the settings object with its new keys, the source-text checks that follow the command code into `lib/agent-command.ts`, and the session binding the upgrade no longer has. The browser opens no WebSocket.
2. Each `PUT` of a transport switches an open browser within 5 s without a reload: `ws-client` holds 1 socket, `ws-session` 1 + one per active session, `ws-pool` between 1 and `maxSockets`; switching between WebSocket modes moves subscriptions make-before-break; `"sse"` switches back.
3. `/api/events/ws` refuses an unauthenticated upgrade (401) and a cross-origin one (403), and outlives Bun's 10 s HTTP idle timeout once upgraded.
4. A command replayed with a known `(session, rid)` runs once; one socket carries several sessions' commands; a non-idempotent command is never sent to a second server process.
5. `ws-pool` grows as soon as the active sessions need it, shrinks only after 30 s below, and a resize moves only the sessions whose top-ranked socket changed.
6. After a network switch on the phone every socket reconnects without user action, and `scripts/transport-metrics.ts` prints `action`, `event`, `reconnect` and isolation rows for every transport in use, plus `rebalance` rows for `ws-pool`, from the production JSONL.
