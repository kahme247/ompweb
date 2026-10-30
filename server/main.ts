// Production entry: `bin/omp-web.js` spawns `bun server/main.ts -p <port> -H <host>` and waits for the Ready line.
// Set before the dynamic import below, since modules read NODE_ENV when they load (`next start` forced production too).
Object.assign(process.env, { NODE_ENV: "production" });

const { parseListenArgs, startProduction } = await import("./app");
await startProduction(parseListenArgs(Bun.argv.slice(2), 30177));

export {}; // a module, for top-level await
