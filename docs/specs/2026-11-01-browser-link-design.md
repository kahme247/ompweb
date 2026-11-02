# Browser link: one WebSocket per browser, built like the host link — design

Date: 2026-11-01. Branch: `feat/browser-link` (on `feat/delta-stream`, #361).
Builds on: `docs/specs/2026-10-31-websocket-link-design.md` (D3, D6, D7: the host link's sequencing, pieces, fair queues and unacked window), `docs/specs/2026-10-28-remote-hosts-design.md` ("Link protocol").
Replaces: the WebSocket modes of `docs/specs/2026-10-31-browser-transport-experiment-design.md` (`ws-client`, `ws-client-split`, `ws-session`, `ws-pool`; its D2–D5). Its measurement (D6) stays, reduced to two transports.

## Why

Measured with the experiment's modes: a command's `ack` queued behind event frames already in the socket, the 10 s ack timer then declared a healthy socket dead, the redial replayed every subscription's snapshot (more backlog), and the command answered `transport_lost` ("may have run") although it always ran exactly once. The host link solved the same problems (D7 of the WebSocket link spec). The browser now gets the same machinery, so both links that carry user ↔ omp traffic share one set of guarantees.

## Decisions

### B1. One socket, one setting

- `browserTransport: "sse" | "ws"` in `omp-web-settings.json`, default `"ws"`. A missing value or any other stored value (the experiment's `ws-client`, `ws-client-split`, `ws-session`, `ws-pool`, `websocket`, …) reads as `"ws"`; only a stored `"sse"` keeps SSE. `browserTransportPerSocket`/`browserTransportMaxSockets` are gone (dropped on the next save). `PUT /api/web-settings` accepts only the two values. The live switch is unchanged: a changed setting broadcasts `{type:"transport", transport}` on every connection, and every hello carries it.
- In `"ws"` the SharedWorker (dedicated Worker where SharedWorker is missing) holds **one** WebSocket, `GET /api/events/link`, for everything: every tab's subscriptions (session, running, notifications, host-tools, hosts, file) and every agent command and reply. No second socket: pieces and fair per-key queues keep a small message from waiting behind a large one.
- SSE stays the fallback (B7) and an explicit choice in Settings. Reconcile polls, `POST /api/agent/new`, files, settings and the metrics POST stay HTTP in both modes.

### B2. Reuse boundary

The browser link uses the host link's primitives from `lib/hosts/link-protocol.ts` (pure, no I/O; the worker bundles it):

| Piece | Use |
|---|---|
| `LINK_LIMITS.pieceBytes` (256 KiB), `unackedBytes` (512 KiB), `pingMs` (15 s), `offlineMs` (30 s), `flushMs` (16 ms) | same values, both directions |
| `LinkSender` | per-key FIFO, round-robin, one unit (a whole line ≤ 256 KiB or one `part`) per turn, lines numbered as they go out, one key at a time part-way through a line |
| `PartJoiner` | joins `part`s; gains a `maxChars` constructor argument (default `maxLineBytes`, so the host link is unchanged) because a browser command is up to 8 MiB plus its envelope |
| `SeqWindow`, `Outbox` | dedupe by `seq`, keep sent lines until acked, resend after a reconnect |
| `withSeq`, new `queuedLine(json)` | a JSON object's text as a line `LinkSender` numbers (`encodeQueued` stays the host's typed variant) |

The pacing loops stay per endpoint, as hub and daemon already differ: the server mirrors the hub's `flush` (Bun `send` → `-1` → `drain`), the worker mirrors the daemon's (`bufferedAmount` under 2 pieces, polled every `flushMs`). No host link code path, message or test changes. Risk: these two loops are copies, so a fix to the hub's or the daemon's loop (window accounting, the resend from `sentSeq`, drain handling) must be carried over by hand; `lib/browser-link.integration.test.mjs` runs the real worker against the real server end to catch a divergence that breaks delivery.

### B3. Wire format

Text frames only; one line per frame, both directions. Messages are JSON objects keyed by `type`; sequenced ones end with `"seq":N}` (numbered by `LinkSender`). A line over `pieceBytes` goes as `part {seq, at, end, data}` lines, exactly as on the host link.

Browser → server:

| Message | Seq | Key | Meaning |
|---|---|---|---|
| `hello {v: 1, token, ack}` | no | — | first frame of every socket; `token` null on a fresh start; `ack` the highest down `seq` applied |
| `ack {ack}` | no | — | highest down `seq` applied, sent within `flushMs` of applying, at once past a piece of applied data |
| `ping {c}` | no | — | clock ping (on open and in answer to every server `ping`); also liveness |
| `sub {id, channel}`, `unsub {id}` | yes | subscription id | (un)subscribe, as `POST /api/events` |
| `cmd {rid, session, advisor, command}` | yes | `cmd:<session>` | an agent command; `command` is the tab's JSON body, embedded unparsed by the worker |

Server → browser:

| Message | Seq | Key | Meaning |
|---|---|---|---|
| `welcome {v, token, serverId, resumed, ack}` | no | — | answer to `hello`; `ack` the highest up `seq` applied |
| `ack {ack}` | no | — | after every applied frame |
| `ping {at}` | no | — | every `pingMs` |
| `pong {c, at}` | no | — | answer to a clock ping |
| `e {name, at, data}` | yes | subscription id (`mux` frames: their `sub`, else `mux`) | one `EventStreamConnection` frame, exactly what SSE writes as `event: name / id: at / data: data`; `data` is the raw frame JSON |
| `reply {rid, status, recvAt, at, deduped, data}` | yes | `cmd:<session>` | a command's answer; `data` the route's JSON body, `recvAt` when the `cmd` was applied, `at` when the reply was queued |

`data` is always the last field before `seq`, so the worker reads the header with one small `JSON.parse` and passes `data` on as the substring it is (no parse of a large snapshot in the worker, as with SSE). A `part` line is parsed whole (≤ 256 KiB).

Close codes: 1000/1001 from the browser end the link at once (it is done with it: nothing left to carry, a switch to SSE, the worker going away); any other close keeps it for a resume (the worker's own redial uses 4000). From the server: 1007 malformed frame, 1008 first frame not a `hello` or no `hello` within `helloMs` = 10 s of the upgrade, 1009 frame over `pieceBytes`, 1011 handler failure, 4409 replaced by a newer socket of the same link, 4410 link gone (its backlog or the process-wide budget), 4426 `hello.v` not 1.

Frame size: Bun's `maxPayloadLength` is per server, and the host link needs `blobBytes` + 256 (64 MiB) while it accepts v4 daemons, which send a large result as one binary frame. So Bun still buffers a browser frame up to 64 MiB before `lib/browser-link.ts` closes it 1009 for being over a piece. Only authenticated browsers reach the upgrade, and the hello deadline bounds how long a socket that never says hello stays open. Lowering the limit waits for dropping v4 (`MIN_LINK_PROTOCOL_VERSION` 5: every v5 frame is at most a piece plus its header).

### B4. Delivery, as on the host link

- **Sequenced both ways, acked, resent.** Each side keeps sent lines in its `Outbox` until acked; after a reconnect it resends what is past the peer's `ack` (from `hello`/`welcome`), in order, inside the window, before anything new; the receiver drops a `seq` it already applied.
- **Control bypasses the queues:** `hello`, `welcome`, `ack`, `ping`, `pong` go at once, never behind queued lines.
- **Pieces and fairness:** `LinkSender` per direction. Keys: a subscription's frames under its id; a session's commands (up) and replies (down) under `cmd:<session>`; `mux` hello/transport frames under `mux`. A command reply waits behind at most the window plus one piece per busy key, never behind a whole snapshot. **A session's commands stay in order, Stop included:** a Stop never overtakes the prompt it is meant to stop (if it did, it would reach omp first, find nothing running, and the prompt would then start anyway). Its wait is only that prompt's upload; other sessions' traffic never holds it back.
- **Window:** each side sends sequenced lines only while less than its window is sent and unacked; the server also stops when Bun reports backpressure and continues on `drain`; the worker also while `bufferedAmount` ≥ 2 pieces (polled every `flushMs`). The worker's window is `unackedBytes`. The server's follows the link: each second of busy time (lines in flight) sizes it to 1 s of the ack rate over it, between 64 KiB and `unackedBytes`; only a stretch in which the window or Bun's backpressure held queued lines back resizes it (otherwise the rate is the browser's traffic, not the link's; on a slow link the kernel buffer fills before 512 KiB is unacked, so backpressure must count too). Every byte in the window is ahead of a reply on the same TCP connection, so a fixed 512 KiB made a reply wait about 10 s at 3G speeds under load (the 2026-11-01 lab); 1 s of the link bounds that wait while keeping a full window on fast links.
- **Liveness from ping/pong only.** The server pings every 15 s; each side drops the socket after 30 s without any frame. The server also closes a socket that holds unacked bytes and gets no ack that frees any for `ackMs` = 120 s (pings alone do not count): the link detaches and stays resumable. An honest browser acks after a whole message arrives, so a link slower than about 17 kbit/s (2.2 KB/s) cannot finish a 256 KiB piece before the deadline. Nothing else declares a socket dead: a command waiting for its reply (or an ack arriving late) never redials. Wakes keep the experiment's rules: `online`/`network` redial at once, `visible` sends a clock ping and redials if no frame arrives within 3 s. `online`/`network` also reset the dial backoff to 1 s: the dial at link-up often fails while the route settles, and with the delay grown by the outage's failed dials the next one came 16 s later (28.5 s from drop to first frame in the lab).
- **Coalescing:** the link's `EventStreamConnection` sink reports backpressure while the socket is gone or the sender has unsent lines; `message_update`s then merge as on SSE (`queueUpdate`), and every `ack` (`resume()`) flushes the merged ones. Coalesced frames are never numbered, so the resend never repeats a stale one.

### B5. Resume and resync

- **Identity.** On a `hello` with `token: null`, an unknown token, or a token whose owner is not this socket's web session, the server creates a new link: a fresh token (32 random bytes, base64url), a new `EventStreamConnection`, both sequence counters at 0, `welcome {resumed: false}`. A token presented by another web session is never resumed and its link is left alone.
- **Owner:** SHA-256 of the session cookie (`omp_web_session`) when there is one; `trusted` for a trusted-header request without it; `open` when no password is set. Checked at upgrade time (the gate already ran) and stored on the socket.
- **Resume.** A known token from the same owner reattaches the link to the new socket (an older socket still attached is closed 4409): the server trims its outbox by `hello.ack`, resends from there and answers `welcome {resumed: true, ack}`; the worker trims by `welcome.ack` and resends its own. Subscriptions stay open on the server throughout, so nothing is re-subscribed and no snapshot is replayed: the tabs see nothing (no `error`, no second `open`), only the frames they missed, once.
- **Gap gone → resync.** The server drops a link when its socket has been gone for `LINK_RESUME_MS` = 2 min, when its backlog (outbox plus unsent lines) passes `backlogBytes` = 32 MiB (the socket, if any, closes 4410), when the backlog of every link together passes `totalBacklogBytes` = 256 MiB (the links whose sockets have been gone longest go first; an attached link is left to its own cap, but its socket closes after `ackMs` of unacked bytes with no ack that frees any, which detaches the link and puts it under this budget), or when the server restarts (links live in memory). The next `hello` then gets `resumed: false`, and the worker resyncs: its counters, `LinkSender`, `Outbox` and `PartJoiner` start over, every open tab stream gets `error` CONNECTING, every subscription is sent again, and the channels answer with fresh snapshots (`open`, then the channel's own replay), exactly like an SSE reconnect. The delta/fence logic is untouched: a resumed link delivers the same frames in the same order; a resync is a new subscription. A resuming `hello.ack` past what the server sent is clamped to what it sent.
- **Commands.** The tab's request id is the `rid`; a resend always carries the same `rid`. On resume the outbox resend delivers each `cmd` once (`seq` dedupe). On resync the experiment's rules hold: a command that never fully left the browser is sent again; one that did is sent again if it is idempotent (`get_*`, `predict_word`, and the commands repeatable by nature: `predict_word_feedback`, `set_host_tools`, `set_host_uri_schemes`, which register or record the same thing again; `isIdempotentCommand`, shared by worker and server; never `abort`, whose resend could stop a prompt that ran after it), or if `welcome.serverId` is the one it was sent to and its first send was less than `COMMAND_DEDUPE_MS` = 10 min ago (the first: the server's entry expires 10 min after the first run, so a later resend does not restart the clock), where the server's `(session, rid)` dedupe answers a repeat from the first run (`deduped: true`); anything else answers 503 `transport_lost` ("may have run"). Idempotent commands bypass the dedupe map (running one again is harmless, and they would only take room from commands that change something, and be refused at the cap). The dedupe window grew from 120 s to 10 min so it outlives the 2 min resume TTL with room. A command not sent within 15 s while no socket is up answers 503 `transport_unavailable`; one waiting behind other lines on a live socket waits.
- **Command limits.** The server answers a `cmd` whose `command` is over the HTTP route's body cap (`MAX_AGENT_COMMAND_REQUEST_BYTES`, 8 MiB of UTF-8; the worker checks first, and the server checks a joined line again because its cap, in characters, leaves room for the envelope) 413 `request_too_large`. It remembers at most `DEDUPE_MAX` = 500 commands for a resend, none forgotten before its `COMMAND_DEDUPE_MS`: a command that changes something arriving when 500 are remembered and none has expired is answered 429 `too_many_commands`. Neither answer runs the command or is remembered.

### B6. Worker from TypeScript

- `lib/event-stream-worker.ts` replaces `public/event-stream-worker.js`; it imports `lib/hosts/link-protocol.ts` and `lib/event-stream-protocol.ts`.
- `buildEventStreamWorker(root)` (`server/client-env.ts`) bundles it with `Bun.build` (`target: "browser"`, `format: "iife"`, minified); `scripts/build-client.ts` writes it to `dist/event-stream-worker.js`, and the dev server serves the same bundle from memory at `/event-stream-worker.js`. The URL keeps its content hash: `OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION` is the SHA-256 (12 hex) of the bundle, so a changed worker gets a fresh SharedWorker.
- Browser code rules hold for the bundle (no `AbortSignal.timeout`, `AbortSignal.any`, `Promise.withResolvers`); a test builds the production bundle and checks it. The worker tests run the same source, bundled unminified, in `node:vm` with fake browser globals.

### B7. Fallback to SSE

A dial whose socket closes before `open` is diagnosed with a plain `GET /api/events/link` (the host daemon's D2 pattern): a network error, 401, 502, 503 or 504 (offline, signed out, restarting, or a proxy whose upstream is down) redials with backoff (1 s doubling to 30 s). Any other status (426: a proxy dropped the upgrade; 404/400: a server without the route) is a refusal, but a healthy server answers a plain GET 426 too, so one refusal cannot tell a proxy that strips `Upgrade` from a dial that failed for a network reason just as the network came back (measured: a 10 s flap whose dial failed at link-up put the browser on SSE for 5 min, 2 of 2 runs). So the worker falls back only after `FALLBACK_REFUSALS` = 3 refusals in a row: any open resets the count, and a dial that failed while `navigator.onLine` was false, or whose GET got no answer or a status above, does not count. Then it switches to SSE for `FALLBACK_MS` = 5 min, and tries the socket again if the setting is still `ws`. A close 4426 falls back at once. Falling back is a mode switch: streams move to the EventSource, unsent commands go back to the tab as `{http: true}` (it POSTs them), sent ones answer `transport_lost` at once (they may have run; no link is up to carry their replies), except an idempotent one, which goes back as `{http: true}` like an unsent one.

### B8. Metrics

`/api/transport-metrics` and `scripts/transport-metrics.ts` keep working for both modes. Samples carry `transport` (`sse` or `ws`, the mode in effect), `socket`/`conn` (`sse`, `link`, `http`, `worker`) and `sockets`. `pool`, `rebalance` and the WebSocket `hang` (a missed command ack: there is no ack timer any more) are gone; the tab's HTTP `hang` stays. `action` samples over the link take `recvAt` and `repliedAt` from the `reply`; `behindBytes` is what the link held ahead of the command when it was queued (unsent plus unacked), split into same/other session commands. A `reconnect` sample gains `resumed`; it ends at the `welcome` on resume, at the first `open` or stream frame after a resync; the summary adds a `reconnect resumed` row (yes/no counts).

## What is deleted

`lib/browser-socket.ts` (+ test), `app/api/events/ws/`, `public/event-stream-worker.js`, the `ws-*` values and pool settings (UI, route, locales en/ja/zh-CN), socket-key policy, moves, rendezvous pool, per-socket ack timers, `rebalance`/`pool` metrics and their summary rows, and their tests and docs (AGENTS.md "WebSocket transports (experiment)").

## Limitations

- A socket stays authorized after logout until it closes (checked at upgrade, as before).
- Bun buffers a browser frame up to the host link's 64 MiB `maxPayloadLength` before the handler refuses it (see "Frame size").
- A notification routed to a tab whose link then resyncs is not shown there.
- One line to the browser is at most 512 parts (128 MiB), the `PartJoiner` cap.

## Acceptance

1. `npm run typecheck && npm run lint && npm test` and `npm run build` pass; no `ws-client|ws-session|ws-pool|events/ws|browser-socket` outside `docs/` and `CHANGELOG.md`.
2. Tests (each written failing first): a command reply passes a large event backlog on a slow peer; a late ack does not reconnect; resume resends exactly the missed frames (no duplicates, no re-subscribe); resync with fresh subscriptions after TTL, overflow and server restart; a token from another web session is refused; a resent duplicate command runs once; a missing or old stored setting value reads as `ws` and only `sse` reads as `sse`; the worker bundle has no forbidden APIs; a failed upgrade falls back to SSE.
3. Real smoke: headless Chromium, two tabs, `ws` mode, real omp: a socket killed mid-stream resumes and the reply completes once and matches the stored session; commands sent during the drop are answered once; SSE mode still works.
