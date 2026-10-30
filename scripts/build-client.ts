// Bundles the SPA (app/index.html) into dist/: index.html plus hashed files under dist/assets/. Lists the npm packages
// in the bundle in build/client-packages.json, for the binary release's licenses (scripts/build-binary.ts).
import { rmSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";
import { bundledPackageDirs } from "./licenses";
import tailwind from "./tailwind-plugin";
import { clientEnv } from "../server/client-env";
import { stylesheetFirst } from "../server/http";

const root = path.join(import.meta.dir, "..");
const outdir = path.join(root, "dist");
rmSync(outdir, { recursive: true, force: true });

// Bun's CSS bundler inlines every url() asset under 128 KiB as a base64 data: URL and has no option to stop it
// (oven-sh/bun#24599; `loader: { ".woff2": "file" }` is ignored there). That would put ~250 KB of fonts into the
// render-blocking entry CSS, so woff2 files resolve as external /assets URLs and are copied after the build.
const fonts = new Map<string, string>();
const emitFonts: BunPlugin = {
  name: "emit-fonts",
  setup(build) {
    build.onResolve({ filter: /\.woff2$/ }, async (args) => {
      const source = path.resolve(args.resolveDir, args.path);
      const hash = Bun.hash(await Bun.file(source).arrayBuffer()).toString(36);
      const url = `/assets/${path.basename(source, ".woff2")}-${hash}.woff2`;
      fonts.set(url, source);
      return { path: url, external: true };
    });
  },
};

const result = await Bun.build({
  entrypoints: [path.join(root, "app", "index.html")],
  outdir,
  target: "browser",
  minify: true,
  metafile: true,
  splitting: true,
  sourcemap: "none",
  publicPath: "/",
  naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
  plugins: [tailwind, emitFonts],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    ...Object.fromEntries(Object.entries(clientEnv(root)).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])),
  },
  throw: false,
});

for (const log of result.logs) console.log(log);
if (!result.success) process.exit(1);
for (const [url, source] of fonts) await Bun.write(path.join(outdir, url), Bun.file(source));
const indexPath = path.join(outdir, "index.html");
await Bun.write(indexPath, stylesheetFirst(await Bun.file(indexPath).text()));
await Bun.write(path.join(root, "build", "client-packages.json"), `${JSON.stringify(bundledPackageDirs(result.metafile!, process.cwd()).map((dir) => path.relative(root, dir)), null, 2)}\n`);
console.log(`built ${result.outputs.length + fonts.size} files into ${path.relative(process.cwd(), outdir) || "."}`);
