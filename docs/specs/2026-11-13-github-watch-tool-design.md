# GitHub watch agent tool

Status: draft for approval, 2026-11-13.

## Intent

Agents that open a pull request (or work from an issue) need to hear about what happens on it afterwards: review comments, bot reviews, CI results, the merge. Today this is the external `pr-watcher` service on the main server, registered with a CLI (`pr-watcher add OWNER/REPO#N --session <id>`). It exists only on the machine where it was installed: a session the cluster placed on a worker (`ai-worker-2`, say) cannot register a watch, although delivery would reach it, because delivery goes through omp-web.

This design makes watching part of omp-web: an agent tool, like `list_sessions`, `new_session` and `send_to_session` (`lib/agent-tools.ts`), answered by the web server, so a session on any host can use it.

## Goals

- An agent registers a watch on a GitHub pull request or issue for its own session with one tool call, from any host.
- Updates arrive in that session as messages, with no browser tab open, until the PR/issue is merged or closed or the agent stops watching.
- Watches survive a web-server restart.
- An agent that discovers the tool learns that it needs `gh` on the web server; a call that cannot work says why, in words the agent can relay to the user.

## Non-goals

- Retiring the `pr-watcher` service (later, once this has run for a while).
- A Settings UI listing watches, and a `list_github_watches` tool.
- Webhooks or any GitHub authentication other than the `gh` login.
- Watching repositories, branches or discussions.

## Anti-goals

- Never use credentials other than the web-server machine's `gh` login; never read or store a GitHub token.
- Never deliver the logged-in account's own comments back to the agent (its own replies would loop).
- Never deliver an update twice, nor lose one, because the session was busy, the host offline or the server restarted.

## Approaches

1. **`gh` in the web server (chosen).** The web server runs `gh` and polls; delivery reuses the agent-tool delivery path. Works for sessions on every host, with `gh` installed and logged in once, on the server machine.
2. **`gh` on the calling session's host**, through a new daemon op. Rejected: every worker would need `gh` installed and logged in (the gap this design closes), and it needs a link protocol bump.
3. **GitHub webhooks** (`gh webhook forward`). Rejected: needs repository admin rights and a preview `gh` extension, and does not work on repositories one only contributes to.

## Design

### Tools

Two tools join `AGENT_TOOL_NAMES` / `AGENT_TOOL_DEFINITIONS`, behind the same **Agent tools** setting (`agentToolsEnabled`) and `AgentToolGuard` rate limit as the others:

- `watch_github { target }`: `target` is `OWNER/REPO#N` or a `https://github.com/OWNER/REPO/pull/N` or `/issues/N` URL. GitHub numbers PRs and issues in one sequence, so the tool asks GitHub which one `N` is and watches it accordingly. Watches for the calling session. Calling it again for a target the session already watches changes nothing and returns the existing watch. Returns `{ watching: true, target: "OWNER/REPO#N", kind: "pull_request" | "issue", state, title }`.
- `unwatch_github { target }`: ends the calling session's watch. Returns `{ watching: false, target }`; unwatching something not watched is not an error.

Both descriptions begin: "Requires the GitHub CLI (`gh`) on the PATH of the omp-web server machine, logged in (`gh auth login`)." `watch_github`'s description also lists what is delivered and when the watch ends.

A session may hold at most 20 watches; the 21st is refused with an error naming the limit.

### `gh` availability

Every call first runs `gh auth status` (through `project-command-env.ts`'s environment, without omp-web's secrets). Errors returned to the agent:

- `gh` not found: "`gh` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run `gh auth login` there."
- not logged in: "`gh` is not logged in on the omp-web server machine. Ask the user to run `gh auth login` there."
- target not found or not accessible to the account: `gh`'s own message.

If `gh` stops working later (logged out, uninstalled), polling fails; the watch is kept and the session is told once, with the same text, and again once polling recovers.

### What is delivered

Each message starts `GitHub update (omp-web): OWNER/REPO#N` and carries the item's title and URL.

Pull requests:

- new conversation comments, inline review comments and reviews (with their state: approved, changes requested, commented), except those written by the logged-in `gh` account;
- CI: one message per head commit once every check run and commit status on it has reached a terminal state, naming each failed, cancelled or timed-out check; a new push starts over for the new head;
- merged or closed: one final message, after which the watch ends.

Issues:

- new comments, except the logged-in account's;
- closed (with its reason: completed or not planned): one final message, after which the watch ends.

Only activity after the watch starts is delivered: registration records the current comments, reviews and CI state as the baseline. If CI on the current head is already finished at registration, that result is not delivered.

Delivery goes through the agent-tool `deliver` operation (`createAgentToolOps` in `lib/rpc-manager.ts`): `prompt` when the session is idle, `followUp` when it is running, so an update never interrupts a turn. The message is not sender-attributed as a session (`formatAttributedMessage`); its prefix names its origin.

### Polling and storage

- Each watched item is polled every 60 s with one `gh api graphql` request (comments, reviews, review threads, head commit status rollup, state), shared by every session watching it.
- Watches and their cursors (last delivered comment/review ids or timestamps, last reported head SHA) live in SQLite in `<agent dir>/omp-web/github-watches.sqlite`, opened like the notification store (`bun:sqlite`, WAL, busy timeout, `close(true)`).
- A cursor advances only after `deliver` accepted the message. An update that cannot be delivered (host offline, session not resumable right now) stays pending and is retried on the next poll, so nothing is lost and nothing is sent twice.
- Polling starts with the server and stops with it; a restart resumes from the stored cursors.

### Session lifecycle

- When omp moves a session to a new ID (copy-on-write ownership), its watches follow the new ID through the existing registry aliases.
- Deleting a session ends its watches. Archiving keeps them; deliveries to an archived session stay pending until it is restored or deleted.

## Left to the builder

- The exact GraphQL query, and how the 60 s interval is spread across many watches.
- Message formatting beyond the prefix (length caps for long comment bodies, how many items go in one message when several arrive in one poll).
- Where the poller is started (`instrumentation.node.ts` beside the other server singletons, with the `globalThis` registry pattern).
