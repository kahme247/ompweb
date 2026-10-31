# WebSocket Host Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `ompweb host` daemon and the web server talk over one WebSocket per host at `/api/hosts/link`; the HTTP legs, the blob route and the v2 compatibility code are gone.

**Architecture:** The daemon (Node + jiti in npm installs, Bun in the compiled binary) dials with the runtime's built-in `WebSocket` and an `Authorization` header. `Bun.serve` checks the bearer token in the link route before `server.upgrade()`, and `lib/hosts/hub.ts` runs the socket through a `websocket` handler. Text frames carry today's JSON messages plus a new unsequenced `ack`; binary frames carry large op results; close codes replace `replaced`, 409 and the version 426.

**Tech Stack:** Bun 1.4.4 (`Bun.serve` `routes` + `websocket`, `bun test`), Node ≥ 24 global `WebSocket` (undici), TypeScript, npm.

**Spec:** `docs/specs/2026-10-31-websocket-link-design.md` (decisions D1–D6, wire format, close codes, acceptance criteria). Read it first. Background: `docs/specs/2026-10-28-remote-hosts-design.md` "Link protocol".

## Global Constraints

- Work only in `/root/git/.ompweb_worktrees/ws-link` on `feat/ws-link`. One commit per task with the message given. The worktree has no `node_modules`: Task 1 runs `npm ci` (never `bun install`, never a `bun.lock`).
- Ports: 0 or 30300–30399 only. Never start, stop or restart a systemd/launchd/tray service, never run `ompweb-deploy`, never touch the real `~/.omp` (temp `HOME`/`PI_CODING_AGENT_DIR`, `OMP_WEB_OMP_BIN=/nonexistent/omp` for any server you start).
- `lib/hosts/**` never references `Bun.*` or `bun:*`, types included (the daemon loads it through jiti). The hub types its socket structurally (`LinkSocket`).
- The daemon stays on Node in npm installs: no change to `bin/omp-web-host.js`, `bin/omp-web.js`, the systemd/launchd helpers, `scripts/windows/*`, the trays or `lib/windows-service.ts`. No new dependency.
- `lib/hosts/link-protocol.ts` keeps both constants as single literal lines, `export const LINK_PROTOCOL_VERSION = 4;` and `export const MIN_LINK_PROTOCOL_VERSION = 4;` (the deploy script parses them with `sed`).
- Limits come from `LINK_LIMITS` (unchanged values): uplink text frame ≤ `uplinkBytes` (16 MiB), line ≤ `maxLineBytes` (8 MiB), result ≤ `blobBytes` (64 MiB); hub `maxPayloadLength = LINK_LIMITS.blobBytes + 256`, `backpressureLimit = LINK_LIMITS.uplinkBytes`, `closeOnBackpressureLimit: true`.
- Close codes only from `LINK_CLOSE` (Task 2): `goingAway 1001`, `invalidData 1007`, `policy 1008`, `tooBig 1009`, `replaced 4409`, `versionMismatch 4426`; revoke uses a plain `close()` (1000).
- Clean cutover: no HTTP fallback, no shim, no re-export of a deleted name. No new `eslint-disable` comments.
- Green bar: from Task 2 on every task ends with `npm run typecheck && npm run lint && npm test` green **except** `lib/hosts/link-integration.test.mjs`, which is red after Task 3 and Task 4 (the transport needs both ends) and green from Task 5. Run it anyway and paste its first failure in the task report.
- Line numbers are hints; locate code by symbol.

## Review Focus

1. **A revoked or unknown token on the Node daemon:** Node shows no status for a refused upgrade, so only the diagnosis GET can tell 401 from an outage; a revoked host must stop its omp children and exit 1, and a re-keyed one must pick up host.json's new token (Task 3 "a refused upgrade is diagnosed…", Task 5 revoke test).
2. **Half-open sockets (laptop sleep, NAT timeout):** with no frame for `offlineMs` the daemon closes the socket and redials while its omp children keep running (Task 3 watchdog test), and the hub flips the host offline (existing hub test). A given-up socket stays inert: every daemon handler first checks it is still the current socket (code review; a late 4409 on a dead socket cannot be produced reliably in a test).
3. **A drop between apply and ack:** no frame lost or duplicated, in both directions (Task 5 streaming test with its three faults; Task 4 resend tests).
4. **A v3 daemon (the Mac) against the new server:** its hello POST gets 426 with `hostVersion 3, serverVersion 4`, it exits telling the user to update the host, and Settings shows needs upgrade without disturbing a healthy link (Task 4 tests).
5. **A peer that stops reading:** the daemon never has more than one uplink text frame unacked; the hub's socket closes at its backpressure limit instead of buffering, and the outbox resends after the redial (Task 3 flow-control test; Task 4 asserts the handler's limits; probe rows in the spec).

## Inventory (counts at `51e40f47`, `rg` over code, tests and docs)

