# Coordinated GUI Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore GUI server updates and make old and current hosts recoverable, including forced, explicitly approved upgrades on Windows, Linux and macOS.

**Architecture:** Extend the existing durable prepare/commit/status workflows with a compatibility-bound plan. Reuse the host updater's release validation/preflight/swap machinery, introduce shared process/supervisor lifecycle operations, and isolate legacy execution behind confirmed fixed recovery commands. The local host remains independent of web-server lifetime and auto-starts only when absent.

**Tech Stack:** TypeScript, Bun server/binary, Node-compatible host modules, React, existing PowerShell/Windows process APIs and POSIX service tools. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-14-coordinated-gui-upgrades-design.md`

## Global Constraints
- Work only in `/root/git/.ompweb_worktrees/feat-coordinated-gui-upgrades`, based on freshly fetched `origin/main` `1f4a4bbfd267533242f34f1bd9f30255bd23b093`.
- Keep normal updates non-destructive. Force requires a plan-bound explicit confirmation; never waive release integrity, ownership, permissions or process identity.
- Windows is first-class. Native Windows process/binary/supervisor tests run on the existing `windows-latest` CI lane. Add macOS native verification for the recovery boundaries as necessary.
- Do not restart live production services or use production sessions for tests.
- Subagents skip all builds/lint/tests/formatters mid-flight. Parent runs focused integrated verification after changes settle, then fixes actual failures.
- Historical source/binaries run unchanged. Existing live failure reports and the successful scratch Linux bootstrap are the repro evidence; add regression coverage for uncertain lifecycle/force/coordinator edges.
- Main owns integration, shared caller changes, docs and final verification. Each implementation slice owns only the files assigned below.

## Review Focus
- An updater launched under a supervised host must survive that host stopping; prove with real processes, including Windows ancestry/job boundaries.
- No PID reuse, replaced control endpoint, changed supervisor configuration or changed approval plan may redirect a stop or filesystem replacement.
- A helper/candidate/server startup failure must restore the prior installation or report explicit partial recovery, never claim success from a POST or shell output.
- An incompatible candidate host may need maintenance-only staging before server cutover; ordinary application traffic must remain rejected and expected release/preflight identity must be proven.
- An offline host, missing runner, disabled updates or unknown compatibility must never be silently ignored by a server-only upgrade.

---

## Task 1: Shared process and supervisor lifecycle
**Files:** Create `lib/upgrade-process.ts`, `lib/upgrade-process.test.mjs`.

**Interfaces:** Export `UpgradeLaunch { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }`; export serializable `UpgradeProcess` with original pid/start identity, executable, installation path and verified supervisor kind/configuration. Export `inspectUpgradeProcess(input: { pid: number; installDir: string; role: 'server' | 'host'; launch: UpgradeLaunch }): Promise<UpgradeProcess>`, `stopUpgradeProcess(plan: UpgradeProcess): Promise<void>`, `restartUpgradeProcess(plan: UpgradeProcess, launch: UpgradeLaunch): Promise<number | undefined>`, and `launchDetachedUpgrade(launch: UpgradeLaunch): Promise<number | undefined>`.

- [ ] Write regression tests proving an independent helper survives caller termination, rejects changed process identity, and stops/restarts only the inspected service/task/supervisor.
- [ ] Implement native Linux systemd unit/cgroup discovery and cgroup escape; retain the existing configured service restart command, binding approval to its snapshot instead of rejecting every wrapper.
- [ ] Implement macOS foreground/launchd and owned restart-loop handling. Freeze the identified loop during replacement and resume it rather than installing a new login service or running a duplicate daemon.
- [ ] Implement native Windows process identity/ancestry, service/task discovery and independent helper launch (for example local CIM process creation), with explicit permissions failures. Never rely on Unix commands or merely detached child ancestry.
- [ ] Verify configured paths/ownership and re-check identity/configuration before stop/restart. Return truthful errors when a supervisor cannot be controlled.

## Task 2: Automatic local-host startup
**Files:** Modify `lib/hosts/local-bootstrap.ts`, `lib/hosts/local-bootstrap.test.mjs`, `instrumentation.node.ts`; create `lib/hosts/local-daemon-start.ts` and focused tests only if keeping bootstrap responsibilities separate is needed.

**Interfaces:** Export `ensureLocalHostDaemon(): Promise<{ started: boolean; pid?: number }>`; consumes `requestHostControl('status')` and `launchDetachedUpgrade(launch)` from Task 1. Keep `ensureLocalHostLink` and its locking behavior.

- [ ] Add regression coverage: absent daemon starts; existing current or legacy daemon is reused; concurrent starts leave one daemon; production-only behavior; a web-server exit does not kill its host.
- [ ] Probe the private control socket first. Start the same installed binary's `host` command or Node's package host entrypoint only after successful local-link preparation.
- [ ] Respect existing services/supervisors and update/recovery operations. Do not start an unmanaged duplicate while a service is starting or an update owns the host.
- [ ] Wire startup into `register()` without blocking web startup indefinitely; report meaningful startup failures, not fake online state.

## Task 3: Forced managed-host recovery and CLI
**Files:** Modify `lib/hosts/update-worker.ts`, `lib/hosts/updates.ts`, `lib/hosts/update-types.ts`, `lib/hosts/daemon.ts`; create `lib/hosts/recovery.ts` and recovery tests. Main wires CLI entrypoints in `server/binary.ts` and `bin/omp-web.js`.

**Interfaces:** Extend native update requests with an explicit `force?: boolean` and optional approved target compatibility supplied by the server. Export `runHostRecoveryCli(argv: string[]): Promise<number>` from `recovery.ts`; accepts strict `--operation`, `--version`, `--min-protocol`, `--max-protocol`, `--force` arguments. The new helper uses local control status to identify the old host; it must not require the old host's updater or runner to work. Export existing `stageBinary` and `preflightHostRelease` with minimal structural input types so the server updater can reuse release staging/preflight without fake daemon fields.

- [ ] Add tests for normal busy refusal versus confirmed force, force without integrity bypass, wrapped services, loop supervision, Windows replacement/rollback and operation replays.
- [ ] Reuse the existing state/claim/descriptor/swap worker rather than writing another archive parser or downloader. Use Task 1 lifecycle operations for inspected supervisors and detached launch.
- [ ] Make force stage/preflight first, then freeze new spawns and stop the daemon/session tree only at commit. Preserve the resume manifest and expose interrupted-session risk to the caller.
- [ ] Add machine-readable `canForceUpdate`/blocker metadata to host status so UI does not infer permission from English strings. A non-force-able integrity/permission failure remains blocked.
- [ ] Implement recovery CLI using the old private control endpoint and durable operation state, with an official release/source pin and expected target protocol. Detect shared server installations and use the coordinated server path rather than silently replacing active server assets.
- [ ] A staged candidate can acknowledge recovery through maintenance with matching operation/release/preflight proof when its application protocol is intentionally awaiting server cutover. Do not count a bare maintenance connection as health.

## Task 4: Isolated legacy bootstrap command construction
**Files:** Create `lib/hosts/legacy-recovery.ts`, `lib/hosts/legacy-recovery.test.mjs`. Main owns `hub.ts` integration.

**Interfaces:** Export `LegacyRecoveryRelease { version: string; repo: string; assets: Array<{name: string; digest: string}> }` and `buildLegacyRecoveryBootstrap(input: { operationId: string; helper: LegacyRecoveryRelease; targetVersion: string; compatibility: {min: number; max: number}; platform: string; force: boolean }): string`. Export fixed legacy runner envelopes for RPC and runner builds; no arbitrary command parameter exposed to HTTP clients.

- [ ] Validate operation/version/repository/digest/platform before constructing commands; add hostile quoting/path tests and missing-helper capability tests.
- [ ] POSIX bootstrap selects its architecture, downloads the official pinned archive with bounded tools, verifies its digest and streams only the exact binary member to a private scratch path. Do not extract archive-derived filesystem paths. Check the helper's unique recovery marker before invoking the new CLI (old unknown subcommands otherwise start a server).
- [ ] Windows bootstrap uses PowerShell/.NET, architecture detection, SHA-256 and exact ZipArchive binary entry streaming to a private scratch file. No bash, curl.exe, tar or Unix utilities required by the bootstrap itself. The legacy runner's existing native bash operation is only the transport for invoking PowerShell.
- [ ] The helper is detached by Task 1 before it terminates anything. Bootstrap secrets come from existing private host configuration when required, never embed bearer tokens in argv. Prefer official public release assets so no new auth endpoint is required.
- [ ] Keep operation identity stable across retries. Completion comes from the new host's authenticated operation receipt; bootstrap stdout is diagnostic only.

## Task 5: Server upgrade compatibility plan and standalone worker
**Files:** Create `lib/upgrade-plan.ts`, `lib/server-update-worker.ts` and focused tests; modify `lib/self-update.ts`, `app/api/app-update/route.ts`, `server/binary.ts`, `bin/omp-web.js` and existing tests as needed. Main owns these files.

**Interfaces:** `UpgradePlan` is durable and includes id, server target/source, candidate protocol range, registered-host identity/version inventory, required transitions, recovery capability and session interruption requirements. `prepareSelfUpdate` returns the plan plus existing attempt/version fields; commit requires plan-bound explicit approval and optional force authorization. Existing status/acknowledge remain supported with truthful stages.

- [ ] Add tests for binary self-update, incompatible hosts, missing/offline hosts, changed plan/candidate, explicit force approval, interrupted coordinator, rollback and package launcher restart.
- [ ] Read both candidate protocol minimum and maximum from trusted release metadata/source. Bind approval to the exact release identity and participant set, re-check before any stop.
- [ ] Stage/preflight all required participants before cutover; use their maintenance/recovery paths while rejecting incompatible ordinary application traffic. Do not assume hosts can acknowledge an application protocol the old server cannot speak.
- [ ] Reuse Task 3 release staging/preflight and Task 1 process lifecycle for a standalone compiled server-update worker copied outside the installation. Preserve current Node/npm/bun paths and fix any exercised broken worker descriptor/restart contracts.
- [ ] Persist host and server steps, gate hard-incompatible server-only updates, restore previous installations on failure and expose partial rollback failures honestly.
- [ ] Initial local-host migration participates even when no local daemon exists. Start it from the selected installed release after cutover.

## Task 6: Hub integration and GUI approval/progress
**Files:** Modify `lib/hosts/hub.ts`, `app/api/hosts/[id]/updates/route.ts`, `components/HostUpdates.tsx`, `components/HostUpdates.test.mjs`, `components/AppUpdateDialog.tsx`, `components/AppShell.tsx`, `components/SettingsConfig.tsx`, matching tests and locale files. Main owns these until bounded UI work can be assigned without overlap.

- [ ] Route modern hosts through maintenance and legacy hosts through only update operations by default. Enable one operation-bound, recovery-only `open`/`stdin` channel solely after explicit forced recovery authorization. Never admit ordinary sessions under a legacy shim.
- [ ] Handle historical RPC-form and runner-form stdin envelopes without assuming package version identifies the shape. Deduplicate recovery spawn with `creationId` and a helper-side lock. Persist pending operations across server restart.
- [ ] Add per-host Force action and explicit session-termination confirmation. Enforce the same authorization and plan checks server-side.
- [ ] Restore the server Update button for supported binary installs and show the proposed server/host transitions, compatibility reasons, interruption warning and durable progress/recovery state in the existing dialog.
- [ ] Preserve origin/auth/input validation and disabled-update settings for every new action.

## Task 7: End-to-end verification and delivery
**Files:** Extend real historical integration coverage, smoke scripts and `.github/workflows/verify-pr.yml`; update README, changelog and the existing local/remote host design sections and obsolete agent guidance.

- [ ] Linux: real historical 0.6.0/0.7.0 binary/package recovery, wrapped service, busy forced update, helper survives daemon stop, no duplicates and rollback.
- [ ] Windows CI: real Windows binary startup, detached helper survives caller tree termination, service/task handling, `.exe` replacement and rollback, legacy and modern update paths. Add native macOS recovery validation; do not substitute mocked platform values.
- [ ] Browser: actual Settings → Hosts normal/Force flow and server-update plan/approval/progress against scratch installations, including a hard protocol incompatibility.
- [ ] Parent runs narrow integrated tests once, then typecheck/build/browser/targeted native checks as relevant. Do not claim Windows completion until its CI proof arrives through pr-watcher.
- [ ] Run `graphify update .`; preserve tracked graph output. Dispatch one condensed adversarial reviewer for contract/correctness/test honesty/over-engineering, fix findings, commit and push.
- [ ] Open the PR, register pr-watcher, handle CI and request available authorized Codex/CodeRabbit reviews after green CI. No production deployment or forced live restart without separate approval.
