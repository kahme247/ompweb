# Building omp in ompweb's CI — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the omp integration round runs in `kahme247/ompweb`; every ompweb release and pre-release compiles `ompweb-omp` against the integration build of `andrebrait/oh-my-pi`; the hourly round keeps building omp between ompweb releases; integration-ci's omp workflows are deleted.

**Spec:** `docs/specs/2026-11-12-omp-build-in-ompweb-design.md` (D1–D11). Read it first. The open questions there are unanswered; tasks that depend on one say so and use the spec's default.

**Base:** `feat/omp-runner` (#460). Sources to copy from: `/root/git/integration-ci` at `5db42d1` (read-only).

## Global Constraints

- Copy integration-ci files with their history-free content, then edit; keep their comments' style (why, not what) and the pinned action SHAs.
- Workflows: `permissions: {}` at the top, per-job grants as in spec D5; `persist-credentials: false` on every fork checkout; no `pull_request_target`.
- The fork is checked out at the workspace root, ompweb at `ompweb/` (sparse `ci/` + `.github/actions/`). Paths: `ompweb/ci/integration`, `INTEGRATION_CONFIG_DIR=$GITHUB_WORKSPACE/ompweb/ci/config`, `./ompweb/.github/actions/omp-agent`.
- Nothing is published to `kahme247/ompweb` releases by an omp job.
- Do not enable `omp-auto.yml`'s `schedule` before Task 8.
- Commit titles follow the log (`ci(omp): …`, `feat(runner): …`, `feat(hosts): …`). One PR per group: A = Tasks 2–4, B = Task 6, C = Task 7.

## Review Focus

1. A repair agent writes outside `ci/config/fixups/root--git--oh-my-pi/` → `commit-fixups.sh` fails and nothing reaches `main`. (Task 2)
2. A pre-release for an sha the fork already released → no bazel job runs; the ompweb job installs that release's tarballs. (Tasks 3, 6)
3. Pruning never deletes the release pinned in `runner/package.json` on main. (Task 3)
4. `ompweb-omp --version` still prints a plain semver; the host omp row has no update button and `startHostUpdate("omp")` is `invalid_target`. (Tasks 6, 7)
5. integration-ci's `ompweb.yml` still builds `deploy/integration` with the new pin. (Task 6)

---

### Task 1: spike — Bun overrides to tarball URLs

**Files:** none committed (scratch dir under `/tmp`).

- [ ] `npm pack` `@oh-my-pi/pi-coding-agent@18.19.0` and every `@oh-my-pi/*` it depends on (transitively), plus `@oh-my-pi/pi-natives-linux-x64@18.19.0`; serve the directory with `python3 -m http.server`.
- [ ] Copy `runner/` to `/tmp/spike/runner`; drop `patchedDependencies`; add `overrides` mapping every `@oh-my-pi/*` name to `http://127.0.0.1:<port>/<tgz>`; `bun install`.
- [ ] Verify: `bun.lock` lists the URL (with integrity) for transitive `@oh-my-pi/*` entries, `ls node_modules/@oh-my-pi` shows one copy each, and `bun scripts/build-binary.ts linux-x64` succeeds (the patch is missing, so expect only the `runSessionHost` `tsc` errors, not resolution errors).
- [ ] If transitive overrides do not take: record it in the spec's D3 and switch Task 6 to the workspace fallback (runner added to the omp checkout's `workspaces`). Report before continuing.

### Task 2: `ci/` — script, config, fixups, helpers

**Files:** create `ci/integration`, `ci/changelog-merge`, `ci/integration.test.sh`, `ci/scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh`, `ci/prompts/omp-repair.md`, `ci/config/root--git--oh-my-pi.sh`, `ci/config/fixups/root--git--oh-my-pi/*.patch` (copies from integration-ci, mode 755 for executables).