| Surface | Hits | Files | Task |
|---|---|---|---|
| HTTP-leg code (`LINK_*_HEADER`, `x-omp-web-*`, `helloOffer`/`helloId`, `handleLinkGet`/`Post`, `handleHelloPost`, `openDownlink`, `currentLink`/`staleLink`/`forgetLink`, `nonce`, `readLines`) | 172 | hub.ts 41, daemon.ts 24, link-protocol.ts 8, link route 3, hub.test 34, daemon.test 16, link-driver helper 8, hosts-route.test 5, link-integration.test 4, link-protocol.test 2, server/app.test.ts 2, AGENTS.md 9, remote-hosts spec 16 | 3, 4, 5, 6 |
| Blob leg (`handleLinkBlob`, `uploadBlob`, `link/blob`, `blob_upload_failed`, `hostsLinkBlobReqId`) | 41 | blob route 3, hub.ts 6, daemon.ts 3, link-protocol.ts 1, server/routes.ts 2, hub.test 8, link-integration 6, daemon.test 2, helper 2, web-auth.test 2, AGENTS.md 2, remote-hosts spec 3, bun-runtime spec/plan 2 | 3, 4, 5, 6 |
| `MIN_LINK_PROTOCOL_VERSION` | 14 (+1 deploy-script parser, unchanged) | hub.ts 3, link-protocol.ts 1, hub.test 4, AGENTS.md 2, remote-hosts spec 2, local-daemon spec 2 | 4, 6 |
| v2/v1 acceptance (`v === 2`, `channels(o, v2)`, `legacyHelloVersion`, "v2 daemon") | 25 | hub.ts 4, link-protocol.ts 5, hub.test 5, link-protocol.test 1, AGENTS.md 4, remote-hosts spec 4, local-daemon spec 2 | 4, 6 |
| `disableIdleTimeout` for the link | 17 code (+4 docs) | hub.ts 8, link route 6, blob route 2, link-integration 1; AGENTS.md 2, bun-runtime spec 2 | 4, 5, 6 |
| `disableIdleTimeout` elsewhere (kept) | 11 | server/app.ts 5, server/routes.ts 4, event-stream-hub.test 1, file-access.test 1 | — |
| `freezeHostLinks` / `frozen` | 24 | hub.ts 15, hub.test 5, rpc-manager.ts 2 (call unchanged), AGENTS.md 2 | 4, 6 |
| `replaced` message and the 409 rule | 47 | hub.ts 4, daemon.ts 6, link-protocol.ts 4, hub.test 8, daemon.test 6, link-protocol.test 3, AGENTS.md 9, remote-hosts spec 7 | 3, 4, 6 |
| `scripts/smoke.ts` | 0 transport refs | proves the link via `/api/hosts` status (Node daemon in repo/packed runs, Bun daemon in the binary run) | 5 (run only) |
| `/opt/omp-deployment/bin/ompweb-deploy` | 2 parsers | `link_protocol`, `min_link_protocol` (`sed` on the two constants) | 6 (check only) |

---

### Task 1: Probe the client and auth choice

Proves D2 on this machine and in this repo's type setup before any code changes. Nothing but spec rows is committed.

**Files:**
- Modify: `docs/specs/2026-10-31-websocket-link-design.md` (append rows to "Verified assumptions")
- Scratch (never committed): `$TMPDIR/ws-link-probe/server.ts`, `$TMPDIR/ws-link-probe/client.mjs`, `types-probe.ts` at the repo root (deleted in Step 4)

- [ ] **Step 1: Install.** `rm -rf node_modules && npm ci` (prints `added … packages`).
- [ ] **Step 2: Runtime probe.** Server: `Bun.serve` on port 30311, `idleTimeout: 10`, one async `routes` entry for `/api/hosts/link` that awaits twice, answers 401 without `Authorization: Bearer x`, then `server.upgrade(req, { data })`; `websocket` with `maxPayloadLength: 64 * 1024 * 1024 + 256`, `backpressureLimit: 1024 * 1024`, `closeOnBackpressureLimit: true`, echo on `message`, `ws.close(4001, "replaced")` or a 40 × 256 KiB send flood in `open` when the query asks. Client (one file, runs everywhere): no token, bad token, header auth + text and binary echo, close 4001, flood, 12 s idle. Run with `bun`, `npx -y node@24.0.0`, `node` (26.x) and `/root/.nvm/versions/node/v24.19.0/bin/node`.
  Expected: every ▶ row of the spec's table reproduces. If any Node client fails header auth, stop and message the plan owner (the fallback is a token in `Sec-WebSocket-Protocol`, D2).
- [ ] **Step 3: Type probe.** `types-probe.ts` at the repo root with `new WebSocket("ws://127.0.0.1:1/api/hosts/link", { headers: { authorization: "Bearer t" } })` and a `Bun.serve` whose `routes` handler returns `undefined` after `server.upgrade()`. Run `npx tsc --noEmit`. Record for each whether it compiles as written or needs a cast (and the exact `tsc` error).
- [ ] **Step 4: Record.** Delete `types-probe.ts`. Append rows `Task 1 probe: …` with the observed output to the table.
- [ ] **Step 5: Commit** `docs: record the WebSocket link probe` (the spec only; `git status` shows nothing else).

### Task 2: Protocol additions for the WebSocket

Additive only: the daemon and hub still compile against the old names until Tasks 3 and 4 remove them.

**Files:**
- Modify: `lib/hosts/link-protocol.ts`
- Test: `lib/hosts/link-protocol.test.mjs`

