# Shared provider credentials for linked hosts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a linked host with sharing turned on runs its omp sessions with the web server machine's provider logins, through omp's own auth broker.

**Architecture:** the web server runs `omp auth-broker serve` on loopback as an idle-stopped child and exposes an allow-listed forwarding route that authenticates the host token. The host daemon runs a loopback forwarder with a per-run secret and starts omp with `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` pointing at it, so the host token never enters a child environment. A per-host registry flag and link protocol v9 decide which spawns get it.

**Tech Stack:** TypeScript; server on Bun; daemon modules on Node through `jiti`; tests `bun test --parallel`.

**Spec:** `docs/specs/2026-11-10-shared-credentials-design.md` (C1–C7). Read it first.

**Base:** the branch contains `feat/transparent-host-pool` (merged at `0425e39b`), which owns link protocol 8. Line numbers in this plan predate that merge, so locate code by the names given.

## Global Constraints

- `LINK_PROTOCOL_VERSION = 9`, `MIN_LINK_PROTOCOL_VERSION = 4` (literal one-line exports: the deploy script `sed`s them).
- Daemon-loaded files (`lib/hosts/daemon*.ts`, `host.ts`, `host-resume.ts`, `local-host.ts`, `link-protocol.ts`, the new `lib/hosts/daemon-broker.ts`, and their `lib/` imports): relative imports only, no `Bun` global.
- ompweb never imports `@oh-my-pi/*` and never reads `agent.db`.
- A host with sharing on never runs a session with its own stored logins: every failure path refuses, none falls back.
- Minimum omp on a sharing host: `15.13.1`.
- The broker child binds `127.0.0.1` only. Ready timeout 60 s; idle stop 5 min after the last forwarded request ends; stop is SIGTERM, then SIGKILL after 5 s.
- Request bodies on both forwarders: at most 1 MiB (`1_048_576` bytes), else 413.
- Forwarded request headers: `content-type`, `accept`, `if-none-match`, `omp-auth-broker-capabilities`. Forwarded response headers: `content-type`, `etag`, `cache-control`, `vary`. Nothing else in either direction.
- Never log a token, a secret or a body. The host token never appears in an omp child's environment or arguments.
- Existing suites must pass. Update fixtures only where they pin the server's own protocol version as 8; never weaken an assertion.
- Commit titles follow the log (`feat(hosts): …`, `docs(hosts): …`). Commit and push after every task.
- No production service or daemon is touched. Task 8 uses throwaway home directories and a free port.

## Review Focus

1. Sharing is turned off, or the host is revoked, while that host has a snapshot stream open → the stream ends at once, not at its next reconnect. (Task 3)
2. `omp auth-broker token --regenerate` is run while the broker child is up → one request answers 503, the next starts a new child with the new token. (Task 2)
3. Two sessions start on a host in the same instant, before its forwarder listens → both get the same port and secret from one listener. (Task 5)
4. The host's saved server URL has a path prefix or a trailing slash (`https://example.com/ompweb/`) → requests reach `<prefix>/api/hosts/broker/...` with no doubled slash. (Task 5)
5. A sharing session resumed after a daemon restart keeps the shared credentials; it must never come back on the host's own logins. (Task 6)

---

### Task 1: `shareCredentials` on the host record

**Files:**
- Modify: `lib/hosts/registry.ts` (`HostRecord`, `parseHostRecord`, `createHost`, `updateHost`)
- Modify: `app/api/hosts/route.ts` (`PATCH`)
- Modify: `lib/hosts/hub.ts` (`LinkedHostRow`, `listHosts`)
- Test: `lib/hosts/registry.test.mjs`, `lib/hosts/hosts-route.test.mjs`

**Interfaces:**
- Produces: `HostRecord.shareCredentials: boolean`; `updateHost(id: string, updates: { label?: string; allowAgentStart?: boolean; shareCredentials?: boolean }): HostRecord`; `LinkedHostRow.shareCredentials: boolean`.

- [ ] **Step 1: Write the failing tests**

`registry.test.mjs`:
- a `hosts.json` record without the field loads with `shareCredentials === false`;
- `createHost("x").host.shareCredentials === false`;
- `updateHost(id, { shareCredentials: true })`, then `loadHosts()` → `true`;
- `updateHost("local", { shareCredentials: true })` throws `ReservedHostError`.

