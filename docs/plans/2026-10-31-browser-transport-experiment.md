# Browser Transport Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-side switch `browserTransport: "sse" | "websocket"` that moves the browser's channel frames, channel (un)subscribe and the `POST /api/agent/[id]` command path onto one general WebSocket plus one WebSocket per session, with the same latency/reconnect instrumentation in both modes stored server-side and summarized by a script.

**Architecture:** The SharedWorker (`public/event-stream-worker.js`) gains a WebSocket mode next to its EventSource; the server gets `/api/events/ws` (gated like every API route, upgraded in `handle()`), a transport-agnostic `EventStreamConnection` (SSE or socket sink), and `runAgentCommand()` shared by the HTTP route and the socket. Tabs keep `openEventStream()`/`sendAgentCommand()`; `sendAgentCommand` asks the worker when the mode is `websocket`. Samples go tab → worker → `POST /api/transport-metrics` → JSONL; `scripts/transport-metrics.ts` prints p50/p95 per transport.

**Tech Stack:** Bun 1.4.4 (`Bun.serve` `routes` + `websocket`, `bun test`), TypeScript, React 19, plain-script worker run in `node:vm` by its tests.

**Spec:** `docs/specs/2026-10-31-browser-transport-experiment-design.md` (D1–D6, wire format, constants, acceptance). Read it first, then AGENTS.md "Live event stream", "Queued messages are omp-owned", "Running state + reconciliation", "RPC session lifecycle", "Bun server".

## Global Constraints

- Work only in `/root/git/.ompweb_worktrees/browser-ws` on `feat/browser-ws`. The worktree has no `node_modules`: Task 1 runs `npm ci` (never `bun install`, never a `bun.lock`). One commit per task with the message given.
- Ports: 0 or 30300–30399. Never start, stop or restart a systemd/launchd/tray service, never run `ompweb-deploy`, never touch the real `~/.omp` (temp `HOME` and `PI_CODING_AGENT_DIR`, `OMP_WEB_OMP_BIN=/nonexistent/omp` for any server you start).
- No new npm dependency. No new `EventSource`. `public/event-stream-worker.js` stays one plain script (its content hash versions the SharedWorker, `server/client-env.ts`); every global it uses (`WebSocket`, `Date`, `setInterval`, `location`, `navigator.connection`) must be injectable in the `vm` context of `lib/event-stream-worker.test.mjs`.
- SSE path behaviour unchanged: with `browserTransport` absent or `"sse"` the worker opens no WebSocket, and every existing test passes; the only edited existing assertions are the extended `hello` (Task 2) and the five full-object `deepEqual`s in `lib/web-settings.test.mjs` (Task 2). A `hello` without `transport` keeps the worker's current mode.
- Browser compat (client code: `components/`, `hooks/`, `lib/event-stream.ts`, `lib/agent-client.ts`, the worker): no `AbortSignal.timeout`, `AbortSignal.any`, `Promise.withResolvers`; no `crypto.randomUUID` in new code (insecure LAN origins): ids are `Math.random().toString(36).slice(2, 12) + Date.now().toString(36)`; the WebSocket URL is absolute (`new URL(path, self.location.href)`, `http`→`ws`).
- The hook tests' fetch fakes return `{ ok, status, json }` without `headers`: read response headers as `res.headers?.get?.(…) ?? null`.
- Constants (spec values, names fixed): `WS_HEARTBEAT_MS = 10_000`, `WS_SILENCE_MS = 25_000`, `VISIBLE_PROBE_MS = 3_000`, ack timeout `10_000 + Math.ceil(bytes / 32)` ms, `SEND_DEADLINE_MS = 15_000`, `SESSION_LINGER_MS = 30_000`, reconnect 1 s doubling to 30 s (existing `RECONNECT_MIN_MS`/`RECONNECT_MAX_MS`), `DEDUPE_WINDOW_MS = 120_000`, `DEDUPE_MAX = 500`, `WS_COALESCE_BYTES = 256 * 1024`, `MAX_COMMAND_FRAME_BYTES = MAX_AGENT_COMMAND_REQUEST_BYTES + 64 * 1024`, `METRICS_FLUSH_MS = 30_000`, `METRICS_FLUSH_COUNT = 200`, `METRICS_BUFFER_MAX = 2_000`, `EVENT_SAMPLE_MS = 1_000`, `WAKE_WINDOW_MS = 60_000`, `BATCH_WINDOW_MS = 2_000`, `SSE_CLOCK_PROBES = 3`; metrics POST ≤ 256 KiB and ≤ 1 000 samples, sample JSON ≤ 4 096 bytes, `metric` ≤ 32 chars, `ua` ≤ 200 chars, JSONL rotated to `.1` above 20 MiB.
- Idempotent commands: `type.startsWith("get_") || type === "predict_word"`. A command's `bytes` is the string length of its JSON body (one `JSON.stringify` in the tab). Close codes on browser sockets: 1007 bad frame, 1009 oversize, 1011 handler failure, 4000 client-side forced reconnect.
- New UI strings in `lib/i18n/locales/en.json`, `ja.json`, `zh-CN.json` (flat keys): `settingsConfig.browserTransport` "Browser connection (experiment)", `settingsConfig.browserTransportDesc` "How browsers receive live updates and send chat commands. Server-sent events + HTTP is the default. WebSocket opens one connection for the app and one per open session. Every open browser switches within a few seconds.", `settingsConfig.browserTransportSse` "Server-sent events + HTTP (default)", `settingsConfig.browserTransportWebSocket` "WebSocket", `settingsConfig.browserTransportSaveFailed` "Could not save the connection setting", `errors.transport_unavailable` "Not sent: no connection to omp-web. Try again.", `errors.transport_lost` "The connection to omp-web dropped before the answer arrived. The command may have run; check before sending it again."
- Green bar: every task ends with `npm run typecheck && npm run lint && npm test` green. Line numbers are hints; locate code by symbol.

