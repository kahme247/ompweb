# Remote workspaces: files, Git and worktrees

Date: 2026-11-03
Status: Architecture and written specification approved on 2026-11-03; implementation planning follows verification of current Explorer behavior.
Tracking: https://github.com/kahme247/ompweb/issues/388
Parent design: [Remote hosts](2026-10-28-remote-hosts-design.md), delivery sub-project 2.

## Goal and approved decisions

A workspace on a remote host gets the existing Explorer, file viewer, Git,
worktrees, directory picker and clone behavior. This is parity, not a new file
manager or Git client. The user selected this sub-project first and approved:

- One daemon path for every host, including this machine. Main does not keep a
  direct-local fallback for these features.
- Typed host operations, using the existing sequenced host link rather than a
  generic HTTP proxy or another socket.
- Daemon-owned filesystem authorization, host-scoped client resources and
  preservation of transfers, watches, clone progress and cancellation.

The user approved the written specification on 2026-11-03. The Explorer baseline
below also records the current hidden-item behavior and search limits.

## Scope

| Surface | Required parity |
| --- | --- |
| Explorer | Directory listing, Show hidden items toggle, search/file index, uploads, upload conflict checks and downloads |
| File viewer | Text, images, audio, documents, DOCX preview, metadata, ranges, live changes, linked files and diff view |
| Composer and chat | File suggestions, file mentions, relative/absolute file links, referenced bash output and GitHub repository resolution |
| Git | Existing status and per-file diff views; no new Git actions |
| Worktrees | Listing, current-worktree selection, create, remove with dirty confirmation, new-session selector and project grouping |
| Directory picker | Host home, parent/child navigation, Windows drives, typed-path validation and default scratch directory |
| Clone | Host-side clone with existing progress, cancellation, cleanup and project registration |

Search across session transcripts, usage, import, archive and config surfaces
remain tracked by the parent issue and are not implemented by this sub-project.
An individual chat's file index/search is in scope; transcript search is not.

## Existing seams and constraints

Sessions and projects already use `Host.sessionOps`, with named parameters in
`SESSION_OP_PARAMS`, daemon dispatch and checked results in `hub.ts`. File, Git
and worktree routes currently execute on main instead. Their client callers
usually carry a path or cwd but no host identity. `AppShell` disables remote
Explorer and Git by clearing `explorerCwd`, while other components gate their
own actions.

`getAllowedFileRoots()` currently uses main's `hostSessions("local")` cache.
It cannot simply be called unchanged inside a daemon: that process has no hub
link from which to populate the cache. The authorization source must move, not
just the route body.

The link already provides fair scheduling, reconnect sequencing, binary
results and binary uploads. It caps an individual result at 64 MiB and a JSON
request line at 8 MiB. Neither limit is a whole-file transfer limit.

Composer uploads already use `uploadFile` (`lib/event-stream.ts`), the main
relay (`lib/uploads.ts`) and daemon staging (`lib/hosts/uploads.ts`). Their
shared `MAX_UPLOAD_BYTES` (`lib/upload-limits.ts`) is 2 GiB per file. Reuse
this path for Explorer uploads; do not preserve its legacy 25 MiB/file,
100 MiB/batch and 101 MiB multipart-body caps or build a second uploader.
The existing 1 MiB upload-check JSON-body cap remains a control-message limit.
Text preview remains limited to 256 KiB and image/DOCX preview to 10 MiB:
these bound rendering/conversion, not transfer. Raising them is not required
to upload or download a large file.

### Current Explorer baseline

Checked against freshly fetched `upstream/main` on 2026-11-03, including
kahme247/ompweb#378 (`f4cf9749`).

- The tree hides its named skip-list (`node_modules`, `.git`, `dist`, `build`
  and similar generated/cache entries) and `.pyc` files by default. The
  **Show hidden items** toggle sends `hidden=1` for directory listings and
  bypasses that skip-list. It is not a blanket dotfile filter and never bypasses
  file authorization. Preserve the toggle, its preference and stale-listing
  fencing when threading host identity through the client and daemon.
- The toggle affects tree listings only. File-index search uses Git's tracked
  and non-ignored untracked files; its non-Git fallback still applies the named
  skip-list and `.pyc` exclusion. Do not silently make the toggle expand search
  scope as part of remote parity.
- The unqueried file-index response returns at most 5,000 paths. Queried search
  ranks against the full cached listing, not that 5,000-path prefix. Explorer
  requests at most 200 file matches; the default `@` suggestion limit is 20.
  Search queries are sliced to 500 JavaScript string code units.