- [ ] Copy the files. In `omp-repair.md`, `collect-round.sh` and comments: `ci/` → `ompweb/ci/`, `andrebrait/integration-ci` → `kahme247/ompweb`, `ci/config` → `ompweb/ci/config`. `collect-round.sh`: `git -C ompweb …` and `-- ci/config/fixups`.
- [ ] Config (spec D8): `EXTRA_PRS='7851=carry/pr-7851'` and its comment loses the 18646 line; add `SKIP_PRS='18668'` with a one-line why; `CI_REPO=kahme247/ompweb`, `CI_WORKFLOW=omp-build.yml`, add `CI_RELEASE_REPO=andrebrait/oh-my-pi`, `CI_REMOTE=upstream`; remove the ten `packages/coding-agent/test/rpc-*.test.ts` occurrences; delete the "Carried PR #18646" comment and its `TEST_CMD+=` line; "and host RPC contracts" leaves the comment above the second list.
- [ ] Delete `ci/config/fixups/root--git--oh-my-pi/18668-*.patch` (3 files).
- [ ] `commit-fixups.sh`: before `git apply --index`, fail when `git apply --numstat "$patch"` names a path not under `ci/config/fixups/root--git--oh-my-pi/`.
- [ ] `integration`: `ci_build` fetches and diffs against `${CI_REMOTE:-origin}/main`. With `CI_RELEASE_REPO`: look up `gh release list -R "$CI_RELEASE_REPO"` for a tag ending `-int.${sha:0:7}`; if found, download `omp-$CI_TARGET` and `SHA256SUMS.txt`, `sha256sum -c` the one line, install as `$dir/omp`; if not, dispatch (`-f repo -f sha -f promote=false`), watch, then do the same download. The `project:`/`artifact:` path stays for configs without `CI_RELEASE_REPO`.
- [ ] `integration.test.sh`: cases for `CI_REMOTE` (diff against the named remote) and `CI_RELEASE_REPO` (reuse path downloads and verifies; digest mismatch fails), `gh` stubbed as the file already does; a case for the `commit-fixups.sh` path guard.
- [ ] Verify: `bash ci/integration.test.sh` passes; `bash -n` on every script; `source ci/config/root--git--oh-my-pi.sh; grep -c 'rpc-' <<<"$TEST_CMD"` prints `0`.
- [ ] Commit `ci(omp): move the integration script, config and fixups from integration-ci`.

### Task 3: `omp-build.yml`

**Files:** create `.github/workflows/omp-build.yml` (from integration-ci `omp.yml`).

- [ ] Inputs (`workflow_call` and `workflow_dispatch`): `repo` (default `andrebrait/oh-my-pi`), `ref` (default empty), `sha` (default empty), `promote` (boolean, default false). Secret: `OMP_FORK_TOKEN` (required for `workflow_call`). Outputs: `sha`, `tag`.
- [ ] Job `resolve` (`ubuntu-24.04`, `contents: read`, no fork code): sha = input `sha` or `gh api repos/$repo/commits/$ref --jq .sha`; tag = the newest `v*` tag reachable from it (blobless clone, `git describe --tags --match 'v*' --abbrev=0`) + `-int.${sha:0:7}`; `exists=true` when the fork release has every D4 asset.
- [ ] `build`, `natives`, `binaries`, `smoke`: today's jobs, `if: needs.resolve.outputs.exists != 'true'`, checking out `needs.resolve.outputs.sha`; ompweb's config is sourced from `ompweb/ci/config/`. Apple SDK step: mirror URL `https://github.com/andrebrait/oh-my-pi/releases/download/apple-sdk/<sha256>.pkg`.
- [ ] Job `pack` (needs `natives`, fork code, `contents: read`): `bun install --frozen-lockfile`, natives artifacts into `packages/natives/native`, pack every public package as `scripts/ci-release-publish.ts` does without publishing (use its `--dry-run` if it leaves the tarballs; otherwise call its manifest rewrite and `bun pm pack` directly), generate the five leaf packages for the targets `runner/scripts/build-binary.ts` knows (`gen-npm-packages.ts`), tar them as `omp-packages-<sha10>.tar` with `omp-packages.json` (`{ "<npm name>": "<tgz>" }`). Upload artifact `omp-packages`.
- [ ] Job `publish` (needs `build`, `smoke`, `pack`; no fork code; `permissions: {}`; `OMP_FORK_TOKEN`): the old `omp-auto.yml` `release` job, idempotent — create the release if missing (`--latest` only when `promote`, else `--latest=false`), upload missing assets (binaries, `SHA256SUMS.txt`, packages tar and index). With `promote`: move `integration-release`, prune to the newest 10 `-int.` releases, skipping the tag found in `kahme247/ompweb` main's `runner/package.json` (`gh api repos/kahme247/ompweb/contents/runner/package.json`).
- [ ] Verify: `actionlint .github/workflows/omp-build.yml`; after Task 5, a dispatch on an already-released sha skips every build job.
- [ ] Commit `ci(omp): build, pack and publish omp builds to the fork from ompweb`.

