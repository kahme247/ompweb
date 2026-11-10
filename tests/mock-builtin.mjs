import { mock } from "bun:test";

// Replaces named exports of a Node builtin for one test. Bun's mock.restore() does not undo
// mock.module(), so the real exports go back by hand. Import the module under test after this
// call, with a fresh `?fresh=N` query, so it binds the fakes.
export async function mockBuiltin(t, name, overrides) {
  const real = { ...(await import(name)) };
  mock.module(name, () => ({ ...real, default: { ...real.default, ...overrides }, ...overrides }));
  // A block body, not `() => mock.module(...)`: with the expression form Bun 1.4.4 kept the fakes
  // in place for the rest of the file (seen with child_process).
  t.after(() => { mock.module(name, () => real); });
}
