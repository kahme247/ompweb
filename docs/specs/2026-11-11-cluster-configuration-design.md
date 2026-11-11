# Cluster members use the master's omp configuration — design

Date: 2026-11-11. Branch: `feat/cluster-config` (on `feat/cluster-membership` 4176e5b7).
Builds on: `docs/specs/2026-11-11-cluster-membership-design.md` (the cluster, its master, joining and leaving) and `docs/specs/2026-11-10-shared-credentials-design.md` (provider logins, the bearer-authenticated host route).

Facts about omp in this document come from its source at 18.2.8 (`docs/settings.md`, `docs/models.md`, `docs/mcp-config.md`, `packages/utils/src/dirs.ts`); the installed omp is 18.18.6. The plan starts by confirming the file locations against the installed version.

## Why

A cluster session can run on any member, but each member reads its own omp configuration. The model picker, `models.yml`, the settings screens, MCP servers, skills, plugins and task agents in the interface are the master's. A session placed on another member therefore runs with different models, tools and rules than the interface shows, and the panels for MCP, Skills, Plugins and Agents say "Not available on remote hosts yet".

omp cannot fetch configuration from another machine, and most of it cannot be pointed elsewhere: `models.yml`, user MCP servers, skills, task agents, rules files and commands are read only from the machine's own omp directory.

Goal: every member runs cluster sessions with the master's configuration. Changing it on the master, in the interface or on disk, reaches the members without any action on them.

Not goals:

- Standalone hosts. A linked host outside the cluster keeps its own configuration, managed on that machine; the panels stay unavailable for it.
- Installing programs. An MCP server's command, a language server or a local model engine that exists only on the master is not installed on members; the interface says what is missing where.
- Configuration inside a repository (`.omp/` in the project). It travels with the checkout already.
- Named omp profiles. Only the master's default profile is mirrored.
- The remaining differences between this machine and remote hosts that are not configuration: transcript search, usage analytics, session import, and the file views of a cluster chat that has no node yet. They get their own plan.

## Decisions

### K1. What is mirrored

From the master's omp agent directory (`~/.omp/agent`) unless another place is named:

