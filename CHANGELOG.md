# Changelog

All notable changes to **omp-web** (`@kahme247/ompweb`) are documented in this file.

---

## [Unreleased]

### Added

- **Sidebar marks sessions with an unsent draft.** A session whose composer still holds text or attachments shows a small pencil beside its title, so a half-written message is easy to find again. The mark follows this browser tab's drafts.
- **Identify untagged builds from the logo.** Clicking or tapping the ompweb logo still reveals the version; builds made from an untagged Git commit also show its full hash and commit date (`YYYY-MM-DD`). Builds made on a tag keep the version-only display. The metadata is embedded in the browser bundle, so installed packages and binaries do not need Git.
- **Workspace file APIs run on the owning host.** Directory listings, file metadata and previews, downloads, file search and referenced shell output go through that machine's daemon, including This machine. File downloads stream in bounded chunks rather than being limited by the host link's per-result size. A stopped or older daemon reports unavailable or unsupported instead of reading a path on the web server.
- **File tabs keep their owning workspace.** Files with the same path on different hosts open in separate tabs. Switching chats does not redirect a tab's reads, Markdown links, images or downloads to the new host. Explorer and composer file suggestions follow the selected host, and confirming an agent's file-open request keeps that request's source host. Mention and reveal actions are disabled while the active chat belongs to another host.
- **Explorer uploads use the shared 2 GiB-per-file uploader on every host.** The old 25 MiB file and 100 MiB batch caps are gone. Files stream into host staging before authorized publication into the selected workspace. Conflict choices preserve existing files until replacement is ready; cancellation removes pending staging, not files already saved. Preview limits are unchanged.
- **Live file watching follows the file's host.** The owning daemon watches and reauthorizes the file, including atomic editor saves. Reconnecting creates a fresh watch and refreshes bytes missed while offline. Closing a tab releases only its watch; no file watcher on the web server substitutes for a disconnected host.
- **Git and worktrees work on linked hosts.** Status, patches and GitHub references use the repository on that machine. Worktree create/select/remove keeps its host identity, grants new paths only there, and retains dirty-removal confirmation. Late results from another selected host cannot replace the current workspace state.
- **Browse and clone workspaces on linked hosts.** The Add workspace picker navigates the chosen machine, validates clone destinations there, and registers completed clones on that host. Clone jobs retain bounded progress across a web restart; cancellation confirms process exit and safe cleanup, while interrupted connections report uncertain outcomes. Workspace URLs can retain their host with `?cwd=...&hostId=...`.
- **Run sessions on other machines from one ompweb.** Link a machine (for example a MacBook) with **Settings → Hosts → Add host**, then run `ompweb host login --url <server url>` (the token is read from stdin) and `ompweb host` there. The remote machine keeps its own `omp`, agent directory and credentials; ompweb routes. The sidebar groups sessions by host, the new-session screen has a host picker, and chat, history, notifications and resume work on every host. If the link drops, the run continues on the remote machine and the chat shows an offline banner until the host reconnects. Agents can pass `host` to `new_session` (it defaults to the agent's own host), which asks for confirmation on a remote host unless the host allows it; an agent on a remote host always asks before it starts or messages a session on this machine. Session archiving and the skills, plugins, agents and MCP settings remain unavailable on remote hosts.
- **Restarting or redeploying ompweb no longer interrupts a run on this machine.** "This machine" now runs through a local `ompweb host` daemon, installed as a second service (`ompweb-host`) by `ompweb systemd install`, `ompweb launchd install` and the Windows tray install. The daemon keeps the omp processes; a restarted web server adopts them, with no resume prompt, and the dialogs and browser tool calls omp was waiting on come back. The daemon is required: until it is installed and linked, "This machine" shows offline (with a banner showing the install command) and new sessions there cannot start. An `ompweb` run in a terminal or with npx installs no service: keep `ompweb host` running in a second terminal. Restarting the daemon still ends runs, and `ompweb systemd restart` leaves it alone. If the web server comes back on another port, the daemon follows it. A `npm run dev` server does not take over the daemon. "This machine" can be renamed in **Settings → Hosts**.
- **ompweb as a single binary, with no Node or npm.** Each release now also carries `ompweb-linux-x64`, `ompweb-linux-arm64`, `ompweb-darwin-x64`, `ompweb-darwin-arm64` (`.tar.gz`) and `ompweb-windows-x64` (`.zip`): one `ompweb` program with the web files beside it. It takes the same options and environment variables as the npm `ompweb`, and runs the daemon too (`ompweb host`). It has no tray, service installers or in-app update: the README's "Single binary" section shows the service units, and Settings → System links the release page when an update is out. Build one with `npm run build:binary`.
- **Binary prereleases from `main`.** Each commit on `main` that passes CI is published as a GitHub prerelease titled with its build time in ISO 8601 UTC (for example `2026-11-01T10:30:00Z`; tag `20261101T103000Z-<short sha>`) with the five single-binary archives. Prereleases are never marked latest, publish no npm package and trigger no update notice.
- **Settings → Hosts shows link protocol versions.** Each host shows the link protocol version its daemon speaks, and the page shows the version this web app expects.
- **Attach any file to a message, up to 2 GiB each.** The composer no longer refuses archives, PDFs or other binary files, and images are no longer capped at 5 MB per message. A file that cannot go inline is uploaded to the session's `local://` directory (`local/uploads/`) on the machine the session runs on, and the message tells the agent its `local://` URL and absolute path; in the chat, each such file is a link that opens it. Each image has an **Inline / As file** switch: Inline sends it with the message as before (omp resizes it for the model), As file keeps the exact bytes. An image too large to go inline switches to As file by itself. Uploads stream in chunks over the browser connection (or over HTTP in SSE mode) and on to the host, and show progress on each chip; Send waits until they finish. An upload resumes by itself from what the host already has when the browser connection drops, the web server restarts, the server loses the host's link, or the upload makes no progress for 2 minutes: the chip shows **Reconnecting…** meanwhile, in both the WebSocket and SSE modes. **Retry** appears only after 5 minutes of such an outage, or for a failure that waiting cannot fix. Update ompweb on the server first, then on its hosts: a host on an older build shows "Update ompweb on the session's host to attach files" when a file is attached. After an in-place upgrade, "This machine" takes uploads only once the ompweb host service (`ompweb-host`) is restarted, and the chip says so; restarting it ends the runs on this machine. Sent uploads are deleted after 30 days by default; **Settings → System → Delete sent uploads after** sets Never, 7, 30 or 90 days for every host, archived sessions included (a host on an older build keeps them).
  **Before upgrading, back up sent uploads you need.** The first retention-policy sync can also delete existing uploads older than the 30-day default. To opt out of that default, set `uploadRetentionDays` to `null` in the server's `omp-web-settings.json` before starting the upgraded server.
- **Keep a host running with the single binary.** The README's "Keep a host running as a service" section has a systemd user unit (Linux), a logon scheduled task (Windows) and, for macOS, a restart script to run in tmux: launchd jobs cannot use the login keychain and SSH agent that omp sessions need. In tmux, macOS Local Network privacy blocks the daemon from LAN addresses, so link it to a URL that does not resolve to one (the server's public URL, or a VPN or tailnet name).
- **Session search shows where each session matched.** While searching the sidebar, the arrow beside a session lists its matches one per line, best match first and newest first among equals, ten at a time with **Load more…**. Matches in the messages of the open conversation are highlighted, typos and partial words included (thinking, tool output and math are not searched; link addresses and image descriptions do not count), and clicking a match opens its session, scrolls to it and marks it as the current one, like the browser's find. Closing or clearing the search removes the highlights. Browsers without the CSS Custom Highlight API (before Chrome 105, Safari 17.2 or Firefox 140) still jump to the match but do not paint it.
- **Show tool calls outside Process details.** A new setting keeps each tool call's row in the transcript instead of folding it; whether the row opens still follows "Keep tool calls collapsed".
- **Never fold tool activity.** A new setting renders every turn flat, with no Process details rows at all. Long turns are paged, and jumping to a search match reveals its message even outside the current page.
- **Connection diagnostics.** Turn on **Settings → Interface & Behavior → Show connection diagnostics** to get a **Connection** tab in the right panel, on desktop and mobile. It shows the transport actually in use (WebSocket or server-sent events, including fallback), connection status, reconnects, and latency statistics over the last 30 minutes: mean, p50, p95, p99.9 and max. Successful commands and sampled live events are grouped by transport. One-way times are clock-corrected estimates; web app ↔ omp includes processing, with `get_state` shown separately as a delivery proxy. p99.9 needs at least 1,000 samples.
- **Updates belong to each host.** Settings → Hosts now shows the ompweb daemon and OMP runtime versions, available updates, and update actions for every machine, including This machine. Checks and installations run on that host. An incompatible or unverifiable daemon update stays visible but blocked, with a reason to update the web server first; OMP updates are independent of the link protocol. A daemon update is refused while session processes or subagents run on that host (close them, then start it again), and the host refuses new sessions while it installs. The host update retains a backup and reports progress after reconnect. **System & Updates** is now **System**, containing only the web server's controls; it no longer updates or restarts a host's OMP sessions globally.

- **Messages wait safely until omp has them.** In an existing chat, the composer clears once IndexedDB has stored the message, and a dimmed bubble names the delivery leg: **Sending**, **Waiting for <host>**, **Delivering**, or **Not sent** with the reason. Browser-held messages survive reloads and closed tabs; server-held messages survive web-server restarts and host outages, and appear on every device viewing the chat. Chromium's Background Sync can deliver after the last tab closes; other browsers retry when an ompweb page reopens. Duplicate submissions share one message id. If a lost host reply leaves delivery uncertain, the message is marked **Not sent** and never retried automatically. Held messages offer **Delete** until dispatched. Follow-ups and steers become omp's own queue chips when accepted. New chats keep their existing first-message path; a browser unable to store the message keeps the composer draft instead.

### Fixes & Improvements

- **Windows host updates allow more time for safety checks.** The process inventory gets up to 20 seconds to start and finish on a busy machine, instead of five. Shared installations and failed or unreadable inventories still block the update before the daemon is stopped.
- **Copied uploads start retention at the send time on Windows too.** When a hard link cannot be used or its timestamp cannot be changed, the host writes a fresh exclusive copy instead of inheriting an old staging timestamp. Failed copies remain retryable without replacing unrelated files.
- **Newly sent uploads survive an overlapping retention sweep.** The host refreshes the staged file's timestamp before making its hard link visible, for attachments and Files-panel uploads alike, so cleanup cannot mistake a just-sent file for an expired one. A Files-panel overwrite of an expired file can no longer be deleted by a sweep that inspected the file it replaced.
- **Windows upload cleanup respects each daemon's retention policy.** Shared temporary roots now keep each daemon's attachments in its own subfolder, so a seven-day policy cannot delete another daemon's “Never” uploads, even with copied session UUIDs. Existing flat fallback files remain readable and are left untouched because their owner is unknown.
- **Credential copies and config `.env` files stay private without blocking independent uploads.** The file viewer and upload preflight/overwrite deny editor swaps and backups such as `.agent.db.swp`, `agent.db~`, `.models.yml.swp` and `models.yml-backup` only directly in omp's actual agent directories (including profiles). `.env` and `.env.*` are also denied at genuine default/profile config roots and agent directories, including their symlinked real targets. Same-named session uploads, workspace files and package assets remain readable and replaceable.
  These checks run on the file's owning host, including remote hosts. An upload batch containing a protected target is refused before any file in that batch is published, and publication rechecks each target before replacing it.
  Profile `.env` files stay private even when the profiles directory cannot be listed. If credential ownership metadata is unreadable, the file service returns 503 rather than guessing that an off-tree alias is safe; restore the daemon user's access to that metadata to resume ordinary file access. Uploads also refuse credential targets behind dangling, relative or chained configured symlinks, without creating the missing credential file.
  Ownership checks also retain native file identities when POSIX filenames cannot be decoded as UTF-8. On macOS, missing credential targets remain protected through filesystem case aliases, without creating calibration files.
  A failed lookup of the requested path stops that request, even if the filesystem recovers immediately afterward. It cannot fall through to a later successful read of credential bytes.
