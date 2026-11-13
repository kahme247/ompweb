# ompweb ships the omp integration build — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the omp round runs in `andrebrait/oh-my-pi` from its default branch `fork-ci` (RPC dropped; also triggered by carried-PR changes; escalating on the fork; fork binaries versioned `<upstream>-int.<stamp>.g<sha7>` and updating from fork releases; each promoted release carrying an npm package zip). ompweb's `runner/` compiles against that zip, every ompweb (pre)release re-pins to the newest `integration-release` build, and the omp row follows ompweb. integration-ci keeps only the script and its other builds.

**Spec:** `docs/specs/2026-11-12-omp-build-in-ompweb-design.md` (F1–F9, W1–W3, cleanup). Read it first. No open questions.

**State (2026-11-13):** I1, I2 and K1–K5 are done, and K7's schedule is back; the first promoted release is `v18.20.0-int.202611130808.gfd57e86`. W1–W3 landed in ompweb PR #473 (one PR instead of PRs B and C), pinned to that release. Open: K6's rewiring, K7's first scheduled run, W2's first pre-release after the merge, and I3.

**Owners and places:**
- **integration-ci** — `andrebrait/integration-ci` (a local checkout), CI reads its `main`; the script's only home. Tasks I1, I2, I3.
- **fork-ci** — orphan branch `fork-ci` of `andrebrait/oh-my-pi`, in a worktree of the local oh-my-pi checkout. Sources: integration-ci at `5db42d1`. Tasks K1–K7.
- **ompweb** — `kahme247/ompweb`, PR #473 (`feat/omp-runner`). Tasks W1–W3.

Order: I1 → K1–K4 → K5 → K6 → W1+W2+I2 (PR B) → W3 (PR C) → K7 → I3.

## Global Constraints

- The fork's `main` is never committed to; `fork-ci` holds only CI files. Every fork-code checkout names its `ref` and sets `persist-credentials: false`.
- `permissions: {}` at workflow level; per-job grants per spec F3. `GITHUB_TOKEN` first; `OMP_FORK_TOKEN` only as the retry on a `workflows`-permission refusal. Secrets only through `environment: omp-round`.
- Jobs that run fork code or an agent hold no write token; publishing jobs run no fork code. No `fork-ci` workflow has `push`, `pull_request` or `pull_request_target` triggers.
- The F9 build-step snippet and release tag line are used verbatim; the natives `jq` line is the same line on `packages/natives/package.json`, in `natives`, `binaries` and `pack` alike.
- ompweb gets no secrets, environments or new triggers.
- Keep pinned action SHAs and comment style. Commit titles: integration-ci `integration: …`/`ompweb: …`; fork-ci `ci: …`; ompweb `feat(runner): …`, `ci(release): …`, `feat(hosts): …`.

## Review Focus

1. Upstream's workflows never see the round's secrets and are disabled within an hour of appearing. (K1, K2)
2. A finished round does not retrigger; a carried-branch push triggers the next; a failed round with an open issue for the same inputs is not retried hourly. (I1, K2)
3. Every binary, the addon stamp, the leaf packages and the tag carry the same `<upstream>-int.<stamp>.g<sha7>`; old-format tags are gone before the first stamped release. (K3, K5)
4. The runner's lockfile pins every `@oh-my-pi/*` package and all six leaves to `file:./vendor/…` with sha512; no npm leaf sneaks in. (W1)
5. An ompweb (pre)release ships the build `integration-release` names, with no secret, and fails if it cannot. (W2)

---

### Task I1 (integration-ci): `heads` and `CI_CONFIG_REF` (spec F5, F8)

**Files:** `integration`, `integration.test.sh`.

- [x] `integration heads`: one `<pr>\t<branch>\t<sha>` per `pr_rows base` row, sha from `gh api repos/<fork slug>/branches/<branch> --jq .commit.sha`, sorted by PR; documented in the header.
- [x] `ci_build`: fetch and diff against `${CI_CONFIG_REF:-origin/main}` (split into remote and branch) instead of the hard-coded `origin main`; the error names the ref.
- [x] Tests (gh stubbed): `heads` honours `SKIP_PRS` and `EXTRA_PRS`; `CI_CONFIG_REF` passes against that ref, fails against a stale one.
- [x] Verify `bash integration.test.sh`. Commit `integration: list carried PR heads; compare the config against CI_CONFIG_REF`; push `main`.

