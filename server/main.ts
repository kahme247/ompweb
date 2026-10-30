// Production entry: `bin/omp-web.js` spawns `bun server/main.ts -p <port> -H <host>` and waits for the Ready line.
// Set before the dynamic imports below, since modules read NODE_ENV when they load (`next start` forced production too).
Object.assign(process.env, { NODE_ENV: "production" });

const root = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
const { parseListenArgs, startServer } = await import("./app");
const server = startServer({ ...parseListenArgs(Bun.argv.slice(2), 30177), dev: false, root });
const { register } = await import("../instrumentation.node");
await register();
console.log(`[omp-web] Ready on ${server.url.origin}`);

export {}; // a module, for top-level await
