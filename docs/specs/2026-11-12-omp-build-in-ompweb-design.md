# ompweb ships the omp integration build — design

Date: 2026-11-12, revised 2026-11-13 (round hosted in the fork). Branch: `ci/omp-build` (on `feat/omp-runner`, PR #460).
Supersedes: `andrebrait/integration-ci` `docs/specs/2026-11-11-omp-auto-integration-design.md` (the round moves to the fork) and its §3 (omp-web's **Custom** omp update source, never built). §3b (ompweb pre-release channel) and §3c (GitHub token) are unaffected.
Depends on: #460 (`runner/`, `ompweb-omp`) and can1357/oh-my-pi#19075 (`runSessionHost`), carried in the integration build.

## Why

ompweb ships its own omp build (`ompweb-omp`, `runner/`), compiled today against npm `@oh-my-pi/pi-coding-agent@18.19.0` plus a Bun patch (`runner/patches/`) that back-ports `runSessionHost`. The omp the user runs (`/opt/omp-patched`) comes from integration-ci's hourly integration of upstream releases plus the user's carried PRs, released on `andrebrait/oh-my-pi`. This design moves that round into the fork itself and makes `ompweb-omp` use its builds.

## Three places

| Where | Owns after cut-over | Secrets |
|---|---|---|
| `andrebrait/oh-my-pi` (the fork) | the omp round: workflows, config, fixups, repair prompt, helper scripts on branch `fork-ci`; releases `<tag>-int.<sha7>` with npm tarballs; `integration-release`; `apple-sdk` mirror; escalation issues | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OMP_FORK_TOKEN` only for the workflow-file ref updates in F3; in Environment `omp-round`. Everything else uses the workflow's own `GITHUB_TOKEN` |
| `kahme247/ompweb` | consumes one public fork release: `runner/` pinned to its tarballs; (pre)releases re-pin to the newest `integration-release` build; the omp row follows ompweb | none |
| `andrebrait/integration-ci` | the `integration` script (single copy), graphify/superpowers/ompweb builds, unchanged; its omp workflows, scripts, config, fixups and releases are deleted after cut-over | its omp secrets can be removed |

## Fork

### F1. `fork-ci`: an orphan default branch

The fork's `main` stays a clean fast-forward mirror of upstream `main` (`integration`'s `sync_fork_base`). Scheduled and dispatched workflows run only from the **default branch**, so the round lives on an orphan branch `fork-ci`, made the fork's default branch. Its tree mirrors integration-ci's omp layout, so workflow paths barely change:

```
.github/workflows/omp-auto.yml     # from integration-ci, adapted (F4–F7)
.github/workflows/omp.yml          # from integration-ci, + pack (F6)
.github/workflows/publish.yml      # from integration-ci, unchanged (rolling `oh-my-pi` release for manual `integration build`)
.github/workflows/fork-guard.yml   # F2
.github/actions/omp-agent/, omp-round/
config/root--git--oh-my-pi.sh
config/fixups/root--git--oh-my-pi/*.patch
prompts/omp-repair.md
scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh
README.md                          # what this branch is; never merged anywhere
```

In every job the fork's code is checked out at the workspace root with an explicit `ref` (`main`, a tag or a sha — never the default, which is now `fork-ci`), `fork-ci` at `ci/` (as integration-ci was), and the `integration` script from `andrebrait/integration-ci` `main` at `tools/` (public, read-only; the round reads it fresh as it does today). `ci/integration` becomes `tools/integration`; `INTEGRATION_CONFIG_DIR=$GITHUB_WORKSPACE/ci/config` as today. One copy of the script, no sync.

What the default-branch switch changes:

- **Upstream's workflows in the fork.** Actions is enabled in the fork today and upstream's workflows run there: `CI` and `Warm bun store cache` on pushes to `main` (every mirror sync), `OMP Nix` on its schedule (which needs the default branch, so it stops) and on every `v*` tag (each `-int.` release tag starts a Nix build today), plus `os-session-tests`, `windows-rename-probe`, `Windows EPIPE regression`, `Copilot`. Workflow enablement is per workflow file path across all branches, so F2 disables every workflow whose path is not on `fork-ci` (Q2).
- **`gh pr create`.** Local `/root/git/oh-my-pi` has `gh repo set-default can1357/oh-my-pi`, so PRs keep targeting upstream `main`. A PR opened inside the fork (web UI or `-R andrebrait/oh-my-pi`) now defaults to base `fork-ci`; pass `--base main`. `sync_fork_base` already names `--base` explicitly.
- **"Sync fork" / `gh repo sync`** act on the default branch unless told otherwise: they would try to merge upstream `main` into `fork-ci`. Use `integration` (its `git push` fast-forward) or `gh repo sync andrebrait/oh-my-pi -b main`. README on `fork-ci` says so.
- Clones of the fork check out `fork-ci`; `origin/HEAD` moves. `BASE=upstream/main`, `pr_rows` and every script ref are explicit, so the script is unaffected.
- Public repository: scheduled workflows are disabled after 60 days without repository activity; the hourly round's pushes and releases are activity, but a long quiet period (no upstream release, no PR change, so no round) can reach it. `fork-guard.yml` (F2) runs daily and is itself activity only if it changes something; Q4.

### F2. `fork-guard.yml`

`schedule` daily and `workflow_dispatch`; `permissions: actions: write`; runs no fork code. Lists `gh api repos/$GITHUB_REPOSITORY/actions/workflows` and disables each `active` workflow whose `path` is not a file on `fork-ci` (`gh workflow disable <id>`). `omp-auto.yml`'s `detect` runs the same step first, so a workflow added by a mirror sync is disabled within the hour; it can still run on the push that introduced it, but without the round's secrets (F3).

### F3. Secrets, tokens, trust

Secrets live in an Environment `omp-round` whose deployment-branch policy is `fork-ci` only; every job that reads one declares `environment: omp-round`. Upstream's workflows (on `main`, tags, PR branches) can never read them, even if a new upstream workflow runs before F2 disables it. The user is the fork's admin.

Default: the workflow's own `GITHUB_TOKEN` with per-job `contents: write` / `issues: write` / `actions: write`. The round now writes only to its own repository, so the cross-repository PAT is no longer needed for issues, releases, assets or `fork-ci` commits.

| Write | Token |
|---|---|
| escalation issues | `GITHUB_TOKEN`, `issues: write` |
| fixup commits to `fork-ci` | `GITHUB_TOKEN`, `contents: write` |
| `gh workflow disable` (F2) | `GITHUB_TOKEN`, `actions: write` |
| release creation, asset uploads, prune, rolling `oh-my-pi` release (`publish.yml`) | `GITHUB_TOKEN`, `contents: write` |
| PR branch pushes (`rebase`, `rebase-repair-push`, `build-repair-push`), `integration-candidate`, `integration-release` | `GITHUB_TOKEN`, `contents: write`, **except** the case below |

Still needs a PAT (`OMP_FORK_TOKEN`, fine-grained, this repository, Contents + Workflows write): any ref update whose old→new diff changes a file under `.github/workflows/`. `GITHUB_TOKEN` can never hold the `workflows` permission, and GitHub refuses such pushes from it. That happens whenever a round moves to a new upstream tag that changed upstream's workflows: rebasing a PR branch onto it, and moving `integration-candidate` and `integration-release` across it. Release creation that makes a new tag on such a commit may hit the same check [INFERENCE; not verified]. `scripts/push-rebased.sh`, `publish-round.sh` and the `integration-release` move therefore push with `GITHUB_TOKEN` and retry once with `OMP_FORK_TOKEN` only when the push is refused for the `workflows` permission; plan Task 1 verifies each case and drops the fallback where it never fires.

`GITHUB_TOKEN` pushes start no workflows. `OMP_FORK_TOKEN` pushes start push-triggered ones; F2 keeps upstream's disabled, and `fork-ci`'s workflows have no `push` trigger.

Job split unchanged: jobs that run fork code or an agent hold no push credential and hand refs and patches to publishing jobs that run no fork code. No `fork-ci` workflow has a `pull_request` or `pull_request_target` trigger. `commit-fixups.sh` refuses a patch that touches any path outside `config/fixups/root--git--oh-my-pi/` and pushes `HEAD:fork-ci`. The agent binary stays upstream's digest-checked release `omp-linux-x64`.

### F4. RPC drops (`config/root--git--oh-my-pi.sh`)

| Item | Change |
|---|---|
| `EXTRA_PRS` | `'7851=carry/pr-7851'` (drops `18646=carry/pr-18646`, pasquale95's RPC form dialog); comment loses the 18646 line |
| `SKIP_PRS` (new line) | `'18668'` — the user's own "correlate RPC input with client message IDs", RPC-only (decided); `runner/src/correlation.ts` rebuilds the contract from public API |
| `TEST_CMD` (line 23 list) | remove `rpc-queued-message`, `rpc-cancel-subagent`, `rpc-steer-subagent` |
| `TEST_CMD` (line 25 list) | remove `rpc-native-input`, `rpc-input-frame`, `rpc-prompt-result`, `rpc-skill-command`, `rpc-compatible-primitives`, `rpc-extension-ui`; the comment above loses "and host RPC contracts" |
| `TEST_CMD` (lines 59–60) | delete "Carried PR #18646 (RPC form dialog) contract tests" and its separate `bun test …rpc-extension-ui.test.ts packages/tui/test/html-form.test.ts` process |
| fixups | `18668-prompt-claim-optional.patch`, `18668-resolve.patch`, `18668-skill-command-client-message-id.patch` are not copied to `fork-ci` |
| `CI_REPO`/`CI_WORKFLOW` | `andrebrait/oh-my-pi` / `omp.yml` (F8) |
| `STACKED_PRS` | unchanged |

All `rpc-*` paths are `packages/coding-agent/test/rpc-*.test.ts`; 10 occurrences (`rpc-extension-ui` twice). RPC work merged upstream (#18929, #18930, earlier `feat(rpc)` PRs) is in the base release. Mixed PRs stay (decided): #14148, #14458 (stacked on #14148), #14608. Resolution patches written with #18668/#18646 present may stop applying; the first round's `integrate-repair` or a local `integration rebuild` refreshes them.

### F5. The round also runs when a carried PR changes

`detect` starts a round when the round's **inputs** differ from those of the last promoted release (decided). Inputs: the upstream tag (latest release, or input `tag`) plus each carried PR's fork branch and head sha — the set `integration` builds (the user's open PRs on `can1357/oh-my-pi`, open `EXTRA_PRS`, minus `SKIP_PRS`).

- Current inputs: new `integration heads` subcommand (integration-ci script; gh only, no fork code): `<pr>\t<branch>\t<sha>` per carried PR.
- Released inputs: each squash on `integration-release` records `Squashed from <ref> (<sha>)`; `detect` reads them and the base tag through `gh api repos/$GITHUB_REPOSITORY/commits?sha=integration-release`.
- A round starts on a new tag, a PR opened/closed/merged, or a carried branch pushed. Branches the round rebases are pushed before `integrate` and their squash records the pushed sha, so a finished round does not retrigger.
- A failed round is not retried hourly for unchanged inputs: `detect` skips while an open `omp-auto` issue names the same `inputs: <sha256>`. `force` overrides both checks. One round at a time, as today.
- Several `-int.` releases per upstream tag are now normal.

### F6. Releases carry npm tarballs

`omp.yml` gets a job `pack` (needs `natives` and `version`; fork code; `contents: read`; no secrets): `bun install --frozen-lockfile`, natives into `packages/natives/native`, F9's version rewrite of `packages/utils/package.json`, every public workspace package packed as upstream would publish it (`scripts/ci-release-publish.ts`'s manifest rewrite and `bun pm pack`, not published), plus one `@oh-my-pi/pi-natives-<os>-<arch>` leaf (`packages/natives/scripts/gen-npm-packages.ts`) for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`. Only `pi-utils` carries the fork version (F9); every other package keeps the base release's, and the runner's overrides map by name, so the mismatch does not matter. `ompweb-omp --version` therefore prints the fork version, the same string as the release tag without `v`. Artifact `omp-packages`: the `.tgz` files and `omp-packages.json` (`{ "<npm name>": "<file>.tgz" }`).

`omp-auto.yml` `release` (no fork code) attaches each `.tgz` and `omp-packages.json` beside the binaries and `SHA256SUMS.txt`; notes unchanged. Pruning keeps the newest 10 `-int.` releases plus the one ompweb `main` pins (read from `kahme247/ompweb` `runner/package.json`, public). Releases before F6 have no tarballs.

### F7. Escalation and Apple SDK in the fork

- `escalate` uses the workflow's `GITHUB_TOKEN` with `permissions: issues: write` on the fork itself (no PAT), label `omp-auto`; body adds `inputs: <sha256>`. Issues are enabled on the fork (done by the user). Issue text is public.
- The Apple SDK step already reads `https://github.com/$GITHUB_REPOSITORY/releases/download/apple-sdk/<sha256>.pkg`; the release `apple-sdk` is created on the fork (`--latest=false`) with `d55351824fd17742fd6e1e7a252fa1028698f32147ee48be9a6b75442bf30575.pkg` (70,553,676 bytes) from integration-ci's release. No workflow change.
- `-int.` releases stay "latest" on the fork; `apple-sdk` and the rolling `oh-my-pi` release are `--latest=false`.

### F8. Local `integration` and `/opt/omp-patched`

The script stays only in integration-ci. Changes there (also used by the round through `tools/`):

- `heads` subcommand (F5).
- `CI_CONFIG_REF` (default `origin/main`): the ref `ci_build` fetches and diffs the config file and `.github` against before dispatching (today hard-coded `origin main`). The omp config sets `CI_CONFIG_REF=origin/fork-ci`.
- Tests in `integration.test.sh` for both.

Host wiring (ai-dev): worktree `/root/git/oh-my-pi-fork-ci` of branch `fork-ci` (remote `origin` = the fork). `~/.config/integration` stops being a symlink to `integration-ci/config` and becomes a directory: per-file symlinks into `integration-ci/config` for graphify, superpowers, ompweb, the pin scripts and `fixups/root--git--ompweb`; `root--git--oh-my-pi.sh` and `fixups/root--git--oh-my-pi` link into the `fork-ci` worktree. `ci_build` resolves the config's repository from the symlink target (it already uses `readlink -f`), so it diffs the fork-ci worktree against `origin/fork-ci`.

`integration build` for oh-my-pi dispatches `omp.yml` on `andrebrait/oh-my-pi`; its reuse lookup reads `project: oh-my-pi` from `fork-ci`'s `omp.yml` and finds zips in the fork's rolling `oh-my-pi` release (`publish.yml`, unchanged). `DEPLOY_CMD` is unchanged. Deploying an auto round: `git -C /root/git/oh-my-pi fetch origin && git -C /root/git/oh-my-pi branch -f integration origin/integration-release && integration build && integration deploy`. The first such deploy after F9 is the bootstrap install of a fork-updating binary on ai-dev.

### F9. Fork versions, tags and `omp update`

Fork binaries update from fork releases. This needs the user's upstream-able PR `feat/configurable-update-source` (pushed to `andrebrait/oh-my-pi` at `4a7bb87e`; carried like the user's other PRs once it is open upstream): with `PI_UPDATE_REPO=<owner>/<repo>`, a compiled omp's startup check, `omp update`, the binary takeover and `update.auto` read `https://api.github.com/repos/<repo>/releases/latest` (an exact version: `releases/tags/v<version>`) instead of `build.stencil.so`, and verify each download against the asset's GitHub `digest` (sha256). `packages/coding-agent/scripts/compile-binary.ts` bakes it in through `define` only when the build environment sets it.

Release contract the fork's workflows meet:

1. Binaries are compiled with `PI_UPDATE_REPO=andrebrait/oh-my-pi` in the environment of `bun run ci:release:build-binaries`.
2. Version `<upstream version>-int.<YYYYMMDDHHMM>.<sha7>`, e.g. `18.20.0-int.202611130355.d2c2eff`, written into `packages/utils/package.json` (the only source of `VERSION`; natives check their own package version and are unaffected). The numeric stamp makes same-base builds sort (checked with omp's `compareVersions` and `Bun.semver.order` by the PR's author).
3. **Stamp** = the integration commit's committer time in UTC, `TZ=UTC git show -s --format=%cd --date=format-local:%Y%m%d%H%M "$SHA"` (decided). It is computed once, in a first job `version` of `omp.yml` (no fork code; blobless clone of the sha), and passed as a job output to every matrix job (`binaries`, `pack`, `smoke`) and, as a `workflow_call` output, to `omp-auto.yml` `release`. No job uses its own clock, so six matrix jobs and the tag cannot straddle a minute. Every round makes a new integration commit, so stamps grow round by round.
4. **Tag** = `v` + exactly what `omp --version` reports (`omp/<version>`); upstream's post-install check requires equality or restores the old binary. `release` builds the tag from the `version` output only and checks `<upstream version>` equals the round's upstream tag without `v`.
5. **Assets** keep upstream's names: `omp-linux-x64`, `omp-linux-arm64`, `omp-darwin-x64`, `omp-darwin-arm64`, `omp-windows-x64.exe`, `omp-windows-arm64.exe`. GitHub's per-asset digest is what omp verifies; `SHA256SUMS.txt` stays for humans and ompweb. No musl assets: musl hosts get a clear error.
6. **Latest.** Every promoted `-int.` release is a full release (never prerelease or draft) created with `--latest`; `releases/latest` ignores prereleases and drafts. `apple-sdk` and the rolling `oh-my-pi` release are `--latest=false`.

Build step (each `binaries` matrix job):

```yaml
         - name: Build release binary
           shell: bash
           env:
              RELEASE_TARGETS: ${{ matrix.target }}
              PI_UPDATE_REPO: ${{ github.repository }}
              VERSION: ${{ needs.version.outputs.version }}
           run: |
              set -euo pipefail
              jq --arg v "$VERSION" '.version = $v' packages/utils/package.json > "$RUNNER_TEMP/utils.json"
              mv "$RUNNER_TEMP/utils.json" packages/utils/package.json
              bun run ci:release:build-binaries
```

`version` job: `base=$(jq -r .version packages/utils/package.json)`, `stamp=$(TZ=UTC git show -s --format=%cd --date=format-local:%Y%m%d%H%M "$SHA")`, output `version=$base-int.$stamp.${SHA:0:7}`.

- **Idempotence.** A build of an sha that already has an `-int.` release (tag ending `.<sha7>`) is not released again. A re-dispatch of the same sha computes the same stamp anyway (committer time), so tag and binaries would agree.
- **Smoke.** The `smoke` job asserts `bin/omp --version` equals `omp/<version>`, and the linux-x64 binary contains the string `andrebrait/oh-my-pi` (fails the build if the update-source PR dropped out of the integration).
- **Rolling `oh-my-pi` release** (`publish.yml`, manual `integration build`): the same `version` job and define.
- **Old-format tags.** `v<base>-int.<sha7>` tags (`v18.19.0-int.77d6529`, `v18.20.0-int.d2c2eff`, …) sort **above** new ones of the same base when the sha has a letter (alphanumeric identifiers outrank numeric ones), so a fork binary at `18.20.0-int.<stamp>.<sha7>` would be offered the old build. The cut-over deletes every old-format `-int.` release and its tag on the fork (`gh release delete <tag> --cleanup-tag --yes`); `release` refuses to create a tag that does not match `^v[0-9]+\.[0-9]+\.[0-9]+-int\.[0-9]{12}\.[0-9a-f]{7}$`, and prune only considers that format, so the old format is never reused. Old binaries are unaffected (they report the plain base version and ask Stencil).
- **Bootstrap.** Existing fork binaries (`v18.20.0-int.d2c2eff` and older) report the plain base version and still update from Stencil, so `omp update` or `update.auto` moves them to upstream's binary on upstream's next release and drops the carried patches. The first stamped build is installed by hand; on ai-dev the `/opt/omp-patched` deploy (F8) does that. After that, updates come from fork releases.
- **What still goes upstream.** npm/bun installs (startup check and `omp update` ask npm), Homebrew `can1357/tap/omp`, mise `github:can1357/oh-my-pi`. Unauthenticated GitHub API calls are limited to 60 per hour per IP.

ompweb: fork versions now have the form `X.Y.Z-int.<YYYYMMDDHHMM>.<sha7>`. `HOST_VERSION_PATTERN` (`lib/hosts/update-worker.ts`) already accepts it (prerelease identifiers joined by `.`, leading zeros allowed), and `lib/version-compare.ts` `parseVersion` accepts any `-…` suffix. No ompweb validator of the old `X.Y.Z-int.<sha7>` form exists (the Custom source that would have had one was never built). W3 adds tests that the omp row and `ompSharesCredentials` accept the new form. `ompweb-omp`'s own build (`runner/scripts/build-binary.ts`) does not set `PI_UPDATE_REPO`; W3 removes ompweb's path to `omp update`.

## ompweb

### W1. `runner/` against a fork release

- `runner/package.json` keeps its dependency names and adds `overrides` mapping every `@oh-my-pi/*` package — transitive ones and the five leaves — to `https://github.com/andrebrait/oh-my-pi/releases/download/<tag>/<file>.tgz` of one fork release: **the committed pin**, recorded with integrity in `runner/bun.lock`. `patchedDependencies` and `runner/patches/` are deleted.
- `runner/scripts/use-omp-build.ts <tag>` reads the release's `omp-packages.json`, rewrites the overrides and runs `bun install`. Pin bumps are manual ompweb PRs with it (decided).
- `runner/scripts/build-binary.ts` is unchanged; `bun install --os='*' --cpu='*'` still installs every leaf.
- `verify-pr.yml`, `omp-runner.yml` and integration-ci's `ompweb.yml` install the committed pin with `--frozen-lockfile`; public downloads only.
- Spike first: Bun must honour `overrides` with tarball URLs for transitive dependencies. Fallback: `use-omp-build.ts` writes every `@oh-my-pi/*` package as a direct URL dependency.

### W2. Every (pre)release uses the newest `integration-release` build

`prerelease.yml` and `publish.yml`, before `sh scripts/build-release-binaries.sh`:

1. `sha=$(gh api repos/andrebrait/oh-my-pi/commits/integration-release --jq .sha)`; `tag` = the fork release whose tag matches `^v[0-9]+\.[0-9]+\.[0-9]+-int\.[0-9]{12}\.${sha:0:7}$` (F9; exactly one per sha). `GITHUB_TOKEN` reads public repositories; no secret.
2. `npx bun runner/scripts/use-omp-build.ts "$tag"`, then `(cd runner && npx bun x tsc -p .)`.
3. Notes gain `omp: andrebrait/oh-my-pi <tag>`.

`integration-release` moves only after its release exists. If the build lacks tarballs or the runner no longer type-checks against it, the (pre)release fails (Q1). Added time: about 1 minute. ompweb gains no secrets, environments or triggers.

### W3. The omp row follows ompweb

Today (#460) the omp row still runs `omp update` through `resolveOmpBin()`, i.e. `ompweb-omp update`, upstream's self-updater, which on a compiled binary replaces it with upstream's `omp` [INFERENCE from upstream `update-cli.ts` `replaceBinaryForUpdate`; not run].

- `lib/omp/updates.ts`: `runOmpUpdate`, `checkOmpUpdate`, the cached check and `parseOmpUpdateStatus` deleted.
- `lib/self-update.ts`: `Kind` is `"app"` only.
- `app/api/omp-update/route.ts`: only `restart` remains.
- `lib/hosts/update-types.ts`/`updates.ts`/`daemon.ts`: `HostUpdateTarget` is `"ompweb"`; `HostUpdateInfo.omp` is `{ currentVersion }`; `startHostUpdate("omp")` is `invalid_target`.
- `components/HostUpdates.tsx` and the Settings omp card: version plus "Updated with ompweb", no button; i18n en/ja/zh-CN/zh-TW.
- Tests: the omp row shows `18.20.0-int.202611130355.d2c2eff` (and an all-digit sha such as `0123456`); `HOST_VERSION_PATTERN` and `ompSharesCredentials("omp/18.20.0-int.202611130355.d2c2eff")` accept it (F9).

## integration-ci cleanup

After one green scheduled round in the fork and one green ompweb pre-release on it: delete `.github/workflows/omp-auto.yml`, `omp.yml`; `.github/actions/omp-agent`, `omp-round`; `scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh`; `prompts/omp-repair.md`; `config/root--git--oh-my-pi.sh`; `config/fixups/root--git--oh-my-pi/`; the `oh-my-pi` and `apple-sdk` releases; README's oh-my-pi section; the secrets `OMP_FORK_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` if nothing else there uses them. `docs/specs/2026-11-11-omp-auto-integration-design.md` gets "superseded by the fork's `fork-ci` branch; see kahme247/ompweb `docs/specs/2026-11-12-omp-build-in-ompweb-design.md`". Kept: `integration` (with F8's changes), `changelog-merge`, `integration.test.sh`, `publish.yml`, `ompweb.yml`, `graphify.yml`, `superpowers.yml`, the `omp-auto` label and old issues.

## Rollout and rollback

1. integration-ci: `integration heads` and `CI_CONFIG_REF` with tests (harmless to today's round).
2. Fork setup (user is admin): Environment `omp-round` limited to `fork-ci` with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OMP_FORK_TOKEN`; push orphan `fork-ci` (F1, F4–F7 content, no `schedule` in `omp-auto.yml` yet); create `apple-sdk`; switch the default branch to `fork-ci`; dispatch `fork-guard.yml`.
3. Disable integration-ci's `omp-auto.yml` schedule.
4. Delete the fork's old-format `v*-int.<sha7>` releases and tags (F9). Dispatch the fork's `omp-auto.yml` with `force=true`: a promoted release `v<base>-int.<stamp>.<sha7>` carrying #19075 and the update-source PR, neither #18646 nor #18668, with tarballs; its binaries print that version.
5. Host rewiring (F8); `integration build && integration deploy` for `/opt/omp-patched` — the bootstrap install of the first fork-updating binary on ai-dev (F9). Other machines running older fork binaries need the same one-time manual install.
6. ompweb PR B (W1 + W2), PR C (W3).
7. Add the `schedule` to `fork-ci`'s `omp-auto.yml`.
8. Cleanup in integration-ci.

Rollback before step 8: switch the fork's default branch back to `main`, `gh workflow enable` integration-ci's `omp-auto.yml`, restore the `~/.config/integration` symlink, copy any new `fork-ci` fixups back to integration-ci. Fork releases stay valid. ompweb PRs revert independently.

## Risks

- Bun `overrides` with tarball URLs for transitive dependencies is unverified (spike, fallback in W1).
- Whether `GITHUB_TOKEN` is refused for a ref update and a release tag that cross upstream workflow changes is inferred; Task 1 verifies, and the PAT fallback stays where it does.
- A new upstream workflow can run once on the push that adds it before F2 disables it (no secrets, Actions minutes only).
- 60-day inactivity can disable the fork's schedules in a quiet period.
- `fork-ci` as default branch confuses the fork's web UI ("Sync fork", PR base defaults).
- Every (pre)release follows `integration-release`, so an hourly round can break the next ompweb (pre)release (Q1).
- #19075 can change in review; the runner then breaks at `tsc` in the next (pre)release.
- Dropping #18668/#18646 can invalidate later resolution patches.
- Rounds also run on carried-PR pushes: more builds, ~25 min each warm. The fork's bazel caches start cold (first round up to ~2 h).
- The round reads the `integration` script from integration-ci `main` unpinned, as today.
- Until the first F9 binary is installed by hand, fork binaries with `update.auto` on can be replaced by upstream's binary on upstream's next release (F9 bootstrap).
- The F9 build depends on the update-source PR staying in the integration; the smoke check fails the build if it drops out.
- A sha7 of seven digits starting with `0` (about 1 in 160 builds) is a numeric prerelease identifier with a leading zero, which strict semver rejects; how `Bun.semver.order` treats it is unverified (Q5).
- Escalation issues and repair notes are public on the fork.

## Open questions for the user

1. **When the newest `integration-release` build breaks an ompweb (pre)release** (runner fails `tsc` against it, or it has no tarballs), should the (pre)release fail (this design), or fall back to the committed pin and say so in its notes?
2. **Upstream's workflows in the fork:** disable all of them (this design: `CI`, `Warm bun store cache`, `OMP Nix` — which today builds each `-int.` tag —, `os-session-tests`, `windows-rename-probe`, `Windows EPIPE regression`, `Copilot`, and any future one), or keep some running (e.g. `OMP Nix` on `-int.` tags)? A kept one runs upstream's code on mirror syncs and tags, without the round's secrets.
3. **`fork-ci` as the fork's default branch** changes the fork's web UI defaults ("Sync fork" targets `fork-ci`, in-fork PRs default to base `fork-ci`, clones check out `fork-ci`). Acceptable?
4. **Inactivity:** if no round runs for 60 days, GitHub disables the fork's schedules. Accept and re-enable by hand, or have `fork-guard.yml` make a monthly no-op commit to `fork-ci`?
5. **All-digit sha7 with a leading zero** (e.g. `…-int.202611130355.0123456`) is invalid strict semver. Accept the risk (comparison is decided by the stamp before it; verify `Bun.semver.order` in the plan's spike), or prefix the sha (`…-int.<stamp>.g<sha7>`)?

## Decisions recorded (2026-11-13)

- The round lives in `andrebrait/oh-my-pi` on branch `fork-ci`; releases and escalation issues on the fork; integration-ci keeps only the script and its other builds; ompweb has no secrets and builds no omp.
- (Pre)releases use the newest `integration-release` build (W2).
- The round also runs when any carried PR's head changes (F5).
- #14148, #14458, #14608 stay; #18646 dropped; #18668 is RPC-only, in `SKIP_PRS` (F4).
- Pin bumps are manual (`use-omp-build.ts`); each (pre)release re-pins for what it ships (W1, W2).
- The `integration` script exists only in integration-ci; the round checks it out from there (F1).
- The omp row is read-only, "Updated with ompweb" (W3).
- Fork binaries are compiled with `PI_UPDATE_REPO=andrebrait/oh-my-pi` (`feat/configurable-update-source`, `4a7bb87e`) and versioned `<upstream>-int.<YYYYMMDDHHMM>.<sha7>`; the stamp is the integration commit's committer time in UTC, computed once and shared by every job and the tag; release tags are `v` + that version exactly; old-format `-int.<sha7>` releases are deleted and never reused (F9).
