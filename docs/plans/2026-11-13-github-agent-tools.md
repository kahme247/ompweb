# GitHub Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five server-side agent tools (`watch_github`, `unwatch_github`, `github_read`, `github_comment`, `github_resolve_thread`) answered by the web server through its own `gh` login, with watch updates delivered through the message outbox as links plus metadata.

**Architecture:** A `gh` runner and a GitHub data layer in `lib/github/`, a pure event differ/formatter, a SQLite watch store, and a poller that turns new events into outbox entries. The tools are wired into the existing agent-tool path (`lib/agent-tools.ts` → `executeAgentTool`, answered in `lib/rpc-manager.ts` `answerServerAgentTool`), with the confirmation rules of `new_session`.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, `child_process.execFile` for `gh`, `node:test` run by `bun test --parallel`.

**Spec:** `docs/specs/2026-11-13-github-watch-tool-design.md`

## Global Constraints

- Every tool description begins: "Requires the GitHub CLI (`gh`) on the PATH of the omp-web server machine, logged in (`gh auth login`); acts as that account."
- `gh` missing: "`gh` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run `gh auth login` there."
- `gh` logged out: "`gh` is not logged in on the omp-web server machine. Ask the user to run `gh auth login` there."
- `gh` runs with `createChildProcessEnvironment` (`lib/project-command-env.ts`): never omp-web's secrets. Never read or store a GitHub token.
- Update messages start `GitHub update (omp-web): OWNER/REPO#N <URL>` and never contain text written on GitHub (no bodies, titles, branch names). No check names or thread file paths (a fork controls its workflow files and its branch).
- At most 20 watches per session. Poll interval 60 s. `gh auth status` result cached 60 s. `github_read` diff capped at 1 MiB with a truncation marker. `github_comment` body capped at 65 536 characters.
- Store: `<agent dir>/omp-web/github-watches.sqlite`, WAL, busy timeout, closed with `close(true)`.
- New setting `githubWritesUnasked` (default `false`), label **Allow agent GitHub writes without asking**, Settings → System beside **Agent tools**.
- Browser code rules of `AGENTS.md` apply to the Settings change; every new server singleton uses the `globalThis` registry pattern.
- Tests: `bun test --parallel <files>`; typecheck `npm run typecheck`; lint `npm run lint`.

## Review Focus

- An item with more comments, reviews or thread comments than one GraphQL page: the poller must page or use newest-first windows so nothing is missed and nothing is redelivered.
- Comments edited or deleted after the baseline: an edit is not a new event, and a deleted id must not cause redelivery of others.
- A force-push while CI runs: only the current head's result is reported, a head already reported is never reported again, and a head that disappeared silently is dropped.
- Two sessions watching the same item: each gets its own entry; one session's deletion ends only its own watch.
- `gh` hanging (network): every `gh` call has a 30 s timeout so one item cannot stall the poller.

---

### Task 1: `gh` runner and target parsing

**Files:**
- Create: `lib/github/gh.ts`
- Test: `lib/github/gh.test.mjs`

**Interfaces:**
- Produces:
  - `type GhRunner = (args: string[], input?: string) => Promise<string>` (stdout; rejects with `GhError { message, stderr, code }`).
  - `defaultGhRunner: GhRunner` (`execFile("gh", args, { env: createChildProcessEnvironment(...), timeout: 30_000, maxBuffer: 16 MiB })`, stdin from `input`).
  - `checkGh(run?: GhRunner, now?: () => number): Promise<{ login: string }>`: runs `gh api user --jq .login` (covers installed + logged in), caches success 60 s (`globalThis`); throws `GhUnavailableError` with exactly the Global Constraints texts (ENOENT → not installed; exit with "auth"/"login"/HTTP 401 in stderr → not logged in).
  - `parseGithubTarget(value: string): { owner: string; repo: string; number: number }` accepting `OWNER/REPO#N` and `https://github.com/OWNER/REPO/(pull|issues)/N` (trailing path/query/fragment ignored); throws `Error("Agent tool argument \"target\" must be OWNER/REPO#N or a GitHub pull request or issue URL.")`.
  - `formatTarget(t): string` → `OWNER/REPO#N`.