- The full Git listing is capped at 200,000 paths. The fallback filesystem
  walk is capped at 50,000 files and eight directory levels below the root.
  The listing cache lasts 10 seconds, and Refresh bypasses it. Preserve
  existing truncation reporting; do not apply these index caps to ordinary
  per-directory tree listing.
- Downloads and streamed PDF/audio have no explicit whole-file size cap in
  the current file route. Image and DOCX conversion limits are preview limits,
  not download limits. The host link's 64 MiB per-result cap must not restrict
  total download size.

The legacy Explorer upload caps above describe the old multipart route, not
the desired parity contract. Explorer must support the composer's existing
2 GiB/file transfer capability through the same shared constant and uploader.
Do not impose a 100 MiB aggregate byte cap on a streamed batch. The composer's
20-files-per-message rule belongs to prompts, not workspace directory uploads;
retain existing upload concurrency/backpressure controls instead of copying
that prompt rule into Explorer.

## Ownership and interfaces

### Browser

Every workspace resource carries its owning host. Use the existing local-host
normalization convention; absence of `hostId` on an existing HTTP request
continues to mean local. Include `hostId` in queries, mutation bodies and file
channel subscriptions. A supplied session context must belong to that same
host; reject mismatches rather than using either machine as a fallback.

Persist host identity on file tabs and their source session, not just the
currently selected chat. Tab deduplication, cache keys, pending actions,
worktree state and file-watch subscriptions use `(hostId, path)` or
`(hostId, cwd)`. The same absolute path on two hosts is two resources. Host
switches fence stale fetches and continuations so an old response cannot update
the newly selected workspace. URLs used for images, media, previews and
explicit downloads carry the same host context.

Relative links resolve against their source document/workspace on its host;
`~`, Windows drives, UNC paths and separators are interpreted by that host.
The browser does not apply main's POSIX path rules to a Windows host.

### Main

Keep the existing HTTP endpoints. Main retains authentication, bounded HTTP
parsing, host resolution, response/status/header formatting and subscription
routing. The selected daemon owns path resolution, access checks, file/Git
operations and workspace registry mutations. Main validates host results before
rendering or returning them. Remote paths never reach main-side `stat`,
`realpath`, file authorization, Git or project-cache functions.

Use one host selection rule for all affected routes. Resolve explicit host IDs
with the existing host resolver. Resolve a session-only request through its
session host; if both are present, require agreement. Unknown host, offline host
and unsupported operation remain distinct errors. Never retry a mutation on a
different host or automatically repeat an uncertain destructive operation.

### Daemon

Add a workspace-operations module beside `session-ops.ts`, exposed as
`Host.workspaceOps`. Reuse the named-parameter dispatch pattern, result envelope
and host-op allow-list. Keep session operations in their existing module; do
not rename unrelated session APIs merely to add workspace operations.

Extract existing route filesystem/Git logic into daemon-loadable helpers,
preserving behavior and shared authorization. Do not copy route implementations
for remote use. All daemon-loaded imports remain relative and Node-compatible;
Bun HTTP concerns stay on main. Each operation validates its untrusted wire
arguments. Main checks result shapes and byte/count bounds, including new
binary result operations.

Logical operation groups:

| Group | Responsibility |
| --- | --- |
| Directory | Home, browse, default cwd; existing `validateCwd` also authorizes the selected directory on its daemon |
| File | List, metadata, text read and file index; bounded read-transfer lifecycle for byte streams |
| Upload | Reuse existing binary transfer/staging; add authorized workspace publication and conflict inspection |
| Git | Status, diff and GitHub repository resolution using existing helpers |
| Worktree | List, add and remove; owning-host cache invalidation |
| Watch | Subscribe, unsubscribe and daemon-to-main change notifications |
| Clone | Start, bounded progress reads and cancel; existing project op registers the confirmed result |

## Authorization and trust boundaries

The browser and main are not sources of filesystem authority for a daemon.
The host link is authenticated, but every operation still validates arguments
and applies that machine's access policy.

The daemon builds roots from its own session cwds/resolved project roots,
registered visible projects, explicitly validated directories, default scratch
directories and worktrees admitted by an authorized list/create operation.
Preserve the existing config/instruction roots and credential-file exclusions.
Root caching/invalidation lives with these sources; it does not query the hub
or another machine. Selecting or registering a directory grants that host's
existing workspace access, never main-side access to the same string.

Reuse the shared read-authorization policy for file reads, metadata, downloads,
previews and watches. Session-reference exceptions are resolved from the owning
host's transcript; they do not grant directory listing or write permission.
Keep realpath/symlink containment and credential exclusions at the actual
access boundary. Do not grant a symlink target more access than a direct path.