## Review Focus

1. **A network switch on the phone with several sockets open** (general + 2 sessions, dedicated worker): `online` closes and redials every socket at once, each resubscribes its own streams and gets the snapshot, a late frame from a replaced socket is ignored, and each socket yields one `reconnect` sample with `batch` 3 (Task 5 "wake online…", Task 7 reconnect sample test).
2. **Stop during an image upload in the same session:** the abort queues behind the ~8 MB prompt on that socket, is sent exactly once, and its sample has `behindBytes > 0`; the prompt's ack timer allows `10 000 + 250 000` ms for 8 000 000 bytes, so a slow upload is not a hang (Task 6 "an abort behind a large prompt…").
3. **The server restarts between send and reply:** a non-idempotent command is never sent to a second `serverId` (answers `transport_lost`), `get_state` is resent, a known `rid` runs once on one server (Task 3 dedupe test, Task 6 resend test).
4. **Flipping the mode with streams and commands in flight:** every tab stream ends OPEN on the new transport exactly once (no duplicate `sub`), pending socket commands settle on their retiring socket, a `cmd` reaching an SSE-mode worker falls back to HTTP, and an old worker script ignores the new control frames (Task 5 switch tests, Task 6 fallback test, Task 2 hello test).
5. **Garbage on a browser socket:** malformed JSON, unknown `t`, oversize frames, a failing channel open or a throwing handler close only that socket and never reach `uncaughtException` or the host links; unauthenticated and cross-origin upgrades never get a socket (Task 3 unit and `server/app.test.ts` tests).

## Inventory (counts at `03a3b2d8`, over `components/ hooks/ lib/ app/ server/ scripts/ public/`)

| Surface | Hits | Files | Task |
|---|---|---|---|
| `sendAgentCommand(` call sites (callers unchanged; routing inside `lib/agent-client.ts`) | 60 calls, 48 command types | `hooks/useAgentSession.ts` 49, `hooks/useBtw.ts` 4, `components/ChatWindow.tsx` 2, `components/SubagentTranscriptDialog.tsx` 2, `components/AppShell.tsx` 1, `components/PluginsConfig.tsx` 1, `components/SkillDiagnostics.tsx` 1 (+ 1 mention in `hooks/useAgentSession.rpc.test.mjs`) | 6, 7 |
| …idempotent by rule (`get_*`, `predict_word`) | 13 calls, 9 types | `get_state` ×4, `get_subagents` ×2, `get_commands`, `get_btw_history`, `get_session_stats`, `get_last_assistant_text`, `get_skill_diagnostics`, `get_subagent_messages`, `predict_word` | 6 |
| …non-idempotent | 47 calls, 39 types | `prompt` ×3, `steer`, `follow_up`, `abort*` ×6 types, queue ops, `bash`, `compact` ×2, `set_*`, `host_*_result`, … | 6 |
| Other `lib/agent-client.ts` exports | `setSessionAdvisorSpawn(` 4, `new HostOfflineError(` 3 | `useAgentSession.ts` 4 + 2, `agent-client.ts` 1 | 6 (advisor rides the `cmd` frame) |
| `fetch` of `GET /api/agent/[id]` (stay HTTP) | 8 | `useAgentSession.ts` | — |
| `POST /api/agent/new` (stays HTTP) | 1 | `useAgentSession.ts` | — |
| `openEventStream(` call sites (unchanged) | 6 | `AppShell.tsx` host-tools, `FileViewer.tsx` file, `SessionSidebar.tsx` running, `useHostRows.ts` hosts, `useNotifications.ts` notifications → general socket; `useAgentSession.ts` session → session socket | 5 |
| Worker subscribe paths | `requestServer(` 2 calls (subscribe in `subscribe()`, unsubscribe in `close()`); resubscribe on `hello` 1, on `end` 1 | `public/event-stream-worker.js` | 5 (socket `sub`/`unsub` frames in WS mode) |
| Server subscribe paths | `connection.subscribe` 1, `.unsubscribe` 1, `new EventStreamConnection(` 1 (+1 test) | `app/api/events/route.ts`, `lib/event-stream-hub.test.mjs` | 2, 3 |
| `LinkSocketData` | 15 | `server/app.ts` 7, `server/routes.ts` 3, `lib/hosts/hub.ts` 3, `app/api/hosts/link/route.ts` 2 | 3 (server files widen to `ServerSocketData`; hub and link route unchanged) |
| `MuxControlFrame` | 4 | `event-stream-protocol.ts` 2, `event-stream-hub.ts` 2 | 2 |
| Source-text assertions on `app/api/agent/[id]/route.ts` | 6 tests | `lib/api-contract.test.mjs` | 1 |
| Full-object settings `deepEqual`s | 5 | `lib/web-settings.test.mjs` | 2 |
| `hello` shape assertions | 1 `deepEqual` + 1 regex | `lib/event-stream-hub.test.mjs` (`connect`), `server/app.test.ts` | 2 |
| Other `EventSource` | 1 (login SSE, unchanged) | `components/ModelsConfig.tsx` | — |