- [ ] **Step 1: Write failing tests** `checkGh maps a missing binary and a logged-out gh to the spec's messages`, `checkGh caches a success for 60 s`, `parseGithubTarget accepts both forms and refuses others` (refuses `owner/repo`, `owner/repo#0`, `https://gitlab.com/...`, `owner/repo#12abc`).
- [ ] **Step 2: Run** `bun test --parallel lib/github/gh.test.mjs` — FAIL (module missing).
- [ ] **Step 3: Implement** as above. Runner faked in tests by passing `run`.
- [ ] **Step 4: Run** the test — PASS.
- [ ] **Step 5: Commit** `feat(github): gh runner and target parsing`.

### Task 2: GitHub data layer

**Files:**
- Create: `lib/github/api.ts`
- Test: `lib/github/api.test.mjs` (fixtures inline as fake `GhRunner` answers)

**Interfaces:**
- Consumes: `GhRunner`, target type from Task 1.
- Produces:
  - `type ItemKind = "pull_request" | "issue"`.
  - `interface GithubActor { login: string; bot: boolean; association: string }`.
  - `interface ItemSnapshot { kind; url; state: "open" | "closed" | "merged"; closedReason?: "completed" | "not_planned"; comments: { id: string; url: string; author: GithubActor }[]; reviews: { id; url; author; state: string; commentCount: number }[]; threadComments: { id; url; author; threadId: string; path: string; line: number | null }[]; head?: { sha: string; checks: { name: string; conclusion: string | null; status: string }[] } }` — metadata only; no bodies.
  - `fetchSnapshot(run, target): Promise<ItemSnapshot>`: one `gh api graphql` request using `repository.issueOrPullRequest(number:)`; pages comments/reviews/thread comments (`last: 100` windows, then `before:` cursors until an id older than the stored cursor appears, or all pages on baseline). Builder chooses the query text.
  - `readItem(run, target, include: ReadPart[], ids?: string[]): Promise<unknown>` with `ReadPart = "summary" | "comments" | "reviews" | "threads" | "checks" | "files" | "diff"`; every user-authored field carries `author` + `association`; `diff` via `gh api -H "Accept: application/vnd.github.diff" repos/O/R/pulls/N`, truncated at 1 MiB with `"…[diff truncated at 1 MiB]"`.
  - `postComment(run, target, body, replyTo?): Promise<{ id: string; url: string }>`: REST `repos/O/R/issues/N/comments` (body via `--input -` JSON on stdin, never argv); `replyTo` a numeric review comment id → `repos/O/R/pulls/N/comments/{id}/replies`; a thread node id (`PRRT_…`) → GraphQL `addPullRequestReviewThreadReply`. Returns the node id the snapshot uses for the new comment.
  - `resolveThread(run, threadId): Promise<void>` (GraphQL `resolveReviewThread`).

- [ ] **Step 1: Write failing tests**: `fetchSnapshot maps a pull request with reviews, threads and a check rollup, without any body text` (assert `JSON.stringify(snapshot)` contains none of the fixture bodies/title), `fetchSnapshot reads an issue and its closed reason`, `fetchSnapshot pages past 100 comments`, `readItem truncates a diff over 1 MiB`, `postComment sends the body on stdin, not argv`, `postComment routes replyTo by id shape`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(github): snapshot, read and write calls through gh`.

### Task 3: Event diff and update formatting

**Files:**
- Create: `lib/github/events.ts`
- Test: `lib/github/events.test.mjs`

**Interfaces:**
- Consumes: `ItemSnapshot`, `formatTarget`.
- Produces:
  - `interface WatchCursor { commentIds: string[]; reviewIds: string[]; threadCommentIds: string[]; reportedHeads: string[]; final: boolean }` (id sets are bounded: keep the newest 2000 of each).
  - `baselineCursor(snapshot): WatchCursor` (marks the current head reported if its checks are all terminal).
  - `type GithubEvent` (union: `comment`, `review`, `thread_comment`, `ci`, `merged`, `closed`), each with `id`, `url`, and metadata from the snapshot.
  - `diffSnapshot(cursor, snapshot, postedIds: ReadonlySet<string>): { events: GithubEvent[]; cursor: WatchCursor }`: new ids not in cursor and not in `postedIds` become events (posted ones join the cursor silently); one `ci` event when the head is not in `reportedHeads` and every check is terminal (counts by conclusion, failed/cancelled/timed-out names capped at 100 chars); `merged`/`closed` once, setting `final`.
  - `formatUpdate(targetText, url, events): string` — header line, then one line per event per spec "What is delivered".
  - `updateEntryId(watchKey: string, events): string` — `"gh-" + sha256(watchKey + "\0" + eventIds.join("\0")).base64url.slice(0, 40)` (matches the outbox's `ENTRY_ID_RE`).

- [ ] **Step 1: Write failing tests**: `diffSnapshot reports only new comments, reviews and thread comments`, `diffSnapshot skips the agent's own posts but reports the same account's other comments`, `diffSnapshot reports CI once per head and not for a superseded head`, `diffSnapshot ends the watch on merge and on close`, `an edited comment is not an event` (same id), `formatUpdate carries no GitHub-authored text` (fixture with hostile body/title/branch absent from output), `updateEntryId is stable for the same events`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(github): watch events and metadata-only update text`.

