# ompweb — Product & Architecture Contract

## Purpose

ompweb is a local, browser-based workspace for the
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent. It lets a
user browse the same local sessions they use in the terminal, continue live
work, configure supported OMP settings, and inspect project files without
creating a second agent runtime or a second source of truth.

The project originated from [agegr/pi-web](https://github.com/agegr/pi-web)
(MIT), but it is maintained as an OMP-focused downstream. We preserve the
license and attribution, and selectively learn from upstream improvements; we
do not assume that Pi-specific implementation changes can be merged unchanged.

## Product principles

1. **OMP remains authoritative.** Sessions, credentials, providers, and agent
   behavior belong to the installed `omp` CLI. ompweb must not invent a
   parallel data format or credential store.
2. **Local-first by default.** The server binds to `127.0.0.1`; remote access
   is an explicit user choice and must be protected by a trusted network
   boundary and HTTPS.
3. **Node-first installation.** A normal user installs Node.js 22.19+ and OMP,
   then runs `npx ompweb@latest` or installs `ompweb` globally. ompweb does not
   require users to install Bun for its own runtime.
4. **Native compatibility over imitation.** Prefer OMP's CLI and documented
   on-disk formats to copied SDK internals. If a capability cannot be done
   safely through those boundaries, leave it out rather than emulating it
   speculatively.
5. **A calm, capable workspace.** The UI should make active work, session
   history, configuration, and project context understandable without hiding
   the agent's state or expanding the app into a general remote-control plane.

## Distribution and identity

- npm package and CLI command: `ompweb`.
- Default server address: `http://127.0.0.1:30177`.
- Existing `OMP_WEB_*` environment variables remain the configuration prefix
  for compatibility: `OMP_WEB_HOSTNAME`, `OMP_WEB_NO_OPEN`, and
  `OMP_WEB_OMP_BIN`. `OMP_WEB_PASSWORD` is accepted only as a migration step
  (see the security contract).
- `PI_CODING_AGENT_DIR` and OMP's own directory conventions are
  respected because they identify the user's existing OMP state.
- The web UI displays its own package version separately from the detected
  installed OMP version; those versions may legitimately differ.

## Runtime architecture

```
Browser
  │ HTTP / Server-Sent Events
  ▼
ompweb (Next.js on Node)
  ├─ reads native OMP session files and selected configuration
  ├─ serves allow-listed project files
  └─ starts one `omp --mode rpc-ui` child per active session
       │ NDJSON over stdio
       ▼
     installed OMP CLI and its existing ~/.omp/agent state
```

### Why the CLI boundary is locked

OMP SDK packages are Bun-only TypeScript and import Bun APIs. Importing
`@oh-my-pi/*` or `@earendil-works/*` into a Node/Next server would make the
application unreliable or non-runnable. Therefore, production code must not
add those runtime dependencies.

Live work goes through the user’s installed `omp --mode rpc-ui` process. This
keeps the agent version, providers, extensions, and session behavior aligned
with the CLI the user already trusts. The RPC layer negotiates v2 when the CLI
advertises it, reassembles bounded chunked frames, and remains compatible with
v1-capable installations.

## Data and mutation boundaries

### OMP-owned state

- `~/.omp/agent` is the source of
  truth for sessions, configuration, models, skills, plugins, and blobs.
- `agent.db` contains authentication data. ompweb never reads or writes it;
  authentication actions go through the OMP RPC process.
- A live OMP process owns writes to its session file. ompweb routes supported
  live actions through RPC and never races a live file rewrite.

### Direct file access

Session browsing is implemented in pure Node against OMP JSONL files. The
reader tolerates the fixed title slot and older session shapes, resolves blob
references when needed, and builds the active branch context from the entry
tree.

Direct session mutation is deliberately narrow and explicit: rename/title,
archive, deletion, and required branch-parent maintenance. These writes are
atomic where possible; archive or deletion stops the associated live process
first. ompweb does not provide a general editor for session JSONL or opaque OMP
state.

Models and allow-listed OMP settings use surgical YAML updates that preserve
unrelated content. Plugin operations run the installed `omp plugin` CLI. MCP
configuration is project-local, validated before writing, and saved atomically.

### Reconnect and foreground catch-up

Completed conversation history is identified by persisted session entry IDs.
Live `message_end` frames have no durable ID and can arrive before OMP writes
the entry, so they trigger catch-up rather than append an unidentified copy.
Streaming text, active tool output, and an optimistic user prompt remain
separate from confirmed history.

`GET /api/sessions/:id/context?sync=1` returns a `SessionSyncResponse`:

- `cursor` contains `firstEntryId` and `lastEntryId` (both null for empty
  history). Send its JSON value in the next request's `cursor` query parameter.
- `mode: "append"` returns only messages after that position; `baseEntryId`
  identifies the expected client prefix. An orphaned cursor or changed
  compaction prefix returns `mode: "replace"`.
- `context.messages` and `context.entryIds` remain aligned. `limit` is an
  integer from 1 to 200 (default 200); follow `hasMore` with the returned cursor.
  Only the selected page's image blobs are resolved.
- Existing `leafId`, `includePreCompaction`, `deferThinking`, and `deferMedia`
  view parameters remain available. A historical view excludes live output.
- `live` contains the web-owned process's current partial message, active tool
  snapshots, and lifecycle flags, or null for a file-only session. Reading
  history never starts an OMP process. A live process can supply its first
  partial before its session file exists, but a missing file cannot erase a
  nonempty confirmed cursor.
- `live.responseObserved` retains positive visible-answer evidence for the
  current run after completion, even before its entry is readable on disk.
  New runs and process/session changes reset it; tool calls alone do not count.

`GET /api/sessions/:id/context?boundary=1` returns only `{ entryIds }` for
the current active context. Prompt and interrupt dispatch use this fresh
ID-only boundary instead of downloading the transcript. It shares the history
index without hydrating message bodies or blobs and cannot be combined with
sync, pagination, or historical-view parameters.

SSE events carry `web: { streamId, sequence }`. The stream epoch changes when
the native process or session identity changes. These values order live
snapshots; they are not a persisted replay journal or `Last-Event-ID` support.
Subscription precedes the `connected` cursor announcement. The client keeps
processing live events while history loads and applies snapshot fields only
when they cannot overwrite newer message, tool, or lifecycle state.

Open/reopen, foreground/online, message completion, and persisted-file
notifications share one coalesced catch-up loop. Pages are accumulated privately
and published only when the selected history is complete. Failed reads retain
the last complete cursor and displayed history. Overlapping full loads preserve
newer complete history rather than treating an intermediate page as authoritative.
Full initial loads and terminal metadata refreshes still update the branch tree.
A completion or persistence notification during an in-flight read schedules
one follow-up read from the newly returned cursor. Raw SSE completions never
append a second copy of an entry that the history response already includes.

Unchanged history pages reuse a file-versioned offset index and seek only the
requested message bodies. The in-memory index cache is bounded to 32 views and
32 MiB of charged metadata; it does not retain transcript bodies or increase
the existing 256 MiB raw-file cache budget or 1 GiB load ceiling. Cold indexes
and changed files require a full metadata scan. Growth alone is not proof of
an append: the same inode can be rewritten and then extended, so any file
version change invalidates offsets rather than trusting an unchecked prefix.
Failed reads never advance the confirmed cursor.

File-only catch-up also refreshes model and thinking metadata without replacing
newer or pending RPC choices. Replacement observer connections restore browser
registrations and the subagent roster only after successfully connecting.

Deploy the frontend and API support together; no native OMP upgrade is required.

## Security contract

- Bind loopback-only by default. A non-loopback hostname is an explicit opt-in.
- `OMP_WEB_PASSWORD_HASH` protects every route with a password-only sign-in
  screen. Only a scrypt hash reaches the server (`ompweb hash-password`),
  because every `omp` session inherits the server's environment and an agent
  could print the password into its transcript, session file and
  model-provider traffic. `--password`, or a plaintext `OMP_WEB_PASSWORD` next
  to a hash, refuses to start. A lone `OMP_WEB_PASSWORD` is hashed by the
  launcher, removed from the server's environment, and logged as a warning with
  the hash to use instead; the server itself still refuses a plaintext.
  Successful sign-in creates an HTTP-only, signed cookie with a 30-day expiry;
  the signing key is a per-installation random value mixed with the hash, so a
  copied password hash cannot forge a session and changing the password still
  invalidates existing sessions. Exposed deployments require HTTPS through a
  trusted reverse proxy or VPN.
- omp-web's own secrets (`OMP_WEB_PASSWORD`, `OMP_WEB_PASSWORD_HASH`,
  `OMP_WEB_TRUSTED_HEADER_SECRET`) are stripped from every child process
  environment through `createChildProcessEnvironment`
  (`lib/project-command-env.ts`). `OMP_WEB_*` values that are configuration
  rather than secrets (`OMP_WEB_PACKAGE_DIR`, `OMP_WEB_OMP_BIN`, ...) are kept.