- **Table charts show every numeric column at once.** Columns that share a unit are drawn as grouped bars with a legend, instead of one column at a time behind a selector, and columns with different units each get their own chart in the same panel. Rows are labelled with the first descriptive column, so an index column such as `#` is no longer used as the label or charted. Values that start with `about`, `approx.`, `approximately`, `around` or `roughly` are read as estimates instead of making the column unchartable. The axis labels now line up with the bars, and the SVG export contains all of the charts.
  Charts remain readable on browsers without CSS subgrid. Tables with more than five same-unit measures are split into additional charts so no legend repeats a colour.
- **Finished background tool calls no longer show up as running.** A `bash` or `task` call that omp moved to the background kept reporting progress after it returned, and ompweb counted each report as a running tool. Opening the chat mid-run then listed those long-finished calls as empty running rows below the transcript until the next event, and an open chat could briefly show a finished call as running again. Calls that returned before an ompweb server restart can still show this once.
- **Background Sync retains permanent rejection states.** A rejected held message, including one from a changed installation scope, is saved as **Not sent** rather than left as **Sending**. It is not rebound to new credentials, and a late refusal cannot recreate an entry another sender already accepted.
- **Pending messages protect newer drafts and delivery intent.** A delayed storage acknowledgement does not clear newer input, even if an edit restores identical text. Same-time submissions keep durable enqueue order; duplicate browser IDs and unrelated successful HTTP responses cannot overwrite or acknowledge a held message. Delete confirmations distinguish removing tracking from cancelling work omp may already have received.
- **Outbox recovery remains live through storage and worker changes.** Storage initialization retries after transient failures, observers attach when an explicit command starts a ready session, and Background Sync verifies worker capability and durable transaction completion. Server-held capacity is bounded across sessions; overflow stays saved in the browser until capacity is available.
- **Slow browser links keep only the latest pending outbox snapshot.** Repeated held-message changes no longer fill the shared connection with redundant large snapshots. Native event ordering and the existing overflow recovery remain intact.
- **A transient browser-storage read failure no longer disables sending until every tab closes.** Later outbox operations reload the retained messages without restarting the worker, preserving their order and duplicate protection.
- **Completed attachments survive ordinary re-login.** The browser retains an upload-specific completion proof with its pending message, so renewed login cookies do not lose file ownership continuity. Accepted entries keep private per-upload authority across server restarts. Preparation stays bound to its original completion generation, so cancellation and ID reuse cannot substitute another file's bytes. Existing upload-owner, host/session and expiry checks remain intact.
- **Pending-message tracking preserves browser tools and dictated drafts.** An internal delivery observer no longer prevents another open app tab from handling a browser tool, and an earlier prompt's asynchronous failure cannot mark a successfully queued follow-up as “Not sent.” Automatically sent or queued dictation clears its submitted text after durable acceptance without clearing newer input, including an identical-text retype.
- **A completed or refused local command cannot hide a later missing response.** When an outbox attempt finishes without starting a turn, its saved-history boundary no longer leaks into the next turn's recovery checks.
- **Pending messages follow native ownership moves immediately.** The confirmed identity change durably retargets held and failed entries before another outbox action, retaining original-ID replay receipts across server restarts. Ordinary branches and session switches stay separate.
- **Deleting a held message cannot be undone by late preparation errors.** A refused or retryable startup result cannot revive the retired entry or send its emptied tombstone.
- **Offline remote chats remain discoverable after a web-server restart.** An empty host cache or failed session-list refresh no longer turns a valid remote chat into a permanent “Session not found” error just because the local daemon is online. Pending messages stay held and reach their owning host once it returns; confirmed missing sessions still fail normally.
- **An agent's `open_file` now opens `local://` files.** `open_file` with `local://note.md` (or `local://nested/name with spaces.md`) opens the file from that session's own `local://` directory in the file viewer, where it used to open a tab that failed with a 403. The URL is read as omp reads it, so a name with a percent such as `local://100%25.md` opens `100%.md`. The file is looked up for the session that asked, even when you are viewing another one, and is read, downloaded (from the file panel's header button too) and live-watched like any other file; a path swapped for a link out of the directory after the file was opened reports nothing of the other file. A file that does not exist, a directory, a URL that leaves the directory (`..`, an absolute path, a symlink out) and one that names a session that does not exist are refused with a message to the agent instead of opening an empty tab, and a lookup the server never answers ends the call with an error after 30 s instead of leaving the agent waiting. A session on a linked host works the same way: that host's daemon resolves and confines the path on its own machine. A host daemon that predates this lookup answers "update or restart the ompweb host daemon" instead of opening an empty tab.
- **Opening a `local://` link refuses omp's own secret files before creating a tab.** The lookup uses the same credential policy as the file viewer, including symlinked agent directories and credential files, so the agent receives an access error instead of a successful “Opened” result followed by a failed tab. Unrelated session artifacts with credential-like names still open.
- **Session-local tabs keep reading the owning artifact.** A workspace file mirroring the artifact's absolute pathname no longer shadows it, and a completed symlink replacement outside the session's local directory is refused even when a broader agent-directory root is browsable.
- **Delayed artifact lookups respect the current conversation.** A file request that finishes after its chat was left no longer opens over the new view; cross-session requests ask for confirmation, including while Settings is open. A live session addressed through an old ID uses its current temporary artifact root on Windows.
  Canceling an outstanding file request aborts its lookup and prevents a late tab or confirmation from appearing. Cancellation stays scoped to that request and its original session, including after a confirmed session-ID move.
- **Removing an upload while offline still deletes it from the host.** A file you remove (or a finished upload you discard) is now deleted from the host's staging area once the browser, the server and the host can reach each other again, even if the browser connection dropped or the host was offline when you removed it. As a backstop, a running host now deletes staged files older than a day every hour, not only when it starts or receives a new upload, which also covers a removal that ompweb lost because it restarted while the host was offline.
- **Sent-upload retention reaches hosts already linked at server startup and retries live-link failures.** An attachment whose timestamp cannot be updated is copied so it does not expire before its selected retention period; unreadable cleanup folders are reported in host logs.
- **`!` commands you run have their own look.** A shell command you ran with `!` now shows as a terminal-style card with a `$ command` prompt line, instead of the same row as the agent's tool calls. A failed run shows its exit code (`exit 1`) or `cancelled`, and a `!!` run is tagged `local`. Click the card to show its output. Long pending commands wrap even on narrow screens, switching to a different run resets its expansion, and screen readers can identify successful runs.
- **The Explorer shows every file, including build output and `.git`, with no switch.** `node_modules`, `.git`, `dist`, `build`, `target`, caches and `.pyc` files are no longer hidden by name. A folder's contents load only when you expand it. This replaces the **Show hidden items** switch from #378, including its toolbar button and saved preference. Symlinks show their raw target (`name → ../target`); an outside-root or dangling link stays visible but cannot be opened or expanded from the tree.
  File search and `@` mentions follow `.gitignore` in a Git repository. Outside Git, or when Git is missing or fails, the bounded fallback includes regular files without name exclusions, including ignored files, but skips symlink entries to both files and directories.
- **File search stays bounded and leaves the host responsive.** The non-Git fallback reads directories asynchronously instead of blocking other daemon requests for the whole scan. It still queues and reads at most 50,000 directories and reports truncated results at its limits. Blocked symlink tooltips explain both outside-workspace and missing targets in every language.
- **Explorer confinement upgrades without changing older daemon contracts.** The original boolean `listFiles` operation remains available to older web servers. The Explorer uses the separately advertised `listFilesInRoot` capability; a daemon without it returns an explicit upgrade-required response rather than an unconfined listing.
- **Reconnecting uploads no longer leave Send blocked by a hanging retry.** The five-minute deadline stops an in-flight retry as well as its back-off, keeping staged bytes for Retry. A connection lost midway through an HTTP response resumes automatically, and tooltips identify network failures instead of showing only “Upload failed”.
- **Files named `agent.db` or `models.yml` open again unless they are omp's own.** The file viewer refused those names anywhere under `~/.omp`, so an uploaded `agent.db` could not be opened from its link. It now refuses only the files omp keeps in its agent directory (and a profile's), with their SQLite sidecars, backups and `models.yaml`/`models.json`. Both symlinked agent directories and individually symlinked credential files keep their real targets protected, including targets with different names; unrelated uploaded copies still open.
  Hard-linked aliases of those owned secrets are denied too, by comparing device and inode identity. Independent copies still open, even with identical contents, and upload preflight and overwrite cannot modify a credential through an alias.
  On Windows, alternate data streams attached to protected files are denied too, including aliases and attempts to create a new stream. Independent streams remain available, and literal colon-named files on POSIX keep their ordinary meaning.
- **Uploads no longer leave submitted messages or restored pages stuck.** A slow attachment copy keeps its session alive even after you switch chats. Commands that change Advisor wait until that preparation is dispatched before they may replace the session's child. Returning through browser Back/Forward shows Retry for an interrupted upload instead of leaving Send permanently blocked.
- **Attachment retries no longer accept missing files or stale upload errors.** An attachment removed or replaced by a directory is reported as missing before it is marked complete. Failed receipt writes leave the staged file available to retry without creating a duplicate, and cancellation cannot be undone by an attachment still finishing. Replies from earlier upload attempts no longer fail a newer Retry. Retrying also waits for failed-write cleanup, so an old attempt cannot delete the new attempt's staged files.
- **A conflicting upload start no longer interrupts the original file.** Reusing an upload ID with another filename or MIME type is rejected before changing the active transfer, so the original upload continues normally.
- **PDFs stay file attachments when the browser omits their MIME type.** Filenames ending in `.pdf` (any case) no longer have their raw contents inserted into the prompt as text.
- **A `!` shell command sent during a run now runs, as in omp's terminal.** It was queued as a plain message for the model instead. It now runs right away beside the turn, and its output shows below the conversation until omp adds it to the history, which omp does when a later prompt starts. A steer sent while such a command runs still steers the turn, and Stop stops the turn first, as Esc does in the terminal. Python (`$`) commands still run only in omp's terminal: omp's RPC mode has no command for them yet.
- **A message sent just before switching chats is no longer held back.** When the session had to start omp first (it had been idle long enough for its process to stop), switching to another chat during that startup cancelled the send and put the text back in the composer. The message is now sent, as it already was for a new chat.
- **Sending a command detects a silently broken browser connection sooner.** Queued messages and steers initially reconnect after 5–6 seconds without delivery-acknowledgement progress, rather than waiting for the 30-second silence check. This also detects a dead uplink while replies still stream down. Recovery uses the existing ordered replay and deduplication; slow command results do not trigger retries. Repeated delivery stalls increase the deadline up to 30 seconds for slow links. Server restarts and expired replay windows retain the existing explicit "may have run" error rather than risking duplicate actions.
- **An open chat now picks up a run that started after it loaded.** When a run started from another tab or device, or from the same chat opened again while its message was still starting omp, the sidebar showed the session running but the chat stayed idle until a reload. The chat now attaches to the run as soon as the sidebar shows it.
  Running updates received during a state check are retained, and compaction controls immediately reflect the attached run. Compaction started in another tab also releases its controls when it finishes while you are reading a historical branch, without replacing that branch. A late state check cannot take over a command this chat has started or bring back a shell command that has finished or been stopped. The chat waits for its first load before attaching, so the branch navigator never comes up empty, and it attaches once its own send, `!` command, Edit or compaction is done if a run started meanwhile; a failed check is retried. A compaction you start keeps its Stop control until it ends, even when the session's omp is still starting.
