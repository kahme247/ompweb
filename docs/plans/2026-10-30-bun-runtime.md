# Bun Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** omp-web runs on one `Bun.serve` process (API, static files, SPA) built by Bun's bundler, with Next.js removed and no user-visible change.

**Architecture:** The Node launcher `bin/omp-web.js` resolves the Bun binary from the package's pinned `bun` dependency and spawns `server/main.ts`. The server routes `app/api/**/route.ts` through a hand-written table (`server/routes.ts`) into `Bun.serve` `routes`, runs `proxy.ts` as its gate, and serves `dist/` (built by `scripts/build-client.ts`). `ompweb host`, the tray and the service helpers stay on Node.

**Tech Stack:** Bun 1.4.4 (`Bun.serve`, `Bun.build`, `bun:sqlite`, `Bun.Image`, `bun test`), React 19, Tailwind 4 via `bun-plugin-tailwind`, Node ≥ 24 for the launcher, npm + `package-lock.json`.

**Spec:** `docs/specs/2026-10-30-bun-runtime-design.md` (requirements R1–R12, invariants 1–10, acceptance criteria). Read it first. Spike evidence: `spike/REPORT.md`, `spike/server.ts`, `spike/build.ts`, `spike/shims/`.

## Global Constraints

- Work only in `/root/git/.ompweb_worktrees/bun-runtime` on `feat/bun-runtime`. One commit per task, using the message given in that task.
- Bun is pinned exactly: dependency `"bun": "1.4.4"`, devDependency `"@types/bun": "1.4.4"`, devDependency `"bun-plugin-tailwind": "0.1.2"`. Node ≥ 24 stays in `engines` (the launcher, `ompweb host`, tray and service helpers run on Node).
- npm only: `npm install`/`npm ci` and `package-lock.json`. Never run `bun install` or `bun add`, and never commit a `bun.lock`.
- `node_modules` in this worktree is a symlink to another worktree's (`../local-daemon/node_modules`). Task 1 replaces it with a real `npm ci` (`rm node_modules` removes only the link). Never install through the symlink.
- Ports: verification uses port 0 or 30300–30399. Never use 30177–30195. Never start, stop or restart a systemd/launchd/tray service. Never touch the real `~/.omp`: servers started for checks get `HOME`, `PI_CODING_AGENT_DIR` (temp dirs) and `OMP_WEB_OMP_BIN=/nonexistent/omp`, as `spike/env.sh` does.
- **Bun built-ins first (user rule):** whenever a dependency or Node-specific pattern is a problem or a cost under Bun, first check Bun's built-in alternatives (`Bun.*` APIs, `bun:*` modules, Bun.serve/bundler/test features) and use one if it fits. Only after that, assess whether keeping the Node dependency is viable. Do not churn working code just to use a Bun API. The decisions already made are in "Bun built-ins check" below; a new case gets a row there in the same commit.
- Modules loaded by the Node-run daemon and tray (`lib/hosts/**` and what they import, `lib/windows-service.ts`, `bin/*.js`) never use `Bun.*` or `bun:*`. They keep loading through `jiti`.
- Server runtime code resolves files from `const root = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd()`, never from `import.meta.dir`/`__dirname` (spec R11). Build scripts and tests may use `import.meta.dir`.
- Client code never uses `AbortSignal.timeout/any` or `Promise.withResolvers`. Every new UI string exists in all `lib/i18n/locales/*.json` (this plan adds none).
- No feature or behavior change: spec invariants 1–10 are the contract. No new `eslint-disable` comments.
- From Task 2 on, every task ends with `npm run typecheck && npm run lint && npm test` green.
- Line numbers are hints. Locate code by symbol.

## Review Focus

1. **SSE and host link through an idle gap longer than Bun's 10 s default:** `/api/events` stays open and keeps delivering (Task 5 `server/app.test.ts` idle test, Task 8 smoke step).
2. **Sign-in over the new server:** with a password set, `/?session=x` → 307 `/login?next=%2F%3Fsession%3Dx`. The login page's `/assets/*` load without a cookie and `/api/hosts/link` answers its own 401 (Task 5 `lib/web-auth.test.mjs` + `server/app.test.ts`). No code sets an `x-middleware-*` header any more, so the final review dropped that never-firing assertion.
3. **Static path traversal:** `/..%2Fpackage.json`, `/%2e%2e/package.json`, `/assets/..%5C..%5Cpackage.json` and a NUL byte all answer 404 and never a file outside `dist/`, `public/` or the KaTeX dir (Task 5 `server/http.test.ts`).
4. **Windows in-app update:** no process runs from the package's `bun.exe` while `npm install -g` replaces it. The update worker command is `OMP_WEB_NODE_BIN`, and the worker stops the server first (Task 7 `lib/self-update.test.mjs`).
5. **Installs where Bun's postinstall did not run** (`--ignore-scripts`, `bun add -g` without trusted deps, npm blocking scripts): the launcher uses the `@oven/bun-<os>-<arch>` binary (Task 1 `bin/bun-runtime.test.mjs`, Task 8 packed smoke).

## Inventory (completeness checks; counts at `ae868dc1`)

| Surface | Count | Where | Task |
|---|---|---|---|
| `next/server` importers | 64 + 1 | 60 route files, `lib/api-utils.ts`, `proxy.ts`, `lib/file-access.test.mjs`, `lib/file-index-route.test.mjs`; `lib/web-auth.test.mjs` imports `next/server.js` | 3 (proxy and web-auth test: 5) |
| `NextResponse.json(` | 381 sites / 61 files | 377 outside `proxy.ts` (60 files) | 3 / 5 |
| `new NextResponse(` | 5 | `notifications/presence`, `notifications/test`, `sessions` routes (4), `proxy.ts` (1) | 3 / 5 |
| `NextResponse.redirect(` / `.next(` | 3 / 4 | `proxy.ts` only | 5 |
| `.nextUrl` | 19 | 14 in `cwd/browse`, `file-index`, `files/[...path]`, `git/diff`, `git/status`, `github-repo`; 5 in `proxy.ts` | 3 / 5 |
| `NextRequest` | 28 | 26 in 6 routes + 3 tests; 2 in `proxy.ts` | 3 / 5 |
| `.cookies` | 2 | `app/api/web-auth/session/route.ts` (response), `proxy.ts` (request) | 5 |
| Other `next*` imports | 10 files | type `next` (`app/layout.tsx`, `app/api/manifest/route.ts`, `next.config.ts`); `next/constants`, `next/dist/.../path-match` (`lib/security-headers.test.mjs`); `next/experimental/testing/server.js` (`lib/web-auth.test.mjs`); `next/dynamic` (`AppShell`, `CommandPaletteMount`, `SettingsConfig`: 9 call sites); `next/navigation` (`AppShell`); `next/font/google`, `next/script` (`layout.tsx`); `next/headers` (`layout.tsx`, `page.tsx`) | 3–5 |
| Route files / `export const dynamic` / `runtime` | 70 / 38 / 2 | `runtime`: `sessions/[id]/export`, `sessions/archive` | 5 |
| `.next` / `next` CLI in code and config | — | `bin/omp-web.js` (`nextDir`, `resolveNextBin`, `nextArgs`, `main` check); `bin/omp-web-security.test.mjs:22-26`; `package.json` (`files`: 8 `.next` entries + `next.config.ts`; scripts: 5 `next` commands); `tsconfig.json` (plugin + 3 `.next` includes + `next-env.d.ts`); `.gitignore` (`/.next/`, `/.next-dev*.log` ×2, `next-env.d.ts`); `scripts/windows/omp-web-service.ps1:33,131`; `scripts/windows/omp-web-tray.ps1:79-80,249`; `nix/package.nix` (fonts patch, fileset); comments in `lib/directory-browser.ts:62`, `lib/rpc-manager.test.mjs:1524`. **Keep:** the `".next"` entries in the ignore lists of `app/api/file-index/route.ts:21` and `app/api/files/[...path]/route.ts:28`, and `lib/worktree.ts:109` (they are about user projects) | 5, 7, 8 |
| jiti | 121 test files + 2 bins | 120 `createJiti`; 18 with `alias` (17 only `"@/"`; 1 real mock: toast stub in `hooks/useAgentSession.rpc.test.mjs`); 6 `moduleCache: false`; 7 call-style `jiti(…)`. **Kept:** `bin/omp-web-host.js`, `bin/omp-web-tray.js` (Node) | 2 |
| `--experimental-strip-types` / `syncBuiltinESMExports` | 3 / 3 | `package.json`, `lib/draft-store.test.mjs`, `lib/github-repo.test.mjs` / `lib/rpc-manager.test.mjs`, `lib/session-reader.test.mjs`, `lib/session-routes.test.mjs` | 2 |
| Tests importing `app/api` modules | 16 | 14 through jiti; `lib/api-contract.test.mjs` reads source text | 2–3 |
| `process.execPath` in tests | 11 files | `bin/{node-version-gate,omp-web-hash-password,omp-web-security,omp-web-systemd}.test.mjs`, `lib/{draft-store,instrumentation-crash-policy,notification-store,rpc-manager,session-resume,skills-service,stt-omp-gateway}.test.mjs` | 2 |
| DOM tests (`tests/setup-dom.mjs` importers) | 30 | 29 import Testing Library statically | 2 |
| `node:sqlite` | 4 files | `lib/notification-store.ts`, `lib/usage-db.ts`, `lib/usage-db.test.mjs`, `lib/notification-hub.test.mjs` | 6 |
| `sharp` / `undici` | 3 / 4 files | `lib/media-cache.ts`, `lib/media-route.test.mjs`, `package.json` (+ comment in `app/api/media/[hash]/route.ts:8`) / `lib/http-dispatcher.ts`, `next.config.ts`, `package.json` (+ comment in `lib/stt-jobs.ts:47`) | 6 |
| `accessSync(...) === undefined` | 2 | `bin/omp-web-systemd.js` `isExecutableFile`, `bin/linux-tray.js` `isExecutable` | 2 |
| `NEXT_PUBLIC_*` | 3 vars, 3 sites | `components/ChatWindow.tsx`, `components/SessionSidebar-chrome.tsx`, `lib/event-stream.ts`. The generic `NEXT_PUBLIC_FOO` env-stripping tests stay | 4 |
| `@next/next/no-img-element` disables | 5 | grep | 5 |
| `"use client"` | 85 files | harmless directive; **kept** (removal is churn) | — |

