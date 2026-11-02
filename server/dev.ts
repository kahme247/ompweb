// Dev entry (`npm run dev`): API plus the SPA from Bun's HTML import with HMR, bundled in memory; never reads dist/.
import html from "../app/index.html";
import { clientEnv } from "./client-env";

declare global {
  var __ompWebRegistered: Promise<void> | undefined;
  var __ompWebDevServer: Bun.Subprocess | undefined;
}

const root = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
const env = clientEnv(root);
if (Object.keys(env).some((name) => !process.env[name])) {
  // bunfig.toml's [serve.static] env inlines OMP_WEB_PUBLIC_* from the environment Bun started with, so setting them
  // now is too late: run once more with them set and the same flags (--hot). The guard survives a --hot re-evaluation.
  const child = (globalThis.__ompWebDevServer ??= Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  }));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  process.exit(await child.exited);
}

Object.assign(process.env, { NODE_ENV: "development" });
const { parseListenArgs, startServer } = await import("./app");
const server = startServer({ ...parseListenArgs(Bun.argv.slice(2), 30178), dev: true, root, html });
// `bun --hot` re-evaluates this file on every edit; register() must run once per process.
globalThis.__ompWebRegistered ??= import("../instrumentation.node").then(({ register }) => register());
await globalThis.__ompWebRegistered;
console.log(`[omp-web] Ready on ${server.url.origin}`);