`hosts-route.test.mjs`:
- `PATCH { id, shareCredentials: true }` → 200, `body.host.shareCredentials === true`;
- `PATCH { id, shareCredentials: "yes" }` → 400, `error === "shareCredentials must be a boolean"`;
- `PATCH { id: "local", shareCredentials: true }` → 400, `error === "This machine's credential sharing cannot be changed"`.

- [ ] **Step 2: Run** `bun test --parallel lib/hosts/registry.test.mjs lib/hosts/hosts-route.test.mjs` — expected: the new tests fail.
- [ ] **Step 3: Implement.** `parseHostRecord` reads `r.shareCredentials === true`; `createHost` writes `false`; `updateHost` mirrors `allowAgentStart`, including the `local` refusal; `PATCH` mirrors the `allowAgentStart` validation and counts the field in the "Nothing to update" check; `listHosts` copies the field.
- [ ] **Step 4: Run** the same command — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): add a per-host credential sharing setting`, push.

---

### Task 2: broker child on the web server

**Files:**
- Create: `lib/omp/auth-broker.ts`
- Test: `lib/omp/auth-broker.test.mjs`
- Reference: `lib/omp/auth-gateway.ts` (same state-on-`globalThis`, environment and exit-hook pattern)

**Interfaces:**
- Produces:

```ts
export const AUTH_BROKER_TIMINGS = { readyMs: 60_000, idleMs: 300_000, killMs: 5_000 }; // mutable: tests shorten them
export class AuthBrokerUnavailableError extends Error {}
/** Fetch `path` (starts with "/v1/", query included) from the broker child on behalf of `hostId`. */
export function brokerFetch(hostId: string, path: string, init: { method: string; headers: Headers; body?: ArrayBuffer; signal: AbortSignal }): Promise<Response>;
/** Abort every open broker request of this host, streams included. */
export function abortBrokerRequests(hostId: string): void;
export function disposeAuthBroker(): void;
```

Behaviour the signature does not fix:
- Start: `omp auth-broker token` (stdout, trimmed; empty is a start failure), then `omp auth-broker serve --bind=127.0.0.1:0`. Ready is the first stdout line that parses as JSON with `message === "auth-broker listening"` and a `url` starting with `http://127.0.0.1:`. Concurrent first calls share one start.
- `brokerFetch` sets `authorization: Bearer <broker token>` itself, fetches with `proxy: false`, and aborts when `init.signal` or the host's own controller aborts.
- A request is in flight until its response body ends, errors or is cancelled. The idle timer runs only at zero in flight.
- Upstream 401 → stop the child and throw `AuthBrokerUnavailableError`. A start failure, a ready timeout and a child that exits mid-start throw it too.

- [ ] **Step 1: Write the failing tests.** Use a fake `omp` through `OMP_WEB_OMP_BIN`: a Node script (with the `.cmd` wrapper on Windows, as `lib/hosts/link-integration.test.mjs` does) that prints `tok-N` for `auth-broker token` (N from a counter file) and, for `auth-broker serve`, appends a line to a starts file, listens on port 0, prints the listening line, answers `GET /v1/echo` with the received `authorization` header, `GET /v1/stream` with one chunk and then stays open, and `GET /v1/deny` with 401.
  - `starts once for concurrent calls`: no starts-file line before the first call; two parallel `brokerFetch("h1", "/v1/echo")` → one line; both bodies equal `Bearer tok-1`.
  - `stays up while a stream is open, stops when idle`: `idleMs = 50`; with `/v1/stream` open, the child is alive after 200 ms; after cancelling the body, it exits within 1 s.
  - `aborts only the named host`: streams open for `h1` and `h2`; `abortBrokerRequests("h1")` → `h1`'s reader rejects, `h2`'s reads on.
  - `restarts after the broker refuses its token`: `/v1/deny` rejects with `AuthBrokerUnavailableError`; the next `/v1/echo` body is `Bearer tok-2` and the starts file has two lines.
  - `restarts after the child exits`: kill the child; the next call answers 200.
- [ ] **Step 2: Run** `bun test --parallel lib/omp/auth-broker.test.mjs` — expected: fail, module not found.
- [ ] **Step 3: Implement** `lib/omp/auth-broker.ts`.
- [ ] **Step 4: Run** the same command — expected: pass.
- [ ] **Step 5: Commit** `feat(auth): run omp's auth broker as an idle-stopped child`, push.

