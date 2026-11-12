# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

Community: [Join the OMPWEB Discord](https://discord.gg/evqgGzRfM5)

A clean, modern web UI for the [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) coding agent. It reads your local omp sessions and gives you a browser workspace to chat with the agent, browse projects, manage settings, and preview files.

![ompweb — live session demo](docs/demo.gif)

<details>
<summary>Screenshots (light / dark)</summary>

![ompweb — light theme](docs/screenshot-light.png)

![ompweb — dark theme](docs/screenshot-dark.png)

</details>

## Requirements

- Nothing else for omp: ompweb ships its own [omp](https://github.com/can1357/oh-my-pi) build, `ompweb-omp` (beside the single binary, or as the `@kahme247/ompweb-omp-<os>-<arch>` optional dependency of the npm package). It reads your `~/.omp` settings, auth and sessions. `OMP_WEB_OMP_BIN` points ompweb at another one
- Node.js `>= 24`. The server runs on [Bun](https://bun.sh), which installs automatically as a dependency of the npm package (a Bun on your `PATH` is used if the bundled one is missing)

The **Steer**, **Delete** and **Edit** actions on a queued message are commands of the `ompweb-omp` channel (`promote_queued_message`, `remove_queued_message`). Deletion is confirmed by omp before the chip disappears; editing recalls text only after cancellation succeeds. A message that is no longer pending leaves the queue unchanged and displays a notice; ompweb does not send a duplicate steering message.

The queue panel shows omp's own queue (`queuedMessages` in `get_state` and `queue_update` events), so every device viewing a session sees the same queued messages. **Stop** moves the text of messages still waiting in the queue back into the composer instead of letting the agent run them; a steer the model already picked up through live steering still runs.

## App installation behind authentication

To install the web app, sign in first and use your browser's installation menu.
The single manifest link requests `/api/manifest` with credentials; that endpoint
uses the existing web-password guard and private, revalidating caching. Its
192×192 and 512×512 PNG icons are embedded from the packaged assets because
Android's native installer fetches ordinary icon URLs without authentication
cookies. The app still launches at `/` with scope `/`. Its `theme_color` and
`background_color` come from the manifest link's `?theme=` parameter: Chrome
refreshes an installed app's manifest without cookies, so the server renders the
selected theme's color (remembered in the `omp-theme-color` cookie) into the
link. Chrome 153 and later color an installed app's Android navigation bar from
it after Chrome next checks the app for manifest updates.

Keep Cloudflare Access and application authentication enabled; no public
manifest exception or Access bypass rule is needed. This does not add offline
support. Local Chromium verification covered cookie-gated metadata with HTTP
icon URLs blocked (zero installability errors). The owner also confirmed that
installation on a physical phone works as expected behind Cloudflare Access.

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

Completion notifications use the `ompweb-omp` channel's `prompt_result` and
`session_settled` frames.

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
ompweb preflight                           # Start the session omp once (as a new session would) and wait for its hello; exit 1 says why it failed
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

### Behind a reverse proxy

Forward WebSocket upgrades on `/api/events/link` (browsers) and `/api/hosts/link` (hosts); without the upgrade, a browser falls back to server-sent events after a few seconds. In nginx that means `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";`, and a `proxy_read_timeout` well above 30 s.

Hosts that [use the server's provider logins](#use-the-servers-provider-logins-on-a-host) also call `/api/hosts/broker/`, authenticated by their host token. That path must reach ompweb without the proxy's own authentication (a proxy login page or `auth_request` would block the daemon), without response buffering (it carries a long-lived event stream; in nginx, `proxy_buffering off;`) and without redirects.

Cluster members also fetch this machine's omp configuration from `/api/hosts/cluster-config/manifest` and `/api/hosts/cluster-config/file/<hash>` (exactly these two paths, `<hash>` being 64 hexadecimal digits), authenticated by their host token and answering members only. Unlike the broker's prefix, they must be reachable at exactly these paths, without the proxy's own authentication and without redirects.

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

### Transparent host pools

ompweb has at most one cluster: the first pool in `pools.json`. This machine is its master.
Creating the cluster adds this machine; an existing first pool that lacks it gains it on the
next join. The cluster appears in the sidebar as one group with one entry per Git repository.
Choose the cluster rather than a member; new independent sessions are placed on an eligible
member and receive an isolated local worktree. Adding a cluster project registers
its Git origin, not a central clone; adding another URL form of a repository the cluster
already has returns that project, unhidden, and keeps its stored origin. The selected member
prepares its checkout when the session starts and reports authentication, preparation, or
repository conflicts explicitly.
Standalone hosts, including the Mac, keep their own groups with typed paths and local clone
progress/cancellation. Resolving the owner for a new chat's attachment does not replace its
live composer or discard its draft and uploads. Placement and preparation failures are also
shown when command discovery or system-prompt inspection starts a session lazily; retrying
remains an explicit user action.

**Joining and leaving.** Each linked host has an **In the cluster** switch in **Settings →
Hosts**. Turning it on asks for a folder on that host for the checkouts the cluster creates
(default `<home>/ompweb-cluster`) and shows what changes. It needs the host online, its daemon
on link protocol 10 with the `gitOrigins` operation, and omp 15.13.1 or newer (a member always
uses this machine's provider logins); otherwise the disabled switch asks for an update of
ompweb or omp, or shows the host's unavailable status. While this machine is not a member yet,
its own daemon needs the same, and the switch asks to restart the host service on this machine
(or to update its omp).

- **Joining:** the host's Git projects are matched by repository: the same repository on
  several members is one cluster project, and its sessions are listed together. `git@github.com:a/b.git`
  and `https://github.com/a/b` are the same repository. Projects without a single Git `origin`,
  subfolders and linked worktrees stay on their node; the cluster shows them with the node's
  name, and a new session there starts on that node. No project files on the host change. A
  cluster project created from a host project keeps the name and alias it showed (the folder
  name when it had no name of its own). A visible checkout that matches a hidden cluster project
  makes that project visible again. This machine joins with the first host added while it is
  not a member (when the cluster is created, or on the next join of an older first pool without
  it): its Git projects then become cluster projects too, and new sessions in them start on any
  member with capacity, not in its own checkout.
  A second checkout of a repository already bound on that host also stays on its node.
  Projects inside, or containing, the chosen checkout folder stay on their node too; pick an
  empty folder that is not a parent of existing projects.
- **Leaving:** the host takes no new cluster sessions. Its matched projects are listed under
  the host again. Checkouts the cluster created inside the host's folder stay bound, so
  sessions the cluster started there stay under the cluster's projects. The cluster keeps the
  projects it gained from the host, so they may now be listed twice; hide any you do not want.
  This machine cannot leave, and the cluster stays when the last linked host does. Revoking a
  member removes it from the cluster the same way; while `pools.json` cannot be read, the revoke
  is refused.
- **Provider logins:** a member always uses this machine's provider logins, whatever its own
  [**Use this server's provider logins**](#use-the-servers-provider-logins-on-a-host) setting
  says; Settings shows it on and disabled. This is computed from membership, so leaving brings
  the host's own setting back. A member can read this machine's access tokens and stored API
  keys. Cluster placement skips a member that cannot take these logins (daemon below link
  protocol 9, or a link that does not share) before preparing a checkout there. The rest of
  this machine's omp configuration (`models.yml`, settings, MCP servers, skills, plugins and
  more) is mirrored to members too; see [Cluster members use this machine's omp
  configuration](#cluster-members-use-this-machines-omp-configuration).
- **Limits:** a host that is too slow to report its Git remotes within the time limit keeps
  the remaining projects on its node; leaving and joining again retries them. Only Linux hosts
  report capacity, so a macOS or Windows master never runs cluster sessions itself: its Git
  projects start only on other members, and a start fails with "No pool worker currently has
  eligible capacity" when none has capacity. A pool disabled through the API takes no new
  sessions, including this machine's Git projects moved into it, which then cannot start
  anywhere; its members still use this machine's provider logins. Settings cannot enable it
  again.

**Upgrade note.** After this update, every linked host already in the first pool uses this
machine's provider logins (it can read their access tokens and stored API keys), without a
confirmation having been shown. This includes a first pool disabled through the API, and a
host added to the first pool later through `PUT /api/hosts` or by editing `pools.json`:
membership, not scheduling, grants the logins. Each linked member needs an updated ompweb host
daemon (link protocol 9 at that release; cluster members now need link protocol 10, see the next
note) and omp 15.13.1 or newer; until the daemon is updated, cluster
placement skips that member, and a start fails when no other member is eligible. Before
updating, remove a host that should not receive the logins from the first pool using
`PUT /api/hosts` or editing `~/.omp/agent/omp-web/pools.json`; the old version has no
membership switch.

**Upgrade note (configuration).** Joining the cluster, and every cluster session on a member,
now need an ompweb host daemon at link protocol 10 on that member. Until a member's daemon is
updated, session starts there are refused ("Update ompweb on the host…"), cluster placement
skips it, and Settings → Hosts says it needs an update. Once its daemon is updated, every host
already in the first pool receives this machine's configuration, secrets included (API keys,
MCP environments and headers, tokens), automatically and without a confirmation having been
shown, within about a minute, and its own configuration is replaced until it leaves (see
below). To avoid that for a host, remove it from the first pool before updating its daemon,
using `PUT /api/hosts` or editing `~/.omp/agent/omp-web/pools.json`. Update the web server
first, then the members.

Creation retries reuse the same intent and creation identity. Once a real session is known,
its owner remains authoritative for resume, files, terminal, uploads, artifacts, rename, and
delete, even if pool membership changes. An unavailable owner does not trigger replacement
on another worker or on the Mac. Dirty files and unpublished work remain on that owner;
there is no live migration or unpublished-work failover. After an uncertain response,
inspect the retained session before explicitly retrying a command that may have run.

### Cluster members use this machine's omp configuration

A cluster session can run on any member, and each member runs it with this machine's omp
configuration: the models, MCP servers, skills, task agents, rules and plugins do not depend on
the member chosen. A change made here, in Settings or on disk, reaches the members within about
a minute without any action on them, and before every session start on a member. A host outside
the cluster keeps its own configuration, managed on that machine.

- **What is mirrored:** from this machine's omp agent directory (`~/.omp/agent`): `config.yml`
  (without the keys below), `models.yml`, `mcp.json`, `.mcp.json`, `AGENTS.md`, `RULES.md`,
  `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, `secrets.yml`, `.env`, and the directories
  `skills/`, `agents/`, `rules/`, `instructions/`, `commands/`, `prompts/`, `hooks/`,
  `extensions/` and `tools/`. Also `~/.agents/skills/` (where Settings installs skills), the
  agent environment variables of **Settings → System**, and the set of installed plugins with
  whether each is enabled. A mirrored directory becomes equal to this machine's: a file that
  exists only on the member is removed from it. `node_modules` and `.git` directories are left
  out. The member's backup holds only what the host had when it joined; a file added or edited
  on the member afterwards is deleted at the next apply, not backed up.
- **What is not mirrored:** `lsp.json`, `ssh.json`, themes, key bindings, sessions, history,
  `agent.db`, caches and `secret-placeholder.key`; configuration inside a repository (`.omp/`
  travels with the checkout); named omp profiles (a cluster project that names a profile runs
  with that profile's own files on each member); and programs: an MCP server's command, a
  language server or a local model engine that exists only on this machine is not installed on
  members.
- **Settings that stay the member's own:** `shellPath`, `python.interpreter`, `browser.*`,
  `worktree.base`, `plan.autosaveDir`, `shellMinimizer.settingsPath`, `mnemopi.dbPath`,
  `workspace.additionalDirectories`, `skills.customDirectories`, `extensions`, `images.urls.*`,
  `providers.tinyModelDevice`, `providers.tinyModelDtype`, `tts.*`, `stt.*`, `tui.*`,
  `terminal.*`, `lsp.*` and `auth.broker.*`. A member keeps its own value for each of them as
  it was when the host joined, or none; a change made on the member afterwards is reset at the
  next apply.
- **Limits:** a file over 5 MiB, a configuration over 50 MiB in all, or so many files that their
  list is over 5 MiB, is not mirrored at all: this machine serves no configuration, a cluster
  session start on a member is refused (409 `cluster_config_invalid`), placement skips every
  member, and **Settings → Hosts** names the file that is over, or says there are too many
  files. A `config.yml` that is not a YAML map or a file that cannot be read does
  the same. Each download a member makes (the list of files, and each file) must finish within
  30 s, body included; a 5 MiB file needs roughly 1.4 Mbit/s, and a member on a slower link
  does not update.
- **When a member applies it:** after joining; when it is behind this machine's version
  (checked every 30 s and at each cluster session start on a member; a new version found
  either way is sent to every member at once); and before every session start on the member, which waits for it. The
  files are written whole or not at all: a failure leaves the previous version in place. Every
  cluster session start carries this machine's version, and a start that must run on that
  member (a resumed session, a project pinned to its node) is refused with the reason when the
  files cannot be applied; new cluster sessions are placed only on members that have this
  machine's current configuration and plugins. A session recovered after a daemon restart, or
  started by another ompweb server, runs on whatever is on the member's disk at that moment.
  Sessions already running are not restarted. The applied files are readable by the daemon's
  user only.
- **Plugins:** after the files, the member runs `omp plugin` itself to install what it lacks
  (this needs `bun` and network access on the member), uninstall what this machine does not
  have, and match each plugin's enabled state. npm plugins
  are pinned to this machine's version; a marketplace plugin has no version pin in omp, so one
  already installed counts as matching. A session start does not wait for its own version's
  plugins, but a start that needs a new version waits behind a plugin job that is still running
  (up to 5 minutes for each install). A new version with the same plugins keeps the member
  current while its plugins are checked again. A failed install
  leaves the member not current, so placement skips it; it is retried about every 30 s and
  Settings shows omp's message.
- **Joining:** needs link protocol 10 on the host. Before the first apply, the host's own
  version of every mirrored file and directory moves to `<agent dir>/omp-web/own-config/` on
  the host, with its plugin list and agent environment variables; the join dialog says the host
  receives this machine's configuration, API keys and environment values included, in place of
  its own until it leaves. A host holds one ompweb server's configuration at
  a time: a host already in another server's cluster cannot join (409 `host_in_other_cluster`)
  and must leave that cluster first. If the host also runs sessions for another ompweb server
  (as a standalone host there), they run on this server's configuration for as long as the host
  is a member here.
- **Changes made on a member** to a mirrored file are overwritten at the next apply; change the
  configuration here. An apply is refused when `~/.agents` is a symbolic link on the member:
  replace it with a real directory. The
  mirrored directories, the staging area and the backup must be on one filesystem.
- **Leaving:** the daemon removes the mirrored files, moves its backup into place, puts back
  its agent environment variables, and reinstalls its own plugins as far as omp allows. Its own
  `config.yml` is its own file again. If putting its configuration back fails, Settings says so
  and the restore is retried while the host is linked, also for a host that was offline when it
  left. A member that is revoked gets its own omp configuration back from its daemon: at once if
  the daemon is connected, otherwise the next time it reaches this machine (and is refused). A session start
  that races a leave is refused. This machine is the master: nothing is
  mirrored to it and nothing of it is backed up.
- **Settings:** each member's line in **Settings → Hosts** shows *same as the master*,
  *updating…*, *failed* with the reason, *held by another ompweb server*, or that the host needs
  an update, and the MCP server commands in the mirrored files that are not installed there.
  When this machine's configuration cannot be mirrored, one message names the file, and no
  member line says *updating…*. For a session or project of the cluster, the Models, settings, MCP, Skills, Plugins and Agents
  screens say that changes apply to every member, and so does **Settings → System** next to the
  agent environment variables. For a session on another member they act on
  this machine's user-level configuration, which the member runs; that session's and project's
  own configuration is not shown there. MCP shows that session's live status, read from the
  process where it runs, and cannot change it; MCP toggles, reload and Skills diagnostics for
  the session are not available there.
- **API:** `GET /api/plugins`, `POST /api/plugins`, `GET /api/skills`, `POST /api/skills/check`
  and `POST /api/skills/update` accept a request without `cwd` and then act on the user level
  only (a project-scope change still needs a `cwd`). `GET /api/mcp?sessionId=…&attach=1` reads
  the live MCP status of a session that is already running and never starts one.
- **Security:** the configuration contains secrets: API keys in `models.yml` and `.env`, MCP
  server environments and headers, tokens in `config.yml` and the values in `secrets.yml`. They
  are written to every member's disk, readable by the daemon's user only; a member can already
  read this machine's provider logins, and this adds the rest. Hooks, extensions, custom tools
  and plugins are code: this machine's code runs on every member; this machine can already
  start omp with full tool access there. Nothing flows the other way:
  a member cannot change this machine's configuration, and the routes only serve members,
  checked on every request, and stop answering a host the moment it leaves or is revoked.
- **Differences that remain:** a provider in `models.yml` that points at this machine's own
  address (for example `http://127.0.0.1:11434`) points at the member's own address there, so a
  local engine has to run on each member or be given an address they can all reach. An API key
  written as an environment-variable name or as a `!command` resolves on the member: the
  variable or command must exist there (variables set in Settings → System or in the mirrored
  `.env` do). MCP servers started by a command need that command on each member.


### Local worker maintenance

`ompweb host status` prints daemon PID, native version/protocol, welcomed-link readiness,
executable/entrypoint identity and maintenance state without credentials.
`ompweb host drain` synchronously checks children (idle included), preparations,
uploads/controls, pending operations and reliable results, and closes new-work admission
only when idle. A busy refusal never kills work or changes admission.
`ompweb host resume` reopens the live daemon. Controls run inside the existing daemon, not
TCP or a separate service: a private Unix socket on Linux and macOS, and on Windows a named
pipe with a random name and a per-start token. Windows keeps both in
`<agent dir>/omp-web/host-control.json`, which only the daemon's user can read through the
agent directory; a request without the current token is refused. A disconnected deployer
cannot release a live drain. Windows hosts report CPU and memory capacity too, so they can be
pool workers.
Disable central member admission before worker rollout; native drain is the final race-free guard.

Worker service cutovers can additionally start drained through `OMP_WEB_HOST_DRAINED=1`
in their protected temporary unit environment. Live resume does not remove that startup
setting. After a deployer crash or lost final resume reply, verify the selected release,
PID and welcomed-link health, and remove the known worker maintenance flag before explicit
resume. Never infer from a missing acknowledgement that admission stayed closed, and never
stop or roll back a candidate after its deployment commit point.

### Single binary

Each [release](https://github.com/kahme247/ompweb/releases/latest) also ships
ompweb as one compiled program with the files it serves beside it:
`ompweb-linux-x64.tar.gz`, `ompweb-linux-arm64.tar.gz`, `ompweb-darwin-x64.tar.gz`,
`ompweb-darwin-arm64.tar.gz` and `ompweb-windows-x64.zip`. It needs no Node, npm
or Bun, and no omp: its own omp build, `ompweb-omp`, is beside it. The x64 builds use Bun's baseline runtime, so
they also run on CPUs without AVX2. Each archive carries the licenses of what it
bundles in `licenses/`. Every commit on `main` that passes CI is also published as a
[prerelease](https://github.com/kahme247/ompweb/releases) named after the time it was
built (for example `2026-11-01T10:30:00Z`), with the same five archives.

```bash
tar -xzf ompweb-linux-x64.tar.gz -C ~/.local/share   # unpacks ompweb-linux-x64/
~/.local/share/ompweb-linux-x64/ompweb               # the web server: same options and environment variables as above
~/.local/share/ompweb-linux-x64/ompweb host          # the local daemon, in a second terminal
```

- **Keep `ompweb` in its directory.** It runs `ompweb-omp` and serves `dist/`, `public/` and the other
  files from the directory it is in (a symlink to it on your `PATH` works), or
  from `OMP_WEB_PACKAGE_DIR` when that is set.
- **macOS** quarantines downloads: run `xattr -dr com.apple.quarantine ompweb-darwin-arm64`
  once before the first start.
- **macOS 15 and later** ask before an app may reach your local network. If
  `ompweb host` on a Mac reports `ECONNREFUSED` for a server on your LAN while
  `curl` reaches it, allow your terminal (or `ompweb`) under System Settings →
  Privacy & Security → Local Network. A server reached over a VPN such as
  Tailscale, or a host started from an SSH session, is not affected.
- **No tray, service installers or in-app update.** To update, stop `ompweb` and
  `ompweb host`, replace the directory with the new release, and start both again;
  **Settings → System** links the release page when a new version is out.
  Your sessions and settings live in `~/.omp`, not in that directory.
- **As systemd user services**, write the two units yourself (adjust the paths):

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

Manage it from **Settings → System → Windows Background Service**, or via CLI:

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
its own `omp` install, `~/.omp/agent` directory, sessions, and credentials (unless you
[share the server's provider logins](#use-the-servers-provider-logins-on-a-host));
ompweb only routes. The remote machine needs `omp` and either Node 24 (for `npx`) or
the [single binary](#single-binary), and must be able to reach the ompweb server over
HTTP(S). It dials out, so it can sit behind NAT.

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

**Settings → Hosts** also shows each machine's ompweb daemon and OMP runtime
versions, available updates and update actions, including **This machine**.
Checks and installations run on the selected host, not on the web server. A host
update whose link protocol is incompatible with the current web app stays visible
but is blocked with a reason; update the web server first. An unverifiable target
protocol is blocked too. OMP updates are independent of the link protocol.
Before updating a daemon, close its session processes: the updater refuses to
interrupt sessions or subagents. Updating OMP leaves existing processes on their
loaded version until they restart. **Settings → System** keeps the web server's
own application update and service settings.
Hosts need a daemon build that supports these update operations; older builds
show an unsupported message and need one manual update first. If the daemon
shares its installation with the web server, update the server first, then use
the host's restart-only update. Unsupported service wrappers and detected restart
scripts show a manual-update reason. Stop external restart loops before updating
a foreground daemon.

A daemon update is carried out by a separate updater process on the host. It
stops the daemon, swaps in the new release and starts it again, and on a failure
it restores the previous release. If that updater is itself killed after stopping
the daemon (a reboot, an out-of-memory kill), nothing restarts the host, which
stays offline. Recover on the host: in the folder containing the installation,
`.ompweb-backup-<id>` is the previous release. If it is there, move the
installation aside and rename the backup back to the installation's name; then
start `ompweb host` (or its service) again. Settings → Hosts reports the update
as interrupted.

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

A reverse proxy must forward the upgrade on `/api/hosts/link`. For hosts that share the server's logins it must also pass `/api/hosts/broker/` without the proxy's own authentication and without response buffering; for cluster members, likewise `/api/hosts/cluster-config/manifest` and `/api/hosts/cluster-config/file/<hash>` without the proxy's own authentication. See [Behind a reverse proxy](#behind-a-reverse-proxy).

Update ompweb on the server before its hosts: a host from before this version shows **needs upgrade** until it is updated.

Notes:

- **Service helpers:** `ompweb systemd install` and `ompweb launchd install` set up
  this machine's own daemon next to its web server (see
  [Two services](#two-services-the-web-server-and-the-local-daemon)). On the other
  machine you only need the daemon, so use
  [Keep a host running as a service](#keep-a-host-running-as-a-service) instead.
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
- **Workspace files on every host:** Explorer, previews, downloads, file search,
  @-mentions and live file watching use the owning machine's daemon, including
  This machine. Explorer uploads accept up to 2 GiB per file with no 100 MiB batch
  cap; preview limits remain 256 KiB for text and 10 MiB for images/DOCX.
  File tabs retain their source session, host and workspace when you switch chats;
  paths from another conversation cannot be mentioned into the selected chat.
  An unavailable or older daemon reports offline or asks for an update; main
  never substitutes its own filesystem. Unprepared pool chats have no guessed
  filesystem to browse.
- **Git and worktrees on every host:** status, diffs, GitHub issue links, and
  worktree creation, selection and removal run on the owning daemon. Dirty
  worktrees still require explicit force confirmation. Switching a worktree
  changes where new sessions start, not an open conversation.
- **Directory browsing and cloning on every host:** the Add workspace picker
  navigates that host's directories and clones HTTPS/SSH repositories there.
  Cancelling waits for the clone process and safe cleanup; interrupted connections
  report an unknown outcome rather than pretending the clone was cancelled.
  If the destination changes during cleanup, captured data is preserved in a
  private quarantine and the error gives its location; inspect it before removing
  or restoring anything.
- **Not available on remote hosts yet:** the Skills,
  Plugins, Agents and MCP settings, for a host outside the cluster (a cluster member uses
  this machine's: see [above](#cluster-members-use-this-machines-omp-configuration)).
  Transcript search still scans this machine.
- **Agent-started sessions:** with agent tools enabled, an agent can pass a `host`
  to `new_session` (it defaults to the agent's own host). A remote host asks for
  confirmation each time unless **Agents can start sessions here without asking**
  is switched on for it in Settings → Hosts. An agent running on a remote host
  always asks before it starts or messages a session on this machine.

### Use the server's provider logins on a host

By default a host uses its own omp logins. Turn on **Use this server's provider logins** for a host in **Settings → Hosts** and the sessions started there use the logins stored on the ompweb server instead, so you log in to a provider once. The setting is per host and off by default; turning it on asks for confirmation. This machine does not have it, because it already uses the server's logins.

- **What is shared:** the provider logins stored on the server (OAuth logins and stored API keys). The server runs `omp auth-broker serve` for this and starts it on the first request; it stops after 5 minutes without one.
- **When a change reaches a host:** every omp process started after a login or logout on the server uses it. A running process picks it up the next time it is used, because omp stops listening for updates after 20 seconds without activity and resumes on its next use. A running process keeps the access tokens and API keys it has already loaded until it ends.
- **What is not shared:** custom providers in `models.yml`, API keys set through environment variables (a host's own environment keys still apply there), and omp settings. A cluster member does get these from this machine: see [Cluster members use this machine's omp configuration](#cluster-members-use-this-machines-omp-configuration).
- **Requirements:** the server's own `omp` must provide `omp auth-broker`. The host's daemon must speak link protocol 9 and its `omp` must be 15.13.1 or newer; otherwise starting a session on that host is refused with a message naming what to update. It never falls back to the host's own stored logins. Joining a session that is already running is not refused. The setting applies to omp processes started after you change it.
- **What the host can read:** the current access token of every OAuth login and every stored API key, in full. A process running as the daemon's user can do the same. OAuth refresh tokens never leave the server machine, and the host cannot add or replace a login. It can mark a login disabled or rate-limited for every machine.
- **Turning it off:** turning sharing off, or revoking the host, aborts the host's open requests to the server and refuses later ones. Access tokens the host already read stay valid until they expire, and API keys until you rotate them at the provider.
- **Dependence on the server:** a running session asks the server whenever an access token needs a refresh, so it fails to authenticate once its token expires while the server is unreachable. An `omp` you run yourself in the host's terminal is unaffected.
- **Troubleshooting:** when sessions on a sharing host fail at startup, check the server log for `[omp-web] broker` lines and that the reverse proxy lets `/api/hosts/broker/` through.

The host token is not put in an omp process's environment. The daemon listens on a loopback port with a secret it generates at each start, gives omp that address and secret, and forwards the requests to the server with the host token.

### Keep a host running as a service

These run the [single binary](#single-binary) in host mode. On Linux and Windows a
service keeps the link up across logouts and reboots; on macOS a script keeps it
running in a terminal (see below for why). Unpack the release for the machine first,
then save the link once with `ompweb host login --url …` as in step 2 (with the
binary's path in place of `npx @kahme247/ompweb@latest`). Each setup starts
`ompweb host` again 10 seconds after it fails, but not after exit 0: that means a
newer link with the same token replaced it, and restarting would take the link back
every 10 seconds. Add `--allow-http` after `host` if
the server URL is plain `http://`, and set `PI_CODING_AGENT_DIR` in the service too
if you saved the link with it set. A machine links to one server: do not also run an
ompweb web server on it, which writes the same link file for its own daemon. To
update, stop the service, replace the release directory, and start it again. After
revoking a host, stop and remove its service: it otherwise keeps retrying.

**Linux (systemd user service).** Create `~/.config/systemd/user/ompweb-host.service`
(adjust the release path):

```ini
[Unit]
Description=ompweb host
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
# Exit 0: a newer link for this host replaced it. Restarting would take the link back.
RestartPreventExitStatus=0
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb-host
loginctl enable-linger "$USER"            # keep it running while you are logged out
journalctl --user -u ompweb-host -f       # logs
```

**macOS (from a terminal).** No launchd job can run a host that omp sessions can
fully use: a LaunchDaemon has no login keychain or SSH agent, which sessions need
for SSH keys and commit signing, and a LaunchAgent cannot reach LAN addresses. A
process started from a terminal inherits the terminal's keychain and SSH agent, so
run the host there, in tmux so it outlives the window.

tmux does not keep the terminal's Local Network permission, though: the tmux server
detaches from the terminal app, and macOS Local Network privacy then blocks the
ad-hoc signed `ompweb` binary from LAN addresses (`connect` fails with "No route to
host", which the daemon reports as `ECONNREFUSED`; Apple's own tools such as `curl`
are not blocked, so a `curl` test passes). Link the host to a URL that does not
resolve to a LAN address, for example the server's public URL, or its VPN or
tailnet name (a Tailscale MagicDNS name served by your reverse proxy with its own
certificate). Save this as `~/.local/bin/ompweb-host-run` (adjust `DIR`) and make
it executable with `chmod +x`:

```sh
#!/bin/sh
# Keeps `ompweb host` running in this terminal, which lends it its keychain and SSH agent.
# Restarts it 10 s after a crash; stops when the token is revoked or the link protocol is
# unsupported (exit 1), or on exit 0: a newer link replaced it, or it was stopped (Ctrl-C).
DIR=${OMPWEB_DIR:-$HOME/.local/share/ompweb-darwin-arm64}
# A tmux started over SSH sees the login keychain locked: unlock it while a terminal can ask.
security show-keychain-info login.keychain-db 2>/dev/null || security unlock-keychain login.keychain-db || exit 1
while :; do
	(cd "$DIR" && exec ./ompweb host)
	rc=$?
	case $rc in 0 | 1) exit "$rc" ;; esac
	echo "ompweb host exited $rc; restarting in 10 s" >&2
	sleep 10
done
```

Run `ompweb-host-run` in a tmux window; Ctrl-C stops the daemon and its sessions.
Start it again after a reboot or logout. If the login keychain locks itself after
inactivity or on sleep, SSH key passphrases and signing fail until you restart it.

**Windows (scheduled task at logon).** In PowerShell, with `$dir` set to the
unpacked release:

```powershell
$dir = "$env:LOCALAPPDATA\ompweb-windows-x64"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\logs" | Out-Null
Set-Content "$dir\ompweb-host.ps1" @'
# Starts `ompweb host` again 10 s after it fails, and stops on exit 0 (a newer link replaced it).
# Output goes to ~\.omp\agent\logs\ompweb-host.log, moved to .log.1 past 10 MB (checked between restarts).
# For a plain http:// server URL, put --allow-http after `host` below.
$log = "$env:USERPROFILE\.omp\agent\logs\ompweb-host.log"
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item $log "$log.1" -Force }
  & "$PSScriptRoot\ompweb.exe" host 2>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $log
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep 10
}
'@
Register-ScheduledTask -TaskName ompweb-host -Force `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") `
  -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\ompweb-host.ps1`"") `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries)
Start-ScheduledTask ompweb-host
```

Stop it with `Stop-ScheduledTask ompweb-host`, then end the running host with
`Get-Process ompweb | Where-Object Path -eq "$env:LOCALAPPDATA\ompweb-windows-x64\ompweb.exe" | Stop-Process`
(only this release's `ompweb.exe`; adjust the path as for `$dir`). Remove it with
`Unregister-ScheduledTask ompweb-host`.

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
- **Web-based Settings** (11 tabs): Interface & Behavior, Safety & Approvals, AI Model Defaults, API Keys & Providers, Usage, Agent & Intelligence (advisor, memory, compaction), Agents, Extensions & Tools (MCP, skills, plugins), Hosts, Notifications, System.
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
