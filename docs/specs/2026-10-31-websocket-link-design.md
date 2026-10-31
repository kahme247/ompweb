# WebSocket host link — design

Date: 2026-10-31. Branch: `feat/ws-link` (base `51e40f47`, on `feat/bun-runtime`). Plan: `docs/plans/2026-10-31-websocket-link.md`.
Builds on: `docs/specs/2026-10-28-remote-hosts-design.md` ("Link protocol"), `docs/specs/2026-10-29-local-daemon-design.md`, `docs/specs/2026-10-30-bun-runtime-design.md`.

## Goal

The `ompweb host` daemon and the web server talk over **one WebSocket per host** at `/api/hosts/link`, instead of today's three HTTP legs (hello/uplink POSTs, the NDJSON downlink GET, and blob POSTs to `/api/hosts/link/blob/<reqId>`). Message shapes, `seq`/`ack`/resend, the hello's replay of open requests, adoption, orphans, the freeze at shutdown and the per-host single link all keep their meaning. The HTTP legs, the blob route and the never-released v2 compatibility code are deleted.

Why: one socket removes the hello-offer handshake, the per-POST nonce/409 rule, the blob leg and the per-request idle-timeout lift; the link gets one liveness signal and one ordering.

Non-goals: compression (`perMessageDeflate` stays off), an update-only mode for old daemons, HTTP proxy support for the daemon (unchanged: Node's `fetch`/`WebSocket` ignore `HTTP(S)_PROXY`, as today), moving the daemon to Bun, any change to `/api/events` or browser-facing streams.

## Decisions

### D1. Transport

- One WebSocket per host, dialed by the daemon: `ws://` or `wss://` + the host's saved server URL + `/api/hosts/link` (the daemon swaps `http`→`ws` in its link URL). The reverse proxy must forward `Upgrade`/`Connection` (ai-web.brait.dev: `snippets/ai-brait-proxy.conf` sets `proxy_http_version 1.1`, `Upgrade $http_upgrade`, `Connection $pfb_connection_upgrade`, `proxy_read_timeout 1d`; verified).
- **Text frames** carry the existing JSON messages: hub → daemon one message per frame; daemon → hub one or more newline-separated messages per frame (the uplink batch, still flushed every 16 ms or at 256 KB).
- **Binary frames** carry what the blob leg carried: the bytes of one large op result, daemon → hub only, sent before the `res` that names them (one socket keeps that order).
- Deleted, no fallback: the hello POST, the downlink GET, uplink POSTs, `POST /api/hosts/link/blob/[reqId]` and its route file.

### D2. Auth and client

- **Auth before upgrade.** The link route runs in `Bun.serve` `routes` with `proxy.ts` reporting it `"public"` (ungated, no origin check). `handleLinkUpgrade` checks `Authorization: Bearer <host token>` first: 401 when no host matches, 503 when the registry cannot be read (never 401, as today), 503 while the server is frozen; only then `server.upgrade(req, { data })`. An authenticated request that does not upgrade gets 426 `{error}`. An unauthenticated upgrade never reaches the password gate's 307 and never gets a socket.
- **The token is checked once per socket.** Revoke already closes the link (`closeHostLink` from `DELETE /api/hosts`); the only token rotation (the local token in `ensureLocalHostLink`) happens at web-server startup, where every socket is new.
- **Client: the runtime's built-in `WebSocket` with `{ headers: { authorization } }`.** Node 24.0.0 (the `engines` floor), 24.19.0 and 26.8.1, and Bun 1.4.4 all send the header (probe below). So the **daemon stays on Node** in npm installs (Node + jiti, unchanged launch path) and runs on Bun in the compiled binary; the same `daemon.ts` code serves both. No `Sec-WebSocket-Protocol` token, no new dependency.
  - Running the daemon under Bun was rejected: it would not remove `jiti` (the tray loads `lib/windows-service.ts` through it), and every supervisor-started daemon (systemd `ompweb-host`, launchd `com.kahme247.ompweb-host` via `npx … host`, Windows `omp-web-host.ps1` running `node.exe omp-web.js host`, the Linux tray) would need a Node→Bun hop, which `bin/omp-web.js` deliberately avoids ("a supervisor's SIGTERM must reach the daemon, not a wrapper"). **Windows changes: none** (no script, task or tray change).
- **Refusal diagnosis.** Node's `WebSocket` exposes no HTTP status for a refused upgrade (24.0.0: close 1002 "Received network error or non-101 status code."; 24.19/26.8: an empty error, close 1006); Bun's puts it only in an error message ("Expected 101 status code: 401"). So when a dial closes **before `open`**, the daemon sends one plain `GET /api/hosts/link` with the same `Authorization` and acts on its status: 401 → today's revoke/re-key logic (host.json holds a newer token for this server → use it; else stop every omp child and exit 1); 503 → redial; anything else (426 from a current server whose upgrade a proxy broke, 400 from an older server, a network error) → log it with the hint below and redial with backoff.

### D3. Reliability

- **`seq`/`ack`/resend stays.** A socket drop is a link drop: each side keeps unacked sequenced messages, resends them after the next `welcome`, and drops a `seq` it already applied. The `ack` header and the POST answer become an unsequenced `ack {ack}` message:
  - daemon → hub: the first line of every uplink frame is `ack` with the highest downlink `seq` the daemon applied;
  - hub → daemon: after applying an uplink frame the hub answers exactly one `ack` with the highest uplink `seq` it applied.
- **Flow control, daemon side: one uplink text frame in flight.** The daemon sends the next frame only after the hub's `ack` for the previous one (the old one-POST-at-a-time rule). A drop clears the in-flight state; everything unacked goes again after the next `welcome`.
- **Hello.** The daemon's first text frame on a new socket is its `hello` (unchanged shape: `v`, `ompVersion`, `platform`, `home`, `autoApproveExtension`, `ack`, `channels[{ch, sessionId, cwd, pending}]`). The hub checks `v`, applies the hello (replace an older socket, reattach/adopt/kill, resend the outbox) and sends `welcome {v, hostId}`. `welcome.nonce`, the hello offer/`helloId` and the 409 rule are gone: a frame belongs to the socket it arrived on, and the hub ignores frames from a socket that is no longer the host's link.
- **Replaced link.** A hello on a new socket of the same host closes the previous socket with **4409** "replaced". The `replaced` down message is deleted. A daemon that gets 4409 on its current socket logs "another ompweb host linked with this token; exiting" and exits 0. A daemon ignores every event from a socket it has already given up (its watchdog fired), so a late 4409 never stops a daemon that already redialed.
- **Shutdown freeze.** `freezeHostLinks()` sets `frozen`, closes every link socket with **1001** "omp-web is restarting", and from then on the hub sends nothing, applies nothing and answers new upgrades 503. The daemon keeps its output unacked and redials (503 → backoff, loopback capped at 3 s) until the next server takes the hello and adopts the children. Pending host ops on the closed sockets fail at once (503 `host_offline`), as when a downlink ended.
- **Liveness.** The app-level `ping`/`pong` (hub pings every 15 s; each side drops the link after 30 s without a frame) stays, because the WebSocket client API exposes no ping/pong frames to the daemon and the hub needs the 30 s offline flip for status and op failures. Bun's own `idleTimeout` (120 s) and `sendPings` stay at their defaults underneath. The HTTP idle lift for the link (`disableIdleTimeout`) goes away: after `server.upgrade()` Bun's 10 s HTTP `idleTimeout` no longer applies (probe: a silent socket stays open 12 s on a server with `idleTimeout: 10`).

### D4. Versioning

- `LINK_PROTOCOL_VERSION = 4` and `MIN_LINK_PROTOCOL_VERSION = 4` (both literal, one line each: the deploy script parses them with `sed`). v4 = "the link is one WebSocket: text frames carry the messages, binary frames large results, `ack` messages replace the ack header and the POST answer; `replaced` and `welcome.nonce` are gone". Dropping v3 is the explicit decision the policy asks for; v2/v1 acceptance code is deleted. The rules in remote-hosts "Protocol versions and compatibility" (compatible changes only within a released version, keep N-1 from the next bump on, web first) stay as written apart from the version history.
- **Version check on the hello frame.** A hello whose `v` is outside `MIN..current` (checked on the raw JSON before decoding, as today) gets close **4426** with reason `{"serverVersion":4}`; Settings shows "needs upgrade (host vN, server v4)" unless the host has a healthy socket. The daemon reads `serverVersion` from the reason and logs, as today, either "update ompweb on this host" or "this host's ompweb is newer than the server's: update ompweb on the server", then exits 1.

### D5. Daemons from before the WebSocket (v3 builds, e.g. the user's Mac)

- A v3 daemon POSTs its hello to `/api/hosts/link`. That POST stays as a refusal only (`handleOutdatedLinkPost`): bearer check (401/503 before the body is read), then the body's `v` (body read up to `uplinkBytes`, parse failures give `hostVersion: null`) through the same `versionMismatch`, answered **426** `{error, hostVersion, serverVersion: 4}`. The v3 daemon's own logic then logs "the server speaks a different link protocol: update ompweb on this host" and exits 1. Without the POST it would get 405 and log the opposite advice ("the server runs an older ompweb").
- A v4 daemon dialing a v3 server: the old server answers the upgrade 400 ("Unknown or expired hello"); the diagnosis GET sees 400 and the daemon logs "the server did not accept the WebSocket upgrade (HTTP 400): check that a reverse proxy forwards Upgrade and Connection, and that the server runs an ompweb at least as new as this host's", then keeps redialing (backoff to 60 s), so it links once the server is updated.
- **Upgrade order: web first, then hosts.** This machine: `ompweb-deploy` restarts `ompweb-api`, then `switch_daemon` sees the running daemon's protocol 3 outside the new release's `4..4` and restarts `ompweb-host` (ending its runs; auto-resume picks interrupted runs up). The Mac: update ompweb there (`npm i -g @kahme247/ompweb` or the new binary) after the server; until then it shows "needs upgrade".

### D6. Limits and backpressure

| Limit | Value | Where |
|---|---|---|
| Uplink text frame | `LINK_LIMITS.uplinkBytes` 16 MiB (UTF-8 bytes) | the daemon's batch cap; the hub closes **1009** above it |
| Single message line | `LINK_LIMITS.maxLineBytes` 8 MiB | unchanged (`encodeLine`/`parseLine`); an over-limit stdout line still becomes `resync` |
| Binary frame payload | `LINK_LIMITS.blobBytes` 64 MiB + header | daemon refuses a larger result with `413 result_too_large` (unchanged); the hub's `maxPayloadLength` is `blobBytes + 256`, so Bun closes 1009 above it |
| Hub send buffer | `backpressureLimit` 16 MiB (`LINK_LIMITS.uplinkBytes`), `closeOnBackpressureLimit: true` | a daemon that stops reading gets its socket closed instead of the hub buffering on; unacked sequenced messages stay in the outbox and go again after the redial, so a dropped frame is never followed by a later `seq` on the same socket |
| Daemon in flight | one uplink text frame; result frames as produced | per-channel backlog still capped at 8 MB with `resync` (unchanged) |

Browser-facing streams (`/api/events` SSE) are outside this change; their buffering is unchanged.

## Wire format

### Upgrade

```
GET /api/hosts/link HTTP/1.1
Upgrade: websocket            (plus the standard WebSocket handshake headers)
Authorization: Bearer <host token>
```

| Request | Answer |
|---|---|
| no or unknown bearer token (upgrade or not) | 401 `{error: "Invalid host token"}` |
| host registry unreadable | 503 (never 401: a daemon told 401 stops its children) |
| server frozen (shutting down) | 503 `{error: "omp-web is shutting down"}` |
| valid token, not an upgrade (`server.upgrade` returns false) | 426 `{error: "The host link is a WebSocket"}` |
| valid token, upgrade | 101; socket data `{hostId, hello: false}` |
| `POST /api/hosts/link` (a v3 daemon's hello) | 401/503 as above, else 426 `{error, hostVersion, serverVersion}` |

### Messages (v4)

Unchanged from v3 unless marked. `seq` is per direction on every message except `hello`, `welcome`, `ack`, `ping`, `pong`.

| Message | Direction | v4 change |
|---|---|---|
| `hello {v, ompVersion, platform, home, autoApproveExtension, ack, channels[{ch, sessionId, cwd, pending}]}` | up | first text frame of a socket, alone |
| `welcome {v, hostId}` | down | **no `nonce`** |
| `stdin {ch, line}`, `kill {ch, force}`, `req {id, op, args}` | down | — |
| `stdout {ch, line}`, `stderr {ch, chunk}`, `exit {ch, code, signal}`, `resync {ch}` | up | — |
| `res {id, ok, result \| error}`; `res {id, ok: true, blob: {bytes}}` | up | the bytes arrive earlier in a binary frame |
| `ack {ack}` | both | **new**, unsequenced; up: first line of every frame; down: one per applied uplink frame |
| `ping` / `pong` | both | — |
| `replaced` | down | **deleted** (close 4409) |

Receivers keep tolerating unknown types (skipped, `seq` applied and acked) and log them as today.

### Binary frame

```
byte 0        n = UTF-8 byte length of the request id (1..255)
bytes 1..n    request id (the `req.id` the result answers)
bytes n+1..   the result: media bytes for readMedia, else the UTF-8 JSON of the result
```

`encodeBlobFrame(id, bytes)` / `decodeBlobFrame(frame)` in `lib/hosts/link-protocol.ts`; decoding never copies the payload. The hub stores the bytes on the pending op with that id; a frame for an unknown or already-filled id is ignored (the matching `res` then fails `host_blob_missing` if its op still waits). The hub never sends a binary frame and the daemon ignores one; a binary frame before the socket's hello closes 1008.

### Close codes

| Code | Sent by | When | Daemon reaction |
|---|---|---|---|
| 1000 | hub | revoke (`closeHostLink`) | redial → refused 401 → diagnosis → stop children, exit 1 |
| 1001 | hub | `freezeHostLinks` | redial with backoff |
| 1007 | hub | an uplink frame with a malformed line or a bad envelope (`seq` outside the safe integers, …): nothing in it is applied | log, redial, resend (as a 400 batch did) |
| 1008 | hub | first frame binary, not JSON, or (its `v` accepted) not a decodable `hello`; a first frame with no valid `v` gets 4426 instead | log, redial |
| 1009 | hub (or Bun) | text frame over `uplinkBytes`, frame over `maxPayloadLength` | log, redial |
| 4409 | hub | a newer socket of this host said hello | exit 0 |
| 4426 | hub | hello `v` outside `MIN..current`; reason `{"serverVersion":N}` | log which side to update, exit 1 |
| any, before `open` | — | refused upgrade or network error | diagnosis GET (D2) |
| 1006 / other | — | drop, watchdog | redial with backoff |

The hub terminates (no close frame) when its offline timer fires; the daemon closes and forgets a socket when its watchdog fires.

## Code shape

- `lib/hosts/link-protocol.ts`: v4 constants, `LINK_CLOSE`, the `ack` message, the blob frame codec; `LINK_HELLO_HEADER`, `LINK_ACK_HEADER`, `LINK_NONCE_HEADER`, `replaced`, `welcome.nonce` and the v2 decoding deleted.
- `lib/hosts/hub.ts` (server end, no `Bun.*` reference, like every `lib/hosts` module): exports `LinkSocketData`, the structural `LinkSocket` (`data`, `send`, `close`, `terminate` — what Bun's `ServerWebSocket` has, so tests drive the hub with a plain object), `handleLinkUpgrade(req, upgrade)`, `handleOutdatedLinkPost(req)` and `hostLinkSocket` (Bun's `websocket` handler: `message`, `close`, `maxPayloadLength`, `backpressureLimit`, `closeOnBackpressureLimit`). A link holds `socket: LinkSocket | null` instead of `stream` + `nonce` + `helloOffer`.
- `server/app.ts`: `Bun.serve({ websocket: hostLinkSocket })`; the route context gains `upgrade(data)` (= `server.upgrade(request, { data })`); a handler that upgraded returns `undefined`, which `dispatch` and `handle` pass through without `finalizeResponse` or the idle-timeout restore. `disableIdleTimeout` stays for the SSE and file streams.
- `app/api/hosts/link/route.ts`: `GET` → `handleLinkUpgrade`, `POST` → `handleOutdatedLinkPost`. `app/api/hosts/link/blob/[reqId]/route.ts` and its `server/routes.ts` entry are deleted; `proxy.ts` `UNGATED` exempts exactly `/api/hosts/link` (no subpaths).
- `lib/hosts/daemon.ts`: a dial loop around `new WebSocket(url, { headers })`, the diagnosis GET, frame flush with one frame in flight, blob frames; the `fetch` option, `readLines`, the nonce/409/426-HTTP/"older main" branches, `posting`/`backingOff`/`postDelay` and `uploadBlob`'s retry loop are deleted.

## What is deleted

| Surface | Hits at `51e40f47` (code + tests + docs) |
|---|---|
| HTTP-leg code: `LINK_HELLO_HEADER`/`LINK_ACK_HEADER`/`LINK_NONCE_HEADER`, `x-omp-web-*`, `helloOffer`/`helloId`, `handleLinkGet`/`handleLinkPost`/`handleHelloPost`/`openDownlink`, `currentLink`/`staleLink`/`forgetLink`, `nonce`, `readLines` | 172 in 13 files |
| Blob leg: `handleLinkBlob`, `uploadBlob`, `link/blob`, `blob_upload_failed`, the blob route and table entry | 41 in 13 files |
| `MIN_LINK_PROTOCOL_VERSION = 2` and v2/v1 acceptance (`v === 2`, `channels(o, v2)`, `legacyHelloVersion`) | 14 + 25 hits |
| `disableIdleTimeout` for the link | 17 code hits (hub 8, link routes 8, integration test 1) |
| `replaced` message and the 409 rule | 47 hits in 8 files |

Kept: `freezeHostLinks` (24 hits; its call in `rpc-manager.ts` is unchanged), `disableIdleTimeout` for the other streams, `scripts/smoke.ts` (0 transport references: it proves the link through `/api/hosts` status), the deploy script (reads the two constants; no change).

## Verified assumptions

Probe by the planner, 2026-10-31, Linux x64: Bun 1.4.4 `Bun.serve` with an async `routes` handler (two awaits, then the bearer check, then `server.upgrade`), `idleTimeout: 10`, `websocket.maxPayloadLength` 64 MiB + 256, `backpressureLimit` 1 MiB, `closeOnBackpressureLimit: true`. Clients: global `WebSocket` of Bun 1.4.4, Node 24.0.0 (`npx -y node@24.0.0`), 24.19.0, 26.8.1. Task 1 re-runs the rows marked ▶ and appends its own.

| Assumption | Evidence |
|---|---|
| ▶ Built-in `WebSocket` sends `Authorization` via `{ headers }` | header auth opened and echoed text (string) and binary (`ArrayBuffer`, `binaryType = "arraybuffer"`) on all four clients |
| ▶ Refused upgrade status is not visible to Node | no token / bad token / 503: Node 24.0.0 error "Received network error or non-101 status code.", close 1002; Node 24.19, 26.8: error with empty message, close 1006; Bun: error "… failed: Expected 101 status code: 401" (or `503`), close 1006 |
| ▶ Close code and reason reach the client | server `ws.close(4001, "replaced")` → `close code=4001 reason="replaced"` on all four |
| ▶ An upgraded socket outlives the HTTP `idleTimeout` | 12 s without traffic on a server with `idleTimeout: 10`: still open (Bun, Node 24.19) |
| ▶ `send` return values and close on backpressure | 40 × 256 KiB sends in `open`: Bun client read all (10 MiB); Node clients: results `n…n, -1 ×3-5, 0 …`, the socket closed (client close 1006, server close 1006) after 4–8.6 MiB |
| `server.upgrade()` from an async route handler that returns `undefined` | works (the handler returned `undefined as unknown as Response`; Bun's route type wants a `Response`) |
| nginx on ai-web.brait.dev forwards the upgrade | `snippets/ai-brait-proxy.conf`: `proxy_http_version 1.1`, `Upgrade`/`Connection` via `$pfb_connection_upgrade`, `proxy_read_timeout 1d`, `proxy_send_timeout 1d` |
| Deploy script with MIN = current | `min_link_protocol` reads `MIN_LINK_PROTOCOL_VERSION` with `sed` and falls back to the current version; `switch_daemon` restarts `ompweb-host` when the running daemon's protocol is outside `[min, current]` |
| Task 1 probe: header auth, text and binary echo | 2026-10-31 re-run, Bun 1.4.4 server on 30311 (`idleTimeout: 10`, async route with two awaits): `open`, `text:hello`, `binary:ArrayBuffer:1,2,3`, close 1000 "bye" on Bun 1.4.4, Node 24.0.0, 26.8.1 and 24.19.0 |
| Task 1 probe: refused upgrade | no token and bad token (401): Bun error "WebSocket connection to '…' failed: Expected 101 status code: 401", close 1006; Node 24.0.0 error "Received network error or non-101 status code.", close 1002 with that reason; Node 24.19.0 and 26.8.1 error message "", close 1006 |
| Task 1 probe: close code and reason | `ws.close(4001, "replaced")` in `open` → `close code=4001 reason="replaced"` on all four |
| Task 1 probe: idle | 12 s without traffic on `idleTimeout: 10`: `readyState=1` and the echo after the wait arrived on all four |
| Task 1 probe: backpressure flood (40 × 256 KiB in `open`, `backpressureLimit` 1 MiB, `closeOnBackpressureLimit`) | Bun client: all 40 messages, 10.00 MiB, then close 1005. Node 24.0.0 / 24.19.0 / 26.8.1: truncated at 4.00 MiB in the last pass (up to 8.25 MiB in an earlier pass), client close 1006, server `close` code 1006. Server `send` results, Node runs: `262144 ×16, -1 ×5, 0 ×19`, or `262144` interleaved with `-1`, then `0`. `send` returns the byte count, `-1` when queued under backpressure, `0` once the socket is closed |
| Task 1 probe: `new WebSocket(url, { headers })` types | `tsc --noEmit` (this repo's tsconfig: `lib: dom`, `@types/bun` 1.4.4) fails as written: `error TS2353: Object literal may only specify known properties, and 'headers' does not exist in type 'string[]'.` Needs a cast, e.g. `{ headers } as unknown as string[]` (compiles) |
| Task 1 probe: `Bun.serve` route handler returning `undefined` after `server.upgrade()` | `@types/bun` `routes` handlers are `Handler<…, Response \| undefined \| void>`, so `return undefined` compiles with no cast when the handler's parameters are typed (`req: Bun.BunRequest, server: Bun.Server<Data>`, or contextually typed via `Bun.serve({ websocket: { data: {} as Data, … } })`). With an explicit `Bun.serve<Data>({ routes: { "/x": async (req, server) => … } })` the unannotated parameters fail: `error TS7006: Parameter 'req' implicitly has an 'any' type.` (also `server`), so annotate them |

## Acceptance criteria

1. `rg -n "LINK_HELLO_HEADER|LINK_ACK_HEADER|LINK_NONCE_HEADER|x-omp-web-(hello|ack|link)|helloOffer|helloId|handleLinkGet|handleLinkBlob|uploadBlob|link/blob|legacyHelloVersion|\"replaced\"" --glob '!docs/**' --glob '!CHANGELOG.md'` → no matches; `app/api/hosts/link/blob/` does not exist; `rg -n disableIdleTimeout lib/hosts app/api/hosts` → no matches.
2. `sed -n 's/^export const LINK_PROTOCOL_VERSION = \([0-9]*\);.*/\1/p' lib/hosts/link-protocol.ts` and the same for `MIN_LINK_PROTOCOL_VERSION` both print `4`.
3. `npm run typecheck && npm run lint && npm test && npm run build && npm run smoke` pass; `lib/hosts/link-integration.test.mjs` runs the real Node daemon over a real WebSocket through `Bun.serve` with its link-break faults; the binary smoke (`--binary`, Bun's client) and the packed-install smoke (Node's client) pass on Ubuntu and Windows CI.
4. Tests pin: 401 before upgrade (and not the 307 with a password set), 426 for a non-upgrade GET and for a v3 hello POST, 4426 with `serverVersion`, 4409 replacement, 1001 freeze plus 503 upgrades while frozen, `ack` per frame, one uplink frame in flight, blob frame before `res`, resend after a drop, the diagnosis GET (401 stops, 503 and 400/426 redial).
5. Docs: remote-hosts "Link protocol" describes the WebSocket (this document's wire format, close codes, limits); local-daemon and `AGENTS.md` (route table, `hub.ts` line, Bun server idle notes, the link and proxy-exclusion bullets, v2 mentions), `DESIGN.md` ("no WebSocket yet"), `CHANGELOG.md` updated.
6. Rollout (after merge, by the deployer): web first via `ompweb-deploy` (restarts `ompweb-host`: protocol 3 outside `4..4`), then the Mac.

## Out of scope

- `perMessageDeflate`, multiplexing several hosts on one socket, a token in `Sec-WebSocket-Protocol`, a hello timeout on sockets that never say hello (an authenticated daemon only; Bun's 120 s idle timeout covers a silent one).
