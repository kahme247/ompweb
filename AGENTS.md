# omp-web - Development Notes

## Quick Start

```bash
npm run dev     # Bun server with hot reload (HMR for the SPA), port 30178
npm run build   # bundle the SPA into dist/ (scripts/build-client.ts)
npm start       # serve dist/ + the API, port 30177
npm test        # bun test --parallel
npm run smoke   # start the built server and `ompweb host` (or a packed install: -- --package <dir>; a binary: -- --binary <path>) and check them
npm run build:binary [-- --target bun-<os>-<arch>]   # build, then compile release/ompweb-<os>-<arch>/ and its .tar.gz/.zip (scripts/build-binary.ts)
npm run typecheck && npm run lint
```

The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

---

## Architecture

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages, even
though the server now runs on Bun: live work goes through the installed `omp`
child. See `DESIGN.md` for the full porting contract.

```
Browser              Bun server (server/app.ts)          omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ SharedWorker ── GET /api/events ──▶ ONE multiplexed SSE per browser │
  │   (all tabs)     POST /api/events ─▶ subscribe running/session/file  │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ session subscription ─▶ event-stream-hub onEvent()            │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── event: s<n> data: {...} ──│                               │
```

The launcher (`bin/omp-web.js`) and the host daemon (`bin/omp-web-host.js`)
and tray run on Node. The launcher spawns `bun server/main.ts` (Bun resolved by
`bin/bun-runtime.js`: the npm `@oven/bun-*` binary, else `bun` on `PATH`), which
serves the SPA from `dist/`, the API routes and the password gate in one
process. Nothing in the daemon or tray may use a Bun API. The compiled binary
(`server/binary.ts`) is the exception: one Bun program that runs the server in
its own process (no launcher), `ompweb host` and `ompweb hash-password`.

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` asks the
session's `Host` (`lib/hosts/host.ts`; `localHost` in `lib/hosts/local-host.ts`)
to spawn `omp --mode rpc-ui` (one process per active session) and runs
`lib/omp/rpc-process.ts` over the returned transport. Every machine-local
action of a session wrapper (spawn, session-file checks, list invalidation)
goes through that host.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).
- `rpc-transport.ts` — `RpcTransport`: the byte pipe under `RpcProcess`
  (`spawnLocalRpcTransport` for a local child; `RemoteRpcTransport` in
  `lib/hosts/hub.ts` for a remote one).
- `auth-gateway.ts` — shared, idle-killed `omp auth-gateway stdio` child:
  omp's own credentials and models behind JSON-line gateway requests.

---

## File Map

```
server/
  main.ts             production entry: sets NODE_ENV, then `startProduction` (app.ts); prints the `Ready on` line the launcher waits for
  binary.ts           the compiled `ompweb` (scripts/build-binary.ts): the launcher's checks (`checkLaunchSecurity`) and `startProduction` in-process, `host` (lib/hosts/host-cli.ts), `hash-password`; refuses tray/service commands
  dev.ts              dev entry (`bun --hot`): serves the HTML import with HMR; re-runs itself once with OMP_WEB_PUBLIC_* set so `bunfig.toml` can inline them
  app.ts              `startServer`: `Bun.serve` + route table + gate + SPA fallback; `startProduction` (listen, `register()`, Ready line); `parseListenArgs`
  routes.ts           the API route table (see "Adding an API route"); `routePattern`, `dispatch`
  http.ts             `finalizeResponse` (security headers, gzip for pages and static files, never `/api/`), `serveFile` (dist/, public/, KaTeX), `renderIndex`
  client-env.ts       build-time constants for the browser bundle (app version, event-stream worker hash)
