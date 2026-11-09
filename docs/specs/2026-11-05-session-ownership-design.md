# Session ownership: one writer per session

Status: slice 1 of 5 implemented (the daemon op and its detector). The command
gate, the wire/UI wiring, explicit force and the outbox behaviour follow.

## The problem

omp ≥ 18.5 grants exactly one writer per session. The lease lives in a named
mutex (Windows) or an abstract socket (POSIX) — deliberately not a file, so
omp-web cannot read it. A second `--resume` does not fail: omp silently moves
the conversation to a fresh sibling file on its first write. A chat driven by a
terminal `omp`, by another omp-web server or by a run that was open a moment ago
therefore looked idle, and sending to it forked the conversation into a copy.

## Where detection lives, and why

The web server cannot answer this question. Under the shared-daemon model the
daemon owns every session file and every child process, including this machine's;
a scan on the web server runs in another PID namespace, as another uid and on
another filesystem, so it silently fails open. Detection is therefore a host op:

```
sessionOwnership { ids: string[] } -> SessionOwnership[]        (one entry per id, request order, <= 256)
SessionOwnership = { id, owner: "daemon" | "foreign" | "none" | "unknown",
                     running?: boolean, source?: "process" | "transcript", lastActivityAt?: number }
```

It is a `SessionOps` op, not a `Host` method: id-only, it flows through
`remoteSessionOps`/`validResult` and gets the 501 fallback for older daemons for
free. It never spawns, kills or writes.

Three facts meet only in the daemon (`lib/hosts/session-ownership.ts`):

1. **`ChannelTable` is the authority for "ours".** A channel's aliases, launch
   files, `spawning` map and `lifecycle` cover a child that is spawning, adopted,
   idle between turns or mid-turn — exactly the cases a main-side reconstruction
   from `isSessionStarting`, a listed-child set and a crash map kept getting
   wrong. A spawn still connecting is ours too: `spawning` is keyed by the
   session identity or the launch file.
2. **The process scan runs where the children run.** Same PID namespace, same
   uid, so `process.getuid()` filtering is exact and the daemon's own children
   are excluded by transport pid plus a bounded ppid-chain walk (the Windows
   `cmd.exe /c omp.cmd` wrapper puts the real `omp` one hop below the pid).
3. **The transcript tail is read on the machine that owns the file.**

## Contract corrections this slice honours

**Unknown is explicit.** `owner: "unknown"` covers a failed scan, a switched-off
scan (`OMP_WEB_FOREIGN_SCAN=0`) and an older daemon's 501. Main distinguishes a
successful negative answer from an unsupported or failed inspection
(`lib/session-ownership.ts`), answers `unknown` for every id of a failed page and
never turns any failure into `none`. With `owner: "unknown"` no `running` fact is
reported: `false` would be a claim the inspection cannot establish.

**Ownership is separate from activity.** A live foreign `omp` owns the file even
while idle between turns (`owner: "foreign"`, `running: false`). A fresh
transcript without positive owner evidence is an activity hint, not proof of a
live writer (`owner: "none"`, `running: true`, `source: "transcript"`); it never
blocks a send by itself. Activity is reported only from evidence that can carry
it: a tail window that parsed no complete record (one multi-MiB tool result fills
the 64 KiB window) says nothing about the transcript's end, so `running` is
omitted rather than reported `false`. A scan hit is re-checked against the OS
(`process.kill(pid, 0)`), because the snapshot is cached for 10 s and a terminal
`omp` closed a second ago would otherwise read as a live writer. Daemon-owned
identity comes from `ChannelTable` alone —
there is no main-side `host.pid` record, no recovery-file inference and no second
detector.

