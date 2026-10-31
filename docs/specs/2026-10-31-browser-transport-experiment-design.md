# Browser transport experiment (SSE + HTTP vs WebSockets) — design

Date: 2026-10-31. Branch: `feat/browser-ws` (stacked on `feat/ws-link`, #347). Plan: `docs/plans/2026-10-31-browser-transport-experiment.md`.
Builds on: AGENTS.md "Live event stream: one socket per browser", "Queued messages are omp-owned", "Running state + reconciliation", "RPC session lifecycle"; `docs/specs/2026-10-31-websocket-link-design.md` (the host link's WebSocket, whose `Bun.serve` `websocket` handler this shares).

## Goal

An A/B experiment for the browser's live transport. Today one SharedWorker (`public/event-stream-worker.js`) holds one SSE stream (`GET /api/events`) carrying every tab's channel frames; subscriptions and every action are HTTP requests. This adds a **WebSocket mode** behind a server-side switch, measures both modes with the same instrumentation, and stores the numbers on the server, so the user can use the phone, switch networks and ask the agent to flip the mode, and the agent compares p50/p95 without the user copying anything.

SSE + HTTP stays the default and keeps working unchanged.

Non-goals: replacing SSE; moving any API besides the agent command path and channel (un)subscribe to the socket; WebSocket compression; working around head-of-line blocking (it is measured); closing a socket when its session cookie is invalidated (limitation below); a metrics UI.

## Decisions

### D1. Two modes, one switch

- Web setting `browserTransport: "sse" | "websocket"` in `omp-web-settings.json` (`lib/web-settings.ts`), default `"sse"`. Anything but `"websocket"` reads as `"sse"`. `GET /api/web-settings` returns it; `PUT /api/web-settings {"browserTransport": …}` validates it (400 `invalid_settings` otherwise). Settings → Interface & Behavior gets a two-option select.
- **Live switch: push.** `PUT` that carries `browserTransport` calls `broadcastBrowserTransport()` (`lib/event-stream-hub.ts`), which writes the control frame `{type:"transport", transport}` on every open connection, SSE and WebSocket. Every `hello` also carries `transport`, so a worker that was disconnected during a flip, or one that just started, converges on its next hello. A worker therefore always starts in SSE mode and switches on the first hello if the setting says otherwise (one wasted SSE handshake per worker start in WebSocket mode; not counted in any metric).
- **Editing the file** works only after an omp-web restart (the settings are cached in `globalThis`, as today); the HTTP call is the supported flip.
- **The agent's flip command** (production, port 30185; the trusted header is the one `pr-watcher` uses, verified: its SHA-256 matches `OMP_WEB_TRUSTED_HEADER_SHA256`; a request without `Origin` skips the origin check):

  ```bash
  curl -sS -X PUT http://127.0.0.1:30185/api/web-settings \
    -H "x-omp-web-auth: $(sed -n 's/^OMP_WEB_TRUSTED_HEADER_SECRET=//p' /opt/omp-deployment/pr-watcher.env)" \
    -H 'content-type: application/json' -d '{"browserTransport":"websocket"}'   # or "sse"
  ```

  The response is the saved settings object; every open browser switches within one round trip.

### D2. Sockets: one general socket plus one per session

In WebSocket mode the worker (same SharedWorker; the dedicated-Worker fallback unchanged, so on Chrome for Android each tab has its own worker and its own sockets) holds:

- **One general socket** `GET /api/events/ws`: the non-session channels (`running`, `notifications`, `host-tools`, `hosts`, `file`) and their subscribe/unsubscribe. It opens with the first such subscription and closes when it has none (as the EventSource does today). No action is session-free on the hot path, so it carries no commands.
- **One socket per session** `GET /api/events/ws?session=<id>`: that session's `session` channel frames **and** that session's agent commands (the `POST /api/agent/[id]` path) with request ids. Opened by the first `session` subscription **or** the first command for that session (useAgentSession sends `get_state`, which starts the wrapper, before it subscribes; AppShell answers host tools of sessions no tab watches). Closed `SESSION_LINGER_MS` = 30 s after it has neither subscriptions nor unanswered commands, so tab switches reuse it. Replies and events of one session are ordered on one socket, and one session's upload never queues behind another session's.
- Expected count: 1 + the sessions open in tabs (plus ones touched by a command in the last 30 s). Background sessions stay on the general socket's `running` channel.
- Everything else stays HTTP in both modes: `GET /api/agent/[id]` (reconcile/state polls, 8 call sites), `POST /api/agent/new`, bash-output, file, settings, the metrics POST and the clock probe.

### D3. Server side

- **Upgrade route** `app/api/events/ws/route.ts`, table key `"events/ws"`. It goes through `handle()` like every gated route, so `proxy()` applies the password gate (session cookie or trusted header) and the API origin check **before** the handler calls `upgrade()`. A request that does not upgrade gets 426; a `session` query longer than 512 chars or empty gets 400. Limitation: the socket stays authorized after logout or a password change until it closes.
- **Socket data** `{ kind: "browser", sessionId: string | null, connection: EventStreamConnection | null }` (`BrowserSocketData`, `lib/browser-socket.ts`). `server/app.ts` composes one `websocket` handler: `ws.data.kind === "browser"` goes to `browserSocket`, anything else to `hostLinkSocket` (unchanged). Bun's limits are per server, so browser sockets inherit the link's `maxPayloadLength` (64 MiB + 256), `backpressureLimit` (16 MiB, close on exceed), `idleTimeout` 120 s and `sendPings`; the browser handler enforces its own frame cap below.
- **One `EventStreamConnection` per socket.** The connection becomes transport-agnostic through a `FrameSink`; `new EventStreamConnection(signal)` keeps building the SSE sink and its `stream` (route and tests unchanged), `new EventStreamConnection(undefined, sink)` serves a socket (`stream` is `null`). Channels, coalescing (`message_update` latest-wins while the peer is behind: SSE `desiredSize < 0`, socket `getBufferedAmount() > 256 KiB`, flushed on `drain`), `end`, and the per-subscription failure isolation are shared code.
- **Shared command function.** `runAgentCommand(id, body, advisor): Promise<Response>` in `lib/agent-command.ts` holds what `POST /api/agent/[id]` does after parsing (type check, `NO_SPAWN_REPLIES`, `LIVE_SESSION_ONLY`, fast path, spawn, cold `set_model`, `commandErrorResponse`). The route parses the body (`parseJsonWithinLimit`, `MAX_AGENT_COMMAND_REQUEST_BYTES`) and the `?advisor=1` query and calls it; the socket handler calls it with the frame's `command` and `advisor` and sends `{status, body: await response.json()}`. One implementation, identical replies.
- **Dedupe.** `globalThis.__ompBrowserCommands: Map<rid, {result: Promise<{status, body}>, expiresAt}>`. A `cmd` whose `rid` is known joins the in-flight promise or replays the settled result (`deduped: true`) instead of running again. Entries expire `DEDUPE_WINDOW_MS` = 120 s after they settle; at most 500 (oldest settled dropped first). Lost on a server restart; D5 never resends a non-idempotent command to a different server.
- **Handler safety.** A throw or rejection in any browser socket handler closes that socket (1011) and is logged; it never reaches `uncaughtException` and never touches host links.

### D4. Wire format

**SSE (unchanged except two additive fields):** every frame gains an `id: <server ms>` line (`event:`, `id:`, `data:`) carrying the emit time; consumers read it as `event.lastEventId` (EventSource sends it back as `Last-Event-ID` on its own reconnects; the server ignores it). `hello` gains `serverId` (random per process) and `transport`. The new `transport` control frame is ignored by an old worker (`handleControl` finds no subscription for it).

**WebSocket, server → client:** text frames `"<name> <server ms>\n<json>"`, split at the first newline without parsing the payload:

| name | payload | meaning |
|---|---|---|
| `mux` | `MuxControlFrame`: `hello {connectionId, serverId, transport}`, `open {sub}`, `end {sub}`, `refused {sub, status, error, code}`, `transport {transport}` | control; `refused` replaces the failed POST answer |
| `s<n>` | the channel payload, exactly as SSE `data:` | one subscription's frame |
| `ack` | `{rid}` | the command frame arrived; `at` = receive time |
| `reply` | `{rid, status, body, deduped?}` | `status`/`body` exactly as the HTTP route answers; `at` = reply time |
| `ping` | `{}` | server heartbeat every `WS_HEARTBEAT_MS` = 10 s |
| `pong` | `{c}` | answer to a client clock ping |

**WebSocket, client → server:** one JSON object per text frame:
`{t:"sub", id, channel}` (id matches `SUBSCRIPTION_ID_RE`, channel through `parseEventStreamChannel`), `{t:"unsub", id}`, `{t:"cmd", rid, advisor, command}` (session sockets only; a general socket answers `reply` 400 `invalid_event_stream_request`), `{t:"ping", c}`. Unparsable JSON or an unknown `t` closes 1007; a frame over `MAX_AGENT_COMMAND_REQUEST_BYTES` + 64 KiB closes 1009 (the worker refuses oversize commands locally with the route's 413 `request_too_large` first, so this is a backstop). `rid` is a string of 1–64 chars.

Per-session order: on the fast path `runAgentCommand` reaches `existing.send()` before its first await, so commands on one session socket reach omp in send order (HTTP gives no such guarantee). Not engineered further.

### D5. Reconnect, liveness and resend (per socket, the same rules for every socket)

- **Heartbeat.** Server `ping` every 10 s. The client answers each `ping` with a clock `ping` (and sends one on `open`). A socket with no frame for `WS_SILENCE_MS` = 25 s is given up: closed, its subscriptions report CONNECTING, it reconnects.
- **Reconnect.** Per socket, backoff 1 s doubling to 30 s, reset by a `hello`. On `hello` the worker re-sends `sub` for every subscription of that socket; channels replay their snapshot on subscribe (the SSE catch-up semantics, reused).
- **Wake.** Tabs forward `online`, `navigator.connection` `change` and `visibilitychange` to the worker (`{op:"wake"}`). `online`/`network`: every socket is closed and reconnected at once, in parallel, no backoff. `visible`: every open socket gets a clock ping; one with no frame within `VISIBLE_PROBE_MS` = 3 s is reconnected; sockets waiting in backoff dial now. In SSE mode wake is only recorded (SSE behaviour unchanged; EventSource keeps its own reconnect).
- **Commands.** Each command carries `rid` (the tab's request id). The worker sends it when its session socket has had its `hello`; a command not sent within `SEND_DEADLINE_MS` = 15 s answers 503 `transport_unavailable` (never left the browser). After sending, an `ack` must arrive within `ACK_TIMEOUT_MS` = 10 000 + bytes / 32 ms (32 KB/s floor for uploads); a miss is a **silent hang**: recorded, the socket is reconnected (trigger `hang`). The reply may take as long as the command takes (compact, bash): only the ack is timed.
- **Resend at most once, on the next socket, same `rid`:**
  - idempotent (`type` starts with `get_`, or `predict_word`): resent;
  - anything else: resent only when the new socket's `hello.serverId` equals the one it was sent under (same process, so the dedupe map holds it; the server joins or replays instead of running it again); otherwise, or on a second loss, it answers 503 `transport_lost` ("the connection dropped before the answer arrived; it may have run").
  - Refinement of the brief's "resend only idempotent commands": with the server's `rid` dedupe and the `serverId` check, resending a non-idempotent command cannot run it twice, and it turns a lost reply on a flaky link into a normal answer instead of an uncertain error.
- **Mode switch.** To SSE: subscriptions move to the EventSource at once; WebSocket sockets stop taking new commands and close when their unanswered commands settle (one that drops meanwhile answers `transport_lost`). To WebSocket: the EventSource closes and every subscription moves to its socket. A `cmd` that reaches a worker in SSE mode (a tab not yet told) is answered `{http: true}`; the tab sends it over HTTP.
- The SSE path keeps its behaviour: no silence detection, no wake action, EventSource's own reconnect, `POST /api/events` subscriptions.

### D6. Measurement (same in both modes, stored on the server)

Clock: offset = `serverNow − (c0 + c1) / 2`, RTT = `c1 − c0`, keep the min-RTT sample per connection (NTP-style). WebSocket: the socket's own `ping`/`pong`. SSE: three sequential `GET /api/transport-metrics` (`{now}`) after each `hello`. Event samples use their connection's clock, or the worker's best one (min RTT over its connections) until the connection has its own, since a resubscribe's snapshot frames can beat the first `pong`; action samples use the worker's best one.

Every sample: `metric`, `transport` (mode), `clientId` (localStorage `omp-web:transport-client-id`), `effectiveType` (`navigator.connection.effectiveType` or `null`), `visible` (any tab of this worker visible); the server adds `serverAt` and `ua` (≤ 200 chars).

| metric | fields | recorded by |
|---|---|---|
| `action` | `req, type, via ("ws"\|"http"), status, outcome ("ok"\|"error"\|"lost"\|"unavailable"), attempts, deduped, bytes, behindBytes, sentAt, recvAt, repliedAt, gotAt, offset, offsetRtt` | tab (`lib/agent-client.ts`), every command. HTTP: `x-omp-received-at`/`x-omp-replied-at` response headers; WS: `ack`/`reply` times |
| `event` | `conn ("sse"\|"general"\|"session"), channel, at, gotAt, offset, offsetRtt` | worker, at most one per connection per second, none before the worker has any clock |
| `reconnect` | `conn, trigger ("error"\|"close"\|"silence"\|"hang"\|"online"\|"network"\|"visible"\|"end"), dropAt, startAt, firstFrameAt, batch` | worker; `startAt` = last wake within 60 s before the drop, else the drop; ends at the first `open` or channel frame after the re-subscribe; `batch` = reconnects started within ±2 s (sockets reconnecting together) |
| `hang` | `req, type, via, bytes, waitedMs` | WS: missed ack (worker); HTTP: the tab's same-formula timer fired before the response (HTTP unchanged otherwise) |
| `dropped` | `count` | worker, when its buffer overflowed |

Derived by the summary: `totalMs = gotAt − sentAt`, `serverMs = repliedAt − recvAt`, `transportMs = totalMs − serverMs` (clock-free), `upMs = recvAt − (sentAt + offset)`, event `ms = gotAt + offset − at`, reconnect `ms = firstFrameAt − startAt`, `fromDropMs = firstFrameAt − dropAt`.

`behindBytes`: WS = the session socket's `bufferedAmount` when the command was sent; HTTP = bytes of this tab's still-unanswered POSTs for the same session. The summary reports abort-family commands (`type` starts with `abort`) split by `behindBytes > 0`: Stop during an image upload.

Transport of samples: tabs post samples to the worker (`{op:"metric"}`; never constructs a worker just for that); the worker buffers (cap 2000, oldest dropped and counted) and flushes `POST /api/transport-metrics {samples}` every 30 s or at 200, over HTTP in both modes; a failed POST keeps the buffer. A dedicated worker loses ≤ 30 s of samples when its tab closes. The route accepts ≤ 256 KiB and ≤ 1000 samples, keeps plain objects with a string `metric` (≤ 32 chars) whose JSON is ≤ 4 KiB, and appends JSONL to `<agent dir>/omp-web/transport-metrics.jsonl`, renamed to `.jsonl.1` (replacing it) once over 20 MiB (≤ 40 MiB on disk).

Summary: `bun scripts/transport-metrics.ts [--since 2h|<ISO>] [--until <ISO>] [--client <id>] [--file <path>]` prints, per transport: count/p50/p95/max of action `totalMs`, `transportMs`, `upMs` (all and per type), event ms per channel and conn, reconnect ms and `fromDropMs` per trigger and conn with mean `batch`; counts of hangs (and how many were answered later), resends (`attempts > 1`), deduped, outcomes; the abort-behind-upload split; and a client table (id, samples, effective types, `ua`).

## Properties to measure, not engineer

- **Full duplex.** An upload on a socket (client → server) does not delay incoming events on that socket; it delays only later client → server messages on it, e.g. Stop during an image upload in the same session. The abort-behind-upload split measures exactly this. Other sessions are unaffected (their own sockets). In SSE mode the abort is a separate HTTP/2 stream through nginx (no queue behind the upload except TCP-level).
- **Connection cost.** nginx speaks HTTP/2 to the browser (`http2 on`), so today the SSE stream and every request share one TCP+TLS connection. nginx has no WebSocket over HTTP/2 (RFC 8441), so every WebSocket is its own HTTP/1.1 TCP+TLS connection through nginx (`snippets/ai-brait-proxy.conf` forwards `Upgrade`, `proxy_read_timeout 1d`): 1 + open sessions handshakes per (re)connect.
- **Parallel reconnect serializes in the browser.** RFC 6455 §4.1 allows one connection in CONNECTING per host:port; Chromium enforces it (`net/socket/websocket_endpoint_lock_manager`). After a network switch, N sockets reconnect "in parallel" but their handshakes queue; per-socket reconnect time vs `batch` shows the cost. Browsers cap WebSockets per profile in the hundreds (not verified here), far above the expected count.
- **Head-of-line blocking** of a large prompt on its own session socket; per-session command order; dedicated-worker sockets per tab on Android.

## Limitations

- Socket authorization is checked once at upgrade (D3).
- Settings file edits need a restart (D1).
- WebSocket mode starts with one SSE handshake per worker start (D1).
- HTTP hang samples cannot tell a slow command from a stalled request until the response arrives; the summary separates hangs answered later.
- Bun's WebSocket limits are server-wide (D3).

## Acceptance

1. With `browserTransport` absent or `"sse"`, every existing test passes; the only edited assertions are the extended `hello`, the settings object with its new key, and the source-text checks that follow the command code into `lib/agent-command.ts`. The browser opens no WebSocket.
2. `PUT {"browserTransport":"websocket"}` switches an open browser within 5 s without a reload: channels resubscribe on 1 general + 1-per-session sockets, chat commands get replies over the session socket; `"sse"` switches back.
3. `/api/events/ws` refuses an unauthenticated upgrade (401) and a cross-origin one (403), and outlives Bun's 10 s HTTP idle timeout once upgraded.
4. A command replayed with a known `rid` runs once; a non-idempotent command is never sent to a second server process.
5. After a network switch on the phone every socket reconnects without user action, and `scripts/transport-metrics.ts` prints `action`, `event` and `reconnect` rows for both transports from the production JSONL.