Order: 1 → 2 → 3 → 5 → 6 → 7 → 8; Task 4 depends on nothing and may run beside 1–3 (it and Task 3 each add one `ROUTE_MODULES` entry: rebase, keep both).

---

### Task 1: One command function for the route and the socket

**Files:**
- Create: `lib/agent-command.ts`
- Modify: `app/api/agent/[id]/route.ts`, `lib/api-contract.test.mjs`
- Test: `lib/agent-command.test.mjs`

**Interfaces:**
- Produces: `export async function runAgentCommand(id: string, body: unknown, advisor: boolean): Promise<Response>` (everything `POST` does after parsing: type check → 400 `command_type_required`, `NO_SPAWN_REPLIES`, `LIVE_SESSION_ONLY`, fast path, spawn, cold `set_model`; never throws: errors go through `commandErrorResponse`); `export function commandErrorResponse(error: unknown): Response` (moved unchanged). The route's `POST` and `GET` answers carry `x-omp-received-at` (ms at handler entry) and `x-omp-replied-at` (ms just before returning).

- [ ] **Step 1: Install.** `npm ci` (prints `added … packages`).
- [ ] **Step 2: Write the failing tests** in `lib/agent-command.test.mjs` (register fake wrappers in `globalThis.__ompSessions` as `lib/event-stream-hub.test.mjs` does: `{ isAlive: () => true, advisorSpawned: false, isRunning: () => false, isEditingHistory: () => false, send: async (body) => … }`):
  - `"runAgentCommand answers a live session exactly as the route"`: `get_state` through `runAgentCommand("s1", body, false)` and through `route.POST` give the same status and JSON `{ success: true, data }`; `send` saw the body verbatim twice.
  - `"a missing type is 400 command_type_required; a no-spawn command without a wrapper gets its canned reply"`: `{}` → 400 `{ code: "command_type_required" }`; `{ type: "predict_word" }` on an unknown id → 200 `{ success: true, data: { suffix: null } }`.
  - `"POST and GET answers carry received/replied times"`: both headers parse as integers with `before ≤ received ≤ replied ≤ after`; an invalid JSON body (400) carries them too.
  - `lib/api-contract.test.mjs`: the assertions on moved code read `lib/agent-command.ts` instead of the route — the `NO_SPAWN_REPLIES` table test; `command_type_required` + `instanceof RpcCommandError` + `status: 400`; `status: 413`; `startRpcSession(id, target.sessionFile, …advisor` + `existing.send(body)`; the whole `#277` test. The route keeps `parseJsonWithinLimit<…>(req, MAX_AGENT_COMMAND_REQUEST_BYTES)`, `RequestBodyTooLargeError` and `searchParams.get("advisor") === "1"`.
