# Changelog

All notable changes to **omp-web** (`@kahme247/ompweb`) are documented in this file.

---

## Unreleased

### Added

- Ask a side question with `/btw <question>`: omp answers from the current conversation in a panel above the composer, even while the agent is working, and the question never enters the chat. Cancel a running answer, copy it, or ask follow-ups in the same topic. `/btw` on its own lists the session's past side questions, including ones asked in the terminal, each expandable to all its turns with **Copy** and **Follow up**. Side questions are text-only: with an attachment in the composer, `/btw` is refused and the draft is kept. An answer that omp lost (for example after its process restarted) shows as **Interrupted** instead of spinning. Requires an omp with the `btw` RPC commands; older omp shows "/btw requires a newer omp" instead of sending the text to the model.
- Show omp's Claude usage-limit badge in the composer toolbar, matching the terminal status line during the wrap-up allowance or once `/slow` low priority takes over. Reset times use the browser's locale and timezone. Requires an omp version whose `get_state` reports structured `anthropicSlowMode` state.
- Add **Paste image** to the composer's **+** menu, with Japanese and Simplified Chinese translations. Requires HTTPS (or localhost), browser support for clipboard image reads, and clipboard permission; the item is hidden where the browser cannot read images from the clipboard. Attaching a file remains available.
- Create a workspace by cloning a Git repository: in the **Add workspace** dialog, enter an `https://` or ssh URL and choose **Clone here** to clone into a new folder under the selected directory, which then becomes the active workspace. Clone progress streams into the dialog; **Cancel clone** stops git and deletes the partial clone. git never prompts, so private repositories need a credential helper or ssh agent.
- Add an off-by-default **Resume running sessions after a restart** setting in Settings → System & Updates. When omp-web restarts while agents are working, it restarts those sessions and prompts each with "Session interrupted and resumed. Continue as you would have done without the interruption." Work in progress at the moment of the restart, such as a running command, is lost. Do not also resume those sessions from a terminal while omp-web is down.
- Add **Copy** and **Copy as Markdown** below user messages and completed assistant replies, with keyboard access and touch-sized controls. Copy only message text, excluding thinking, tool output, and renderer controls; preserve full source for oversized raw-text messages.
- Scope Ctrl+A / Cmd+A to the selected message, currently loaded chat, or active file contents instead of the whole page. Message selection includes collapsed extension previews and expanded details without toolbar labels. Newer pane focus takes precedence over retained child selections. Text fields and IME composition retain native behavior; browser-menu commands and embedded viewers remain browser-controlled.
- Add an off-by-default **Scope native Select All (experimental)** switch in Settings → Interface & Behavior. The per-browser preference narrows whole-page selections from native menus while leaving keyboard scoping independent. Disable it if browser selection handles or menus behave unexpectedly; intentional whole-page selections can also be narrowed.
- Play back a voice recording before transcribing or sending it. Pause keeps a left-side preview control; Stop opens a review deck with play, discard, and transcribe-and-send.
- Link GitHub issue and pull-request references in chat messages. Bare `#123` links to the session checkout's GitHub repository (the `gh` default remote, else `upstream`, `github`, then `origin`); `owner/repo#123` links to that repository. Code spans and existing links are left unchanged.
- Show all of an agent's ask-tool questions in one panel, with checkboxes for multi-select, radio buttons for single-select (recommended option marked and preselected), and an **Other** free-text answer per question, submitted together. Requires an omp that supports `set_ask_dialog`; older omp keeps the one-question-at-a-time dialog.
- Make `agent://<id>` subagent handles in chat messages clickable. Bare handles, inline code containing only a handle, and Markdown links open that subagent's result dialog; `agent://Parent/Child` opens the nested `Parent.Child` subagent when the roster knows it. A `read` of an `agent://` handle opens the same dialog from its tool row.
- Show the full model name, including its provider (for example `anthropic/claude-sonnet-5-5`), and the reasoning effort in the subagent result dialog, for running subagents and for finished ones after a reload. Finished background subagents take them from their saved transcript, so they also appear in the composer's subagent chips.

### Fixes & Improvements

- Allow development requests from all RFC1918 private IPv4 ranges, not just `192.168.*.*`. Set `OMP_WEB_DEV_ORIGIN` to allow a tunnel or reverse-proxy hostname without editing `next.config.ts`; the setting is development-only.
- The **Agent environment variables** editor in Settings → System & Updates now sits below its title and description and follows the page width, instead of sitting beside them and extending past the right edge. The text box also grows with its contents.
- Show queued steers and follow-ups on every device viewing a session. The queue panel now shows omp's own queue (omp 18.4.4 or later) instead of a copy kept by the tab that sent them, so it also stays correct across reloads.
- **Stop** no longer loses a queued steer or lets the agent run it anyway. The text of messages still waiting in the queue moves back into the composer (images attached to them are dropped). Requires omp 18.4.4 or later. A steer the model already picked up through live steering (for example on OpenAI models with `providers.openaiLiveSteering`) cannot be taken back: omp requeues it when the run stops and runs it next.
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
- Clearly dim Attach files while the agent is running; queued messages remain text-only.
- Recover saved responses before reporting an empty agent reply after returning to a backgrounded page or PWA. Preserve provider errors and distinguish new runs from older answers.
- Catch up missed conversation entries incrementally after reconnecting or returning to the page, including during active runs. Restore quiet partial responses and live tool output without duplicating history or overwriting newer updates.
- Send prompts with image attachments in full again: commands reach OMP as one unchunked JSONL record. Protocol-v2 `rpc_chunk` framing is outbound-only, so any prompt over 1 MiB was rejected as `Unknown command: rpc_chunk` and reset the session after the prompt-ack timeout.
- Show the **New session** fork action below agent replies as well as user prompts, so the newest message in a conversation can fork the session. omp's `branch` command accepts a user entry only, so each reply forks at the prompt that started its turn; replies with no earlier prompt keep no fork action.
- Count subagents, advisors, `/tan` clones and extension helper sessions in Settings → **Usage**. Their model usage lives in transcripts inside each session's artifacts folder, which the Usage page never read. It counted only subagent summaries in `task` results, and background subagents leave those empty. These transcripts now count toward the session and project that own them. History copied by `/tan`, `/fork` or a branch counts once and moves to a remaining copy if the original is deleted, and a `task` summary counts only when no copy of its subagent's transcript exists. The `local://` scratch folder is not scanned. The usage cache rebuilds once on first load; when another omp-web version shares it, files that version synced are re-read.

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