## Bun built-ins check (user rule)

| Node dependency / pattern | Bun built-in checked | Choice |
|---|---|---|
| `next` (router, server, bundler, fonts) | `Bun.serve` `routes`, `Bun.build` HTML entry, HTML import + HMR | Replace |
| `sharp` (thumbnails) | `Bun.Image` (applies EXIF orientation; resize/webp verified) | Replace |
| `undici` + `lib/http-dispatcher.ts` | Bun `fetch` honors `HTTP(S)_PROXY`/`NO_PROXY` | Remove |
| `node:sqlite` `DatabaseSync` | `bun:sqlite` `Database` (sync, prepared statements, WAL, `busy_timeout`, `inTransaction`); `Bun.SQL` assessed below | Replace with `bun:sqlite` |
| jiti in tests | `bun test` loads TS and tsconfig paths natively; `mock.module`; `?fresh=N` imports | Replace |
| jiti in `bin/omp-web-host.js`, `bin/omp-web-tray.js` | Running them under Bun would drop jiti, but every supervisor-started daemon would need a Node→Bun hop (SIGTERM must reach the daemon) | Keep (Node) |
| `node:test` / `node:assert` imports in tests | `bun test` runs them as they are | Keep; use `bun:test` only for `mock.module`/`spyOn` |
| `t.mock.method(fs \| childProcess, …)` + `syncBuiltinESMExports()` | `mock.module("node:fs", …)` swaps the builtin for every importer, but `mock.restore()` does not undo it | `bun:test` `mock.module` via `tests/mock-builtin.mjs`, which re-registers the real exports in `t.after` |
| `jsdom` | No DOM built into Bun | Keep |
| `@tailwindcss/postcss` + `postcss` | Bun CSS bundler + official `bun-plugin-tailwind` | Replace |
| `NextRequest.cookies` / `NextResponse.cookies` | `Bun.CookieMap` / `Bun.Cookie` | Replace |
| Next's built-in gzip | `CompressionStream("gzip")` (web standard, built in) | Replace |
| Gzip of `/api/` answers (Next 16 never compressed route-handler responses; a 40 MB session read cost ~1 s per request) | `CompressionStream`, `Bun.gzipSync` (blocks the loop ~650 ms per 40 MB), `node:zlib` streams (slower under Bun) | None: `/api/` answers go uncompressed, as under Next |
| `node:sqlite` `close()` finalized open statements | `bun:sqlite` `close()` keeps the file open until its prepared statements are collected (Windows: EBUSY) | `close(true)` |
| Next's `listen` failed on a taken port | `Bun.serve` sets `SO_REUSEPORT` when `development` is false | `reusePort: false` |
| `node:child_process` (45 files) incl. IPC to the Node launcher | `Bun.spawn`; Node's API works under Bun, including Node↔Bun IPC | Keep (no problem) |
| `web-push` (VAPID, aes128gcm) | No built-in; works under Bun (spike probe 5) | Keep |
| `fs.accessSync` returns `null` on Bun | — (semantics bug) | try/catch |
| `eslint-config-next` / `tsc` | Bun has no linter or typechecker | `typescript-eslint` + `eslint-plugin-react-hooks`; `tsc` with `@types/bun` |
| `next/font/google` (4 families) | No Bun font loader. Bun's CSS bundler inlines every `url()` asset under 128 KiB as a base64 data URL and ignores `loader: { ".woff2": "file" }` (oven-sh/bun#24599) | Self-host `@fontsource-variable` woff2 (OFL) in `app/fonts/`; a `Bun.build` plugin (`onResolve`, `external: true`) keeps them as hashed `/assets/` URLs and `scripts/build-client.ts` copies them |
| `next/dynamic`, `next/navigation` (client) | `React.lazy` + `Suspense`; History API with `useSyncExternalStore` (Bun has no client router) | Replace (`lib/dynamic.tsx`, `lib/navigation.ts`) |
| `fs.watch` in the file viewer channel (Bun drops an event within ~2 ms of the previous one) | Bun has no other file-watch API (`--watch`/`--hot` watch the process's own modules) | Keep `fs.watch`; `lib/event-stream-hub.ts` re-stats once 50 ms after the last event |
| Bun's HTML bundler moves the entry `<link rel="stylesheet">` to the end of `<head>`, after the pre-paint theme script that reads `--bg` | No bundler option for tag placement | `scripts/build-client.ts` moves the link before the first inline script in `dist/index.html` (dev keeps Bun's order) |
| Tailwind's `color-mix()` polyfill (a full-strength fallback plus a nested `@supports (color: color-mix(in lab, red, red))` override per declaration): Bun 1.4.4's CSS bundler drops an `@supports` rule that follows one with the same condition, so rules with two such declarations, and keyframes, lost their overrides | Bun CSS targets: fixed (Chrome 80, Safari 14), no `Bun.build` CSS option, no browserslist; Bun keeps `color-mix()` with `var()` as written. `bun-plugin-tailwind` 0.1.2 has no `polyfills` option | `scripts/tailwind-plugin.ts` wraps the plugin and removes the polyfill from Tailwind's output (build and dev); Next's targets (Chrome 111, Safari 16.4) support `color-mix()`. `scripts/tailwind-plugin.test.ts` fails if a source `color-mix()` is missing from the built CSS |

**Bun.SQL (async) vs bun:sqlite for the notification store — assessment.** `lib/notification-hub.ts` calls the store synchronously on hot paths:
- `publishNotification` (sync, called from session event handling) runs `listDevices` and `recordHistory`;
- `getVapidPublicKey` and `stillSubscribed` are sync;
- only `sendPush`/`sendTestPush` are already async.

The two notification routes are async, but every query is a microsecond-scale local lookup. Bun.SQL's sqlite adapter wraps the same in-process SQLite in promises. That gives no I/O concurrency, while `publishNotification` would become async and its history-then-broadcast ordering would need awaiting. **Verdict:** bun:sqlite is the better long-run fit, so no GitHub issue is needed.

## File map

- **Create:**
  - `bin/bun-runtime.js` and `bin/bun-runtime.test.mjs`;
  - `server/routes.ts`, `server/http.ts`, `server/app.ts`, `server/main.ts`, `server/dev.ts`, `server/client-env.ts` and their tests `server/{routes,http,app,client-env}.test.ts`;
  - `app/index.html`, `app/client.tsx`, `app/boot.ts`;
  - `components/AppErrorBoundary.tsx`, `lib/dynamic.tsx`, `lib/navigation.ts`;
  - `scripts/build-client.ts`, `scripts/smoke.ts`, `bunfig.toml`;
  - `app/fonts/*.woff2` and their OFL licenses.
- **Delete:**
  - Next files: `next.config.ts`, `instrumentation.ts`, `postcss.config.mjs`;
  - Next app files: `app/layout.tsx`, `app/page.tsx`, `app/login/page.tsx`, `app/error.tsx`, `app/global-error.tsx`;
  - Code replaced by Bun: `lib/http-dispatcher.ts`, `lib/security-headers.test.mjs` (ported);
  - The spike: `spike/`.
