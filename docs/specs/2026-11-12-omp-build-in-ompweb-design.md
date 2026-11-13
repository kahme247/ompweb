# ompweb ships the omp integration build — design

Date: 2026-11-12, revised 2026-11-13 (two-repo split). Branch: `ci/omp-build` (on `feat/omp-runner`, PR #460).
Amends: `andrebrait/integration-ci` `docs/specs/2026-11-11-omp-auto-integration-design.md` (§1 trigger, §1 escalation, §2 release assets, config) and replaces its §3 (omp-web's **Custom** omp update source, never built). §3b (ompweb pre-release channel) and §3c (GitHub token) are unaffected.
Depends on: #460 (`runner/`, `ompweb-omp`) and can1357/oh-my-pi#19075 (`runSessionHost`), carried in the integration build.

## Why

ompweb ships its own omp build (`ompweb-omp`, `runner/`), compiled today against npm `@oh-my-pi/pi-coding-agent@18.19.0` plus a Bun patch (`runner/patches/`) that back-ports `runSessionHost`. The omp the user runs (`/opt/omp-patched`) comes from integration-ci's hourly integration of upstream releases plus the user's carried PRs, released on `andrebrait/oh-my-pi`. This design makes `ompweb-omp` use that same integration build.

## Split

| Repository | Owns | Secrets |
|---|---|---|
| `andrebrait/integration-ci` | the omp round: `omp-auto.yml` (hourly, rebase, integrate, build, AI repair, release), `omp.yml` (build, natives, binaries, smoke, **pack**), the `integration` script and its omp config and fixups, the `apple-sdk` mirror, the `/opt/omp-patched` deploy | `OMP_FORK_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (already there) |
| `andrebrait/oh-my-pi` | the fork releases `<tag>-int.<sha7>` and branch `integration-release`, now with npm tarballs; escalation issues | — |
| `kahme247/ompweb` | consumes one public fork release: `runner/` pinned to its tarballs; (pre)releases re-pin to the newest `integration-release` build; the omp row follows ompweb | **none** |

Nothing of the omp round moves into ompweb. ompweb never builds omp.

## Decisions

### D1. integration-ci: RPC drops (config `config/root--git--oh-my-pi.sh`)

| Item | Change |
|---|---|
| `EXTRA_PRS` | `'7851=carry/pr-7851'` (drops `18646=carry/pr-18646`, pasquale95's RPC form dialog); its comment loses the 18646 line |
| `SKIP_PRS` (new line) | `'18668'` — the user's own "correlate RPC input with client message IDs", RPC-only (decided); `runner/src/correlation.ts` rebuilds the same contract from public API |
| `TEST_CMD` (line 23 list) | remove `rpc-queued-message`, `rpc-cancel-subagent`, `rpc-steer-subagent` |
| `TEST_CMD` (line 25 list) | remove `rpc-native-input`, `rpc-input-frame`, `rpc-prompt-result`, `rpc-skill-command`, `rpc-compatible-primitives`, `rpc-extension-ui`; the comment above loses "and host RPC contracts" |
| `TEST_CMD` (lines 59–60) | delete "Carried PR #18646 (RPC form dialog) contract tests" and its separate `bun test …rpc-extension-ui.test.ts packages/tui/test/html-form.test.ts` process (`html-form.test.ts` is upstream's TUI test, run by upstream CI) |
| fixups | delete `config/fixups/root--git--oh-my-pi/18668-prompt-claim-optional.patch`, `18668-resolve.patch`, `18668-skill-command-client-message-id.patch` |
| `STACKED_PRS` | unchanged (neither PR is stacked) |

All `rpc-*` paths are `packages/coding-agent/test/rpc-*.test.ts`; 10 occurrences (`rpc-extension-ui` twice). RPC work already merged upstream (#18929 checkbox state, #18930 form context, earlier `feat(rpc)` PRs) is in the base release and cannot be left out. Mixed PRs stay (decided): #14148, #14458 (stacked on #14148) and #14608. Resolution patches written with #18668/#18646 present (`18780-resolve.patch`, `14458-resolve.patch`, …) may stop applying; the first round's `integrate-repair` or a local `integration rebuild` refreshes them.

### D2. integration-ci: the round also runs when a carried PR changes

`omp-auto.yml` `detect` starts a round when the round's **inputs** differ from those of the last promoted release, not only on a new upstream tag (decided). Inputs: the upstream tag (latest release, or input `tag`) plus every carried PR's fork branch and head sha — the set `integration` builds (the user's open PRs on `can1357/oh-my-pi`, open `EXTRA_PRS`, minus `SKIP_PRS`).

- Current inputs: new subcommand `integration heads` (gh only, no fork code) prints `<pr>\t<branch>\t<sha>` per carried PR from `pr_rows`, sha from `gh api repos/<fork>/branches/<branch>`.
- Released inputs: each squash commit on `integration-release` already records `Squashed from <ref> (<sha>)`; `detect` reads the base tag and those shas through `gh api repos/$FORK/commits?sha=integration-release`, as `release` already does for the notes.
- A round therefore starts on a new tag, a PR opened/closed/merged, or a carried branch pushed. Branches the round rebases are pushed before `integrate`, and their squash records the pushed sha, so a finished round does not trigger the next one.
- A failed round is not retried hourly for unchanged inputs: `detect` skips when an open `omp-auto` issue on `andrebrait/oh-my-pi` names the same `inputs: <sha256>` (digest of the sorted table). `force` overrides both checks. The one-round-at-a-time check is unchanged.
- Release tags stay `<upstream tag>-int.<sha7>`; several releases per upstream tag are now normal.

### D3. integration-ci: escalation issues on the fork

`escalate` opens and comments its issues on `andrebrait/oh-my-pi` (decided), label `omp-auto`, with `GH_TOKEN: ${{ secrets.OMP_FORK_TOKEN }}`; job permissions shrink to `actions: read`. The body adds `inputs: <sha256>` from `detect`. Prerequisites: issues enabled on the fork (today `has_issues: false`) and `OMP_FORK_TOKEN` with Issues read/write on it. Issue text (repair notes, log tails) is public.

### D4. integration-ci: npm tarballs on every fork release

`omp.yml` gets a job `pack` (needs `natives`; fork code; `contents: read`, no secrets):

- `bun install --frozen-lockfile`, the `natives-*` artifacts into `packages/natives/native`.
- Packs every public workspace package exactly as upstream would publish it for that commit: upstream's manifest rewrite (`scripts/ci-release-publish.ts`: `catalog:`/`workspace:` resolved, `prepack` run, so `pi-coding-agent` ships `dist/docs-index.generated.txt` and `scripts/`) and `bun pm pack`, without publishing.
- One `@oh-my-pi/pi-natives-<os>-<arch>` leaf package (`packages/natives/scripts/gen-npm-packages.ts`) per target `runner/scripts/build-binary.ts` builds: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`.
- Versions stay the base release's (e.g. `18.19.0`), so `ompweb-omp --version` and ompweb's `HOST_VERSION_PATTERN` see a plain semver; the integration sha is in the release.
- Output: artifact `omp-packages` = `omp-packages-<sha10>.tar` (all `.tgz`) and `omp-packages.json` (`{ "<npm name>": "<file>.tgz" }`).

`omp-auto.yml` `release` (no fork code) downloads `omp-packages` too and attaches the **individual** `.tgz` files plus `omp-packages.json` to the fork release (individual assets so a lockfile can point at one URL each). The binaries, `SHA256SUMS.txt` and notes are unchanged. `omp.yml`'s rolling `publish` to integration-ci's `oh-my-pi` release (manual `integration build`) is unchanged and does not carry tarballs.

Pruning keeps the newest 10 `-int.` releases **plus** the one ompweb `main` pins: before deleting, `release` reads `gh api repos/kahme247/ompweb/contents/runner/package.json` (public) and skips that tag. A release older than D4 has no tarballs; ompweb cannot pin it.

Unchanged in integration-ci: `apple-sdk` mirror, bazel caches, trust split, `ompweb.yml`, `/opt/omp-patched` (`DEPLOY_CMD`, `CI_REPO=andrebrait/integration-ci`, `CI_WORKFLOW=omp.yml`), and the `integration` script's single home.

### D5. ompweb: `runner/` against a fork release

- `runner/package.json` keeps its dependency names and adds `overrides` mapping every `@oh-my-pi/*` package — transitive ones and the five leaf packages included — to `https://github.com/andrebrait/oh-my-pi/releases/download/<tag>/<file>.tgz` of one fork release. That release is **the committed pin**; `runner/bun.lock` records the URLs with integrity hashes. `patchedDependencies` and `runner/patches/` are deleted.
- `runner/scripts/use-omp-build.ts <tag>` reads the release's `omp-packages.json`, rewrites the overrides (removing stale `@oh-my-pi/*` ones) and runs `bun install` (lockfile updated). Pin bumps are manual ompweb PRs with it (decided).
- `runner/scripts/build-binary.ts` is unchanged: same `node_modules` layout; `bun install --os='*' --cpu='*'` still installs every leaf.
- `verify-pr.yml`, `omp-runner.yml` and integration-ci's `ompweb.yml` install the committed pin with `--frozen-lockfile`; they need no token beyond public downloads.
- Spike first (plan Task 1): Bun must honour `overrides` with tarball URLs for transitive dependencies. Fallback if not: `use-omp-build.ts` rewrites the direct `dependencies` to URLs and adds every transitive `@oh-my-pi/*` package as a direct dependency with its URL, so no override is needed.

### D6. ompweb: every (pre)release uses the newest `integration-release` build

`prerelease.yml` and `publish.yml`, before `sh scripts/build-release-binaries.sh`:

1. `sha=$(gh api repos/andrebrait/oh-my-pi/commits/integration-release --jq .sha)`; `tag` = the fork release whose tag ends `-int.${sha:0:7}` (`gh release list -R andrebrait/oh-my-pi`). `GITHUB_TOKEN` reads public repositories; no secret.
2. `npx bun runner/scripts/use-omp-build.ts "$tag"`, then `(cd runner && npx bun x tsc -p .)`.
3. The prerelease notes and the draft release notes get `omp: andrebrait/oh-my-pi <tag>`.

`integration-release` only moves after its release exists (`release` creates the release, then moves the branch), so step 1 finds it. If the newest build lacks tarballs (released before D4) or the runner no longer type-checks against it, the (pre)release fails (Q1). The (pre)release's lockfile differs from the committed one only in those URLs and hashes; it is not committed back.

Added time: download of ~5 tarball sets, about 1 minute. ompweb gains no secrets, environments or new triggers; `prerelease.yml`'s main-only dispatch guard stays.

### D7. ompweb updater: the omp row follows ompweb

`ompweb-omp` is versioned with ompweb; hosts get a new omp only by updating ompweb. Today (#460) the omp row still runs `omp update` through `resolveOmpBin()`, i.e. `ompweb-omp update`, upstream's self-updater, which on a compiled binary replaces it with upstream's `omp` [INFERENCE from upstream `update-cli.ts` `replaceBinaryForUpdate`; not run]. Changes:

- `lib/omp/updates.ts`: `runOmpUpdate`, `checkOmpUpdate`, the cached check and `parseOmpUpdateStatus` are deleted.
- `lib/self-update.ts`: `Kind` is `"app"` only; `omp-self-update` state files are no longer written.
- `app/api/omp-update/route.ts`: `check`/`update`/`commit`/`status`/`acknowledge` removed; `restart` (restart all sessions) stays.
- `lib/hosts/update-types.ts`/`updates.ts`/`daemon.ts`: `HostUpdateTarget` is `"ompweb"`; `HostUpdateInfo.omp` is `{ currentVersion }` from `getOmpVersion()`; `startHostUpdate("omp")` is `invalid_target` (older servers that send it get that error).
- `components/HostUpdates.tsx` and the Settings omp card: version plus "Updated with ompweb", no button. i18n en/ja/zh-CN/zh-TW.
- The **Custom** source of the 2026-11-11 design is not built.

### D8. Rollout and rollback

1. integration-ci (pushed to `main`, which CI reads): D1 config and fixups, D2 `integration heads` + `detect`, D3 `escalate`, D4 `pack` + `release` assets + prune guard, script tests.
2. `gh repo edit andrebrait/oh-my-pi --enable-issues`; the user confirms `OMP_FORK_TOKEN` has Issues read/write on the fork.
3. Dispatch integration-ci `omp-auto.yml` with `force=true`: a promoted fork release whose notes carry #19075, neither #18646 nor #18668, and whose assets include `omp-packages.json` and the `.tgz` files.
4. `/opt/omp-patched`: `integration build && integration deploy` from that `integration-release`, as today.
5. ompweb PR B (on #460): D5 + D6.
6. ompweb PR C: D7.

Rollback: integration-ci changes revert with `git revert` on its `main` (fork releases stay valid; extra assets are harmless). ompweb PR B reverts to the npm pin and patch; PR C reverts independently.

## Risks

- Bun `overrides` with tarball URLs for transitive dependencies is unverified (spike, fallback in D5).
- #19075 can change in review; the runner then breaks at `tsc` in the next (pre)release, not at runtime.
- Every (pre)release follows `integration-release`, so an hourly round can break the next ompweb (pre)release (D6, Q1).
- Dropping #18668/#18646 can invalidate later resolution patches; the first round may need the repair agent or a local rebuild.
- Rounds now also run on carried-PR pushes (D2): more full builds, ~25 min each with a warm cache.
- integration-ci's prune reads ompweb's pin; a pin bumped by a PR that is not yet merged can be pruned under it (the PR's CI fails until rebased onto a kept release).
- Escalation issues and repair notes are public on `andrebrait/oh-my-pi`.

## Open questions for the user

1. **When the newest `integration-release` build breaks an ompweb (pre)release** (runner fails `tsc` against it, or it has no tarballs), should the (pre)release fail (this design), or fall back to the committed pin and say so in its notes?

## Decisions recorded (2026-11-13)

- The omp round stays in `andrebrait/integration-ci`; releases stay on `andrebrait/oh-my-pi`; ompweb gets no secrets and builds no omp.
- (Pre)releases use the newest `integration-release` build (D6).
- The round also runs when any carried PR's head changes (D2).
- #14148, #14458 and #14608 stay; #18646 is dropped; #18668 is RPC-only and goes to `SKIP_PRS` (D1).
- Escalation issues go to `andrebrait/oh-my-pi` (D3).
- Pin bumps are manual (`use-omp-build.ts`); each (pre)release re-pins for what it ships (D5, D6).
- The `integration` script stays only in integration-ci; the `apple-sdk` mirror and `/opt/omp-patched` deploy are unchanged (D4).
- The omp row in ompweb's updater is read-only, "Updated with ompweb" (D7).
