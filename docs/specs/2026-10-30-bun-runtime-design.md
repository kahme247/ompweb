# Bun runtime instead of Next.js — design

Date: 2026-10-30. Branch: `feat/bun-runtime`. Evidence: `spike/REPORT.md` (Bun 1.4.4, base `8e639641`).
Plan: `docs/plans/2026-10-30-bun-runtime.md`.

## Goal

omp-web serves its API, its static files and (in the next PR) WebSockets from one `Bun.serve` process, and Bun's bundler builds the React single-page app. Next.js is removed.

Why: Next blocks WebSocket upgrades (the next PR moves the host link to a WebSocket), cuts proxied request bodies over 10 MB, loads two module instances (instrumentation vs routes), and adds build traps ("never run `next build` during dev").

Non-goals: the WebSocket link itself; single-binary distribution (`bun build --compile`); any feature change. Users must not notice the switch.

## Requirements

- **R1 Runtime and distribution.** Bun ≥ 1.4 runs the server. The npm package `bun` is a dependency pinned exactly (`"bun": "1.4.4"`), so `npm i -g @kahme247/ompweb` and `npx` bring Bun with them. The Node launcher `bin/omp-web.js` stays the npm `bin`. It resolves Bun in this order: the package's `bun` dependency, then its `@oven/bun-<os>-<arch>` platform package (used when the postinstall did not run), then `bun` on PATH (version ≥ 1.4.4). It then spawns the server under that Bun. Linux x64 is verified in Task 1. macOS is verified on the user's Mac and Windows in the repo's Windows CI, both with the packed-install smoke test (Task 8).
- **R2 Next removed entirely.** This covers `next`, `eslint-config-next`, `next.config.ts`, the tsconfig `next` plugin, `.next`, `next/font`, `next/dynamic`, `next/navigation`, `next/headers`, `next/script` and `next/server`. A codemod turns `NextResponse.json` into `Response.json`, `NextRequest` into `Request` and `.nextUrl` into `new URL(req.url)`. `proxy.ts` becomes server middleware that returns a `Response`, or `"public"`/`"authenticated"` to continue (password gate and origin check, same behavior). `instrumentation.node.ts`'s `register()` runs once at server startup. `instrumentation.ts` is deleted.
- **R3 Routes.** Route handler files stay at `app/api/**/route.ts`, keep their `(req, { params: Promise<…> })` signature (the context also carries `disableIdleTimeout`, see R4), and are found through one hand-written table, `server/routes.ts`, with one import and one entry per file. A test fails when the table and the files on disk differ. The table feeds `Bun.serve` `routes`: `[id]` becomes `:id` and `[...path]` becomes `*`, with the rest segments decoded into `params.path`.
- **R4 HTTP behavior.** Bun's default `idleTimeout` (10 s) stays, so a socket that stalls before it is authenticated is reaped. Bun also cuts a handler that is still working after 10 s, so an `/api/` request that `proxy()` reports as authenticated (a session, the trusted header, or no password) runs with `server.timeout(request, 0)`, and the 10 s come back once its handler returns, so an idle keep-alive socket is still closed. A handler whose response stays open without traffic calls `disableIdleTimeout` to keep the limit off: SSE `/api/events`, the login SSE, the clone, search, bash-output and file streams, and the host link once its bearer token checks out. Bun's default `maxRequestBodySize` (128 MiB) stays: it is above every handler's own limit (101 MB uploads, 64 MB link blobs) and still bounds the handlers that read a bare `req.json()`. Hashed assets under `/assets/` get `public, max-age=31536000, immutable`. `index.html` (for `/` and `/login`) gets `private, no-cache, max-age=0, must-revalidate`. `sw.js` and `event-stream-worker.js` get `no-cache`, and other `public/` files `public, max-age=0`. Static files carry `Last-Modified` and answer a matching `If-Modified-Since` with 304. Compressible responses are gzip-compressed (Next did this). Unknown extensionless GET paths fall back to the SPA. The event-stream worker keeps its content-hash `?v=` URL.
- **R5 Node-only dependencies.** For each Node-only dependency or API that is a problem or a cost under Bun, a Bun built-in is checked first, and the Node dependency is kept only when no built-in fits. The resulting choices:
  - **Thumbnails:** `sharp` is replaced by `Bun.Image`.
  - **SQLite:** `node:sqlite` is replaced by `bun:sqlite`, which is synchronous like `DatabaseSync`, so the store APIs and their callers stay unchanged.
  - **HTTP proxy:** `undici` and `lib/http-dispatcher.ts` are removed, because Bun's `fetch` honors `HTTP(S)_PROXY`/`NO_PROXY`.
  - **Cookies:** `Bun.Cookie`/`Bun.CookieMap` replace `NextRequest.cookies`/`NextResponse.cookies`.
  - **`fs.accessSync`:** it returns `null` on Bun, so the `=== undefined` executable checks become try/catch.
  - **Kept:** `web-push`, `jsdom` and `node:child_process` (they work and no built-in replaces them). `jiti` also stays, for the Node-run `ompweb host` daemon and the tray; tests stop using it.