- **Move:** `app/icon.svg` → `public/icon.svg`.

---

### Task 1: Prove the distribution and runtime assumptions; add the Bun resolver

**Files:**
- Modify: `package.json`, `package-lock.json` (add `bun`, `@types/bun`), `docs/specs/2026-10-30-bun-runtime-design.md` ("Verified assumptions" rows)
- Create: `bin/bun-runtime.js`, `bin/bun-runtime.test.mjs`

**Interfaces:**
- Produces (CommonJS, Node-compatible, no Bun APIs):
  ```js
  const MIN_BUN_VERSION = "1.4.4";
  /** Absolute path of the Bun that runs the server, or "bun" when only PATH has one. Throws Error("Bun runtime not found: …") naming the reinstall command. */
  function resolveBunBinary(packageDir, env = process.env) // → string
  module.exports = { MIN_BUN_VERSION, resolveBunBinary };
  // CLI: `node bin/bun-runtime.js <args…>` runs Bun with <args>, inherits stdio, exits with its status (used by the Windows dev fallback, Task 7).
  ```
  Order: (1) `require.resolve("bun/package.json", { paths: [packageDir] })` → `<dir>/bin/bun.exe` if it is a file > 1 MiB (the 450-byte placeholder means the postinstall did not run). (2) The first existing `@oven/bun-<os>-<arch>{,-musl,-baseline}/bin/bun[.exe]`, resolved from the `bun` package dir: os `darwin|linux|windows` (from `process.platform`, win32 → windows), arch `aarch64|x64`. (3) `bun` on `env.PATH` whose `--version` is ≥ `MIN_BUN_VERSION`, returned as `"bun"`.

- [ ] **Step 1: Real install.** `rm node_modules && npm ci`. Expected: `test -d node_modules && ! test -L node_modules` succeeds.
- [ ] **Step 2: Add Bun.** `npm install --save-exact bun@1.4.4 && npm install --save-dev --save-exact @types/bun@1.4.4`. Expected: `node_modules/.bin/bun --version` → `1.4.4`.
- [ ] **Step 3: Failing tests** in `bin/bun-runtime.test.mjs` (`node:test`; runs under `node --test` now and `bun test` after Task 2):
  - `resolves the package's own Bun`: `resolveBunBinary(repoRoot)` is an existing file, and running it with `--version` prints `require("../package.json").dependencies.bun`.
  - `falls back to the platform package when the postinstall did not run`: a temp dir with `node_modules/bun/package.json` (`{"name":"bun","version":"1.4.4"}`), a 450-byte `node_modules/bun/bin/bun.exe` and `node_modules/@oven/bun-<os>-<arch>/{package.json,bin/bun[.exe]}` → returns that `@oven` path.
  - `uses bun on PATH last and refuses an old one` (skip on win32): a temp `PATH` dir whose `bun` script prints `1.3.0` → throws matching `/1\.4\.4/`; printing `1.4.4` → returns `"bun"`.
  - `no Bun anywhere`: `resolveBunBinary(emptyDir, { PATH: "" })` throws `/Bun runtime not found/`.
- [ ] **Step 4: Run** `node --test bin/bun-runtime.test.mjs` → FAIL (module missing).
- [ ] **Step 5: Implement** `bin/bun-runtime.js` (version compare: split on `.`, numeric).
- [ ] **Step 6: Run** → PASS.
- [ ] **Step 7: Probes** (throwaway files in `/tmp/bunplan-t1`, not committed). Add one row per probe to the spec's "Verified assumptions" table (command → deciding output):
  1. Packed global install: `npm pack --ignore-scripts` (skips `prepack`, which still runs `next build`), then `npm install -g --prefix /tmp/bunplan-t1/prefix ./kahme247-ompweb-0.6.0.tgz`. `node -e` calling `resolveBunBinary(<prefix>/lib/node_modules/@kahme247/ompweb)` → a path whose `--version` is `1.4.4`. Repeat with `npm install -g --ignore-scripts` → the `@oven/bun-linux-x64` path.
  2. NO_PROXY: one `bun -e` script with a `Bun.serve({ port: 0 })` answering `ok`. `HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1` → fetch to it gives 200 `ok`. Without `NO_PROXY` → `ECONNREFUSED`.
  3. Launcher IPC: a Node script spawns `<resolved bun> child.ts` with `stdio: ["inherit","inherit","inherit","ipc"]`, and messages go both ways (planner pre-check: works).
  4. Store compatibility: under **Node**, create real stores with the current code: `node -e 'const j=require("jiti")(__filename,{alias:{"@/":process.cwd()+"/"}}); …'` with `PI_CODING_AGENT_DIR=/tmp/bunplan-t1/agent`. That runs `getVapidKeys(...)`, `saveDevice(...)` and `recordHistory(...)` from `lib/notification-store.ts`, plus `getUsageDatabase()` from `lib/usage-db.ts`. Then, with `bun -e` and `bun:sqlite`:
     - rows read back;
     - `PRAGMA journal_mode` → `wal`;
     - `stat -c %a notifications.db` → `600`;
     - a second `bun` process doing `BEGIN IMMEDIATE` while the first holds a write transaction waits (`busy_timeout = 5000`), then succeeds after the first commits.
  5. Body cap: a streamed 150 MiB POST to `Bun.serve` → 413 by default, 200 with `maxRequestBodySize: Number.MAX_SAFE_INTEGER` (pre-checked; re-run and record).
  6. Add rows marked "pending: user's Mac (Task 8 packed smoke)" and "pending: Windows CI (Task 8)".
- [ ] **Step 8: Verify** `npm test` (still `node --test`) and `npm run typecheck` → pass.
- [ ] **Step 9: Commit** `build(bun): pin the Bun runtime and add its resolver`.

### Task 2: Tests run under `bun test`

**Files:**
- Modify: `package.json` (`test`), `tests/setup-dom.mjs`, the 121 jiti test files, the 3 strip-types and 3 `syncBuiltinESMExports` files, the 11 `process.execPath` tests as needed, the 29 DOM test files, `bin/omp-web-systemd.js` (`isExecutableFile`), `bin/linux-tray.js` (`isExecutable`)

**Interfaces:**
- Produces: `npm test` = `bun test --parallel --timeout 30000` (no path filter; Bun finds every `*.test.{mjs,ts}` outside `node_modules`). Later tasks add `server/*.test.ts`.

- [ ] **Step 1: Baseline.** Run the current `npm test`. Record pass/fail/skip in the commit body (the spike measured 1958/0/12 at `8e639641`).
- [ ] **Step 2: Switch the script** to `bun test --parallel --timeout 30000`. Run it and save the failure list.
- [ ] **Step 3: jiti codemod** (a one-off script, not committed), then a manual pass:
  - delete `import { createJiti } from "jiti"` and every `const <x> = createJiti(…)`;
  - `await <x>.import("<p>")` → `await import("<p>")`; `<x>("<p>")` → `await import("<p>.ts")` (keep the extension the file has);
  - `alias: { "@/": … }` → nothing (Bun reads the tsconfig paths);
  - the toast alias in `hooks/useAgentSession.rpc.test.mjs` → `mock.module("@/components/ui/toast", () => import("./__fixtures__/toast-stub.mjs"))` from `bun:test`, before the hook's import;
  - `moduleCache: false` re-imports → `await import(\`./rpc-manager.ts?fresh=${n}\`)` with a per-call counter;
  - `{ default: true }` → `.default`.
- [ ] **Step 4: Builtin mocks.** Replace `t.mock.method(fs|childProcess, …)` + `syncBuiltinESMExports()` with `mock.module("node:fs" | "node:child_process", () => ({ ...real, default: { ...real, <name>: fake }, <name>: fake }))` from `bun:test`. Then import the module under test fresh (`?fresh=N`), and restore with `mock.restore()` in `t.after`.
- [ ] **Step 5: DOM tests.**
  - In `tests/setup-dom.mjs`, delete the `after()` teardown (`--parallel` gives every file a fresh global). Add every DOM global a failing test names (expected at least `KeyboardEvent`, `MouseEvent`, `FocusEvent`, `InputEvent`, `HTMLInputElement`, `HTMLTextAreaElement`, `EventTarget`, and a `matchMedia` stub returning `{ matches: false, addEventListener() {}, removeEventListener() {} }`), all from `dom.window` so `instanceof` checks agree.
  - In the 29 files, move the Testing Library imports below the setup import as dynamic imports: `const { render, screen } = await import("@testing-library/react");`. Bun evaluates CommonJS dependencies before an ESM side-effect import.
