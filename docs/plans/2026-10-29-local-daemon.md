# Local Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** omp runs survive web-server restarts: this machine is reached only through a local `ompweb host` daemon, and a restarted web server adopts the omp children it finds running.

**Architecture:** Builds on PR #339 (`feat/remote-hosts`). The hub stops killing unknown channels on `hello` and adopts them into `AgentSessionWrapper`s rebuilt from omp's state. The daemon replays still-open blocking requests it saw on each channel. "This machine" becomes a linked host `local` over loopback, bootstrapped by the web server; main no longer spawns omp or reads session files itself.

**Tech Stack:** Next 16 route handlers, Node 24, `node:test`, jiti; systemd/launchd/Windows service helpers in `bin/` and `lib/windows-service.ts`.

**Spec:** `docs/specs/2026-10-29-local-daemon-design.md` (and `docs/specs/2026-10-28-remote-hosts-design.md` for the link it extends).

## Global Constraints

- Base branch: `feat/remote-hosts` (PR #339) until it merges, then `upstream/main`.
- No new dependencies. Daemon-loaded modules (`lib/hosts/*`, what they import) never import `next/*` or `@/`.
- `LINK_PROTOCOL_VERSION` becomes `3` (hello carries pending requests).
- Pending-request replay cap: 1 MB of raw lines per channel; over it the channel is not adoptable.
- Adoption re-sync uses the existing `GET_STATE_TIMEOUT_MS`; a timeout kills the child and resumes it once.
- The local host id is the literal `"local"`; label "This machine"; it cannot be renamed or revoked.
- Loopback links (`127.0.0.1`, `::1`, `localhost`) use `http://` without `--allow-http`.
- Copy: "start the ompweb-host service"; "This machine needs the ompweb-host service. Install it with: <command>".
- Client code never uses `AbortSignal.timeout/any` or `Promise.withResolvers`; every new UI string exists in all `lib/i18n/locales/*.json`.
- Line numbers below are hints; locate code by symbol.

## Review Focus

1. A web restart during a run that is waiting on an `ask` dialog: after adoption the dialog shows again in the browser and answering it continues the run (Task 1 + Task 3 tests).
2. A channel listed in `hello` whose session id is unknown, or whose re-sync times out: killed and resumed once, never two writers on one file (Task 3).
3. Dev server takes the local link, then stops: production adopts channels dev started, including a run dev left mid-turn (Task 3 integration test).
4. A web server that regenerated the local token: the daemon re-reads `host.json` on 401 and relinks without restarting its children (Task 4).
5. A machine with the new web server but no daemon service: "This machine" offline with the install hint, no crash, no direct spawn (Task 5 + Task 6).

---

### Task 1: Daemon tracks and replays pending blocking requests (link v3)

**Files:**
- Modify: `lib/hosts/link-protocol.ts` (version 3; hello channel `pending: string[]`), `lib/hosts/daemon.ts`
- Create: `lib/hosts/pending-requests.ts`
- Test: `lib/hosts/pending-requests.test.mjs`, `lib/hosts/daemon.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export class PendingRequests {             // one per channel, daemon side
    constructor(limitBytes: number);
    noteStdout(line: string): void;          // decodes (RpcFrameDecoder) and opens/closes entries
    noteStdin(line: string): void;           // host_tool_result / extension_ui_response close by id
    lines(): string[] | null;                // raw lines of open requests in order; null when over the cap
  }
  // hello: channels: { ch: string; sessionId: string | null; pending: string[] | null }[]
  ```
  Opened by `host_tool_call` and `extension_ui_request` with a method in `BLOCKING_UI_METHODS` (import from `lib/notification-events.ts` if it has no next/@ imports, else move the constant to a shared module). Closed by `host_tool_result`/`extension_ui_response` with the same id on stdin, or `host_tool_cancel` (`targetId`) / an `extension_ui_request` cancel frame from omp. A chunked frame's raw `rpc_chunk` lines are kept together.
- [ ] **Step 1: Failing tests** — `pending-requests.test.mjs`: an `ask` request then its `extension_ui_response` → `lines()` is `[]`; an open `host_tool_call` → `lines()` holds its raw line; a request split into three `rpc_chunk` lines → `lines()` holds all three in order; `host_tool_cancel` with `targetId` closes the call; past `limitBytes` → `null`; a non-blocking `notify` UI request is not kept. `daemon.test.mjs`: after a link drop the next `hello` carries the open request's line for its channel.
- [ ] **Step 2: Run** `node --experimental-strip-types --test lib/hosts/pending-requests.test.mjs lib/hosts/daemon.test.mjs` → FAIL.
- [ ] **Step 3: Implement**; bump `LINK_PROTOCOL_VERSION` to 3 and update `decodeUp` for the new hello field.
- [ ] **Step 4: Run** → PASS; `npm test`, `node_modules/.bin/tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(hosts): the daemon replays open blocking requests on hello`.

### Task 2: Adopted session wrapper

**Files:**
- Modify: `lib/omp/rpc-process.ts`, `lib/rpc-manager.ts`
- Test: `lib/rpc-manager.test.mjs`, `lib/omp/rpc-process-runtime.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  // RpcProcessOptions gains:
  adopted?: { protocolVersion: 2 };   // skip the ready wait; decoder starts at v2 and drops rpc_chunk records until a chunk with index 0 / a plain frame
  export async function adoptRpcSession(input: {
    host: Host; transport: RpcTransport; sessionId: string; sessionFile: string; cwd: string; replay: string[];
  }): Promise<AgentSessionWrapper>;   // lib/rpc-manager.ts
  ```
  `adoptRpcSession` builds the wrapper on the existing transport with no spawn, sends `negotiate_protocol` (v2), `set_subagent_subscription`, `set_ask_dialog`, `get_state` (→ `applyIdentity`, running/compacting/queue), `get_subagents`, `get_btw_history`; then feeds each `replay` line through the same path as a stdout line so `handleFrame` re-tracks dialogs and host tool calls; registers it like `startRpcSession` (registry, `onDestroy`, `onIdentityChange`) and calls `notifyRunningChange`. Any re-sync command timing out (`GET_STATE_TIMEOUT_MS`) rejects after destroying the wrapper.
- [ ] **Step 1: Failing tests** — scripted transport already past `ready`: `adoptRpcSession` resolves without waiting for `ready`, issues the commands in the order above, reports `isRunning()` when `get_state` says streaming; a replayed `ask` `extension_ui_request` appears in the wrapper's pending dialogs and reaches an attached listener; a replayed `host_tool_call` reaches a host-tool listener; a leading `rpc_chunk` continuation is dropped without a protocol error; a `get_state` timeout rejects and the transport receives a kill.
- [ ] **Step 2: Run** the two test files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm test`, `tsc`.
- [ ] **Step 5: Commit** `feat(rpc): adopt a live omp child into a session wrapper`.

### Task 3: The hub adopts instead of killing

**Files:**
- Modify: `lib/hosts/hub.ts` (`reattach`), `lib/session-resume.ts` (`resumeOnHostLink`), `lib/hosts/session-index.ts` (session lookup for adoption)
- Test: `lib/hosts/hub.test.mjs`, `lib/session-resume.test.mjs`, `lib/hosts/link-integration.test.mjs`

**Interfaces:**
- Consumes: `adoptRpcSession` (Task 2), hello `pending` (Task 1).
- Produces: on `hello`, each listed channel with no transport and a `sessionId` found in that host's session list (fresh `listSessions`, not the cache) is adopted with its `pending` lines as `replay`. Channels with no `sessionId`, an unknown session, `pending === null`, or a failed adoption take today's orphan path (kill, `orphanExit`, resume once if it was mid-run). An adopted session is removed from the interrupted-session list so `resumeOnHostLink` never resumes it.
- [ ] **Step 1: Failing tests** — hub: a listed unknown channel for a known session is adopted (no `kill` sent, wrapper registered); unknown session → killed as today; adoption failure → killed and resumed once; `pending: null` → killed. session-resume: an adopted session gets no resume prompt. link-integration: real daemon + fake omp; start a run, recreate the hub (simulated web restart), the same child pid keeps streaming frames to a new wrapper with no gap or duplicate, and no resume prompt is written to its stdin; a run waiting on an `ask` shows the dialog again after the restart and the answer reaches omp.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm test`, `tsc`.
- [ ] **Step 5: Commit** `feat(hosts): a restarted web server adopts live omp children`.

### Task 4: Local link bootstrap

**Files:**
- Modify: `lib/hosts/registry.ts` (reserved `local` record), `lib/hosts/hub.ts` (`getHost("local")` → the linked host), `lib/hosts/daemon.ts` (re-read `host.json` on 401; loopback http), `bin/omp-web-host.js`, `instrumentation.node.ts` (bootstrap at start), `app/api/hosts/route.ts` (local row from the registry, not synthesized)
- Create: `lib/hosts/local-bootstrap.ts`
- Test: `lib/hosts/local-bootstrap.test.mjs`, `lib/hosts/daemon.test.mjs`, `lib/hosts/hosts-route.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export function ensureLocalHostLink(input: { url: string }): { token: string; written: boolean };
  // registry: the "local" record exists exactly once; createHost never returns id "local"; updateHost/revokeHost("local") throw
  ```
  At startup the web server calls `ensureLocalHostLink({ url: "http://127.0.0.1:<its port>" })`: creates or keeps the `local` record, writes `<agent dir>/omp-web/host.json` (0600, temp + rename) when its url/token differ. The daemon, on 401, re-reads `host.json` once and redials with the new token; it exits only when the file still holds the rejected token. `http://` is accepted for loopback hosts without `--allow-http`.
- [ ] **Step 1: Failing tests** — bootstrap writes `host.json` with the server's loopback url and a token `hostForToken` accepts; a second call with the same url does not rewrite; registry refuses to revoke/rename `local`; daemon given a stale token gets 401, re-reads the rewritten file and links; daemon with an unchanged stale file exits 1; `http://127.0.0.1` links without `--allow-http`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm test`, `tsc`.
- [ ] **Step 5: Commit** `feat(hosts): bootstrap the local daemon link`.

### Task 5: Main never runs omp or reads session files itself

**Files:**
- Modify: `lib/hosts/local-host.ts` (becomes the daemon's machine implementation; main imports nothing from it), `lib/api-utils.ts`, `lib/hosts/session-index.ts`, `lib/rpc-manager.ts`, every `app/api/**` route importing `localHost`, `lib/session-resume.ts`, `lib/file-access.ts` (local roots now come from the `local` host's session list)
- Test: affected route/manager tests; add `lib/hosts/no-direct-local.test.mjs`

**Interfaces:**
- Consumes: `getHost("local")` from Task 4.
- Produces: every main-side path that used `localHost` uses `getHost("local")`. `allowFileRoot` keeps working for `local` (local paths are main's paths) — the check becomes `host.id === "local"` instead of `host === localHost`. `no-direct-local.test.mjs` fails if any file under `app/` or `lib/` other than `lib/hosts/daemon.ts`, `lib/hosts/local-host.ts` and their tests imports `local-host` or `spawnLocalRpcTransport`.
- [ ] **Step 1: Write** `no-direct-local.test.mjs` (it fails on the current imports).
- [ ] **Step 2: Run** → FAIL listing the importing files.
- [ ] **Step 3: Migrate** each import; tests that relied on direct local behavior use the existing `link-driver.test-helper.mjs` or a fake host.
- [ ] **Step 4: Run** `npm test`, `tsc`, `npm run lint` → PASS.
- [ ] **Step 5: Commit** `refactor(hosts): this machine goes through its daemon`.

### Task 6: Offline local host UI and install hint

**Files:**
- Modify: `components/HostsConfig.tsx` (local row: no rename/revoke; offline hint), `components/AppShell.tsx` (one-time banner), `lib/i18n/locales/*.json`
- Test: `components/HostsConfig.test.mjs`

**Interfaces:**
- Consumes: `hosts` channel status for `local`.
- Produces: when `local` is offline, Settings → Hosts shows "start the ompweb-host service"; when it has never linked since this web server started and 10 s have passed, AppShell shows a one-time dismissible banner "This machine needs the ompweb-host service. Install it with: <command>", where the command is the platform's helper from Task 7 (`ompweb systemd install` / `ompweb launchd install` / the Windows service command).
- [ ] **Step 1: Failing tests** — local row renders no Rename/Revoke; offline local row shows the hint; banner appears once after 10 s offline, not again after dismissal (localStorage key), not when local links.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; lint.
- [ ] **Step 5: Commit** `feat(hosts): tell users to install the local daemon`.

### Task 7: Service helpers install both units

**Files:**
- Modify: `bin/omp-web-systemd.js`, `bin/omp-web-launchd.js`, `lib/windows-service.ts`, `bin/omp-web-tray.js`
- Test: `bin/omp-web-systemd.test.mjs`, `lib/windows-service.test.mjs`, a launchd plist test

**Interfaces:**
- Produces: `install` writes and enables two units — the existing web unit and `ompweb-host` running `<ompweb bin> host` with `Restart=always` (systemd) / `KeepAlive` (launchd) / a second Windows service; `uninstall` removes both; `status` reports both. The tray shows the daemon state next to the web state.
- [ ] **Step 1: Failing tests** — generated systemd units: two files, the host unit's `ExecStart` ends with ` host`; launchd: two plists with `KeepAlive`; Windows: two service definitions.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(service): install the ompweb-host daemon next to the web service`.

### Task 8: This machine's deploy and docs

**Files:**
- Modify (outside the repo, not under git): `/opt/omp-deployment/bin/ompweb-deploy`; create the `ompweb-host` systemd unit for this VM
- Modify: `AGENTS.md`, `README.md`, `DESIGN.md`, `CHANGELOG.md`

- [ ] **Step 1:** Back up `/opt/omp-deployment/bin/ompweb-deploy`, then add: `ompweb-host` unit pointing at the same release; restart it only when the release's `LINK_PROTOCOL_VERSION` differs from the running daemon's (`GET /api/hosts`, local row `hostVersion`); rollback restores both units' release.
- [ ] **Step 2:** Docs per the spec's Documentation section.
- [ ] **Step 3: Deploy smoke (needs the user's go-ahead to deploy):** start a long run on this machine, deploy a web-only change, confirm the run continues with the same omp pid and no resume prompt.
- [ ] **Step 4: Commit** `docs(hosts): document the local daemon`.
