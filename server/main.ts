// Production entry: `bin/omp-web.js` spawns `bun server/main.ts -p <port> -H <host>` and waits for the Ready line.
// Set before the dynamic imports below, since modules read NODE_ENV when they load (`next start` forced production too).
Object.assign(process.env, { NODE_ENV: "production" });

const root = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
const { parseListenArgs, startServer } = await import("./app");
const listen = parseListenArgs(Bun.argv.slice(2), 30177);
let server: Bun.Server<undefined>;
try {
  server = startServer({ ...listen, dev: false, root });
} catch (error) {
  // The launcher checks the port first, but another process can take it before this bind.
  if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
  console.error(`Port ${listen.port} on ${listen.hostname} is already in use: is ompweb already running? Otherwise stop the process using it or start ompweb with --port ${listen.port + 1}.`);
  process.exit(1);
}
const { register } = await import("../instrumentation.node");
await register();
console.log(`[omp-web] Ready on ${server.url.origin}`);

export {}; // a module, for top-level await