---

### Task 3: forwarding route and gate

**Files:**
- Create: `app/api/hosts/broker/[...path]/route.ts`
- Modify: `server/routes.ts` (import and `"hosts/broker/[...path]"` entry)
- Modify: `proxy.ts` (`UNGATED` and its comment)
- Modify: `app/api/hosts/route.ts` (`PATCH`, `DELETE`)
- Test: `lib/hosts/broker-route.test.mjs`, `lib/web-auth.test.mjs`, `lib/hosts/hosts-route.test.mjs`

**Interfaces:**
- Consumes: `brokerFetch`, `abortBrokerRequests`, `AuthBrokerUnavailableError` (Task 2); `hostForToken`, `HostRegistryUnreadableError`, `LOCAL_HOST_ID`, `HostRecord.shareCredentials` (Task 1); the handler context `{ params, disableIdleTimeout }` (`server/routes.ts`).
- Produces: `GET`, `POST`, `DELETE` on `/api/hosts/broker/<broker path>`.

The allow-list, exact:

```ts
const ALLOWED: readonly (readonly [method: string, path: RegExp])[] = [
  ["GET", /^\/v1\/(?:healthz|snapshot|snapshot\/stream|credentials\/disabled|usage|usage\/history|usage\/clients)$/],
  ["POST", /^\/v1\/credential\/\d+\/(?:refresh|disable|block)$/],
  ["DELETE", /^\/v1\/credential\/\d+\/blocks$/],
  ["POST", /^\/v1\/usage\/(?:observed|stale)$/],
];
```

Order of checks, each answering JSON `{ error }` with `cache-control: no-store`:
1. Bearer token missing or unknown → 401 `Unknown host token`; `HostRegistryUnreadableError` → 503.
2. Host is `local` or has `shareCredentials` false → 403 `Credential sharing is off for this host`.
3. `"/" + params.path.join("/")` with the request method not in `ALLOWED` → 404.
4. `disableIdleTimeout()`.
5. Body over 1 MiB → 413 (read it only for `POST`).
6. `brokerFetch(host.id, path + url.search, …)` with `signal: request.signal`; `AuthBrokerUnavailableError` → 503; any other failure → 502.
7. Log `[omp-web] broker <host id> <method> <path> <status>` (no query).

`UNGATED` gains the alternative `api\/hosts\/broker\/` (a prefix; `/api/hosts/broker` itself and `/api/hosts/brokerx` stay gated).

`PATCH` with `shareCredentials === false` and `DELETE` call `abortBrokerRequests(id)` after the registry write.

- [ ] **Step 1: Write the failing tests.** `broker-route.test.mjs` mocks `@/lib/omp/auth-broker` so `brokerFetch` records its arguments and returns a canned `Response`:
  - no header and an unknown token → 401, `brokerFetch` not called;
  - known token, sharing off → 403; the `local` record's token → 403;
  - unreadable `hosts.json` → 503;
  - `GET v1/snapshot?wait=30000` → `brokerFetch` gets `("<host id>", "/v1/snapshot?wait=30000", …)`;
  - `POST v1/credential`, `GET v1/credential/1/refresh`, `GET v1/credentials/check`, `GET v2/snapshot`, `POST v1/credential/x/refresh` → 404 each;
  - request headers `cookie`, `x-forwarded-for`, `authorization` are not in the forwarded `Headers`; the four allowed ones are;
  - upstream headers `set-cookie` and `x-other` are not in the answer; the four allowed ones are; the upstream status is kept;
  - a 1 MiB + 1 byte `POST v1/usage/observed` → 413;
  - `brokerFetch` rejecting with `AuthBrokerUnavailableError` → 503; with `new Error("x")` → 502;
  - `disableIdleTimeout` is called once for an accepted request and never for a 401.

  `web-auth.test.mjs`: with a password set and no cookie, `proxy()` returns `"public"` for `/api/hosts/broker/v1/healthz` and a 401 `Response` for `/api/hosts/broker` and `/api/hosts/brokerx/v1/healthz`.

  `hosts-route.test.mjs`: `PATCH { shareCredentials: false }` and `DELETE` call `abortBrokerRequests` with the host id; `PATCH { shareCredentials: true }` does not.