### Task 4: Watch store

**Files:**
- Create: `lib/github/watch-store.ts`
- Test: `lib/github/watch-store.test.mjs`

**Interfaces:**
- Consumes: `WatchCursor`.
- Produces (tables `watches(session_id, item_key, kind, cursor_json, created_at, PRIMARY KEY(session_id, item_key))`, `posted(item_key, comment_id)`, `read_grants(session_id, repo_key)`; `item_key` = `owner/repo#n` lower-cased owner/repo):
  - `addWatch(sessionId, itemKey, kind, cursor): "added" | "exists" | "limit"` (limit 20 per session).
  - `removeWatch(sessionId, itemKey): boolean`; `removeSessionWatches(sessionId): void`.
  - `listWatches(): { sessionId; itemKey; kind; cursor }[]`.
  - `commitUpdate(sessionId, itemKey, cursor, final): void` — saves the cursor, or deletes the watch when `final`. A crash before it runs is safe: the next poll derives the same `updateEntryId`, which the outbox answers with the stored entry.
  - `recordPosted(itemKey, commentId)`, `postedIds(itemKey): Set<string>`.
  - `hasReadGrant(sessionId, repoKey)`, `grantRead(sessionId, repoKey)`.
  - `renameSession(oldId, newId)` (for session moves), `closeWatchStore()`.