### Task K1 (fork-ci): branch content (spec F1, F2, F4)

**Files:** copy from integration-ci `.github/workflows/{omp-auto,omp,publish}.yml`, `.github/actions/{omp-agent,omp-round}/`, `config/root--git--oh-my-pi.sh`, `config/fixups/root--git--oh-my-pi/*.patch` (without `18668-*`), `prompts/omp-repair.md`, `scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh`; create `.github/workflows/fork-guard.yml`, `README.md`.

- [x] `git -C <oh-my-pi checkout> worktree add --orphan -b fork-ci <fork-ci worktree>`; copy keeping paths.
- [x] Config (F4): `EXTRA_PRS='7851=carry/pr-7851'`; `SKIP_PRS='18668'` with a one-line why; the ten `rpc-*` tests and the #18646 `TEST_CMD+=` line and comment removed; "and host RPC contracts" removed; `CI_REPO=andrebrait/oh-my-pi`, `CI_WORKFLOW=omp.yml`, `CI_CONFIG_REF=origin/fork-ci`. Make sure the update-source PR (`feat/configurable-update-source`) is carried: open upstream, or a fork-qualified `EXTRA_PRS` entry until it is.
- [x] `fork-guard.yml` (F2): `schedule` `0 5 * * *` + `workflow_dispatch`; `permissions: actions: write`; disables every active workflow whose `path` is not a file in this checkout.
- [x] `README.md`: what `fork-ci` is; never merge it; sync `main` only with `integration` or `gh repo sync andrebrait/oh-my-pi -b main`; PRs inside the fork need `--base main`.
- [x] `prompts/omp-repair.md` and script comments: integration-ci → the fork's `fork-ci`; script at `tools/integration`; fixups commit to `fork-ci`.
- [x] Verify: `source config/root--git--oh-my-pi.sh; grep -c 'rpc-' <<<"$TEST_CMD"` prints `0`; `bash -n scripts/*.sh`. Commit `ci: the omp integration round, moved from integration-ci`.

### Task K2 (fork-ci): workflows run from the fork (spec F1, F3, F5, F7)

**Files:** `.github/workflows/omp-auto.yml`, `.github/workflows/omp.yml`, `.github/actions/omp-round/action.yml`, `scripts/{push-rebased,publish-round,commit-fixups}.sh`.