**Interfaces:**
- Produces:
  - `DownMessage` and `UpMessage` each gain `{ type: "ack"; ack: number }` (unsequenced); `DOWN_TYPES` and `UP_TYPES` list `"ack"`.
  - `export const LINK_CLOSE = { goingAway: 1001, invalidData: 1007, policy: 1008, tooBig: 1009, replaced: 4409, versionMismatch: 4426 } as const;`
  - `export function encodeBlobFrame(id: string, bytes: Uint8Array): Uint8Array<ArrayBuffer>` — layout in the spec ("Binary frame"); throws `LinkProtocolError` when the id's UTF-8 length is 0 or over 255.
  - `export function decodeBlobFrame(frame: Uint8Array): { id: string; bytes: Uint8Array }` — `bytes` is a `subarray` of `frame` (no copy); throws `LinkProtocolError` for an empty frame, a zero id length, or a frame shorter than its header.

- [ ] **Step 1: Write the failing tests**
  - `"round-trips every down message kind"` / `"…up message kind"`: add `{ type: "ack", ack: 7 }` to both lists.
  - `test("ack is unsequenced and its value must be a safe non-negative integer", …)`: `decodeDown('{"type":"ack","ack":5}')` deep-equals `{ type: "ack", ack: 5 }`, same for `decodeUp`; `ack: -1`, `ack: 2 ** 53`, `ack: "5"` throw `LinkProtocolError` both ways.
  - `test("a blob frame carries its request id and the bytes without copying them", …)`: `const frame = encodeBlobFrame("r-1", new Uint8Array([9, 8, 7]))`; `frame[0] === 3`; `decodeBlobFrame(frame)` gives `id "r-1"`, bytes `[9, 8, 7]`, and `decoded.bytes.buffer === frame.buffer`. A multi-byte id (`"é"`) round-trips with `frame[0] === 2`.
  - `test("blob frames with an empty, over-long or cut id are refused", …)`: `encodeBlobFrame("", …)` and `encodeBlobFrame("x".repeat(256), …)` throw; `decodeBlobFrame(new Uint8Array([]))`, `new Uint8Array([0, 1])` and `new Uint8Array([5, 0x61])` throw `LinkProtocolError`.
- [ ] **Step 2: Run** `bun test lib/hosts/link-protocol.test.mjs` — FAIL (`encodeBlobFrame` not exported, `ack` decoded as unknown).
- [ ] **Step 3: Implement** the Interfaces block in `lib/hosts/link-protocol.ts` (`ack` uses the existing `seqNum` reader).
- [ ] **Step 4: Run** `bun test lib/hosts/link-protocol.test.mjs && npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(hosts): ack message, close codes and binary result frames for the WebSocket link`.

### Task 3: The daemon dials a WebSocket

**Files:**
- Modify: `lib/hosts/daemon.ts`
- Test: `lib/hosts/daemon.test.mjs` (rewrite `scriptedServer`; transport tests below)

**Interfaces:**
- Consumes: Task 2 (`ack`, `LINK_CLOSE`, `encodeBlobFrame`).
- Produces: `runHostDaemon(options: { url: string; token: string; allowHttp: boolean }): { stop(): Promise<void>; done: Promise<number> }` — the `fetch` option is removed (`lib/hosts/host-cli.ts` never passed it). Behavior on the wire: spec D2/D3 and "Close codes".

Exact behavior (the parts the spec leaves to the daemon):
- Dial: `new WebSocket(linkUrl.replace(/^http/, "ws"), { headers: { authorization: sent } })`, `binaryType = "arraybuffer"`; on `open` send the hello as the first text frame (the existing replay/no-replay fallback stays); each text frame from the hub is one message → `handleDown(frame)`; binary frames from the hub are ignored. Keep the `sent` authorization per dial (the 401 logic compares it).
- One socket at a time. When the watchdog fires (no frame for `offlineMs`), call `close()`, treat the link as dropped at once, and ignore every later event from that socket.
- `welcome` → linked, reset `redialDelay`, flush. `ack {ack}` → clear the in-flight flag, `acked(ack)`, `scheduleFlush()`. `replaced` handling is deleted.
- Flush only while linked and no frame is in flight: frame = `encodeLine({ type: "ack", ack: down.acked })` + `PONG_LINE` if owed + outbox lines in `seq` order, total ≤ `LINK_LIMITS.uplinkBytes`; nothing to send (no item, no pong) → no frame. A drop clears in-flight and linked; the outbox goes again after the next `welcome`.
- Result too large for inline JSON or `readMedia` bytes: check `blobBytes` (unchanged 413 `result_too_large`), then, if linked, `socket.send(encodeBlobFrame(id, bytes))` and queue `res {blob: {bytes}}`; if not linked, queue the `res` without the frame (the hub failed that op when the link dropped).
- After a dial: close 4409 → log "another ompweb host linked with this token; exiting", `shutdown(0)`. Close 4426 → read `serverVersion` from the JSON reason and log as the old 426 branch did, `shutdown(1)`. Closed before `open` → diagnosis `fetch(linkUrl, { headers: { authorization: sent }, signal })` with `AbortSignal.any([stopSignal.signal, AbortSignal.timeout(LINK_LIMITS.offlineMs)])`: 401 → the existing 401 branch (rename `fatal` to `unauthorized(sent)`, keep its host.json logic and messages); 503 → log `the server is unavailable (503); redialing`; any other status → log `the server did not accept the WebSocket upgrade (HTTP <status>): check that a reverse proxy forwards Upgrade and Connection, and that the server runs an ompweb at least as new as this host's`; a fetch error → `link lost (<reason>); redialing`. Every other close → `link lost (code <code>[: <reason>]); redialing`. Then `followLogin()`, backoff with jitter, `nextRedialDelay` (unchanged).
- Delete: `readLines`, `posting`/`backingOff`/`postDelay`, the nonce/`welcome` promise/`forgetLink`, the 409 and 426-HTTP branches, the "older main" (400/404/405/409) exit, `uploadBlob`'s retry loop, the `LINK_*_HEADER` imports.

