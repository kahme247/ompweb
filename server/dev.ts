// Dev entry (`npm run dev`): API plus the SPA from Bun's HTML import with HMR, bundled in memory; never reads dist/.
import html from "../app/index.html";
import { clientEnv } from "./client-env";

declare global {
  var __ompWebRegistered: Promise<void> | undefined;
}

Object.assign(process.env, { NODE_ENV: "development" });
const root = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
// Inlined into the dev bundle through bunfig.toml's [serve.static] env.
Object.assign(process.env, clientEnv(root));
const { parseListenArgs, startServer } = await import("./app");
const server = startServer({ ...parseListenArgs(Bun.argv.slice(2), 30178), dev: true, root, html });
// `bun --hot` re-evaluates this file on every edit; register() must run once per process.
globalThis.__ompWebRegistered ??= import("../instrumentation.node").then(({ register }) => register());
await globalThis.__ompWebRegistered;
console.log(`[omp-web] Ready on ${server.url.origin}`);
