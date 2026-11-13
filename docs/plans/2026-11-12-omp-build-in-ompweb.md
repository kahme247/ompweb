# ompweb ships the omp integration build — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the omp round runs in `andrebrait/oh-my-pi` from an orphan default branch `fork-ci` (RPC dropped, also triggered by carried-PR changes, escalating on the fork, releases with npm tarballs); ompweb's `runner/` compiles against such a release and every ompweb (pre)release re-pins to the newest `integration-release` build; the omp row follows ompweb; integration-ci's omp process is deleted.

**Spec:** `docs/specs/2026-11-12-omp-build-in-ompweb-design.md` (F1–F8, W1–W3, cleanup). Read it first. Open questions Q1–Q4 there; tasks use the spec's defaults and say where an answer changes them.

**Places:** integration-ci (`/root/git/integration-ci`, CI reads its `main`; the script's only home), the fork (`/root/git/oh-my-pi`, remote `origin` = fork; new worktree `/root/git/oh-my-pi-fork-ci`), ompweb (base `feat/omp-runner`, #460). Sources for `fork-ci`: integration-ci at `5db42d1`.

## Global Constraints

- The fork's `main` is never committed to; `fork-ci` holds only CI files. Every fork-code checkout names its `ref` (the default branch is `fork-ci`) and sets `persist-credentials: false`.
- `permissions: {}` at workflow level; per-job grants per spec F3. `GITHUB_TOKEN` first; `OMP_FORK_TOKEN` only as the refused-for-`workflows` fallback (F3). Secrets only through `environment: omp-round`.
- Jobs that run fork code or an agent hold no write token; publishing jobs run no fork code.
- No `fork-ci` workflow has `push`, `pull_request` or `pull_request_target` triggers.
- ompweb gets no secrets, environments or new triggers.
- Keep integration-ci's pinned action SHAs and comment style. Commit titles: integration-ci `integration: …`/`omp: …`; fork-ci `ci: …`; ompweb `feat(runner): …`, `ci(release): …`, `feat(hosts): …`.

## Review Focus

1. Upstream's workflows never see the round's secrets (Environment limited to `fork-ci`) and are disabled within an hour of appearing. (Tasks 4, 5)
2. A finished round does not retrigger; a push to one carried PR branch triggers the next; a failed round with an open issue for the same inputs is not retried hourly. (Tasks 3, 5)
3. A push refused for the `workflows` permission retries with `OMP_FORK_TOKEN`; every other write uses `GITHUB_TOKEN`. (Tasks 2, 5)
4. Prune never deletes the release ompweb `main` pins. (Task 6)
5. An ompweb pre-release ships the build `integration-release` names, with no secret; `ompweb-omp --version` prints a plain semver; the omp row has no update button. (Tasks 9–11)

---

### Task 1: spike — Bun overrides to tarball URLs (scratch, nothing committed)

- [ ] `npm pack` `@oh-my-pi/pi-coding-agent@18.19.0`, every `@oh-my-pi/*` it depends on transitively, and `@oh-my-pi/pi-natives-linux-x64@18.19.0` into `/tmp/spike/pkgs`; serve with `python3 -m http.server`.
- [ ] Copy ompweb `runner/` to `/tmp/spike/runner`; drop `patchedDependencies`; `overrides` map each `@oh-my-pi/*` to `http://127.0.0.1:<port>/<tgz>`; `bun install`.
- [ ] Verify: `bun.lock` has the URLs with integrity for transitive entries; one copy of each in `node_modules/@oh-my-pi`; `bun scripts/build-binary.ts linux-x64` resolves everything (only `runSessionHost` type errors expected).
- [ ] If transitive overrides do not take, Task 9 uses spec W1's fallback; note it in the spec.

### Task 2: spike — what `GITHUB_TOKEN` may write (scratch repository)

- [ ] Ask the user for a throwaway public repository (e.g. `andrebrait/token-spike`, deleted afterwards) with Actions on. Commit a workflow `spike.yml` (`workflow_dispatch`, `contents: write`) and a second workflow file `x.yml`; branch `old` at that commit; `main` gets a commit changing `x.yml`.
- [ ] Dispatch `spike.yml`; with `GITHUB_TOKEN` it tries: (a) `git push --force origin main:old` (diff touches `.github/workflows`), (b) `gh api -X PATCH repos/$R/git/refs/heads/old -f sha=<main> -F force=true`, (c) `gh release create t1 --target <main sha>` (new tag on a commit whose tree differs from the default branch in workflows), (d) a push whose diff touches no workflow file. Record which are refused and the exact error text.
- [ ] Write the result into spec F3 (replace the [INFERENCE]) and drop the PAT fallback from any path that was never refused. Use the error text as the fallback's match in Task 5.

### Task 3: integration-ci — `heads` and `CI_CONFIG_REF` (spec F5, F8)

**Files:** `integration`, `integration.test.sh`.

- [ ] `integration heads`: one `<pr>\t<branch>\t<sha>` per `pr_rows base` row, sha from `gh api repos/<fork slug>/branches/<branch> --jq .commit.sha`, sorted by PR; documented in the header.
- [ ] `ci_build`: fetch and diff against `${CI_CONFIG_REF:-origin/main}` (split into remote and branch for the fetch) instead of the hard-coded `origin main`; the error message names the ref.
- [ ] Tests (gh stubbed): `heads` rows honour `SKIP_PRS` and `EXTRA_PRS`; `CI_CONFIG_REF` diff passes against that ref and fails against a stale one.
- [ ] Verify: `bash integration.test.sh`. Commit `integration: list carried PR heads; compare the config against CI_CONFIG_REF`; push `main` (today's round is unaffected).

### Task 4: the `fork-ci` branch content

**Files (new orphan branch `fork-ci`, worktree `/root/git/oh-my-pi-fork-ci`):** copy from integration-ci `.github/workflows/{omp-auto,omp,publish}.yml`, `.github/actions/{omp-agent,omp-round}/`, `config/root--git--oh-my-pi.sh`, `config/fixups/root--git--oh-my-pi/*.patch` (without `18668-*`), `prompts/omp-repair.md`, `scripts/{collect-round,commit-fixups,publish-round,push-rebased}.sh`; create `.github/workflows/fork-guard.yml`, `README.md`.

- [ ] `git -C /root/git/oh-my-pi worktree add --orphan -b fork-ci /root/git/oh-my-pi-fork-ci`; copy the files keeping their paths.
- [ ] Config (spec F4): `EXTRA_PRS='7851=carry/pr-7851'` (18646 comment line removed); `SKIP_PRS='18668'` with a one-line why; ten `packages/coding-agent/test/rpc-*.test.ts` removed; "Carried PR #18646" comment and its `TEST_CMD+=` line deleted; "and host RPC contracts" removed; `CI_REPO=andrebrait/oh-my-pi`, `CI_WORKFLOW=omp.yml`, `CI_CONFIG_REF=origin/fork-ci`; the config header comment names `fork-ci`.
- [ ] `fork-guard.yml` (spec F2): `schedule` `0 5 * * *` and `workflow_dispatch`; `permissions: actions: write`; lists workflows via the API and `gh workflow disable`s each active one whose `path` is not a file in this checkout of `fork-ci`. Q2: if the user keeps some upstream workflows, list their paths in an `ALLOW` variable here.
- [ ] `README.md`: what `fork-ci` is; never merge it; sync `main` only with `integration` or `gh repo sync andrebrait/oh-my-pi -b main`; PRs inside the fork need `--base main`.
- [ ] `prompts/omp-repair.md` and script comments: `andrebrait/integration-ci` → the fork's `fork-ci`; the script lives at `tools/integration`; fixups commit to `fork-ci`.
- [ ] Verify: `source config/root--git--oh-my-pi.sh; grep -c 'rpc-' <<<"$TEST_CMD"` prints `0`; `bash -n scripts/*.sh`. Commit `ci: the omp integration round, moved from integration-ci` (not pushed until Task 7).

### Task 5: `fork-ci` workflows adapted (spec F1, F3, F5, F7)

**Files:** `.github/workflows/omp-auto.yml`, `.github/workflows/omp.yml`, `.github/actions/omp-round/action.yml`, `scripts/{push-rebased,publish-round,commit-fixups}.sh` on `fork-ci`.

- [ ] `on:`: `workflow_dispatch` only for now (Task 12 restores `schedule`). `env: FORK: ${{ github.repository }}`.
- [ ] Checkouts in every job: the fork's code with `ref: main` (or the tag/sha the job already uses); `ref: fork-ci`, `path: ci`; `repository: andrebrait/integration-ci`, `ref: main`, `path: tools`, sparse `integration changelog-merge`. `ci/integration` → `tools/integration`.
- [ ] Jobs that read `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `OMP_FORK_TOKEN` declare `environment: omp-round`.
- [ ] Tokens (spec F3): publishing steps use `GITHUB_TOKEN` (`contents: write`); `push-rebased.sh`, `publish-round.sh` and the `integration-release` move push with it and, only on Task 2's refusal text, retry once with `OMP_FORK_TOKEN` (`TOKEN_FALLBACK` env). `commit-fixups.sh`: refuse paths outside `config/fixups/root--git--oh-my-pi/`, push `HEAD:fork-ci` with `GITHUB_TOKEN`.
- [ ] `detect` (spec F5): first the F2 disable step (`actions: write`); then current inputs (`tools/integration heads` with the `INTEGRATION_*` envs `rebase` uses) vs released inputs (base tag and `Squashed from … (<sha>)` per squash of `integration-release`, mapped by the `PR #N` subject); equal → skip; open `omp-auto` issue whose body contains `inputs: <sha256>` → skip; `force`/`candidate` bypass. Output `inputs`. The "release for this tag exists" check goes.
- [ ] `escalate`: `GH_TOKEN: ${{ github.token }}`, `permissions: { issues: write, actions: read }`, issues on `$GITHUB_REPOSITORY`; body adds `inputs: <sha256>`.
- [ ] `release`: `GITHUB_TOKEN` with `contents: write` (tag creation per Task 2), notes and assets as today.
- [ ] Verify: `actionlint .github/workflows/*.yml`; `grep -rn 'integration-ci' .github scripts prompts` shows only the `tools` checkout and history notes. Commit `ci: run the round from the fork with its own token`.

### Task 6: `pack` and tarball assets (spec F6)

**Files:** `.github/workflows/omp.yml`, `.github/workflows/omp-auto.yml` on `fork-ci`.

- [ ] `omp.yml` job `pack` (needs `natives`; `contents: read`; fork code at `inputs.sha`): `./.github/actions/bun-install`; `natives-*` into `packages/natives/native`; pack public packages as `scripts/ci-release-publish.ts` does without publishing (its `--dry-run` if it leaves tarballs, else its manifest rewrite + `bun pm pack` per package); leaves for `linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64` via `packages/natives/scripts/gen-npm-packages.ts`; `omp-packages.json`; artifact `omp-packages` (`retention-days: 7`). `publish` needs `pack`.
- [ ] `omp-auto.yml` `release`: download `omp-packages`, upload each `.tgz` and `omp-packages.json`. Prune: read the pinned tag from `gh api repos/kahme247/ompweb/contents/runner/package.json` (the `releases/download/<tag>/` segment; none → nothing extra) and skip it.
- [ ] Verify: `actionlint`. Commit `ci: attach the npm packages to each integration release`.

### Task 7: fork setup and cut-over round (operational; user is admin)

- [ ] User: Environment `omp-round` on `andrebrait/oh-my-pi`, deployment branches `fork-ci` only, secrets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OMP_FORK_TOKEN` (fine-grained, this repository, Contents + Workflows write; omit if Task 2 showed no refusals).
- [ ] `git -C /root/git/oh-my-pi-fork-ci push origin fork-ci`; `gh api -X PATCH repos/andrebrait/oh-my-pi -f default_branch=fork-ci` (Q3).
- [ ] `gh release download apple-sdk -R andrebrait/integration-ci -D /tmp/sdk && gh release create apple-sdk -R andrebrait/oh-my-pi --latest=false --title "Apple SDK mirror" --notes "SHA256-named Apple SDK packages for the bazel darwin toolchain" /tmp/sdk/*.pkg`.
- [ ] `gh workflow run fork-guard.yml -R andrebrait/oh-my-pi`; `gh workflow list -R andrebrait/oh-my-pi` shows only `fork-ci`'s workflows active (Q2).
- [ ] `gh workflow disable omp-auto.yml -R andrebrait/integration-ci`.
- [ ] `gh workflow run omp-auto.yml -R andrebrait/oh-my-pi -f force=true`; watch (cold bazel cache, up to ~2 h). Expected: a promoted release listing #19075 and neither #18646 nor #18668, with `omp-packages.json` and the `.tgz` files; no `OMP Nix` run on its tag.

### Task 8: host rewiring and `/opt/omp-patched` (spec F8)

- [ ] Replace the `~/.config/integration` symlink with a directory: per-file symlinks into `/root/git/integration-ci/config` for every file and fixups dir there except the omp ones; `root--git--oh-my-pi.sh` → `/root/git/oh-my-pi-fork-ci/config/root--git--oh-my-pi.sh`, `fixups/root--git--oh-my-pi` → `/root/git/oh-my-pi-fork-ci/config/fixups/root--git--oh-my-pi`. Keep the `.retired-*` dirs linked.
- [ ] `cd /root/git/oh-my-pi && git fetch origin && git branch -f integration origin/integration-release && integration build && integration deploy`; `readlink /opt/omp-patched/current` names the release sha; `/opt/omp-patched/current/omp --version` runs.
- [ ] `integration build` for graphify, superpowers and ompweb still finds its config (`integration prs` dry check in each repo).

### Task 9: ompweb — runner against the fork release (spec W1)

**Files:** `runner/package.json`, `runner/bun.lock`; delete `runner/patches/`; create `runner/scripts/use-omp-build.ts`; doc comment in `runner/scripts/build-binary.ts`; pin paragraph in `docs/specs/2026-11-12-omp-runner-design.md`.

- [ ] `use-omp-build.ts <tag>`: fetch the release's `omp-packages.json`; set the overrides (or Task 1's fallback); drop stale `@oh-my-pi/*` overrides and `patchedDependencies`; write `package.json`; `bun install` in `runner/`; fail when a `@oh-my-pi/*` dependency has no entry.
- [ ] Run it with Task 7's tag; delete `runner/patches/`; `bun x tsc -p runner`, `bun test` in `runner/`, `bun runner/scripts/build-binary.ts linux-x64`, `runner/release/ompweb-omp-linux-x64 --version` (plain semver) and `--smoke-test` pass.
- [ ] Verify: Verify PR and `omp-runner.yml` green; `integration build-sha <sha>` with the ompweb config builds in integration-ci's `ompweb.yml`.
- [ ] Commit `feat(runner): compile ompweb-omp against the omp integration build`.

### Task 10: ompweb — (pre)releases re-pin to `integration-release` (spec W2)

**Files:** `.github/workflows/prerelease.yml`, `.github/workflows/publish.yml`.

- [ ] Before `Build the release binaries` in both: resolve `sha` and `tag` (spec W2, `GH_TOKEN: ${{ github.token }}`); no matching release → fail with a clear message (Q1: if the answer is fall back, keep the committed pin and add a notes line instead); `npx bun runner/scripts/use-omp-build.ts "$tag" && (cd runner && npx bun x tsc -p .)`; export `OMP_TAG`.
- [ ] Notes: prerelease `--notes` and the draft release notes gain `omp: andrebrait/oh-my-pi $OMP_TAG`.
- [ ] Verify: `actionlint`; after merge, the next pre-release's notes name the current `integration-release` tag and its `ompweb-omp --version` runs.
- [ ] Commit `ci(release): ship the newest omp integration build with every release`. Open PR B (Tasks 9–10).

### Task 11: ompweb — the omp row follows ompweb (spec W3)

**Files:** `lib/omp/updates.ts`, `lib/self-update.ts`, `app/api/omp-update/route.ts`, `lib/hosts/update-types.ts`, `lib/hosts/updates.ts`, `lib/hosts/daemon.ts`, `components/HostUpdates.tsx`, the Settings omp update card and its i18n keys (en, ja, zh-CN, zh-TW); tests `lib/hosts/updates.test.mjs`, `lib/hosts/host-updates-route.test.mjs`, `lib/self-update.test.mjs`, `components/SettingsConfig.updates.test.mjs`; `CHANGELOG.md`.

- [ ] Before editing, `xd://lsp` references for `checkOmpUpdate`, `runOmpUpdate`, `HostUpdateTarget`, `OmpUpdateStatus` and the `omp` `Kind`; add any caller missing above.
- [ ] Implement spec W3. Tests: `omp` target rejected; no omp `canUpdate`; Settings card has no update button. Delete tests of removed behaviour.
- [ ] Verify: `npm run typecheck`, `npm run lint`, `bun test --parallel lib/hosts lib/self-update.test.mjs components/SettingsConfig.updates.test.mjs`.
- [ ] CHANGELOG: "omp updates with ompweb: the omp row no longer runs `omp update`." Commit `feat(hosts): omp updates with ompweb`. Open PR C.

### Task 12: schedule

- [ ] On `fork-ci`: restore `schedule: - cron: "17 * * * *"` in `omp-auto.yml` (Q4: if the user wants the keep-alive, add the monthly no-op commit step to `fork-guard.yml`). Commit `ci: run the round hourly`; push.
- [ ] Next scheduled run: `detect` skips (inputs unchanged since Task 7).

### Task 13: integration-ci cleanup (after one green scheduled fork round and one green ompweb pre-release)

- [ ] Branch in `/root/git/integration-ci`: delete the files listed in the spec's cleanup section; superseded line in `docs/specs/2026-11-11-omp-auto-integration-design.md`; trim README's oh-my-pi section; `bash integration.test.sh` passes. Merge to `main`.
- [ ] `gh release delete oh-my-pi -R andrebrait/integration-ci --cleanup-tag --yes`; same for `apple-sdk`; `gh secret delete` `OMP_FORK_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` there if no remaining workflow references them (`grep -rn 'secrets\.' .github`).
- [ ] Host: the `~/.config/integration` per-file symlinks for removed integration-ci omp files are already gone (Task 8); `integration build` for graphify/superpowers/ompweb still works.

## Rollback

Spec "Rollout and rollback": before Task 13, `gh api -X PATCH repos/andrebrait/oh-my-pi -f default_branch=main`, `gh workflow enable omp-auto.yml -R andrebrait/integration-ci`, restore the `~/.config/integration` symlink, copy new `fork-ci` fixups back to integration-ci. ompweb PRs B and C revert independently.