- [ ] **Step 2: Run** `bun test --parallel lib/hosts/broker-route.test.mjs lib/web-auth.test.mjs lib/hosts/hosts-route.test.mjs server/routes.test.ts` — expected: the new tests fail.
- [ ] **Step 3: Implement** the route, the table entry, the gate and the two aborts.
- [ ] **Step 4: Run** the same command — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): forward allow-listed auth-broker requests for sharing hosts`, push.

---

### Task 4: link protocol v9 and the hub's flag

**Files:**
- Modify: `lib/hosts/link-protocol.ts` (`LINK_PROTOCOL_VERSION`), plus a new constant
- Modify: `lib/hosts/host.ts` (`SpawnRequest`)
- Modify: `lib/hosts/hub.ts` (`RemoteHost.spawnRpc`)
- Test: `lib/hosts/hub-v7.test.mjs`; fixtures that pin the server's version as 8

**Interfaces:**
- Consumes: `HostRecord.shareCredentials` (Task 1).
- Produces:

```ts
export const LINK_PROTOCOL_VERSION = 9;
export const SHARED_CREDENTIALS_SINCE_VERSION = 9;
// SpawnRequest gains:
/** Hub → daemon (v9): run this process with the opening server's provider logins. */
shareCredentials?: true;
/** Daemon only: the server URL whose link supplies the credentials. Never trusted from the wire. */
credentialsServer?: string;
```

`spawnRpc`, before it sends anything: read the host's record with `loadHosts()`. If sharing is on and the link's `hostVersion` is below 9, throw `new HostOpError(426, "host_upgrade_required", "Update ompweb on <label> to share credentials with it")`. Otherwise the `open` launch is `{ ...spawnRequest, shareCredentials: true }` for a sharing host and `spawnRequest` unchanged for any other. `local` never shares.

- [ ] **Step 1: Write the failing tests** in `hub-v7.test.mjs`:
  - sharing host linked at v9 → the daemon side receives `open` with `launch.shareCredentials === true`;
  - non-sharing host at v9 → `"shareCredentials" in launch === false`;
  - sharing host linked at v8 → `spawnRpc` rejects with `status === 426`, `code === "host_upgrade_required"`, and no `open` or `spawn` request is sent;
  - non-sharing host at v8 → opens as before.
- [ ] **Step 2: Run** `bun test --parallel lib/hosts` — expected: the new tests fail.
- [ ] **Step 3: Implement.** Then run the suite again and fix only fixtures that fail because they pin the server's own version as 8 (`serverVersion`, `welcome.v`, a hello `v` meant as "current").
- [ ] **Step 4: Run** `bun test --parallel lib/hosts app server components` — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): link protocol v9 carries the credential sharing flag`, push.

---

### Task 5: forwarder on the host daemon

**Files:**
- Create: `lib/hosts/daemon-broker.ts` (Node only: `node:http`, `node:crypto`, `node:stream`, global `fetch`)
- Test: `lib/hosts/daemon-broker.test.mjs`

**Interfaces:**
- Consumes: `SpawnRequest.credentialsServer` (Task 4); `HostOpError` (`./link-protocol`); `isNewerVersion` (`../npm-update`).
- Produces:

```ts
export const MIN_SHARED_CREDENTIALS_OMP = "15.13.1";
export type BrokerForwarder = { env(serverUrl: string): Promise<Record<string, string>>; stop(): Promise<void> };
export function startBrokerForwarder(deps: { login(serverUrl: string): { url: string; token: string } | null; log(message: string): void }): BrokerForwarder;
/** The extra spawn environment for a launch, or undefined when it does not share. Throws instead of falling back. */
export function credentialsEnv(launch: SpawnRequest, deps: { forwarder: BrokerForwarder; ompVersion(): Promise<string | null> }): Promise<Record<string, string> | undefined>;
```