- [ ] **Step 6: Runtime assumptions in tests.**
  - Tests that run a `bin/*.js` script (production runs them on Node) spawn `"node"`, not `process.execPath`.
  - Tests that run a TS module in a child spawn `process.execPath` (Bun) without `--experimental-strip-types`.
  - Fix the code bug the run exposes: `isExecutableFile` in `bin/omp-web-systemd.js` and `isExecutable` in `bin/linux-tray.js` become `fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile();` inside the existing try/catch, matching `bin/omp-web-launchd.js`.
- [ ] **Step 7: Verify.**
  - `npm test` → 0 fail, pass + skip ≥ baseline pass + skip, and no test file deleted or skipped wholesale.
  - `rg -l "createJiti|from \"jiti\"" --glob '*.test.*'` → no output.
  - `rg -n "experimental-strip-types|syncBuiltinESMExports" lib bin hooks components package.json` → no output.
  - `npm run typecheck && npm run lint` → pass.
- [ ] **Step 8: Commit** `test: run the suite under bun test`.

### Task 3: Route handlers use Web `Request`/`Response`

**Files:**
- Modify: the 60 route files that import `next/server`, `lib/api-utils.ts`, `app/api/manifest/route.ts`, `lib/file-access.test.mjs`, `lib/file-index-route.test.mjs`. Not `proxy.ts` and not `lib/web-auth.test.mjs` (both in Task 5).

**Interfaces:**
- Produces: handlers typed `(request: Request, context: { params: Promise<…> })` that return `Response`; `lib/api-utils.ts` helpers return `Response` (`resolveSessionHostOr404`, `hostOfflineResponse`, `resolveHostOrError`, `opErrorResponse`, `apiErrorResponse`).

- [ ] **Step 1: Codemod** (a one-off script, not committed):
  - delete `import { NextResponse } from "next/server";` and `import { NextRequest, NextResponse } from "next/server";`;
  - `NextResponse.json(` → `Response.json(` (377);
  - `new NextResponse(` → `new Response(` (4);
  - type `NextResponse` → `Response`;
  - `NextRequest` → `Request` (26);
  - `<req>.nextUrl` → `new URL(<req>.url)` (14), hoisting `const url = new URL(request.url)` when a handler reads it more than once.
  - In `app/api/manifest/route.ts`, delete `import type { MetadataRoute } from "next"` and the annotation.
- [ ] **Step 2: Verify the counts.**
  - `rg -n "NextResponse|NextRequest|nextUrl|from \"next" app/api lib --glob '!lib/web-auth.test.mjs'` → no output (`app/layout.tsx`/`app/page.tsx` keep their Next imports until Task 5).
  - `npm run typecheck && npm run lint && npm test` → pass.
  - `npm run build` (still `next build`; Next accepts Web `Response`) → succeeds.
- [ ] **Step 3: Commit** `refactor(api): route handlers use Web Request and Response`.

### Task 4: React SPA entry built by Bun

**Files:**
- Create:
  - entry and shell: `app/index.html`, `app/client.tsx`, `app/boot.ts`, `components/AppErrorBoundary.tsx`;
  - Next replacements: `lib/dynamic.tsx`, `lib/navigation.ts`, `lib/navigation.test.mjs`;
  - build: `server/client-env.ts`, `server/client-env.test.ts`, `scripts/build-client.ts`;
  - fonts: `app/fonts/{geist-latin-wght-normal,jetbrains-mono-latin-wght-normal,noto-sans-mono-latin-wght-normal,noto-sans-mono-cyrillic-wght-normal,source-serif-4-latin-wght-normal}.woff2`, `app/fonts/{Geist,JetBrainsMono,NotoSansMono,SourceSerif4}-OFL.txt`.
- Modify:
  - `app/globals.css`, `app/layout.tsx` (drop `next/font`), `app/error.tsx` (re-export);
  - imports: `components/AppShell.tsx`, `components/CommandPaletteMount.tsx`, `components/SettingsConfig.tsx`;
  - client env: `components/ChatWindow.tsx`, `components/SessionSidebar-chrome.tsx`, `lib/event-stream.ts`, `next.config.ts` (`env` keys renamed, values unchanged);
  - `lib/markdown.ts`, `package.json` (devDependency `bun-plugin-tailwind@0.1.2`).

**Interfaces:**
- Produces:
  ```ts
  // server/client-env.ts — build and dev use the same values
  export function clientEnv(root: string): { OMP_WEB_PUBLIC_APP_VERSION: string; OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION: string };
  // version from package.json; worker = sha256(public/event-stream-worker.js) hex, first 12 chars (moved from next.config.ts)
  // lib/navigation.ts
  export function useSearchParams(): URLSearchParams;
  export function useRouter(): { replace(url: string): void; push(url: string): void; back(): void; refresh(): void };
  // lib/dynamic.tsx — same call shape as next/dynamic
  export default function dynamic<P extends object>(loader: () => Promise<ComponentType<P> | { default: ComponentType<P> }>, options?: { loading?: ComponentType; ssr?: boolean }): ComponentType<P>;
  // components/AppErrorBoundary.tsx
  export function AppCrashScreen(props: { error: Error; reset: () => void }): JSX.Element; // the UI moved from app/error.tsx, unchanged
  export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }>; // renders AppCrashScreen; reset = setState({ error: null })
  ```
- Build output contract (consumed by Task 5): `dist/index.html`, plus every other output under `dist/assets/<name>-<hash>.<ext>`, referenced by absolute `/assets/…` URLs.

- [ ] **Step 1: Failing tests.**
  - `lib/navigation.test.mjs` (with setup-dom): `replace("/?session=b")` updates `useSearchParams().get("session")` and leaves `history.length` unchanged; `push` adds an entry; a `popstate` re-renders with the new search.
  - `server/client-env.test.ts`: the version equals `package.json` `version`, and the worker version equals the first 12 hex chars of the sha256 of `public/event-stream-worker.js`.