### Task 4: `omp-auto.yml` and the composite actions

**Files:** create `.github/workflows/omp-auto.yml`, `.github/actions/omp-agent/action.yml`, `.github/actions/omp-round/action.yml` (from integration-ci).

- [ ] Copy; `on:` keeps only `workflow_dispatch` for now (the `schedule` block comes back in Task 8).
- [ ] Second checkout `path: ompweb`, `sparse-checkout: ci .github/actions`; every `ci/…` path becomes `ompweb/ci/…`; `uses: ./ompweb/.github/actions/omp-*`; `INTEGRATION_CONFIG_DIR: ${{ github.workspace }}/ompweb/ci/config`.
- [ ] Publishing jobs check out ompweb at the root (they run `ci/scripts/*` from it and `commit-fixups.sh` pushes ompweb `main` with `GITHUB_TOKEN`, `contents: write`).
- [ ] `build` → `uses: ./.github/workflows/omp-build.yml` with `sha`, `promote: true`, `secrets: { OMP_FORK_TOKEN: … }`; delete the `release` job and drop it from `escalate`'s `needs`; the "fork already has a release for this tag" check in `detect` is unchanged.
- [ ] Jobs that read secrets declare `environment: omp-integration` (spec Q5; remove the line if the answer is repository secrets).
- [ ] Verify: `actionlint`; `grep -rn 'integration-ci' .github ci` prints nothing except comments that name the old home on purpose.
- [ ] Commit `ci(omp): run the hourly omp round from ompweb`. Open PR A (Tasks 2–4).

### Task 5: cut-over round (operational, after PR A merges)

- [ ] Upload the Apple SDK package to the fork: `gh release download apple-sdk -R andrebrait/integration-ci -D /tmp/sdk && gh release create apple-sdk -R andrebrait/oh-my-pi --latest=false --title "Apple SDK mirror" --notes "SHA256-named Apple SDK packages for the bazel darwin toolchain" /tmp/sdk/*.pkg`.
- [ ] Ask the user to add `OMP_FORK_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (and the Environment, Q5). Confirm with `gh secret list -R kahme247/ompweb` (names only).
- [ ] `gh workflow disable omp-auto.yml -R andrebrait/integration-ci`.
- [ ] `gh workflow run omp-auto.yml -R kahme247/ompweb -f force=true`; watch to the end (cold cache ≈ 2 h). Expected: a promoted fork release `v<tag>-int.<sha7>` with the D4 assets, whose `## Carried patches` lists #19075 and neither #18646 nor #18668.
- [ ] If it fails, the escalation issue names the stage; fix in `ci/` by PR, re-dispatch.

### Task 6: runner against the integration build; (pre)releases build omp

**Files:** modify `runner/package.json`, `runner/bun.lock`; delete `runner/patches/`; create `runner/scripts/use-omp-build.ts`; modify `.github/workflows/prerelease.yml`, `.github/workflows/publish.yml`; doc comment in `runner/scripts/build-binary.ts` and `docs/specs/2026-11-12-omp-runner-design.md` (pin paragraph).

- [ ] `use-omp-build.ts <fork-tag>`: fetch `omp-packages.json` from the release, set `overrides["<name>"] = https://github.com/andrebrait/oh-my-pi/releases/download/<tag>/<tgz>` for every entry (removing stale `@oh-my-pi/*` overrides), remove `patchedDependencies`, write `package.json`, run `bun install` in `runner/`. Small assert self-check: every `@oh-my-pi/*` in `dependencies` has an override.
- [ ] Run it with Task 5's tag; delete `runner/patches/`; `bunx tsc -p runner`, `bun test` in `runner/`, `bun runner/scripts/build-binary.ts linux-x64` and `release/ompweb-omp-linux-x64 --smoke-test` pass.
- [ ] `prerelease.yml`/`publish.yml`: job `omp` (`uses: ./.github/workflows/omp-build.yml`, `ref: integration-release`, `secrets: { OMP_FORK_TOKEN }`); the existing job gets `needs: omp`, keeps its `if:`, and before `build-release-binaries.sh` runs `npx bun runner/scripts/use-omp-build.ts "${{ needs.omp.outputs.tag }}" && (cd runner && npx bun x tsc -p .)`. The pre-release notes and the draft release notes get one line `omp: andrebrait/oh-my-pi@<tag>`. `prerelease.yml`'s `workflow_dispatch` stays main-only.
- [ ] Verify: Verify PR and `omp-runner.yml` green on the PR (frozen lockfile against the pin); after merge, the pre-release run skips every bazel job and its `ompweb-linux-x64` archive's `ompweb-omp --version` prints the base semver. Dispatch integration-ci `ompweb.yml` on the merged sha (`integration build-sha` with the ompweb config) and confirm it builds.
- [ ] Commit `feat(runner): compile ompweb-omp against the omp integration build`. Open PR B.