Behaviour the signatures do not fix:
- Nothing listens until the first `env()` call; then `127.0.0.1:0`, once, with one secret of 32 random bytes (base64url) for the daemon's lifetime.
- `env(serverUrl)` returns `{ OMP_AUTH_BROKER_URL: "http://127.0.0.1:<port>/<base64url(serverUrl)>", OMP_AUTH_BROKER_TOKEN: <secret> }`.
- A request is `/<key>/<rest>`. A bearer that is not the secret (constant-time comparison) → 401. `deps.login(decoded key)` null → 503. Otherwise fetch `<login.url without trailing slashes>/api/hosts/broker/<rest>` (query kept) with `authorization: Bearer <login.token>`, read on every request, and stream the answer back. Upstream unreachable → 502. A client that disconnects aborts the upstream fetch.
- `credentialsEnv`: no `credentialsServer` → `undefined`, and nothing else runs. Otherwise it reads `deps.ompVersion()` first: `null` or older than `MIN_SHARED_CREDENTIALS_OMP` → `new HostOpError(409, "host_omp_too_old", "Shared credentials need omp 15.13.1 or newer on this host (found <version or \"unknown\">)")`. Only then it returns `deps.forwarder.env(launch.credentialsServer)`. Whether the link still exists is Task 6's check, not this function's.

- [ ] **Step 1: Write the failing tests** against a real loopback upstream (`http.createServer`) that records each request:
  - `env` shape: URL matches `^http://127\.0\.0\.1:\d+/[A-Za-z0-9_-]+$`, the last segment decodes to the server URL, the token is 43 characters; two parallel `env()` calls for different servers share origin and token;
  - no bearer, and a wrong bearer → 401, upstream not called;
  - right bearer, `GET /<key>/v1/snapshot?wait=5` → upstream sees `/api/hosts/broker/v1/snapshot?wait=5` with `authorization: Bearer <login token>`; the secret appears in no upstream header; `cookie` and `x-extra` are not forwarded;
  - `login` returns a new token on the second request → the second upstream request carries it;
  - server URL `http://127.0.0.1:<p>/ompweb/` → upstream path `/ompweb/api/hosts/broker/v1/healthz`;
  - `login` returns null → 503; upstream closed → 502; a body of 1 MiB + 1 byte → 413;
  - streaming: the upstream writes one chunk and holds the response; the client reads that chunk before the upstream writes the second; when the client aborts, the upstream sees `close`;
  - `stop()` ends an open stream and frees the port;
  - `credentialsEnv`: launch without `credentialsServer` → `undefined` and the forwarder is not started; version `"15.13.0"` and `null` → rejects with `code === "host_omp_too_old"` and the forwarder is not started; `"15.13.1"` and `"18.18.6"` → the `env` result.