- [ ] **Step 2: Run** `bun test lib/navigation.test.mjs server/client-env.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `lib/navigation.ts` and `lib/dynamic.tsx` come from `spike/shims/` (rename the event to `omp:navigate`). Then change the import lines: `next/dynamic` → `@/lib/dynamic` (3 files) and `next/navigation` → `@/lib/navigation` (AppShell).
- [ ] **Step 4: Fonts.**
  - `npm pack @fontsource-variable/{geist,jetbrains-mono,noto-sans-mono,source-serif-4}`. From each tarball, copy the listed `files/*-wght-normal.woff2` and `LICENSE` into `app/fonts/`.
  - In `app/globals.css`, next to the existing `@font-face` blocks, paste the matching blocks from each package's `wght.css` (keep their `font-family` name and `unicode-range`; `url("./fonts/<file>")`; `font-display: swap`). Add `:root { --font-geist: "<Geist family>"; --font-jb-mono: …; --font-noto-mono: …; --font-source-serif: … }`.
  - Remove the four `next/font/google` calls and their class names from `app/layout.tsx`. Next keeps rendering until Task 5, now from these faces.
- [ ] **Step 5: Client env rename.**
  - `process.env.NEXT_PUBLIC_APP_VERSION` and `NEXT_PUBLIC_OMP_WEB_VERSION` → `process.env.OMP_WEB_PUBLIC_APP_VERSION`.
  - `NEXT_PUBLIC_EVENT_STREAM_WORKER_VERSION` → `OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION`.
  - `next.config.ts` `env` renames its three keys to the two new names (same values, its own hash code) until Task 5 deletes it.
- [ ] **Step 6: KaTeX out of the entry chunk.** In `loadMathMarkdownPlugins` (`lib/markdown.ts`), replace `await import("katex/dist/katex.min.css")` with: when `typeof document !== "undefined"` and there is no `link[data-katex]`, append `<link rel="stylesheet" href="/katex/katex.min.css" data-katex>` to `document.head`. Task 5 serves `/katex/`; until then math is unstyled under Next.
- [ ] **Step 7: Shell.**
  - **`app/index.html`:** `<html lang="en" translate="no" class="notranslate">`. The `<head>` holds:
    - `charset` and the viewport `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`;
    - `<title>omp web</title>` and description `Web UI for the oh-my-pi (omp) coding agent`;
    - `mobile-web-app-capable=yes`, `apple-mobile-web-app-title=omp web`, `apple-mobile-web-app-status-bar-style=default` and `format-detection=telephone=no` (cross-check against `git show ae868dc1:app/layout.tsx` `generateMetadata`);
    - `<meta name="google" content="notranslate">` and `<link rel="icon" href="/icon.svg" type="image/svg+xml" sizes="any">`;
    - the five inline scripts copied verbatim from `app/layout.tsx` (theme, lang, font-size, ui-scale, touch-targets);
    - `<link rel="stylesheet" href="./globals.css">`.

    The `<body>` keeps the layout's attributes and style and holds `<div id="root" style="display: contents"></div>` and `<script type="module" src="./client.tsx">`. No manifest link (the bundler would try to resolve it; the server injects it).
  - **`app/boot.ts`:** appends a `<script>` whose `textContent` is `SIDEBAR_HISTORY_BRIDGE_SCRIPT`.
  - **`app/client.tsx`:**
    - imports `./boot` first (ESM evaluates it before AppShell's module);
    - renders `<StrictMode><AppErrorBoundary><IosFocusZoomGuard /><ThemeColor />{location.pathname === "/login" ? <LoginForm /> : <Suspense fallback={<RouteLoadingFallback />}><AppShell appName={document.title} /></Suspense>}</AppErrorBoundary></StrictMode>`;
    - moves `RouteLoadingFallback` from `app/page.tsx`.
  - **`components/AppErrorBoundary.tsx`:** `AppCrashScreen` is the `app/error.tsx` UI moved as is. `app/error.tsx` becomes `"use client"; export { AppCrashScreen as default } from "@/components/AppErrorBoundary";` until Task 5 deletes it.
- [ ] **Step 8: Build script** `scripts/build-client.ts`:
  - `rm -rf dist`;
  - `Bun.build({ entrypoints: ["app/index.html"], outdir: "dist", target: "browser", minify: true, splitting: true, sourcemap: "none", publicPath: "/", naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" }, plugins: [tailwind], define: { "process.env.NODE_ENV": "\"production\"", …clientEnv(root) as "process.env.<KEY>": JSON.stringify(value) }, throw: false })`;
  - print the logs, exit 1 when `!success`, else print the output count.
  - The 6 duplicate-key warnings from `lib/i18n/locales/*.json` already exist; leave them.
- [ ] **Step 9: Verify.**
  - `bun scripts/build-client.ts` exits 0.
  - `test -f dist/index.html`; `grep -o '"/assets/[^"]*' dist/index.html` lists only `/assets/` URLs; `grep -c 'omp-theme' dist/index.html` → `1`.
  - `ls dist/assets/*.woff2 | wc -l` ≥ 7.
  - The entry CSS (the `.css` linked from `dist/index.html`) contains neither `katex` nor `data:font`.
  - `grep -l "$(node -p 'require("./package.json").version')" dist/assets/*.js` finds a file.
  - `npm run typecheck && npm run lint && npm test` → pass.
  - `npm run build` (`next build`) still succeeds.
- [ ] **Step 10: Commit** `feat(client): React SPA entry built by Bun`.

### Task 5: Bun server replaces Next

**Files:**
- Create:
  - server: `server/routes.ts`, `server/http.ts`, `server/app.ts`, `server/main.ts`, `server/dev.ts`;
  - tests: `server/routes.test.ts`, `server/http.test.ts`, `server/app.test.ts`;
  - `bunfig.toml`.
- Modify:
  - gate and routes: `proxy.ts`, `lib/web-auth.test.mjs`, `app/api/web-auth/session/route.ts`, the 38 + 2 route files with `dynamic`/`runtime` exports;
  - launcher: `bin/omp-web.js`, `bin/omp-web-security.test.mjs`;
  - config: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`;
  - the 5 `@next/next/no-img-element` comment sites; comments in `lib/directory-browser.ts:62` and `lib/rpc-manager.test.mjs:1524`.
- Delete: `next.config.ts`, `instrumentation.ts`, `postcss.config.mjs`, `app/layout.tsx`, `app/page.tsx`, `app/login/page.tsx`, `app/error.tsx`, `app/global-error.tsx`, `lib/security-headers.test.mjs`. Move: `app/icon.svg` → `public/icon.svg`.

**Interfaces:**
- Consumes: `resolveBunBinary` (Task 1), `dist/` layout and `clientEnv` (Task 4).
- Produces:
  ```ts
  // proxy.ts — null means "continue"
  export const UNGATED: RegExp; // /^\/(?:assets\/|_bun\/|favicon\.ico|icon\.svg|icon\.png|icon-192\.png|badge-96\.png|sw\.js|api\/hosts\/link(?:\/|$))/ (prefix match, as Next's matcher)
  export function proxy(request: Request): Response | null;
  // server/routes.ts
  type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // never: each handler narrows its own params; the router passes Record<string, string | string[]>.
  export type RouteHandler = (request: Request, context: { params: Promise<never> }) => Response | Promise<Response>;
  export type RouteModule = Partial<Record<Method, RouteHandler>>;
  export const ROUTE_MODULES: Record<string, RouteModule>; // key = directory under app/api, e.g. "sessions/[id]/state"; one `import * as` per file via "@/app/api/…/route"
  export function routePattern(key: string): { pattern: string; rest: { name: string; index: number } | null };
  export function dispatch(mod: RouteModule, request: Request, params: Record<string, string | string[]>): Promise<Response>;
  // server/http.ts
  export function finalizeResponse(request: Request, response: Response): Response; // security headers (overwrite), cache-control for "/" and "/login", gzip
  export function serveFile(request: Request, root: string, dev: boolean): Promise<Response | null>; // dist (prod), public, /katex/; null = no file
  export function renderIndex(html: string, request: Request): string; // install name + manifest link
  // server/app.ts
  export function parseListenArgs(argv: string[], defaultPort: number): { port: number; hostname: string }; // -p/--port, -H/--hostname (node:util parseArgs), default host 127.0.0.1
  export function startServer(options: { port: number; hostname: string; dev: boolean; root: string; html?: Bun.HTMLBundle }): Bun.Server;
  ```
- Behavior that `routePattern`/`dispatch`/`startServer` must have:
  - `[x]` → `:x`; `[...x]` → `*` with `params.x` = the path segments from `rest.index` on, empty ones dropped, each passed through `decodeURIComponent`.
  - A request whose pathname fails `decodeURIComponent` → 400.
  - A missing method → 405 with `Allow`; OPTIONS → 204 with `Allow`; HEAD without a handler → GET (Next did both).
  - A handler throw → `console.error` + 500 `{ error: "Internal Server Error" }`.
  - `startServer` keeps Bun's default `idleTimeout` (10 s) and passes `development: dev ? { hmr: true, console: true } : false`; `handle` calls `server.timeout(request, 0)` for an `/api/` request past the gate (not `UNGATED`, not `/api/web-auth/session`), and the host link through `disableIdleTimeout` after its bearer check (final review I1: a global `idleTimeout: 0` let unauthenticated stalled requests hold sockets). It keeps Bun's default `maxRequestBodySize` (128 MiB), which is above every handler's own limit (101 MB uploads, 64 MB link blobs); `Number.MAX_SAFE_INTEGER` would leave the bare `req.json()` handlers unbounded (Task 5 review).
  - Every route and the `fetch` fallback run `proxy()` first; every response goes through `finalizeResponse`.
  - `fetch` serves `serveFile`, then `/` and `/login` (prod: `renderIndex(dist/index.html)`), then the SPA fallback (GET/HEAD, not `/api/`, last segment without a `.`). Anything else → 404 text.
  - `startServer` does **not** call `register()`; the entries do.
- `finalizeResponse` rules:
  - Always build a new `Response(body, { status, statusText, headers })`, because `Response.redirect()` headers are immutable.
  - Headers: `SECURITY_HEADERS` (copy the values from `next.config.ts`) for every path except `/api/files/*`, which gets `FILE_RESPONSE_HEADERS`.
  - Cache: `/` and `/login` → `private, no-cache, max-age=0, must-revalidate`.
  - gzip when all of these hold: `accept-encoding` includes `gzip`; status 200; no `content-encoding` or `content-range`; content-type matches `^(text/(?!event-stream)|application/(json|javascript|manifest\+json|xml)|image/svg\+xml)`. Then: body through `CompressionStream("gzip")`, delete `content-length`, set `content-encoding: gzip` and `vary: accept-encoding`. (No size floor: `Response.json` and `Bun.file` responses carry no `content-length` here, so a `≥ 1024` rule never applied; final review.)
- `serveFile` rules:
  - Decode the pathname; reject a NUL byte, `\`, or any `..` segment. The resolved path must start with its base dir plus the separator, and the target must be a regular file (`statSync().isFile()`).
  - Cache-control: `/assets/*` → `public, max-age=31536000, immutable`; `/sw.js` and `/event-stream-worker.js` → `no-cache`; other public and KaTeX files → `public, max-age=0`. Every file carries `Last-Modified` (its mtime), and a GET/HEAD whose `If-Modified-Since` is not older answers 304 (final review: without validators every revalidation re-downloaded the file).
  - The KaTeX dir is `path.join(path.dirname(Bun.resolveSync("katex/package.json", root)), "dist")`, mounted at `/katex/`.
- `renderIndex`: replace `<title>omp web</title>` and the `apple-mobile-web-app-title` content with the HTML-escaped (`& < > " '`) `getInstallName(request.headers)`. Insert `<link rel="manifest" href="/api/manifest" crossorigin="use-credentials">` before `</head>`. Read `dist/index.html` once at startup.

- [ ] **Step 1: Failing tests.**
  - `server/routes.test.ts`:
    - the keys of `ROUTE_MODULES` equal the directories of `new Bun.Glob("app/api/**/route.ts")` (70);
    - every module exports only `GET|POST|PUT|PATCH|DELETE`;
    - `routePattern("files/[...path]")` → `{ pattern: "/api/files/*", rest: { name: "path", index: 3 } }`;
    - `routePattern("sessions/[id]/entries/[entryId]/thinking")` → `/api/sessions/:id/entries/:entryId/thinking`;
    - `dispatch` with a `{ GET }` module: POST → 405 with `allow: GET`, OPTIONS → 204, HEAD → the GET status, and `await context.params` equals the params passed in.
  - `server/http.test.ts` (port of `lib/security-headers.test.mjs`, which is deleted):
    - `/`, `/api/file-index` and `/assets/x.js` carry the exact CSP, `DENY`, `nosniff`, `no-referrer` and `microphone=(self)`;
    - `/api/files/home/user/project/logo.svg`, `…/report.docx` and `/api/files/C%3A/Users/me/project/logo.svg` carry no config CSP (a handler CSP `sandbox` survives) and get `SAMEORIGIN` and `microphone=()`;
    - a handler `X-Frame-Options: SAMEORIGIN` on `/api/hosts` becomes `DENY`;
    - a redirect response passes without throwing;
    - gzip happens for a 2 KB JSON body and is skipped for `text/event-stream`, status 206, a 500-byte body, and requests without `accept-encoding`;
    - `serveFile` returns 404/null for the four traversal inputs in Review Focus 3, `immutable` for `/assets/*` and `no-cache` for `/sw.js`;
    - with `OMP_WEB_NAME=<script>`, `renderIndex` puts `&lt;script&gt;` in `<title>`, and the manifest link sits before `</head>`.
  - `server/app.test.ts`: `startServer({ port: 0, dev: false, root })` where `root` is a temp dir holding a fixture `dist/index.html` plus `public` and `node_modules` linked to the repo's (`fs.symlinkSync(target, link, "junction")`, which needs no admin on Windows). Env: `PI_CODING_AGENT_DIR`/`HOME` temp and `OMP_WEB_OMP_BIN=/nonexistent/omp`:
    - `GET /api/hosts` → 200 JSON;
    - `POST /api/hosts` with `Origin: https://evil.example` → 403;
    - `GET /api/nope` → 404; `GET /api/sessions/%E0%A4%A/state` → 400;
    - `GET /` → 200 HTML with `no-cache`; `GET /some/page` → index; `GET /missing.js` → 404;
    - `GET /api/events` delivers its first event and is still open after 12 s with no traffic.
  - `lib/web-auth.test.mjs`: replace `NextRequest` with `Request` and `unstable_doesMiddlewareMatch` with `proxy()`. With a hash and no cookie:
    - `/sw.js`, `/assets/a.js`, `/api/hosts/link` and `/api/hosts/link/blob/x` → `null`;
    - `/api/hosts/linkx` → 401;
    - `/?session=x` → 307 `location: /login?next=%2F%3Fsession%3Dx`.

    Plus the existing proxy cases (503 on a bad hash, `/login` → `/` without a password, cookie and trusted header accepted). No response carries a header starting with `x-middleware-`.