- **R6 Tests and checks.** Tests run under `bun test --parallel` with no jiti and no `--experimental-strip-types`. The full suite passes, as do `tsc --noEmit` (with `@types/bun`) and ESLint (typescript-eslint plus react-hooks, without the Next config).
- **R7 Front end.** Fonts are self-hosted from `app/fonts` (Geist, JetBrains Mono, Noto Sans Mono, Source Serif 4 as variable woff2). KaTeX CSS leaves the entry chunk: it is linked on first math render from `/katex/`. `NEXT_PUBLIC_*` become build-time `OMP_WEB_PUBLIC_APP_VERSION` and `OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION`. `next/dynamic` and `next/navigation` become local `lib/dynamic.tsx` and `lib/navigation.ts` with the same call-site API.
- **R8 Dev and prod.** `npm run dev` runs `bun --hot server/dev.ts` on port 30178: API plus HMR SPA in one process, bundled in memory. `npm run build` writes the client to `dist/`, and `npm start` serves it on 30177. Dev never reads `dist/`, so building during dev is harmless.
- **R9 Launchers, services and CI.** `bin/omp-web.js` spawns `<bun> server/main.ts -p <port> -H <host>` and keeps its restart and update protocol. The update worker runs on Node (`OMP_WEB_NODE_BIN`), so nothing executes the package's `bun.exe` while npm replaces it on Windows. The Windows scripts and `lib/windows-service.ts` check `dist/index.html` instead of `.next` and accept a `bun*` port owner. systemd/launchd/tray keep starting the Node launcher. CI adds a smoke test of the built app and of a packed global install, on Ubuntu and Windows.
- **R10 Package manager.** npm and `package-lock.json` stay; no `bun.lock`.
- **R11 Static roots.** The server resolves `dist/`, `public/` and the KaTeX directory from one root, `OMP_WEB_PACKAGE_DIR ?? process.cwd()`, never from `import.meta`/`__dirname`. This keeps a later compiled-binary build possible.
- **R12 Cleanup.** `spike/` is reference only. The plan's last task deletes it.

## Architecture

```
ompweb (Node ≥ 24: bin/omp-web.js) ── spawn + IPC ──▶ Bun: server/main.ts
  options, password hash, restart gate,              Bun.serve
  update arming, banner on "Ready"                    ├─ routes: server/routes.ts → app/api/**/route.ts
                                                      ├─ proxy.ts gate (before every route and file)
ompweb host / tray / systemd / launchd: Node          ├─ server/http.ts: security headers, cache, gzip, static, SPA
  (jiti loads lib/hosts/*, lib/windows-service.ts)    └─ register() from instrumentation.node.ts once
npm run build: scripts/build-client.ts → Bun.build(app/index.html) → dist/
npm run dev:   bun --hot server/dev.ts (HTML import, HMR, no dist/)
```

## Invariants (must not change for users)

