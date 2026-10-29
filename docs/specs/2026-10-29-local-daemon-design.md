# Local daemon: omp runs survive web-server restarts

## Goal

Restarting or redeploying the ompweb web server never interrupts an omp run, on
this machine or any linked host. That frees the web server to change and restart
often.

Today the web server owns the local omp children (`LocalHost` spawns them over
stdio), so every restart kills them, and auto-resume restarts them with a
resume prompt. Remote hosts (`docs/specs/2026-10-28-remote-hosts-design.md`)
already keep their children alive while the link is down, but a web-server
restart still kills them as orphans.

## Decisions

- **The local daemon is required.** This machine is reached only through a
  local `ompweb host` daemon, linked over loopback. `LocalHost`'s direct spawn
  path is removed; there is one code path for every host.
- **The daemon is its own service** (systemd unit / launchd agent / Windows
  service), installed next to the web service.
- **Restarts adopt live children.** A restarted web server takes over the omp
  children the daemon still runs instead of killing them.
- **Dev mode does not take the local daemon.** Only the production web server
  writes the daemon's `host.json`; a dev server shows "This machine" offline.
  (The daemon dials out, so a takeover would need it to follow every rewrite of
  `host.json`, and production and dev would then pull it back and forth.)

## Non-goals

- Changing omp. Gaps in omp's RPC that block a clean adoption are handled with
  the fallbacks below and reported upstream separately.
- Keeping runs alive across a daemon restart. The daemon owns the children;
  restarting it ends them, and auto-resume handles that as today.
- Multiple web servers sharing one daemon at the same time.

## Process layout

```
ompweb (web service)  ──link over 127.0.0.1──▶  ompweb host (daemon service) ──▶ omp children
          └──link over https/tailnet──▶  ompweb host on the Mac ──▶ omp children
```

- **"This machine" is a linked host with the fixed id `local`.** It is shown as
  "This machine", listed first, and cannot be revoked or renamed in Settings →
  Hosts.
- **Session file operations** (`session-ops.ts`) run in the daemon, as they do
  for remote hosts. The web server keeps no direct session-file reads for
  `local`, so the two paths cannot drift.
- **Local link bootstrap.** On start, the web server makes sure a host record
  `local` exists with a token, and writes the daemon's
  `<agent dir>/omp-web/host.json` (`{url, token}`, mode 0600) with its own
  loopback URL. The daemon re-reads `host.json` when its link gets 401, so a
  web server that regenerated the token is picked up without restarting the
  daemon. Loopback links use `http://` without `--allow-http`.

## Adopting live children

On `hello`, for each listed `{ch, sessionId}` that has no wrapper on the web
server:

1. Look up `sessionId` in that host's session list to get the file and cwd. A
   child whose session is unknown (never written, or deleted) is killed, as
   today.
2. Create an `AgentSessionWrapper` on the existing channel with `adopted: true`.
   It skips spawn, the `ready` wait and the initial protocol negotiation.
3. Re-sync the protocol: send `negotiate_protocol` again; drop partial chunked
   frames until the next complete one.
4. Rebuild state: `get_state` (identity, model, streaming/compacting, queue),
   `get_subagents`, `get_btw_history`. If omp reports a run in progress, mark
   the wrapper running; the next frames continue it, and the committed message
   shows anything streamed before the restart.
5. Register the wrapper under its session id and publish it on the `running`
   channel; browsers reopening the session attach as on any stream reopen.

**Pending requests are replayed by the daemon.** omp (checked at oh-my-pi
`3e3c488a58`) has no command that lists pending `extension_ui_request`s or
`host_tool_call`s, and neither ever times out, so a request the web server
missed would block the run forever. The daemon already sees every line, so it
keeps, per channel, the raw lines of each blocking request still open:

- opened by a `host_tool_call` or an `extension_ui_request` whose method is in
  `BLOCKING_UI_METHODS` (decoded with `RpcFrameDecoder`, so chunked frames are
  kept whole);
