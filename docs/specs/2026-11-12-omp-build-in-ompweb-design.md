# Building omp in ompweb's CI — design

Date: 2026-11-12. Branch: `ci/omp-build` (on `feat/omp-runner`, PR #460).
Replaces: `andrebrait/integration-ci` `docs/specs/2026-11-11-omp-auto-integration-design.md` §1, §2, §4–§6 (the round, the fork release, trust, script) and §3 (omp-web's **Custom** omp update source, never implemented). §3b (ompweb pre-release channel) and §3c (GitHub token) are unaffected.
Depends on: #460 (`runner/`, `ompweb-omp`) and can1357/oh-my-pi#19075 (`runSessionHost`) carried in the integration build.

## Why

ompweb now ships its own omp build (`ompweb-omp`, `runner/`). Today it compiles against npm `@oh-my-pi/pi-coding-agent@18.19.0` plus a Bun patch (`runner/patches/`) that back-ports `runSessionHost`, while the omp the user runs (`/opt/omp-patched`) comes from `andrebrait/integration-ci`'s hourly integration of upstream releases plus the user's carried PRs. Two omps, two pipelines. This design makes one: the integration build is produced in `kahme247/ompweb`, every ompweb release and pre-release compiles `ompweb-omp` against it, and the hourly round keeps building omp between ompweb releases.

## Decisions

### D1. What moves, and where (workflows, triggers, `workflow_call` boundaries)

Into `kahme247/ompweb`:

| integration-ci | ompweb | Trigger | Boundary |
|---|---|---|---|
| `.github/workflows/omp-auto.yml` | `.github/workflows/omp-auto.yml` | `schedule` `17 * * * *`; `workflow_dispatch` (`tag`, `force`, internal `candidate`) | caller of `omp-build.yml` |
| `.github/workflows/omp.yml` | `.github/workflows/omp-build.yml` | `workflow_call` and `workflow_dispatch` (`repo`, `sha`, `promote`) | reusable; called by `omp-auto.yml`, `prerelease.yml`, `publish.yml`; dispatched by `integration build` |
| `.github/actions/omp-agent`, `.github/actions/omp-round` | same paths | composite | used by the repair jobs only |
| `integration`, `changelog-merge`, `integration.test.sh` | `ci/integration`, `ci/changelog-merge`, `ci/integration.test.sh` | — | — |
| `scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh` | `ci/scripts/` | — | — |
| `prompts/omp-repair.md` | `ci/prompts/omp-repair.md` | — | — |
| `config/root--git--oh-my-pi.sh`, `config/fixups/root--git--oh-my-pi/` | `ci/config/root--git--oh-my-pi.sh`, `ci/config/fixups/root--git--oh-my-pi/` | — | — |

`ci/` is a new top-level directory; it is outside `package.json` `files`, so nothing ships to npm. Workflows check the fork out at the workspace root and ompweb at `ompweb/` (sparse: `ci/`, `.github/actions/`), so paths read `ompweb/ci/integration` and `INTEGRATION_CONFIG_DIR=$GITHUB_WORKSPACE/ompweb/ci/config`; composite actions are `./ompweb/.github/actions/omp-*`. The fork's own `./.github/actions/bun-install` and `bazel-cache` keep their root paths.

`omp-build.yml` is today's `omp.yml` (`build` = `BUILD_CMD`/`TEST_CMD`, `natives` × 7, `binaries` × 6, `smoke` × 6) with three changes:

1. A first job `resolve` (no fork code): input `ref` *or* `sha`. Outputs `sha`, `tag` and `exists` — whether the fork already has a release for that sha with every asset in D4. When `exists`, every build job is skipped and callers reuse the release.
2. A job `pack` (needs `natives`; fork code, read-only token): the npm tarballs ompweb's runner compiles against (D3), uploaded as artifact `omp-packages`.
3. `publish` no longer calls integration-ci's `publish.yml` (rolling `oh-my-pi` release, retired). It is the old `omp-auto.yml` `release` job, moved here and made idempotent: creates the fork release (D4) or adds missing assets to it; with `promote: true` it also moves `integration-release`, marks the release latest on the fork and prunes.

`omp-auto.yml` keeps its jobs and trust split (detect, rebase, rebase-repair(-push), integrate(-repair), candidate, build, build-repair(-push), escalate). Its `release` job is gone: `build` calls `omp-build.yml` with `promote: true`, which publishes.

ompweb's own workflows:

- `prerelease.yml` and `publish.yml` gain a first job `omp` (`uses: ./.github/workflows/omp-build.yml`, `ref: integration-release`, `promote: false`); the existing job `needs: omp` and, before `build-release-binaries.sh`, runs `bun runner/scripts/use-omp-build.ts <tag>` (D3).
- `verify-pr.yml` and `omp-runner.yml` are unchanged: they install the committed pin (D3) with `--frozen-lockfile` and never build omp.
- No omp workflow has a `pull_request` or `pull_request_target` trigger.

integration-ci's `ompweb.yml` (ompweb's own integration build, `deploy/integration`) stays there and keeps working: it installs the runner from the committed pin (public URLs) exactly as it installs the npm pin today.

### D2. How a (pre)release obtains the omp build

Default ref: `integration-release` of `andrebrait/oh-my-pi` — the last commit an auto round built, tested, smoke-tested and released (Q1). Because the hourly round releases every commit it moves that branch to, a (pre)release normally **reuses** the published build: `resolve` finds the release, the build jobs skip, and the ompweb job downloads tarballs. Added time ≈ 1 minute (today's pre-release takes ~2 min).

When the release for the resolved sha is missing (an explicit `ref`/`sha`, or a release pruned by hand), the same run **builds** it through the same jobs, publishes it to the fork (`promote: false`), and continues. Measured on integration-ci's last full round (run 43212295671): `build` 22 min and `natives` 12–16 min in parallel, `binaries` and `smoke` ~1 min each, so ~25 min with a warm cache. A cold bazel cache (first round in the new repository) is bounded by the 120-minute `natives` timeout.

Bazel caching moves as is: `actions/cache` disk caches keyed `bazel-disk-v1-<build|target>-<hash(Cargo.lock, MODULE.bazel.lock)>`, pruned to used entries and saved only by green runs. Caches are per repository, so the first ompweb round starts cold. One lockfile generation is ~4.8 GB (8 × ~600 MB, measured in integration-ci) plus ~440 MB of Bun cache; GitHub's default repository limit is 10 GB, shared with ompweb's npm caches (Q10). Every omp job runs on `main`'s ref (schedule, dispatch on main, `workflow_run`/tag pushes), so all share one cache scope.

### D3. Compiling `ompweb-omp` against the integration build

The npm pin (`@oh-my-pi/*@18.19.0`) and `runner/patches/@oh-my-pi%2Fpi-coding-agent@18.19.0.patch` are replaced by the integration build's own npm tarballs:

- `omp-build.yml` `pack` produces exactly what upstream would publish to npm for that commit: every public workspace package packed with `bun pm pack` after upstream's manifest rewrite (`scripts/ci-release-publish.ts`: `catalog:`/`workspace:` resolved, `prepack` run, so `pi-coding-agent` carries `dist/docs-index.generated.txt` and `scripts/`), plus one `@oh-my-pi/pi-natives-<os>-<arch>` leaf package per target (`packages/natives/scripts/gen-npm-packages.ts`) holding that target's `.node` files from `natives`. Versions are left as the base release's (`18.19.0`), so `ompweb-omp --version` and `HOST_VERSION_PATTERN` see a plain semver; the integration sha is in the fork release and in ompweb's release notes.
- They are release assets (`omp-packages-<sha10>.tar` plus `omp-packages.json`, a name → file index) on the fork release (D4).
- `runner/package.json` keeps its dependency names and adds `overrides` mapping every `@oh-my-pi/*` package — transitive ones and the five leaf packages included — to its tarball URL on one fork release. That release is **the committed pin**; `runner/bun.lock` records it with integrity hashes. `patchedDependencies` and `runner/patches/` are deleted.
- `runner/scripts/use-omp-build.ts <fork-tag>` rewrites the overrides to another release and runs `bun install` (lockfile updated). It is how a human or bot bumps the pin, and what a (pre)release runs with the `tag` from `omp-build.yml` `resolve` before building; the (pre)release's lockfile differs from the committed one only in those URLs and hashes, and its notes name the omp release.
- `runner/scripts/build-binary.ts` is unchanged: it resolves the same package layout from `node_modules`. `bun install --os='*' --cpu='*'` keeps installing every leaf.
- Drift: runner code that no longer type-checks against the release's omp fails the (pre)release (`tsc` runs in `omp-runner.yml` on PRs against the pin; the (pre)release job adds `bunx tsc -p runner`). An omp API change therefore needs an ompweb PR that bumps the pin and adapts the runner.

Spike first (plan task 1): Bun must honour `overrides` with tarball URLs for transitive dependencies. If it does not, the fallback is to unpack the omp checkout at that sha into the job and add `runner/` to its Bun workspace (`workspace:*`), building the runner there.

### D4. Where omp builds are published

On the fork, `andrebrait/oh-my-pi`, as today — never on `kahme247/ompweb`. ompweb's in-app updater reads only `kahme247/ompweb` (`releases/tags/v<version>`, npm), its pre-release list is ompweb's own, and nothing in ompweb reads the fork's "latest", so an omp build can neither become ompweb's latest nor appear as an ompweb pre-release.

- Tag `<nearest upstream v* tag>-int.<sha7>` (e.g. `v18.19.0-int.77d6529`), target the built sha. A promoted (auto-round) release is marked latest on the fork; a non-promoted one (a (pre)release's in-run build, a manual `integration build`) is created `--latest=false`.
- Assets: `omp-linux-x64`, `omp-linux-arm64`, `omp-darwin-x64`, `omp-darwin-arm64`, `omp-windows-x64.exe`, `omp-windows-arm64.exe`, `SHA256SUMS.txt` (upstream's names, unchanged), `omp-packages-<sha10>.tar`, `omp-packages.json`; notes as today (upstream body + `## Carried patches`).
- Promotion moves `integration-release`; pruning keeps the newest 10 `-int.` releases **plus** the one `runner/package.json` on `kahme247/ompweb` main pins (read through the API before deleting), so `verify-pr`, `omp-runner.yml` and integration-ci's `ompweb.yml` never lose their tarballs.
- Hourly job output: for each new upstream release, one promoted fork release. It creates no ompweb release or pre-release and opens no ompweb PR (Q7 asks whether it should open the pin-bump PR).
- integration-ci's rolling `oh-my-pi` release is retired with integration-ci's omp workflows.

### D5. Trust model in a public repository

Unchanged from integration-ci, per job:

| Job | Runs | Secrets | `GITHUB_TOKEN` |
|---|---|---|---|
| `detect` | no fork code | — | `actions: read` |
| `rebase` | git only | `OMP_FORK_TOKEN` | `contents: read` |
| `*-repair` | fork code + agent | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | `contents: read` (`actions: read` for build-repair) |
| `integrate`, `omp-build.yml` `build`/`natives`/`binaries`/`pack` | fork code | — | `contents: read` |
| `smoke` | built binaries | — | none |
| `*-repair-push`, `candidate`, `omp-build.yml` `publish` | no fork code | `OMP_FORK_TOKEN` | `contents: write` only where fixups are committed; `actions: write` for build-repair-push |
| `escalate` | no fork code | — | `issues: write`, `actions: read` |

New in ompweb:

- **Fork PRs.** No omp workflow triggers on `pull_request`/`pull_request_target`; `verify-pr.yml` keeps `pull_request` (no secrets, read-only token for forks). `prerelease.yml` stays `workflow_run` on `push` to `main` only, so a fork PR never reaches `omp-build.yml` or a secret.
- **Who can read the secrets.** Repository secrets reach any workflow on any branch a write collaborator pushes (today `kahme247`, `andrebrait`). The three secrets go in an Environment `omp-integration` whose deployment-branch policy is `main` only, and the jobs that need them declare it (Q5; needs a repository admin).
- **Fixup commits land on ompweb's `main`, the product branch.** In integration-ci a compromised repair could only touch CI scripts; here it could touch shipped code. `commit-fixups.sh` therefore refuses a patch that touches any path outside `ci/config/fixups/root--git--oh-my-pi/` (checked with `git apply --numstat` before `--index`). Commits pushed with `GITHUB_TOKEN` start no workflow, so a fixup commit triggers no Verify PR and no pre-release.
- **Caches.** Build jobs run carried third-party code (e.g. #7851) with the runner's cache-write token, now in the same scope as ompweb's npm cache. ompweb's `npm ci` and the runner's `bun install` verify package integrity against their lockfiles, so a planted cache entry cannot change what installs; bazel's disk cache was already shared with that code in integration-ci.
- `permissions: {}` at workflow level; per-job as above. `persist-credentials: false` on every fork-code checkout.
- Agent jobs keep upstream's own release `omp-linux-x64` (digest-checked) as the agent binary, not the code under repair.

### D6. Apple SDK mirror

`natives` downloads the SHA256-pinned Apple SDK package from `https://github.com/$GITHUB_REPOSITORY/releases/download/apple-sdk/<sha256>.pkg` because `swcdn.apple.com` answers GitHub runners 403. In ompweb that would add an `apple-sdk` non-pre-release to `kahme247/ompweb`, which GitHub can mark latest once no `v*` release outranks it. The mirror moves to the fork instead: release `apple-sdk` on `andrebrait/oh-my-pi` (`--latest=false`), asset `d55351824fd17742fd6e1e7a252fa1028698f32147ee48be9a6b75442bf30575.pkg` (70,553,676 bytes, copied from integration-ci's release); the step reads `https://github.com/andrebrait/oh-my-pi/releases/download/apple-sdk/<sha256>.pkg`. The digest check and Apple fallback stay (Q9).

### D7. `/opt/omp-patched` (the TUI omp on ai-dev)

`DEPLOY_CMD` is unchanged (copies `$BUILD_DIR/omp` into `/opt/omp-patched/releases/<sha10>/`, swaps `current`). Its `BUILD_DIR` now comes from the fork release:

- Config: `CI_REPO=kahme247/ompweb`, `CI_WORKFLOW=omp-build.yml`, new `CI_RELEASE_REPO=andrebrait/oh-my-pi`, new `CI_REMOTE=upstream` (D10).
- `integration build`: if the fork has a release for the branch head, download its `omp-$CI_TARGET` and `SHA256SUMS.txt`, verify, place as `$BUILD_DIR/omp`; otherwise dispatch `omp-build.yml` (`repo`, `sha`, `promote=false`) and, once green, download from the release it published.
- Deploying an auto round: `git -C /root/git/oh-my-pi fetch origin && git -C /root/git/oh-my-pi branch -f integration origin/integration-release && integration build && integration deploy` (the build step reuses the release; no CI run).

### D8. Dropping RPC from the integration

| Item | Change |
|---|---|
| `EXTRA_PRS` | `'7851=carry/pr-7851'` (drops `18646=carry/pr-18646`, pasquale95's RPC form dialog) |
| `SKIP_PRS` (new line) | `'18668'` — the user's own "correlate RPC input with client message IDs"; 21 of its 29 files are RPC, the rest exist to feed RPC, and `runner/src/correlation.ts` rebuilds the same contract from public API (Q4) |
| `TEST_CMD` (line 23 list) | remove `rpc-queued-message`, `rpc-cancel-subagent`, `rpc-steer-subagent` |
| `TEST_CMD` (line 25 list) | remove `rpc-native-input`, `rpc-input-frame`, `rpc-prompt-result`, `rpc-skill-command`, `rpc-compatible-primitives`, `rpc-extension-ui`; comment loses "and host RPC contracts" |
| `TEST_CMD` (lines 59–60) | delete "Carried PR #18646 (RPC form dialog) contract tests" and its separate `bun test …rpc-extension-ui.test.ts packages/tui/test/html-form.test.ts` process (`html-form.test.ts` is upstream's TUI test, run by upstream CI) |
| fixups | delete `18668-prompt-claim-optional.patch`, `18668-resolve.patch`, `18668-skill-command-client-message-id.patch` |
| `STACKED_PRS` | unchanged (neither PR is stacked) |
| prompt | `ci/prompts/omp-repair.md` loses RPC wording tied to 18646 if any |

All `rpc-*` paths are `packages/coding-agent/test/rpc-*.test.ts`; 10 occurrences (rpc-extension-ui twice).

RPC work already merged upstream (#18929 checkbox state, #18930 form context by roboomp, and the earlier merged `feat(rpc)` PRs) is in the base release and cannot be left out. Mixed PRs stay: #14148 and #14458 (skill diagnostics: TUI and RPC; #14458 is stacked on #14148) and #14608 (one `rpc-mode.ts` hunk) (Q3). Later resolution patches written with #18668/#18646 present (`18780-resolve.patch`, `14458-resolve.patch`, `15729…`, `15896…`) may stop applying; the first round's `integrate-repair` or a local `integration rebuild` refreshes them.

### D9. ompweb updater: the omp row

`ompweb-omp` is versioned with ompweb; hosts get a new omp only by updating ompweb. Today (#460) the omp row still runs `omp update` through `resolveOmpBin()`, i.e. `ompweb-omp update` — upstream's self-updater, which on a compiled binary replaces it with upstream's `omp` [INFERENCE from `update-cli.ts` `replaceBinaryForUpdate`; not run]. Changes:

- `lib/omp/updates.ts`: `runOmpUpdate`, `checkOmpUpdate`, the cached check and `parseOmpUpdateStatus` are deleted.
- `lib/self-update.ts`: `Kind` is `"app"` only; the `omp-self-update` state files are no longer written.
- `app/api/omp-update/route.ts`: `check`/`update`/`commit`/`status`/`acknowledge` removed; `restart` (restart all sessions) moves to an existing sessions route or stays alone in this route.
- `lib/hosts/update-types.ts`/`updates.ts`/`daemon.ts`: `HostUpdateTarget` is `"ompweb"`; `HostUpdateInfo.omp` becomes `{ currentVersion }` from `getOmpVersion()`; `startHostUpdate("omp")` is rejected as `invalid_target`. Older servers that send `omp` get that error.
- `components/HostUpdates.tsx`: the omp row shows the version with "updated with ompweb", no button; the Settings omp update card goes the same way. i18n en/ja/zh-CN/zh-TW.
- The **Custom** source of the 2026-11-11 design is not built.

### D10. integration-ci deletion and `integration` changes

Deleted from integration-ci after cut-over: `.github/workflows/omp-auto.yml`, `omp.yml`; `.github/actions/omp-agent`, `omp-round`; `scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh`; `prompts/omp-repair.md`; `config/root--git--oh-my-pi.sh`; `config/fixups/root--git--oh-my-pi/`; the `oh-my-pi` and `apple-sdk` releases; README's oh-my-pi section. `docs/specs/2026-11-11-omp-auto-integration-design.md` gets a one-line "superseded by kahme247/ompweb `docs/specs/2026-11-12-omp-build-in-ompweb-design.md`". `publish.yml`, `ompweb.yml`, `graphify.yml`, `superpowers.yml` stay. The `omp-auto` issue label stays for old issues.

`integration` script (ompweb `ci/integration`):

- `CI_REMOTE` (default `origin`): the remote `ci_build` compares the config and `.github` against before dispatching. ompweb's local checkouts have `origin` = `andrebrait/ompweb` and `upstream` = `kahme247/ompweb`, and CI reads `kahme247/ompweb` main.
- `CI_RELEASE_REPO` (optional): D7's release lookup and download in `ci_build`, replacing the `project:`/`artifact:` sed lookup for this config (that lookup stays for `ompweb.yml`, `graphify.yml`, `superpowers.yml`).
- Tests in `ci/integration.test.sh` for both (gh stubbed).

Host wiring (ai-dev): `~/.config/integration` stops being a symlink to `integration-ci/config` and becomes a directory of per-file symlinks (graphify, superpowers, ompweb, pins → integration-ci; `root--git--oh-my-pi.sh` and `fixups/root--git--oh-my-pi` → `/root/git/ompweb-worktrees/omp-ci/ci/config/…`, a worktree tracking `upstream/main`). `~/.local/bin/integration` follows Q8.

### D11. Rollout and rollback

1. #460 merges (or this branch rebases onto whatever lands).
2. Upload the Apple SDK package to the fork's `apple-sdk` release (D6).
3. ompweb PR A: `ci/`, the omp workflows and actions, `omp-build.yml` with `resolve`/`pack`/`publish`, the D8 config, the script changes. `omp-auto.yml` lands **without** its `schedule` (dispatch only). Secrets/Environment added (Q5).
4. Disable integration-ci's `omp-auto.yml` schedule (`gh workflow disable`), so two rounds never race on the fork's branches and fixups.
5. Dispatch `omp-auto.yml` with `force=true` on the current upstream tag; it must carry #19075 and produce a promoted fork release with `omp-packages-*`. Cold cache: allow ~2 h.
6. ompweb PR B: runner overrides pinned to that release, `use-omp-build.ts`, patch removed, `prerelease.yml`/`publish.yml` call `omp-build.yml`.
7. ompweb PR C: updater omp row (D9).
8. Add the `schedule` to ompweb's `omp-auto.yml`. Rewire ai-dev (D10) and deploy `/opt/omp-patched` from the new release (D7).
9. After one green scheduled round and one green pre-release: delete integration-ci's omp files and releases (D10).

Rollback: until step 9, re-enable integration-ci's schedule and disable ompweb's (one `gh workflow` call each). PR B reverts to the npm pin and patch (`git revert`), and fork releases stay valid either way. After step 9, restore the deleted files from integration-ci's history.

## Risks

- Bun `overrides` with tarball URLs for transitive dependencies is unverified (spike, fallback in D3).
- #19075 can change in review; the runner breaks at `tsc` on the next pin bump, not at runtime.
- Dropping #18668/#18646 can invalidate later resolution patches; the first round may need the agent or a local rebuild.
- First ompweb round runs a cold bazel cache; two cache generations exceed 10 GB together.
- A (pre)release whose `resolve` misses the release adds ~25 min (warm) to 2 h (cold).
- Fixup commits by automation on ompweb `main`, limited to the fixups path.
- Escalation issues and repair notes (log tails) become public in whichever repository receives them.

## Open questions for the user

1. **Which fork ref does an ompweb (pre)release build?** `integration-release` (last green auto round; reuses its build, ~1 min) — this design's default — or `integration` (pushed by local `integration build`) or `integration-candidate` (auto round, before build)?
2. **Should the hourly round also run when a carried PR's head changes**, not only on a new upstream release? Today a new or updated PR (e.g. #19075) waits for the next upstream tag or a manual `force` dispatch.
3. **#14148 and #14458** (skill diagnostics for TUI and RPC; #14458 stacked on #14148) and **#14608** (one RPC hunk): keep them (this design) or leave them out as RPC?
4. **Confirm #18668 counts as RPC-only** and goes to `SKIP_PRS` (its non-RPC files are AgentSession/SessionManager plumbing for the RPC `clientMessageId`).
5. **Secrets placement:** repository secrets, or an Environment `omp-integration` limited to `main` (needs a `kahme247/ompweb` admin), and should outside-collaborator fork PRs require approval to run workflows?
6. **Where do escalation issues go:** `kahme247/ompweb` issues (public, label `omp-auto`) or `andrebrait/oh-my-pi` issues (via `OMP_FORK_TOKEN`, needs Issues write on it)?
7. **Pin bumps:** should the hourly round open an ompweb PR bumping `runner/` to each new fork release? A PR opened with `GITHUB_TOKEN` does not start Verify PR, so that needs a PAT or GitHub App with access to `kahme247/ompweb`; otherwise bumps are manual (`bun runner/scripts/use-omp-build.ts <tag>`).
8. **Home of the `integration` script:** ompweb's `ci/integration` becomes the one copy the host uses for every project (graphify, superpowers, ompweb deploy), or integration-ci keeps its own copy for those?
9. **Apple SDK mirror** on the fork (`andrebrait/oh-my-pi` release `apple-sdk`, this design) — acceptable, or another location?
10. **Actions cache budget** on `kahme247/ompweb`: ~5 GB per omp lockfile generation against the 10 GB default; raise the limit, or accept evictions (a cold `natives` costs up to 2 h)?
11. **Automation committing fixups to ompweb `main`** (path-restricted, `GITHUB_TOKEN`): acceptable to `kahme247`, or should fixups live on a separate branch?