- [ ] **Step 1: Rewrite the scripted server** in `daemon.test.mjs` as a real `Bun.serve({ port: 0, hostname: "127.0.0.1" })` (the tests run under `bun test`): `scriptedServer({ refuse = () => null, validToken = null } = {})` returns `{ url, hellos, up, acks, blobs, gets, diagnoses, holdAcks, send(message) → seq, raw(message), close(code, reason), drop(), res(id), stop() }`. `gets` counts upgrade attempts; `refuse(n)` gives the status to answer the nth one with, or `null` to upgrade it; a plain GET (the diagnosis, counted in `diagnoses`) answers the status the latest attempt got, or 426 when that one upgraded (as the hub does); `validToken` answers 401 to other bearers on both. The first frame of a socket goes to `hellos` and is answered `welcome`; later text frames are split into lines, the leading `ack` line's value goes to `acks`, the rest to `up`, and the frame is answered `{type:"ack", ack}` unless `holdAcks`; binary frames go to `blobs` via `decodeBlobFrame`. `start(server)` dials `server.url`.
- [ ] **Step 2: Port and write the tests** (keep every non-transport test as is; `server.downlink` waits become `server.hellos.length`):
  - `"an http:// loopback server links without --allow-http"` and `"the hello reports this host's extension auto-approve"`: unchanged assertions over the first hello frame.
  - `"one uplink frame is in flight until its ack, and each frame starts with the ack of the applied downlink"`: `holdAcks = true`; spawn `c1`, send two `echo` stdins 100 ms apart; after 300 ms exactly one new frame arrived and its `acks` entry equals the last downlink `seq`; `holdAcks = false` and one hub `ack` → the second echo arrives.
  - `"a large result goes as one binary frame before its res"`: the old readMedia fixture (`blobs/aaaa…` = `image-bytes`); `blobs` holds `{ id: "m1", bytes: "image-bytes" }` and the frame index of the blob precedes the `res` whose `blob` is `{ bytes: 11 }`.
  - `"uplink messages unacked when the socket drops are resent after the next welcome, once"`: `holdAcks = true`, request `p1` (listProjects), `server.drop()`, `holdAcks = false`; after the relink `res p1` arrives; across both sockets the hub applied `p1` once by `seq` (`up` holds it twice at most, same `seq`), and the second hello's `ack` is the highest downlink `seq` sent.
  - `"close 4426 exits 1 naming the side to update; close 4409 exits 0"`: a server that closes the hello with `4426` and reason `{"serverVersion":2}` → exit 1, log "this host's ompweb is newer than the server's: update ompweb on the server"; `{"serverVersion":9}` → "update ompweb on this host"; after a welcome, `server.close(4409, "replaced")` → exit 0.
  - `"a refused upgrade is diagnosed with one plain GET: 401 stops every omp child, 503 and others redial"`: (a) link, spawn `c1`, then `refuse = (n) => (n > 1 ? 401 : null)` and `server.drop()` → exit 1, the child pid is gone (`ESRCH`), log contains "revoked", `diagnoses >= 1`; (b) `refuse` returns 503 for attempt 2 and 426 for attempt 3 → both logged (`unavailable (503)`, `did not accept the WebSocket upgrade (HTTP 426)` with the proxy hint), the hello on attempt 4 lists `c1`, the child still runs.
  - `"a 401 with a newer token in host.json redials with it and links"`, `"…still holding the rejected token exits 1"`, `"…names another server is not adopted"`, `"…differs only by a trailing slash"`, `"a failed dial re-reads host.json and follows its new url"`: same assertions, the 401 coming from `refuse`/`validToken` and the diagnosis GET.
  - `"no frame for offlineMs closes the socket and redials; the omp children keep running"`: set `LINK_LIMITS.offlineMs = 300` (the daemon reads it at call time; restore it in `t.after`), link, spawn `c1`, the server sends nothing → a second hello arrives listing `c1`, the child pid still answers `process.kill(pid, 0)`.
  - `"output beyond the channel buffer while the uplink is down is dropped, then resync"`: `uplinkDown` becomes `holdAcks`; same assertions.
  - Delete `"a main that does not understand the hello POST…"`, `"a POST or blob upload refused as from a replaced link…"`, `"5xx answers are retried…"` (covered above), `"a blob upload refused with 401 after the web server re-keyed…"`.