app/
  index.html          the SPA shell, the bundler entry; #root holds static copies of RouteLoadingFallback and (swapped in on /login by an inline script) LoginForm's first render, painted before the bundle runs
  client.tsx          browser entry: renders `LoginForm` on `/login`, else `AppShell` (a path check, no router)
  boot.ts             runs first in client.tsx: installs the sidebar history bridge before AppShell registers popstate listeners
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/search/route.ts        GET ?q= — NDJSON { scores } batches (titles + transcripts); closing the request stops the scan
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  events/route.ts                 GET multiplexed SSE | POST subscribe/unsubscribe channels
  hosts/route.ts                  GET hosts (this machine first) | POST { label } → token once + login command | PATCH { id, label?, allowAgentStart? } (`local`: label only, empty resets to "This machine") | DELETE ?id= revoke (registry first, then close the link); 503 if hosts.json is unreadable
  hosts/link/route.ts             GET downlink (NDJSON stream) | POST uplink (NDJSON batch) — the `ompweb host` daemon; bearer-token auth, skipped by the `proxy.ts` gate
  hosts/link/blob/[reqId]/route.ts  POST raw bytes for a large op result (daemon → main)
  notifications/devices/route.ts  GET VAPID key + subscribed | PUT { deviceId, prefs, subscription? }
  notifications/presence/route.ts POST { clientId, deviceId, visible, sessionId, seq }
  notifications/test/route.ts     POST { deviceId } send a test push (502 on push-service refusal)
  notifications/history/route.ts  GET entries | PATCH { ids } mark read | DELETE ?id= remove one, ?all=1 clear
  auth/**                         provider list, login/logout, API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  github-repo/route.ts            GET ?cwd= — GitHub owner/repo of the checkout (for #N links)
  media/[hash]/route.ts           GET tool-result image by sha256 (?thumb=1 → 480px WebP preview)
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/test/route.ts     POST test a configured model/provider
  omp-settings/route.ts           GET/PUT native config.yml settings (allow-listed)
  web-settings/route.ts           GET/PUT omp-web's own server settings (auto-resume)
  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  projects/clone/route.ts         POST clone a git URL into a new workspace (NDJSON progress) | DELETE cancel
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  stt/route.ts                    POST audio (+scope) → 202 { jobId } | GET ?scope= live jobs (lib/stt-jobs.ts)
  stt/[jobId]/route.ts            GET job state | POST retry with kept audio | DELETE ?claim= claim/discard
  stt/[jobId]/audio/route.ts      GET the kept recording (audio/* only) for playback
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  dynamic.tsx          `dynamic()` over `React.lazy` + `Suspense`
  navigation.ts        `useRouter`/`useSearchParams` over the History API
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  hosts/               hosts and the local daemon (see "Remote hosts"); none of the daemon-loaded files may import `@/` (the daemon runs on Node through `jiti`)
    host.ts            `Host` interface, `HostStatus`, `isLinkUp`
    local-host.ts      `localHost`, the daemon's side: spawn + file checks on the daemon's machine; `resolveSpawnCwdResult`; `SESSION_EDIT_EXTENSION_PATH` (from the module's own location: the daemon runs in HOME). Never imported by main, nor is `daemon.ts` (`no-direct-local.test.mjs`)
    local-bootstrap.ts web server side of the local link: `localLinkUrl`, `ensureLocalHostLink` (the `local` record + `host.json`)
    host-login.ts      `host.json` (`loginHost`, `readHostLogin`) and `isLoopbackHost`, shared by the daemon and local-bootstrap
    session-ops.ts     file-reading half of the session/project routes, run on the owning host's daemon (this machine's too)
    link-protocol.ts   link messages, codec, size limits, `HOST_OP_NAMES`, `SeqWindow`/`Outbox`
    hub.ts             main side: link GET/POST/blob handlers, `RemoteHost`, `getHost`, `listHosts`, adoption of live children (`reattach`/`adopt`), orphans, `freezeHostLinks`, `hosts` change events
    daemon.ts          daemon side: `runHostDaemon` (reconnect, buffering, op dispatch, hello with each child's `{sessionId, cwd, pending}`; follows a `host.json` url or token change when a dial fails; loopback redials at most 3 s apart)
    pending-requests.ts daemon side: `PendingRequests`, a channel's still-open blocking requests and current session id for the hello
    registry.ts        `<agent dir>/omp-web/hosts.json`: create/update/revoke, token hashing and lookup; the `local` record (`rotateLocalHostToken`, `customLocalLabel`)
    session-index.ts   sessions and projects across hosts, cached per host; `hostForSessionId`, `sessionSpawnTarget`, `invalidateLocalSessionLists`
  provider-accounts.ts distinct omp accounts per provider from `omp usage` reports (Models → provider detail)
  agent-client.ts      typed fetch helper for /api/agent commands
  btw.ts               /btw side-question records + pure frame/snapshot merge (order-safe)
  draft-store.ts       local draft persistence helpers
  event-stream.ts      tab-side EventSource-shaped streams over the shared worker
  event-stream-hub.ts  server connections + running/session/file channels for /api/events
  event-stream-protocol.ts  wire contract shared by hub, route, and facade
  file-access.ts       allowed file roots for /api/files and worktrees
  file-authorization.ts  single allow-list gate for /api/files and the file channel
  media-cache.ts       tool-result images → /api/media URLs; media copies + thumbnails
  file-paths.ts        client/server path encoding helpers
  github-refs.ts       remark plugin linking #N / owner/repo#N + GithubRepoContext
  git-clone.ts         pure clone helpers: URL→directory name (https/ssh only), \r-aware progress log
  github-repo.ts       server: pick the gh-default GitHub remote from git config
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  project-command-env.ts  child-process environments: strips PORT/NODE_ENV/NEXT_* and omp-web's secrets
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  notification-events.ts  shared: event/prefs/history-entry types, frame→event detector, renderNotification()
  notification-hub.ts  server: presence, routing, Web Push, recording published notifications
  notification-store.ts  server: SQLite store for VAPID keys, devices and the notification history
  notification-history.ts  browser: mirror of the server's notification history (Notifications tab)
  notification-client.ts  browser: device id, prefs store, service worker + push subscription
  rpc-manager.ts       session registry + startRpcSession over RpcProcess (spawn via a Host)
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  session-search.ts    shared fuzzy/phrase query scorer for sidebar search (title weights ≫ transcript)
  session-content-search.ts  server: per-file transcript text cache (size+mtime) + searchSessions()
  session-resume.ts    running-session list for auto-resume after a restart
  web-auth.ts          password-hash check + session cookie signing
  web-auth-secret.ts   per-installation session-signing key (~/.omp/agent/omp-web/web-auth-secret.json)
  web-password-hash.ts typed view of bin/omp-web-password-hash.js (the scrypt hash format)
  web-settings.ts      omp-web server settings (~/.omp/agent/omp-web-settings.json)
  skills-service.ts    skill listing via `omp skill list --json`; pure-Node replica scan as fallback
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getToolNamesForPreset()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  navigation-history.ts  pure back/forward view-history stack + shortcut matcher (⌘[/⌘], Alt+←/→)
  word-prediction.ts   pure ghost-text arithmetic (advance/accept) for composer word prediction
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer; with a linked host the workspaces group per host (`HostGroup`), keyed by `hostProjectKey` (`lib/project-ordering.ts`: bare path on this machine, `<hostId>:<path>` elsewhere)
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ComposerPanels.tsx  composer-attached /btw + todo + subagent panels (collapsible, live states)
  BtwPanel.tsx        /btw side-question panel (stream, cancel, copy, follow-up) + history dialog
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  NotificationList.tsx notification history list + Mark all read/Clear actions (mobile right-panel tab, desktop bell popover)
  NotificationBell.tsx desktop top-bar bell: unread badge + floating NotificationList popover
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  HostsConfig.tsx     linked hosts: add (token shown once), rename, revoke, allowAgentStart (Settings → Hosts tab)
  LocalDaemonBanner.tsx  production-only hint with the install command while no local daemon has linked (90 s grace)
  host-status.ts      host name, status text and dot colour shared by Settings → Hosts and the sidebar
  PluginsConfig.tsx   modal for installed plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  GhostMirror.tsx     textarea overlay painting ghost-text word completion
  TabBar.tsx          tab bar (Chat + open file tabs)
  WorktreesPanel.tsx  file-panel Worktrees tab: list/switch/create/remove the active repo's worktrees
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useHostRows.ts           the `hosts` channel as React state (status of every host; sidebar, new-session picker, Settings → Hosts)
  useAudio.ts              completion sound + browser AudioContext unlock
  useNotifications.ts      presence reports, toast/system delivery, notification clicks
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state (localStorage key "omp-theme")
  useNavigationHistory.ts  in-app back/forward stack (record/peek/commit/drop) for visited chat views
  useWordPrediction.ts     debounced omp predict_word ghost text + feedback
  useBtw.ts                /btw records/active panel/history dialog fed by btw_* SSE frames

bin/
  bun-runtime.js      resolves the Bun binary (npm `@oven/bun-*`, else PATH, minimum version check); used by the launcher, scripts and nix
  omp-web-host.js     `ompweb host [login]`: loads lib/hosts/host-cli.ts through jiti; token read from stdin, never argv. `omp-web.js host` requires it in-process (no child) so SIGTERM/SIGINT reach the daemon's stop

scripts/
  build-client.ts     `npm run build`: bundles app/index.html into dist/ (Bun.build + tailwind-plugin.ts; fonts emitted as /assets files)
  tailwind-plugin.ts  bun-plugin-tailwind minus Tailwind's color-mix() polyfill (Bun 1.4.4 drops repeated @supports rules); build and dev
  smoke.ts            `npm run smoke`: starts the built server (or `--binary <path>`) and `ompweb host` with a throwaway HOME; checks the SPA, an asset, the API, a session listed through the daemon and SSE
  build-binary.ts     `npm run build:binary`: compiles server/binary.ts (NODE_ENV define, no .env/bunfig autoload) into release/ompweb-<os>-<arch>/ beside dist/, public/, the KaTeX files, the session-edit extension and the licenses; archives it
  licenses.ts         the release's `licenses/`: license files of every npm package the server and client bundles hold (Bun.build metafiles; build-client.ts writes build/client-packages.json) and `bun-LICENSE-<version>.md`, the vendored license of the embedded Bun runtime. Bumping Bun: vendor its LICENSE.md for the new version, or build-binary.ts stops

dist/                 build output (git-ignored, shipped in the package); the production server reads index.html and assets from here
bunfig.toml           Bun dev-server bundling: tailwind plugin and the OMP_WEB_PUBLIC_* inlining
```

---

## Key Design Decisions & Traps

### Adding an API route
1. Create `app/api/<path>/route.ts` exporting `GET`/`POST`/`PUT`/`PATCH`/`DELETE` handlers (plain `Request` → `Response`; dynamic segments `[id]`, catch-all `[...path]`).
2. Add one `import * as x from "@/app/api/<path>/route"` and one entry to `ROUTE_MODULES` in `server/routes.ts`; the key is the directory under `app/api` (`"sessions/[id]"`).
3. `server/routes.test.ts` fails when the table and the files on disk differ, and when a route module exports anything but method handlers.

The table is static imports, not a runtime glob, so `bun build --compile` (`scripts/build-binary.ts`) bundles every handler. `dispatch` answers HEAD from `GET`, OPTIONS and a missing method (405 with `allow`), passes `params` as a promise (plus `disableIdleTimeout`, below), and turns a throw into a 500 JSON body.

### Bun server (`server/`)
- Bun's 10 s `idleTimeout` stays on: it reaps sockets that stall before or during a request, and it also cuts a handler still working after 10 s. So `handle` (`server/app.ts`) calls `server.timeout(request, 0)` for an `/api/` request that `proxy()` reports as `"authenticated"` (never `"public"`) and puts the 10 s back once the handler returns or throws: the setting outlives the response on a keep-alive socket. A handler whose response stays open without traffic (SSE `/api/events`, the login SSE, the clone/search/bash-output/file streams) calls `disableIdleTimeout` from the route context (`dispatch`, `server/routes.ts`) to keep it off until that stream ends or is cancelled; a new stream must do the same, or it is cut after 10 s idle. The host link is gate-exempt (`"public"`), and `lib/hosts/hub.ts` calls `disableIdleTimeout` only once the bearer token checks out. `maxRequestBodySize` is left at Bun's 128 MiB default, above the 101 MB upload cap and the 64 MB link legs; do not lower it.
- Bun's router matches the **raw** path, while `request.url` is normalized (`..` and `%2e%2e` resolved). The gate and handlers read `request.url`, so each route re-matches the normalized path against its own `URLPattern` after the gate and answers 404 if it no longer matches. Never serve a gated route under an ungated path.
- Redirects carry a relative `Location` (`request.url` is always `http://` under Bun, so an absolute URL would leave https behind a TLS proxy).
- `Response.redirect()` headers are immutable; `finalizeResponse` (`server/http.ts`) copies every answer into a fresh `Response` to set the security headers and gzip. Do not mutate a handler's response headers elsewhere.
- `globalThis` state survives `bun --hot` re-evaluation, and `register()` (`instrumentation.node.ts`) runs once per process behind a `globalThis` guard in `server/dev.ts`. New server singletons use the `globalThis` registry pattern of `rpc-manager.ts`.
- Dev (`npm run dev`) serves the SPA from the HTML import with HMR, bundled in memory, and re-runs itself once with `OMP_WEB_PUBLIC_*` set because `bunfig.toml` inlines them from the environment Bun started with. Dev pages carry `script-src blob:` in their CSP (HMR updates run as blob scripts); production does not.
- `OMP_WEB_PACKAGE_DIR` (set by the launcher) is the root for `dist/`, `public/` and KaTeX; `process.cwd()` is the fallback for dev and tests. The compiled binary sets it to its own directory (unless set) before any server module loads, so every runtime file must come from that root: a module's `import.meta.url` in the binary is Bun's virtual `/$bunfs/`, which no other process can read. A new file the server or daemon reads at runtime also goes into `scripts/build-binary.ts`'s copy list.
- The binary needs `process.env.NODE_ENV` defined as `"production"` at build time (`scripts/build-binary.ts`): a plain `bun build --compile` inlines `"development"`, and the server then never writes the daemon's link. `npm run smoke -- --binary` catches that (no session lists).
- `Bun.serve` turns on `SO_REUSEPORT` when `development` is false, so a second omp-web would share the port instead of failing; `startServer` passes `reusePort: false`, and `startProduction` (`server/app.ts`) reports an `EADDRINUSE` in one line.
- The in-app update worker runs on Node (`OMP_WEB_NODE_BIN`, the launcher's `process.execPath`), not Bun. The compiled binary has no in-app update: `Bun.isStandaloneExecutable` turns it off (`lib/self-update.ts`) and `/api/app-update` names the release page (`installMethod: "binary"`).
- Bun's `fs.watch` drops an event that follows the previous one within ~2 ms, so the file channel (`openFileChannel`, `lib/event-stream-hub.ts`) re-stats the file ~50 ms after every event.
- `bun:sqlite` `.get()` returns `null` for no row (not `undefined`).
- `bun:sqlite` `close()` keeps the database file open while prepared statements are alive (until GC), so Windows cannot remove or replace it: the stores close with `close(true)`, which finalizes them (`closeNotificationStore`, `closeUsageDatabase`).
- `readSttConfig` lives in server-only `lib/stt-jobs.ts`; the browser bundle must never import it.
- Browser code must not import `next/*`: use `lib/dynamic.tsx` and `lib/navigation.ts`.

### Tests (`bun test`)
- DOM tests import `tests/setup-dom.mjs` first and then import Testing Library dynamically, so its queries bind to that document. `bun test --parallel` gives every file a fresh global; nothing is torn down.
- A module under test that must see a fake builtin is imported with a fresh query (`?fresh=N`) after `mockBuiltin(t, name, overrides)` (`tests/mock-builtin.mjs`, built on `mock.module`; Bun's `mock.restore()` does not undo `mock.module`, so the helper restores by hand).

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives `bun --hot` re-evaluation; a plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.
- Two cleanup backstops, both unref'd so they never hold the event loop:
  `IDLE_DESTROY_MS` (10 min) and `DISCONNECT_DESTROY_MS`
  (`OMP_WEB_DISCONNECT_DESTROY_MS`, 2 min, `0` disables). The shorter one only
  fires once a session has been genuinely abandoned — no `onEvent` listener, no
  run in flight, no startup handshake, no unanswered `send()`. The last
  `onEvent` detach *starts* that window rather than exposing the last frame's,
  so a reload reattaching seconds later does not 409. Both are fed by
  `resetIdleTimer()`, the single activity choke point for `send()` and every
  child frame: adding a new call path must route activity through it.

### Auto-resume after a restart (`lib/session-resume.ts`)
- Off by default (`autoResumeSessions` in `omp-web-settings.json`). When on,
  `notifyRunningChange()` keeps `omp-web-interrupted-sessions-<pid>.json` in
  the agent dir listing sessions that are mid-run; startup
  (`instrumentation.node.ts`) consumes it, restarts each session and sends
  `RESUME_PROMPT`.
- Each instance writes only its own pid's list, so a second omp-web sharing
  the agent dir (e.g. `npm run dev` beside an installed one) never resumes or
  overwrites sessions the other is running. Startup claims a list only when its
  pid is dead or the file predates the last boot, plus the legacy unsuffixed
  list. Same-boot pid reuse or a zombie writer leaves that list unresumed.
- The omp children run under the daemon, so stopping the web service does not
  reach them: the next server adopts the ones still running and drops their
  entries from this list (`adoptedChild`, see "Local daemon"). Only sessions
  whose child died (daemon restart, crash, failed adoption) resume, after the
  daemon's hello (`resumeOnHostLink`). A session whose process died stays
  listed for `EXIT_GRACE_MS`; the shutdown handler freezes the list
  (`markShuttingDown`) so deaths during a shutdown count as interrupted, while
  a crash with omp-web still up is dropped after the window.
- Only session ids are stored; paths are re-resolved on resume.
- Known limit: resume does not detect a terminal `omp --resume <id>` started
  on the same session while omp-web was down; both would write the file.

### Remote hosts (`lib/hosts/`, `app/api/hosts/`, `bin/omp-web-host.js`)
- **Host seam** (`lib/hosts/host.ts`). Every host, this machine included, is
  reached over the link: `getHost(id)` (`hub.ts`) returns a `RemoteHost` whose
  calls go to a daemon. `getHost("local")` is the link of this machine's own
  `ompweb host` daemon (see "Local daemon"); there is no direct spawn or file path
  on main. `localHost` (`id: "local"`, `local-host.ts`) is the daemon's side: it spawns
  and reads files on the machine the daemon runs on. `startRpcSession(..., host)`
  asks `host.spawnRpc` for an `RpcTransport`; `RpcProcess`, the wrapper, the
  event hub, notifications, the queue and `/btw` never see where omp runs.
  Session and project file reads are `host.sessionOps` (`session-ops.ts`, run in
  the daemon), addressed by session id, never by path: routes use `resolveSessionHostOr404`
  (`lib/api-utils.ts`) and the host resolves the file itself. New route code
  must not open a session file on main for a session that may be remote or local.
  `SessionInfo.hostId` and `ManagedProject.hostId` carry the host; sidebar and
  project state key on `hostProjectKey` (bare path on this machine, `<hostId>:<path>`).
- **Link = two HTTP legs, both dialled by the daemon** (`/api/hosts/link`):
  `GET` is the downlink (long-lived NDJSON, main → daemon), `POST` the uplink
  (batched NDJSON, daemon → main). No WebSocket yet: the route handlers are
  plain `Request` → `Response` functions with no upgrade path (and no `ws`). Every
  line except `hello`/`welcome`/`ping`/`pong` has a per-direction `seq`;
  `ack` rides the hello and every POST (the `x-omp-web-ack` header on an
  uplink POST). The hello is a POST body, never a header (proxy header
  buffers would cap the channels it lists): a POST with `x-omp-web-hello: 1`
  carries it and answers `{helloId}`, and the downlink GET names that id in
  `x-omp-web-hello`; main takes the hello at that GET, so it opens one
  downlink once. A v1 daemon's header hello gets 426. Each `hello.channels`
  entry carries `pending` (link v3): the raw stdout lines of that child's
  still-open `host_tool_call`s, `host_uri_request`s and blocking `extension_ui_request`s
  (`PendingRequests`), or null past `LINK_LIMITS.pendingBytes`. Each side keeps unacked
  lines, resends after a reconnect and drops any `seq` it already applied.
  Main decodes a whole POST before applying any of it. `hello.ack === 0`
  means a fresh daemon: main restarts that host's uplink window. Wire shapes
  and size limits live in
  `lib/hosts/link-protocol.ts` (one op allow-list, `HOST_OP_NAMES`, shared by
  both sides); the spec is `docs/specs/2026-10-28-remote-hosts-design.md`.
- **Link protocol versions** (spec "Protocol versions and compatibility"). A
  released `LINK_PROTOCOL_VERSION` changes only compatibly: an added optional
  field or a message type receivers skip is fine; a changed type or meaning, or
  a newly required field, needs a new version. Receivers skip unknown message
  types (acking their `seq`) and answer unknown ops 501 `unknown_op`, from v3 on;
  a v2 daemon is strict. Main keeps supporting older
  daemons, at least N-1, from `MIN_LINK_PROTOCOL_VERSION` (2) up; dropping one is
  an explicit decision (a daemon on a dropped version gets 426; an update-only
  mode is planned). For an older daemon main decodes its hello into today's shape
  (`decodeUp`), sends only messages that version understands, and echoes its
  version in `welcome` and `hostVersion`; a v2 daemon's listed children are
  killed, never adopted. Upgrade order: web app first, then hosts; a daemon need
  not support a newer main (it gets 426).
- **One link per host, and the 409 nonce rule.** A new link with the same token
  replaces the old one (`replaced` is sent, the old daemon exits); two daemons
  must never run competing `omp --resume` children on one agent dir. Each
  `welcome` carries a fresh `nonce`; every uplink POST and blob upload sends it
  as `x-omp-web-link` and main answers 409 (before reading the body) when it is
  not the current link's. Without it a replaced daemon's late POST lands in the
  window a newer daemon's hello just reset and drops that daemon's first
  messages as duplicates. On 409 the daemon keeps its messages for the next
  `welcome`.
- **Transport down is not exited.** While the link is down the omp child keeps
  running on its machine. A wrapper on a host whose `isLinkUp(status)` is false
  is "transport down": no `process_exit`, idle and disconnect timers paused
  until the link returns; frames carry `host_status` for the offline banner;
  sends answer 503 `{hostOffline: true, delivery}`: `"refused"` when nothing
  left (the composer keeps the draft), `"unknown"` when the link dropped after
  the command was sent (it may still run; the composer drops the draft so it
  is never sent twice). A fresh chat adopts the `sessionId` a 503 from
  `/api/agent/new` carries. A child missing from `hello.channels`
  gets a synthesized `process_exit`. Use `isLinkUp` (`host.ts`, client-safe) as
  the one link predicate; do not compare `status === "online"` (an `omp-missing`
  host is linked).
- **A failed op never runs later.** An op that times out (504) or whose
  downlink ends or host goes offline (503, at once, not at the 30 s timeout)
  drops its `req` from the outbox (`failOp` in `hub.ts`), so a delete the user
  saw fail is never applied after a redial. `destroyAndWait` returns once the
  session's host is offline (`untilHostDown`); the kill stays queued for the
  link. A wrapper therefore stays in the registry until its child really exits
  (a resume whose handshake failed is registered in the catch for this), so a
  retry awaits its `destroyPromise` instead of spawning a second `--resume`
  child. A reload (`restart`) waits for the old child the same way: if the
  host drops first, it fails `host_offline`, the wrapper answers
  `host_offline` until that child's exit arrives (or `lost` on the next
  hello) and is then destroyed; no replacement spawns beside it.
  `restartAllRpcSessions` (omp update) restarts local sessions only.
  Remote-only transport members (`onResync`, `lost`) are optional on
  `RpcTransport` and duck-typed. There is one module graph, but live objects on
  `globalThis` outlive a `bun --hot` re-evaluation, which may re-create the
  `RemoteRpcTransport` class (not verified); duck typing holds either way, so
  never `instanceof RemoteRpcTransport`.
- **Live-link recycle rule.** A prompt, history-edit or MCP command that times
  out normally recycles the child. On a remote host it does so only if the host
  sent uplink traffic after the command was dispatched (`lastUplinkAt`,
  `linkLostDuring` in `rpc-manager.ts`); a quiet or dropped link answers
  `host_offline` (503), queues no kill and leaves the run to
  `reconcileAfterGap`. A kill through a dead link only waits in the outbox.
- **Orphans and resume.** On `hello`, listed channels with no wrapper are children
  of a previous server run: they are adopted (see "Local daemon"), and killed
  (`kill`, escalating to force after 5 s, registered until their `exit`) only when
  adoption is impossible. A cold spawn for a session
  awaits `orphanExit(hostId, sessionId)` first so two children never write one
  file; the wait rejects 503 as soon as the link goes down. A buffer overflow on
  the daemon (8 MB per channel) sends `resync {ch}` and main reruns the
  `get_state` reconcile. With `autoResumeSessions` on, an interrupted session
  resumes after its host's hello (`resumeOnHostLink`,
  `lib/session-resume.ts`), once, after the orphan's exit.
- **Proxy exclusion.** The `proxy.ts` gate lets `/api/hosts/link` and its
  subpaths through (the `UNGATED` pattern names exactly those): the daemon has
  no session cookie, so it authenticates with its bearer token instead. The hub verifies the `Authorization: Bearer <host token>`
  header before reading any body (401 unknown token, 503 unreadable
  `hosts.json`). Keep `/api/hosts` itself behind the proxy.
- **Remote paths never reach `allowFileRoot`** or any other main-side
  filesystem check: they mean nothing on main. `startNewRpcSession` calls
  `allowFileRoot` and the local session-list invalidation only for the local
  host; remote cwd validation is the host's `validateCwd` op. Daemon input is
  untrusted: blob hashes must match `^[0-9a-f]{64}$`, results are shape-checked
  in `hub.ts`, and `sessionFileExists`/`spawn` accept only paths under the
  daemon's sessions directory. A remote session export is always served as an
  attachment: inline, its HTML would run on main's origin.
- **Daemon-loaded modules must not import `@/` or use Bun APIs.** `bin/omp-web-host.js`
  loads `lib/hosts/daemon.ts` through plain `jiti` on the Node runtime, which does
  not resolve the `@/` alias and has no `Bun` global (the tray modules likewise). That covers everything the daemon pulls in
  (`daemon.ts`, `link-protocol.ts`, `local-host.ts`, `session-ops.ts`,
  `host.ts`, and their `lib/` imports). Use relative imports there.
- **Registry.** `<agent dir>/omp-web/hosts.json` (0600, atomic write) stores
  only `sha256(token)`; the token is shown once. Mutations use the strict
  reader and throw `HostRegistryUnreadableError` (503) instead of rewriting a
  file they could not parse. Revoke deletes the record first, then closes the
  link (the daemon sees 401 and stops its children). The `hosts` event channel
  carries the `GET /api/hosts` body. A missing `hosts.json` (an agent-dir
  mismatch, say) answers 401 to every daemon, and a daemon told its token is
  unknown stops all its omp children: check `PI_CODING_AGENT_DIR` before
  starting main.
- **Agent tools.** Calls carry the caller's host (`sourceHostId`);
  `new_session`'s `host` defaults to it. A host with `allowAgentStart` off asks
  a server-owned `confirm` through the normal extension-UI path
  (`confirmFromServer`). Local callers never ask for this machine. A remote
  caller asks before any other host unless that host allows agent starts, and
  always before this machine, for `new_session` and `send_to_session` alike.
- **Not yet remote:** Explorer, Git, Worktrees, the Skills/Plugins/Agents/MCP
  settings tabs and directory browsing show "Not available on remote hosts
  yet". Sub-projects 2 and 3 of the spec add ops for them.

#### Local daemon (`docs/specs/2026-10-29-local-daemon-design.md`)
- **Two services.** `ompweb` (web) and `ompweb-host` (`ompweb host`, the daemon) are installed together by `ompweb systemd install`, `ompweb launchd install` and the Windows tray install; uninstall removes both, `ompweb systemd restart` restarts the web unit only. The daemon owns this machine's omp children, so a web restart, update or redeploy leaves runs going; restarting the daemon ends them (auto-resume then resumes the sessions that were running). An upgrade restarts the daemon only when the running daemon's link version is outside the new release's `[MIN_LINK_PROTOCOL_VERSION, LINK_PROTOCOL_VERSION]` range (it would get 426 and exit); a daemon inside the range keeps running.
- **Local link bootstrap** (`lib/hosts/local-bootstrap.ts`, called from `instrumentation.node.ts`). `localLinkUrl()` builds the daemon's URL from `OMP_WEB_PORT`/`OMP_WEB_HOSTNAME` (set by the `ompweb` launcher; wildcard binds map to `127.0.0.1`, a non-loopback bind gets no link and a console warning). `ensureLocalHostLink()` makes sure the `local` record exists (`registry.ts`, `rotateLocalHostToken`) and writes `<agent dir>/omp-web/host.json` (`{url, token}`, 0600). A `host.json` whose token the registry still accepts and whose url matches is left alone, so a web restart does not make the daemon redial. It throws, and startup only logs, when `host.json` points to a non-loopback server (a remote-host login on this machine): it is never overwritten. The daemon re-reads `host.json` when its link gets 401 and exits only if the file still holds the rejected token.
- **Dev mode does not take the daemon.** With `NODE_ENV=development` `ensureLocalHostLink` is skipped, so the daemon stays linked to production and the dev server shows "This machine" offline. The local row of `GET /api/hosts` carries `daemonManaged: false` there, which hides the install banner.
- **`local` is a registry record like any host**, with three exceptions: it is listed first, `PATCH` takes `label` only (`allowAgentStart` is fixed), and it cannot be revoked. Renaming "This machine" is a `PATCH /api/hosts {id: "local", label}`; an empty label resets it (`registry.ts` stores `""`; `customLocalLabel()` / `DEFAULT_LOCAL_LABEL` map it). `getHost("local")` works without the record: it is the daemon link, offline while none is linked, and "needs upgrade" on a protocol mismatch (`hostVersion` in the row is the daemon's).
- **Adoption on hello** (`reattach`/`adopt` in `hub.ts`, `adoptRpcSession` in `rpc-manager.ts`). Each listed `{ch, sessionId, cwd, pending}` channel that has no transport on this server is a child of a previous server and is taken over by a new `AgentSessionWrapper` (`adopted: true`, `RpcProcess` option `adopted`). There is no session-list lookup: the spawn `cwd` comes from the hello, and the session identity from the child's own `get_state` (`applyIdentity`), so a new session whose file is not written yet is adoptable. The daemon names each child's current session in the hello (`PendingRequests.sessionId`: the file's header id at spawn, then the last successful `get_state`). Re-sync (`AgentSessionWrapper.adopt`): `negotiate_protocol`, `set_subagent_subscription`, `set_ask_dialog`, `get_state`, `get_subagents`, `get_btw_history`, then `replay` of the `pending` lines and `release` of the frames held meanwhile. Every command is bounded by `GET_STATE_TIMEOUT_MS`.
- **The daemon replays open blocking requests** (`pending-requests.ts`): `host_tool_call`, `host_uri_request` and blocking `extension_ui_request` lines, until answered or cancelled, capped at `LINK_LIMITS.pendingBytes` per channel. An adopted wrapper feeds them through `handleFrame` (`replaying`; agent tools are not re-run), so dialogs reappear and browser tool calls wait for the next tab (`hostToolsUnknown`, `parkHostTool`). A request opened while the old server stopped is also resent unacked: `RpcProcess.release` skips held requests the replay already delivered, so it is handled once. The hello also carries `autoApproveExtension`, which an adopted run has no spawn result for.
- **A child is killed only when it cannot be adopted:** its hello entry has no session id, lost its `pending` lines to the cap, or came from a v2 hello (`killOrphan`), or a re-sync command times out or the child exits, its held output overflows, or its real session (after `get_state`) is already started on this server (`adoptRpcSession` kills it: its wrapper's dispose). Auto-resume (`resumeOnHostLink`) first awaits `adoptedChild()` and resumes a session only if it was not adopted.
- **Shutdown freezes the links and never kills daemon children.** The `cleanup` in `rpc-manager.ts` runs `markShuttingDown()` and `freezeHostLinks()`: from then on a link neither sends nor applies anything (no kill, no rejection of open host tool calls as tabs close; the daemon's POSTs get 503 "shutting down"). The daemon keeps the output unacked for the next server. An adoption that fails after the freeze leaves its child to the next server instead of killing it.
- **Install banner** (`components/LocalDaemonBanner.tsx`). In production, when the local row stays offline with `hostVersion === null` (no daemon has linked since this server started) for 90 s of a page view (well past the daemon's redial wait, at most 3 s on loopback, so a restarting daemon does not trip it), it shows the platform's install command and, for a foreground `ompweb` (terminal or npx, no service), `ompweb host` to keep running in another terminal; Settings → Hosts shows both for an offline local row. Dismissal is kept in `localStorage`. Main never installs services or starts the daemon.
- **No direct local path.** `local-host.ts` is the daemon's; `lib/hosts/no-direct-local.test.mjs` fails when anything outside its allow-list spawns omp or imports it. The utility omp (`rpc-utility.ts`, login) is the one deliberate exception: it is not a session.

### Session moves (omp >= 18.5 ownership) and title generation
- Only the first omp process to write a session file owns it; a non-owner moves
  to a sibling file with a new id on its first write and emits a
  `notice` with `source: "session-persistence"`. `handleFrame` answers it with
  `followSessionMove()`: the pending flag makes the next `applyIdentity` treat
  the id change as the same conversation (stream/run state kept, **old id kept
  as a registry alias**, new id registered via `onIdentityChange({keepOldId})`).
  Branch/new/switch still drop the old key. `startRpcSession` also reuses any
  live wrapper reporting the requested session file instead of spawning a second
  `--resume` child (which would fork again). `onDestroy` removes every key that
  points at the wrapper.
- `POST /api/sessions/[id]/auto-name` asks omp to generate the title
  (`AgentSessionWrapper.generateTitle()`: native `generate_title`, else
  argument-less `/rename`, never while a run is in flight). Only when omp cannot
  does it fall back to the stored/derived title (`generated:false`), saved
  through the live process when there is one.

### Browser compatibility
Client code (`components/`, `hooks/`) must not call `AbortSignal.timeout`,
`AbortSignal.any` or `Promise.withResolvers` — older mobile browsers throw and
the whole tree shows the "unexpected error" screen. Use `AbortController` + timers and
executor-style promises instead. Server code may use them freely.

### Editing and branching — don't confuse them
- **Fork** ("Fork a new session from this point" button, `messageView.newSessionTitle`, on user and assistant messages; only offered while the session is idle — ChatWindow gates it on `!sessionBusy && !isNew`): creates a new independent `.jsonl` file via omp's `branch` RPC. Shown as a child in the sidebar tree via `parentSession` header field. `branch` only takes a user entry and keeps the history *before* it, so `lib/chat-fork.ts` maps rows: a user prompt forks at itself and its returned text prefills the fork's composer (edit-and-resend, text only — attached images are not restored); an assistant reply forks at the next user prompt so the reply is kept; the newest reply falls back to its own prompt with the prefill. Rows that would edit the very first prompt (an empty fork) offer no fork.
- **Edit** (`edit_message`, user-message button): moves the live conversation's history to before that user entry; it is not a read-only historical view or an explicit Fork. `lib/omp/session-edit-extension.mjs`, explicitly loaded on spawn/restart, calls omp's public `ctx.navigateTree(entryId, { summarize: false })` and appends a non-message `omp-web-history-navigation` entry. Node never imports the Bun-only SDK or rewrites the JSONL.
  - Require authoritative `get_state.isSettled === true` and reject pending background work; runtimes without settlement reporting fail explicitly. Preserve run/edit fencing, including rename and automatic-title fallbacks, and do not report success after an observed edit-time native persistence error.
  - `SessionEditResult` remains `{ sessionId: string, cancelled: boolean, leafId: string | null }`. The returned ID identifies the confirmed post-edit conversation. Single-owner Edit keeps ID/file; a non-owner's native copy-on-write relocation is expected. Server persistence notices feed `applyIdentity` and registry aliases; the HTTP result drives client identity adoption (there is no public identity-change frame). Reload the confirmed target before text prefill, reject unrelated switches, and preserve the original file and old branches.
  - The private `/omp-web-edit` transport uses `prompt`, so installed input hooks must pass the internal command through unchanged. OMP v18.12.6 invokes input hooks before command dispatch; registration checks alone do not bypass them. A temporary-hook probe confirmed consumption can intercept the command without an agent run. No input-handler registrations were found in the 20 official hook/extension TypeScript examples examined, and the official RPC fixture matches `consume:`, `transform:` and `slow:` rather than slash commands. Conflict probability is unmeasured and no known shipped third-party conflict is established. This is an explicit compatibility boundary, not a promise of arbitrary plugin support or a requirement for universal hook-free upstream RPC.
  - Preserve ordinary native storage/error semantics: appends commonly reach the OS page cache synchronously, persistence failures latch and emit `source: "session-persistence"`, `level: "error"` notices, and native `flush()` throws latched errors. An append returning alone does not prove error-free persistence; surface observed edit-time write failures rather than claim success. Edit does not introduce a stronger fsync guarantee or require a new global durability API.
  - A native `prompt` acknowledgement may have no data; only the request-correlated extension result confirms Edit. An observed persistence-error notice is not handler completion: keep the operation fence until the handler completes, or await child teardown on uncertain completion before unlocking. If an input hook invokes an agent, an observed run must retain run ownership; an acknowledged but not-yet-started agent cannot leave an unfenced startup gap and requires awaited teardown.
  - Prefill only the selected message's text, not its original images. Preserve existing drafts, newer typing and composer attachments through pending edits, cancellation, errors and genuine navigation. `submissionBlocked` keeps asynchronous dictation from submitting or clearing the composer without disabling recording pause/resume/discard. `session_history_changed` carries the leaf marker; the initiating tab deduplicates its own delayed echo without resetting a newer view or run. Editing does not undo filesystem/tool side effects.
  - Legal identity moves keep the hook and composer mounted. Transfer drafts capacity-neutrally and carry the exact source snapshot so input completed in the same React batch is merged, not overwritten or duplicated. Pending attachment reads, recordings and recovery operations retain their owner across the move; genuine navigation remains isolated. Draft text survives full-page reload via sessionStorage; attachment payloads remain memory-only.
  - The confirmed-move callback synchronously calls `ChatInputHandle.retargetPendingRecovery(from, to)` before state updates or parent callbacks. This advances only captured queue-recovery ownership, closing the acknowledgement-to-commit gap; layout hydration still owns the live composer key/state. Do not turn this pre-commit ownership handoff into eager draft hydration.
  - Pending transcription keeps its original server scope/job/claim ownership. Confirmed moves record a tab-local recovery association so the target can rediscover that job after navigation/remount; other clients' drafts and server scopes are not migrated. A hard reload before an upload acknowledgement can leave multiple possible source jobs; retain recovery and report ambiguity rather than guess or reupload.
  - Event connections own their readiness waits: replacement and unmount settle the old wait as closed, clear its timers/coalesced work and close its observer. Late continuations must not attach streams to an unmounted hook or let a stale connection authorize a new operation. Keep lifetime cleanup separate from the mount-load latch so StrictMode setup/cleanup replay still cleans up observers attached afterward.
  Ordinary `ChatInput.onSend` returns `Promise<PromptSubmissionResult>` (`accepted` / `rejected` / `superseded`). Only rejection restores composed text/file contents and images through `recoverDraft`; its receipt supplies the promoted real-session draft key when a new chat became a session, otherwise the composer uses the originating key captured before submission. Superseded failures must not reinsert a processed turn or reset a newer run. The composer owns recovery; `useAgentSession.handleSend` must not separately insert failed-send text and duplicate it.
- **In-session branch** (Continue button / BranchNavigator): reads a historical view of the entry tree within the same file; it does not change the live agent's context. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=` through `handleLeafChange`; never use that read-only path to implement Edit.

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Live tool execution (`tool_execution_start/update/end`)
omp announces a tool the moment it starts, streams the tool's output while it
runs, and only commits the `toolResult` message at the end. The UI must not
wait for that commit:
- `useAgentSession` keeps a `liveToolResults` map keyed by `toolCallId`
  (seeded on `tool_execution_start` with `partial: true`, refreshed on
  `tool_execution_update` — omp sends the FULL accumulated partial result per
  chunk, latest wins — and released on `_end`/the committed toolResult).
  Committed results always win over live entries (`ChatWindow` merges them), so
  a reload never shows a stale snapshot.
- `ToolCallBlock` renders a `partial` result as **running** (spinner, and
  "Running tool…" instead of the "(no output)" marker when nothing has been
  printed yet), and opens the row while it runs when the "Keep tool calls
  collapsed" setting is off — that is what that setting means. `AppShell` must
  pass `toolCallsDefaultCollapsed` into `ChatWindow`; without it the setting is
  inert (the chat then always collapses).
- `CommittedTranscript` renders the newest turn flat only while the UI "Hide
  tool activity while working" setting is off; with it on (the default) the
  running turn folds into one **Process details** row per activity run, like a
  finished turn. `AppShell` must pass `hideToolActivity` into `ChatWindow` for
  the switch to do anything. The fold row is the expand affordance, so a hidden
  tool call is one click away rather than gone.
- `tool_execution_update` is coalesced per tool call at display rate in
  `lib/message-update-coalescer.ts` (chatty commands emit ~10-100+ frames/s).
  `message_end` drops the pending `message_update` (the committed message
  supersedes it) but must NOT drop buffered tool updates.
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

### Reasoning display ("Expand thinking blocks by default")
- `ThinkingBlock` (`components/MessageView.tsx`) seeds `expanded` from
  `expandThinkingByDefault`, plumbed and stored exactly like
  `toolCallsDefaultCollapsed` (`omp-web:expand-thinking` in `AppShell`, off by
  default). It is an initial value only: manual collapse/expand keeps working
  per block, and a reload remounts from the preference.
- The preference deliberately covers a **streaming** block too. A "completed
  only" rule would have to flip the state mid-stream (fighting a manual
  collapse), and remounts start from the preference either way, so streaming and
  completed blocks stay consistent.
- Auto-expanded historical blocks are `deferred` (thinking text is fetched on
  demand), so a mount effect loads their content through the same loader the
  click path uses — one request per mount, cached per (session, entry, block).

### Tool-result images (`lib/media-cache.ts`, `/api/media/[hash]`)
- Tool-result images never reach the browser as base64. History (`deferMedia`)
  and live frames (`AgentSessionWrapper.emit`, which also feeds the replay
  snapshot) replace each image with `{type:"image", mimeType, url:"/api/media/<sha256>"}`.
  User-message and custom-message images stay inline.
- The hash is omp's blob address (sha256 of the bytes): blob refs map directly
  (a missing blob becomes the `[image unavailable …]` text), inline images are
  hashed and copied to `<omp-web dir>/media/`. omp writes blobs in place, so the
  route serves the copy until the blob has the copy's size. A daily sweep (run
  on the next media write) deletes copies omp now holds and files older than
  30 days.
- `ToolCallBlock` shows `?thumb=1` (480px WebP made once with `Bun.Image`, which
  applies EXIF orientation, and cached next to the copies; full image if the
  bytes do not decode) and opens the full
  image in the lightbox. The route serves only PNG/JPEG/GIF/WebP by magic bytes.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `compaction_start` /
`compaction_end` events. Completion is `agent_end` (`isTerminal !== false`),
errors surface as failed RPC responses plus `notice` events.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Queued messages are omp-owned
The queue panel renders omp's snapshot only: `get_state.queuedMessages` on
load/reconcile/stream open and live `queue_update` frames. Never track chips
client-side — every client viewing the session must show the same queue.
One sequence (`queueSeqRef`) orders every source: a get_state snapshot takes
a number when requested and applies only if no newer snapshot or
`queue_update` was applied (HTTP and SSE can reorder). Edit/Delete use
`remove_queued_message` (act only on `removed: true`; newer omp also returns
the message's `images`, which Edit restores), Steer uses
`promote_queued_message`; the chip changes when omp's next snapshot arrives.
`handleAbort` coalesces overlapping Stops, then sends `abort_and_restore_queue`:
omp's Esc (`clearQueue({ forInterrupt: true })`, then abort) in one step,
returning the withdrawn user messages, whose texts and images go to the
session draft via `recoverDraft`. omp labels an image-only message `[Image]`;
that label is never restored as text. It covers what a client snapshot cannot: a steer promoted
after the last `queue_update`, and live-steered input the run claimed but never
recorded (omp would otherwise requeue it and drain it into a new turn right
after the abort). Never reimplement this client-side. A failed request is
retried once (omp returns whatever is still queued) and only while the run
captured at the click is current; texts lost with a response that never
arrived cannot be recovered, so the hook warns (`queueRestoreUncertain`).
Fallback ONLY when omp answers "Unknown command" (omp without the command):
withdraw each listed message with `remove_queued_message` BEFORE sending
`abort` (bounded by `WITHDRAW_BEFORE_ABORT_MS`), saved as each removal
confirms. A follow-up that answers `removed: false` is retried on `steering`
(a concurrent promotion moved it); never the reverse. Every abort is fenced to
the prompt run id captured at the click, so it cannot kill a prompt started
during the wait.
- Submitting during a run defaults to **Queue follow-up**
  (`lib/composer-prefs.ts`, `omp-web:submit-during-run`); only an explicitly
  stored choice overrides it, and an absent key yields `queue`.
- omp-web's own `!!` shell command (`bashRunning`, set for the whole `bash`
  RPC) is the one state omp refuses a prompt in. The wrapper degrades instead
  of throwing (`queueWhileShellRunning` in `lib/rpc-manager.ts`): the frame is
  forwarded as omp's `follow_up` — never aborted, never reimplemented here —
  and the reply reports it (`{queued:true, queue:"followUp",
  reason:"shellRunning"}`), which the hook surfaces as a notice while rolling
  the phantom optimistic turn back. The chip still comes from omp's snapshot.

### Live event stream: one socket per browser (`/api/events`)
- Browsers cap HTTP/1.1 at **6 connections per host across all tabs**, and an
  SSE response pins one for its lifetime. Per-stream SSE (sidebar + host
  tools + chat + file watch per tab) froze everything after ~2 tabs, so
  **never add a new `EventSource`** for live data: add a channel instead.
- `public/event-stream-worker.js` (plain script, SharedWorker; dedicated
  Worker where SharedWorker is missing) holds the only `/api/events`
  EventSource and multiplexes every tab's subscriptions: frames arrive as
  `event: <subId>`, control frames as `event: mux` (`hello`/`open`/`end`).
  Subscriptions are attached with `POST /api/events`. Its URL carries a
  content hash (`server/client-env.ts`) so a changed worker never serves stale tabs.
- Tabs use `openEventStream(channel)` (`lib/event-stream.ts`), which keeps
  EventSource semantics: `onerror` + CONNECTING = reconnecting on its own,
  CLOSED = fatal (e.g. 409 for a wrapper-less session; the chat hook then
  retries with backoff). Dead tabs are detected with a lifetime Web Lock —
  MessagePort has no close event.
- Channels (`lib/event-stream-hub.ts`): `running` (sidebar badges +
  session-list hints), `notifications` (one tab's toasts and in-page system
  notifications, keyed by its `clientId`), `hosts` (the `GET /api/hosts` body on
  subscribe and on every link or registry change), `host-tools` (cross-session
  `open_url`/`notify`/`open_file` calls), `session` (observer-only, never
  spawns omp; keeps the latest-wins `message_update` coalescing under
  backpressure), `file` (viewer watch, same allow-list as `/api/files`). A
  failing frame ends only its own subscription, never the shared socket.
- Split channels by consumer, lifetime, key and access check, not by which
  stream happens to be open: a subscription costs one `POST`, not a socket, so
  never piggyback a frame type on another consumer's channel. `notifications`
  and `host-tools` are subscribed from `AppShell`, so they outlive the sidebar
  (which unmounts while Settings is open).

### Running state + reconciliation
- The sidebar subscribes to the `running` channel, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats its `session` channel as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Composer-attached panels (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`) and the subagent roster live **pinned above
  the chat input**, not inside the scrollable message list. `ComposerPanels`
  renders both, each independently collapsible via its header row (`chevron`);
  panels start collapsed (headers always show live progress / running-summary).
  Non-running chips (terminal or history) nest under a `Completed (N)` toggle
  inside the roster, collapsed on every mount (not persisted).
  Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. `TodoList` keeps a
  non-collapsible default (`collapsible` prop) for SSR tests.

### Side questions (`/btw`, `lib/btw.ts`, `hooks/useBtw.ts`, `components/BtwPanel.tsx`)
- `btw` / `btw_cancel` / `get_btw_history` are passthrough RPC commands;
  answers stream as `btw_delta` (text appended to the latest turn) and
  `btw_record` (full snapshot per lifecycle change) frames. omp persists the
  history per session (and re-reads it from disk when idle), so the TUI and
  omp-web share topics. omp answers `btw` before that turn's frames; the
  running `btw_record` comes first.
- `/btw <question>` and `/btw` are client builtins (`handleBuiltinSlashCommand`
  case `"btw"`). `ChatInput.sendSideQuestion` routes them there from both the
  idle and the streaming submit path, *before* attachments are folded in:
  never sent as a prompt, never queued, and refused with a toast (draft and
  attachments kept) while attachments are attached. Asking starts the wrapper
  (`get_state`) and attaches SSE first when it is not open, so no early delta
  is lost; a second ask while one is starting is ignored.
- The `btw` response, history snapshots and frames race (HTTP vs SSE): merge
  only through `lib/btw.ts`, which never lets a stale snapshot drop streamed
  text, a turn, or a finished status. A record that was running before a
  history read and is missing from it becomes `interrupted` (omp lost it).
- `btw_*` frames skip the message-update coalescer (each would flush the main
  stream's pending update) and are batched in `useBtw` with the coalescer's
  `scheduleAtDisplayRate` (rAF, 50ms timer in hidden tabs). Pending frames are
  flushed before a history snapshot is merged, never after it.
- `btw_*` frames are routed to `useBtw` BEFORE `catchUp.observe(event)`, never
  after: `observe()` classifies a frame on its `streamId`, and its `"epoch"`
  branch resets the whole transcript (`dispatch({type:"reset"})` +
  `clearLiveToolResults()`). A side question must never be able to wipe the
  live view of the run happening beside it.
- `get_btw_history` and `btw_cancel` never spawn or replace omp: the agent
  route answers them like `predict_word` (`NO_SPAWN_REPLIES`: empty history,
  `cancelled:false`) when no child is alive. History is re-read on every SSE
  open, from the visibility/online reconcile while a record runs, and after a
  cancel that found nothing running. `/btw` alone sends `get_state` first, so
  it may start omp. An omp without the commands answers `Unknown command:
  btw` → localized "requires a newer omp" toast (`toastBtwError`); background
  reads stay silent and pause for `UNSUPPORTED_RETRY_MS`. omp's "cancelled
  before it started" failure is the user's own Cancel: no toast.
- The panel sits first in `ComposerPanels` (also rendered in the empty
  new-chat layout) and is keyed by record id: each new topic starts expanded,
  unlike todo/subagents. A running record this tab did not know yet opens it
  (another tab, reconnect); a known topic never reopens a closed panel.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. `subagent_event`
  frames also feed a bounded per-subagent activity buffer shown in the
  transcript dialog.
- **Roster hydration**: `get_subagents` snapshots (which carry progress)
  rehydrate the roster after SSE reconnect (`refreshSubagentRoster`, wired
  into mount, send, and the reconcile poll). Terminal subagents vanish from
  the RPC registry — history fills that gap.
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots. omp-web recovers
  the roster from disk (`extractSubagentHistory`, result fields win over the
  mid-run snapshot), so past/finished runs show in the composer panel after a
  reload. The transcript route pages the sibling file byte-wise (mirroring
  `get_subagent_messages`, which is RPC-registry-gated and refuses files it
  doesn't know). The dialog reads only the final output — `<id>.md` via
  `?mode=completion` (bounded tail read that also works for transcripts
  beyond the 16MB paging cap) with a live `get_subagents` snapshot fallback
  for header enrichment; it never pages the raw transcript. Subagent ids are
  `[A-Za-z0-9_-]+` segments joined by `.`, because omp names a nested spawn
  `Parent.Child` (`SUBAGENT_ID_RE` in `lib/subagent-types.ts`, which also
  keeps `/`, `\` and `..` out of the joined path). The transcript route caps
  them at 100 characters and validates before joining to confine reads to the
  sibling dir.
- **`agent://` links** (`lib/agent-links.ts`): `MarkdownBody` linkifies bare
  handles and inline code that is exactly a handle (remark plugin), keeps the
  `agent:` protocol through rehype-sanitize and `urlTransform`, and opens
  the handle through `AgentLinkContext`, which `ChatWindow` provides with
  `agentLinkTarget` (dotted nested id first, then the base id; unknown ids
  open a disk-backed stub). Without a provider the handle renders as plain
  text. The plugin runs after `remarkGithubRefs` (so `agent://Foo#12` is not an
  issue link) and never links omp's write-only `agent://all`. Because the
  shared sanitizer admits `agent:`, every `ReactMarkdown` host must drop
  rejected hrefs (`defaultUrlTransform(url) || undefined`) — a blank `href=""`
  links to omp-web itself; `FileViewer` does this.
  Tool rows (`ToolCallBlock` in `MessageView`) open an `agent://` `path`
  through the same context.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- The file panel's **Worktrees** tab (`components/WorktreesPanel.tsx`) switches, creates, and removes worktrees; the new-session screen's worktree `<select>` (AppShell, shown when the selected workspace has 2+ worktrees) only switches. `SessionSidebar` owns the per-repo worktree cache and the actions and emits them as a `WorktreeContext` (`onWorktreeContextChange`, null unless the active workspace is a Git top-level repo); AppShell hands it to both. Switching moves the sidebar's effective cwd (where a new session starts), not the open session.
- Explorer, Git, and file viewers use `explorerCwd` in AppShell: the open session's cwd first, then the sidebar's cwd, then the new-session cwd. Mention/copy-path helpers resolve relative paths against the same value.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists **managed projects**: explicitly added directories (registered in
  `~/.omp/agent/projects.json`, written atomically as temp-file + rename) plus
  session-discovered ones — hidden entries excluded. Removing a project only
  marks it hidden (reversible via re-adding); hidden entries suppress session
  re-discovery.
- Registry paths are canonical `projectRoot`s: `POST` resolves worktrees to
  their main repo via `resolveProject`, and `resolveProject` returns the
  symlink-free on-disk form for plain directories so registered and
  session-discovered paths compare equal on Windows casing.
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` —
  the in-memory browse allowlist does not survive restarts, and empty managed
  projects derive no root from sessions.
- By default (sort "None") the client orders the merged list manually
  (`sortOrder`, set by drag/Move up/down), then most-recently-added, then by
  path (`lib/project-ordering.ts`), so rows never jump while sessions refresh.
  The header sort button (`omp-web:project-sort` in `localStorage`, per
  browser) switches to Alphabetical (label A→Z) or Last updated (newest last
  message first: `lastMessageAt` from the session tail scan, else the file
  mtime) — the latter deliberately reorders on activity. While a
  sort is active, rows get a pin toggle: pinned projects (`pinOrder` in the
  registry, pinned to the end of the group) lead in their own manual order and
  alone keep Move up/down and drag; pins are ignored under "None".
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment. Rows show no worktree/branch selector (see the Worktrees tab).

### Clone a repository as a new workspace (`/api/projects/clone`)
- The Add-workspace `DirectoryPicker` takes an optional Git URL; "Clone here"
  clones into `<selected dir>/<repo name>`, then registers that directory
  through the normal `POST /api/projects` path.
- Only `https://`, `ssh://` and scp-like `user@host:path` URLs are accepted
  (`cloneDirectoryName`); git also runs with `GIT_ALLOW_PROTOCOL=https:ssh`
  and `GIT_TERMINAL_PROMPT=0`, so credentials must come from helpers/agents.
- The POST streams NDJSON (`output` chunks, then one of `done` / `cancelled` /
  `error`). Cancel is `DELETE { id }`: the POST stream stays open until the
  partial clone is deleted, so the UI can confirm the cleanup. A client
  disconnect cancels and cleans up too. An existing target is refused (409).

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from this machine's session cwds and their resolved project roots (as its daemon lists them: `hostSessions("local")`, the last list while the daemon is offline), `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`. Other hosts' paths never reach it.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- The session-id → file path cache (`cacheSessionPath`, `lib/session-reader.ts`) on main is filled by main's own scans and by wrappers on the local host; it only serves the readers listed under "Session list caching".

### Session list caching — new sessions must appear immediately
- The sidebar and command palette list sessions per host: `listSessionsAllHosts()` (`lib/hosts/session-index.ts`) calls each host's `listSessions` op and caches it 30 s per host (`LIST_TTL_MS`, the daemon's own TTL). **This machine's list is its daemon's**; a host that fails or is offline keeps its last list. Nothing on main parses session files to build it.
- The daemon's `listSessions` is `listAllSessions()` (`lib/session-reader.ts`): a 30 s TTL list cache plus an mtime-keyed directory walk in `lib/omp/session-files.ts` (`listSessionFiles`), both in the daemon process.
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.
- A mutation that main triggers calls `invalidateLocalSessionLists()`: it clears main's per-host entry and sends the daemon `invalidateSessionLists` (the daemon runs the invalidation above). A route that changes this machine's session files and does not call it leaves the sidebar stale for up to 30 s.
- **Still read on main, from this machine's own files** (main and the daemon share a machine, so these see the same sessions): transcript search (`session-content-search.ts`, `/api/sessions/search`), the session file watcher (`session-watcher.ts`), archive list/restore (`/api/sessions/archive`), import (`/api/sessions/import`), usage (`usage-db.ts`), and the bash-output, subagent-history and file-reference readers (`session-file-references.ts`, `subagent-history.ts`). They use main's own copies of `session-reader` and its caches, so they are invalidated separately (`invalidateSessionListCache()`); a new reader of session files on main for a session that may be remote is a bug.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- A `ResizeObserver` on the chat scroller (`ChatWindow`, beside `nearBottom`)
  keeps a reader whose previous view reached the bottom there when the
  scroller changes height (phone keyboard, composer or ask panel growing). It
  judges by the previous height, so content that grew below the reader (an
  expanded tool call) does not count as being at the bottom.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `$schema`, ...), and support rename via `previousName`.
- The MCP settings live in their own Settings tab (`SettingsTabs` id `"mcp"`,
  workspace-gated). Server list rows show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files`.

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- `/api/skills` lists through `lib/skills-service.ts`, which execs `omp skill list --json` with the project as the process cwd (omp ≥ 18.3.3; never pass the directory as an argument — Windows `.cmd` launchers run through `cmd.exe`, which would interpret `&` in it). That is the same discovery sessions use, including `namespace/name` collision aliases and plugin/registry/custom-directory skills. A pure-Node replica scan (project `.omp/skills` walk-up, `~/.omp/agent/skills`, the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs, managed skills) is only the fallback for older binaries and failed or malformed output. A failed run is negative-cached per binary fingerprint **and cwd** (5 min) so old installs don't spawn per request while one broken project config cannot degrade the others. Listing runs omp's normal startup, so it has omp's side effects (e.g. omp renames an unparseable `config.yml` aside, as a session would).
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives. omp reports it back as `hide` (it reads `hide`/`disableModelInvocation`/`disable-model-invocation`). Frontmatter is omp's only per-skill "hide from model, keep `/skill:`" knob; `disabledExtensions: ["skill:<name>"]` removes the skill entirely.
- Only user-owned skills are togglable: `getSkillToggleRoots()` (allowed file roots — workspaces the user opened — plus replica scan roots) is the single allowlist for both PATCH and the `togglable` flag GET returns; it is `main`'s pre-CLI allowlist, unchanged. Skills omp lists from anywhere else (the plugin cache, registry installs, custom directories outside a workspace) render a disabled toggle — their files belong to an installer and an update would discard the edit. Never widen PATCH to whatever omp lists.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` queries the npm registry for `@kahme247/ompweb` updates, detects the install (`installMethod`: `bun` vs `npm` via `detectInstallMethod`, `binary` for the compiled release), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @kahme247/ompweb` or `bun add -g @kahme247/ompweb`; for `binary`, the release page, which Settings shows under a download message).
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`, `get_logout_accounts`, `logout`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly. `/api/auth/accounts/[provider]` lists stored accounts and removes one by `credentialId`; omp without those commands reports `supported: false` and the UI falls back to the read-only `omp usage` account list.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

### Navigate back / forward (`lib/navigation-history.ts`, `hooks/useNavigationHistory.ts`)
- Browser-style back/forward over visited chat views (sessions + the new-chat
  composer), in-memory per page load. It is **omp-web's own stack**, never the
  browser History API — the app only ever `router.replace`s `?session=`, and
  the real history stack belongs to the mobile back-gesture / exit-guard
  machinery (`useSidebarHistory` + the popstate bridge).
- AppShell records views from one effect keyed on
  `(selectedSession?.id, newSessionCwd)`: recording the entry the cursor
  already sits on is a no-op, which is what makes back/forward
  self-suppressing — `navigateInHistory` commits the step, the view lands, the
  effect re-records the target, nothing is pushed. Any other view change
  (sidebar/palette select, new chat, session created, fork, project-switch
  close) pushes normally and truncates the forward branch, browser-style.
- Applying a step: peek → resolve the session id via `/api/sessions` →
  commit + `handleSelectSession`, or `handleNewSession` for new-chat entries.
  A dead id (deleted session) drops that entry and tries the next one in the
  same direction; a failed list fetch aborts without dropping. A view change
  during the await (versioned ref) aborts the navigation so a slow fetch
  never yanks the chat away.
- Shortcuts live in `useGlobalKeyboardShortcuts`: ⌘[/⌘] (macOS standard),
  Alt+←/Alt+→ (Windows/Linux standard; on macOS Alt+Arrow stays free — it is
  word-wise caret movement), plus the mouse back/forward buttons
  (`BrowserBack`/`BrowserForward`). The keystroke is always swallowed while a
  handler is registered — an exhausted stack stops dead rather than falling
  through to the browser's own back/forward, so the app is never backed out
  of by accident — and shortcuts are skipped entirely while a
  `[role="dialog"]` modal is open. The sidebar header buttons (before Archived
  Sessions, wrapped in `.sidebar-nav-buttons`) disable on stack bounds, show
  the platform shortcut in their tooltip, and hide below a 240px sidebar via
  the `.sidebar-shell` container query (the keyboard shortcuts still work).

### Composer word prediction (`hooks/useWordPrediction.ts`, `components/GhostMirror.tsx`)
- Ghost text comes from omp's `predict_word` RPC (engine = omp's
  `spelling.autocomplete` setting; omp applies the prose gates). Tab or →
  accepts; accept/typed-past outcomes go back as `predict_word_feedback`.
- Keystroke predictions never spawn or replace an omp child: the agent route
  answers `{ suffix: null }` when no process is alive, so sessions that are not
  running show no ghost text until the first send.
- Ghost text paints only when the caret ends its line (the mirror overlay would
  otherwise overlap typed text). Settings → Interface & Behavior → Word
  completion (`lib/composer-prefs.ts`, localStorage `omp-web:word-completion`):
  Auto (default) enables it only when the primary pointer is fine
  (`(pointer: fine)` — mouse/trackpad; browsers cannot detect an on-screen
  keyboard), Enabled/Disabled force it. Also skipped for
  drafts past 20k chars (omp's prose-gate cap); an omp without `predict_word`
  ("Unknown command") pauses requests for a minute.
- Ghost state lives in a small external store (`useSyncExternalStore` in
  `GhostMirror`), not ChatInput state: re-rendering the composer per ghost
  change was the dominant per-keystroke cost.

### Voice transcription jobs (`lib/stt-jobs.ts`, `/api/stt`, `hooks/useDictation.ts`)
- The browser never waits on the STT endpoint: `POST /api/stt` keeps the
  recording in memory and starts a job; the hook polls `GET /api/stt/[jobId]`
  (proxies with ~30s timeouts would otherwise return HTML 504s). Job failures
  are 200 payloads for the same reason.
- Jobs carry the composer scope (`draftKey`: session id, or `newChatDraftKey`:
  `new:<cwd>` here, `new:<hostId>:<cwd>` for a fresh chat on a remote host). The
  hook adopts the newest job for its scope on mount, focus, visibility and
  every 4s while visible and idle, so another browser can play (`/audio`),
  retry (`POST`) or discard it. Leaving the scope stops following without
  discarding.
- A finished job is delivered only by claim:
  `DELETE ?claim=<instance token>&owner=<tab token>` returns the text to the
  first claim token (repeatable with the same token); polls never carry text,
  and other composers see `gone` and stand down silently. A claim on an
  unfinished job is a no-op; a `DELETE` without `claim` discards and aborts
  the upstream request.
- Two tokens, never merged. The tab token (sessionStorage) identifies the
  job owner: it survives genuine-navigation composer remounts (a confirmed
  Edit identity move keeps the composer mounted), gets the 15s first claim,
  and alone gets the send/queue choice back. A duplicated tab copies it, so
  exclusivity comes from the claim token, which is per hook instance.
- The send/queue choice (`after`: send | steer | followup) is uploaded with
  the recording, kept on the job, and returned with the owner's claim. Never
  keep it only in component state: a session switch remounts the composer and
  loses it. A non-owner claim only inserts, since that composer holds its own
  draft and attachments.
- Store is per process (`globalThis` map) with caps (4 pending, 20 live) and
  TTLs; a server restart loses jobs, and the hook then re-uploads its local
  copy if it has one.
- Without `OMP_WEB_STT_ENDPOINT`, `OMP_WEB_STT_MODEL` names an omp STT model
  (e.g. `openai-codex/codex-transcribe`, the ChatGPT subscription) and jobs
  go through `lib/omp/auth-gateway.ts` as base64 JSON — so the gateway's 25MB
  body cap limits audio to 18MB there. omp-web never reads omp credentials.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Notifications (`lib/notification-*.ts`, `public/sw.js`, Settings → Notifications)
- Detection runs on the server in `AgentSessionWrapper.handleFrame` (and
  `handleProcessExit` for crashes), so sessions no tab watches still notify.
  `createNotificationDetector()` only inspects top-level frames; subagent
  activity is wrapped in `subagent_*` frames and never notifies. "Completed"
  fires on `session_settled` (not `prompt_result`), so background work started
  by the prompt is done too; a failed or aborted last prompt suppresses it.
  Auto-approved tool confirmations return before the hook and never notify.
  omp sends `retry_fallback_applied` before the `auto_retry_start` of the same
  failure, so the detector holds a reason-less fallback until that frame.
  Failures also arrive as omp-web's own `prompt_error` (failed `response`) and
  `process_exit` frames; the detector reports one failure per run.
- A session omp moved to a new file keeps its old ids as `aliases` on the
  event, so a tab still showing an old id counts as viewing it.
- Presence and streams are separate on purpose. Presence: each tab reports
  `{clientId, deviceId, visible, sessionId}` to `/api/notifications/presence`
  (visibility/session change, input after idling, every 30 s while present;
  expires 60 s after receipt). `visible` means visible AND input within 3 min.
  `sessionId` is null while full-page Settings hides the chat. Streams: the
  tab's open SSE connections (`attachNotificationClient`), which reconnect and
  overlap independently of presence. `clientId` is per page load, `deviceId`
  per browser (`localStorage`). Reports carry a per-page `seq`; the server
  drops one older than the stored report (requests can arrive out of order).
  Prefs PUTs run one at a time and read the prefs when sent, for the same reason.
- Routing (`routeNotification`, unit-tested): a visible tab on the session
  drops the event everywhere (presence only, so a reconnecting stream cannot
  leak it); else if a visible tab with an open stream exists, `whenActive:
  "toast"` devices get a toast on their active tabs only; else push (subscribed
  devices) or in-page `showNotification` (tabs with an open stream).
- The server decides before pushing: iOS revokes push permission for pushes
  that display nothing, so `public/sw.js` always shows what it receives.
- Notifications have their own `notifications` channel (`clientId` = the
  tab's notification client id), opened by `useNotifications` in `AppShell`,
  so a tab stays reachable on every view, Settings included. A tab on
  Settings is visible, so it also counts as active.
- Prefs and push subscriptions are per device, in `localStorage` and mirrored to
  the SQLite notification store in omp-web's data dir
  (`lib/notification-store.ts`, server-only; mode 0600 because it also holds
  the VAPID private key; WAL with a busy timeout). It also keeps the
  notification history. An installed server and `npm run dev` sharing the agent
  dir share it safely; the first open imports and deletes the old
  `notifications.json`. Push text is
  rendered server-side in the device's locale. Browsers with saved settings (enabled or not) sync on load; never-configured browsers do not.
- A crash notifies "Run failed" while a run is live or while background work
  started by it has not settled yet (`unsettled`, cleared by `session_settled`).
- The Settings test button pushes through the server for subscribed devices
  (502 with the push service's answer on failure) and shows a local
  notification otherwise, or a toast where none are allowed.
- `/sw.js` and `/badge-96.png` are exempt from the password gate (`proxy.ts`):
  browsers re-fetch the worker for updates without the session cookie.
- Notification clicks survive an expired sign-in: `proxy.ts` sends `/?session=…`
  to `/login?next=/?session=…`, and `LoginForm` returns there (only `/?…`
  targets are accepted). The worker navigates non-app windows to the session
  URL; the app falls back to that URL when `/api/sessions` cannot be read.

## Git history and PR landing rules

- **Never rewrite `main`'s history** — no force-push, `filter-branch`, rebase
  of already-pushed commits, or `reset --hard` followed by a force-push — unless
  the user explicitly asks for exactly that, after being told what it affects
  (every rewritten commit gets a new hash, forks and clones diverge). A cosmetic
  flaw such as a badly worded commit title is not worth it; leave it.
- Never push or rewrite someone else's branch. Contributors' commits keep their
  original hashes and authorship.
- Land PRs with a squash or rebase merge so each change is one commit with a
  normal title (`fix(scope): ...`, matching the surrounding log). Do not create
  throwaway integration branches (`scratch`, `pr-NNN`) and merge PR branches
  into them: git's auto-titles (`Merge branch 'pr-200' into scratch`) end up in
  the permanent history. If PRs conflict with each other (usually
  `CHANGELOG.md`), ask the authors to rebase, or resolve on a properly named
  branch and write real commit messages.
- Before merging a PR: CI green on the current head, mergeable, and diff read.
  Pass the head SHA to the merge so a late push is not merged unseen.

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible), `field.tsx` (form fields +
ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell).
Toasts are not stored. The notification list (`NotificationList`: the desktop
top-bar bell's popover, `NotificationBell`; the right panel's Notifications tab
on mobile only, `isMobile`) lists the server's
notification history (`lib/notification-history.ts`, a mirror of
`/api/notifications/history`): `publishNotification` records every
notification type some device has turned on (completed, input, error, model
switch), whether or not any tab or push receives it, already read when a
visible tab shows that session; the newest 100, so entries survive reloads and restarts and
every device sees the same list. The mirror loads on mount and when the tab
becomes visible (read marks and removals from other devices), adds events this
tab receives over SSE without a refetch, and reloads when the service worker
reports a push it showed. Entries store the `NotificationEvent` and render in
the viewer's language; clicking one, or Enter, marks it read and opens its
session (`OPEN_SESSION_EVENT`).
On desktop the bell carries the unread badge and its popover (base-ui Popover,
380px wide, at most 480px tall, the list scrolls) closes when a notification
opens a session. On mobile unread entries badge the right-panel toggle, which
then opens the Notifications tab. Entries become read when the user closes the
popover or leaves that tab (only the entries it
showed), uses Mark all as read, or opens the notification from its toast or
row, and a reused id (`<sessionId>:<type>`) is unread again. Mark-read, remove
and clear update the list at once, then the server; a failed request reloads
it. Unread rows show a leading accent dot and a bold title; read
rows are dimmed. Toasts and Notifications entries dismiss on
a sideways touch/pen swipe (base-ui's toast swipe; `NotificationRow` for the
list) and carry `data-swipe-dismiss`, which the mobile sidebar gesture skips.
`useDragClickGuard` swallows the click that ends any drag on them, judged by
the whole travel. `createSwipeTracker` cancels a swipe the finger turned back
(16px from its farthest point), as on Android; for toasts the release is
converted into the `pointercancel` base-ui treats as "snap back".
The `onClick` option makes the whole card the action: a click outside its
buttons, links and expandable text, ignoring drags and text selection, or Enter
on the focused card. There is no separate action button).
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.