- [ ] **Step 2: Run** `bun test --parallel lib/hosts/daemon-broker.test.mjs` — expected: fail, module not found.
- [ ] **Step 3: Implement** `lib/hosts/daemon-broker.ts`.
- [ ] **Step 4: Run** the same command — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): forward auth-broker requests from omp through the host daemon`, push.

---

### Task 6: daemon wiring and resume

**Files:**
- Modify: `lib/hosts/daemon-channels.ts` (`open`, about line 98; `spawnLegacy`, about line 168)
- Modify: `lib/hosts/daemon.ts` (`spawn` dep 83–91, `prepareLaunch` 92–99, `shutdown` 293–300, startup 301–306)
- Modify: `lib/hosts/host.ts` (`Host.spawnRpc` options), `lib/hosts/local-host.ts` (`spawnRpc`)
- Modify: `lib/hosts/host-resume.ts` (`validate`, lines 124–136)
- Test: `lib/hosts/daemon-channels.test.mjs`, `lib/hosts/host-resume.test.mjs`, `lib/hosts/local-host-profile.test.mjs`, `lib/hosts/daemon-runtime.test.mjs`

**Interfaces:**
- Consumes: `startBrokerForwarder`, `credentialsEnv` (Task 5); `SpawnRequest.shareCredentials`, `SpawnRequest.credentialsServer` (Task 4); `DaemonLink.login` (`{ url, token }`, the token replaced in place by `rekey`).
- Produces: `Host.spawnRpc(request, sessionId?, options?: { replaceAdvisor?: boolean; preparing?: boolean; expectedChannel?: string; env?: Record<string, string> })`. `env` is merged over `getAgentEnvOverrides()` by `localHost`; `RemoteHost` ignores it.

Decisions:
- `ChannelTable.open` replaces the wire fields before `ensure`: `credentialsServer` is `link.login.url` when `args.launch.shareCredentials === true`, otherwise absent; `shareCredentials` is removed. A wire-supplied `credentialsServer` is always discarded. `spawnLegacy` removes both.
- `prepareLaunch` rejects a `credentialsServer` that is present and not a string (400 `invalid_request`), like its other fields.
- The daemon's `spawn` dep: when the launch has `credentialsServer` and `links` has no entry for it, throw `new HostOpError(409, "credentials_link_gone", "The web server that shares its credentials with this session is no longer linked to this host")`; then `credentialsEnv(launch, { forwarder, ompVersion: getOmpVersion })`; pass the result as `options.env` to `localHost.spawnRpc`.
- The forwarder is created once in `runHostDaemon` with `login: url => links.get(url)?.login ?? null`, and stopped in `shutdown`.
- Startup order: move the `makeLink` loop (line 306) above the recovery block (lines 301–305), so a recovered sharing session finds its link. `link.start()` stays where it is.
- `HostResumeTracker.validate` keeps `credentialsServer` when it is a string and throws `Invalid recovery launch` when it is present and not a string. Without this a resumed session silently loses the field (Review Focus 5).

- [ ] **Step 1: Write the failing tests.**
  - `daemon-channels.test.mjs`: a v9 link with `login.url === "https://a.example"` opens with `launch.shareCredentials: true` → `deps.spawn` receives `credentialsServer === "https://a.example"` and no `shareCredentials`; an open with wire `credentialsServer: "https://evil.example"` and no flag → `deps.spawn` receives neither field; a second link joining that running session without the flag → `deps.spawn` called once in total; `spawnLegacy` with both wire fields → neither reaches `deps.spawn`.
  - `host-resume.test.mjs`: an entry with `credentialsServer: "https://a.example"` comes back from `takeRunning()` with it; `credentialsServer: 5` → throws `Invalid recovery launch`.
  - `local-host-profile.test.mjs`: `spawnRpc(request, null, { env: { OMP_AUTH_BROKER_URL: "u" } })` → the spawned child's environment has it, and it wins over the same key in `agentEnv`.
  - `daemon-runtime.test.mjs`: an `open` with the flag on a daemon whose omp is `15.13.0` fails with `host_omp_too_old` and starts no process; with a current omp the child environment has both variables, the URL is loopback and the value of `OMP_AUTH_BROKER_TOKEN` is not the link's token; a recovered entry whose `credentialsServer` is not linked is not started and is logged with `credentials_link_gone`'s message.
- [ ] **Step 2: Run** `bun test --parallel lib/hosts` — expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test --parallel lib/hosts` — expected: pass.
- [ ] **Step 5: Commit** `feat(hosts): start omp with shared credentials on sharing hosts`, push.

---

### Task 7: Settings toggle and documentation

**Files:**
- Modify: `components/HostsConfig.tsx` (next to the `allowAgentStart` toggle, line 144; a second `ConfirmDialog` like the revoke one, line 211)
- Modify: `lib/i18n/locales/en.json`, `ja.json`, `zh-CN.json`
- Modify: `README.md`, `AGENTS.md`, `DESIGN.md`, `docs/specs/2026-10-28-remote-hosts-design.md`, `CHANGELOG.md`
- Test: the existing `HostsConfig` test file if one exists, else `components/HostsConfig.share-credentials.test.mjs`

**Interfaces:**
- Consumes: `LinkedHostRow.shareCredentials` and `PATCH { id, shareCredentials }` (Task 1).

Behaviour: linked hosts only. Turning the toggle off sends `PATCH` at once. Turning it on opens the dialog; only its confirm button sends `PATCH`. The dialog is not `danger`.

Strings (keys `hostsConfig.<name>`):

| name | en | ja | zh-CN |
|---|---|---|---|
| `shareCredentials` | Use this server's provider logins | このサーバーのプロバイダーログインを使用 | 使用此服务器的提供商登录 |
| `shareCredentialsAria` | Use this server's provider logins on {name} | {name} でこのサーバーのプロバイダーログインを使用 | 在 {name} 上使用此服务器的提供商登录 |
| `shareCredentialsTitle` | Share credentials with {name}? | {name} と認証情報を共有しますか？ | 与 {name} 共享凭据？ |
| `shareCredentialsDescription` | Sessions started on {name} will use this server's provider logins. That host can read their access tokens and stored API keys. Its own logins are not used. | {name} で開始するセッションは、このサーバーのプロバイダーログインを使用します。このホストはアクセストークンと保存済みの API キーを読み取れます。ホスト自身のログインは使用されません。 | 在 {name} 上启动的会话将使用此服务器的提供商登录。该主机可以读取访问令牌和已保存的 API 密钥，且不再使用主机自己的登录。 |
| `shareCredentialsConfirm` | Share | 共有する | 共享 |