### Task 7: the omp row follows ompweb

**Files:** modify `lib/omp/updates.ts` (delete or reduce), `lib/self-update.ts`, `app/api/omp-update/route.ts`, `lib/hosts/update-types.ts`, `lib/hosts/updates.ts`, `lib/hosts/daemon.ts`, `components/HostUpdates.tsx`, the Settings omp update card and its i18n keys (en, ja, zh-CN, zh-TW); tests `lib/hosts/updates.test.mjs`, `lib/hosts/host-updates-route.test.mjs`, `lib/self-update.test.mjs`, `components/SettingsConfig.updates.test.mjs`; `CHANGELOG.md`.

- [ ] Before editing, `xd://lsp` references for `checkOmpUpdate`, `runOmpUpdate`, `HostUpdateTarget`, `OmpUpdateStatus`, and the `omp` `Kind`; every caller is in the list above or added to it.
- [ ] Implement spec D9. `HostUpdateInfo.omp` is `{ currentVersion: string | null }`; the daemon's `startHostUpdate` rejects `omp` with `invalid_target`; the UI shows the version and "Updated with ompweb".
- [ ] Tests: the omp target is rejected; the host update info has no omp `canUpdate`; the Settings card renders without an update button. Delete tests of removed behaviour.
- [ ] Verify: `npm run typecheck`, `npm run lint`, `bun test --parallel lib/hosts lib/self-update.test.mjs components/SettingsConfig.updates.test.mjs`.
- [ ] CHANGELOG: "omp updates with ompweb: the omp row no longer runs `omp update`."
- [ ] Commit `feat(hosts): omp updates with ompweb`. Open PR C.

### Task 8: schedule and ai-dev (after PRs B and C merge)

- [ ] PR: add `schedule: - cron: "17 * * * *"` back to `omp-auto.yml`. After merge, wait for one scheduled run (it skips when the fork already has the tag's release).
- [ ] ai-dev: `git -C /root/git/ompweb worktree add /root/git/ompweb-worktrees/omp-ci upstream/main --detach`; replace the `~/.config/integration` symlink with a directory of per-file symlinks (spec D10); point `~/.local/bin/integration` per Q8.
- [ ] `cd /root/git/oh-my-pi && git fetch origin && git branch -f integration origin/integration-release && integration build && integration deploy`; `readlink /opt/omp-patched/current` names the release sha and `/opt/omp-patched/current/omp --version` runs.

### Task 9: delete integration-ci's omp process (after one green scheduled round and one green pre-release)

- [ ] In `/root/git/integration-ci` on a branch: delete the files in spec D10, add the "superseded" line to `docs/specs/2026-11-11-omp-auto-integration-design.md`, trim the README's oh-my-pi section; `bash integration.test.sh` (if the script stays there, Q8) passes. PR to `andrebrait/integration-ci`.
- [ ] After merge: `gh release delete oh-my-pi -R andrebrait/integration-ci --cleanup-tag --yes` and the same for `apple-sdk`.
- [ ] Verify: `gh workflow list -R andrebrait/integration-ci` lists no omp workflow; `integration build` for graphify/superpowers/ompweb still finds its config.

## Rollback

Spec D11. Until Task 9: `gh workflow enable omp-auto.yml -R andrebrait/integration-ci` and `gh workflow disable omp-auto.yml -R kahme247/ompweb`; `git revert` PR B's merge to return the runner to the npm pin and patch.