- [ ] **Step 3: Run** `bun test lib/hosts/daemon.test.mjs` — FAIL (the daemon still POSTs).
- [ ] **Step 4: Implement** the behavior above in `lib/hosts/daemon.ts`. If Task 1 found that `tsc` rejects `{ headers }`, cast the init at that one call site with a one-line comment naming why.
- [ ] **Step 5: Run** `bun test lib/hosts/daemon.test.mjs lib/hosts/link-protocol.test.mjs && npm run typecheck && npm run lint && npm test` — PASS except `link-integration.test.mjs` (expected red).
- [ ] **Step 6: Commit** `feat(hosts): the host daemon links over one WebSocket`.

### Task 4: The server end of the WebSocket

**Files:**
- Modify: `lib/hosts/link-protocol.ts`, `lib/hosts/hub.ts`, `app/api/hosts/link/route.ts`, `server/routes.ts`, `server/app.ts`, `proxy.ts`
- Delete: `app/api/hosts/link/blob/[reqId]/route.ts`
- Test: `lib/hosts/link-driver.test-helper.mjs`, `lib/hosts/hub.test.mjs`, `lib/hosts/hosts-route.test.mjs`, `lib/hosts/link-protocol.test.mjs`, `lib/web-auth.test.mjs`, `server/app.test.ts`

**Interfaces:**
- Consumes: Task 2; Task 3's daemon behavior (one `ack` per uplink frame expected back).
- Produces (`lib/hosts/hub.ts`):
  - `export interface LinkSocketData { hostId: string; hello: boolean }`
  - `export interface LinkSocket { readonly data: LinkSocketData; send(data: string | Uint8Array): number; close(code?: number, reason?: string): void; terminate(): void }`
  - `export function handleLinkUpgrade(req: Request, upgrade: (data: LinkSocketData) => boolean): Response | undefined` — spec "Upgrade" table; `undefined` once upgraded.
  - `export async function handleOutdatedLinkPost(req: Request): Promise<Response>` — spec D5.
  - `export const hostLinkSocket: { maxPayloadLength: number; backpressureLimit: number; closeOnBackpressureLimit: true; message(ws: LinkSocket, data: string | Uint8Array): void; close(ws: LinkSocket, code: number, reason: string): void }`
- Produces (`server/routes.ts`): `RouteHandler` context gains `upgrade: (data: LinkSocketData) => boolean` and may return `undefined`; `dispatch(mod, request, params, disableIdleTimeout = () => {}, upgrade = () => false): Promise<Response | undefined>`.