- closed by the matching `host_tool_result` / `extension_ui_response` written to
  stdin, or a `host_tool_cancel` / UI cancel from omp.

`hello` carries them per channel (`channels[{ch, sessionId, pending: string[]}]`,
capped at 1 MB per channel; over the cap the channel is not adoptable and takes
the kill-and-resume path). The adopted wrapper feeds them through its normal
frame handling, so dialogs reappear, input-needed notifications fire, and browser
tool calls reach a tab again. This changes the hello shape, so
`LINK_PROTOCOL_VERSION` becomes 3.

**Framing.** omp answers `negotiate_protocol` every time, and every ompweb child
is already on protocol v2, so the adopted wrapper starts its decoder at v2,
drops `rpc_chunk` records until the first record of a new frame, and sends
`negotiate_protocol` again.

**Adoption failure** (any of the re-sync commands time out after
`GET_STATE_TIMEOUT_MS`): the child is killed and resumed once through the
existing orphan path, so no session ends up with two writers.

Auto-resume remains for children that really died: a daemon restart, a crash,
or an adoption failure.

## Failure cases

| Case | Behavior |
|---|---|
| Web server restarts, daemon fine | Runs continue; adopted on `hello`; no resume prompt. |
| Daemon restarts or upgrades | Children end; sessions that were running resume once (existing auto-resume). |
| Web and daemon on different link protocol versions | 426; "This machine" shows "needs upgrade"; new sessions there are disabled until the daemon is restarted on the new version. |
| Dev server running | It never writes `host.json`, so the daemon stays linked to production; dev shows "This machine" offline. |
| Daemon not installed or not running | "This machine" shows offline with "start the ompweb-host service"; new local sessions are disabled. |
| `host.json` token stale (web regenerated it) | Daemon gets 401, re-reads `host.json`, redials. It exits only if the file still holds the rejected token. |

## Installing and upgrading

- `ompweb systemd install` and `ompweb launchd install` install two units: the
  existing web unit and `ompweb-host` (`ompweb host`), both restarting on
  failure. Uninstall removes both.
- Windows (`lib/windows-service.ts`, tray): the same split, a second service
  for the daemon. The tray shows both states.
- **Existing installs:** on first start after the upgrade, if no local daemon
  links within 10 s, the web server shows a one-time banner with the exact
  command to install the daemon service (it does not install services itself).
  Until then "This machine" is offline as above.
- **Upgrades:** an upgrade replaces the package for both. The web unit restarts
  as today. The daemon unit restarts only when `LINK_PROTOCOL_VERSION`
  changed; otherwise the old daemon keeps running the live children and new
  code takes effect at its next restart.

### This machine's deployment

`/opt/omp-deployment/bin/ompweb-deploy` gains a daemon unit (`ompweb-host`)
from the same release:

- It restarts `ompweb-api` with the existing probes and rollback.
- It restarts `ompweb-host` only when the release's `LINK_PROTOCOL_VERSION`
  differs from the running daemon's (read from `GET /api/hosts`).
- Rollback restores the previous release for both units.

## Dev mode

When `NODE_ENV` is `development`, the web server skips `ensureLocalHostLink`:
the daemon stays linked to production, and dev shows "This machine" offline.

## Testing

- **Unit:** adoption builds a wrapper from `hello` without spawning; the
  re-sync order; each fallback in the gaps table; adoption failure kills and
  resumes once; local bootstrap writes `host.json` and re-reads on 401.
- **Integration:** a real web server and a real daemon (fake omp). Start a run,
  restart only the web side; the same omp pid keeps streaming, no resume prompt,
  no duplicated or lost frames. Restart the daemon; the run resumes once.
- **Deploy smoke:** deploy a web-only change on this VM during a run; the run
  continues.

## Documentation

AGENTS.md (process layout, adoption, the required daemon), README (two services,
install commands, dev mode note), DESIGN.md (the host seam no longer has a
direct path), CHANGELOG.
