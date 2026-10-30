# Contributing to omp-web

Thanks for your interest in contributing!

## Setup

- Node.js 24 or newer (the server runs on [Bun](https://bun.sh), which `npm install` provides)
- The [omp](https://github.com/can1357/oh-my-pi) binary on your `PATH` (or set `OMP_WEB_OMP_BIN`)

```bash
npm install
npm run dev   # http://127.0.0.1:30178, Bun hot reload
```

## Checks (must pass before submitting)

```bash
npm run typecheck                                  # type check
npm run lint                                       # ESLint, zero warnings
npm test                                           # unit tests (bun test --parallel)
```

`npm run build` bundles the browser app into `dist/` and `npm run smoke`
starts the built server and checks it; the dev server never reads `dist/`.

### React tests

Tests use `bun test` with `node:test`-style `test()` calls; no Jest or Vitest configuration is required.
Mock a Node builtin with `mockBuiltin` (`tests/mock-builtin.mjs`, built on `mock.module`) and import the module under test afterwards with a fresh `?fresh=N` query.
For interactive components and hooks, import `tests/setup-dom.mjs` before
`@testing-library/react/pure.js` (both imported dynamically, in that order), and register `cleanup` with `afterEach`.
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
- **i18n**: every user-facing string needs entries in all three dictionaries:
  `lib/i18n/locales/{en,zh-CN,ja}.json`.
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