Exact behavior:
- `link-protocol.ts`: `LINK_PROTOCOL_VERSION = 4`, `MIN_LINK_PROTOCOL_VERSION = 4` (doc comment: the v4 line from spec D4; keep the pointer to the compatibility rules); delete `LINK_HELLO_HEADER`, `LINK_ACK_HEADER`, `LINK_NONCE_HEADER`, `replaced` (type, `DOWN_TYPES`, `decodeDown`), `welcome.nonce`, and the v2 branches (`autoApproveExtension` always read, `channels(o)` always reads `cwd`/`pending`).
- `hub.ts` `Link`: `socket: LinkSocket | null` replaces `stream`, `nonce`, `helloOffer`. `enqueue(link, line)` = `link.socket?.send(line)` (Bun closes a socket over its backpressure limit; the outbox keeps sequenced lines). `request()` treats `!link.socket` as offline.
- `message(ws, data)`: frozen → ignore. `link.socket === ws` → frame. Else `ws.data.hello` → ignore (a replaced socket). Else the first frame: binary → close `policy`; parse the raw JSON (`policy` on failure), `versionMismatch(link, raw)` → close `versionMismatch` with reason `JSON.stringify({ serverVersion: LINK_PROTOCOL_VERSION })`; `decodeUp` not a hello → close `policy`; else `openLink(link, ws, hello)` (today's `openDownlink` minus the stream, nonce and Response: close the previous socket with `replaced`/"replaced by a newer link", reset windows by `hello.ack`, `welcome {v, hostId}`, resend the outbox, reattach, ping timer, status, hello listeners) and set `ws.data.hello = true`.
- A frame on the current socket calls `sawDaemon` first. Binary → `decodeBlobFrame` (`policy` on error), store on the pending op with that id if it has none, else ignore. Text → over `uplinkBytes` UTF-8 bytes → close `tooBig`; split on `\n`, drop empties, decode every line first (any throw → close `invalidData`, nothing applied); `ack` lines → `outbox.ack`; the rest through `applyUp` (unchanged); then send `encodeLine({ type: "ack", ack: link.up.acked })`.
- `close(ws)`: if `link.socket === ws` → `endSocket(link)` (today's `endStream`: socket null, fail ops `host_offline`; status waits for the offline timer as today).
- `freezeHostLinks()`: `frozen = true`, then every link's socket `close(LINK_CLOSE.goingAway, "omp-web is restarting")`. Offline timer: `terminate()` + `endSocket`. `closeHostLink`: `close()` then today's cleanup. `versionMismatch` marks needs-upgrade only when the link has no socket (was: no stream).
- `handleOutdatedLinkPost`: `authenticate` (401/503 before reading the body), `readBodyWithinLimit(req, LINK_LIMITS.uplinkBytes)`, best-effort `JSON.parse`, `versionMismatch(link, raw) ?? 426 with hostVersion from raw.v` — always 426.
- Delete from `hub.ts`: `handleLinkGet`, `handleLinkPost`, `handleHelloPost`, `handleLinkBlob`, `legacyHelloVersion`, `currentLink`, `staleLink`, the `disableIdleTimeout` parameter of `authenticate`, the NDJSON `Response`.
- `app/api/hosts/link/route.ts`: `GET(req, { upgrade })` → `handleLinkUpgrade(req, upgrade)`; `POST(req)` → `handleOutdatedLinkPost(req)`; header comment says the hub checks the bearer token before it upgrades and that the POST only refuses pre-WebSocket daemons.
- `server/routes.ts`: delete the blob import and table entry; context and `dispatch` per Interfaces. `server/app.ts`: `Bun.Server<LinkSocketData>` at its 6 annotations (`handle`, `devIndex`, `startServer` return and `routes` record, `startProduction` return and local); `Bun.serve({ …, websocket: hostLinkSocket })`; each route passes `(data) => server.upgrade(request, { data })` to `dispatch`; `handle` returns `undefined` untouched when the handler upgraded (no `finalizeResponse`, no restore); drop the host-link clause from `handle`'s comment. Cast only where Task 1 recorded `tsc` needs it.
- `proxy.ts`: `UNGATED` ends in `api\/hosts\/link$`; its comment drops the blob subpath.

- [ ] **Step 1: Rewrite `LinkDriver`** (`link-driver.test-helper.mjs`), keeping its public API (`linkHost`, `linkLocalHost`, `linkLocalDaemon`, `dial`, `next`, `post`, `answer`, `serve`, `drop`, `welcome`, `ack`, `upSeq`) so the seven other importers stay unchanged. `dial` calls `hub.handleLinkUpgrade(new Request(URL, { headers: { authorization, upgrade: "websocket" } }), (data) => …)` (asserts `undefined`), builds a plain socket `{ data, send, close, terminate }` that queues what the hub sends and, on `close`/`terminate`, calls `hub.hostLinkSocket.close(socket, code, reason)` in a microtask, then sends the hello through `hub.hostLinkSocket.message`. `next()` skips `ping` and `ack` (keeping the last hub ack) and returns `null` once closed. `post` sends one text frame `[ack line, …messages]`. `answer` with bytes sends `encodeBlobFrame(req.id, bytes)` then the `res`. `drop()` closes with 1006. Export `upgradeSocket(token)` returning `{ response, socket }` for hub tests that need the raw socket.
- [ ] **Step 2: Port `hub.test.mjs`** onto `upgradeSocket`/`LinkDriver` (helpers `linkHello`, `openDown`, `linkGet`, `linkPost`, `downlink`, `openLink` become socket helpers). Changes:
  - `"a missing, malformed or wrong bearer token gets 401 before any upgrade or body read"`: for each bad header, `handleLinkUpgrade` → 401 and the `upgrade` stub was never called; `handleOutdatedLinkPost` with a `watchedBody()` → 401, `pulled === false`.
  - `"a hello with another version is closed 4426 with the server's version and marks the host needs-upgrade"` (from the 426 test): `v: LINK_PROTOCOL_VERSION + 1` and `v: 3` → socket closed `4426`, reason `{"serverVersion":4}`, row `needs-upgrade`, `hostVersion` set.
  - `"a pre-WebSocket daemon's hello POST gets 426 with both versions"`: POST body `{"type":"hello","v":3,…}` → 426 `{hostVersion: 3, serverVersion: 4}`; a non-JSON body → 426 `hostVersion: null`.
  - `"an authenticated request that does not upgrade gets 426"` (replaces the 400 GET test): `upgrade` stub returns `false` → 426.
  - `"a first frame that is not a hello closes the socket 1008"`: a binary frame, `not json`, and `{"type":"stdout","v":4,"seq":1,"ch":"c","line":"x"}` (an accepted `v`, so past the version check) each → `1008`, host stays offline. (A first frame without a valid `v` gets 4426, as a hello POST without one got 426.)
  - `"a hello frame listing hundreds of channels links"` (the scale test, as a frame).
  - `"a second link with the same token closes the first socket with 4409, and frames still arriving on it are ignored"` (replaces the `replaced` test and both 409 tests): a `stdout` frame on the old socket after the swap reaches no transport and changes no `seq` window.
  - `"freezeHostLinks closes every link socket with 1001, answers upgrades 503 and applies nothing after"` (replaces "a stopping server takes no hello…").
  - `"the hub answers each uplink frame with one ack; an ack line from the daemon trims the downlink outbox"`: frame with `ack: 0` + `stdout seq 1` → reply `{type:"ack", ack: 1}`; resend after a redial carries only unacked downlink messages.
  - `"a resent uplink frame applies only the new seq and acks the highest"`, `"downlink messages the daemon did not ack are resent after it redials"`, `"a restarted daemon (hello ack 0) starts a fresh uplink sequence"`: as before, over frames.
  - `"a binary frame carries a large result ahead of its res; an unknown id or a second frame for one op is ignored"` (from the blob-leg test; the result validation part unchanged).
  - `"a text frame over uplinkBytes closes 1009; a frame with one malformed line or an unsafe seq applies nothing and closes 1007"` (from the 413 and safe-integer tests).
  - `"ops pending when the socket closes reject at once and are not resent"` (from the offline-flip test): `drop()` → pending op rejects 503 `host_offline` before `opTimeoutMs`.
  - `"the websocket handler bounds what one peer can make the server hold"`: `hostLinkSocket.maxPayloadLength === LINK_LIMITS.blobBytes + 256`, `backpressureLimit === LINK_LIMITS.uplinkBytes`, `closeOnBackpressureLimit === true`.
  - `"an unreadable host registry answers 503, never 401"`: through `handleLinkUpgrade` and `handleOutdatedLinkPost`.
  - `"a version-mismatched dial leaves a healthy link online"`: with a linked host, a second socket's `v: 3` hello (closed 4426) and a v3 hello POST (426) leave the row `online` and the first socket open.
  - Delete the v1 GET test, `"…older than MIN_LINK_PROTOCOL_VERSION…"`, both v2 tests, both 409 tests.
- [ ] **Step 3: Port the other tests.** `hosts-route.test.mjs`: its local dial uses `linkHost`-style `LinkDriver`; `"DELETE revokes…"` asserts the socket closed and a new `handleLinkUpgrade` with that token → 401. `link-protocol.test.mjs`: delete `"a v2 hello decodes into today's shape…"`, drop `nonce`/`replaced` from the round-trips. `lib/web-auth.test.mjs`: the two `/api/hosts/link/blob/…` paths move into the 401 list, plus `/api/hosts/link/`. `server/app.test.ts`: in the idle test the host link becomes `new WebSocket(url("/api/hosts/link").replace(/^http/, "ws"), { headers: bearer })` sending a v4 hello on open, first message `welcome`, and after the stall race a `ping` arrives with `readyState === WebSocket.OPEN` (keep the `link` stall entry); new `test("the host link refuses an unauthenticated upgrade with 401, not the gate's 307, and answers 426 to a request that does not upgrade", …)` with a password set: a Bun `WebSocket` without headers errors with a message matching `/\b401\b/` and never opens; `fetch` with the bearer and no upgrade → 426; a POSTed v3 hello with the bearer → 426 `hostVersion 3`.
- [ ] **Step 4: Run** `bun test lib/hosts/hub.test.mjs lib/hosts/hosts-route.test.mjs lib/hosts/link-protocol.test.mjs lib/web-auth.test.mjs server/app.test.ts server/routes.test.ts` — FAIL.
- [ ] **Step 5: Implement** the behavior above; delete the blob route.
- [ ] **Step 6: Run** the same tests, then `npm run typecheck && npm run lint && npm test` — PASS except `link-integration.test.mjs` (expected red). `rg -n "LINK_HELLO_HEADER|LINK_ACK_HEADER|LINK_NONCE_HEADER|handleLinkGet|handleLinkBlob|legacyHelloVersion|\"replaced\"" lib app server proxy.ts` → only `link-integration.test.mjs`.
- [ ] **Step 7: Commit** `feat(hosts): the web server takes host links over one WebSocket`.

### Task 5: End to end over a real socket

**Files:**
- Test: `lib/hosts/link-integration.test.mjs`

**Interfaces:**
- Consumes: Task 4's `hostLinkSocket`, `LinkSocket`, link route `GET(req, { upgrade })` / `POST(req)`; Task 3's daemon (spawned as `node bin/omp-web-host.js`, i.e. Node's `WebSocket`).

- [ ] **Step 1: Port the bridge.** Replace the `node:http` server with `Bun.serve({ port: 0, hostname: "127.0.0.1", routes: { "/api/hosts/link": { GET, POST } }, websocket })`. `GET` calls `linkRoute.GET(req, { upgrade: (data) => srv.upgrade(req, { data }) })` and counts 503 answers in `seen.refusedUpgrades`. `websocket` spreads `hub.hostLinkSocket` and wraps it: `open` adds the socket to `sockets`; each socket gets one stable wrapper from a `WeakMap` (`data` is the same `ws.data` object; `send` records `kill` channels into `seen.kills` and applies `loseStdin` by terminating instead of sending a `stdin` frame; a `dropSends` flag makes `send` return 0 without sending; `close`/`terminate` forward); `message` applies `cutUplinkBeforeApply` (terminate without passing a frame that contains `"message_update`) and `cutUplinkAfterApply` (pass it with `dropSends` on, so the ack is lost, then terminate), counts binary frames in `seen.binaryFrames`; `close` removes from `sockets` and forwards.
- [ ] **Step 2: Port the restart.** `restartWeb`: `process.emit("SIGTERM")` (the freeze closes the sockets with 1001), `await whileStopping?.()`, `await waitFor(() => sockets.size === 0, "the frozen hub to close the link")`, clear the link timers, reset the globals as today; no `closeAllConnections`, no `seen.posting`. The fake omp logs `{ kind: "out", line }` for every stdout line it writes; the two stopping tests wait for their output in `ompLog()` (`"while stopping"`; `q2` and `send_to_session`) and for `seen.refusedUpgrades` to grow, instead of `seen.refusedPosts`. Their other assertions stay.
- [ ] **Step 3: Rename** `"a 2 MB session read arrives through the blob leg"` → `"…in one binary frame"` (`seen.binaryFrames` +1). **Add, last:** `test("revoking the host closes its socket; the daemon is refused 401, stops its omp children and exits 1", …)`: `revokeHost(hostId)` + `hub.closeHostLink(hostId)`; the daemon exits with code 1 within 20 s and its log contains "revoked".
- [ ] **Step 4: Run** `bun test lib/hosts/link-integration.test.mjs` — PASS; then `npm run typecheck && npm run lint && npm test` — 0 failures.
- [ ] **Step 5: Smoke.** `npm run build && npm run smoke` (Node daemon); `npx bun scripts/build-binary.ts --target bun-linux-x64-baseline && npm run smoke -- --binary release/ompweb-linux-x64/ompweb` (Bun daemon); `P="$(mktemp -d)" && npm pack --ignore-scripts && npm install -g --prefix "$P" ./kahme247-ompweb-*.tgz && npm run smoke -- --package "$(npm root -g --prefix "$P")/@kahme247/ompweb"` (Node daemon from a packed install). Each prints `ok \`ompweb host\` links this machine` and no `FAIL`. Remove the tarball and `release/` output afterwards (`git status` clean apart from the test file).
- [ ] **Step 6: Commit** `test(hosts): run the link integration test over a real WebSocket`.

### Task 6: Docs and final checks

**Files:**
- Modify: `docs/specs/2026-10-28-remote-hosts-design.md`, `docs/specs/2026-10-29-local-daemon-design.md`, `AGENTS.md`, `DESIGN.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: remote-hosts spec.** Rewrite "Link protocol" (intro, "Messages", the message table, "Rules" → Version/One link per host/Large results/Limits) from the WebSocket spec's D1–D6, wire format and close codes; in "Protocol versions and compatibility" replace the v2 bullet with "v4 (the WebSocket link) dropped v3 before any release; from the next version on, main keeps N-1" and the `MIN_LINK_PROTOCOL_VERSION (2)` mention with 4. Point to `docs/specs/2026-10-31-websocket-link-design.md`. Historical documents stay as written: `docs/specs/2026-10-30-bun-runtime-design.md`, `docs/plans/2026-10-30-bun-runtime.md`, `docs/plans/2026-10-29-local-daemon.md`.
- [ ] **Step 2: local-daemon spec** "Failure cases": the N-1 row says a daemon one version behind links from the next protocol bump on (v4 links only v4); the dropped/newer row says 426 (POST) or close 4426.
- [ ] **Step 3: AGENTS.md.** Route table: `hosts/link/route.ts  GET WebSocket upgrade (the ompweb host daemon; bearer checked before the upgrade, skipped by the proxy.ts gate) | POST 426 for pre-WebSocket daemons`; delete the blob row. `hub.ts` line: "the link's upgrade and `websocket` handler (`handleLinkUpgrade`, `hostLinkSocket`)". Bun server bullet: the link is no longer an idle-lift stream (upgraded sockets are outside the HTTP idle timeout); `server/app.ts` passes `upgrade` in the route context and a handler that upgraded returns `undefined`. Rewrite the "Link = two HTTP legs" bullet as one WebSocket (frames, `ack`, one frame in flight, close codes), the "409 nonce rule" bullet as "one socket per host: a new hello closes the old socket 4409", the version bullet (MIN 4), the proxy-exclusion bullet (exact path), the freeze bullet (sockets closed 1001, upgrades 503), and drop "or came from a v2 hello".
- [ ] **Step 4: DESIGN.md** (the "two HTTP requests … no WebSocket yet" paragraph): one WebSocket the daemon opens; text frames for messages, binary frames for large results. **README.md** hosts section, after the reconnect paragraph: "Behind a reverse proxy, forward WebSocket upgrades on `/api/hosts/link` (nginx: `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";`, and a `proxy_read_timeout` well above 30 s)." and "Update ompweb on the server before its hosts: a host from before this version shows **needs upgrade** until it is updated." **CHANGELOG.md** Unreleased, Fixes & Improvements: one bullet — the host link is one WebSocket (fewer requests, large results in the same connection); reverse proxies must forward WebSocket upgrades on `/api/hosts/link`; hosts linked with an earlier build of this release must be updated after the server.
- [ ] **Step 5: Final checks.**
  - `rg -n "LINK_HELLO_HEADER|LINK_ACK_HEADER|LINK_NONCE_HEADER|x-omp-web-(hello|ack|link)|helloOffer|helloId|handleLinkGet|handleLinkBlob|uploadBlob|link/blob|legacyHelloVersion|\"replaced\"" --glob '!docs/**' --glob '!CHANGELOG.md'` → no output; `test ! -e 'app/api/hosts/link/blob'`; `rg -n disableIdleTimeout lib/hosts app/api/hosts` → no output.
  - `sed -n 's/^export const LINK_PROTOCOL_VERSION = \([0-9]*\);.*/\1/p' lib/hosts/link-protocol.ts` → `4`; same with `MIN_LINK_PROTOCOL_VERSION` → `4` (the deploy script's parsers; with the running daemon on 3 it will restart `ompweb-host`, spec D5).
  - `npm run typecheck && npm run lint && npm test && npm run build && npm run smoke` → all pass.
- [ ] **Step 6: Commit** `docs: describe the WebSocket host link`.
