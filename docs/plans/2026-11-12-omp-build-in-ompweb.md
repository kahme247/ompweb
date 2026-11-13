# ompweb ships the omp integration build — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the integration-ci omp round drops RPC, also runs on carried-PR changes, escalates on the fork, and attaches npm tarballs to each fork release; ompweb's `runner/` compiles against such a release (no npm pin, no Bun patch), every ompweb (pre)release re-pins to the newest `integration-release` build, and the omp update row follows ompweb.

**Spec:** `docs/specs/2026-11-12-omp-build-in-ompweb-design.md` (D1–D8). Read it first. One question is open (spec Q1); Task 7 uses the spec's default (fail).

**Repositories:** Tasks 2–5 in `andrebrait/integration-ci` (`/root/git/integration-ci`, CI reads its `main`; `~/.local/bin/integration` and `~/.config/integration` are symlinks into it). Tasks 1, 6–8 in `kahme247/ompweb`, base `feat/omp-runner` (#460).

## Global Constraints

- kahme247/ompweb gets no secrets, environments or new triggers; it only downloads public fork releases.
- integration-ci keeps its trust split: jobs running fork code or an agent hold no push credential; publishing jobs run no fork code.
- integration-ci: keep the pinned action SHAs and the comment style; every script change gets a case in `integration.test.sh`.
- Commit titles: integration-ci follows its log (`omp: …`, `integration: …`); ompweb `feat(runner): …`, `ci(release): …`, `feat(hosts): …`.

## Review Focus

1. A round finishes → the next hourly `detect` sees unchanged inputs and skips; a push to one carried PR branch → the next `detect` starts a round; a failed round with an open issue for the same inputs is not retried hourly. (Task 3)
2. Prune never deletes the release ompweb `main` pins. (Task 4)
3. The fork release lists every `@oh-my-pi/*` package `runner/` resolves, and the five natives leaves. (Tasks 4, 6)
4. An ompweb pre-release ships the build `integration-release` points at, without any secret. (Task 7)
5. `ompweb-omp --version` prints a plain semver; the omp row has no update button; `startHostUpdate("omp")` is `invalid_target`. (Tasks 6, 8)

---

### Task 1: spike — Bun overrides to tarball URLs (ompweb, nothing committed)

- [ ] `npm pack` `@oh-my-pi/pi-coding-agent@18.19.0`, every `@oh-my-pi/*` it depends on transitively, and `@oh-my-pi/pi-natives-linux-x64@18.19.0` into `/tmp/spike/pkgs`; serve with `python3 -m http.server`.
- [ ] Copy `runner/` to `/tmp/spike/runner`; drop `patchedDependencies`; add `overrides` mapping each `@oh-my-pi/*` name to `http://127.0.0.1:<port>/<tgz>`; `bun install`.
- [ ] Verify: `bun.lock` lists the URL with integrity for transitive `@oh-my-pi/*` entries; `ls node_modules/@oh-my-pi` shows one copy each; `bun scripts/build-binary.ts linux-x64` resolves everything (only `runSessionHost` type errors expected, from the missing patch).
- [ ] If transitive overrides do not take: use spec D5's fallback (all `@oh-my-pi/*` as direct URL dependencies) in Task 6 and note it in the spec.

### Task 2: integration-ci — RPC drops (spec D1)

**Files:** `config/root--git--oh-my-pi.sh`; delete `config/fixups/root--git--oh-my-pi/18668-{prompt-claim-optional,resolve,skill-command-client-message-id}.patch`.

- [ ] `EXTRA_PRS='7851=carry/pr-7851'`, 18646 comment line removed; add `SKIP_PRS='18668'` with a one-line why above it.
- [ ] Remove the ten `packages/coding-agent/test/rpc-*.test.ts` occurrences; delete the "Carried PR #18646" comment and its `TEST_CMD+=` line; "and host RPC contracts" leaves the comment above the second list.
- [ ] Verify: `source config/root--git--oh-my-pi.sh; grep -c 'rpc-' <<<"$TEST_CMD"` prints `0`; `bash -c 'source config/root--git--oh-my-pi.sh; echo "$EXTRA_PRS|$SKIP_PRS"'` prints `7851=carry/pr-7851|18668`.
- [ ] Commit `omp: drop the RPC PRs and RPC contract tests from the integration`.

### Task 3: integration-ci — round on carried-PR changes, issues on the fork (spec D2, D3)

**Files:** `integration`, `integration.test.sh`, `.github/workflows/omp-auto.yml`, `prompts/omp-repair.md` (only if it names the issue location).

- [ ] `integration heads`: one `<pr>\t<branch>\t<sha>` line per `pr_rows base` row, sha from `gh api repos/<fork slug>/branches/<branch> --jq .commit.sha`, sorted by PR; documented in the header's usage. Test: rows and `SKIP_PRS` honoured (gh stubbed).
- [ ] `detect`: add a sparse checkout of this repo (`integration`, `config/`), run `ci/integration heads` with `INTEGRATION_*` envs as `rebase` uses; build the current table (`base\t<tag>` + rows) and the released table (base tag and `Squashed from … (<sha>)` per squash on `integration-release`, via `gh api repos/$FORK/commits?sha=integration-release&per_page=100`, mapped to branch by the `PR #N` subject). Equal → skip. Open `omp-auto` issue on `$FORK` whose body contains `inputs: <sha256 of current table>` → skip. `force` or `candidate` bypass both. Output `inputs` (the digest). The old "fork already has a release for this tag" check goes.
- [ ] `escalate`: `GH_TOKEN: ${{ secrets.OMP_FORK_TOKEN }}`, every `gh label/issue` call `-R "$FORK"`; body adds `inputs: ${{ needs.detect.outputs.inputs }}`; permissions `actions: read`.
- [ ] Verify: `bash integration.test.sh`; `actionlint .github/workflows/omp-auto.yml`.
- [ ] Commit `omp: rebuild when a carried PR changes and escalate on the fork`.

### Task 4: integration-ci — npm tarballs on fork releases (spec D4)

**Files:** `.github/workflows/omp.yml`, `.github/workflows/omp-auto.yml`.

- [ ] `omp.yml` job `pack` (needs `natives`; `contents: read`; checkout of `inputs.repo@inputs.sha`, `persist-credentials: false`): `./.github/actions/bun-install`; download `natives-*` into `packages/natives/native`; pack public packages the way `scripts/ci-release-publish.ts` does without publishing (its `--dry-run` if it leaves tarballs; otherwise call its manifest rewrite and `bun pm pack` per package); generate leaves for `linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64` with `packages/natives/scripts/gen-npm-packages.ts` and pack them; write `omp-packages.json`; upload artifact `omp-packages` (`omp-packages-<sha10>.tar` + index, `retention-days: 7`). `publish` needs `pack` too, so a failed pack fails the build.
- [ ] `omp-auto.yml` `release`: also download `omp-packages`, untar, upload each `.tgz` and `omp-packages.json` with the binaries. Prune: read the pinned tag from `gh api repos/kahme247/ompweb/contents/runner/package.json --jq .content | base64 -d` (the `releases/download/<tag>/` segment; none yet → nothing extra kept) and skip it.
- [ ] Verify: `actionlint` both files; Task 5's round.
- [ ] Commit `omp: attach the npm packages to each fork release`. Push integration-ci `main` (Tasks 2–4).

### Task 5: cut-over round (operational)

- [ ] `gh repo edit andrebrait/oh-my-pi --enable-issues`; ask the user to confirm `OMP_FORK_TOKEN` has Issues read/write on the fork.
- [ ] `gh workflow run omp-auto.yml -R andrebrait/integration-ci -f force=true`; watch to the end. Expected: a promoted release whose `## Carried patches` lists #19075 and neither #18646 nor #18668, with `omp-packages.json` and its `.tgz` files.
- [ ] Failure: the issue on `andrebrait/oh-my-pi` names the stage; fix, re-dispatch.
- [ ] `/opt/omp-patched`: `cd /root/git/oh-my-pi && git fetch origin && git branch -f integration origin/integration-release && integration build && integration deploy` (reuses the published build).
- [ ] Next scheduled run: `detect` skips (inputs unchanged).

### Task 6: ompweb — runner against the fork release (spec D5)

**Files:** `runner/package.json`, `runner/bun.lock`; delete `runner/patches/`; create `runner/scripts/use-omp-build.ts`; doc comment in `runner/scripts/build-binary.ts`; pin paragraph in `docs/specs/2026-11-12-omp-runner-design.md`.

- [ ] `use-omp-build.ts <tag>`: fetch `https://github.com/andrebrait/oh-my-pi/releases/download/<tag>/omp-packages.json`, set the overrides (or Task 1's fallback), drop stale `@oh-my-pi/*` overrides and `patchedDependencies`, write `package.json`, `bun install` in `runner/`; fail when a `@oh-my-pi/*` dependency has no entry.
- [ ] Run it with Task 5's tag; delete `runner/patches/`; `bun x tsc -p runner`, `bun test` in `runner/`, `bun runner/scripts/build-binary.ts linux-x64`, `runner/release/ompweb-omp-linux-x64 --version` (plain semver) and `--smoke-test` pass.
- [ ] Verify: Verify PR and `omp-runner.yml` green on the PR; `integration build-sha <sha>` with the ompweb config builds in integration-ci's `ompweb.yml`.
- [ ] Commit `feat(runner): compile ompweb-omp against the omp integration build`.

### Task 7: ompweb — (pre)releases re-pin to `integration-release` (spec D6)

**Files:** `.github/workflows/prerelease.yml`, `.github/workflows/publish.yml`.

- [ ] Step before `Build the release binaries` in both: resolve `sha` and `tag` (spec D6 step 1, `GH_TOKEN: ${{ github.token }}`), fail with a clear message when no release matches; `npx bun runner/scripts/use-omp-build.ts "$tag" && (cd runner && npx bun x tsc -p .)`; export `OMP_TAG`.
- [ ] Notes: prerelease `--notes` and the draft release notes (append after `generate-release-notes.js`) gain `omp: andrebrait/oh-my-pi $OMP_TAG`.
- [ ] Verify: `actionlint`; after merge, the next pre-release's notes name the current `integration-release` tag and its `ompweb-linux-x64` archive's `ompweb-omp --version` runs.
- [ ] Commit `ci(release): ship the newest omp integration build with every release`. Open PR B (Tasks 6–7).

### Task 8: ompweb — the omp row follows ompweb (spec D7)

**Files:** `lib/omp/updates.ts`, `lib/self-update.ts`, `app/api/omp-update/route.ts`, `lib/hosts/update-types.ts`, `lib/hosts/updates.ts`, `lib/hosts/daemon.ts`, `components/HostUpdates.tsx`, the Settings omp update card and its i18n keys (en, ja, zh-CN, zh-TW); tests `lib/hosts/updates.test.mjs`, `lib/hosts/host-updates-route.test.mjs`, `lib/self-update.test.mjs`, `components/SettingsConfig.updates.test.mjs`; `CHANGELOG.md`.

- [ ] Before editing, `xd://lsp` references for `checkOmpUpdate`, `runOmpUpdate`, `HostUpdateTarget`, `OmpUpdateStatus` and the `omp` `Kind`; add any caller missing above.
- [ ] Implement spec D7. Tests: `omp` target rejected; host update info has no omp `canUpdate`; Settings card has no update button. Delete tests of removed behaviour.
- [ ] Verify: `npm run typecheck`, `npm run lint`, `bun test --parallel lib/hosts lib/self-update.test.mjs components/SettingsConfig.updates.test.mjs`.
- [ ] CHANGELOG: "omp updates with ompweb: the omp row no longer runs `omp update`."
- [ ] Commit `feat(hosts): omp updates with ompweb`. Open PR C.

## Rollback

Spec D8: `git revert` the integration-ci commits on its `main`; revert PR B (npm pin and patch return) and PR C independently.
