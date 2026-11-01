# Contributing to omp-web

Thanks for your interest in contributing!

## Setup

- Node.js 24 or newer
- The [omp](https://github.com/can1357/oh-my-pi) binary on your `PATH` (or set `OMP_WEB_OMP_BIN`)

```bash
npm install
npm run dev   # http://127.0.0.1:30178
```

The repository tracks a [graphify](https://github.com/Graphify-Labs/graphify) code
graph in `graphify-out/graph.json`. To keep it current, install the graphify release
that built it (`uv tool install graphifyy==0.9.99`; releases build different graphs
from the same code, so bump this together with a rebuilt graph) and run
`sh scripts/setup-hooks.sh` once per clone. The script enables the tracked
`.githooks/pre-commit`, which rebuilds the graph and stages it with every commit
that stages anything else, and registers graphify's merge driver for `graph.json`.
The first commit in a new clone or worktree rebuilds from scratch (about two
minutes); later ones take about a second. Set `GRAPHIFY_SKIP_HOOK=1` to commit
without the rebuild. The rebuild reads the working tree, so unstaged code ends up in
the committed graph: to commit only part of your changes, `git stash --keep-index
--include-untracked` first. The hook refuses `git commit <path>`, whose temporary
index would leave the rebuilt graph unstaged; stage with `git add` and run a plain
`git commit`. Git runs no pre-commit hook for rebases, cherry-picks or
merges that complete without conflicts: run `PYTHONHASHSEED=0 graphify update .`
afterwards and commit the graph.

## Checks (must pass before submitting)

```bash
npx tsc --noEmit                                   # type check
npm run lint                                       # ESLint, zero warnings
npm test                                           # unit tests
```

Avoid `npm run build` during local development — it writes to `.next/` and
interferes with the dev server. Builds are for release work.

### React tests

Tests use `node:test` and `jiti`; no Jest or Vitest configuration is required.
For interactive components and hooks, import `tests/setup-dom.mjs` before
`@testing-library/react/pure.js`, and register `cleanup` with `afterEach`.
Use DOM queries and `@testing-library/user-event` for component interactions,
and `renderHook` for hook state and lifecycle tests. Keep the real jsdom
`window` and `document`; mock only the browser or network APIs a scenario needs.

Static HTML tests can continue using `react-dom/server`. Layout, scrolling,
and native browser navigation still require real-browser verification.
The jsdom dependency stays on 29.x for now; moving to a newer major is a separate change.

## Conventions

- **Styling**: use the design tokens in `app/globals.css` (colors, radius,
  shadow, motion) — no hardcoded colors. Shared primitives live in
  `components/ui/` (Dialog/Tooltip/Collapsible/field/toast, built on Base UI);
  icons come from `lucide-react`.
- **i18n**: every user-facing string needs entries in all four dictionaries:
  `lib/i18n/locales/{en,zh-CN,zh-TW,ja}.json`.
- **Architecture**: omp-web never imports `@oh-my-pi/*` or `@earendil-works/*`
  packages (Bun-only). Live agent features go through the `omp` child process
  via RPC; see `DESIGN.md` and `AGENTS.md` for the full contract.

## Pull requests

- Keep PRs focused; describe the user-visible change and how you verified it.
- For UI changes, include before/after screenshots in both light and dark
  themes when practical.

## Reporting issues

Please use the issue templates and include your OS, Node version, omp version,
and browser.