- [ ] **Step 3: Run** `bun test lib/agent-command.test.mjs lib/api-contract.test.mjs` — FAIL (module missing).
- [ ] **Step 4: Implement.** Move the code; `POST` = parse (catch → `commandErrorResponse`) → `runAgentCommand(id, body, advisor)` → set both headers on the returned `Response` (headers of `Response.json` are mutable).
- [ ] **Step 5: Run** `bun test lib/agent-command.test.mjs lib/api-contract.test.mjs lib/agent-skill-diagnostics-route.test.mjs && npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 6: Commit** `refactor(agent): share the command path; timing headers on /api/agent/[id]`.

### Task 2: The setting, emit times and transport control frames

**Files:**
- Modify: `lib/web-settings.ts`, `app/api/web-settings/route.ts`, `lib/event-stream-protocol.ts`, `lib/event-stream-hub.ts`
- Test: `lib/web-settings.test.mjs`, `lib/event-stream-hub.test.mjs`, `lib/api-contract.test.mjs` (web-settings route test)

**Interfaces:**
- Produces:
  - `lib/event-stream-protocol.ts`: `export type BrowserTransport = "sse" | "websocket";` `MuxControlFrame` = `hello {connectionId, serverId, transport}` | `open {sub}` | `end {sub}` | `refused {sub, status, error, code}` | `transport {transport}`.
  - `lib/web-settings.ts`: `WebServerSettings.browserTransport: BrowserTransport` (default `"sse"`, only the literal `"websocket"` reads as WebSocket).
  - `lib/event-stream-hub.ts`: `export interface FrameSink { write(name: string, at: number, data: string): boolean; backpressured(): boolean; heartbeat(): boolean; readonly heartbeatMs: number; close(): void }`; `constructor(signal?: AbortSignal, sink?: FrameSink)` (no sink → the SSE sink and `stream`; with a sink `stream` is `null`); public `control(frame: MuxControlFrame): void` and `resume(): void` (flush coalesced updates; the socket's `drain`); `export function serverId(): string` (`globalThis.__ompServerId ??= randomUUID()`); `export function broadcastBrowserTransport(transport: BrowserTransport): void`.
  - SSE frame: `event: <name>\nid: <at>\ndata: <json>\n\n`; heartbeat stays `":\n\n"` every 30 s.

- [ ] **Step 1: Write the failing tests**
  - web-settings: the five full-object `deepEqual`s gain `browserTransport: "sse"`; `test("browserTransport round-trips and anything but websocket reads as sse")`: save `"websocket"` → loads `"websocket"`; a file with `"ws"` or `true` → `"sse"`.
  - hub `connect()`: hello deep-equals `{ type: "hello", connectionId: connection.id, serverId: <the same string for two connections>, transport: "sse" }`.
  - `"every SSE frame carries its emit time as id"`: subscribe `hosts`; the raw `open` and data chunks match `/^id: (\d+)$/m` with `before ≤ id ≤ after`.
  - `"broadcastBrowserTransport reaches every open connection"`: two connections each read `{ event: "mux", data: { type: "transport", transport: "websocket" } }`.
  - `"a sink connection writes name/at/data, coalesces while backpressured and flushes on resume"`: a fake sink recording writes; with `backpressured()` true three `message_update`s then `resume()` with it false → one write carrying the last; `heartbeat()` called every `heartbeatMs` (mock timers).
  - route: `PUT {"browserTransport":"ws"}` → 400 `invalid_settings`; `PUT {"browserTransport":"websocket"}` → 200 body has it, an open connection reads the `transport` frame, `GET` returns it; a PUT without the key broadcasts nothing.
- [ ] **Step 2: Run** `bun test lib/web-settings.test.mjs lib/event-stream-hub.test.mjs` — FAIL.
- [ ] **Step 3: Implement.** Hello reads `loadWebServerSettings().browserTransport`; the hub imports the setting and the PUT route imports `broadcastBrowserTransport` (called only when the key was present). `deliver()` uses `sink.backpressured()`; the SSE sink keeps today's `desiredSize < 0`, `pull` and `cancel`.
- [ ] **Step 4: Run** `bun test lib/web-settings.test.mjs lib/event-stream-hub.test.mjs lib/event-stream-worker.test.mjs server/app.test.ts && npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(events): browserTransport setting, emit times and transport control frames`.

### Task 3: The browser WebSocket endpoint

**Files:**
- Create: `lib/browser-socket.ts`, `app/api/events/ws/route.ts`
- Modify: `server/routes.ts`, `server/app.ts`
- Test: `lib/browser-socket.test.mjs`, `server/app.test.ts`

**Interfaces:**
- Consumes: Task 1 `runAgentCommand`, `commandErrorResponse`; Task 2 `FrameSink`, `EventStreamConnection`, `serverId`, `control`.
- Produces:
  - `export interface BrowserSocketData { kind: "browser"; sessionId: string | null; connection: EventStreamConnection | null }`
  - `export interface BrowserSocket { readonly data: BrowserSocketData; send(data: string): number; close(code?: number, reason?: string): void; getBufferedAmount(): number }` (structural, like `LinkSocket`)
  - `export function handleBrowserSocketUpgrade(req: Request, upgrade: (data: BrowserSocketData) => boolean): Response | undefined` — 400 `invalid_event_stream_request` for an empty or > 512-char `session`, 426 when `upgrade` returns false.
  - `export const browserSocket = { open(ws), message(ws, data: string | Uint8Array), drain(ws), close(ws) }` — wire format: spec D4; dedupe: spec D3.
  - `server/routes.ts`: `export type ServerSocketData = LinkSocketData | BrowserSocketData;` the route context's `upgrade` takes `ServerSocketData`; table key `"events/ws"`.
  - `server/app.ts`: `Bun.serve({ websocket })` spreads `hostLinkSocket` for its limits and dispatches `open`/`message`/`drain`/`close` on `ws.data.kind === "browser"` (a type guard); link sockets behave exactly as before.

- [ ] **Step 1: Write the failing tests** (`lib/browser-socket.test.mjs`; fake socket records `send`s, `close(code)`; parse a frame with `const [head, json] = [s.slice(0, s.indexOf("\n")), s.slice(s.indexOf("\n") + 1)]`):
  - `"open sends hello with connectionId, serverId and transport"`.
  - `"sub opens a channel; a refused sub answers refused and keeps the socket"`: `session` channel of an unmanaged id → `mux` `{ type: "refused", sub: "s1", status: 409, code: "session_not_managed" }`, socket open; `hosts` → `mux open` then an `s2` frame.
  - `"cmd on a session socket acks, then replies with the route's status and body"`: fake wrapper; frames in order `ack {rid}` then `reply {rid, status: 200, body: { success: true, data }}`, ack `at` ≤ reply `at`. The frame's `advisor` arrives: an idle fake with `advisorSpawned: true` answers through `send` for `advisor: true` (the fast path) and is never destroyed.
  - `"one rid runs once: a duplicate joins in flight, a later one replays with deduped"`: `send` resolves after a held promise; two `cmd` with `rid: "r1"` → `send` called once, two replies; a third after settle → `reply.deduped === true`, still one call. Entries beyond `DEDUPE_MAX` drop oldest settled first.
  - `"cmd on the general socket is 400 invalid_event_stream_request"`.
  - `"bad frames close the socket: 1007 for bad JSON or t, 1009 over MAX_COMMAND_FRAME_BYTES, 1011 when a handler throws"`: a socket whose `send` throws on the reply → close 1011, no throw escapes `message`.
  - `"ping answers pong with c"`; `"close releases every subscription"` (running listener count back to baseline, as the hub test does).
  - `"upgrade: 426 without an upgrade, 400 for a bad session, data carries the session id"`.
  - `server/app.test.ts`, in `"Bun's idle timeout spares…"`: a `new WebSocket(url("/api/events/ws").href.replace(/^http/, "ws"), { headers: signedIn } as unknown as string[])` gets a `hello`, is still OPEN after the 20 s wait, and `{t:"sub",id:"s1",channel:{kind:"hosts"}}` gets `mux` `open`. In the refusal test (password set): `fetch(url("/api/events/ws"))` → 401; with `signedIn` and `origin: "http://evil.example"` → 403; with `signedIn` and no upgrade → 426.
- [ ] **Step 2: Run** `bun test lib/browser-socket.test.mjs server/app.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `open`: `new EventStreamConnection(undefined, sink)` with `write = ws.send("<name> <at>\n<data>") !== 0` (Bun: bytes sent, `-1` queued under backpressure, `0` dropped), `backpressured = getBufferedAmount() > WS_COALESCE_BYTES`, `heartbeatMs = WS_HEARTBEAT_MS` sending `ping`. Every handler body runs in one `guarded(ws, fn)` (log + `close(1011)`), and the command promise chain ends in a `.catch` that does the same.
- [ ] **Step 4: Run** `bun test lib/browser-socket.test.mjs server/app.test.ts lib/hosts && npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(events): browser WebSocket endpoint with command dedupe`.

