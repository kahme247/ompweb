# omp-web - Development Notes

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

---

## Architecture

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/agent/running/events ───▶ running id SSE          │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/**                         provider list, login/logout, API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  github-repo/route.ts            GET ?cwd= — GitHub owner/repo of the checkout (for #N links)
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
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  agent-client.ts      typed fetch helper for /api/agent commands
  btw.ts               /btw side-question records + pure frame/snapshot merge (order-safe)
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  github-refs.ts       remark plugin linking #N / owner/repo#N + GithubRepoContext
  git-clone.ts         pure clone helpers: URL→directory name (https/ssh only), \r-aware progress log
  github-repo.ts       server: pick the gh-default GitHub remote from git config
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  rpc-manager.ts       session registry + startRpcSession over RpcProcess
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  session-resume.ts    running-session list for auto-resume after a restart
  web-settings.ts      omp-web server settings (~/.omp/agent/omp-web-settings.json)
  skills-service.ts    skill listing via `omp skill list --json`; pure-Node replica scan as fallback
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getToolNamesForPreset()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  word-prediction.ts   pure ghost-text arithmetic (advance/accept) for composer word prediction
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
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
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  PluginsConfig.tsx   modal for installed plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  GhostMirror.tsx     textarea overlay painting ghost-text word completion
  TabBar.tsx          tab bar (Chat + open file tabs)
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts              completion sound + browser AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state (localStorage key "omp-theme")
  useWordPrediction.ts     debounced omp predict_word ghost text + feedback
  useBtw.ts                /btw records/active panel/history dialog fed by btw_* SSE frames
```

---

## Key Design Decisions & Traps

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
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
- A service stop signals every process at once, so an omp child can die
  before omp-web's own SIGTERM handler runs. A session whose process died
  therefore stays listed for `EXIT_GRACE_MS`; the shutdown handler freezes the
  list (`markShuttingDown`) so those deaths count as interrupted, while a
  crash with omp-web still up is dropped after the window.
- Only session ids are stored; paths are re-resolved on resume.
- Known limit: resume does not detect a terminal `omp --resume <id>` started
  on the same session while omp-web was down; both would write the file.

### Two kinds of branching — don't confuse them
- **Fork** ("Fork a new session from this point" button, `messageView.newSessionTitle`, on user and assistant messages; only offered while the session is idle — ChatWindow gates it on `!sessionBusy && !isNew`): creates a new independent `.jsonl` file via omp's `branch` RPC. Shown as a child in the sidebar tree via `parentSession` header field. `branch` only takes a user entry and keeps the history *before* it, so `lib/chat-fork.ts` maps rows: a user prompt forks at itself and its returned text prefills the fork's composer (edit-and-resend, text only — attached images are not restored); an assistant reply forks at the next user prompt so the reply is kept; the newest reply falls back to its own prompt with the prefill. Rows that would edit the very first prompt (an empty fork) offer no fork.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

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
- `tool_execution_update` is coalesced per tool call at display rate in
  `lib/message-update-coalescer.ts` (chatty commands emit ~10-100+ frames/s).
  `message_end` drops the pending `message_update` (the committed message
  supersedes it) but must NOT drop buffered tool updates.
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

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
`remove_queued_message` (act only on `removed: true`), Steer uses
`promote_queued_message`; the chip changes when omp's next snapshot arrives.
`handleAbort` coalesces overlapping Stops, then sends `abort_and_restore_queue`:
omp's Esc (`clearQueue({ forInterrupt: true })`, then abort) in one step,
returning the withdrawn user messages, which go to the session draft via
`recoverDraftText`. It covers what a client snapshot cannot: a steer promoted
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

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
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
  idle and the streaming submit path, *before* the attachment gate: never sent
  as a prompt, never queued, and refused with a toast (draft and attachments
  kept) while attachments are attached. Asking starts the wrapper
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
- The client sorts the merged list by most-recently-added (registration
  order), then by path for session-discovered projects
  (`lib/project-ordering.ts`); the order deliberately does NOT depend on
  session activity, so project rows never jump around while sessions refresh.
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.

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
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
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
- `GET /api/app-update` queries the npm registry for `@kahme247/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @kahme247/ompweb` or `bun add -g @kahme247/ompweb`).
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

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
- Jobs carry the composer scope (`draftKey`: session id or `new:<cwd>`). The
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
  job owner: it survives the composer remounting (`AppShell` keys
  `ChatWindow` by session), gets the 15s first claim, and alone gets the
  send/queue choice back. A duplicated tab copies it, so exclusivity comes
  from the claim token, which is per hook instance.
- The send/queue choice (`after`: send | steer | followup) is uploaded with
  the recording, kept on the job, and returned with the owner's claim. Never
  keep it only in component state: a session switch remounts the composer and
  loses it. A non-owner claim only inserts, since that composer holds its own
  draft and attachments.
- Store is per process (`globalThis` map) with caps (4 pending, 20 live) and
  TTLs; a server restart loses jobs, and the hook then re-uploads its local
  copy if it has one.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

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
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
