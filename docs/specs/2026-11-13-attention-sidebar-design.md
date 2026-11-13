# Needs attention: sidebar section and agent attention signal

## Intent

A user running many sessions across hosts must see at a glance which ones are
blocked on them. Today a blocked session is marked inside its workspace (#461,
the "Waiting for your input" icon), but finding it means scanning every
expanded workspace. A **Needs attention** section above Workspaces lists exactly
those sessions, and nothing else.

## What counts as needing attention

A session needs attention while either holds:

1. **An open blocking dialog** waits for the user: `ask`, `confirm`, `select`,
   `input`, `editor` or `open_url` (`BLOCKING_UI_METHODS`). This covers tool
   permission prompts ("Allow tool: …", unless auto-approved) and omp-web's own
   confirmations (`confirmFromServer`, used by `send_to_session` and
   `new_session`). The server already reports this per running session as
   `RunningRpcSession.awaitingInput` (#461).
2. **The agent said it waits for the user.** The model calls the
   `request_attention` tool when it ends its turn waiting for an instruction,
   an answer, a decision or an approval. The tool persists a marker entry. The
   session needs attention while that marker is newer than the session's newest
   user message **and** the session is not running. The next user message
   clears it, so the agent never has to withdraw it.

The second signal lives in the session file, so it survives idle reaping (the
omp process is gone), web server restarts and daemon restarts.

## Agent tool: `request_attention`

- Part of ompweb's omp build: `runner/src/attention.ts` defines it as an SDK
  custom tool, and `createHostedAgentSession` (`runner/src/session.ts`) passes
  it in `customTools` to every session the runner creates, headless or TUI, so
  every omp-web session on every host gets it. Subagents do not (omp builds
  them with its own factory and none of their parent's custom tools), nor do
  sessions of a stock omp.
- `loadMode: "essential"`, so it is always in the model's tool list; omp keeps
  SDK custom tools active under `--tools <list>` and `--no-tools`.
- Parameters: `{ reason: string }`, a short sentence on what the agent needs.
  The runner collapses whitespace, trims it and keeps at most 300 characters.
- Effect: `session.sessionManager.appendCustomEntry("omp-web-attention",
  { reason })` on the session that runs it, persisted as
  `{"type":"custom","customType":"omp-web-attention","data":{"reason":…},…}`.
  It does not change the session title.
- The tool description tells the model when to call it: at the end of a turn
  that waits on the user. Not for progress updates, not mid-task.
- The entry type and the 300-character cap are a literal on each side, as for
  `omp-web-history-navigation`: `runner/src/attention.ts` and
  `lib/omp/session-files.ts`.

## Detection on disk

`scanTailMessage` (`lib/omp/session-files.ts`) already walks the tail window
backwards to the newest message entry. It continues backwards until the newest
real `role: "user"` message; an `omp-web-attention` custom entry found before
that sets `attention: { reason, at }` (`at` is the entry's timestamp, `""` when
missing). User-role messages omp marks `synthetic: true` do not count as the
user answering, so they neither stop the walk nor clear the marker. An
assistant message with a tool call newer than the marker means the agent kept
working, so the marker is ignored; the call that requested attention is older
than its marker and does not cancel it. Only the
32 KiB tail window is scanned; a marker followed by more than 32 KiB of later
entries without a user message is not found (accepted: the agent calls the tool
as its last act).

`SessionInfo.attention?: { reason: string; at: string }` carries it to the
client through the existing per-host session lists. The session list refreshes
on `agent_end` already, so a marker written during a run appears when the run
ends.

## Sidebar

- A **Needs attention** section above the Workspaces header. Hidden while no
  session needs attention.
- The set: `awaitingInput` sessions from the `running` channel, plus sessions
  whose `attention` is set and that are not running.
- Same structure, rows and badges as Workspaces: host group (when host groups
  show), then workspace row, then session rows, rendered with the same
  components. Sessions stay in Workspaces too.
- Always alphabetical: hosts by name, workspaces by label, sessions by display
  title. The user's sort mode, pins and manual order do not apply.
- No pin control, no drag or move, no sort/filter/add buttons in the section
  header. Search and the running filter do not filter it.
- Workspace rows in the section start expanded and show every attention
  session (no "show more"). Collapsing a host or workspace there does not
  affect Workspaces.
- A session row's tooltip carries the reason when the attention comes from
  the tool.
- The section scrolls on its own and takes at most about 40% of the sidebar
  height, so Workspaces stays reachable.

## Approaches considered

1. **Title emoji convention** (`⏸️`, `❓`, `🚧` from a personal
   `session_phase` extension). Rejected: omp-web would hardcode one user's
   convention.
2. **Live extension status** (`ctx.ui.setStatus`). Rejected: in-memory only;
   the session would leave the section when its idle process is reaped while
   still waiting.
3. **Bundled tool writing a session entry** (chosen). Works for every agent of
   every omp-web session, persists, needs no omp change.
4. **Native omp attention API**. Cleanest, but needs an upstream oh-my-pi
   change; can replace 3 later.

## Non-goals

- Notifications: the existing `input` notification is unchanged.
- Inferring attention from free text ("Should I…?").
- Showing attention for terminal-only omp sessions.