- [ ] **Step 2: Run** `bun test server lib/web-auth.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `server/routes.ts` (write the table once from `bun spike/gen-routes.ts` output, then keep it by hand), `server/http.ts` and `server/app.ts`. Then:
  - `proxy.ts`: `Response.json` / `new Response`; `NextResponse.redirect(u)` → a 307 with a relative `Location` (`/login?next=…`, `/`), because Bun's `request.url` is always `http://` and an absolute one would leave https behind a TLS proxy; `NextResponse.next()` → `null`; `request.cookies.get(n)?.value` → `new Bun.CookieMap(request.headers.get("cookie") ?? "").get(n)`; `request.nextUrl` → `new URL(request.url)`; `UNGATED` check first; delete `export const config`. Rewrite its comment: the link exclusion stays for bearer auth, and the 10 MB note goes.
  - `app/api/web-auth/session/route.ts`: `Response.json({ ok: true }, { headers: { "set-cookie": new Bun.Cookie(OMP_WEB_SESSION_COOKIE, createWebSession(), { httpOnly: true, secure, sameSite: "lax", maxAge: OMP_WEB_SESSION_MAX_AGE_SECONDS, path: "/" }).serialize() } })`.
  - Delete `export const dynamic …` (38) and `export const runtime …` (2).
  - `instrumentation.node.ts`: keep the `aborted`/`ECONNRESET` journaling branch (its test stays) but reword its comment, which blames Next's `proxy.ts` body cloning. Remove "Next" from the other comments there.