**Batching.** One bounded process scan answers a whole request; the transcript
tail is read only for ids whose file changed inside the 60 s activity window.
Main pages a list longer than 256 ids (`LINK_LIMITS.ownershipIds`) instead of
silently skipping the rest, and a failed page does not stop the remaining pages.
Resolving an id whose path is not cached costs the same one `listAllSessions()`
scan the session list route pays (measured ~2.3 s cold, ~1 ms warm), so the first
request after a list-cache expiry is slower than the rest; the 256-id bound
bounds the reply, not that scan. It is shared with the list route through the
same cache, so it is paid once, not per id.

**Validation at the host boundary.** The daemon rejects a non-array, an empty
array, a non-string id and more than 256 ids with 400 `invalid_request`; the
detector's own guard uses the same status and code, so one condition has one
answer. Main's
`validResult` rejects a daemon reply whose length, identity or order differs from
the request, or whose `owner`/`running`/`source`/`lastActivityAt` has the wrong
type, as 502 `host_bad_result`.

**Windows process identity.** `process.getuid` does not exist on Windows, and
reading another user's process owner needs `PROCESS_QUERY_INFORMATION`, which an
unelevated daemon lacks. The Windows scan therefore keeps every row — a
same-machine `omp` of any account counts as a possible owner — and narrows by
process identity instead: a row counts only when its image is `omp.exe`/`omp` or
its command line names an omp entry (`omp.cmd`, `omp.bat`, `omp.js`, a path below
`@oh-my-pi`). That last rule is what makes a shim-launched omp visible: a `.cmd`
launcher (which `wrapWindowsScript` supports) runs omp as a `node.exe` process
below `cmd.exe`, so an image-name-only filter missed it entirely. This is the
documented limit, not an other-user exclusion; POSIX drops other-uid rows and a
kept and a dropped row are both asserted (`lib/hosts/session-ownership.test.mjs`).

**Resume flags.** omp 18.12 documents `-r, --resume=<value>` ("by ID prefix,
path, or picker if omitted") and `--restore=<value>`, which resumes "as --resume
does, then goes on with what its last process left unfinished" — the flag a user
reaches for after a crash, exactly when a second writer appears. All three are
recognised, with `=`, a space or (`-r`) the attached form, and a *unique* id
prefix is matched as omp would resolve it (an ambiguous or shorter-than-four
prefix claims nothing). A resume argument is only evidence on an omp row:
`-r` is also `grep -r`, `rm -r` and `tar -r`, and a POSIX scan lists every
process of the user.

**Every requested id is scanned.** An id whose file does not resolve — a session
a foreign `omp` created after the 30 s list cache was warmed, or a file outside
the sessions tree — still goes to the scan with no path. Dropping such ids made a
live foreign writer answer a definite `none`, the one answer a caller may send
into.

**Detection is not a lock.** The inspection is read-only and not atomic with a
later spawn: a writer can start between the two, so a `--resume` can still move a
conversation into a copy without the user's confirmation. The op reduces the
window; it does not promise to close it. Callers must not describe it as a lock.

## Later slices

2. Command gate: `409 session_owned_elsewhere` with `{ elsewhere }` on the cold
   path of `runAgentCommand`, before upload attachment; a live wrapper is never
   gated. `session_running_elsewhere` keeps its current meaning (the daemon's
   link-compatibility collision in `daemon-channels.ts` `collision()`) and is not
   reused.
3. Wire/UI: `elsewhereSessions` on the `running` frame and `GET /api/sessions`
   (additive, part of the ETag), a sidebar indicator distinct from the running
   spinner, a chat banner. First discovery comes from the normal session-list
   refresh, not only the 10 s tick that clears an existing badge; external
   presence never feeds local completion/unread transitions.
4. Explicit force: `?force=1` over HTTP and `force: true` on the browser link,
   preserving the original submission (images, finished uploads, recovered
   drafts, receipt/run ownership) through the 409 and the confirmation. Force
   bypasses only this advisory check, never host permissions or lifecycle fences.
5. Outbox: `session_owned_elsewhere` is a final, not-sent refusal
   (`may_have_been_sent = 0`, no automatic retry), so a background retry can
   never fork a conversation.