Uploads require an authorized absolute destination, safe filenames and
containment at write/commit time. Partial uploads are private staging files,
not visible target files. Recheck conflicts at commit: `error` and `skip` must
not overwrite a file that appeared after inspection. Interrupted or failed
writes must not destroy an existing target. Preserve the explicit overwrite
choice; cancellation only removes staging owned by that transfer.

Worktree removal must match a worktree in the selected repository, refuse the
main worktree, and preserve dirty confirmation. Never trust a requested delete
path merely because it has the right shape. Clone cleanup removes only the
destination this clone successfully created; never an existing directory or an
unrelated replacement. Git runs on the host with argument arrays and the
existing sanitized environment and protocol restrictions.

Directory browsing preserves the current ability to navigate before selecting
a workspace. It does not authorize file content in each directory visited;
validation/selection remains the explicit grant boundary.

Remote bytes and HTML are untrusted. Keep MIME/content checks, content
disposition, preview sanitization and restrictive CSP. DOCX conversion may run
on main on bounded bytes returned by the host; it must not open the remote path
on main or permit active remote content in the application origin.

## Transfers and lifecycle

### Downloads, media and previews

For streamed responses, open an authorized file on its daemon and return an
opaque read handle plus validated metadata. Read sequential bounded chunks
through the existing request/result mechanism, returning raw bytes as for
`readMedia`. Extend binary-result handling explicitly for these operations;
do not base64-encode whole downloads or assemble the whole file in main memory.
One response pulls only its next bounded chunk, so HTTP backpressure bounds
memory. Preserve valid Range responses, 416 behavior and cancellation.

Handles bind to the opened resource, host and daemon lifetime. A replaced file
must not cause one download to concatenate bytes from different files. Close
handles on completion, cancellation or error; idle abandoned handles expire
after two minutes. A daemon restart invalidates handles. A link interruption
fails the current HTTP read rather than silently reopening/restarting it.

The existing 256 KiB piece size is the upper bound for one raw read chunk.
This permits files larger than the link's per-result cap without raising that
cap or adding a general streaming protocol.

### Uploads

Reuse `uploadFile`, its worker/browser-link and HTTP fallback, main's
owner-scoped relay, and `StagedUploads` on the target daemon. They already
transfer binary chunks of at most 256 KiB, bound unacknowledged bytes to
`UPLOAD_WINDOW_BYTES` (2 MiB), resume from acknowledged offsets and reject
files larger than `MAX_UPLOAD_BYTES` (2 GiB). Do not base64-encode another
upload stream, buffer a whole file/multipart batch, or add a separate
start/chunk/cancel implementation.

The missing operation is publishing a completed staged upload into an
authorized workspace directory. Add that destination-specific operation
alongside the existing session-only `uploadAttach`; do not pass a fake session
or grant arbitrary destination paths to the session attach operation.
Main checks ownership and host agreement; the daemon checks write authorization,
safe filenames, completed byte count and destination conflicts. Preserve
`error`, `skip` and explicit `overwrite`, with per-file batch outcomes.
Publication must be safe across lost replies: a receipt bound to the upload
and destination lets a repeat return the confirmed result without overwriting
again. An incomplete upload never replaces an existing target.

Keep existing upload retry, stall, cancellation and staging-cleanup behavior:
the current main registry has a 10-minute idle bound, daemon staging has a
24-hour lifetime and hourly sweep, and transient uploads resume using the
existing sender. Do not replace those with a new two-minute upload expiry.
Workspace files are user files, not session attachments: they must not be
enrolled in automatic sent-session-upload retention or deleted by removing
a composer chip. Only their uncommitted staging uses upload cleanup.

The old multipart Explorer upload path is removed in the client/server
cutover. Conflict inspection can retain its bounded JSON request; file bytes
use the shared uploader in both browser transports, on local and remote hosts.

### Watches

Move `fs.watch` and the trailing stat check to the daemon. Add a sequenced
workspace-watch event identifying the watch subscription, never an arbitrary
host-selected browser channel. Main routes it to the existing `file` channel;
no new browser socket or EventSource is introduced. Unsubscribe closes the
watch and timers. Late events from an old watch are ignored.

On link loss, notify the file consumer that its connection is unavailable.
On reconnect, reauthorize/re-establish active watches and obtain a fresh stat
before declaring them connected, so saves during the gap cannot be missed.
A daemon restart or socket replacement must not leave duplicate active watches;
subscriptions belong to the current main/link ownership epoch.

### Clone