- [ ] **Step 4: Entries.**
  - **`server/main.ts`:** `process.env.NODE_ENV = "production"` (as `next start` forced it). Then `await import("./app")`, `startServer({ ...parseListenArgs(Bun.argv.slice(2), 30177), dev: false, root })`, `await register()` (dynamic import of `../instrumentation.node`), and print `[omp-web] Ready on http://<host>:<port>`. The launcher waits for `Ready`.
  - **`server/dev.ts`:** a static `import html from "../app/index.html"`. When an `OMP_WEB_PUBLIC_*` value from `clientEnv(root)` is missing from its environment, it re-runs itself once with them set (`[serve.static] env` reads only the startup environment). Then `process.env.NODE_ENV = "development"`, dynamic import of `./app`, and `startServer({ …parseListenArgs(argv, 30178), dev: true, root, html })`, which mounts `html` at `/__omp_dev_index`; `/`, `/login` and the SPA fallback fetch it from there, so dev pages pass the gate and `renderIndex` as in prod. Their CSP adds `blob:` to `script-src` (Bun's HMR updates are blob: scripts; without it every edit is a full reload). Guard `globalThis.__ompWebRegistered ??= register()` so `bun --hot` re-evaluation registers once, then print the Ready line.
  - **`bunfig.toml`:** `[serve.static]` with `plugins = ["bun-plugin-tailwind"]` and `env = "OMP_WEB_PUBLIC_*"`.
- [ ] **Step 5: Launcher** (`bin/omp-web.js`).
  - Delete `nextDir`, `resolveNextBin`, `nextBin` and `nextArgs`. Add `serverCommand()` → `[resolveBunBinary(pkgDir), path.join(pkgDir, "server", "main.ts"), "-p", String(port), "-H", String(hostname)]`, called at each spawn so a restart after an update resolves again.
  - `spawnServer` runs `spawn(cmd[0], cmd.slice(1), …)`. `waitForRestartRequest` passes `serverCommand()` to `acknowledgeAndStartRestart`.
  - In `runRestartGate`, `spawnChild(message.args[0], message.args.slice(1), …)`, and validation requires a non-empty `message.args`.
  - `main()` checks `dist/index.html` and `server/main.ts`, keeping the "Build artifacts not found" message. A resolver error prints its message and exits 1.
  - Update `module.exports` (drop `resolveNextBin`).
  - `bin/omp-web-security.test.mjs`: the fake package gets `dist/index.html` and a `server/main.ts` stub that writes `process.env` to the dump file. Spawn `"node"`; the resolver finds Bun on the test's PATH.
- [ ] **Step 6: Package and config.**
  - scripts:
    - `dev`: `bun --hot server/dev.ts -H 127.0.0.1 -p 30178`; `dev:lan`: the same with `-H 0.0.0.0`;
    - `build`: `bun scripts/build-client.ts`;
    - `start`: `bun server/main.ts -H 127.0.0.1 -p 30177`; `start:lan`: the same with `-H 0.0.0.0`.
  - `npm uninstall next eslint-config-next @tailwindcss/postcss postcss`, then `npm install --save-dev typescript-eslint@^8.57.1 eslint-plugin-react-hooks@^7.0.1`.
  - `eslint.config.mjs`: `tseslint.config({ ignores: ["dist/**", "spike/**"] }, ...tseslint.configs.recommended, reactHooks.configs.flat.recommended, { rules: { the three current "off" rules } })`. Delete the 5 `@next/next/no-img-element` disable comments.
  - `tsconfig.json`: drop the `next` plugin, the `.next/**` includes and `next-env.d.ts`; add `"exclude": ["node_modules", "dist", "spike"]`.
  - `.gitignore`: drop the Next block lines (`/.next/`, `/out/`, `/.next-dev*.log`, `next-env.d.ts`); keep `/dist`.
  - Delete the files listed above; `git mv app/icon.svg public/icon.svg`.
- [ ] **Step 7: Run** `bun test server lib/web-auth.test.mjs` → PASS, then `npm run typecheck && npm run lint && npm test` → pass.
- [ ] **Step 8: Live check** (isolated env, port 30311). Run `npm run build && bun server/main.ts -p 30311`, then curl:
  - `/` → 200 HTML with `<title>omp web</title>` and the manifest link;
  - `/assets/<entry>.js` → `immutable` and `content-encoding: gzip`;
  - `/api/hosts` → 200; `/api/files/etc` → 403 `access_denied` (Linux);
  - a cross-origin POST → 403;
  - `/katex/katex.min.css` → 200;
  - no `x-middleware-*` or `x-powered-by`.

  With `OMP_WEB_PASSWORD_HASH` from `printf 'pw\n' | node bin/omp-web.js hash-password`, check:
  - `/?session=x` → 307 `/login?next=%2F%3Fsession%3Dx`;
  - the right password → `set-cookie: omp_web_session=…; HttpOnly; SameSite=Lax`.

  In a headless browser (the harness `browser` tool): the sidebar renders, a fixture session opens via `?session=`, fonts load from `/assets/*.woff2`, a math reply renders styled, and the Settings tabs load.
- [ ] **Step 9: Dev and launcher check.**
  - `bun --hot server/dev.ts -p 30312`: the page renders. A route file edit changes its response without a restart, and the `[omp-web] starting` line prints once. A component edit hot-swaps it.
  - `node bin/omp-web.js -p 30313 --no-open`: the banner prints and `/api/hosts` → 200. Ctrl-C leaves no `server/main.ts` process (`pgrep -f server/main.ts` empty).
- [ ] **Step 10: Commit** `feat(server): serve omp-web from Bun instead of Next`.

### Task 6: Bun built-ins replace node:sqlite, sharp and undici

**Files:**
- Modify:
  - SQLite: `lib/notification-store.ts`, `lib/usage-db.ts`, `lib/notification-store.test.mjs`, `lib/notification-hub.test.mjs`, `lib/usage-db.test.mjs`;
  - thumbnails: `lib/media-cache.ts`, `lib/media-route.test.mjs`, `app/api/media/[hash]/route.ts` (comment);
  - proxy dispatcher: `instrumentation.node.ts`, `lib/stt-jobs.ts` (comment);
  - `package.json`, `package-lock.json`.
- Delete: `lib/http-dispatcher.ts`

**Interfaces:**
- Produces: the store and usage-db exports keep their signatures, except that the `DatabaseSync` types become `Database` from `bun:sqlite` (`getUsageDatabase(customPath?): Database`, `syncUsage(…, customDb?: Database)`). `createThumbnail(hash, image): Promise<Buffer | null>` is unchanged.

- [ ] **Step 1: Failing tests.**
  - `lib/notification-store.test.mjs`:
    - a store file created with `node:sqlite` `DatabaseSync` (available under Bun) using the current schema plus a VAPID row and a device opens through the store with the same keys and device;
    - after a write, `notifications.db` and `notifications.db-wal` have mode `0o600` (skip on win32).
  - `lib/usage-db.test.mjs`: the failed-migration test still rolls back (`inTransaction`).
  - `lib/media-route.test.mjs` (no sharp; images from `new Bun.Image(await Bun.file("public/icon-192.png").bytes()).resize(w, h, { fit: "fill" }).png().bytes()`):
    - 1600×1000 → thumbnail 480×300 WebP (`RIFF`);
    - 800×400 → 480×240;
    - a JPEG with an injected EXIF APP1 orientation 6 at 40×20 → 20×40;
    - non-image bytes → `null`.
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement.**
  - **SQLite:**
    - `import { Database } from "bun:sqlite"`; `new DatabaseSync(p)` → `new Database(p)`; `db.isTransaction` → `db.inTransaction`;
    - every `.get()` result: `null` replaces `undefined`, so map it to `undefined` where a signature promises `| undefined` (`getDevice`);
    - the pragmas and the 0600 pre-create stay as they are; the test files switch to `bun:sqlite`.
  - **Thumbnails:** `thumb = Buffer.from(await new Bun.Image(image).resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).bytes())`. Drop `.rotate()` (Bun.Image applies EXIF orientation) and the dynamic-import comment, and update the comments that mention sharp.
  - **Proxy dispatcher:** delete the `configureHttpDispatcher` block in `register()`. `npm uninstall sharp undici`.
- [ ] **Step 4: Verify.**
  - `rg -n "node:sqlite|DatabaseSync|sharp|undici|http-dispatcher" lib app server bin instrumentation.node.ts package.json` → no output.
  - `npm run typecheck && npm run lint && npm test` → pass.
  - Live: a server on 30311 shows `?thumb=1` for a fixture image tool result (or curl `/api/media/<hash>?thumb=1` → `image/webp`).
- [ ] **Step 5: Commit** `refactor(runtime): use bun:sqlite, Bun.Image and Bun's fetch proxy support`.

### Task 7: Update worker on Node, Windows scripts and services

**Files:**
- Modify: `bin/omp-web.js` (`serverEnvironment`), `lib/self-update.ts`, `lib/self-update.test.mjs`, `scripts/windows/omp-web-service.ps1`, `scripts/windows/omp-web-tray.ps1`, `lib/windows-service.ts`, `lib/windows-service.test.mjs`

**Interfaces:**
- Consumes: the `bin/bun-runtime.js` CLI (Task 1).
- Produces: env `OMP_WEB_NODE_BIN` (set by the launcher to `process.execPath`). It is internal like `OMP_WEB_LAUNCHER_PID`.

- [ ] **Step 1: Failing tests.**
  - `lib/self-update.test.mjs`: with `OMP_WEB_NODE_BIN=/opt/node/bin/node`, the spawned worker command (direct, or after `systemd-run … --scope …`) is `/opt/node/bin/node` and not `process.execPath`. Without it, the command falls back to `process.execPath`.
  - `lib/windows-service.test.mjs`: the generated orphan-kill script matches `-like "node*"` and `-like "bun*"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - `serverEnvironment()` adds `OMP_WEB_NODE_BIN: process.execPath`.
  - `lib/self-update.ts` uses `const runtime = process.env.OMP_WEB_NODE_BIN || process.execPath` for `command` and inside `commandArgs`. Add a one-line comment: Windows locks a running `bun.exe`, and npm replaces the package's.
  - `lib/windows-service.ts`: `if ($owner -and ($owner.Name -like "node*" -or $owner.Name -like "bun*"))`.
  - Both `.ps1` scripts:
    - `$NextDir = …".next"` → `$BuildIndex = Join-Path $RepoRoot "dist\index.html"` in the start→dev fallback (comment updated);
    - the dev branch becomes `$inner = "`"$NodeExe`" `"$(Join-Path $RepoRoot 'bin\bun-runtime.js')`" --hot server\dev.ts -H $EffectiveHostname -p $EffectivePort"`;
    - `omp-web-host.ps1` is unchanged (Node launcher).
  - `bin/omp-web-update-worker.js` needs no change: it now runs on Node, and its `process.execPath` tray call stays valid.
- [ ] **Step 4: Verify.**
  - `npm test` → pass.
  - `rg -n '\.next[/"]|next\\dist|next dev' scripts lib bin` → only `lib/worktree.ts` and `lib/worktree.test.mjs` (comments about user projects).
  - Windows parsing is checked in CI (Task 8).
- [ ] **Step 5: Commit** `fix(update): run the update worker on Node; Windows scripts start Bun`.

### Task 8: Packaging, CI and the smoke test

**Files:**
- Create: `scripts/smoke.ts`
- Modify: `package.json` (`files`, `smoke`, `release:check`), `.github/workflows/verify-pr.yml`, `.github/workflows/publish.yml`, `nix/package.nix`, `flake.nix`

**Interfaces:**
- Produces: `npm run smoke [-- --package <dir>]`. The default `<dir>` is the repo root. It exits 0 when every step passes and prints one `ok <step>` / `FAIL <step>: <detail>` line per step.

- [ ] **Step 1: `package.json`.**
  - `files`: `["bin", "lib", "app/api", "server", "dist", "public", "scripts", "proxy.ts", "instrumentation.node.ts", "tsconfig.json", "package.json"]` (tsconfig carries the `@/` paths the server resolves at runtime).
  - `"smoke": "bun scripts/smoke.ts"`.
  - `"release:check": "npm run typecheck && npm run lint && npm test && npm run build && npm run smoke"`.
  - `prepack` stays `npm run build`.
- [ ] **Step 2: `scripts/smoke.ts`.**
  1. Take a free port (listen on 0, read it, close).
  2. Create temp `HOME`/`PI_CODING_AGENT_DIR` and set `OMP_WEB_OMP_BIN=<temp>/missing-omp`.
  3. Spawn `node <dir>/bin/omp-web.js -p <port> -H 127.0.0.1 --no-open` and wait ≤ 60 s for `Ready` on stdout.
  4. `GET /` → 200 `text/html` containing `id="root"` and `no-cache`.
  5. The first `/assets/*.js` named in it → 200 with `immutable`, plus `content-encoding: gzip` when requested with `accept-encoding: gzip`.
  6. `GET /api/hosts` → 200 JSON.
  7. `GET /api/events` → first event received, and the stream is still open after 12 s.
  8. Stop the launcher (`SIGTERM`; on win32 `taskkill /pid <pid> /t /f`), then wait until a TCP connect to the port fails (≤ 15 s).
  9. Remove the temp dirs.
- [ ] **Step 3: Run** `npm run build && npm run smoke` → all `ok`. Then the packed install:
  - `npm pack --ignore-scripts && npm install -g --prefix /tmp/bunplan-t8 ./kahme247-ompweb-*.tgz`;
  - `npm run smoke -- --package "$(npm root -g --prefix /tmp/bunplan-t8)/@kahme247/ompweb"` → all `ok`.
- [ ] **Step 4: CI.**
  - `verify-pr.yml` steps: after "Verify production build", add "Smoke test" (`npm run smoke`) and "Packed install smoke test" with `shell: bash` (the Step 3 commands with `$RUNNER_TEMP/ompweb-prefix`), both on ubuntu and windows.
  - Windows only: parse both `.ps1` scripts (`pwsh -NoProfile -Command "foreach ($f in 'scripts/windows/omp-web-service.ps1','scripts/windows/omp-web-tray.ps1') { $e=$null; [System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$e) | Out-Null; if ($e) { $e; exit 1 } }"`).
  - `publish.yml`: add `npm run smoke` after `npm run build`.
- [ ] **Step 5: Nix.** (As built: nixpkgs' `bun` is 1.4.2, below the pinned 1.4.4, so Nix keeps the npm `@oven/bun-<os>-<arch>` binary that every install uses.)
  - `nix/package.nix`: delete the four `fetchurl` fonts, `localFontsPatch`, `patches` and `postPatch`. In the fileset, drop `instrumentation.ts`, `next.config.ts`, `next-env.d.ts` and `postcss.config.mjs`, and add `../server` and `../bunfig.toml`.
  - `npmRebuildFlags = [ "--ignore-scripts" ]`: bun's postinstall execs the unpatched binary, so `bin/bun-runtime.js` resolves the `@oven` binary itself.
  - Linux only: `autoPatchelfHook` with `dontAutoPatchelf = true`; `preBuild` runs `autoPatchelf -- node_modules/@oven`, removes `node_modules/.bin/bun{,x}` and puts the resolved binary's directory on `PATH` for the build. The shipped `@oven` binary stays in `node_modules` for the launcher.
  - `flake.nix` devShell: add `bun`.
  - Unverified: written without nix. `npmDepsHash` changes with the lockfile and needs `nix build .#default` to report the new hash; the controller refreshes it on a machine with nix.
- [ ] **Step 6: Verify** `npm run typecheck && npm run lint && npm test && npm run build && npm run smoke` → pass.
- [ ] **Step 7: Commit** `ci: smoke-test the Bun server and the packed install`.

### Task 9: Documentation

**Files:**
- Modify: `AGENTS.md`, `README.md`, `README.ja.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `DESIGN.md`, `CHANGELOG.md`

- [ ] **Step 1: `AGENTS.md`.**
  - **Quick Start:** `npm run dev` (Bun hot reload, 30178), `npm run build` / `npm start` (30177), `npm test` (`bun test --parallel`), `npm run smoke`. Delete line 11 ("Never run `next build` during dev").
  - **Architecture diagram:** Browser → Bun server (`server/app.ts`) → omp; launcher on Node; daemon and tray on Node.
  - **File Map:** `server/*`, `app/index.html`, `app/client.tsx`, `app/boot.ts`, `scripts/build-client.ts`, `scripts/smoke.ts`, `bin/bun-runtime.js`, `dist/`, `bunfig.toml`.
  - **New section "Adding an API route":** create `app/api/<path>/route.ts`, add one import and one entry to `server/routes.ts` (key = directory under `app/api`), and let `server/routes.test.ts` enforce it.
  - **Traps:** the per-request `server.timeout(request, 0)` after the gate (never for public paths) and Bun's 128 MiB default `maxRequestBodySize`; Bun's router matches the raw path while `request.url` is normalized (each route re-matches the normalized path); redirects carry a relative `Location`; `Response.redirect()` headers are immutable (`finalizeResponse` copies); `globalThis` state survives `bun --hot` (formerly "Next hot-reload") and the `register()` guard; daemon/tray modules use no Bun APIs; `bun:sqlite` `.get()` returns `null`; `Bun.Image` applies EXIF orientation; DOM tests import Testing Library dynamically after `tests/setup-dom.mjs`; fresh imports use `?fresh=N` and builtin mocks use `mock.module`; the update worker runs on Node (`OMP_WEB_NODE_BIN`); static roots come from `OMP_WEB_PACKAGE_DIR`.
  - **Update the Next mentions:**
    - "Proxy exclusion" keeps the bearer reason and drops the 10 MB buffering;
    - Remote hosts says "No WebSocket yet" without `next start`;
    - the jiti daemon note says "Node runtime";
    - Tool-result images says `Bun.Image`.
  - **Delete** the `# This is NOT the Next.js you know` block (end of file).
- [ ] **Step 2: READMEs** (en/ja/zh-CN): requirements are Node ≥ 24, and Bun is installed automatically as a dependency (or used from PATH). Remove the `.next` dev warning and update the dev/build/start commands. **CONTRIBUTING:** the same commands, the removed `.next` paragraph, and `bun test` notes. **DESIGN.md:** replace the 2 Next references.
- [ ] **Step 3: `CHANGELOG.md` `[Unreleased]` → "Fixes & Improvements":** "**ompweb now runs on Bun instead of Next.js.** The npm package brings its own Bun, so installs and updates work as before, with no change to URLs, ports, settings or the password gate. Host link uploads are no longer cut at 10 MB." Name `OMP_WEB_DEV_ORIGIN` as removed (dev-only).
- [ ] **Step 4: Verify** `rg -n "next build|next dev|next start|\.next/|Next\.js" AGENTS.md README*.md CONTRIBUTING.md DESIGN.md` → only the CHANGELOG-style "instead of Next.js" history lines, if any.
- [ ] **Step 5: Commit** `docs: document the Bun runtime`.

### Task 10: Remove the spike and run the final audit

**Files:**
- Delete: `spike/`
- Modify: `eslint.config.mjs`, `tsconfig.json` (drop the `spike` ignores and excludes)

- [ ] **Step 1:** `git rm -r spike` and drop its ignore/exclude entries.
- [ ] **Step 2: Clean rebuild.** `rm -rf node_modules dist && npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm run smoke` → all pass. Then the packed-install smoke from Task 8 Step 3 → all `ok`.
- [ ] **Step 3: Completeness greps** (each → no output):
  - `rg -n --glob '!docs/**' --glob '!CHANGELOG.md' "from ['\"]next|NextResponse|NextRequest|nextUrl|next/font|next/dynamic|next/navigation|next/headers|next/script|eslint-config-next|http-dispatcher|DatabaseSync|node:sqlite"`;
  - `node -e 'const p=require("./package.json");const d={...p.dependencies,...p.devDependencies};for(const n of ["next","sharp","undici","eslint-config-next","@tailwindcss/postcss","postcss"])if(d[n])console.log(n)'`;
  - `rg -l "createJiti" --glob '*.test.*'`.
- [ ] **Step 4: Spec check.** Go through the spec's acceptance criteria 1–5 and mark each with the command that proved it, in the PR description draft (not committed). Hand-off items for the controller: run the packed smoke on the user's Mac and refresh `npmDepsHash` with nix if Task 8 could not.
- [ ] **Step 5: Commit** `chore: remove the Bun spike`.