- **A finished compaction no longer reports "The agent stopped without returning a response".** When a chat caught up with a session that was only compacting (started from another tab, or while the chat was reconnecting), it treated the compaction as a prompt run, showed it as running, and reported an empty reply once the compaction ended. A compaction now shows only its own Stop compaction control; a compaction during a run still keeps that run going.
- **The dictation waveform no longer stays flat while you speak.** The meter's audio context was created only after the microphone opened; when that took longer than the click's activation window, the browser kept the context suspended and the bars showed silence even though the recording and transcription were fine. The context now starts inside the click.
- **Streaming replies use about a sixth of the bandwidth.** ompweb now asks omp (18.13.2 or later) for only what changed in a streaming reply instead of the whole reply several times a second, and the browser rebuilds the reply itself. In one measured reply the live stream fell from 232 KB to 91 KB, and the reply updates themselves from 178 KB to 30 KB, so replies keep up on slow mobile links. A tab opened mid-reply, a reconnect and a restarted server still show the whole reply. An older omp keeps sending whole replies and works as before.
- **The host link is now one WebSocket**, with fewer requests and large results sent in the same connection. A reverse proxy in front of ompweb must forward WebSocket upgrades on `/api/hosts/link` (see the README's hosts section). Update ompweb on the server first, then on its hosts: a host linked with an earlier build of this release shows **needs upgrade** until it is updated.
- **The browser connection is now one WebSocket that survives drops.** Settings → Interface & Behavior → **Browser connection** now defaults to the **WebSocket link**: one connection per browser that carries live updates and chat commands with the same delivery as the host link. A large event no longer delays a command's answer, a slow answer never resets the connection, and after a short drop (up to 2 minutes) the connection picks up exactly where it stopped, without reloading the chat (if more than 32 MiB of updates piled up meanwhile, it reloads the chat instead). Longer outages and server restarts reload as before; a command that cannot be confirmed still says it may have run. The proxy must forward WebSocket upgrades on `/api/events/link`; a browser whose proxy refuses the upgrade falls back to server-sent events on its own. To use server-sent events + HTTP all the time, switch the setting back to it in Settings. The earlier experimental WebSocket choices are gone and read as the default.
- **ompweb now runs on Bun instead of Next.js.** The npm package brings its own Bun, so installs and updates work as before, with no change to URLs, ports, settings or the password gate. `OMP_WEB_DEV_ORIGIN` is removed: it only configured the Next development server. `npm run build` no longer interferes with `npm run dev`. The skills.sh search now gives up after 10 s and falls back to the `skills find` CLI instead of waiting on a stalled skills.sh.
  - **If you start ompweb from a terminal (`ompweb` or `npx`), start it again once after the in-app update to this version.** The launcher that is already running applies the update and then tries to restart the server with Next, which the update removed, so the server does not come back. systemd, launchd and the tray start the new launcher and are not affected.
  - Browsers older than Safari 16.2 or Chrome 111 lose the colours ompweb mixes with `color-mix()` (tints, borders and focus rings), which no longer carry a solid fallback. Those browsers were outside the Next.js build's targets too.
- **The service installers set up the host daemon too.** `ompweb systemd install`, `ompweb-launchd install` and the Windows tray install now register `ompweb host` as a second unit (`ompweb-host`) next to the web service, restarting it after a 10 s delay so it can wait for the web server to write its host link on first install. `uninstall` and `status` cover both, and the tray menus show the daemon state.
- **Forking a session or editing a message asks first.** The Fork button under a message and the Edit button under your own message now open a confirmation dialog, so a stray tap while scrolling no longer creates a new session or rewinds the current one.
- **Expanded thinking blocks no longer collapse when a step finishes.** With "Expand thinking blocks by default" on, a thinking block opened while streaming, then moved into a closed Process details row as soon as the step committed. Thinking now stays out of the fold while the setting is on.
- **In-app updates work when ompweb runs as a systemd service.** The update worker ran inside the service's cgroup, so stopping the server killed the worker too: nothing was installed, the service could stay down (`Restart=on-failure` does not restart a clean SIGTERM exit), and every page load reopened the update dialog at "Stop ompweb-managed sessions". The worker now runs in its own transient scope (`systemd-run --scope`) and stops, updates and starts the unit through `systemctl`, starting it again if the install fails.
- **An update whose worker died is reported as failed.** A running update whose worker process is gone, or whose lease has expired, now becomes a failed attempt the dialog can show and clean up, instead of waiting forever.
- **Upgrade ompweb before its hosts.** The web server links a host daemon one link protocol version older than its own, so a host keeps running sessions until its `ompweb` is updated. After a web restart the server adopts that daemon's live runs, as it does a current daemon's, without resuming them; only a large message from such a host still arrives whole instead of in pieces, which can stall that host's link on a slow connection. A daemon older than that, or newer than the web server, is still asked to upgrade.
- **The Provider Usage header stays put while its list scrolls.** Scrolling a long provider list in the sidebar also scrolled the section header (title, window toggle, refresh) out of view, on desktop and mobile. Only the list scrolls now.
- **Android system bars match the theme's top bar.** The browser theme color, which tints the Android status bar, now uses the top bar's color instead of the page background, so a light theme no longer shows a white status bar above a tinted top bar. An installed app also reports the current theme's color in its manifest, as both its theme and background color, which Chrome uses for the navigation bar (Chrome 153 and later). Chrome applies it only when it next checks the installed app for manifest updates, so after a theme change the navigation bar can keep the previous theme's color for a while; tap **Request update** for the app in `chrome://webapks` to apply it sooner.
- **No shadow smudge at the top-left of light themes.** The hidden "skip to content" link sat just above the screen, and its drop shadow showed through onto the top bar. The shadow now appears only while the link is shown.
- **On Android, omp-web draws behind the navigation bar instead of leaving it black.** The phone sidebar and file panel were anchored to the bottom of the screen and padded with the bottom safe-area inset, which Chrome treats as a reason not to draw edge to edge, so it painted the navigation bar itself (black in the installed app, and flashing while the sidebar opened). The panels are now sized by height instead, so the page's background shows under the navigation bar.
- **No more blank space above the composer in long chats.** In a chat with many messages, the position rail on the right could be taller than the message area. That happened most once Tasks or Subagents were expanded above the composer. The rail then pushed the messages up and left an empty band above the composer, which grew with each panel opened. The rail now fits the message area and scrolls instead, keeping its active marker visible when panels expand or collapse.
- **No blank band above the composer on phones either.** Scrolling to the newest message could also shift the message area itself up, leaving an empty band above the composer until the page was reloaded. Scrolling can no longer shift the message area (Safari 16 and later; older Safari keeps the old behavior).
- **Sending to a session another omp process has open no longer leaves a dead fork.** When omp moved the resumed session to a new file during startup, the tab kept the old id, the event stream failed with "Failed to connect to the agent event stream", the prompt never went, and the forked session was reaped two minutes later. The requested id now stays routable alongside the new one.
- **Changing Advisor keeps a moved session on the right conversation.** A tab still using the pre-move session ID now restarts the current session file on its owning host when toggling Advisor, instead of reopening the original file, selecting another host’s copy, or returning “Session not found” if the original was removed.

---

## [v0.6.0] - 2026-10-26

### Added

- **Numeric tables become accessible charts.** A completed assistant reply containing a numeric table also renders it as a chart (bar, line or scatter, chosen from the data) with the original table kept below, and the chart can be exported as SVG. Charts only appear in completed replies, never while streaming.
- **Project MCP servers can be switched on and off from Settings, and a session can be reloaded.** Toggling a server writes the project MCP config and, for an idle session, respawns it so the change takes effect; a running session refuses the reload instead of interrupting work. The config editor also supports the standard omp config locations and server types (stdio, http, sse).
- **Agent-callable server-side tools, off by default.** With the setting enabled, an agent can list sessions, start a new session, and send a message to another session through omp-web's own tools, with per-source rate limits and a chain-depth cap so agents cannot loop through each other.
- **Toggle the provider usage widget between 5H and 7D.** The usage chip cycles Auto → 5H → 7D → Auto, and the choice is remembered in the browser.
- New sessions get a title on their own. omp does not name sessions in RPC mode ([can1357/oh-my-pi#14616](https://github.com/can1357/oh-my-pi/issues/14616)), so they stayed untitled until **Generate title** was clicked. After a reply finishes, omp-web now asks omp's title generator to name an untitled session, the way omp's terminal UI does. omp skips a bare greeting, so a later reply in the same session tries again, up to three times. The request runs in the background: the chat shows no run and none of `/rename`'s output, and a title you set yourself is never replaced.

### Fixes & Improvements

- **Model switches survive a cold start.** Switching models on a session whose omp process had stopped used to fail with HTTP 500, because the resume spawn carried no model and omp exited before the switch RPC ran. The spawn now carries the requested model, and the switch is verified against the session state, falling back to the spawn-bound model when the RPC reports a spurious "Model not found". (#277)
- **The chat minimap tooltip stays aligned while the rail scrolls.** Tooltip rows no longer drift or clip when the minimap is scrolled or dragged; the tooltip position and the drag mapping follow the rail's actual layout. (#251)
- **Usage buckets are labelled correctly.** The Anthropic Fable bucket is labelled as such, and Antigravity's second bucket is shown instead of being hidden. (#284)
- **The Linux tray no longer drags in `dbus-next` at install time.** The dependency is loaded on demand only when the tray runs, removing 99 packages from the install; without it, the tray command exits with an install hint. (#268)
- **Transient composer live status merges into the tasks header row.** The standalone live-status bar is kept only as a fallback, so the composer area stays quieter while the agent works. (#245)
- **Active sessions survive status delays and pending prompts.** A session no longer drops out of the active list while its status is delayed or a prompt is still pending. (#263)
- **Performance work:** usage sync batching, subagent header caching and ANSI panel trimming (#287); streaming git attribute parsing and a faster file-index walk (#286); a fast path for math-free Markdown, cached file-fuzzy metadata and deduplicated session stats (#283); reused edit-distance buffers and a bounded content-search cache (#282).
- **Notification pushes lost to network errors are retried**, and the cause is logged instead of silently dropped. (#280)
- **The composer's primary button follows the Steer setting**, so it offers Steer when steering is the configured behavior during a run. (#281)
- **Many concurrent omp-web tabs work.** The live event stream is multiplexed through one shared worker per browser instead of one SSE connection per stream, so the browser's per-host connection limit no longer freezes tabs. (#257)
- **Transcribe with omp's own speech-to-text models**, including a ChatGPT/Codex subscription, without a separate STT server or API key: set `OMP_WEB_STT_MODEL` and leave `OMP_WEB_STT_ENDPOINT` unset. (#249)
- **Mid-prompt skill autocomplete** in the composer, with skill session auto-naming fixed alongside it. (#260)
- **Same-session message editing — Draft, pending final gates and maintainer CI/review.** Edit moves omp's live history to before the selected message and prefills its text for editing and resending. Ordinary single-owner Edit keeps the session ID/file; native ownership conflicts may legitimately move the conversation to a sibling ID/file. The server follows native persistence notices and registry aliases; the browser adopts the HTTP-confirmed identity without remounting the composer. Old continuations remain historical branches rather than new model context. Edit requires full session settlement, including background deliveries; older runtimes without that signal refuse editing. Installed input hooks must pass the private edit command through unchanged; no new upstream API is required. Correlated results, not bare native acknowledgements, confirm completion; observed persistence errors fail Edit without releasing its fence before handler completion or awaited process teardown. Pending edits preserve drafts, newer typing and attachments, leave recording controls usable, and ignore delayed edit echoes that would reset a newer view or turn. Identity moves transfer exact-source drafts without consuming another cache slot; text survives full reload through sessionStorage, while attachments remain memory-only. Pending transcription retains its original job/scope and a tab-local move association; ambiguous unacknowledged uploads remain recoverable rather than being guessed or reuploaded. Rejected sends restore outgoing content to the originating conversation, following new-session promotion without touching another chat; superseded failures do not reinsert processed turns. Renaming, including automatic-title fallbacks, respects the edit lock. Connection replacement/unmount owns readiness cancellation and StrictMode-safe cleanup. Isolated native checks cover relocation, observed write errors and reopening; separate actual AppShell checks use controlled HTTP and are not production native/browser end-to-end proof. Fork and read-only historical browsing remain separate; Edit does not undo filesystem/tool side effects, restore original-message images or promise stronger fsync durability. (#276)
- Fix test fixtures on macOS and paths containing spaces: report the actual tray platform, launch the transcription gateway stub with the exact quoted Node executable, and separate deterministic known-path cache invalidation from native filesystem-watch delivery without weakening authorization or content assertions.
- Fold tool activity while the agent works, the same way a finished turn folds it: the transcript shows one **Process details** row per turn instead of a row per tool call, and expanding it shows every call as it streamed. Assistant replies keep streaming in view, and the composer keeps naming the running tool. Turn off **Hide tool activity while working** in Settings → Interface & Behavior for the previous row-per-call view.
- **On desktop, notifications open from a bell in the top bar**, left of the right-panel toggle. The bell shows the unread count and opens a floating panel with the notification history, **Mark all as read** and **Clear**; the list scrolls inside a panel of limited width and height. Opening a notification closes the panel, and closing it marks the shown notifications as read. The right panel's Notifications tab and the right-panel toggle's unread count remain on phones only.
- On phones and narrow windows, the top bar's tools menu is only as wide as its buttons instead of spanning the screen, and its **System** button opens the system prompt again. The prompt panel used to open inside the menu's sideways-scrolling strip, which clipped it out of view.
- **Search looks inside sessions and ranks by relevance.** The workspace search now also matches the text of your messages and the assistant's replies, not only titles. Each word is matched on its own, in any order and with small typos tolerated; results matching your word order, and matches in titles, rank first. Put text in "quotes" to require that exact phrase. Title matches show at once; transcript matches stream in while a spinner shows the search is running, and **Stop** ends it, keeping the results found so far.

### Sidebar

- **Recently completed sessions stay in the running filter.** A session that just finished no longer vanishes from the running filter at once; it remains visible as recently completed. (#267)
- **Sort and pin workspaces.** A sort button next to the workspace search switches between None (your manual order), Alphabetical and Last updated (the workspace whose session got the newest message first). While a sort is active, each workspace has a pin button: pinned workspaces stay at the top in the order you give them with Move up, Move down or dragging, and newly pinned ones join the end of that group. Unpinned workspaces follow the sort and cannot be moved by hand. The sort is remembered per browser; pins are stored with the workspace list. (#271)

---

## [v0.5.2] - 2026-10-15

### Breaking changes

- **omp-web now requires Node.js 24 or newer** (the current LTS). `ompweb` and its service and tray commands (`ompweb-systemd`, `ompweb-launchd`, `ompweb-tray`, `ompweb-tray-linux`) refuse older versions before doing anything.
- **A plaintext web password no longer reaches the server.** `ompweb --password` now stops the launcher at startup, and the server refuses every request while a plaintext password is in its environment. Every `omp` session inherits omp-web's environment, so an agent running `env` could print the password into its session file and send it to the model provider. Replace it with `OMP_WEB_PASSWORD_HASH`: run `ompweb hash-password` (it reads the password from stdin, so it stays out of shell history and `ps`) and pass the printed `scrypt$…` value. As a migration step, `ompweb` still accepts `OMP_WEB_PASSWORD`: it hashes the password at startup, keeps it out of the server's environment, and logs a warning with the hash to set as `OMP_WEB_PASSWORD_HASH`. Switch soon: agents can still read the plaintext from the `ompweb` launcher process, and each start makes a new hash, so every restart signs all browsers out. Setting both variables stops the launcher. The service installers hash an `OMP_WEB_PASSWORD` given at install time, so `OMP_WEB_PASSWORD='…' ompweb-systemd install` still works and now stores only the hash; the Linux tray's **Set Web Password…** does the same. Existing session cookies are invalidated.

### Added

- **The Notifications tab keeps its list across reloads, restarts and devices.** omp-web now records the notifications you turned on (task finished, waiting for input, run failed, model switched) on the server, including ones sent while no tab was open, and every browser shows the same list and read state. A notification for the session you are looking at is listed as already read. Entries appear in the language of the browser showing them. Notification settings, push subscriptions and keys move into a SQLite store in omp-web's data directory, using the SQLite module built into Node.js 24; the first start imports them from the old `notifications.json`, so existing push subscriptions keep working.
- Transcribe voice input with a model omp already has credentials for, such as your ChatGPT subscription: leave `OMP_WEB_STT_ENDPOINT` unset and set `OMP_WEB_STT_MODEL` to an omp speech-to-text model, for example `openai-codex/codex-transcribe`. omp-web runs it through `omp auth-gateway stdio`, so no API key or separate STT server is needed. Recordings are limited to 18MB on this path. Requires an omp release with that model ([can1357/oh-my-pi#15391](https://github.com/can1357/oh-my-pi/pull/15391)).
- **Expand thinking blocks by default**, an off-by-default switch next to **Keep tool calls collapsed** in Settings → Interface & Behavior. Turn it on to read the model's reasoning without expanding every block; each block still collapses and expands by hand, and the choice applies to a block that is still streaming as well. Tool-call collapsing is unchanged.
- List every account omp stores for a subscription provider in Settings → API Keys & Providers and disconnect a single account with its **Disconnect** button; the other accounts stay connected and omp keeps choosing and rotating between them. The sign-in button of a connected provider now reads **Add account**: signing in with another account adds it, and signing in with a connected account refreshes it. Requires omp 18.7.0 or later ([can1357/oh-my-pi#14588](https://github.com/can1357/oh-my-pi/pull/14588)); older omp keeps the read-only account list from `omp usage` and explains how to disconnect from a terminal.
- Add **Settings → Notifications**: desktop and mobile notifications for a finished task (after the prompt and any background work it started are done; subagents never notify), a question or approval waiting for you, a run that failed after retries and fallbacks, and a model switch omp made on its own (for example Fable falling back to Opus after a refusal, or a usage-limit fallback). Each browser chooses its own events and whether to show an in-app toast or a system notification while you use omp-web in another tab. Nothing is shown for the session you are viewing, and clicking a notification opens its session; an in-app toast opens it from a click or tap anywhere on it, or Enter when it has keyboard focus. Over HTTPS (or on `localhost`) notifications arrive through Web Push even with no omp-web tab open, including the iPhone/iPad app added to the Home Screen; the push keys and device list live in `~/.omp/agent/omp-web/notifications.json`. Notifications are off until you turn them on. This replaces the previous completion notification for the open session, and the agent's `notify` tool now also works on Android.
- Skip the web password for clients your reverse proxy trusts: the proxy sends a secret in `X-Omp-Web-Auth` only for trusted address ranges, and omp-web holds only the secret's SHA-256 digest in `OMP_WEB_TRUSTED_HEADER_SHA256`. Other clients still sign in with the password. The README shows how to generate the secret without it reaching shell history, and an nginx setup, including how to trust the real client address behind Cloudflare, Cloudflare Tunnel or another proxy, and how to guard against DNS rebinding. The service installers preserve the setting, and the digest never reaches child processes.
- Choose **Classifier** or **Vendor default** in Settings → AI Model Defaults → **Auto Thinking Source** when Reasoning is `auto`. The choice is saved in omp's native config for newly started or restarted agents. Vendor mode prefers the publisher's effort, then omp's per-model default, then normal Auto fallback. Requires an omp release containing [can1357/oh-my-pi#14114](https://github.com/can1357/oh-my-pi/pull/14114).
- Show conflicting skill names and deduplicated installations when an OMP session starts, with resolution details, a **×** button that dismisses the notice for the session until the diagnostic report changes, and a persisted **Turn off** action that disables startup notices. Inspect a running session manually in **Settings → Extensions & Tools → Skills**, even when notices are off; inspection never resumes a stopped session. Requires an OMP runtime with the skill-diagnostics RPC commands; older runtimes report live diagnostics as unavailable.
- Ask a side question with `/btw <question>`: omp answers from the current conversation in a panel above the composer, even while the agent is working, and the question never enters the chat. Cancel a running answer, copy it, or ask follow-ups in the same topic. `/btw` on its own lists the session's past side questions, including ones asked in the terminal, each expandable to all its turns with **Copy** and **Follow up**. Side questions are text-only: with an attachment in the composer, `/btw` is refused and the draft is kept. An answer that omp lost (for example after its process restarted) shows as **Interrupted** instead of spinning. Requires an omp with the `btw` RPC commands; older omp shows "/btw requires a newer omp" instead of sending the text to the model.
- Show omp's Claude usage-limit badge in the composer toolbar, matching the terminal status line during the wrap-up allowance or once `/slow` low priority takes over. Reset times use the browser's locale and timezone. Requires an omp version whose `get_state` reports structured `usageLimit` state.
- Add a **Slow** toggle next to **Fast** in the composer toolbar, the equivalent of omp's `/slow`. On Claude models it turns low priority on or off in your omp settings, so it applies to every session and terminal; on OpenAI and Google models it switches this session to the provider's flex tier. Once the session's omp process runs, the toggle follows omp's `get_state` (`slowModeSupported`); before that, including in a new session, it follows the selected model's provider (`anthropic`, `openai`, `openai-codex`, `google`, `google-vertex`) and, on Claude, the `providers.anthropic.slowMode` setting. Clicking it there starts the session's omp process.
- Show the composer's reasoning level with TUI-style icons, alongside its name on desktop and without the name on narrow toolbars. The menu pairs each icon with its level name. Icons use consistent, vertically centered shapes rather than font-dependent Unicode glyphs, with larger mobile controls, smaller desktop controls, and support for high-contrast colors. Keep the model icon visible on phones and reduce unused space between the model and reasoning controls without wrapping the standard toolbar controls. Provider-defined levels retain their names with normal truncation.
- Keep the reasoning menu in one column on phones as well as desktop, with one full-width level per row instead of side-by-side chips.
- Add **Paste image** to the composer's **+** menu, with Japanese and Simplified Chinese translations. Requires HTTPS (or localhost), browser support for clipboard image reads, and clipboard permission; the item is hidden where the browser cannot read images from the clipboard. Attaching a file remains available.
- Name web app installations, iOS home-screen titles, and browser tabs after the server's hostname (without port), so multiple servers can be told apart. Localhost and IP addresses keep the generic `omp web` name; named LAN hosts are preserved. Tabs show `workspace - installation name`. Existing installations may need to be re-added to pick up the new name.
- Name web app installations, iOS home-screen titles and browser tabs with `OMP_WEB_NAME`, so multiple servers can be told apart. Unset or blank keeps `omp web`; `url`, `host` or `domain` (any case) uses the hostname the browser connected to, without port, keeping `omp web` for localhost and IP addresses; any other value is used as-is. The service installers preserve the setting. Tabs show `workspace - name`. Existing installations may need to be re-added to pick up a new name.
- Create a workspace by cloning a Git repository: in the **Add workspace** dialog, enter an `https://` or ssh URL and choose **Clone here** to clone into a new folder under the selected directory, which then becomes the active workspace. Clone progress streams into the dialog; **Cancel clone** stops git and deletes the partial clone. git never prompts, so private repositories need a credential helper or ssh agent.
- Add a manual refresh button to the sidebar's Provider Usage panel, with the same success feedback as workspace refresh. Manual refresh bypasses omp-web's usage cache and invalidates omp's cached reports before fetching fresh limits; automatic five-minute refresh remains unchanged. Manual refresh requires an omp that supports `usage invalidate`; an unsupported or failed refresh shows as unavailable instead of reporting success.
- Add an off-by-default **Resume running sessions after a restart** setting in Settings → System & Updates. When omp-web restarts while agents are working, it restarts those sessions and prompts each with "Session interrupted and resumed. Continue as you would have done without the interruption." Work in progress at the moment of the restart, such as a running command, is lost. Do not also resume those sessions from a terminal while omp-web is down.
- Add **Copy** and **Markdown** below user messages and completed assistant replies, with keyboard access and touch-sized controls. Copy only message text, excluding thinking, tool output, and renderer controls; preserve full source for oversized raw-text messages. Shorten message actions to **Fork** and **Read** to leave more room on mobile; the speech tooltip and accessible label remain **Read aloud**.
- Scope Ctrl+A / Cmd+A to the selected message, currently loaded chat, or active file contents instead of the whole page. Message selection includes collapsed extension previews and expanded details without toolbar labels. Newer pane focus takes precedence over retained child selections. Text fields and IME composition retain native behavior; browser-menu commands and embedded viewers remain browser-controlled.
- Add an off-by-default **Scope native Select All (experimental)** switch in Settings → Interface & Behavior. The per-browser preference narrows whole-page selections from native menus while leaving keyboard scoping independent. Disable it if browser selection handles or menus behave unexpectedly; intentional whole-page selections can also be narrowed.
- Add a **Notifications** tab, first in the right panel before Explorer and Git, listing the last 100 toasts and system notifications (task completions, agent `notify` messages). Entries keep their action buttons and can be dismissed one by one or all at once. While notifications are unread, the panel toggle shows their count and opens straight to the tab; entries become read when you leave it or choose **Mark all as read**. Toasts now stay on screen for 6 seconds, and errors for 10 seconds. On touch screens, swipe a toast or a Notifications entry left or right to dismiss it, as on Android; the swipe can start anywhere on it except its buttons, and it never also moves a sidebar. Changed your mind mid-swipe? Drag it back toward the centre before letting go and it stays. A mostly vertical drag still scrolls the list. A mouse drag now selects text instead of dismissing a toast, and toasts no longer dismiss with a downward swipe. The mobile sidebar swipes also keep working while a toast is on screen.
- Play back a voice recording before transcribing or sending it. Pause keeps a left-side preview control; Stop opens a review deck with play, discard, and transcribe-and-send.
- Link GitHub issue and pull-request references in chat messages. Bare `#123` links to the session checkout's GitHub repository (the `gh` default remote, else `upstream`, `github`, then `origin`); `owner/repo#123` links to that repository. Code spans and existing links are left unchanged.
- Show all of an agent's ask-tool questions in one panel, with checkboxes for multi-select, radio buttons for single-select (recommended option marked and preselected), and an **Other** option per question whose text box is the option itself, submitted together. Typing in it chooses **Other**; choosing another option keeps the text in place, and choosing **Other** again uses it. While the questions are open the message box is hidden, so it is clear the answer goes in the panel; **Cancel** brings the message box back with your draft untouched. Requires an omp that supports `set_ask_dialog`; older omp keeps the one-question-at-a-time dialog.
- Make `agent://<id>` subagent handles in chat messages clickable. Bare handles, inline code containing only a handle, and Markdown links open that subagent's result dialog; `agent://Parent/Child` opens the nested `Parent.Child` subagent when the roster knows it. A `read` of an `agent://` handle opens the same dialog from its tool row.
- Show the full model name, including its provider (for example `anthropic/claude-sonnet-5-5`), and the reasoning effort in the subagent result dialog, for running subagents and for finished ones after a reload. Finished background subagents take them from their saved transcript, so they also appear in the composer's subagent chips.
- Attach images and text files while the agent is running, and send them with a steer or a queued follow-up. Attaching through **+**, paste, or drag and drop now works during a run; with only attachments in the composer, **Stop** becomes **Queue**. An image-only message shows as `[Image]` in the queue. A steer or follow-up that omp refuses returns to the composer with its images, and so does a queued message taken back by **Edit** or **Stop**. Getting images back from **Edit** and **Stop** requires an omp with `abort_and_restore_queue` and image-returning `remove_queued_message` ([can1357/oh-my-pi#14179](https://github.com/can1357/oh-my-pi/pull/14179)); older omp returns only the text.
- Open file paths that chat messages write as inline code in the file panel, so a screenshot path such as `` `/var/tmp/shot.webp` `` shows in the image viewer. Absolute paths with at least two segments, `~/` home paths, Windows drive paths, and workspace-relative paths with a directory and file extension link; a `:line[:col]` suffix is dropped when opening. Other code, scheme handles (`history://`, `agent://`, `https://`) and fenced code blocks stay unchanged. Files outside the workspace open when the session mentions them, now including `~/` mentions; bare paths in prose are not linked.
- Show omp's passive tool context as one dim `↳ Context: …` line on the last tool card of the tool batch it follows, matching omp's terminal, instead of a separate developer-message row. Hover the line for the full text; expanding the card shows the full text as its own section below the output. ANSI codes and control characters are removed and the text is collapsed to one line. Context that follows a non-tool message is not shown, so it never lands on an earlier, unrelated card. In a batch of several tool calls the line sits on the last call's tool row. Copy as Markdown and transcript exports leave it out. Requires an omp release containing [can1357/oh-my-pi#13269](https://github.com/can1357/oh-my-pi/pull/13269); with older omp, passive context still shows as a developer-message row.

### Fixes & Improvements

- On a phone, the first tap on an option, **Submit** or **Cancel** in a question panel now acts on it. It used to only close the keyboard or resize the panel, which moved the target out from under the tap. The message box's keyboard now closes as soon as the question appears (the message box is hidden then anyway), the panel no longer resizes when an option or button takes focus, and while you type in **Other** a touch or pen tap elsewhere in the panel no longer moves focus first. Choosing an option then closes the keyboard; tapping back into the kept **Other** text chooses it again. **Submit** closes the keyboard at once instead of after the server confirms the answer, and collapsing the keyboard while typing in **Other** no longer makes the next tap raise it again for a moment. A mouse, including one on a touchscreen laptop, keeps its usual behavior.
- On a phone, opening the keyboard at the end of a conversation no longer hides the newest messages under it: the chat stays scrolled to the bottom. The same holds when the message box or a question panel grows. A conversation you scrolled up in stays where it is.
- When the agent finishes a reply, the chat no longer jumps up to the start of the reply and back down. The finished reply used to disappear for a moment until its saved copy was loaded; it now stays on screen and the saved copy replaces it in place.
- **Passive tool context shows its wrapper.** Context wrapped in a tag such as `<system-reminder source="graphify">` now names the tag and every attribute on the tool card's `↳ Context (system-reminder · source=graphify): …` line. Expanding the card shows the context as a small nested card with that header and the body below, like developer reminders. Before, the tag name and attribute keys were dropped, so a graphify nudge looked like unlabelled text.
- `ompweb hash-password` in a terminal finishes when you press Enter. The hidden prompt waited for a newline, but a terminal in raw mode sends Enter as a carriage return, so the prompt never ended.
- The Notifications tab now tells unread notifications from read ones: an unread notification has an accent dot before it and a bold title on a tinted row, and read notifications are dimmed. The tab also lists only the notifications that can also be pushed (task finished, input needed, error, model switch). Confirmations such as "Saved", copy results, update notices and agent `notify` calls still show as toasts but no longer fill the tab. A session's next notification of the same type is unread again instead of inheriting the earlier one's read state.
- Fit the agent's question panel on a phone. A long question, header or option preview no longer widens the panel past the screen and clips the answer text at the right edge, and previews wrap instead of scrolling sideways.
- A question that arrives while you are composing on a touch device no longer pulls focus into its answer box, which raised the on-screen keyboard and scrolled the unread question away. The panel waits for a tap; on a desktop with a keyboard it focuses its first field as before.
- Reach **Submit** with the keyboard open: the question panel is now capped to the visible area so its Cancel/Submit footer stays on screen, and the dialog's buttons follow the **Touch Targets** setting.
- Submitting a message while the agent is working now queues it by default instead of steering, in Settings → Interface & Behavior → **Message during active run**: steering a long tool or shell command could abort the turn mid-task and left the new message undelivered. A previously saved choice is kept; only an empty setting changes meaning. Sending during omp-web's own `!!` shell command no longer fails with "Cannot send a prompt while a shell command is running": the message is handed to omp's queue instead of aborting anything, the optimistic bubble is withdrawn, and a notice says it was queued behind the running command.
- Keep omp-web's own secrets out of every child process it starts, not only the `omp` session processes: plugin install and upgrade, skill install/update/search, update checks and the self-update worker, agent unpack, and the Git commands the file panel runs. A session environment no longer contains the web password hash, so `env` inside an agent no longer prints anything that grants access to this server. `OMP_WEB_*` values that are configuration rather than secrets (the `omp` binary path, port, package dir) keep reaching the processes that need them.
- Sign web sessions with a per-installation random key (created on first start at `~/.omp/agent/omp-web/web-auth-secret.json`, mode `0600`) mixed with the password hash, instead of the hash itself. Anyone who reads the hash out of a service environment file can no longer forge a session cookie, and changing the password still signs every browser out.
- On Windows, changing or removing the web password hash with `setx` now takes effect at the next server restart. The tray (native and PowerShell) and the background service read `OMP_WEB_PASSWORD_HASH` from the user, then system, environment each time they start the server, instead of preferring the copy they captured at logon, so an old password no longer keeps working after you rotate it. The native tray previously did not pass the hash on at all.
- The **Notifications** tab now lists notifications that appeared as system notifications too, not only in-app toasts, including Web Push notifications that arrive while an omp-web tab is open. Click or tap an entry for a session, or press Enter on it, to open that session; its dismiss button still only removes it. The list is still kept per tab in memory, so pushes that arrive with no omp-web tab open are not listed.
- Opening a notification by clicking or tapping its toast now marks it as read in the Notifications tab, so it no longer counts toward the unread badge. A later notification of the same kind for the same session is unread again, even after the earlier one was read.
- Word-completion ghost text in a scrolled composer now appears right after the caret. When the draft had text after the caret, it used to be drawn lines further down.
- Show a single plus sign on the **Add provider** buttons in Models settings, and none in the Add provider dialog title. The translated label no longer repeats the button's **+** icon.
- Links in a Markdown file preview no longer navigate omp-web away. A relative link the file panel cannot open, such as one in a Markdown file outside the workspace, shows as plain text with its target on hover; web links open in a new tab. An image the panel cannot load shows its alt text instead of a broken image.
- The image viewer now opens with the whole image fitted to the screen on every device, instead of at 100%; images smaller than the screen stay at their real size. The zoom percentage is always relative to the image's real pixels, at every Interface Scale. Zoom out goes down to 10%, or further to the fitted size for very large images, in ×1.25 steps. **Fit to screen** and **1:1** (actual size) replace **Reset zoom**. Zooming keeps the centre of the view in place, and a zoomed-in image can now be scrolled to every edge; before, the parts outside the starting size were cut off. The viewer covers exactly the window at Compact, Comfortable and Large Interface Scale, and its buttons follow the **Touch Targets** setting, wrapping on narrow screens instead of being clipped.
- Show images from tool results again after reopening or reloading a session. Since tool-result images were dropped from the initial history load, screenshots and image reads showed only `[1 tool result image omitted from initial history payload …]`, with a wrong byte count. Expanding the tool row now shows a small preview; click it for the full image. Previews are 480px WebP files generated once and kept in omp-web's data folder, and live tool output also arrives as a link instead of inline base64, so many large screenshots no longer slow the chat down or fill browser memory.
- The completion notification omp-web used to show for the open session when its tab was in the background is gone, along with its permission prompt on the first finished run. Turn on **Settings → Notifications** to get notifications again; they now cover every session, not only the open one.
- Builds no longer fail at random while fetching fonts. Google Fonts sometimes serves Noto Serif SC through links Next.js cannot parse, so omp-web now ships its own copy: a 2.2 MB subset (weights 600–700; GB2312, kana and CJK punctuation), downloaded only when a page shows Chinese or Japanese text in a heading. Characters outside the subset use the system's CJK serif font. The Nix package's local-font patch applies again.
- Balance the composer icons on phones and narrow toolbars with a slightly smaller effort-level icon and a larger Slow-mode snail, while keeping menu icon sizes unchanged.
- Keep the model picker on the left and reasoning effort, Fast, Slow, microphone, and Send/Stop controls in a right-aligned composer group, including wrapped mobile rows.
- The Provider Usage panel now shows each account's email instead of omp's redacted form (`an*`); accounts without an email show as **Account N**. Only the email, plan and limits reach the browser.
- The composer's reasoning menu now uses the same borderless rows as the model picker instead of bordered cards.
- The context popover now uses the room above the composer instead of a fixed 380px cap, so it only scrolls when the window is too short for it.
- Fix settings crashes, stalled session catch-up, and failed voice transcription polling in browsers without `AbortSignal.timeout`, `AbortSignal.any`, or `Promise.withResolvers`, including development-mode clients. Client requests now use `AbortController` timers and ordinary promises while retaining timeouts and cancellation (#196).
- Allow development requests from all RFC1918 private IPv4 ranges, not just `192.168.*.*`. Set `OMP_WEB_DEV_ORIGIN` to allow a tunnel or reverse-proxy hostname without editing `next.config.ts`; the setting is development-only.
- Fix authenticated app-installation metadata: serve `/api/manifest` through the existing password guard with one credentialed manifest link and embedded packaged PNG icons, avoiding cookie-free native installer icon downloads. Preserve the app identity and root launch URL/scope, retain private revalidating caching, and remove the obsolete public-manifest exception. Verified in local Chromium with HTTP icon URLs blocked and no installability errors; the owner also confirmed successful installation on a physical phone behind Cloudflare Access.
- Manage Git worktrees from a new **Worktrees** tab in the file panel, next to Explorer and Git. It lists the active workspace's worktrees and switches, creates, and removes them; removing one with uncommitted changes asks before forcing. The new-session screen also gets a worktree picker under **Workspace** when the selected workspace has more than one worktree. Switching in either place moves the folder where new sessions start and leaves the open session alone. While a session is open, Explorer, Git, and open files show that session's folder. The workspace list no longer shows a branch selector beside each workspace name.
- Keep the sidebar's action menus inside the screen on phones and at larger interface scales.
- The **Agent environment variables** editor in Settings → System & Updates now sits below its title and description and follows the page width, instead of sitting beside them and extending past the right edge. The text box also grows with its contents.
- Show queued steers and follow-ups on every device viewing a session. The queue panel now shows omp's own queue (omp 18.4.4 or later) instead of a copy kept by the tab that sent them, so it also stays correct across reloads.
- **Stop** no longer loses a queued steer or lets the agent run it anyway: as with Esc in omp's terminal, every message still waiting in the queue moves back into the composer. With omp's `abort_and_restore_queue` (newer omp), omp takes the queue back and aborts in one step, which also covers a steer you just promoted that this page's queue had not caught up with, and one the model already picked up through live steering (for example OpenAI models with `providers.openaiLiveSteering`). If that request fails, Stop retries it once and warns when the messages may not have come back. Older omp (18.4.4 or later) falls back to removing each message the page lists before the abort; there, a steer the page does not list or the model already took still runs after Stop, and attached images are dropped.
- Long voice transcriptions no longer fail with `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` behind a reverse proxy. The server now keeps the recording and transcribes it as a background job (up to about 5 minutes) while the browser polls short requests, so proxy timeouts no longer cut off a slow STT endpoint. The job survives the recording browser disconnecting: any browser showing the same session picks it up, can play the recording and retry a failure, and the transcript is inserted in exactly one browser. A **Transcribe and send** (or queue) choice stays with the job, so the transcript is still sent after you switch sessions and come back; if the agent is running by then it is queued as a follow-up, and a queue choice whose run has ended is sent. Another browser that finishes the job only inserts the text. **Transcribe and send** from the review deck now sends too. Recordings stay on the server (in memory) for up to an hour or until inserted or discarded. Anyone who can reach the omp-web API can list, play and retry those recordings by session, so set `OMP_WEB_PASSWORD` when omp-web is reachable by others.
- Sending a message to a live session no longer fails with **HTTP 404** when the session's transcript cannot be read. An empty baseline is used instead, so the prompt is still delivered. The previous behavior is what surfaced as `Failed to send message: HTTP 404` on sessions created by slash commands.
- The Skills page lists exactly what omp resolves, through `omp skill list --json` (omp 18.3.3 or later): plugin, custom-directory and registry skills appear, and colliding names show as `namespace/name`. Skills that live outside omp-web's skill folders, such as plugin installs, show a disabled toggle because an update would undo the edit. Older omp binaries keep the built-in scan.
- On phones, the top bar's **⋯** menu no longer repeats the session name already shown in the title, and its theme and language pickers open fully instead of being cut off at the bar's edge.
- **Resume running sessions after a restart** no longer resumes sessions that another running omp-web instance (for example a dev server sharing the same agent directory) is still running. Previously the second instance started duplicate agents that ran alongside the originals and wrote to the same session files.
- On phones and tablets, the first time the file panel opens it now takes keyboard focus, closes with Escape, and keeps Tab inside the panel, like every later open. Previously the first open left focus on the toggle button and ignored Escape. Closing the panel after that first open also returns focus to what opened it, such as a file link in the chat, instead of the page body.
- The Git side panel now honors `.gitattributes`: changed files marked `linguist-generated`, `linguist-vendored`, `linguist-documentation`, or `-diff` move into a collapsed "files marked in .gitattributes" group below the main list, and the panel previews the first unmarked change. `-diff` files show that their diff is suppressed, including untracked ones, instead of a generic "Diff unavailable". Files with the `binary` attribute stay in the main list.
- Stop showing tool paths such as `history://…`, `proc://…` and `local://…` as file links. They are resolved by omp, and clicking them opened an "Access denied" viewer tab. `http://` and `https://` paths passed to `read` now open the URL in a new browser tab instead.
- omp-web no longer exits when a browser disconnects in the middle of a POST request, for example when a tab closes while a request is still in flight. A Next.js bug (vercel/next.js#99278) could turn that disconnect into an uncaught `Error: aborted`, which the crash handler treated as fatal. These disconnects are now logged to `diagnostics.log` as `client-abort` and the server keeps running; every other uncaught error still exits.
- When `PI_CODING_AGENT_DIR` points away from `~/.omp/agent`, the crash journal (`diagnostics.log`) is written to `<agent dir>/omp-web/` instead of `~/.omp/omp-web/`, so isolated test and development servers no longer write to the real journal.
- Slide the file panel in from the right edge on phones, with the same timing as the left sidebar, instead of popping it open full-screen. The first open slides too, without a **Loading…** placeholder or a dimmed backdrop flashing over the chat. The panel still covers the whole screen once open, and it opens and closes instantly when reduced motion is enabled.
- On mobile, move the session information control (context ring with stats, tokens, cost, and **Compact context**) to the top-right of the top bar; desktop keeps it in the composer toolbar. Preserve the ring usage coloring, its popover, and the `/session` shortcut. Opening the panel moves focus into it; Escape dismisses it before run shortcuts and returns focus to its opener when focus is still within the panel.
- Make the mobile workspace sidebar full-screen without a dimmed backdrop, with a visible top-left close button. Place the file-panel opener inside the upper bar and add a separate top-right close button inside the file panel, with keyboard focus returning to its opener. Keep the session-title pill centered between the header controls.
- Continue the mobile file-panel tab-row border underneath its close-button cell, so the divider spans the full width.
- On mobile, swipe anywhere on the app surface: swipe right to open the left sidebar or close the right one, and swipe left for the opposite action. No device-edge start or perfectly straight movement is required. Recognition follows overall dominant-axis displacement and tolerates curved thumb movement, a brief corrective start, and shorter deliberate drags. Taps, predominantly vertical movement, multi-touch, text editing or selection, native horizontal scrolling, and open popups retain their normal behavior; persistent drawer lists, including Git changes, remain swipeable. Embedded previews retain native input and full width; swipe on their surrounding toolbar to close the sidebar.
- Let the centered session-title pill fit its content and grow for longer names up to the available header space, instead of stretching short names into a fixed-size box.
- Keep **Collapse input** available after expanding a long user message with **Show full input**, so the message can be collapsed again.
- Agent host tools (`open_url`, `notify`, `open_file`) no longer fail when you switch to another session mid-run. Any open omp-web tab now answers them, and a URL or file from a session you are not viewing opens only after you confirm it in a dialog.
- Ask before opening links from the agent. Turn on **Open agent links without asking** in Settings → Interface & Behavior to open links from the session you are viewing right away; links from other sessions always ask.
- An attached ask panel no longer steals focus after it opens. Typing in a question's **Other** box no longer selects the first option when the text begins with a space, and focus is never pulled back to a radio button once you have moved on.
- Keep every assistant reply visible in the chat. **Process details** now folds only the activity between replies (thinking, tool calls, notices), so a reply that ended a turn is no longer hidden when a background job or reminder resumes the agent.
- Honor omp's **Hide Thinking Blocks** setting in the chat, and rename the toggle from **Thinking Blocks** so its label matches what it does.
- Start system reminders, async job results, and late LSP diagnostics collapsed to their first line. Click the header to expand; reminder headers show their attributes, such as `reason` and `rule`.
- Render Nerd Font icons that omp sends when its symbol preset is set to Nerd (for example the multi-select **Done selecting** check mark) instead of empty boxes. The bundled symbols font (Nerd Fonts Symbols Only, SIL OFL 1.1, about 1.2 MB) applies only to Private Use Area codepoints and is downloaded only when a page shows one of these icons.
- Show late LSP diagnostic notices with their original line breaks, like async results, instead of collapsing them onto one line.
- Unexpected omp process exits now remain visible in the workspace and session sidebar until that session starts again, including the exit code or signal and the last stderr line.
- Show free-text answers to agent questions (the ask tool's "Other" option and other `promptStyle` editor requests) in the chat font instead of the monospace code font.
- Keep line breaks in agent dialog titles instead of running multi-line titles together on one line.
- Restore the Settings toggle track, which the 44px hit area had squeezed into a dot. Cap Settings dropdowns at half the card width with an ellipsis for long options, and stack them below their label at full card width on narrow screens.
- Give the top-bar theme picker the same padding and icon spacing as the language picker; its icon and arrow were squeezed into a 28px button.
- Improve phone and tablet ergonomics with safe-area-aware top chrome, a focus-trapped mobile workspace drawer, an actionable first-run workspace state, touch-sized sidebar actions, narrow-screen composer wrapping, clearer settings loading/retry states, and quieter streaming announcements.
- Keep the Extensions & Tools settings panel scrollable on desktop and touch layouts, including long MCP server lists.
- Let non-native settings tabs render while the common OMP configuration loads, and show static MCP configuration before live status resolution.
- Give the new-session workspace picker a calmer destination card with a folder badge, stronger focus and hover states, a compact path context line, and touch-friendly spacing while retaining the native accessible select behavior.
- Defer the file panel and its Explorer/Git work until first use, use a fixed overlay for the file panel on tablet widths, increase mobile Explorer row height, enlarge Git touch targets, and keep compact session context available in the mobile overflow menu.
- Move focus into attached extension requests, contain keyboard focus in the custom extension terminal, and add a local retry action when a text file cannot be loaded.
- Add local retry actions and status semantics to Explorer, Git, and text-file failure states so transient workspace errors are recoverable without hunting for a toolbar refresh control.
- Defer Explorer and Git tab work until each tab is first opened, avoiding duplicate status requests and hidden-panel overhead while preserving visited tab state.
- Pause content fetches and file-watch connections for inactive file tabs, then resume them when the tab becomes active to reduce background network and rendering work.
- Defer the command-palette chunk until the first Ctrl/Cmd+K shortcut, reducing initial shell work while preserving the existing keyboard workflow.
- Add a visible command-palette action in the topbar overflow menu with the Ctrl/Cmd+K shortcut exposed to assistive technology, while keeping the palette chunk lazy.
- Replace the generic file-panel loading label with a shape-matched skeleton toolbar and rows, giving desktop and mobile users a stable visual handoff while the deferred panel chunk loads.
- Enlarge mobile file-search controls and add inline refresh actions to sidebar load failures, keeping the primary navigation recoverable without relying on the header icon.
- Keep the full-page Settings header clear of notches and home indicators, and enlarge its search, back, and close controls for touch devices.
- Add a localized **Return to latest message** control that appears when a long conversation is scrolled away from the bottom, with reduced-motion-aware scrolling and touch-sized mobile controls.
- Replace the sidebar’s generic loading label with shape-matched workspace/session skeleton rows for a calmer first paint on desktop and mobile.
- Clarify the mobile file-panel control by switching from a panel icon to an explicit close icon when the panel is open, while retaining the existing accessible toggle labels.
- Enlarge mobile session-search and composer attachment-remove controls so common mobile cleanup actions meet the same touch-target standard as navigation.
- Make the compact mobile topbar overflow horizontally navigable so the new command action, session context, and existing controls remain reachable instead of overlapping at narrow widths.
- Localize the command palette’s session-loading state instead of leaving English-only copy visible in Chinese and Japanese.
- Localize the workspace login title, password prompt, unlock action, and authentication errors for English, Chinese, and Japanese users.
- Localize composer attachment limits, skipped-file explanations, read failures, and running-agent attachment errors for English, Chinese, and Japanese users.
- Localize composer retry-abort and attachment removal labels so mobile cleanup and recovery actions match the active interface language.
- Close the mobile topbar overflow when launching the command palette from its visible trigger, preventing the menu from remaining open behind the modal.
- Add localized retry actions to image, audio, and document viewer failures so transient file-loading problems can recover without closing the file panel.
- Keep the login card clear of device safe areas, enlarge password and unlock controls for touch use, and retain the shared focus-ring treatment.
- Add localized inline retry recovery to workspace directory-picker failures, so mobile users can recover without closing the picker.
- Enlarge directory-picker profile, launch toggle, and extra-argument controls on touch devices for reliable workspace setup on phones.
- Enlarge mobile Settings navigation tabs and provider segmented controls to 44px targets, keeping the horizontal Settings header easy to traverse on phones.
- Localize the document viewer’s PDF type label so file metadata remains consistent with the selected interface language.
- Localize workspace-picker profile and extra-argument accessible labels for English, Chinese, and Japanese users.
- Enlarge archive-browser search and clear controls on touch devices for reliable session-history filtering on phones.
- Enlarge MCP refresh, server selection, add-server, config fields, and action buttons on touch devices for reliable mobile server setup.
- Localize MCP connection, enabled/disabled, off, and invalid status labels for English, Chinese, and Japanese users.
- Localize agent discovery error, warning, and fallback diagnostic messages for English, Chinese, and Japanese users.
- Announce agent discovery errors with alert semantics while keeping warning-only diagnostics polite, so assistive technology distinguishes failures from informational notices.
- Give the archive search clear action an explicit localized **Clear search** accessible label instead of reusing the dialog close label.
- Enlarge agent reload, unpack, create, search, list, copy, save, cancel, and remove controls on touch devices for reliable mobile agent management.
- Localize bundled, user, and project agent scope badges so agent metadata remains readable across supported languages.
- Announce MCP configuration load failures with alert semantics while retaining polite status announcements for live-status connectivity notices.
- Expand the Settings switch hit area to 44px while preserving the existing 40×24 visual track and focus behavior.
- Replace the text-file viewer’s generic loading label with shape-matched skeleton lines and semantic busy state for smoother first paint.
- Replace the conversation session-loading label with shape-matched skeleton lines and semantic busy state for a calmer chat first paint.
- Enlarge the conversation session retry action on touch devices so a failed session can be recovered reliably from mobile.
- Expose Explorer directory and search loading state through `aria-busy`, improving assistive-technology feedback while mobile file navigation remains touch-friendly.
- Replace the initial workspace-validation label with a shape-matched skeleton and semantic busy state for a calmer first paint.
- Show the Ctrl/Cmd+K shortcut in the command-palette toolbar trigger’s tooltip while retaining the existing accessible shortcut metadata.
- Give the archive search input an explicit localized accessible label instead of relying on placeholder text alone.
- Refresh the OMP version shown in new sessions after a CLI update without requiring an omp-web server restart. Reuse results while executable metadata is unchanged, with a five-minute fallback expiry for launchers. Keep the last known version visible between visits and distinguish initial loading from an unavailable runtime.
- Add `OMP_WEB_DISABLE_AUTOUPDATE` to skip npm/OMP update checks and block in-app self-update actions, preserve the setting in service installers, and show the disabled state in Settings.
- Return browser host-tool and host-URI results as fire-and-forget frames while preserving OMP's original request ID, preventing `open_file` and clipboard bridge calls from hanging.
- Restore copy-success feedback after React Strict Mode re-runs effect setup.
- Cancel queued messages in OMP before removing their chips or recalling them for editing. Failed or timed-out cancellation leaves the message visible; successful recall survives composer remounts without losing newer typing. Requires native `remove_queued_message` support.
- Preserve question-dialog answers and selections when an SSE reconnect replays the same pending request or answer submission fails.
- Keep sent-message copy, edit, and fork actions visible without hover or a reveal tap. Also keep file mention/download, Git open-file actions, and sidebar menus visible alongside their metadata; wrap message actions on narrow screens.
- Expand complete tool inputs inline, including multiline code and edit patches, while keeping command previews compact and output visibility unchanged.
- Keep composer controls on one line, with equally sized Send, Stop, and Queue buttons and model names truncating before short effort labels.
- Align the + button and primary action with matching composer insets.
- Recover saved responses before reporting an empty agent reply after returning to a backgrounded page or PWA. Preserve provider errors and distinguish new runs from older answers.
- Catch up missed conversation entries incrementally after reconnecting or returning to the page, including during active runs. Restore quiet partial responses and live tool output without duplicating history or overwriting newer updates.
- Send prompts with image attachments in full again: commands reach OMP as one unchunked JSONL record. Protocol-v2 `rpc_chunk` framing is outbound-only, so any prompt over 1 MiB was rejected as `Unknown command: rpc_chunk` and reset the session after the prompt-ack timeout.
- Show the **New session** fork action below agent replies as well as user prompts, so the newest message in a conversation can fork the session. omp's `branch` command accepts a user entry only, so each reply forks at the prompt that started its turn; replies with no earlier prompt keep no fork action.
- Count subagents, advisors, `/tan` clones and extension helper sessions in Settings → **Usage**. Their model usage lives in transcripts inside each session's artifacts folder, which the Usage page never read. It counted only subagent summaries in `task` results, and background subagents leave those empty. These transcripts now count toward the session and project that own them. History copied by `/tan`, `/fork` or a branch counts once and moves to a remaining copy if the original is deleted, and a `task` summary counts only when no copy of its subagent's transcript exists. The `local://` scratch folder is not scanned. The usage cache rebuilds once on first load; when another omp-web version shares it, files that version synced are re-read.
- Show every tool call as its own row. Collapsing a finished turn's process details no longer merges tool calls from separate assistant messages into a single row, and parallel calls are no longer folded behind a summary header such as "Searched 2 times".

---

## [v0.5.0] - 2026-09-12

This release brings live tool-output streaming, a workspace picker for new sessions, voice dictation, new themes, an activity timeline with transcript export, and a redesigned settings experience.

### Highlights

- **Live tool output**: Tool calls now show a running indicator with streamed output while the tool executes, instead of a dead row awaiting the result.
- **Workspace picker for new sessions**: Choose the destination workspace directly above the new-session composer, with workspace names, exact paths, and worktree preservation.
- **Voice dictation**: Provider-agnostic speech-to-text dictation in the composer.
- **New themes**: OMP Midnight plus popular light and dark palettes with previews and CommandPalette support.
- **Activity timeline**: Activity group summaries, a minimap rail, and transcript export.
- **Composer upgrades**: Plus menu, context-ring gauge, context detail panel, and a `/loop` command to repeat a task up to N attempts.
- **Redesigned settings**: Full-page centered layout with a provider grid.
- **Long-session stability**: Targeted cache invalidation, oversized-file handling, better error surfacing, and render optimization.

### Fixes & Improvements

- Keep Cancel and Submit reachable in mobile extension questions by scrolling long questions and answers above a fixed action row and sizing the editor for short viewports.
- Confirm session deletion and workspace removal in dialogs on desktop and mobile. Cancel leaves data untouched; workspace removal keeps files and sessions.
- Center the workspace/session breadcrumb over the conversation column, and keep mobile generation speed and file-panel controls clear of the panel toggle. Explorer actions now have a separate touch-sized toolbar on mobile.
- Keep the top bar on one row with a fixed-width speed readout: compact units such as t/s, kt/s, and Mt/s, and a same-width ~ marker for average speed. The full rate remains in the tooltip; the whole pill hides when it cannot fit, without clipping or scrolling.
- Keep the fixed-width speed readout visible on narrow screens, including 320px: show theme, language, history, branches, and system controls directly when their measured widths fit beside any visible speed readout, and use a More disclosure otherwise, without shrinking touch targets. New-session screens do not reserve space for an absent readout.
- Open the language menu to the right of its left-side toolbar trigger so all options remain visible in the mobile More disclosure and the desktop header.
- Keep resized file panels and their contents inside the window at intermediate widths and non-default interface scales, wrapping file and Explorer actions when space is tight.
- Keep session action menus visible on touch devices beside fixed-width, right-aligned timestamps, with larger tap targets and titles using the remaining row width.
- Keep workspace header action menus visible on touch devices without first selecting or expanding the workspace.
- Keep provider and OMP System navigation in one horizontally scrollable row on narrow screens, and keep Save and Cancel in normal flow with inline save errors.
- Hide the Steer action when the only queued message is already a steer, matching the expanded queue while keeping Edit and Delete available.
- Keep the theme picker inside the mobile viewport by opening it to the right of its toolbar anchor.
- Match browser and installed-app chrome to the selected theme, with OMP Midnight as the launch fallback.
- Open the conversation sidebar on Back before leaving in narrow, overlay-sidebar layouts. On every layout, warn before Back, reload, or close can discard unsent text or attachments. Cancel keeps the current conversation and drafts; switching conversations still preserves drafts.
- Keep unsent-content confirmation active across consecutive Back presses on Android Chrome, including after switching to a new session.
- Some installed browsers cannot close a directly launched app programmatically. After confirming Leave, use native Back or Close if prompted. Chrome may bypass sidebar-first Back until the first interaction after launch, and Android process termination can bypass page warnings.
- Show app-close guidance only in standalone installed apps, never in ordinary browser tabs.

---

## [v0.4.2] - 2026-09-02

### Fixes & Improvements

- Handle provider daily usage windows and Windows npm spawn shells in the self-update flow.

---

## [v0.4.1] - 2026-09-02

### Fixes & Improvements

- Surface quota 429 RESOURCE_EXHAUSTED errors persistently instead of stopping silently.
- Pin the live agent status bar to the top edge of the composer.
- Keep the running indicator visible on selected/hovered sessions.

---

## [v0.4.0] - 2026-09-02

This release adds native autostart services, self-updates, a redesigned top bar, usage analytics, and composer upgrades.

### Highlights

- **Native autostart**: Windows Task Scheduler service, system tray manager, desktop shortcuts, and macOS launchd installer.
- **Self-updates**: Durable auto-update for OMP and omp-web with unified notifications.
- **Top bar redesign**: 3-zone layout with centered breadcrumb, provider cards, and zoom-aware menus.
- **Usage analytics**: Dashboard with persistent SQLite store plus provider usage limits.
- **Composer upgrades**: Tool preset picker, collapsible input, file search in the Explorer, and workspace-level OMP launch arguments.

---

## [v0.3.6] - 2026-08-28

This release adds workspace renaming and reordering, improved context compaction views, prompt queue expansion, and clear network startup banners.

### Highlights

- **Workspace aliases and reordering**: Give your workspaces friendly names and drag-and-drop or use keyboard shortcuts to reorder them in the sidebar.
- **Inspect past context**: Browse full conversation history from before compaction occurred, with accurate before-and-after token counts and compaction method indicators.
- **Queued prompt expansion**: Expand and review queued follow-up prompts before they are sent to the agent.
- **Interactive questions in composer**: Respond to interactive questions from extensions directly inside the chat composer.
- **Accurate live stats**: Live generation speed (tokens per second) is now pulled directly from the agent runtime, and cache hit rates are displayed in both the top bar and session info panel.
- **Helpful network startup banner**: When starting omp-web, the terminal now displays clear, clickable local, LAN, and Tailscale network addresses.
- **Complete Chinese settings localization**: Fully translated Settings, Models, MCP, and Agent configuration screens with smooth hydration.

### Fixes & Improvements

- Fixed the session details popover from getting cut off or hiding message and token numbers.
- Pressing Escape inside popups or dialogs now closes only the dialog without stopping the running agent.
- Tooltips now display properly above open dialogs and modals.
- Enhanced keyboard navigation visibility in the command palette.
- Made archived session recovery safer and improved session file caching on Windows.

### Contributors

Thank you to the contributors who made this release possible:
- @2740653660

---

## [v0.3.5] - 2026-08-21

This release introduces an archive browser for past conversations, live tracking for external CLI sessions, per-chat advisor controls, and a cleaner chat timeline.

### Highlights

- **Archived session browser**: Browse and search archived conversations in a dedicated panel, and restore them anytime without losing data.
- **Live external sessions**: Sessions started directly from the `omp` command-line now show up in the web interface and stream their responses live.
- **Per-chat advisor mode**: Turn the advisor agent on or off for individual conversations, with settings remembered per chat.
- **Cleaner tool-call timeline**: Tool calls and agent reasoning steps now display in a compact, organized timeline with expandable details and side-by-side file diffs.
- **Live speed indicator**: See real-time token generation speed while the agent is responding, along with average speeds for past turns.
- **Simplified model & reasoning pickers**: Redesigned selectors make choosing models and thinking levels quicker and easier on both desktop and mobile.

### Fixes & Improvements

- Fixed focus handling so closing the mobile sidebar never traps keyboard navigation.
- Added web app manifest and icons for installing omp-web directly to your device home screen.
- Server-side network requests now properly respect `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` settings.
- MCP server credentials are now safely preserved when renaming an MCP server.
- Fixed crashes caused by incomplete or manually edited session files.

### Contributors

Thank you to the contributors who made this release possible:
- @gzaripov

---

## [v0.3.4] - 2026-08-20

This release brings persistent visual agent settings, stronger API safeguards, and improved MCP security.

### Highlights

- **Visual agent settings**: Configure agent behavior and visual preferences directly in Settings, with changes saved automatically.
- **Safer MCP credentials**: Project MCP server secrets and tokens are hidden from API responses while being safely preserved during updates.
- **Request size protection**: Added payload size limits to protect agent and file endpoints from oversized requests.
- **Smooth settings editing**: Prevented background settings refreshes from overwriting changes you are actively typing.

### Fixes & Improvements

- Standardized release builds on Node.js 22.
- Normalized line endings and file types across Windows, macOS, and Linux.
- Improved accessibility and visual feedback for interactive buttons.

---

## [v0.3.3] - 2026-08-18

This release improves model search, Windows workspace support, authentication reliability, and text display.

### Highlights

- **Searchable models**: Quickly filter and search through available models directly inside the model selector.
- **Smoother model catalog loading**: Efficiently loads large model catalogs without slowdowns or connection hiccups.
- **Windows drive picker**: Easily select and browse different drives and Git worktrees on Windows.
- **System prompt on demand**: The system prompt now loads on demand for a faster initial chat load.

### Fixes & Improvements

- Better handling of markdown frontmatter and metadata cards.
- Polished sidebar layout and improved text rendering for East Asian (CJK) characters.
- Fixed authentication handshake issues with newer agent versions.
- Safer fallbacks when a selected model is temporarily unavailable.

### Contributors

Thank you to the contributors who made this release possible:
- @flaribbit

---

## [v0.3.2] - 2026-08-17

This release introduces password protection for web access, a redesigned Settings experience, and CLI improvements.

### Highlights

- **Password protection**: Secure your web interface with simple password login and secure session cookies.
- **New CLI flags**: Added `--password`, `--help`, and `--version` command-line options.
- **Redesigned Settings**: Easily search through settings, manage endpoint presets, and configure models with a cleaner layout.
- **Live running sessions**: Running conversations stay clearly visible in the sidebar while keeping updates efficient.

### Fixes & Improvements

- Kept composer controls and thinking toggles accessible while the agent is running.
- Improved initial scroll positioning and prompt helper behavior.
- Fixed pulse animations and status indicators in dark and light themes.
- Polished active folder highlights on Windows systems.

---

## [v0.3.1] - 2026-08-14

This release brings a major redesign of the workspace sidebar and chat composer, along with wider layouts and accessibility fixes.

### Highlights

- **Redesigned sidebar**: Cleaner project grouping and clearer status indicators make navigating multiple projects effortless.
- **Redesigned composer**: Added a dedicated queued follow-up bar so you can queue prompts while the agent is busy.
- **Wider chat workspace**: Expanded the chat column to make better use of widescreen monitors.
- **Universal file attachments**: Attach any supported file type to your chat messages with helpful file icons.
- **Refined typography & details**: Polished code blocks, process details, and spacing across the interface.

### Fixes & Improvements

- Protected attachment reads against file access races and resource leaks.
- Improved file picker filtering and session discovery.
- Fixed sidebar project grouping issues caused by Windows path casing.
- Added proper cleanup for background event streams when switching tabs.

---

## [v0.3.0] - 2026-08-13

This release adds full agent control commands, keyboard shortcuts for models and reasoning, and explicit update notifications.

### Highlights

- **Interrupt & reply**: Stop a running agent response and immediately send a new prompt from the composer.
- **Retry from banner**: Retry failed responses with a single click directly from the error banner.
- **Keyboard shortcuts**: Quickly cycle through models and reasoning levels using handy keyboard shortcuts.
- **Queue mode controls**: Choose between steering and follow-up queue modes directly in the interface.
- **Update notifications**: Replaced automatic background updates with clear update notices and copyable terminal commands.

### Fixes & Improvements

- Smoother live streaming responses and better memory cleanup when sessions finish.
- Improved Windows path comparisons and Git worktree handling.
- Better color contrast, mobile layouts, and screen reader accessibility.

---

## [v0.2.9] - 2026-08-12

This release adds an image lightbox, smoother streaming for long conversations, and configuration safety improvements.

### Highlights

- **Image lightbox**: Click any image in chat to view it in full size, zoom in, or copy it to the clipboard.
- **Collapsible tool calls**: Your preference for keeping streaming tool calls collapsed or expanded is now saved.
- **Smoother streaming**: Long conversations now stream smoothly with significantly reduced lag and fewer unnecessary re-renders.
- **Custom reasoning levels**: Support for custom thinking and reasoning levels defined by external model providers.

### Fixes & Improvements

- Prevented older session data from overwriting newer runs during page reloads.
- Protected MCP configuration files with file locks to avoid corruption during simultaneous writes.
- Fixed upload and path issues on Windows network shares (UNC paths).
- Improved subagent transcript accessibility and retry behavior.

---

## [v0.2.8] - 2026-08-12

This release introduces a dedicated subagent workspace, pinned task plans, and improved session history recovery.

### Highlights

- **Pinned task & subagent panel**: Keep your todo task list and active subagents pinned right above the composer.
- **Live subagent details**: See real-time subagent status, active tools, retries, token usage, cost, and background task markers.
- **Subagent transcript viewer**: Open a dedicated dialog to view final results, live logs, or full transcripts.
- **History recovery**: Subagents from past conversations are now recovered from disk history when you reopen a session.
- **Clean task summaries**: Expanded task cards show concise summaries without cluttering the screen with raw logs.

### Fixes & Improvements

- Restoring a session from a URL now waits until the session is fully loaded.
- Kept project ordering stable and refined dropdowns and toast notifications.
- Improved subagent identifier validation, UTF-8 text handling, and accessibility.

---

## [v0.2.7] - 2026-08-12

This release improves self-update safety with automatic backups, verification, and rollbacks.

### Highlights

- **Safe updates with automatic backup**: Creates a backup before updating the app or agent runtime.
- **Update verification**: Verifies the newly installed binary and launches a test session before marking the update complete.
- **Automatic rollback**: Automatically restores the previous working version if an update fails, preventing broken installations.
- **Package manager detection**: Accurately detects whether you installed via npm or Bun and uses the right tool for the job.
- **Update history in Settings**: View the status and outcome of your latest update attempt directly in Settings.

---

## [v0.2.6] - 2026-08-12

This release expands project workflows, file attachments, subagent visibility, and chat customization.

### Highlights

- **Session import**: Safely import session files into any selected workspace.
- **File attachments**: Attach text and Markdown files directly to your prompts.
- **Searchable model catalog**: Browse and pick models from an expanded, searchable catalog.
- **Web slash commands**: Use convenient slash commands that work seamlessly with the agent.
- **Subagent activity**: Track subagent progress and refresh transcripts in real time.
- **Planning & goals banner**: See task plans and objectives pinned above the composer with live progress timers.

### Fixes & Improvements

- Unified color themes, status badges, and focus rings across all UI components.
- Hardened session import and background process restart behavior.
- Cleaned up assistant message layouts while keeping tool details easily accessible.

---

## [v0.2.5] - 2026-08-10

This release introduces managed project workspaces and improves task tracking and session reliability.

### Highlights

- **Managed project workspaces**: Manage projects in a resizable sidebar with persistent workspace registration and activity grouping.
- **Phase-based task tracking**: Track progress through multi-phase plans with live phase indicators.
- **Smoother session recovery**: Improved session file reading and chat state recovery after disconnections.
- **Reliable in-app updates**: Smoother and more dependable update checks.

---

## [v0.2.4] - 2026-08-10

This release improves streaming scroll stability and simplifies application updates.

### Highlights

- **Stable scroll follow**: Fixed chat scrolling so the view stays smoothly anchored as long responses stream in.
- **Reliable updates**: Streamlined the update flow to use standard npm packages for a smoother upgrade experience.

---

## [v0.2.3] - 2026-08-10

This release improves code readability and visual feedback during streaming.

### Highlights

- **Clearer code blocks**: Refined syntax highlighting and code block styling for better readability.
- **Smooth streaming scroll**: Fixed auto-scrolling behavior so you can comfortably read responses while the agent types.
- **Better completion feedback**: Improved status indicators when the agent finishes answering.

---

## [v0.2.2] - 2026-08-10

This release improves Windows startup behavior and updates project documentation.

### Highlights

- **Clean Windows startup**: Prevented background agent processes from spawning unwanted console windows on Windows.
- **Updated screenshots & config**: Refreshed application documentation, screenshots, and developer settings.

---

## [v0.2.1] - 2026-08-10

This is the initial public release of omp-web: a fast, modern browser interface for the omp coding agent.

### Highlights

- **Live streaming chat**: Converse with the agent with live streamed text, tool call cards, thinking levels, token counts, cost tracking, and context window gauges.
- **Session management**: Switch between conversations, fork threads, branch into alternatives, and restore sessions directly from URLs.
- **Integrated file explorer**: Browse project files with syntax highlighting, Markdown and Mermaid previews, live updates, diffs, and file mentions.
- **Image attachments**: Drag and drop, paste, or pick images to include in your prompts.
- **Comprehensive configuration**: Easily configure providers, models, API keys, OAuth logins, tools, reasoning intensity, system prompts, and skills from the web UI.
- **Productivity features**: Queue follow-ups, enable steering modes, play completion sounds, navigate with a minimap, and use on mobile devices.
- **Global CLI**: Launch easily via `ompweb` on Windows, macOS, and Linux with customizable host and port options.
- **Internationalization**: Full English, Chinese, and Japanese localization with built-in onboarding guides.

### Contributors

Thank you to the contributors who made this release possible:
- @19WAS85
- @AKAZIK-py
- @AyushDubey23
- @GodD6366
- @Kabochar
- @Li7777777
- @MonteNegroX
- @RizzoTho
- @Windrunner20
- @agegr
- @c54444263
- @fallleave001
- @hcnysa
- @huangyuxi99
- @hzdingxb
- @imxyanua
- @isWittHere
- @kaiwishc
- @kerwin2046
- @killersteps
- @kongdd
- @lc-git
- @levinwang6
- @lifu963
- @mike950523
- @molicherry
- @opsCar
- @robinwlive
- @shani-singh1
- @sleepinginsummer
- @sunqing78
- @tura-ai-agent
- @windli2018
- @xCss
- @xiaojueshi
- @zhudatou630
- @zzjcool
