# Cluster membership in Settings, and moving a host's projects into its cluster — design

Date: 2026-11-11. Branch: `feat/cluster-membership` (on `feat/shared-credentials` 4e8fbaee, which contains `feat/transparent-host-pool`).
Builds on: the host pool (`lib/hosts/pools.ts`, README "Transparent host pools"; it has no spec of its own) and `docs/specs/2026-11-10-shared-credentials-design.md`.

"Cluster" is the name in the interface. The code keeps `pool`: `pools.json`, `HostPool`, `poolId`. Nothing is renamed.

## Why

A cluster today can only be set up by sending the whole `pools.json` content to `PUT /api/hosts`. Nothing in the interface shows or changes which hosts are members.

A host that becomes a member keeps its existing projects under its own name in the sidebar, apart from the cluster's projects. The same repository then appears once per host, and its sessions are split the same way.

Goal:

- Settings → Hosts shows, per host, whether it is standalone or in a cluster, and changes it. A MacBook stays standalone while the Proxmox hosts form one cluster.
- When a host joins a cluster, its projects become the cluster's. The same repository on several members is one project, and its sessions are listed together.

Not goals:

- Moving files, checkouts or sessions between machines. Nothing on a host's disk changes when it joins.
- A project without a Git remote running on another member. It stays on its node.
- Renaming or deleting a cluster, and the `draining` flag, in the interface. `PUT /api/hosts` still does these.
- A host in two clusters. The data allows it; the interface offers one.

## Decisions

### M1. The selector

- Each row in Settings → Hosts, **This machine** included, gets a **Cluster** control: `Standalone`, each existing cluster by name, and `New cluster…`.
- Choosing a cluster opens a confirmation with two fields and two notes:
  - the cluster's name (only for `New cluster…`);
  - the folder on that host where the cluster keeps the checkouts it creates (`projectsRoot`), prefilled with `<host home>/ompweb-cluster`;
  - what happens to the host's projects (M2);
  - the credential note of M4.
- Choosing `Standalone` for a member asks for confirmation and says what M5 does.
- A host can join only while it is online, its daemon speaks link protocol 9 or newer and it answers the `gitOrigins` operation (M2). Otherwise the control is disabled and says which of the three is missing.

### M2. Joining moves the host's projects

Joining is one request to the server, which reads the host's projects, computes the new cluster and saves it in one write. If any step fails, nothing is saved.

- **What the host reports.** A new host operation `gitOrigins(paths)` answers, for each path, the literal value of `remote.origin.url` (null when there is none or more than one) and whether the path is the top level of a main checkout with a real `.git` directory. These are the conditions the cluster's own preparation already requires of a checkout.
- **Which projects.** Every project the server lists for that host: registered ones, hidden ones included, and those found from sessions.
- **A project that can move:** a main checkout with one valid origin.
  - If the cluster has a project with the same origin (M3), the host's checkout is bound to it: `clonePaths[hostId]` is the existing path.
  - Otherwise a cluster project is created from it. It takes the host project's name, alias, hidden state, pin, order and launch settings.
  - If the host has two checkouts of one repository, the first in the host's project order is bound; the other is pinned (below).
- **A project that cannot move:** no Git repository, no remote, several remotes named `origin`, a subfolder, or a linked worktree opened as a project. It stays a project of that host and is shown in the cluster, pinned to its node (M6).
- **Bindings for the rest.** The joining host gets a path under its `projectsRoot` for every cluster project it has no checkout of, and every other member gets one for each new project. Today a host that is added after a project was registered gets none, so its sessions never show under that project.
- The host's own project list on its disk is not changed. A bound project stops being listed under the host because the server already hides a host project whose path is bound.

### M3. The same repository

Two origins are the same repository when they are equal after: lower-casing the host name, removing the user (`git@`), reading `host:path` as `ssh://host/path`, ignoring the scheme, and removing a trailing `/` and `.git`. `git@github.com:a/b.git` and `https://github.com/a/b` are one project.

The project keeps the origin it was first registered with. The preparation check on a member compares the checkout's origin with it by the same rule, where today it requires the exact text. It still requires exactly one `origin` URL.

### M4. Members use the server's provider logins

- A member, other than This machine, always runs its sessions with the server's provider logins, whatever its own "Use this server's provider logins" setting says. Any member can be chosen for a new session, so all of them need the same logins.
- This is computed from membership, not stored: leaving the cluster brings the host's own setting back.
- In Settings the per-host toggle of a member is shown on and disabled, with the reason.
- If `pools.json` cannot be read, a host's sessions are refused, not started with other logins.
- The confirmation of M1 repeats the security note of the shared-credentials design: that host can read the server's access tokens and stored API keys.

### M5. Leaving

- The host is removed from the cluster's members and gets no new sessions from it.
- Checkouts that joining bound (paths outside the host's `projectsRoot`) are unbound: those projects and their sessions are listed under the host again, with the presentation they had there.
- Checkouts the cluster created (paths inside `projectsRoot`) stay bound, so sessions the cluster started there stay under the cluster's projects. This is today's behaviour for a removed member.
- A cluster whose last member leaves is kept while it has projects, and removed when it has none.

### M6. Sidebar

- A cluster is one group. Its projects come first; each lists the sessions of every member together. This already works for bound checkouts, including sessions in their linked worktrees.
- After them, the group lists the pinned projects of its members, each marked with its node's name. A new session there starts on that node, as it does today.
- A member no longer has a group of its own. A standalone host keeps its group.

## Errors

| Case | Result |
|---|---|
| Host offline, daemon older than protocol 9, or no `gitOrigins` | The control is disabled; the request answers 409 with the reason |
| `gitOrigins` fails or times out | Nothing saved; the error is shown |
| `projectsRoot` not an absolute path | 400 |
| `pools.json` unreadable | 503, as the other cluster requests answer today |
| Host is already a member of another cluster | 409: leave it first |

## Testing

- The computation of M2 and M5 is a pure function of the cluster, the host's projects and their origins: bound to an existing project, created, pinned for each reason, two checkouts of one repository, presentation carried over, bindings seeded for other members, leaving.
- M3: the forms that must match and the ones that must not (different host, different path, path differing only in case).
- The join and leave requests: each row of "Errors", and one write per request.
- M4: a member is treated as sharing with its own setting off; This machine is not; unreadable `pools.json` refuses.
- Sidebar grouping: a member's pinned projects fall in the cluster's group with the node's name; a standalone host keeps its group.
- The Settings control: disabled states, the two confirmations.
- Live, with the user: the Proxmox hosts joined one by one, the MacBook left standalone.

## Documentation

`README.md` ("Transparent host pools", which also says existing workspaces of members stay under their host), `AGENTS.md`, `CHANGELOG.md`, and the Settings strings in English, Chinese and Japanese.
