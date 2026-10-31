# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

Community: [Join the OMPWEB Discord](https://discord.gg/evqgGzRfM5)

A clean, modern web UI for the [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) coding agent. It reads your local omp sessions and gives you a browser workspace to chat with the agent, browse projects, manage settings, and preview files.

![ompweb — live session demo](docs/demo.gif)

<details>
<summary>Screenshots (light / dark)</summary>

![ompweb — light theme](docs/screenshot-light.png)

![ompweb — dark theme](docs/screenshot-dark.png)

</details>

## Requirements

- [omp](https://github.com/can1357/oh-my-pi) installed and available on your `PATH` (or specified via `OMP_WEB_OMP_BIN`)
- Node.js `>= 24`. The server runs on [Bun](https://bun.sh), which installs automatically as a dependency of the npm package (a Bun on your `PATH` is used if the bundled one is missing)

The **Steer** action on a queued follow-up requires an omp runtime with the `promote_queued_message` RPC command (not available in omp 18.1.16). Older runtimes report an error and leave the message queued as a follow-up; ompweb does not send a duplicate steering message.

Queue **Delete** and **Edit** additionally require `remove_queued_message`. Deletion is confirmed by OMP before the chip disappears; editing recalls text only after cancellation succeeds. Unsupported runtimes or messages that are no longer pending leave the queue unchanged and display a notice.

The queue panel shows omp's own queue (`queuedMessages` in `get_state` and `queue_update` events, omp 18.4.4 or later), so every device viewing a session sees the same queued messages. **Stop** moves the text of messages still waiting in the queue back into the composer instead of letting the agent run them; a steer the model already picked up through live steering still runs. Older omp runtimes show no queue panel, and Stop cannot take queued messages back.

## App installation behind authentication

To install the web app, sign in first and use your browser's installation menu.
The single manifest link requests `/api/manifest` with credentials; that endpoint
uses the existing web-password guard and private, revalidating caching. Its
192×192 and 512×512 PNG icons are embedded from the packaged assets because
Android's native installer fetches ordinary icon URLs without authentication
cookies. The app still launches at `/` with scope `/`.

Keep Cloudflare Access and application authentication enabled; no public
manifest exception or Access bypass rule is needed. This does not add offline
support. Local Chromium verification covered cookie-gated metadata with HTTP
icon URLs blocked (zero installability errors). The owner also confirmed that
installation on a physical phone works as expected behind Cloudflare Access.

Skill startup notices require an OMP runtime with `get_skill_diagnostics`,
`set_skill_startup_diagnostics`, and `skill_diagnostics_update`. Conflicts and
redundant installations appear above the composer when its OMP session starts;
an empty new-chat page does not start OMP just for diagnostics. **Details** shows
the resolved default, variants, identical copies, backing paths, sources, and
selection reason. The **×** button dismisses the notice for that session until
the diagnostic report changes. **Turn off** and **Settings →
Interface & Behavior → Skill startup notices** use OMP's persisted
`skills.showStartupDiagnostics` preference, not a separate browser setting.
**Settings → Extensions & Tools → Skills → View skill diagnostics** remains
available for a selected running session when notices are off. Inspection does
not resume stopped sessions. Missing support or no running session is unavailable,
not a clean result.

## Notifications

Turn on notifications in **Settings → Notifications**. Each browser keeps its own
settings: which events notify (task finished, waiting for input, run failed,
model switched automatically) and what happens while you use omp-web in another
tab (an in-app toast, or always a system notification). Nothing is shown for the
session you are viewing. Clicking a notification opens its session.

- **Push** reaches the browser even when no omp-web tab is open. It needs a
  secure context (HTTPS through your reverse proxy, or `localhost`), and the
  omp-web server needs outbound HTTPS access to the browser vendors' push
  services. omp-web generates its push (VAPID) keys on first use and stores them,
  with the device list and the notification history, in its data directory
  (owner-only), so they survive restarts.
- On **iPhone and iPad** (iOS 16.4 or later), push works only in the app added
  to the Home Screen.
- In a secure context without push support, system notifications appear while
  an omp-web tab is open. Over plain HTTP on a non-localhost address, browsers
  allow no system notifications: only the in-app toasts shown while you use
  omp-web remain.
- Desktop browsers show notifications through the operating system's
  notification center. Push delivery needs the browser process running.

Completion notifications use omp's `prompt_result` and `session_settled` RPC
frames (omp 18.3.1 or later).

## Quick Start

**Run directly without installing:**

```bash
npx @kahme247/ompweb@latest
```

or
```bash
nix run github:kahme247/ompweb
```

**Or install globally:**

```bash
npm install -g @kahme247/ompweb
ompweb
```

**Or download the single binary** (no Node or npm): see [Single binary](#single-binary).

Open [http://127.0.0.1:30177](http://127.0.0.1:30177) in your browser.

### CLI Options

```bash
ompweb --port 8080                         # Custom port
ompweb --hostname 0.0.0.0                  # Listen on network
ompweb hash-password                       # Print the value for OMP_WEB_PASSWORD_HASH
ompweb --no-open                           # Don't auto-open the browser
ompweb --install-tray                      # Install Windows System Tray service & Desktop shortcuts
ompweb --uninstall-tray                    # Uninstall Windows System Tray service & shortcuts
ompweb --tray                              # Start background System Tray manager
ompweb systemd install                     # Install Linux systemd user services (web + ompweb-host daemon)
ompweb launchd install                     # Install the macOS launchd agents (web + ompweb-host daemon)
ompweb --help                              # Show help
ompweb --version                           # Show version
```

### Password protection

omp-web **never passes a plaintext password to the server**, because every
`omp` session inherits the server's environment: an agent running `env` would
print the password into its session file and send it to the model provider.
`--password` stops `ompweb` at startup. An `OMP_WEB_PASSWORD` still works for
now: `ompweb` hashes it at startup, keeps it out of the server's environment,
and logs a warning with the hash to put in `OMP_WEB_PASSWORD_HASH` instead.
Switch soon: agents can still read the plaintext from the `ompweb` launcher
process, and each start makes a new hash, so every restart signs all browsers
out. Setting both variables stops `ompweb`; remove `OMP_WEB_PASSWORD`.

Generate a hash instead and give that to the server:

```bash
ompweb hash-password                       # asks twice, input hidden
echo "a-long-random-password" | ompweb hash-password   # or pipe it in

OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' ompweb
```

`ompweb hash-password` reads the password from stdin — never from a command
line argument — so it stays out of your shell history and out of `ps` output.
The hash is scrypt (N = 2^15, r = 8, p = 1) with a fresh 16-byte salt, printed
in the self-describing form `scrypt$<ln>$<r>$<p>$<salt>$<digest>`. Anyone who
reads the hash cannot sign in with it, and it cannot be turned back into the
password.

Sessions are not signed with the password hash. A random signing key is created
on first start in `~/.omp/agent/omp-web/web-auth-secret.json` (mode `0600`) and
mixed with the hash, so changing the password still signs everyone out while the
stored hash alone is never enough to forge a session.

The service installers (`ompweb systemd install`, `ompweb-launchd install`, the
Linux tray, and the Windows service) still accept `OMP_WEB_PASSWORD` at install
time and hash it before writing it to their configuration. Only the hash is
stored.

On Windows, the tray and background service read `OMP_WEB_PASSWORD_HASH` from
your user or system environment (for example `setx OMP_WEB_PASSWORD_HASH
"scrypt$…"`) each time they start the server, not from the environment they were
started with. Changing or removing the hash takes effect at the next server
restart, without signing out of Windows.

### Two services: the web server and the local daemon

ompweb runs this machine's `omp` sessions through a small daemon, `ompweb host`,
linked to the web server over loopback. The service installers (`ompweb systemd install`,
`ompweb launchd install`, `ompweb --install-tray`) install both: the web
service and `ompweb-host`. Uninstall removes both.

**Running ompweb in the foreground** (`ompweb` in a terminal, or `npx
@kahme247/ompweb@latest`) installs no service, so nothing runs the daemon: keep
`ompweb host` (with npx: `npx @kahme247/ompweb@latest host`) running in a
second terminal. Without it "This machine" stays offline. The web server writes
the daemon's link when it starts, so start the web server first.

- **Restarting or redeploying the web server does not interrupt runs.** The daemon
  keeps the omp processes running; the restarted web server takes them over, with
  no resume prompt, and dialogs or tool calls omp was waiting on reappear.
- **Restarting the daemon does end runs** (it owns the omp processes). With auto-resume
  on, sessions that were running resume once. `ompweb systemd restart` restarts the
  web service only; upgrades restart the daemon only when its link protocol version
  is outside the range the new release supports.
- **First start after an upgrade:** if no daemon has linked after about 90 seconds,
  ompweb shows a banner with the install command for your platform. It never installs
  services itself. Until the daemon runs, "This machine" shows offline and new
  sessions on it cannot start.
- **It is a host like any other.** Rename "This machine" in **Settings → Hosts**
  (clear the name to reset it); it cannot be revoked. The web server writes the
  daemon's link (`~/.omp/agent/omp-web/host.json`, mode `600`) at startup, only
  for a loopback bind address.
- **Development:** `npm run dev` does not take the daemon (see
  [Development](#development)).

### Single binary

Each [release](https://github.com/kahme247/ompweb/releases/latest) also ships
ompweb as one compiled program with the files it serves beside it:
`ompweb-linux-x64.tar.gz`, `ompweb-linux-arm64.tar.gz`, `ompweb-darwin-x64.tar.gz`,
`ompweb-darwin-arm64.tar.gz` and `ompweb-windows-x64.zip`. It needs no Node, npm
or Bun; only omp must be installed. The x64 builds use Bun's baseline runtime, so
they also run on CPUs without AVX2. Each archive carries the licenses of what it
bundles in `licenses/`.

```bash
tar -xzf ompweb-linux-x64.tar.gz -C ~/.local/share   # unpacks ompweb-linux-x64/
~/.local/share/ompweb-linux-x64/ompweb               # the web server: same options and environment variables as above
~/.local/share/ompweb-linux-x64/ompweb host          # the local daemon, in a second terminal
```

- **Keep `ompweb` in its directory.** It serves `dist/`, `public/` and the other
  files from the directory it is in (a symlink to it on your `PATH` works), or
  from `OMP_WEB_PACKAGE_DIR` when that is set.
- **macOS** quarantines downloads: run `xattr -dr com.apple.quarantine ompweb-darwin-arm64`
  once before the first start.
- **No tray, service installers or in-app update.** To update, stop `ompweb` and
  `ompweb host`, replace the directory with the new release, and start both again;
  **Settings → System** links the release page when a new version is out.
  Your sessions and settings live in `~/.omp`, not in that directory.
- **As systemd user services**, write the two units yourself (adjust the paths;
  add omp's directory to `PATH`, or set `OMP_WEB_OMP_BIN`):

```ini
# ~/.config/systemd/user/ompweb.service
[Unit]
Description=ompweb web service

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb --no-open
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
# OMP_WEB_PASSWORD_HASH, PORT and OMP_WEB_HOSTNAME go here, as for ompweb-systemd.
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/ompweb-host.service
[Unit]
Description=ompweb host daemon
# It exits until the web server has written its link: keep restarting.
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb ompweb-host
```

  On macOS, two launchd agents (`ProgramArguments` `…/ompweb --no-open` and
  `…/ompweb host`, with `RunAtLoad` and `KeepAlive`) do the same; on Windows, two
  Task Scheduler tasks that run `ompweb.exe --no-open` and `ompweb.exe host` at logon.

### Run as a Windows Service (System Tray)

Install ompweb as a Windows background service with a system tray icon and autostart at login:

```bash
ompweb --install-tray
```

Manage it from **Settings → System & Updates → Windows Background Service**, or via CLI:

```bash
ompweb --tray          # Start the tray manager
ompweb --uninstall-tray
```

Shortcuts are created on the Desktop and Start Menu. The service restarts automatically and shows the current port and status in the tray. The install also registers the [local daemon](#two-services-the-web-server-and-the-local-daemon) as a second scheduled task (`ompweb host`); the tray shows both states.

### Run as a macOS Service (launchd)

Install ompweb as a launchd user agent that starts at login and restarts on crash:

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

Manage it with:

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd status      # Show service state
npx --yes @kahme247/ompweb@latest ompweb-launchd uninstall   # Stop and remove
```

The service runs `npx --yes @kahme247/ompweb@latest`; pass a package spec to pin a
version, e.g. `ompweb-launchd install @kahme247/ompweb@0.3.6`. All
[environment variables](#environment-variables) are read at install time and baked
into the plist, plus `OMP_WEB_PKG` (package spec, same as the positional argument).
As a service, the browser is **not** auto-opened by default — install with
`OMP_WEB_NO_OPEN=0` to restore that.

```bash
OMP_WEB_PASSWORD=secret npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

`OMP_WEB_PASSWORD` is hashed at install time; the plist holds the hash, never
the password. Pass `OMP_WEB_PASSWORD_HASH` to install a hash you generated with
`ompweb hash-password`.

When binding to a non-loopback host, require authentication (`OMP_WEB_PASSWORD_HASH`
or equivalent access control) and HTTPS through a trusted reverse proxy or VPN.
Never expose the unauthenticated web UI or send its password/session cookie over
plaintext HTTP.

Logs go to `~/Library/Logs/ompweb/ompweb.log` (web) and
`~/Library/Logs/ompweb/ompweb-host.log` (the
[local daemon](#two-services-the-web-server-and-the-local-daemon)). The plists live at
`~/Library/LaunchAgents/com.kahme247.ompweb.plist` (mode 600; the password
hash — not the password — is stored there) and
`~/Library/LaunchAgents/com.kahme247.ompweb-host.plist`.

### Run as a Linux Service (systemd)

Install ompweb as a systemd **user** service that starts at login and restarts
on crash:

```bash
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd install
```
The installer creates `~/.omp/agent/web-service.env` automatically with mode
`600`; no manual file creation is required. The explicit `--package` form makes
`npx` run the systemd executable from the selected package.

To bind the service to all IPv4 interfaces for LAN access, set a password while
installing:

```bash
OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='change-me' \
  npx --yes --package=@kahme247/ompweb@latest ompweb-systemd install
```

The password is hashed before it is written to `web-service.env`.

Manage it with:

```bash
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd status    # Show service state
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd restart   # start / stop / restart
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd uninstall # Stop and remove
```

The service runs the locally installed `ompweb` binary resolved at install time
(override with `OMP_WEB_SYSTEMD_BIN`). Runtime configuration lives in
`~/.omp/agent/web-service.env` — the tray (or any editor) can change the port,
hostname, and password hash there and just restart the service; no reinstall
needed.
Install-time [environment variables](#environment-variables) are baked into
that file. As a service, the browser is **not** auto-opened by default. The
units live at `~/.config/systemd/user/ompweb.service` and
`~/.config/systemd/user/ompweb-host.service` (the
[local daemon](#two-services-the-web-server-and-the-local-daemon)); logs go to
the journal:

```bash
journalctl --user -u ompweb -u ompweb-host -f
```

On a headless server, enable user lingering if the service must keep running
after the last login session ends:

```bash
loginctl enable-linger "$USER"
```

### Linux System Tray (KDE Plasma and compatible)

On Linux, `ompweb-tray` registers a StatusNotifierItem tray icon with a context
menu: open the web UI, copy its URL, start/stop/restart the systemd service,
view logs, expose the web UI to the network, change the port, set the web
password, toggle autostart, and quit the tray.

```bash
npx --yes @kahme247/ompweb@latest ompweb-tray --install      # Icons + autostart + start tray
npx --yes @kahme247/ompweb@latest ompweb-tray --status       # Tray and service status
npx --yes @kahme247/ompweb@latest ompweb-tray --uninstall    # Remove autostart, stop tray
```

**Expose to Network** rebinds the service from `127.0.0.1` to `0.0.0.0` so the
web UI is reachable from your LAN or VPN (e.g. Tailscale). Leaving loopback
requires a web password — the tray prompts for one via `kdialog`/`zenity` when
needed, and stores its hash. **Change Port…** and **Set Web Password…** edit
`~/.omp/agent/web-service.env` and restart the service. When binding to a
non-loopback host, use HTTPS through a trusted reverse proxy or VPN for remote
access.

"Start with Plasma" in the tray menu toggles a desktop autostart entry at
`~/.config/autostart/ompweb-tray.desktop`. Requires a running StatusNotifierItem
host (KDE Plasma, and most Wayland/X11 desktops).

## Run sessions on another machine

One ompweb can start and watch omp sessions on other machines. Each machine keeps
its own `omp` install, `~/.omp/agent` directory, sessions, and credentials;
ompweb only routes. The remote machine needs Node 24 and `omp` installed, and must
be able to reach the ompweb server over HTTP(S). It dials out, so it can sit behind NAT.

1. On the ompweb server, open **Settings → Hosts → Add host**, enter a name, and copy
   the token. The token is shown once; only its hash is stored.
2. On the remote machine, save the link. The token is read from stdin, never from
   an argument, so it does not show up in `ps`:

   ```bash
   npx @kahme247/ompweb@latest host login --url https://your-ompweb.example.com
   ```

   Paste the token when prompted (or pipe it in). It is saved to
   `~/.omp/agent/omp-web/host.json` with mode `600`.
3. Start the link and leave it running:

   ```bash
   npx @kahme247/ompweb@latest host
   ```

   The host shows **online** in Settings → Hosts, the sidebar gets a group for it,
   and the new-session screen gets a host picker.

`https://` is required. Plain `http://` is accepted only for loopback addresses, or
with `--allow-http` (for example on a tailnet):

```bash
npx @kahme247/ompweb@latest host login --url http://100.64.0.1:30177
npx @kahme247/ompweb@latest host --allow-http
```

If the connection drops, the daemon reconnects by itself (1 s backoff doubling to
60 s; 3 s at most for the web server on the same machine). After a failed dial it
re-reads its saved link, so a web server that came back on another port is found
without restarting the daemon. After a network drop, runs keep going on the remote machine; the chat shows
an offline banner and the runs reattach when the link returns. A laptop that goes
to sleep (closing the lid, usually) pauses the daemon and its omp runs along with
everything else on it: they resume when it wakes, and the link returns then. A
docked or no-sleep setup keeps running with the lid closed. Revoking a host in
Settings closes its link and the daemon stops its omp processes.

Notes:

- **Service helpers:** `ompweb systemd install` and `ompweb launchd install` set up
  this machine's own daemon next to its web server (see
  [Two services](#two-services-the-web-server-and-the-local-daemon)). On the other
  machine you only need the daemon, and the helpers would also start a web server
  there, so run `ompweb host` under a supervisor of your choice that restarts it
  after failure to keep the link up across logouts or reboots.
  The daemon exits with code `1` when the server revokes its token or when its
  link protocol version is outside the range the server supports (older than the
  server's oldest supported version, or newer than the server: update ompweb on
  the older side), and `0` when a newer link for the same host replaces it.
  SIGTERM or SIGINT stops the daemon and its omp processes.
  A link is one-per-host, so never run two daemons with the same token.
- **The server's agent directory holds the host list** (`omp-web/hosts.json`).
  Starting the ompweb server with a different `PI_CODING_AGENT_DIR`, or losing
  that file, makes every host token unknown: each daemon is told it was revoked,
  stops its omp processes and exits.
- **Trust:** a linked host runs omp with full tool access on that machine for
  whoever controls the ompweb server or the token. Keep the token private and
  revoke it when a machine is retired.
- **Not available on remote hosts yet:** the file explorer, Git and worktree
  panels, directory browsing, and the Skills, Plugins, Agents and MCP settings only
  work on the machine ompweb runs on. Chat, session history, notifications and
  starting sessions work on every host.
- **Agent-started sessions:** with agent tools enabled, an agent can pass a `host`
  to `new_session` (it defaults to the agent's own host). A remote host asks for
  confirmation each time unless **Agents can start sessions here without asking**
  is switched on for it in Settings → Hosts. An agent running on a remote host
  always asks before it starts or messages a session on this machine.

## Features

- **Interactive Chat**: Real-time streaming conversation with your local `omp` agent — tool calls, thinking levels, token counts, cost, context gauge, queue controls, and interrupt & retry.
- **Message Copy**: Copy user messages and completed assistant replies as rendered plain text or original Markdown using the buttons below each message. Thinking, tool output, and message controls are excluded. Oversized messages that use the raw-text viewer copy their full source in either format.
- **Queue Deletion Confirmation**: Preview and confirm before cancelling queued follow-ups or steered messages in OMP. Requires native `remove_queued_message` support; already-delivered messages cannot be recalled.
- **Session Management**: Browse past conversations by project, fork sessions, branch within a session, archive/restore, import session files, and deep-link via URL.
- **Draft Recovery**: Unsent text stays scoped to its conversation or new-session workspace and is restored after Back/Forward navigation or reload in the same tab when browser storage is available (up to 50 drafts). Images and file attachments remain in memory only.
- **Live Plans & Subagents**: Collapsible panels pinned above the composer track live todo phases and running subagents (status, tool, retries, tokens/cost, nested tasks) with transcript dialogs and history recovery.
- **Tool Preset Picker**: Choose the toolset for new sessions in the composer — `none` / `default` (`read,bash,edit,write`) / `full` (all tools including subagents). Persists to localStorage.
- **File Explorer & Previews**: Browse workspaces side-by-side with chat; preview code, markdown, Mermaid, images, audio, PDFs, and diffs with allow-listed access.
- **Git Worktree Support**: Create, switch, and manage Git worktrees directly from the sidebar; sessions and file roots stay grouped by project.
- **Remote Hosts**: Link other machines (for example a MacBook) and run sessions there from one ompweb. The sidebar groups sessions by host. See [Run sessions on another machine](#run-sessions-on-another-machine).
- **Usage & Analytics**: Dashboard in **Settings → Usage** for tokens, costs, cache savings, and breakdowns by provider / model / day / project with SQLite persistence.
- **Windows System Tray & Service**: Background service, tray icon, logon autostart, and Desktop/Start Menu shortcuts (Windows).
- **macOS launchd Service**: LaunchAgent that starts at login, restarts on crash, and logs under `~/Library/Logs/ompweb`.
- **Linux systemd Service & Tray**: User service that starts at login and restarts on crash, plus a StatusNotifierItem tray icon with service controls (KDE Plasma and compatible desktops).
- **Notifications**: Desktop and mobile (PWA) notifications for finished tasks, questions waiting for an answer, failed runs, and automatic model switches, with Web Push when served over HTTPS. See [Notifications](#notifications).
- **Web-based Settings** (11 tabs): Interface & Behavior, Safety & Approvals, AI Model Defaults, API Keys & Providers, Usage, Agent & Intelligence (advisor, memory, compaction), Agents, Extensions & Tools (MCP, skills, plugins), Hosts, Notifications, System & Updates.
- **Slash Commands & Shortcuts**: Quick prompts (`/plan`, `/review`, `/fix`, `/test`, etc.), `⌘K` / `Ctrl+K` palette, and model/reasoning cycling.
- **UI Themes & Localization**: Warm paper light/dark themes plus an omp.sh-inspired midnight (`omp`) theme, chat font size & interface scale, with full English, Chinese (简体中文), and Japanese (日本語) translations.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Server port | `30177` |
| `OMP_WEB_HOSTNAME` | Server bind host | `127.0.0.1` |
| `OMP_WEB_PASSWORD_HASH` | Optional scrypt hash of the web login password, from `ompweb hash-password`. Required for a non-loopback bind | _None (auth disabled)_ |
| `OMP_WEB_TRUSTED_HEADER_SHA256` | SHA-256 hex digest of the secret a trusted reverse proxy sends in `X-Omp-Web-Auth` to skip the password for that request; see [Skipping the password on trusted networks](#skipping-the-password-on-trusted-networks) | _None (disabled)_ |
| `OMP_WEB_NO_OPEN` | Set to `1` to prevent auto-opening browser | `0` |
| `OMP_WEB_DISABLE_AUTOUPDATE` | Set to `1` to disable update checks and in-app updates; restart after changing | `0` |
| `OMP_WEB_NAME` | Name shown in browser tabs and installed-app names. `url`, `host` or `domain` (any case) uses the hostname the browser connected to, without port; localhost and IP addresses keep `omp web`. Any other value is used as-is. Restart after changing | `omp web` |
| `OMP_WEB_OMP_BIN` | Path to `omp` binary if not on `PATH` | _auto-detected_ |
| `PI_CODING_AGENT_DIR` | Custom omp agent directory | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI-compatible transcription endpoint URL. Leave unset to transcribe with `OMP_WEB_STT_MODEL` through omp's own credentials | _None_ |
| `OMP_WEB_STT_KEY` | Optional API key for the STT endpoint | _None_ |
| `OMP_WEB_STT_MODEL` | Model name for the STT endpoint. Without an endpoint: an omp speech-to-text model run with omp's logins, such as `openai-codex/codex-transcribe` (ChatGPT subscription; needs an omp version with that model) | _None (disabled without an endpoint)_ |

**`OMP_WEB_NAME` and installed apps.** An installed app (PWA) is usually named after the page it was installed from. If you later change `OMP_WEB_NAME`, or reach omp-web through a different address while `OMP_WEB_NAME` is `url`, `host` or `domain`, your operating system may rename the installed app as well. Leave `OMP_WEB_NAME` empty, or set a name that identifies this omp-web server whatever domain name or address is used to reach it.

## Skipping the password on trusted networks

omp-web cannot see the client's address itself, so it leaves the decision to
your reverse proxy. The proxy sends a secret in the `X-Omp-Web-Auth` header,
and omp-web holds only that secret's SHA-256 digest in
`OMP_WEB_TRUSTED_HEADER_SHA256`. A request whose header hashes to that digest
is treated as signed in. Everyone else still signs in with the password whose
hash is in `OMP_WEB_PASSWORD_HASH`; without a password there is nothing to
skip, and the header is ignored. Keep omp-web bound to `127.0.0.1` so only the
proxy reaches it.

Generate the secret and its digest without typing the secret on a command line,
so it never lands in your shell history. This writes a random secret straight
into an nginx include file readable only by root and nginx, and prints only the
digest:

```bash
secret=$(openssl rand -hex 32)
printf 'map $ompweb_trusted $ompweb_auth {\n    1        "%s";\n    default  "";\n}\n' "$secret" \
  | sudo install -m 0640 -o root -g www-data /dev/stdin /etc/nginx/ompweb-auth.conf
printf %s "$secret" | sha256sum | cut -d' ' -f1
unset secret
```

Use your nginx group in place of `www-data` (`nginx` on some distributions).
Set the printed digest as `OMP_WEB_TRUSTED_HEADER_SHA256`. The command history
holds only the commands, never the secret. On Windows, the tray and background
service read it from your user or system environment, like
`OMP_WEB_PASSWORD_HASH`.

Always generate the secret this way; do not reuse a password or another chosen
value. omp-web stores only a fast, unsalted SHA-256 digest, which is safe only
for a long random secret: anyone who reads the digest could recover a short or
guessable one with a dictionary attack.

With nginx, send the secret only to the address ranges you trust:

```nginx
# http {} context
geo $ompweb_trusted {
    default       0;
    10.0.0.0/16   1;
}
include /etc/nginx/ompweb-auth.conf;  # the map written above

# the location that proxies to omp-web
proxy_set_header X-Omp-Web-Auth $ompweb_auth;
```

Always set the header, as above: the empty value for other clients replaces any
`X-Omp-Web-Auth` a client sends itself. nginx only inherits `proxy_set_header`
from outer blocks when a block sets none of its own, so put this line next to
the location's other `proxy_set_header` lines.

Serve omp-web only for its own hostname: give its `server` block an explicit
`server_name`, and add a `default_server` block that answers every other
hostname with `return 444;`. Otherwise a web page that a trusted browser visits
can point its own domain name at your nginx (DNS rebinding) and have nginx add
the secret to its requests.

`geo` checks `$remote_addr`, the address that connected to nginx. When clients
reach nginx through another proxy, use the
[`realip` module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) to
replace it with the real client address. It does so only for connections from
addresses you list in `set_real_ip_from`:

- **Cloudflare (proxied DNS):** trust `CF-Connecting-IP`, and only from
  Cloudflare. List every range from <https://www.cloudflare.com/ips-v4/> and
  <https://www.cloudflare.com/ips-v6/>, and keep them up to date. Use this only
  when Cloudflare is really in front.

  ```nginx
  set_real_ip_from 173.245.48.0/20;  # ...one line per Cloudflare range
  real_ip_header   CF-Connecting-IP;
  ```

  Also refuse connections that come neither from Cloudflare nor from your
  trusted ranges. `$realip_remote_addr` is the address that actually
  connected, before `realip` replaced it:

  ```nginx
  geo $realip_remote_addr $ompweb_peer_allowed {
      default          0;
      173.245.48.0/20  1;  # ...every Cloudflare range
      10.0.0.0/16      1;
  }
  # in the server block
  if ($ompweb_peer_allowed = 0) { return 403; }
  ```

- **Cloudflare Tunnel (`cloudflared`):** the tunnel connects to nginx from
  `cloudflared`'s address (`127.0.0.1` when it runs on the same machine), so
  trust `CF-Connecting-IP` from there: `set_real_ip_from 127.0.0.1;` and
  `real_ip_header CF-Connecting-IP;`. Any local process can then send its own
  `CF-Connecting-IP` to nginx and claim a trusted address, and a local
  connection without that header keeps `127.0.0.1`, so listing `127.0.0.1` in
  `$ompweb_trusted` trusts every local process that connects to nginx.
- **Any other proxy or load balancer:**

  ```nginx
  set_real_ip_from  <proxy address or range>;
  real_ip_header    X-Forwarded-For;
  real_ip_recursive on;
  ```

  `real_ip_recursive on` reads `X-Forwarded-For` from the right and skips the
  hops listed in `set_real_ip_from`. Addresses a client adds itself are
  ignored.

## Development

```bash
git clone https://github.com/kahme247/ompweb.git
cd ompweb
npm install
npm run dev
```

The dev server runs at [http://127.0.0.1:30178](http://127.0.0.1:30178).

A dev server does not take over the local daemon: only the production web
server writes the daemon's `host.json`, so "This machine" shows offline in dev
and the daemon stays linked to your installed ompweb.

`npm run dev` runs the server with Bun hot reload. `npm run build` bundles the browser app into `dist/`, and `npm start` serves it on port 30177 (`npm run smoke` checks the result). `npm run dev:lan` binds the dev server to all interfaces. `npm run build:binary` builds the [single binary](#single-binary) for this machine into `release/` (`-- --target bun-linux-arm64` and the like for another platform; `npm run smoke -- --binary release/ompweb-linux-x64/ompweb` checks it).

### Checks

```bash
npm run typecheck   # Type check (TypeScript)
npm run lint        # ESLint
npm test            # Run test suite (bun test)
```

## License & Credits

- Forked from [agegr/pi-web](https://github.com/agegr/pi-web) (MIT) and adapted for [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
- Released under the [MIT License](./LICENSE).