Documentation, normal prose, taken from the spec:
- `README.md`, "Run sessions on another machine": what sharing does and does not share, the security note, omp 15.13.1; the reverse-proxy paragraphs (lines 184 and 508): `/api/hosts/broker/` must reach the server without the proxy's own authentication and without response buffering.
- `AGENTS.md`: file map entries for the three new files; "Remote hosts": v9, the flag, the forwarder, no fallback; "Auth and model config": the broker child; the proxy-exclusion note gains the second path.
- `DESIGN.md` lines 101–103: each machine uses its own credentials unless sharing is on.
- `docs/specs/2026-10-28-remote-hosts-design.md`, "Rules" → "Version": add `9: open.launch.shareCredentials`.
- `CHANGELOG.md`: one entry under the unreleased heading.

- [ ] **Step 1: Write the failing test:** rendering a linked host with `shareCredentials: false`, clicking the toggle sends no request and shows the dialog title; confirming sends `PATCH /api/hosts` with `{ id, shareCredentials: true }`; with `shareCredentials: true`, clicking sends `{ id, shareCredentials: false }` with no dialog; the `local` row has no such toggle.
- [ ] **Step 2: Run** it — expected: fail.
- [ ] **Step 3: Implement** the toggle, the dialog and the strings; write the documentation.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test` — expected: all pass.
- [ ] **Step 5: Commit** `feat(hosts): credential sharing toggle in Settings`, then `docs(hosts): document shared credentials`, push.

---

### Task 8: end-to-end proof with real omp (throwaway, nothing committed)

Uses the installed `omp` (18.18.6 here), two temporary home directories and a free port. No real login is involved: the shared credential is a fake API key.

- [ ] **Step 1:** `npm run build`. Create homes `A` (server) and `B` (host). In `A`, seed one credential: start `omp auth-broker serve --bind=127.0.0.1:0` with `HOME=A`, `POST /v1/credential` `{"provider":"openrouter","credential":{"type":"api_key","key":"sk-probe-FAKE-0001"}}` with the token from `omp auth-broker token`, stop it.
- [ ] **Step 2:** Start the server as `scripts/smoke.ts` does (`bin/omp-web.js -p <free port> -H 127.0.0.1 --no-open`, `HOME=A`). `POST /api/hosts {label:"b"}`, save the token with `ompweb host login --url http://127.0.0.1:<port>` under `HOME=B`, start `ompweb host` under `HOME=B`, wait for the host to be `online`.
- [ ] **Step 3:** With sharing off, start a session on host `b` (an omp process spawned there is enough; no prompt has to succeed). Expected: no `broker` line in the server log; `B/.omp/cache/auth-broker-snapshot.enc` does not exist.
- [ ] **Step 4:** `PATCH /api/hosts {id, shareCredentials:true}`; start a second session on `b`. Expected: the server log has `[omp-web] broker <id> GET /v1/snapshot 200` and a `/v1/snapshot/stream` request; `B/.omp/cache/auth-broker-snapshot.enc` exists; `sk-probe-FAKE-0001` and the host token appear in no file under `B` except `B/.omp/agent/omp-web/host.json` (token only) — check with a recursive search; the omp child's environment (`ps eww <pid>` on macOS) has a loopback `OMP_AUTH_BROKER_URL` and no host token.
- [ ] **Step 5:** Wait 20 s. Expected: the snapshot stream is still open (no new `snapshot/stream` request line), which proves the 10 s idle timeout is off for it.
- [ ] **Step 6:** `PATCH {id, shareCredentials:false}`. Expected: the stream closes at once and the client's retry logs `403`.
- [ ] **Step 7:** Stop both processes, delete both homes. Report each expectation as met or not, with the log lines.

The live test with real logins (spec, "Testing") stays with the user and is not part of this plan.