### Task 4: Metrics endpoint, JSONL store and summary script

**Files:**
- Create: `lib/transport-metrics.ts`, `app/api/transport-metrics/route.ts`, `scripts/transport-metrics.ts`
- Modify: `server/routes.ts` (key `"transport-metrics"`)
- Test: `lib/transport-metrics.test.mjs`, `scripts/transport-metrics.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/transport-metrics` → `{ now: number }`, `cache-control: no-store` (the SSE clock probe).
  - `POST /api/transport-metrics` `{ samples: object[] }` → `{ written: number }`; 400 `invalid_transport_metrics` for a non-object body, a missing array or > 1 000 samples; 413 above 256 KiB (`parseJsonWithinLimit`).
  - `lib/transport-metrics.ts`: `export function transportMetricsPath(): string` (`<getAgentDir()>/omp-web/transport-metrics.jsonl`); `export function appendTransportSamples(samples: unknown[], ua: string | null): number` — keeps plain objects with a string `metric` ≤ 32 chars whose JSON is ≤ 4 096 bytes, adds `serverAt` and `ua` (≤ 200 chars), rotates to `.jsonl.1` (replacing it) when the file is over 20 MiB before appending, one `appendFileSync`.
  - `scripts/transport-metrics.ts`: `export function percentile(values: number[], p: number): number | null` (nearest rank); `export function summarize(samples: Record<string, unknown>[], options: { since?: number; until?: number; client?: string }): SummaryRow[]` with `SummaryRow = { section: string; transport: string; key: string; count: number; p50: number | null; p95: number | null; max: number | null }`; `export function formatReport(rows: SummaryRow[]): string`; CLI (`import.meta.main`) with `--since <2h|30m|ISO>` (default 24h), `--until <ISO>`, `--client <id>`, `--file <path>` (reads `.1` then the file, filters on `serverAt`). Sections and derived values: spec D6.

- [ ] **Step 1: Write the failing tests**
  - `"POST keeps valid samples, stamps them and answers the count"` (temp `PI_CODING_AGENT_DIR`): 3 valid + a string + one with a 5 000-char field + one without `metric` → `{ written: 3 }`; three lines, each with `serverAt` within the call and `ua` from the request; 1 001 samples → 400.
  - `"the store rotates above 20 MiB"`: `truncateSync` the file to 20 MiB + 1 → after one append `.1` has that size and the file holds only the new line.
  - `"GET answers now"`: within `[before, after]`, `cache-control: no-store`.
  - `scripts/transport-metrics.test.ts`: `percentile([10,20,30,40,100], 50) === 30`, `…95) === 100`, `percentile([], 50) === null`; `summarize` over a fixture with both transports gives the `action totalMs` rows per transport, `transportMs = total − (repliedAt − recvAt)`, event `ms = gotAt + offset − at`, reconnect `ms` from `startAt` and mean `batch`; an `abort` with `behindBytes > 0` lands in the `abort behind upload` row; a `hang` whose `req` has an action counts under `answered later`; `since`/`until`/`client` filter; `formatReport` prints one line per row.
- [ ] **Step 2: Run** `bun test lib/transport-metrics.test.mjs scripts/transport-metrics.test.ts` — FAIL.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run** those tests, `bun scripts/transport-metrics.ts --file <fixture written by the test dir>` prints the table, then `npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(metrics): transport sample endpoint, JSONL store and summary script`.

### Task 5: Worker WebSocket mode for channels

**Files:**
- Modify: `public/event-stream-worker.js`, `lib/event-stream.ts`, `lib/event-stream-protocol.ts` (header comment: the WS framing)
- Test: `lib/event-stream-worker.test.mjs`