1. **URLs.** All 70 `/api/**` paths and their methods are unchanged. Also unchanged: `/`, `/login`, the `/?session=<id>` deep link, `/sw.js`, `/event-stream-worker.js?v=<hash>`, `/api/manifest` (gated, with credentials), `/icon.svg`, `/icon.png`, `/icon-192.png`, `/badge-96.png`, `/omp-web-logo.svg` and `/omp-web.ico`. Static segments still win over `[id]` (`/api/sessions/search`, `/api/agent/new`). OPTIONS/HEAD still work as Next answered them (204 with `Allow`; HEAD uses GET). A missing method answers 405, and malformed `%` encoding answers 400.
2. **Ports and CLI.** 30177 for prod and the launcher default, 30178 for dev. The `ompweb` flags (`-p/--port`, `-H/--hostname`, `--no-open`, …), the subcommands (`host`, `hash-password`, the service forwarders) and the `ompweb*` bins are unchanged. Node ≥ 24 is still required.
3. **Environment variables.** Unchanged: `OMP_WEB_PASSWORD_HASH` (and the refusal of a legacy `OMP_WEB_PASSWORD`), `OMP_WEB_NAME`, `OMP_WEB_OMP_BIN`, `OMP_WEB_PORT`, `OMP_WEB_HOSTNAME`, `OMP_WEB_SERVICE`, `OMP_WEB_TRUSTED_HEADER*`, `OMP_WEB_SECRET_ENV_VARS`, `OMP_WEB_STT_*`, `OMP_WEB_DISABLE_AUTOUPDATE`, `OMP_WEB_DISCONNECT_DESTROY_MS`, `OMP_WEB_OPEN`/`OMP_WEB_NO_OPEN`, `OMP_WEB_TERMINAL`, `OMP_WEB_SYSTEMD_BIN`, `PI_CODING_AGENT_DIR` and `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. The only removal is the dev-only `OMP_WEB_DEV_ORIGIN` (Next's HMR origin allow-list, which has no Bun counterpart).
4. **Password gate.** These behaviors stay identical (`proxy.ts`):
   - a misconfigured hash refuses everything with 503 text;
   - with no password, `/login` redirects 307 to `/`;
   - with a password and no session, `/api/*` answers 401 `{code:"password_required"}`, and pages redirect 307 to `/login`, keeping `?next=/?session=…` for `/` with a query;
   - a signed-in `/login` redirects 307 to `/`;
   - `/api/web-auth/session` stays open;
   - the session cookie keeps its name, `HttpOnly; SameSite=Lax; Path=/; Max-Age`, and `Secure` on https or `x-forwarded-proto: https`;
   - the trusted proxy header is honored.

   Ungated paths stay the same: the icons, `sw.js`, `/api/hosts/link` and its subpaths, plus the login page's assets (`/assets/*`, which replace `/_next/static/*`). No `x-middleware-*` header ever reaches a client.
5. **Origin check.** Cross-origin `/api/*` requests still get 403.
6. **Security headers.** These are exactly the `next.config.ts` values. CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `Permissions-Policy: camera=(), microphone=(self), geolocation=()` apply to every path except `/api/files/*`. That path gets `nosniff`, `SAMEORIGIN`, `no-referrer` and `camera=(), microphone=(), geolocation=()`, and keeps the handler's own CSP. A config header overwrites a handler header of the same name. No `X-Powered-By`.
7. **SSE and host link.** `/api/events` behavior is unchanged: hello, subscribe, 30 s heartbeats, cleanup on client abort. The stream stays open past Bun's 10 s default idle timeout. The host link keeps bearer auth, NDJSON and blob uploads, with only its own 16 MB/64 MB limits under Bun's 128 MiB server cap (Next truncated gated bodies at 10 MB).
8. **Files and data.** The file allow-lists (`lib/file-access.ts`) are unchanged. `<agent dir>/omp-web/notifications.db` keeps its schema, location and mode 0600, and existing stores open as they are. The usage database keeps its path and `user_version`. The diagnostics journal keeps its path and format. Thumbnails stay 480 px WebP behind `?thumb=1`, cached as `<hash>.thumb.webp`, with EXIF orientation applied.
9. **Updates and services.** The update commands stay `npm install -g @kahme247/ompweb` / `bun add -g @kahme247/ompweb`. In-app update keeps `UPDATE_PROTOCOL` 1 and its control files. The restart gate and the systemd, launchd and Windows unit/task names, along with the `ompweb-host` service, are unchanged.
10. **HTML head.** Same title (install name from `OMP_WEB_NAME`, HTML-escaped), description, viewport (`viewport-fit=cover, interactive-widget=resizes-content`), Apple web-app tags, `format-detection`, manifest link with `crossorigin="use-credentials"` and `/icon.svg`. The theme, language, font-size, UI-scale and touch-target scripts run before first paint, and the sidebar history bridge runs before React.

## Intentional differences (dev-only or invisible)

- **Dev HTML path:** dev also answers `/__omp_dev_index` without the gate. Pages fetch Bun's HTML import from there, and it is the same public shell that `/login` serves. Dev pages also allow `blob:` scripts in their CSP, because Bun's HMR client runs each update as one.
- **`OMP_WEB_DEV_ORIGIN` is removed.** It was dev-only.
- **Bodies over 10 MB on gated routes reach the handler** (up to Bun's 128 MiB cap). Its own limit applies instead of a silent truncation.
- **Unknown paths:** unknown extensionless page paths get the SPA instead of Next's 404 page, and unknown `/api/*` paths get a plain-text 404.
- **ESLint covers less:** it runs typescript-eslint recommended plus react-hooks. The Next config's `react`, `jsx-a11y`, `import` and `@next/next` rules are dropped.
- **No error page around the layout:** `app/global-error.tsx` has no counterpart. One root error boundary shows the `app/error.tsx` screen.

## Verified assumptions

Pre-checks by the planner (2026-10-30, Bun 1.4.4, Node 26.8.1, npm 11.19.0, Linux x64) and the spike. Task 1 re-runs the ones marked ▶ against this repo and appends its rows.

| Assumption | Evidence |
|---|---|
| The `bun` npm dependency provides a binary (linux-x64) | `npm install bun@^1.4.4`: npm warns about install scripts but runs the postinstall; `node_modules/bun/bin/bun.exe` is 107 MB and `--version` prints `1.4.4`. ▶ packed global install |
| Without the postinstall | `npm install --ignore-scripts`: `bin/bun.exe` is a 450-byte placeholder ("Bun's postinstall script was not run"), and the real binary is at `node_modules/@oven/bun-linux-x64/bin/bun` |
| Proxy env | Spike probe 6: Bun `fetch` honors `HTTP_PROXY`, bypasses via `NO_PROXY`, and a dead `HTTPS_PROXY` gives `ECONNREFUSED`. ▶ NO_PROXY |
| Node parent ↔ Bun child IPC | Node 26 `spawn(bun, …, {stdio: [..,"ipc"]})`: `process.send` works both ways (`{"echo":{"hello":1},"bun":"1.4.4"}`). ▶ with the launcher |
| tsconfig `@/*` inside `node_modules` | `bun <pkg in node_modules>/server/main.ts` importing `@/lib/a` prints `paths ok 42` |
| bun:sqlite on a node:sqlite file | It opens a WAL database written by Node `DatabaseSync`. Multi-statement `exec` works, `inTransaction` is true inside `BEGIN IMMEDIATE`, `.get()` with no row returns `null` (Node: `undefined`), and `run()` returns `{changes, lastInsertRowid}`. ▶ real store, 0600, second process |
| Bun.serve routing | `:id` arrives decoded (`a%20b` → `a b`), and a static sibling wins. `*` sets no param, and malformed `%E0%A4%A` arrives as U+FFFD, not an error. The default `maxRequestBodySize` answers 413 to a streamed 150 MiB POST, and `Number.MAX_SAFE_INTEGER` accepts it |
| Bun.Image | EXIF orientation 6 on a 40×20 JPEG reads as 20×40. `resize(480,480,{fit:"inside",withoutEnlargement:true}).webp({quality:80})` turns 1600×1000 into 480×300 |
| Bun.build HTML | With `naming` it writes `dist/index.html` plus `dist/assets/<name>-<hash>.{js,css}`, and inline classic `<script>`s stay in `<head>` |
| bun test | It finds `*.test.mjs` and supports `--parallel` (implies `--isolate`). `import("./m.ts?fresh=1")` gives a fresh instance, and `mock.module("node:fs")` reaches named imports of modules loaded afterwards |
| Task 1 probe: packed global install (Linux x64, npm 11.19.0) | `npm pack --ignore-scripts`, then `npm install -g --prefix <p> ./kahme247-ompweb-0.6.0.tgz`: `resolveBunBinary(<p>/lib/node_modules/@kahme247/ompweb)` → `…/node_modules/bun/bin/bun.exe` (107 MB), `--version` → `1.4.4`. npm warned the `bun` postinstall is "not yet covered by allowScripts" but still ran it. With `--ignore-scripts`, `bin/bun.exe` is 450 bytes and the resolver returns `…/node_modules/@oven/bun-linux-x64/bin/bun`, `--version` → `1.4.4` |
| Task 1 probe: NO_PROXY | `HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1 bun np.ts` (`Bun.serve({port:0})` + `fetch`) → `200 ok`. Without `NO_PROXY` → `ECONNREFUSED` |
| Task 1 probe: launcher IPC | Node `spawn(resolveBunBinary(repo), ["child.ts"], {stdio:["inherit","inherit","inherit","ipc"]})`: parent got `{"ready":true}`, sent `{hello:1}`, got `{"echo":{"hello":1},"bun":"1.4.4"}` |
| Task 1 probe: store compatibility | Under Node + jiti with `PI_CODING_AGENT_DIR=<tmp>`: `getVapidKeys`, `saveDevice`, `recordHistory`, `getUsageDatabase()` created `omp-web/notifications.db` and `usage.db`. `bun:sqlite` read back the vapid row, the device row and the history row, and the usage tables (`synced_files`, `usage_records`); `PRAGMA journal_mode` → `wal` (both); `stat -c %a notifications.db` → `600`. A second `bun` process doing `BEGIN IMMEDIATE` (`busy_timeout = 5000`) while the first held a write transaction for 1.5 s waited 933 ms (started 0.6 s in), then succeeded after the commit |
| Task 1 probe: body cap | Streamed 150 MiB POST to `Bun.serve`: default → `413`; `maxRequestBodySize: Number.MAX_SAFE_INTEGER` → `200 ok 157286400` |
| Task 1 probe: macOS | pending: user's Mac (Task 8 packed smoke) |
| Task 1 probe: Windows | pending: Windows CI (Task 8) |

## Acceptance criteria

1. `rg -n --glob '!docs/**' --glob '!CHANGELOG.md' "from ['\"]next|NextResponse|NextRequest|nextUrl|next/font|next/dynamic|next/navigation|next/headers|next/script|eslint-config-next"` → no matches. `package.json` has no `next`, `sharp`, `undici`, `eslint-config-next`, `@tailwindcss/postcss` or `postcss`.
2. `npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm run smoke` passes on Ubuntu and Windows CI. `npm test` has 0 failures and no test file was deleted, except `lib/security-headers.test.mjs`, which is ported to `server/http.test.ts`.
3. The packed-install smoke (`npm pack`, global install into a temp prefix, `npm run smoke -- --package <dir>`) passes on Ubuntu CI, Windows CI and the user's Mac.
4. The server tests pin invariants 1, 4, 5, 6 and 7. The store, media and update-worker tests pin 8 and 9, and the index-render test pins 10.
5. `AGENTS.md` describes the Bun architecture, the route table and the new traps, and has no Next block or "never run next build" trap. README (en/ja/zh-CN), CONTRIBUTING, DESIGN and CHANGELOG are updated. `spike/` is gone.

## Future work (out of scope)

- A single binary: compile the server program with `bun build --compile`. The client bundle, HTML, CSS and `public/` ship next to it as files, not embedded. R11 and the static route table keep this possible.
- The WebSocket host link (next PR).