- API requests are origin-checked. Do not add browser-to-host execution paths
  that bypass this boundary.
- OMP RPC host tools are intentionally not registered. A browser request must
  not become arbitrary host command execution through an extension callback.
- File APIs are not a general filesystem browser. They are restricted to
  selected workspaces, valid Git worktrees, session-referenced directories, and
  explicitly selected roots. Paths are canonicalized to reject traversal and
  symlink escapes.
- Secrets, raw API keys, and auth database contents never appear in API
  responses, logs, or the browser.

## UX contract

- The session sidebar is the durable navigation model: projects, sessions,
  branches, worktrees, and files must agree about the selected workspace.
- Streaming state is explicit. The UI reconciles Server-Sent Events with RPC
  state so a background tab cannot remain falsely “running”.
- Desktop and mobile share the same core workflow. Mobile controls keep usable
  touch targets and a visible loading state rather than a blank shell.
- Accessibility and motion preferences are first-class. Components use the
  shared design tokens and UI primitives rather than one-off colors or controls.
- Expensive rendering is deferred until needed; responsiveness and initial
  bundle size are part of the product contract.

## Upstream and release strategy

`agegr/pi-web` is the historical source and a useful source of UI ideas,
bug fixes, and tests. Before adopting an upstream change, verify that it does
not depend on Pi runtime behavior or Bun-only APIs. Port the user-visible
behavior, not blindly the implementation.

Releases are independent:

1. Run typecheck, lint, relevant tests, and a production build.
2. Confirm `npm pack --dry-run` contains the built `.next` output and exposes
   the `ompweb` binary.
3. Publish `ompweb@<version>` only from an npm account authorized for that
   package.
4. Tag and release the repository that owns this downstream project.

## Non-goals

- Reimplementing OMP, its provider registry, or its credential database.
- Embedding Bun-only OMP SDK packages in the Node server.
- Turning a local agent workspace into an internet-facing multi-user service.
- Unrestricted filesystem browsing or arbitrary browser-triggered host tools.
- Automatic bulk synchronization from `agegr/pi-web`.

When a proposed feature conflicts with one of these boundaries, preserve the
boundary unless the design is intentionally revised first.