**Interfaces:**
- Consumes: Task 2 hello/`transport`/`refused` frames; Task 3 wire format.
- Produces (tab ↔ worker, additive):
  - worker → tab `{ transport: BrowserTransport }`: to a tab when it attaches (once known) and to all tabs on every change.
  - tab → worker `{ op: "wake", reason: "init" | "visible" | "hidden" | "online" | "network", visible: boolean, clientId: string }`: on `Transport` construction, `visibilitychange`, `online`, `navigator.connection` `change`. `clientId` from `localStorage` `omp-web:transport-client-id` (created once; a per-load id when storage throws).
  - `lib/event-stream.ts`: `export function transportMode(): BrowserTransport` (`"sse"` until the worker says otherwise, and without a transport).
  - Worker state shared by Tasks 6–7: `mode`; `conns: Map<"general" | "session:<id>", Conn>` with `Conn = { key, sessionId, ws, serverId, connectionId, subs: Set, pending: Map, lastFrameAt, reconnectDelayMs, reconnectTimer, lingerTimer, retiring, clock, lastEventSampleAt, reconnect }`; the EventSource side gets the same `clock`/`lastEventSampleAt`/`reconnect` fields in one `sseConn` object. Each subscription records its `conn`; a frame or control from a socket that is not `conn.ws` any more is ignored.

Behaviour: spec D2, D5 (mode switch, linger, heartbeat, reconnect, wake). In SSE mode the existing code paths run unchanged.

- [ ] **Step 1: Write the failing tests.** Extend `loadWorker` with a `FakeWebSocket` (`url`, `readyState`, `sent` (parsed JSON), `bufferedAmount`, `close(code)`, `open()`, `frame(name, at, payload)`, `drop()`), `location: { href: "https://example.test/" }`, a controllable `Date` (`{ now: () => clock.now }`), `setInterval`/`clearInterval`. Existing tests stay as they are.
  - `"a hello saying websocket moves every stream to a general socket and one socket per session"`: tab opens running, file, session a, session b; SSE hello with `transport: "websocket"` → EventSource closed; sockets `wss://example.test/api/events/ws`, `…?session=a`, `…?session=b`; after each socket's `open` + hello, `sub` frames: general running+file, a session a, b session b; `mux open` → tab `{ id, type: "open" }`; tab got `{ transport: "websocket" }`.
  - `"a transport control switches back: sockets close and one EventSource resubscribes everything"`.
  - `"a session socket lingers 30 s after its last stream, and a stream within the linger reuses it"`; the general socket closes as soon as it has no stream.
  - `"25 s of silence reconnects with backoff and resubscribes on the next hello; frames from the old socket are ignored"`.
  - `"wake online redials every socket at once; wake visible probes and redials only a socket silent for 3 s"`.
  - `"refused fails only its stream as CLOSED"`; `"end resubscribes after 3 s on the same socket"`.
- [ ] **Step 2: Run** `bun test lib/event-stream-worker.test.mjs` — FAIL (new tests only).
- [ ] **Step 3: Implement** in the worker and the tab (`Transport` stores the mode, sends `wake`; the `pageshow` resume path unchanged).
- [ ] **Step 4: Run** `bun test lib/event-stream-worker.test.mjs hooks/useAgentSession.rpc.test.mjs && npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(worker): WebSocket mode with a general socket and one per session`.

### Task 6: Agent commands over the session socket

**Files:**
- Modify: `public/event-stream-worker.js`, `lib/event-stream.ts`, `lib/agent-client.ts`, `lib/i18n/locales/{en,ja,zh-CN}.json` (`errors.transport_unavailable`, `errors.transport_lost`)
- Test: `lib/event-stream-worker.test.mjs`, `lib/agent-client.test.mjs` (DOM: import `tests/setup-dom.mjs` first)

