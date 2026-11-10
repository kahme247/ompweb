# Shared provider credentials for linked hosts — design

Date: 2026-11-10. Branch: `feat/shared-credentials` (on `main` c72de444).
Builds on: `docs/specs/2026-10-28-remote-hosts-design.md` ("Security", "Protocol versions and compatibility"), `docs/specs/2026-11-06-multi-server-host-design.md` (M1, M3, M7), and OMP's own `docs/auth-broker-gateway.md`.

## Why

Every linked host keeps its own provider logins. The model selector, the provider settings and the login screen, however, all use the web server machine's OMP. A model chosen in the UI can therefore have no login on the host that runs the session, and every provider has to be logged in once per host, by hand, which is awkward for OAuth on a headless machine.

Goal: a host with sharing turned on runs its sessions with the web server machine's provider logins. One login in Settings covers that host; token refresh, rotation and logout apply to it without any action on the host.

Not goals:

- Copying credentials to hosts. OAuth refresh tokens never leave the web server machine.
- Sharing `models.yml` custom providers, environment-variable API keys or OMP settings. These stay per host, so a model that exists only through them can still be missing on a host.
- A per-host model list, or host placement that considers providers.
- Hiding access tokens from hosts (OMP's `auth-gateway`). It can replace the transport later without changing the setting.

## Decisions

### C1. OMP's auth broker is the mechanism

`omp auth-broker serve` serves the credential store of the machine it runs on over HTTP and performs every OAuth refresh itself. An OMP process started with `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` replaces its local credential store with the broker's snapshot, in which each refresh token is replaced by a sentinel; when an access token expires the process asks the broker to refresh it.

ompweb adds no credential handling of its own. It still never reads `agent.db` and never imports OMP packages: it runs the installed CLI and forwards HTTP.

Checked against OMP's source and `omp auth-broker --help` of omp 18.18.6. Not yet run end to end; the plan starts with that probe.

### C2. Sharing is a per-host setting, off by default

- `HostRecord` gains `shareCredentials: boolean` (absent means `false`). `PATCH /api/hosts` accepts it; Settings → Hosts shows one toggle per remote host. The `local` record never has it: this machine already uses the store directly.
- Off by default for two reasons. Broker mode replaces the host's own stored logins, so turning it on for an existing host changes which accounts its sessions use. And it extends what a host is trusted with (see "Security").
- The setting applies to OMP processes started after the change. A running process keeps the credentials it started with.

### C3. The broker runs as a child of the web server

- `lib/omp/auth-broker.ts`, modelled on `lib/omp/auth-gateway.ts`: started on the first forwarded request with `omp auth-broker serve --bind=127.0.0.1:<free port>`, ready once `GET /v1/healthz` answers, stopped after 5 minutes with no forwarded request in flight (an open snapshot stream counts as in flight) and when the server shuts down. Its bearer token comes from `omp auth-broker token` and stays in the server process.
- Sessions on this machine and the Settings screens keep using the store directly. The broker reloads the store before every snapshot and every refresh pass, so a login or logout in Settings reaches the hosts.
- The broker and this machine's own OMP processes refresh the same OAuth rows. That is the situation several local OMP processes are already in; the plan includes a test that a refresh by one is picked up by the other.

### C4. One forwarding route on the web server

`/api/hosts/broker/[...path]`:

- Outside the password gate, like `/api/hosts/link`: the daemon has no session cookie. `UNGATED` names the prefix `api/hosts/broker/` and nothing beside it.
- Authenticates `Authorization: Bearer <host token>` with `hostForToken` before reading any body: 401 for an unknown token, 403 for a host without `shareCredentials` and for `local`, 503 when `hosts.json` is unreadable or the broker cannot start.
- Forwards only paths under `/v1/`, with the method, query and body, and the request headers `content-type`, `accept`, `if-none-match` and `omp-auth-broker-capabilities`, replacing the bearer with the broker's. Returns the status, the body as a stream and the response headers `content-type`, `etag`, `cache-control` and `vary`.
- Refuses `POST /v1/credential` with 403: a host cannot add or replace a credential.
- Turns Bun's 10 s idle timeout off once the token is accepted: the snapshot stream and the 30 s long poll stay open without traffic. The upstream request is aborted when the host disconnects.
- Logs the host id, method, path and status. Never a token or a body.

### C5. The daemon forwards for its OMP processes

The daemon listens on `127.0.0.1:0` and creates a random secret each time it starts. An OMP process it spawns for a sharing host gets:

```
OMP_AUTH_BROKER_URL=http://127.0.0.1:<port>/<link>
OMP_AUTH_BROKER_TOKEN=<daemon secret>
```

The forwarder checks the secret, then sends the request to `<that link's server URL>/api/hosts/broker/...` with that link's current host token, and streams the answer back.

The host token is deliberately not put in the process environment:

- OMP's tools inherit the environment. An agent that runs `env` would write the host token into the session file and send it to the model provider, which is the reason the web password is kept out of the environment. The daemon secret that leaks this way is usable only on that machine's loopback, by a user who can already read `host.json`.
- A long-running OMP process keeps working when the host token is replaced or the server comes back on another address: the daemon reads the link's current values for every request.

### C6. Link protocol v8

- `open.launch` gains `shareCredentials?: true`. The hub sets it when the host's record has sharing on; a v8 daemon then spawns as in C5, using the link that sent the `open`.
- With several web servers on one daemon (M3), the server whose `open` starts the process decides. A server that joins a running process does not change its credentials.
- Resume after a daemon restart (M7): the recorded `launch` keeps the flag and the server URL of its link. If that link is no longer in `host.json`, the session is not resumed and the reason is logged.
- `LINK_PROTOCOL_VERSION` becomes 8; `MIN_LINK_PROTOCOL_VERSION` stays 4. For a host with sharing on whose daemon speaks v4–v7, the hub refuses to start a process with 426 `host_upgrade_required`. Hosts with sharing off behave exactly as before on every version.

### C7. No silent fallback to other credentials

A host with sharing on never runs a session with its own stored logins:

- Daemon too old: refused (C6).
- The host's OMP older than 15.13.1: the daemon refuses the spawn and names that version. It is the earliest release whose changelog shows `OMP_AUTH_BROKER_URL` handling OAuth logins correctly; an older OMP could ignore the variables and use its own logins.
- Broker or web server unreachable, host revoked (401) or sharing turned off (403): OMP reports the authentication failure in the session. A run that is in progress continues until one of its access tokens needs a refresh.

## Security

Today a compromised host does not expose the web server machine's provider logins. With sharing on for a host, anyone who holds that host's token, and any process running as the daemon's user, can:

- read the current access token of every OAuth login and every stored API key in full;
- mark a credential disabled (for every machine, until it is logged in again) or rate-limited (until the block expires).

They cannot obtain an OAuth refresh token and cannot add or replace a credential (C4). Turning sharing off or revoking the host stops further reads at once; tokens already read stay valid until they expire, and API keys until they are rotated at the provider.

Unchanged rules still apply: host tokens are stored hashed, the daemon requires `https://` except for loopback or `--allow-http`, and the broker itself listens on loopback only. A reverse proxy that adds its own authentication must let `/api/hosts/broker/` through to the server, as it does `/api/hosts/link`.

## Limits

- Not shared: `models.yml` custom providers, environment-variable API keys, OMP settings (see "Not goals").
- Remote runs now depend on the web server for token refresh. Before, a run continued through a network drop for as long as its own host's logins lasted.
- A host's own `omp` in a terminal is unaffected: only processes the daemon spawns get the broker variables.

## Testing

Tests sit beside the code, as in the rest of the repository.

- Route: 401, 403 (sharing off, `local`), 503; path confinement to `/v1/`; the upload refusal; header allow-lists in both directions; a streamed answer passes through; the upstream is aborted on disconnect.
- Broker child with a fake `omp`: lazy start, readiness, idle stop with a stream open and closed, restart after an exit.
- Registry and `PATCH /api/hosts`: the new field, its absence in old files, the `local` refusal.
- Daemon forwarder: wrong secret, link selection, host token replaced between two requests, streaming.
- Hub and daemon: the flag is set only for sharing hosts; refusal below v8; spawn environment; resume with the link present and absent.
- Live, at a time agreed with the user because it uses real logins: a session on a host with an empty credential store answers with the server's login; a logout on the server makes the host's next request fail.

## Documentation

- `README.md`: sharing in "Run sessions on another machine", the reverse-proxy path and the security note.
- `AGENTS.md`: file map, "Remote hosts", "Auth and model config".
- `DESIGN.md`: the paragraph that says each machine uses its own credentials.
- `docs/specs/2026-10-28-remote-hosts-design.md`: the v8 line under "Rules".
- `CHANGELOG.md`, and the Settings strings in English, Chinese and Japanese.
