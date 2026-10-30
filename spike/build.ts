// Probe 9: bundle the SPA with Bun's bundler + Tailwind 4 plugin. SPIKE_SHIMS=1 aliases next/* to spike/shims.
import tailwind from "/tmp/bunspike/deps/node_modules/bun-plugin-tailwind/index.mjs";
import path from "path";
import shimPlugin from "./shim-plugin";

const shims = process.env.SPIKE_SHIMS === "1";
const t0 = performance.now();
const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "index.html")],
  outdir: path.join(import.meta.dir, "dist"),
  minify: true,
  splitting: true,
  naming: { chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  sourcemap: "none",
  throw: false,
  plugins: [tailwind, ...(shims ? [shimPlugin] : [])],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("spike"),
    "process.env.NEXT_PUBLIC_OMP_WEB_VERSION": JSON.stringify("spike"),
    "process.env.NEXT_PUBLIC_EVENT_STREAM_WORKER_VERSION": JSON.stringify("spike"),
  },
});
console.log(`build ${result.success ? "OK" : "FAILED"} in ${(performance.now() - t0).toFixed(0)}ms, ${result.logs.length} log entries`);
for (const log of result.logs) console.log(`  [${log.level}] ${log.message}${log.position ? ` @ ${log.position.file}:${log.position.line}` : ""}`);
const byKind: Record<string, number> = {};
for (const o of result.outputs) byKind[o.kind + ":" + path.extname(o.path)] = (byKind[o.kind + ":" + path.extname(o.path)] ?? 0) + o.size;
console.log("outputs:", result.outputs.length, Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, `${(v / 1024).toFixed(0)} KiB`])));