**Interfaces:**
- Consumes: Task 3 `cmd`/`ack`/`reply`; Task 5 `Conn`, `transportMode()`.
- Produces:
  - tab → worker `{ op: "cmd", n: number, req: string, sessionId: string, advisor: boolean, body: string }` (`body` = the command's JSON, stringified once by the tab; the worker builds the frame by concatenation, `{"t":"cmd","rid":<req>,"advisor":…,"command":` + body + `}`).
  - worker → tab `{ cmd: n, http: true }` (worker in SSE mode) or `{ cmd: n, status, body, recvAt: number | null, repliedAt: number | null, attempts: number, deduped: boolean, behindBytes: number }`. Local answers: 413 `{ error: "Agent command is too large", code: "request_too_large" }` above `MAX_AGENT_COMMAND_REQUEST_BYTES` (the worker mirrors the constant); 503 `{ error, code: "transport_unavailable" }`; 503 `{ error, code: "transport_lost" }`.
  - `lib/event-stream.ts`: `export interface CommandReply { status: number; body: unknown; via: "ws" | "http"; recvAt: number | null; repliedAt: number | null; attempts: number; deduped: boolean; behindBytes: number }`; `export function sendSessionCommand(sessionId: string, req: string, body: string, advisor: boolean): Promise<CommandReply | null> | null` — `null` unless `transportMode() === "websocket"`; resolves `null` on `{ http: true }`; `Transport.fail()` resolves pending ones with 503 `transport_lost`.
  - `lib/agent-client.ts`: `sendAgentCommand` signature and error mapping unchanged; it computes `req` and the body string once, uses `sendSessionCommand` and falls back to the HTTP POST (which returns a `CommandReply` with `via: "http"` and the Task 1 headers).

Behaviour: spec D5 "Commands" and "Resend". The session socket stays open while `pending` is non-empty; linger starts when it empties.

- [ ] **Step 1: Write the failing tests** (worker):
  - `"a command opens its session socket, is sent after hello, and the reply reaches the tab"`: the frame parses to `{ t: "cmd", rid: req, advisor, command }`; `ack` then `reply` → tab `{ cmd, status: 200, body, recvAt, repliedAt, attempts: 1, deduped: false }`.
  - `"a missed ack is a hang: the socket redials and the command is resent once with the same rid"`: a 3 200-char body → at 10 099 ms nothing, at 10 100 ms the socket closes (4000); after the new hello the same `rid` is sent again.
  - `"after a drop, non-idempotent commands are resent only to the same serverId"`: `prompt` sent under `srv1`, drop, hello `srv2` → tab gets 503 `transport_lost`, no resend; same with `get_state` → resent; `prompt` with hello `srv1` → resent, `attempts: 2`; a second drop → `transport_lost`.
  - `"a command not sent within 15 s answers transport_unavailable; an oversize one answers 413 locally"`.
  - `"an abort behind a large prompt waits on the same socket, is sent once, and reports behindBytes"`: an 8 000 000-char prompt, then `bufferedAmount = 8_000_000`; the abort reply carries `behindBytes: 8000000`; the prompt's ack timer does not fire before 260 000 ms.
  - `"in SSE mode a cmd answers http: true"`; `"switching to SSE keeps a socket until its pending command settles, then closes it"`.
  - `lib/agent-client.test.mjs` (fake `SharedWorker` that reports `{ transport: "websocket" }` and answers `cmd`): `"websocket mode goes through the worker and maps errors like HTTP"` (200 → data; 503 `{ hostOffline: true, delivery: "unknown" }` → `HostOfflineError` with `mayHaveRun`; `{ code: "transport_lost" }` → the localized message); `"http: true falls back to POST /api/agent/<id>?advisor=1"`; `"sse mode uses fetch, and a fetch fake without headers works"`.
- [ ] **Step 2: Run** `bun test lib/event-stream-worker.test.mjs lib/agent-client.test.mjs` — FAIL.
- [ ] **Step 3: Implement** worker `cmd` handling (queue → send on hello → ack timer → reply; resend rules; deadlines), the tab's `cmd` routing, `agent-client` routing, and the two locale keys in all three files.
- [ ] **Step 4: Run** `bun test lib/event-stream-worker.test.mjs lib/agent-client.test.mjs hooks/useAgentSession.rpc.test.mjs && npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(worker): agent commands over the session socket`.

### Task 7: Instrument both transports

**Files:**
- Modify: `public/event-stream-worker.js`, `lib/event-stream.ts`, `lib/agent-client.ts`
- Test: `lib/event-stream-worker.test.mjs`, `lib/agent-client.test.mjs`

**Interfaces:**
- Consumes: Task 4 endpoint; Task 5 `Conn`/`sseConn`, `wake`; Task 6 `CommandReply`.
- Produces: tab → worker `{ op: "metric", sample: object }`; `lib/event-stream.ts` `export function recordTransportSample(sample: Record<string, unknown>): void` (posts only when a transport exists; never constructs one). Sample schema and derived values: spec D6. The worker stamps `transport`, `clientId`, `effectiveType`, `visible` on every sample that lacks them, and `offset`/`offsetRtt` (best current clock) on `action` samples.

Exact rules:
- Clock: WS `pong` → `offset = at − (c + now) / 2`, `rtt = now − c`, keep the min-RTT sample per `Conn`; the client sends `{t:"ping", c}` on `open` and on every server `ping`. SSE: after each `hello`, `SSE_CLOCK_PROBES` sequential `fetch("/api/transport-metrics")`.
- Event: SSE `Number(event.lastEventId)`, WS the frame's `at`; at most one per connection per `EVENT_SAMPLE_MS`; the connection's clock, else the worker's best (min RTT across `conns` and `sseConn`); none before any clock exists.
- Reconnect: `dropAt` when the drop is noticed (EventSource `onerror`, socket `close`, silence, missed ack, forced wake), `startAt` = latest wake within `WAKE_WINDOW_MS` before `dropAt`, else `dropAt`; ends at the first `open` control or channel frame after the new `hello`; `batch` = reconnect starts within `BATCH_WINDOW_MS` of this one (worker-wide list of recent starts).
- Hang: WS in the Task 6 ack timer; HTTP in `agent-client` with the same formula, once per request, not aborting the fetch.
- `behindBytes`: WS `ws.bufferedAmount` at send (Task 6); HTTP the summed body bytes of this tab's unanswered POSTs for the same session.
- Flush: `POST /api/transport-metrics` every `METRICS_FLUSH_MS` or at `METRICS_FLUSH_COUNT`; on failure keep; above `METRICS_BUFFER_MAX` drop the oldest and add one `{ metric: "dropped", count }` to the next batch.

- [ ] **Step 1: Write the failing tests**
  - `"a pong sets the min-RTT clock and event samples measure gotAt + offset − at"`: server clock 5 000 ms ahead, RTT 40 then 10 → `offset` from the 10 ms sample; a frame stamped `at` 5 ms before receipt (server time) → `ms` 5.
  - `"SSE: three clock probes after hello, then lastEventId gives event samples"`.
  - `"at most one event sample per connection per second"`.
  - `"a reconnect sample runs from the wake to the first open after resubscribe, with batch = sockets redialed together"`: wake online with 3 sockets → three samples, `batch: 3`, `startAt` = wake time.
  - `"samples flush at 200 or every 30 s, survive a failed POST, cap at 2 000 and report dropped"`.
  - `"every sample carries transport, clientId, effectiveType and visible"` (`navigator.connection = { effectiveType: "3g" }`; a tab `wake` with `visible: false`).
  - `lib/agent-client.test.mjs`: `"an HTTP action sample uses the timing headers and counts behindBytes of the same session"`; `"an HTTP command slower than the ack formula records one hang, then its action"`; `"a socket action sample carries attempts, deduped, recvAt and repliedAt"`.
- [ ] **Step 2: Run** `bun test lib/event-stream-worker.test.mjs lib/agent-client.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the rules above.
- [ ] **Step 4: Run** `bun test lib/event-stream-worker.test.mjs lib/agent-client.test.mjs hooks/useAgentSession.rpc.test.mjs && npm run typecheck && npm run lint && npm test` — PASS.
- [ ] **Step 5: Commit** `feat(metrics): instrument both browser transports`.

### Task 8: Settings control, docs and an end-to-end run

**Files:**
- Modify: `components/SettingsConfig.tsx` (a `SETTINGS` entry `{ id: "browser-transport", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", … scope: "UI" }` and a `BrowserTransportSetting` rendered in Interface & Behavior), `lib/i18n/locales/{en,ja,zh-CN}.json` (the five `settingsConfig.browserTransport*` keys), `AGENTS.md`
- Test: `components/SettingsConfig.browser-transport.test.mjs`

**Interfaces:**
- Consumes: Task 2 `GET`/`PUT /api/web-settings`.
- Produces: `BrowserTransportSetting` — a `<select>` (`nativeSelectStyle`, like `word-completion`) with `sse`/`websocket`, loaded from `GET /api/web-settings` (disabled until loaded), `PUT { browserTransport }` on change, restore + `toast.error(t("settingsConfig.browserTransportSaveFailed"), …)` on failure (the `AutoResumeSessionsSetting` pattern).

- [ ] **Step 1: Write the failing test** `"the browser transport select shows the saved value and saves a change"`: fetch fake answers `{ browserTransport: "sse" }`; select value `sse`; choosing `websocket` sends one `PUT` with `{"browserTransport":"websocket"}`; a 500 answer restores `sse`.
- [ ] **Step 2: Run** `bun test components/SettingsConfig.browser-transport.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the control and the locale keys (en copy from Global Constraints; ja and zh-CN translated).
- [ ] **Step 4: Docs.** AGENTS.md "Live event stream": a "WebSocket mode (experiment)" bullet list — the switch and the exact flip command (spec D1), general vs session sockets and linger, `/api/events/ws` gated in `handle()`, the frame format, `runAgentCommand` as the one command path, dedupe and the resend rule, the SSE `id:` emit time and the extended `hello`, the metrics file and `bun scripts/transport-metrics.ts`. File map: `lib/agent-command.ts`, `lib/browser-socket.ts`, `lib/transport-metrics.ts`, `app/api/events/ws/route.ts`, `app/api/transport-metrics/route.ts`, `scripts/transport-metrics.ts`.
- [ ] **Step 5: End to end** (temp `HOME` and `PI_CODING_AGENT_DIR`, `OMP_WEB_OMP_BIN=/nonexistent/omp`, no password; no daemon, so no sessions are listed): `npm run build && bun server/main.ts -H 127.0.0.1 -p 30331`. In Chromium (the eval `browser`), open `http://127.0.0.1:30331/`; `ss -Htn state established '( sport = :30331 )' | wc -l` notes the count. `curl -sS -X PUT http://127.0.0.1:30331/api/web-settings -H 'content-type: application/json' -d '{"browserTransport":"websocket"}'`; within 5 s the page shows no error, the sidebar and Settings → Hosts still load, and the count changes (the EventSource is gone, the general socket is up). The session path, against the same server from a Bun one-liner: `new WebSocket("ws://127.0.0.1:30331/api/events/ws?session=e2e")`, after its `hello` send `{"t":"cmd","rid":"e2e-1","advisor":false,"command":{"type":"predict_word","text":"he","cursor":2}}` → `ack` then `reply` with `{"status":200,"body":{"success":true,"data":{"suffix":null}}}` (a no-spawn reply, no omp needed); the same `rid` again → `"deduped":true`. Emulate offline → online in the page (CDP `Network.emulateNetworkConditions`); after 30 s `bun scripts/transport-metrics.ts --since 10m --file $PI_CODING_AGENT_DIR/omp-web/transport-metrics.jsonl` prints `event` and `reconnect` rows for `websocket` (trigger `online`). Flip back to `sse`: the page resubscribes over one EventSource and no socket remains. Stop the server.
- [ ] **Step 6: Run** `npm run typecheck && npm run lint && npm test && npm run smoke` — PASS.
- [ ] **Step 7: Commit** `feat(settings): browser transport switch; document the experiment`.