- [x] `on:` `workflow_dispatch` only (K7 restores `schedule`). `env: FORK: ${{ github.repository }}`.
- [x] Checkouts: fork code with `ref: main` (or the job's tag/sha); `ref: fork-ci`, `path: ci`; `repository: andrebrait/integration-ci`, `ref: main`, `path: tools`, sparse `integration changelog-merge`. `ci/integration` → `tools/integration`.
- [x] Jobs that read secrets declare `environment: omp-round`.
- [x] Token retry: `push-rebased.sh`, `publish-round.sh`, the `integration-release` move and release creation use `GITHUB_TOKEN`; on output containing `workflows` permission refusal (`refusing to allow a GitHub App to create or update workflow`), retry once with `OMP_FORK_TOKEN` and log `token=pat`. `commit-fixups.sh`: refuse paths outside `config/fixups/root--git--oh-my-pi/`; push `HEAD:fork-ci` with `GITHUB_TOKEN`.
- [x] `detect`: the F2 disable step (`actions: write`); current inputs (`tools/integration heads`) vs released inputs (base tag and `Squashed from … (<sha>)` per squash on `integration-release`, mapped by the `PR #N` subject); equal → skip; open `omp-auto` issue with `inputs: <sha256>` → skip; `force`/`candidate` bypass. Output `inputs`. The "release for this tag exists" check goes.
- [x] `escalate`: `GH_TOKEN: ${{ github.token }}`, `permissions: { issues: write, actions: read }`, issues on `$GITHUB_REPOSITORY`; body adds `inputs: <sha256>`.
- [x] Verify `actionlint .github/workflows/*.yml`. Commit `ci: run the round from the fork with its own token`.

### Task K3 (fork-ci): versions and update source (spec F9)

**Files:** `.github/workflows/omp.yml`, `.github/workflows/omp-auto.yml`, `.github/workflows/publish.yml`.

- [x] `omp.yml` first job `version` (no fork code; `contents: read`; blobless clone at `inputs.sha`): the release-tag lines from F9 verbatim (`stamp=…`, `version="$(jq -r .version packages/utils/package.json)"`, `rel="v$version-int.$stamp.g${SHA:0:7}"`); outputs `stamp`, `version` (`${rel#v}`), `tag` (`$rel`); `workflow_call` outputs `version`, `tag`.
- [x] `binaries` "Build release binary": F9's snippet verbatim, plus the natives line (same `jq` on `packages/natives/package.json`).
- [x] `natives`: before `bazel-natives.ts`, the same stamp and natives `jq` line. `pack` (K4): utils and natives lines.
- [x] `smoke`: `bin/omp --version` (and `omp.exe`) == `omp/${{ needs.version.outputs.version }}`; linux-x64: `grep -c andrebrait/oh-my-pi bin/omp` > 0.
- [x] `omp-auto.yml` `release`: tag `${{ needs.build.outputs.tag }}`; fail unless it matches `^v[0-9]+\.[0-9]+\.[0-9]+-int\.[0-9]{12}\.g[0-9a-f]{7}$` and its base equals the round's tag without `v`; skip when a release whose tag ends `.g<sha7>` exists; `--latest`, never `--prerelease`/`--draft`. Prune only the new format.
- [x] `publish.yml` callers: same `version` job.
- [x] Verify `actionlint`; K5's round. Commit `ci: stamp fork versions and update fork binaries from fork releases`.

### Task K4 (fork-ci): npm package zip (spec F6)

**Files:** `.github/workflows/omp.yml`, `.github/workflows/omp-auto.yml`, `scripts/fake-npm/npm` (new, executable).

- [x] `scripts/fake-npm/npm`: a stub `npm` that, for `publish <tarball>`, copies the tarball into `$OMP_PACK_OUT` and exits 0; anything else exits 0 without network.
- [x] `omp.yml` job `pack` (needs `version`, `natives`; `contents: read`; fork code at `inputs.sha`): `./.github/actions/bun-install`; utils+natives version lines; `natives-*` artifacts into `packages/natives/native`; `PATH="$GITHUB_WORKSPACE/ci/scripts/fake-npm:$PATH" bun scripts/ci-release-publish.ts` (12 JS tarballs); `bun scripts/ci-release-publish.ts --native-leaf <tag>` for `linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64 win32-arm64`; `index.json`; zip `omp-packages-<version>.zip`; fail unless 18 tarballs; artifact `omp-packages`. `publish` needs `pack`.
- [x] `omp-auto.yml` `release`: upload the zip. Prune: skip the tag in `kahme247/ompweb` `main` `runner/omp-build.json` (`gh api repos/kahme247/ompweb/contents/runner/omp-build.json`; missing → nothing extra kept).
- [x] Verify `actionlint`. Commit `ci: attach the npm packages to each integration release`.

### Task K5 (fork, operational; user is fork admin): cut-over round

- [x] User: Environment `omp-round`, deployment branches `fork-ci` only, secrets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OMP_FORK_TOKEN` (fine-grained, this repository, Contents + Workflows write).
- [x] `git -C <fork-ci worktree> push origin fork-ci`; `gh api -X PATCH repos/andrebrait/oh-my-pi -f default_branch=fork-ci`.
- [x] `gh release download apple-sdk -R andrebrait/integration-ci -D /tmp/sdk && gh release create apple-sdk -R andrebrait/oh-my-pi --latest=false --title "Apple SDK mirror" --notes "SHA256-named Apple SDK packages for the bazel darwin toolchain" /tmp/sdk/*.pkg`.
- [x] `gh workflow run fork-guard.yml -R andrebrait/oh-my-pi`; `gh workflow list -R andrebrait/oh-my-pi` shows only `fork-ci`'s workflows active.
- [x] `gh workflow disable omp-auto.yml -R andrebrait/integration-ci`.
- [x] Delete old-format releases and tags: `gh release list -R andrebrait/oh-my-pi --limit 100 --json tagName --jq '.[].tagName' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-int\.[0-9a-f]{7}$' | xargs -r -n1 gh release delete -R andrebrait/oh-my-pi --cleanup-tag --yes`.
- [x] `gh workflow run omp-auto.yml -R andrebrait/oh-my-pi -f force=true`; watch (cold bazel cache, up to ~2 h). Expected: a Latest release `v<base>-int.<stamp>.g<sha7>` (stamp = the integration commit's committer minute, UTC) listing #19075 and the update-source PR, neither #18646 nor #18668; binaries print the tag without `v`; `omp-packages-<version>.zip` with 18 tarballs; no `OMP Nix` run on the tag. A failure opens an `omp-auto` issue on the fork; fix, re-dispatch.

### Task K6 (fork / build host): rewiring and bootstrap (spec F8, F9)

- [ ] Replace the `~/.config/integration` symlink with a directory: per-file symlinks into the integration-ci checkout's `config/` for everything but the omp config and fixups (keep `.retired-*`); `root--git--oh-my-pi.sh` and `fixups/root--git--oh-my-pi` → the `fork-ci` worktree's `config/…`.
- [x] In the oh-my-pi checkout: `git fetch origin && git branch -f integration origin/integration-release && integration build && integration deploy`.
- [ ] Verify: the deployed omp's `--version` prints the stamped version; `HOME=$(mktemp -d) <deployed omp> update --check` asks `api.github.com/repos/andrebrait/oh-my-pi` and reports up to date; `integration prs` still finds the graphify, superpowers and ompweb configs. Other machines on older fork binaries: install this release by hand once.

### Task W1 (ompweb): runner against the fork's packages (spec W1)

**Files:** `runner/package.json`, `runner/bun.lock`, `runner/omp-build.json` (new), `runner/.gitignore` (`vendor/`), `runner/scripts/use-omp-build.ts` (new); delete `runner/patches/`; `.github/workflows/verify-pr.yml`, `.github/workflows/omp-runner.yml`, `scripts/build-release-binaries.sh`; doc comment in `runner/scripts/build-binary.ts`; pin paragraph in `docs/specs/2026-11-12-omp-runner-design.md`.

- [x] `use-omp-build.ts [<tag>]`: no tag → read `omp-build.json`, download `https://github.com/<repo>/releases/download/<tag>/omp-packages-<version>.zip`, unzip into `runner/vendor/` (replacing it). With tag → same fetch for that tag, then rewrite `omp-build.json`, the three direct deps to `file:./vendor/<file>.tgz`, and `overrides` for all 12 `@oh-my-pi/*` packages and all 6 `@oh-my-pi/pi-natives-*` leaves from `index.json`; drop `patchedDependencies`; `bun install` in `runner/`. Fail when a `@oh-my-pi/*` dependency or leaf has no entry.
- [x] Run it with K5's tag; delete `runner/patches/`; `grep -c 'registry.npmjs.org.*@oh-my-pi' runner/bun.lock` prints `0`; `bun x tsc -p runner`, `bun test` in `runner/`, `bun runner/scripts/build-binary.ts linux-x64`, `runner/release/ompweb-omp-linux-x64 --version` (the tag without `v`) and `--smoke-test` pass; `~/.omp/natives/<stamped version>/` is the extracted dir.
- [x] Before every runner `bun install`: `npx bun runner/scripts/use-omp-build.ts` in `verify-pr.yml`, `omp-runner.yml` (both jobs) and `scripts/build-release-binaries.sh`.
- [x] Verify: Verify PR and `omp-runner.yml` green, including the cross-target `--os/--cpu` installs and builds (first test of fork leaves off linux-x64).
- [x] Commit `feat(runner): compile ompweb-omp against the fork's omp packages`.

### Task I2 (integration-ci): ompweb build fetches the runner's packages

**Files:** `.github/workflows/ompweb.yml`, `config/root--git--ompweb.sh`.

- [x] Before each `npx bun install --cwd runner …` in `ompweb.yml` and in `BUILD_CMD`: `{ [ ! -f runner/scripts/use-omp-build.ts ] || npx bun runner/scripts/use-omp-build.ts; }`.
- [x] Verify: `integration build-sha <W1 sha>` with the ompweb config builds. Commit `ompweb: fetch the runner's omp packages before installing`; push `main` together with PR B's merge.

### Task W2 (ompweb): (pre)releases re-pin to `integration-release` (spec W2)

**Files:** `.github/workflows/prerelease.yml`, `.github/workflows/publish.yml`.

- [x] Before `Build the release binaries` in both: resolve `sha` and `tag` (spec W2 step 1, `GH_TOKEN: ${{ github.token }}`); no match → fail with a clear message; `npx bun runner/scripts/use-omp-build.ts "$tag" && (cd runner && npx bun x tsc -p .)`; export `OMP_TAG`. `build-release-binaries.sh`'s own fetch then finds the re-pinned `omp-build.json`.
- [x] Notes: prerelease `--notes` and the draft release notes gain `omp: andrebrait/oh-my-pi $OMP_TAG`.
- [ ] Verify `actionlint`; after merge, the next pre-release names the current `integration-release` tag and its `ompweb-omp --version` prints it without `v`.
- [x] Commit `ci(release): ship the newest omp integration build with every release`. (Landed in PR #473 instead of a separate PR B.)

### Task W3 (ompweb): the omp row follows ompweb (spec W3)

**Files:** `lib/omp/updates.ts`, `lib/self-update.ts`, `app/api/omp-update/route.ts`, `lib/hosts/update-types.ts`, `lib/hosts/updates.ts`, `lib/hosts/daemon.ts`, `components/HostUpdates.tsx`, the Settings omp update card and its i18n keys (en, ja, zh-CN, zh-TW); tests `lib/hosts/updates.test.mjs`, `lib/hosts/host-updates-route.test.mjs`, `lib/self-update.test.mjs`, `components/SettingsConfig.updates.test.mjs`, `lib/hosts/cluster.test.mjs`; `CHANGELOG.md`.

- [x] `xd://lsp` references for `checkOmpUpdate`, `runOmpUpdate`, `HostUpdateTarget`, `OmpUpdateStatus` and the `omp` `Kind`; add missing callers.
- [x] Implement spec W3. Tests: `omp` target rejected; no omp `canUpdate`; Settings card without an update button; `18.20.0-int.202611130355.gd2c2eff` shown and accepted by `HOST_VERSION_PATTERN` and `ompSharesCredentials`. Delete tests of removed behaviour.
- [x] Verify: `npm run typecheck`, `npm run lint`, `bun test --parallel lib/hosts lib/self-update.test.mjs components/SettingsConfig.updates.test.mjs`.
- [x] CHANGELOG: "omp updates with ompweb: the omp row no longer runs `omp update`." Commit `feat(hosts): omp updates with ompweb`. (Landed in PR #473 instead of a separate PR C.)

### Task K7 (fork-ci): hourly schedule

- [x] Restore `schedule: - cron: "17 * * * *"` in `omp-auto.yml`. Commit `ci: run the round hourly`; push.
- [ ] Next scheduled run: `detect` skips (inputs unchanged since K5).

### Task I3 (integration-ci): cleanup (after one green scheduled fork round and one green ompweb pre-release)

- [ ] Delete the files listed in the spec's cleanup section; superseded line in `docs/specs/2026-11-11-omp-auto-integration-design.md`; trim README's oh-my-pi section; `bash integration.test.sh` passes. Commit `omp: the round moved to the fork's fork-ci branch`; push `main`.
- [ ] `gh release delete oh-my-pi -R andrebrait/integration-ci --cleanup-tag --yes`; same for `apple-sdk`; `gh secret delete` `OMP_FORK_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` if `grep -rn 'secrets\.' .github` no longer names them.
- [ ] Verify: `integration build` for graphify, superpowers and ompweb still finds its config.

## Rollback

Before I3: `gh api -X PATCH repos/andrebrait/oh-my-pi -f default_branch=main`, `gh workflow enable omp-auto.yml -R andrebrait/integration-ci`, restore the `~/.config/integration` symlink, copy new `fork-ci` fixups back to integration-ci. Revert PR B (with I2) and PR C independently.