| Part | Files |
|---|---|
| Settings | `config.yml`, without the keys of K2 |
| Models | `models.yml` |
| MCP servers (user level) | `mcp.json`, `.mcp.json` |
| Skills | `skills/`, and `~/.agents/skills/` (where the interface installs them) |
| Task agents | `agents/` |
| Rules and context | `AGENTS.md`, `RULES.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, `rules/`, `instructions/` |
| Commands and prompts | `commands/`, `prompts/` |
| Hooks, extensions, custom tools | `hooks/`, `extensions/`, `tools/` |
| Secret obfuscation | `secrets.yml` |
| Environment | `.env` in the agent directory, and the "agent environment variables" of Settings → System |
| Plugins | the set of installed plugins and whether each is enabled (K5) |

A mirrored directory becomes equal to the master's: files that exist only on the member are removed from it (they are in the member's backup, K6).

Limits per file 5 MiB and per bundle 50 MiB; `node_modules` and `.git` directories are left out. A master configuration over a limit is not mirrored at all, and Settings says which file is over.

Not mirrored: `lsp.json`, `ssh.json`, themes, key bindings, sessions, history, `agent.db`, caches, and `secret-placeholder.key`.

### K2. Settings that stay the member's own

These `config.yml` keys describe the machine. The member keeps its own value for each, or none:

`shellPath`, `python.interpreter`, `browser.*`, `worktree.base`, `plan.autosaveDir`, `shellMinimizer.settingsPath`, `mnemopi.dbPath`, `workspace.additionalDirectories`, `skills.customDirectories`, `extensions`, `images.urls.*`, `providers.tinyModelDevice`, `providers.tinyModelDtype`, `tts.*`, `stt.*`, `tui.*`, `terminal.*`, `lsp.*`, and `auth.broker.*` (a member's broker settings come from its daemon).

The list is one constant, used by the master when it builds the bundle and by the member when it merges.

### K3. How it gets there

- **Version.** The master computes the configuration's version: a hash over the path and content hash of every mirrored file, the agent environment variables, and the plugin set. It recomputes when the interface writes a configuration file and when a watched file changes on disk.
- **Pull.** A member's daemon fetches the list of files for a version, and each file it lacks by content hash, from two new routes under `/api/hosts/cluster-config/`. They are authenticated with the host token, like `/api/hosts/broker/`, and answer only members; a standalone host gets 403.
- **Apply.** The daemon writes each file with mode 0600 to a temporary name and renames it, removes what the list no longer has, merges `config.yml` (K2), and records the applied version. Either the whole version is applied or the previous one stays.
- **When.** After joining; when the master announces a new version over the link; and before every session start on a member: `open.launch` carries the master's version, and the daemon applies it first if its own differs.
- Link protocol 10 adds the version to `open.launch`, the announcement, and the member's report of its applied version and plugin state. Joining the cluster then requires protocol 10.

### K4. A member that is not current

- **New cluster sessions** are placed only on members whose applied version is the master's and whose plugins match (K5). A member that is behind is skipped, as a draining one is.
- **A session that must run on one member** (a resumed session, a project pinned to its node): the daemon applies the files first. If that fails, the start is refused with the reason; the session is never started with the member's own configuration. A plugin difference does not block it and is shown.
- Sessions already running are not restarted.
- Settings → Hosts shows each member's state: current; updating; failed, with the reason; and the MCP server commands that are not installed there.

### K5. Plugins

- The master's plugin set is read with `omp plugin list --json`, as the interface reads it today.
- A member installs what it lacks, removes what the master does not have, and matches the enabled state, by running `omp plugin` itself. This needs `bun` and network access on the member, runs after the files are applied, and does not delay a session start.
- A failed install leaves the member not current (K4) and is shown with omp's message.

### K6. Joining and leaving

- **Joining.** Before the first apply, the daemon moves the member's own version of every mirrored file and directory into `<agent dir>/omp-web/own-config/` and records its own plugin list there. The confirmation of joining says that the host's configuration is replaced until it leaves.
- **Changes made on a member** to a mirrored file are overwritten at the next apply. Configuration is changed on the master.
- **Leaving.** The daemon removes the mirrored files, moves the backup into place, and restores its own plugin set as far as omp allows; failures are shown. Its `config.yml` is its own file again, unchanged.
- This machine is the master: nothing is mirrored to it and nothing of it is backed up.

### K7. The settings screens

- For a session or project of the cluster, whichever member runs it, the Models, settings, MCP, Skills, Plugins and Agents screens act on the master's configuration, as they do for this machine today, and say that it applies to the whole cluster.
- The model picker needs no change: with the same `models.yml` and the shared logins, a member's models are the master's, except for providers that depend on the machine (below).
- Live MCP status of a running session still comes from that session's own process.

## Security

- The bundle holds secrets: API keys in `models.yml` and `.env`, MCP server environment and headers, tokens in `config.yml`, and the values in `secrets.yml`. They are written to every member's disk, readable by the daemon's user only. A member can already read the master's provider logins; this adds the rest.
- Hooks, extensions, custom tools and plugins are code. The master's code runs on every member. The master can already start omp with full tool access there.
- Nothing flows the other way: a member cannot change the master's configuration, and the routes only serve.
- The routes answer members only, check membership on every request, and stop answering a host the moment it leaves or is revoked.

## Limits

- A provider in `models.yml` that points at the master's own address (`http://127.0.0.1:11434`) points at the member's own address there. A local engine has to run on each member, or be given an address the members can reach.
- An API key written as an environment-variable name, or as a `!command`, resolves on the member: the variable or the command has to exist there. Variables set in Settings → System or in the mirrored `.env` do.
- MCP servers started by a command need that command on each member.
- A cluster project that names an omp profile runs with that profile's own configuration on each member; it is not mirrored.

## Testing

- Bundle building: every part of K1; the keys of K2 removed; the limits; `node_modules` left out; the version changes when any input changes and only then.
- The routes: host token; member only; revoked or left host; unknown version; a file requested by a hash that is not in the current version.
- Apply on a member, in a temporary agent directory: first apply makes the backup; directories become equal to the master's; `config.yml` keeps the member's own K2 keys; a failure half-way leaves the previous version in place; leaving restores every file byte for byte.
- Session start: a member that is behind applies first; a failed apply refuses the start; placement skips a member that is not current.
- Plugins, with a fake `omp`: install, remove, enable state, a failing install.
- Settings: the panels for a cluster session act on the master; the per-member state.
- Live, with the user: a change to `models.yml` and a new skill on the master appear in a session started on another member.

## Documentation

`README.md`, `AGENTS.md`, `CHANGELOG.md`, the remote-hosts specification's version rule, and the Settings strings in English, Chinese and Japanese.