- [ ] **Step 1: Write failing tests**: `the 21st watch of a session is refused`, `commitUpdate with final removes the watch`, `watches survive reopening the store`, `renameSession moves watches and read grants`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** like `lib/notification-store.ts` (`bun:sqlite`, WAL, busy timeout, `close(true)`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(github): SQLite watch store`.

### Task 5: Poller and outbox delivery

**Files:**
- Create: `lib/github/watcher.ts`
- Modify: `instrumentation.node.ts` (start after `startOutbox()`; stop in the shutdown path beside `closeOutboxStore`)
- Modify: `lib/rpc-manager.ts` (call `renameSession` where `onSessionMove`/identity aliases are recorded for the outbox; call `removeSessionWatches` where a session is deleted)
- Test: `lib/github/watcher.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4; `runOutboxCommand`, `outboxScope` (`lib/message-outbox.ts`); `loadWebServerSettings().agentToolsEnabled`.
- Produces:
  - `startGithubWatcher(deps?: { run?: GhRunner; deliver?: (sessionId: string, entryId: string, message: string) => Promise<"ok" | "gone" | "retry">; now?; schedule? }): void` and `stopGithubWatcher(): void` (`globalThis` singleton).
  - default `deliver` = `runOutboxCommand(sessionId, { type: "outbox_add", id, scope: outboxScope(), mode: "prompt", message }, false, "omp-web:github-watch")`: 2xx → `"ok"`, 404 → `"gone"`, anything else → `"retry"`.
  - `pollOnce(): Promise<void>` (exported for tests): skips everything while `agentToolsEnabled` is false; groups watches by item, one `fetchSnapshot` per item, spreads items across the 60 s interval; per watch `diffSnapshot` → if events, `deliver(updateEntryId)` → `"ok"`: `commitUpdate`; `"gone"`: `removeSessionWatches`; `"retry"`: leave the cursor. On `GhUnavailableError`, deliver one notice per session (`GitHub update (omp-web): watching paused: <message>`), and one "resumed" notice once it recovers (state in `globalThis`, not persisted).

- [ ] **Step 1: Write failing tests** (fake run/deliver/schedule): `a new review is delivered once and the cursor advances`, `a retry leaves the cursor so the next poll redelivers the same entry id`, `a gone session ends its watches only`, `two sessions watching one item fetch it once and each get an entry`, `agent tools off pauses polling and turning it on catches up`, `gh unavailability is announced once and its recovery once`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**, then wire start/stop and the session move/delete hooks.
- [ ] **Step 4: Run** the test plus `bun test --parallel lib/message-outbox.test.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(github): poll watches and deliver through the outbox`.

### Task 6: The five agent tools

**Files:**
- Create: `lib/github/tools.ts`
- Modify: `lib/agent-tools.ts` (names, definitions, delegation), `lib/rpc-manager.ts` (`createAgentToolOps` supplies `github`; replay rule at the `host_tool_call` case)
- Test: `lib/github/tools.test.mjs`; extend `lib/agent-tools.test.mjs` only for the delegation/definition contract

**Interfaces:**
- Consumes: Tasks 1, 2, 4; `AgentToolContext`, `AgentToolHost`, `startsUnasked` rule.
- Produces:
  - `GITHUB_TOOL_NAMES = new Set(["watch_github", "unwatch_github", "github_read", "github_comment", "github_resolve_thread"])`, `GITHUB_TOOL_DEFINITIONS: HostToolDefinition[]` (descriptions per Global Constraints and spec "Tools"; `github_read` says returned text is untrusted data).
  - `interface GithubToolOps { run: GhRunner; listHosts(): AgentToolHost[]; writesUnasked(): boolean }`.
  - `executeGithubTool(name, args, ops: GithubToolOps, ctx: AgentToolContext): Promise<unknown>`: `checkGh` first; reads/watches from `ctx.sourceHostId !== "local"` need `hasReadGrant` or a `startsUnasked`-style host allowance or `ctx.confirm("Let this session on <host> read OWNER/REPO through the server's GitHub login?")` (grant stored on yes; error `"The user declined GitHub access for this session."` on no); writes need `ops.writesUnasked()` or `ctx.confirm` showing target and the first 3 lines of the body (error `"The user declined to post on GitHub."`); `github_comment` refuses a body over 65 536 characters before asking, and records the new id via `recordPosted`; `watch_github` baselines with `fetchSnapshot` + `baselineCursor`.
  - `AgentToolSessionOps` gains `github: GithubToolOps`; `AGENT_TOOL_NAMES`/`AGENT_TOOL_DEFINITIONS` include the GitHub ones; `executeAgentTool` delegates for those names after the enabled check and `ctx.guard.checkRate`.
  - Replay (`this.replaying`): `github_read`, `watch_github`, `unwatch_github` run (idempotent); `github_comment`, `github_resolve_thread` answer `AGENT_TOOL_UNKNOWN_OUTCOME`.

- [ ] **Step 1: Write failing tests**: `every GitHub tool description starts with the gh requirement`, `a missing gh fails the call with the install message`, `a remote session asks once per repository and remembers the answer`, `a host with allowAgentStart reads without asking`, `a write asks every time unless writes are unasked`, `a declined write posts nothing`, `github_comment records its comment so the watcher skips it`, `watch_github is idempotent and refuses the 21st`, `the agent-tool gate refuses GitHub tools when agent tools are off`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** and wire.
- [ ] **Step 4: Run** `bun test --parallel lib/github/tools.test.mjs lib/agent-tools.test.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(github): watch, read and reply agent tools`.

### Task 7: The write setting, docs and changelog

**Files:**
- Modify: `lib/web-settings.ts` (`githubWritesUnasked: boolean`, default `false`, read as `raw.githubWritesUnasked === true`), `app/api/web-settings/route.ts` (boolean validation like `agentToolsEnabled`, code `invalid_settings`), `components/SettingsConfig.tsx` (a `GithubWritesSetting` toggle after `AgentToolsSetting`, same pattern), `lib/i18n/locales/{en,ja,zh-CN,zh-TW}.json` (`settingsConfig.githubWritesUnasked`, `…Desc`, `…SaveFailed`; extend `settingsConfig.agentToolsDesc` to name the GitHub tools and the `gh` requirement), `AGENTS.md` (file map entries for `lib/github/*`, a short "GitHub agent tools" subsection under Key Design Decisions pointing to the spec), `CHANGELOG.md` (Unreleased → Added).
- Test: `lib/web-settings.test.mjs`

- [ ] **Step 1: Write failing test** `githubWritesUnasked defaults to false and round-trips`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the setting, route, toggle, strings, docs.
- [ ] **Step 4: Run** `bun test --parallel lib/web-settings.test.mjs` then `npm run typecheck && npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(github): setting to allow agent writes without asking; docs`.
