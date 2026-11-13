# ompweb ships the omp integration build — design

Date: 2026-11-12, final 2026-11-13. ompweb side: PR #473 (`feat/omp-runner`).
Supersedes: `andrebrait/integration-ci` `docs/specs/2026-11-11-omp-auto-integration-design.md` (the round moves into the fork) and its §3 (omp-web's **Custom** omp update source, never built). §3b (ompweb pre-release channel) and §3c (GitHub token) are unaffected.
Depends on: PR #473's runner (`runner/`, `ompweb-omp`); can1357/oh-my-pi#19075 (`runSessionHost`) and the fork owner's `feat/configurable-update-source` (`ef93b0ad`, `PI_UPDATE_REPO`), both carried in the integration build.

## Why

Before this design, ompweb's own omp build (`ompweb-omp`, `runner/`) compiled against npm `@oh-my-pi/pi-coding-agent@18.19.0` plus a Bun patch that back-ported `runSessionHost`, and the omp deployed on the build host came from integration-ci's hourly integration of upstream releases plus the carried PRs, released on `ompweb-dev/oh-my-pi`. This design moves that round into the fork itself, makes fork binaries update from fork releases, and makes `ompweb-omp` compile against the fork's own packages.

Current state: `runner/omp-build.json` pins the fork release `v18.20.0-int.202611130808.gfd57e86`, the runner installs only that release's packages, and the Bun patch and `runner/patches/` are gone. Every ompweb (pre)release re-pins to the newest `integration-release` build (W2). Progress per task is in `docs/plans/2026-11-12-omp-build-in-ompweb.md`.

## Three places

| Where | Owns after cut-over | Secrets |
|---|---|---|
| `ompweb-dev/oh-my-pi` (the fork) | the omp round on branch `fork-ci` (workflows, config, fixups, repair prompt, helper scripts); releases `v<upstream>-int.<stamp>.g<sha7>` with binaries and an npm package zip; `integration-release`; `apple-sdk` mirror; escalation issues | Environment `omp-round` (only `fork-ci`): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OMP_FORK_TOKEN` (fallback only, F3). Everything else uses the workflow's own `GITHUB_TOKEN` |
| `kahme247/ompweb` | `runner/` pinned to one fork release's packages; every (pre)release re-pins to the newest `integration-release` build; the omp row follows ompweb | none |
| `andrebrait/integration-ci` | the `integration` script (single copy); graphify, superpowers and ompweb builds; its omp workflows, scripts, config, fixups, releases and omp secrets are deleted after cut-over | omp secrets removed |

## Fork

### F1. `fork-ci`: an orphan default branch

The fork's `main` stays a clean fast-forward mirror of upstream `main` (`integration`'s `sync_fork_base`). Scheduled and dispatched workflows run only from the **default branch**, so the round lives on an orphan branch `fork-ci`, made the fork's default branch (decided). Its tree mirrors integration-ci's omp layout, so workflow paths barely change:

```
.github/workflows/omp-auto.yml     # from integration-ci, adapted (F3–F9)
.github/workflows/omp.yml          # from integration-ci, + version, pack (F6, F9)
.github/workflows/publish.yml      # from integration-ci (rolling `oh-my-pi` release for manual `integration build`)
.github/workflows/fork-guard.yml   # F2
.github/actions/omp-agent/, omp-round/
config/root--git--oh-my-pi.sh
config/fixups/root--git--oh-my-pi/*.patch
prompts/omp-repair.md
scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh
README.md                          # what this branch is; never merged; how to sync main
```

In every job the fork's code is checked out at the workspace root with an explicit `ref` (`main`, a tag or a sha — never the default, which is now `fork-ci`), `fork-ci` at `ci/` (as integration-ci was), and the `integration` script from `andrebrait/integration-ci` `main` at `tools/` (public, read-only; fresh each run, as today). `ci/integration` becomes `tools/integration`; `INTEGRATION_CONFIG_DIR=$GITHUB_WORKSPACE/ci/config`. One copy of the script.

What the default-branch switch changes:

- **Upstream's workflows in the fork** run today: `CI` and `Warm bun store cache` on pushes to `main` (every mirror sync), `OMP Nix` on its schedule and on every `v*` tag (each `-int.` release starts a Nix build), `os-session-tests`, `windows-rename-probe`, `Windows EPIPE regression`, `Copilot`. All are disabled (decided, F2).
- **`gh pr create`** from the local oh-my-pi checkout keeps targeting upstream (`gh repo set-default can1357/oh-my-pi`). A PR opened inside the fork defaults to base `fork-ci`; pass `--base main`. `sync_fork_base` already passes `--base`.
- **"Sync fork" / `gh repo sync`** act on the default branch: sync the mirror with `integration` or `gh repo sync ompweb-dev/oh-my-pi -b main`, never the bare command or the web button. The `fork-ci` README says so. Only the user's own GitHub UI clicks are affected (decided acceptable).
- Clones check out `fork-ci`; `origin/HEAD` moves. The script uses explicit refs everywhere.
- 60 days without repository activity disables the fork's schedules; releases are frequent, so no keep-alive (decided).

### F2. `fork-guard.yml`

`schedule` daily and `workflow_dispatch`; `permissions: actions: write`; no fork code. Lists `gh api repos/$GITHUB_REPOSITORY/actions/workflows` and disables each `active` workflow whose `path` is not a file on `fork-ci`. `omp-auto.yml` `detect` runs the same step first, so a workflow added by a mirror sync is disabled within the hour; it can still run once on the push that added it, without the round's secrets (F3).

### F3. Secrets, tokens, trust

Secrets live in Environment `omp-round` with deployment branches `fork-ci` only; every job that reads one declares `environment: omp-round`, so upstream's workflows (on `main`, tags, PR branches) can never read them.

| Write | Token |
|---|---|
| escalation issues | `GITHUB_TOKEN`, `issues: write` |
| fixup commits to `fork-ci` | `GITHUB_TOKEN`, `contents: write` |
| `gh workflow disable` (F2) | `GITHUB_TOKEN`, `actions: write` |
| release creation, asset uploads, prune, rolling `oh-my-pi` release | `GITHUB_TOKEN`, `contents: write`; release creation retries with the PAT like below |
| PR branch pushes (`rebase`, `rebase-repair-push`, `build-repair-push`), `integration-candidate`, `integration-release` | `GITHUB_TOKEN`, `contents: write`; retry with the PAT |

Push with `GITHUB_TOKEN` first, then retry once with `OMP_FORK_TOKEN` (fine-grained, this repository, Contents + Workflows write) only when GitHub refuses the write for the `workflows` permission (decided; no separate spike). That refusal is expected when a ref moves across an upstream release that changed `.github/workflows/`, because `GITHUB_TOKEN` can never hold that permission [INFERENCE for the refs API and release tag creation]. The retry lives in `scripts/push-rebased.sh`, `scripts/publish-round.sh` and the `release`/`integration-release` step, matching the error text, and logs which token succeeded so the PAT can be removed later if the fallback never fires.

`GITHUB_TOKEN` pushes start no workflows; `OMP_FORK_TOKEN` pushes start push-triggered ones, which F2 keeps disabled; `fork-ci`'s workflows have no `push`, `pull_request` or `pull_request_target` trigger. Jobs that run fork code or an agent hold no write token and hand refs and patches to publishing jobs that run no fork code. `commit-fixups.sh` refuses a patch outside `config/fixups/root--git--oh-my-pi/` and pushes `HEAD:fork-ci`. The repair agent binary stays upstream's digest-checked `omp-linux-x64`.

### F4. RPC drops (`config/root--git--oh-my-pi.sh`)

| Item | Change |
|---|---|
| `EXTRA_PRS` | `'7851=carry/pr-7851'` (drops `18646=carry/pr-18646`); comment loses the 18646 line |
| `SKIP_PRS` (new) | `'18668'` — RPC-only (decided); `runner/src/correlation.ts` rebuilds the contract from public API |
| `TEST_CMD` (line 23 list) | remove `rpc-queued-message`, `rpc-cancel-subagent`, `rpc-steer-subagent` |
| `TEST_CMD` (line 25 list) | remove `rpc-native-input`, `rpc-input-frame`, `rpc-prompt-result`, `rpc-skill-command`, `rpc-compatible-primitives`, `rpc-extension-ui`; comment loses "and host RPC contracts" |
| `TEST_CMD` (lines 59–60) | delete "Carried PR #18646 (RPC form dialog) contract tests" and its separate `bun test …rpc-extension-ui.test.ts packages/tui/test/html-form.test.ts` process |
| fixups | `18668-prompt-claim-optional.patch`, `18668-resolve.patch`, `18668-skill-command-client-message-id.patch` are not copied to `fork-ci` |
| `CI_REPO` / `CI_WORKFLOW` / `CI_CONFIG_REF` | `ompweb-dev/oh-my-pi` / `omp.yml` / `origin/fork-ci` (F8) |
| `STACKED_PRS` | unchanged |

10 `packages/coding-agent/test/rpc-*.test.ts` occurrences (`rpc-extension-ui` twice). Merged upstream RPC work (#18929, #18930, earlier `feat(rpc)` PRs) is in the base release. #14148, #14458 (stacked on #14148) and #14608 stay (decided). Resolution patches written with #18668/#18646 present may stop applying; the first round's `integrate-repair` or a local `integration rebuild` refreshes them.

### F5. The round also runs when a carried PR changes

`detect` starts a round when the round's **inputs** differ from those of the last promoted release (decided). Inputs: the upstream tag (latest release, or input `tag`) plus each carried PR's fork branch and head sha (the user's open PRs on `can1357/oh-my-pi`, open `EXTRA_PRS`, minus `SKIP_PRS`).

- Current inputs: `integration heads` (gh only, no fork code) prints `<pr>\t<branch>\t<sha>` per carried PR.
- Released inputs: each squash on `integration-release` records `Squashed from <ref> (<sha>)`; `detect` reads them and the base tag through `gh api repos/$GITHUB_REPOSITORY/commits?sha=integration-release`.
- A round starts on a new tag, a PR opened/closed/merged, or a carried branch pushed. Branches the round rebases are pushed before `integrate` and their squash records the pushed sha, so a finished round does not retrigger.
- A failed round is not retried hourly for unchanged inputs: `detect` skips while an open `omp-auto` issue names the same `inputs: <sha256>`. `force` overrides both checks. One round at a time.

### F6. Each promoted release carries the npm packages

`omp.yml` job `pack` (needs `version`, `natives`; fork code; `contents: read`; no secrets), proven on linux-x64 by the LibSpike run (option A):

1. `bun install --frozen-lockfile`; F9's version rewrite; every `natives-*` artifact into `packages/natives/native`.
2. `bun scripts/ci-release-publish.ts` with a stub `npm` first on `PATH` that keeps each tarball instead of publishing it: 12 JS tarballs (manifests rewritten, `catalog:`/`workspace:` resolved, `prepack` run; `pi-coding-agent` ships `dist/docs-index.generated.txt` and `scripts/`, stats ships `dist/client`). ~20 s.
3. `bun scripts/ci-release-publish.ts --native-leaf <tag>` for each of the six leaf targets — `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` — from the `.node` files already in `packages/natives/native`. ~10 s each; no extra native builds.
4. Zip all 18 tarballs as `omp-packages-<version>.zip` with an `index.json` (`{ "<npm name>": "<file>.tgz" }`). Artifact `omp-packages`.

`omp-auto.yml` `release` (no fork code) uploads the zip beside the binaries and `SHA256SUMS.txt`. Pruning keeps the newest 10 new-format `-int.` releases plus the one ompweb `main` pins (`runner/omp-build.json` on `kahme247/ompweb` `main`, public). Releases older than F6 have no zip; ompweb cannot pin them.

### F7. Escalation and Apple SDK in the fork

- `escalate` uses `GITHUB_TOKEN` with `permissions: issues: write` on the fork itself, label `omp-auto`; body adds `inputs: <sha256>`. Issues are enabled (done). Issue text is public.
- The Apple SDK step reads `https://github.com/$GITHUB_REPOSITORY/releases/download/apple-sdk/<sha256>.pkg`; release `apple-sdk` is created on the fork (`--latest=false`) with `d55351824fd17742fd6e1e7a252fa1028698f32147ee48be9a6b75442bf30575.pkg` (70,553,676 bytes) from integration-ci's release. No workflow change.

### F8. Local `integration` and the deployed omp

The script stays only in integration-ci. Changes there (also used by the round through `tools/`):

- `heads` subcommand (F5).
- `CI_CONFIG_REF` (default `origin/main`): the ref `ci_build` fetches and diffs the config and `.github` against before dispatching (today hard-coded `origin main`).
- Tests in `integration.test.sh` for both.

Host wiring (the build host): a worktree of `fork-ci`. `~/.config/integration` becomes a directory: per-file symlinks into `integration-ci/config` for graphify, superpowers, ompweb, the pin scripts, `fixups/root--git--ompweb` and the `.retired-*` dirs; `root--git--oh-my-pi.sh` and `fixups/root--git--oh-my-pi` link into the `fork-ci` worktree. `ci_build` resolves the config's repository through `readlink -f`, so it diffs that worktree against `origin/fork-ci`.

`integration build` for oh-my-pi dispatches `omp.yml` on the fork; the reuse lookup reads `project: oh-my-pi` from `fork-ci`'s `omp.yml` and finds zips in the fork's rolling `oh-my-pi` release. `DEPLOY_CMD` is unchanged. Deploying an auto round, in the local oh-my-pi checkout: `git fetch origin && git branch -f integration origin/integration-release && integration build && integration deploy`. The first such deploy after F9 is the bootstrap install on the build host.

### F9. Fork versions, tags and `omp update`

`feat/configurable-update-source` (`ef93b0ad`, carried): with `PI_UPDATE_REPO=<owner>/<repo>` baked in by `packages/coding-agent/scripts/compile-binary.ts` (`define`, only when the build environment sets it), a compiled omp's startup check, `omp update`, binary takeover and `update.auto` read `https://api.github.com/repos/<repo>/releases/latest` (exact version: `releases/tags/v<version>`) instead of `build.stencil.so`, and verify each download against the asset's GitHub `digest` (sha256).

Release contract (from the update-source note; `feat/configurable-update-source` at `ef93b0ad`, 19/19 tests incl. an all-digit leading-zero hash):

1. Compile with `PI_UPDATE_REPO=ompweb-dev/oh-my-pi` in the env of `bun run ci:release:build-binaries`.
2. Tag = `v` + exactly what `omp --version` reports (post-install check requires equality, else rollback).
3. Version format: `<upstream version>-int.<YYYYMMDDHHMM UTC>.g<sha7>`, e.g. `18.20.0-int.202611130355.gd2c2eff`.
   The numeric time identifier makes same-base builds sort (verified with `compareVersions` and `Bun.semver.order`); the `g` keeps an all-digit hash from becoming a numeric identifier with a leading zero (decided).
4. **Stamp** = the integration commit's committer time in UTC (decided, confirmed): `TZ=UTC git show -s --format=%cd --date=format-local:%Y%m%d%H%M "$SHA"`. It is a property of the commit, so every matrix job and the tag compute the same value; no job uses its own clock. `omp.yml`'s first job `version` (no fork code; blobless clone at the sha) also outputs `stamp` and `version` for jobs without a checkout (`smoke`, and `omp-auto.yml` `release` through a `workflow_call` output). Each round makes a new integration commit, so stamps grow.
5. **Assets** keep upstream's names: `omp-{linux,darwin}-{x64,arm64}`, `omp-windows-{x64,arm64}.exe`. GitHub's per-asset `digest` (sha256) is what omp verifies; `SHA256SUMS.txt` stays. No musl assets: musl hosts get a clear error.
6. **Latest.** Every promoted `-int.` release is a full release created with `--latest` (never prerelease or draft); `releases/latest` ignores prereleases and drafts. `apple-sdk` and the rolling `oh-my-pi` release are `--latest=false`.

Build step (each `binaries` matrix job), verbatim from the note:

```yaml
         - name: Build release binary
           shell: bash
           env:
              RELEASE_TARGETS: ${{ matrix.target }}
              PI_UPDATE_REPO: ompweb-dev/oh-my-pi
              SHA: ${{ inputs.sha }}
           run: |
              set -euo pipefail
              stamp="$(TZ=UTC git show -s --format=%cd --date=format-local:%Y%m%d%H%M "$SHA")"
              jq --arg s "$stamp.g${SHA:0:7}" '.version += "-int." + $s' packages/utils/package.json > "$RUNNER_TEMP/utils.json"
              mv "$RUNNER_TEMP/utils.json" packages/utils/package.json
              bun run ci:release:build-binaries
```

Release tag (`release`, and the `version` job's output), verbatim from the note:

```bash
version="$(jq -r .version packages/utils/package.json)"   # upstream version, unstamped
rel="v$version-int.$stamp.g${SHA:0:7}"
```

`release` also checks `$version` equals the round's upstream tag without `v`, and refuses a tag not matching `^v[0-9]+\.[0-9]+\.[0-9]+-int\.[0-9]{12}\.g[0-9a-f]{7}$`. Smoke asserts `bin/omp --version` == `omp/${rel#v}`.

**Natives version (addition beyond the note).** Only `packages/utils/package.json` feeds `VERSION`, and with the note's step alone the natives keep `18.20.0`, which is correct for loading. But the natives loader keys its extracted-addon cache by the natives package's own version (`loader-state.js`: `versionedDir = path.join(nativesDir, packageVersion)`, `packageVersion` from `packages/natives/package.json`), so upstream omp, fork omp and `ompweb-omp` on one machine would share `~/.omp/natives/18.20.0/`, checked only by version and size. To separate them, the same stamp is appended to `packages/natives/package.json` with the identical `jq` line (`… packages/natives/package.json > "$RUNNER_TEMP/natives.json"`, then `mv`) in **every** job that builds or embeds natives — `natives` (before `bazel-natives.ts`, which stamps that version into each addon after linking, so bazel's caches are unaffected), `binaries` and `pack` — so the addon stamp, the leaf packages and the embedded manifest agree. Doing it in only some of those jobs makes the loader reject the addon. This needs one `binaries` run to confirm (plan Task 5).

- **Idempotence.** An sha that already has a new-format release (tag ending `.g<sha7>`) is not released again.
- **Smoke.** `bin/omp --version` must print `omp/$VERSION`; the linux-x64 binary must contain `ompweb-dev/oh-my-pi` (fails the build if the update-source PR dropped out).
- **Rolling `oh-my-pi` release** (manual `integration build`): same `version` job and define.
- **Old-format tags.** `v<base>-int.<sha7>` tags (`v18.19.0-int.77d6529`, `v18.20.0-int.d2c2eff`, …) sort above new ones of the same base when the sha has a letter. Cut-over deletes every old-format release and tag; `release` and prune only handle the new format, so the old one is never reused.
- **Bootstrap.** Existing fork binaries report the plain base version and update from Stencil: `omp update` or `update.auto` would move them to upstream's binary on upstream's next release. The first stamped build is installed by hand; on the build host the deploy (F8) does that. After that, updates come from fork releases.
- **Still upstream:** npm/bun installs (npm), Homebrew `can1357/tap/omp`, mise `github:can1357/oh-my-pi`. Unauthenticated GitHub API: 60 requests per hour per IP.

## ompweb

### W1. `runner/` against the fork's packages (LibSpike option A)

- `runner/omp-build.json` (committed): `{ "repo": "ompweb-dev/oh-my-pi", "tag": "v18.20.0-int.<stamp>.g<sha7>" }` — **the pin**.
- `runner/vendor/` (git-ignored) holds the unzipped `omp-packages-<version>.zip`.
- `runner/package.json`: the three direct `@oh-my-pi/*` dependencies become `file:./vendor/<file>.tgz`; `overrides` map **every** `@oh-my-pi/*` package (all 12) **and every native leaf** (all 6) to `file:./vendor/<file>.tgz`. Without a leaf override, `bun install` silently pulls upstream's npm leaf of the same version and the runner embeds upstream's addon (LibSpike pitfall); with the stamped natives version (F9) a missing override fails instead, because no npm leaf has that version. `patchedDependencies` and `runner/patches/` are deleted.
- `runner/bun.lock` records each `file:` tarball with its sha512; `--frozen-lockfile` fails on a tampered or different tarball.
- `runner/scripts/use-omp-build.ts`:
  - no argument: download the pinned release's zip, unzip into `runner/vendor/` (fetch only; then `bun install --frozen-lockfile`);
  - `<tag>`: re-pin — fetch that release's zip, rewrite `omp-build.json`, the `file:` dependencies and overrides from its `index.json`, run `bun install` (lockfile updated).
  Pin bumps are manual ompweb PRs (decided).
- Every runner install calls the fetch first: `verify-pr.yml`, `omp-runner.yml`, `scripts/build-release-binaries.sh`, and integration-ci's `ompweb.yml` and `config/root--git--ompweb.sh` `BUILD_CMD` (guarded by `[ -f runner/scripts/use-omp-build.ts ]` for older commits).
- `runner/scripts/build-binary.ts` is unchanged: same `node_modules` layout; `bun install --os='*' --cpu='*'` installs every leaf from `vendor/`. Measured on linux-x64: install 1 s, build 88 s, binary 245 MB, `--version` and `--smoke-test` and headless `hello` work, extracted addon byte-identical to the fork's build. Cross-target builds with fork leaves were not run by the spike.

### W2. Every (pre)release uses the newest `integration-release` build

`prerelease.yml` and `publish.yml`, before `sh scripts/build-release-binaries.sh`:

1. `sha=$(gh api repos/ompweb-dev/oh-my-pi/commits/integration-release --jq .sha)`; `tag` = the fork release matching `^v[0-9]+\.[0-9]+\.[0-9]+-int\.[0-9]{12}\.g${sha:0:7}$`. `GITHUB_TOKEN` reads public repositories; no secret.
2. `npx bun runner/scripts/use-omp-build.ts "$tag"`, then `(cd runner && npx bun x tsc -p .)`.
3. Notes gain `omp: ompweb-dev/oh-my-pi <tag>`.

`integration-release` moves only after its release exists. If the build has no package zip or the runner fails `tsc` against it, the (pre)release **fails** (decided); a human fixes the runner or the round. The re-pin is not committed back. Added time: about 1 minute plus the runner builds already there. ompweb gains no secrets, environments or triggers.

### W3. The omp row follows ompweb

Before W3 the omp row ran `omp update` through `resolveOmpBin()`, i.e. `ompweb-omp update`, which on a compiled binary replaces it with upstream's `omp` [INFERENCE from upstream `update-cli.ts` `replaceBinaryForUpdate`; not run]. `ompweb-omp`'s own build sets no `PI_UPDATE_REPO`.

- `lib/omp/updates.ts`: `runOmpUpdate`, `checkOmpUpdate`, the cached check and `parseOmpUpdateStatus` deleted.
- `lib/self-update.ts`: `Kind` is `"app"` only.
- `app/api/omp-update/route.ts`: only `restart` remains.
- `lib/hosts/update-types.ts`/`updates.ts`/`daemon.ts`: `HostUpdateTarget` is `"ompweb"`; `HostUpdateInfo.omp` is `{ currentVersion }`; `startHostUpdate("omp")` is `invalid_target`.
- `components/HostUpdates.tsx` and the Settings omp card: version plus "Updated with ompweb", no button; i18n en/ja/zh-CN/zh-TW.
- Versions: `HOST_VERSION_PATTERN` and `lib/version-compare.ts` already accept `X.Y.Z-int.<stamp>.g<sha7>`; no validator of the old `-int.<sha7>` form exists. Tests: the omp row shows `18.20.0-int.202611130355.gd2c2eff`; `HOST_VERSION_PATTERN` and `ompSharesCredentials("omp/18.20.0-int.202611130355.gd2c2eff")` accept it.

## integration-ci cleanup

After one green scheduled round in the fork and one green ompweb pre-release on it: delete `.github/workflows/omp-auto.yml`, `omp.yml`; `.github/actions/omp-agent`, `omp-round`; `scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh`; `prompts/omp-repair.md`; `config/root--git--oh-my-pi.sh`; `config/fixups/root--git--oh-my-pi/`; the `oh-my-pi` and `apple-sdk` releases; README's oh-my-pi section; the secrets `OMP_FORK_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` if no remaining workflow references them. `docs/specs/2026-11-11-omp-auto-integration-design.md` gets "superseded by the fork's `fork-ci` branch; see kahme247/ompweb `docs/specs/2026-11-12-omp-build-in-ompweb-design.md`". Kept: `integration` (F8), `changelog-merge`, `integration.test.sh`, `publish.yml`, `ompweb.yml` (with W1's fetch line), `graphify.yml`, `superpowers.yml`, the `omp-auto` label and old issues.

## Rollout and rollback

1. integration-ci: `integration heads`, `CI_CONFIG_REF`, tests (harmless to today's round).
2. Fork: Environment `omp-round`; push orphan `fork-ci` (no `schedule` yet); `apple-sdk` release; default branch → `fork-ci`; dispatch `fork-guard.yml`.
3. Disable integration-ci's `omp-auto.yml`.
4. Delete the fork's old-format releases and tags. Dispatch the fork's `omp-auto.yml` with `force=true`: a promoted release `v<base>-int.<stamp>.g<sha7>` carrying #19075 and the update-source PR, neither #18646 nor #18668, with `omp-packages-<version>.zip`; its binaries print that version.
5. Host rewiring (F8); `integration build && integration deploy` for the build host's omp (bootstrap). Other machines on older fork binaries get the same release installed by hand once.
6. ompweb W1, W2 and W3 (shipped together in PR #473) with integration-ci's fetch line for `ompweb.yml`/config.
7. Add the `schedule` to `fork-ci`'s `omp-auto.yml`.
8. integration-ci cleanup.

Rollback before step 8: default branch back to `main`, re-enable integration-ci's `omp-auto.yml`, restore the `~/.config/integration` symlink, copy new `fork-ci` fixups back to integration-ci. Fork releases stay valid. Reverting PR #473 reverts the ompweb side.

## Risks

- Cross-target `bun install --os/--cpu` with fork leaves and cross-target runner builds were not exercised by the spike (only linux-x64); PR #473's `omp-runner.yml` runs were the first test.
- Which writes `GITHUB_TOKEN` is refused is inferred; the PAT retry covers it, and its log shows whether it ever fires.
- A new upstream workflow can run once on the push that adds it before F2 disables it (no secrets).
- Every (pre)release follows `integration-release`, so an hourly round can fail the next ompweb (pre)release until the runner is adapted.
- #19075 and the update-source PR can change in review; the runner breaks at `tsc`, and the smoke check catches a dropped update source.
- Until the first stamped binary is installed by hand, older fork binaries with `update.auto` can be replaced by upstream's binary.
- Dropping #18668/#18646 can invalidate later resolution patches.
- Rounds also run on carried-PR pushes (~25 min each warm); the fork's bazel caches start cold (first round up to ~2 h).
- The round reads the `integration` script from integration-ci `main` unpinned, as today.
- Escalation issues and repair notes are public on the fork.

## Open questions

None.

## Decisions recorded (2026-11-13)

- The round lives in `ompweb-dev/oh-my-pi` on default branch `fork-ci`; releases, `apple-sdk` and escalation issues on the fork; integration-ci keeps only the script and its other builds; ompweb has no secrets and builds no omp.
- `fork-ci` as default branch is fine; sync the mirror with `integration` or `gh repo sync ompweb-dev/oh-my-pi -b main`.
- All upstream workflows are disabled in the fork (F2). No inactivity keep-alive.
- Tokens: `GITHUB_TOKEN` first, PAT retry only on a `workflows`-permission refusal; no token spike.
- The round also runs when any carried PR's head changes (F5).
- #14148, #14458, #14608 stay; #18646 dropped; #18668 is RPC-only, in `SKIP_PRS` (F4).
- Fork versions `<upstream>-int.<YYYYMMDDHHMM>.g<sha7>`, stamp = integration commit's committer time in UTC, computed once; tags `v` + that version; binaries compiled with `PI_UPDATE_REPO=ompweb-dev/oh-my-pi`; old-format tags deleted, never reused (F9).
- ompweb's runner uses the fork's own npm tarballs (LibSpike option A) from one `omp-packages-<version>.zip` per promoted release, `file:` deps plus overrides for every package and leaf, sha512-pinned in `bun.lock` (W1).
- Pin bumps are manual; every (pre)release re-pins to the newest `integration-release` build and fails if it cannot (W1, W2).
- The omp row is read-only, "Updated with ompweb" (W3).
