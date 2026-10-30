// Probe 11b: one binary with API + embedded SPA (Tailwind + next/* shims applied at compile time).
import tailwind from "/tmp/bunspike/deps/node_modules/bun-plugin-tailwind/index.mjs";
import path from "path";
import shimPlugin from "./shim-plugin";

const t0 = performance.now();
const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "server-full.ts")],
  compile: { outfile: "/tmp/bunspike/omp-web-full" },
  target: "bun",
  minify: true,
  throw: false,
  plugins: [tailwind, shimPlugin],
  define: {
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("spike"),
    "process.env.NEXT_PUBLIC_OMP_WEB_VERSION": JSON.stringify("spike"),
    "process.env.NEXT_PUBLIC_EVENT_STREAM_WORKER_VERSION": JSON.stringify("spike"),
  },
});
console.log(`compile ${result.success ? "OK" : "FAILED"} in ${(performance.now() - t0).toFixed(0)}ms`);
for (const log of result.logs) if (!log.message.startsWith("Duplicate key")) console.log(`  [${log.level}] ${log.message}`);
