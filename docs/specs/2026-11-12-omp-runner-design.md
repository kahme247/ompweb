# ompweb's own omp build and channel — design

Date: 2026-11-12. Branch: `feat/omp-runner`.
Replaces: the `omp --mode rpc-ui` boundary in `DESIGN.md` ("Why the CLI boundary is locked") and the RPC parts of `docs/specs/2026-10-28-remote-hosts-design.md`.

## Why

ompweb's live features ride omp's RPC mode, and every gap or regression there is an upstream PR away from a fix: the whole `ask` form and its pre-checked choices disappeared over RPC in omp 18.18.3, extension and session hooks are missing until someone upstreams them, and RPC-only quirks (protocol negotiation, chunked frames, `set_ask_dialog`, the session-edit extension) exist only to work around the boundary. omp's SDK already exposes the `AgentSession` the TUI drives. Building our own omp on that SDK makes RPC unnecessary: ompweb receives the same session events and calls the same session methods the TUI does, so mirroring the TUI is a consequence, not a feature.

## Decisions

### R1. Our own omp build

`runner/` is a Bun package pinned to an exact `@oh-my-pi/pi-coding-agent` release. `runner/src/cli.ts` stands in for omp's own entry (worker-host declaration, SQLite lock shim, postmortem handlers) and runs omp's `runCli` with one change: the root `launch` command passes its own session factory to `runRootCommand` (`runner/src/launch.ts`, a copy of upstream's to keep in step on every bump). Everything else (settings, auth, models, extensions, MCP, plugins, the TUI itself) is upstream omp, unpatched.

- It is compiled per platform like omp's release binary (`ompweb-omp-<os>-<arch>`, `runner/scripts/build-binary.ts`, `.github/workflows/omp-runner.yml`) and replaces the user's installed `omp` for everything ompweb starts (`OMP_WEB_OMP_BIN` points at it).
- People can run it as their normal omp. A TUI started from it connects to the local `ompweb host` (R3), so the web sees and drives that same live session.
- Upstream API drift breaks `tsc` on the pin bump instead of breaking the web at runtime. The fragile points are `runCli`, the `commands` table, `runRootCommand`'s injectable dependencies and the copied launch command.

### R2. One channel, two transports

NDJSON, one JSON object per line, keyed by `t`. The same messages travel over:

- **stdio** for sessions the daemon spawns: `ompweb-omp --headless [omp flags]` boots omp's full startup without the TUI, and every dialog goes to the host alone.
- **a Unix socket** for sessions started from a TUI: the runner dials `$XDG_RUNTIME_DIR/ompweb/host.sock` (the per-user temp dir where there is no runtime dir), refuses a directory it does not own or that others can write, and redials if the host restarts. With no host listening, it is a plain omp run.

omp → host: `hello` (first line: `proto`, `pid`, `sessionId`, `sessionFile`, `cwd`), `session` (identity changed: new, resume, fork), `event` (every event the host needs: `AgentSession` events plus the ones RPC synthesized, `message_update` in delta mode by default), `res`, `ui_request`, `ui_end`, and the presentation, bridge and login frames documented in the header of the runner file that sends them.

host → omp: `cmd {id, op, args}`, `ui_response {id, value}`, and the bridge results (`host_tool_result`, `host_uri_result`, login input).

Commands keep RPC's names, arguments and result fields, so the port maps one to one; a runner file comments every deliberate difference. The transcript before `hello` is the session file, which the host already reads.

### R3. Dialogs race

The runner wraps the tool UI context the TUI (or the headless mode) hands the session. Each dialog (`select`, `confirm`, `input`, `editor`, `askDialog`, `formDialog`, `approve`) is sent as `ui_request {id, method, args}` with the method's own arguments; whichever side answers first wins, the other side's dialog closes (`ui_end` to the host, an abort signal to the TUI). `formDialog` carries the agent's whole HTML form, so the web renders the same form, explanatory text and default choices the TUI shows.

### R4. ompweb translates at its boundary

ompweb keeps its internal frames where that keeps `rpc-manager.ts` and the browser unchanged: the process layer (`lib/omp/rpc-process.ts`) turns `ui_request`/`ui_end` into its `extension_ui_request` shapes (new `form` method for `formDialog`) and answers back as `ui_response`; the daemon (`lib/hosts/daemon-channels.ts`) reads identity, pending requests and lifecycle from the new frames. The host link protocol is unchanged: the daemon still forwards child lines. Removed: v1/v2 negotiation, `rpc_chunk`, `set_ask_dialog`, the session-edit extension (`edit_message` is a native command).

### R5. Clean break

There is no RPC fallback. An ompweb host runs only with a runner built for the channel `proto` it speaks; a mismatch in `hello` refuses the session with a message naming both versions.

## Security

The channel can prompt the agent, and the agent runs shell commands. The socket lives in a directory owned by the user and not writable by anyone else, and the socket file is `0600`; never TCP. Remote machines keep reaching their sessions through the authenticated host link.

## Open

- Windows: named pipe with a current-user ACL instead of the Unix socket.
- Release distribution of the per-platform runner binaries beside ompweb's own.
- Whether `set_model` should keep RPC's behaviour of saving the model as the user's default role.