Run the child and cleanup on the daemon. `startClone` returns a job identity
promptly rather than holding a 30-second ordinary op open for the whole clone.
Progress reads use a cursor and a bounded buffer, returning within one second;
main exposes the existing NDJSON response, including a final cleanup-confirmed
`done`, `cancelled` or `error`. If a bounded progress buffer rolls over, advance
the cursor explicitly; do not buffer an unbounded command log.

Cancel targets the job, stops its process tree and waits for cleanup before
reporting cancellation. Disconnecting the HTTP client requests cancellation.
Jobs not observed for two minutes cancel and clean up. A temporary host-link
gap is not proof of cancellation: report uncertainty until a same-daemon status
read confirms the terminal state. A new daemon cannot claim the previous job
completed. Register only the confirmed clone result on its owning host.

## Compatibility, errors and cutover

Add optional advertised workspace operation names to the daemon hello. Absence
means workspace operations are unsupported, not that the host is offline.
Older daemons keep their sessions and link; show a host-daemon upgrade hint for
unsupported workspace features. New operations and watch notifications are
additive, using the existing unknown-op/message compatibility policy. Do not
raise the minimum link version or change existing message meanings.

After migration, remove direct-local implementations of the affected routes
and remove remote-unavailable gates only when their surface is fully connected.
A stopped local daemon now makes these workspace features unavailable, matching
the approved single-path decision. Dev mode still does not take production's
local daemon; its workspace UI must report unavailable rather than reaching
production or using a hidden direct-local fallback.

Main-side readers for config and other out-of-scope features remain unchanged.
Where authorization helpers serve both kinds of reader, separate policy from
root discovery rather than moving those unrelated features onto host ops.

Preserve structured error codes and HTTP status semantics: authorization 403,
missing file 404, upload/worktree conflicts 409, existing size failures 413,
unsupported operation 501 and host-link failures 503. An error received after a
mutation was sent must not imply the mutation did not happen. Surface uncertain
outcomes and reconcile state before offering a repeat.

## Delivery boundaries

The implementation plan will use complete user-facing slices, not a merged
scaffold. The sequence is files and their authorization/transfer/watch path,
then Git/worktrees, then directory-picker/clone completion. Local and remote
callers migrate together for each affected surface. Existing settings/config
gates remain until their separate sub-project ships. This sequence does not
remove any item from the accepted sub-project scope.

Use the repository's spec and plan conventions. Add changelog/user guidance
with the behavioral changes, including the local-daemon dependency and older
daemon upgrade hint. Extend packaging if a new runtime asset is introduced;
ordinary imported source modules need no separate copied asset.

## Acceptance and verification

1. Use two hosts with the same absolute workspace path and different contents.
   Open both files/tabs and switch chats; listing, reads, suggestions, links,
   Git, downloads and watches remain attached to their owner.
2. Exercise the actual Node `ompweb host` daemon and real server routes, not
   only a fake Host: browse, preview, Range download including a file over
   64 MiB, upload with each conflict choice, modify a watched file and cancel
   a transfer. Upload files larger than 25 MiB and batches larger than 100 MiB
   through Explorer. Cover the shared 2 GiB/file boundary and refusal above
   it without allocating a whole-file buffer. Memory stays bounded by transfer
   chunks/windows, not whole file or batch size.
3. Deny outside-root reads/listings/writes, cross-host session-reference use,
   secret-file and symlink escapes. Allow legitimate instruction/file links
   under the existing policy. Test destination races and interrupted overwrite
   so the old target survives unless a complete overwrite commits.
4. In a temporary Git repository, prove status/diff, GitHub remote resolution,
   worktree list/create/select, dirty removal refusal and explicit force
   confirmation. Session/project lists refresh on that host, not another one.
5. Exercise directory navigation/default cwd and a real clone on the selected
   host, progress, failure, cancel and HTTP disconnect cleanup. Verify unknown
   job/host errors and no deletion of a pre-existing target.
6. Disconnect/reconnect the link while reading, staging uploads, watching and
   cloning; verify no host fallback, duplicate write or false success. Restart
   main/daemon separately and check resource cleanup and stale-response fences.
7. Verify an older daemon still runs sessions and receives no unsupported watch
   traffic; workspace UI gives the upgrade hint. Verify production/local and
   dev behavior under the single-daemon-path rule.
8. Run affected existing suites with `bun test --parallel`, typecheck/lint/build,
   the packaged smoke command and browser checks of Explorer, file viewer, Git,
   Worktrees and directory picker. Cover Windows path semantics in deterministic
   tests; report separately if no live Windows host was exercised.

Permanent tests target authorization, observable transfer outcomes, identity
isolation, lifecycle transitions and mutation safety. Do not pin source text,
op counts or incidental wiring. Use the actual UI and real daemon for smoke
proof; tests alone do not establish remote parity.
