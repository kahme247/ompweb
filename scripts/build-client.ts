// Bundles the SPA (app/index.html) into dist/: index.html plus hashed files under dist/assets/.
import { rmSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";
import { clientEnv } from "../server/client-env";

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
// Bun moves the entry stylesheet to the end of <head>, after the pre-paint scripts. The theme script reads --bg
// from it for theme-color, and a stylesheet only blocks the scripts that follow it, so put it before them.
const indexPath = path.join(outdir, "index.html");
const html = await Bun.file(indexPath).text();
const stylesheet = /<link rel="stylesheet"[^>]*>/.exec(html)?.[0];
if (!stylesheet) throw new Error("dist/index.html has no stylesheet link");
// Without this anchor the replace below would drop the stylesheet from the page.
if (!html.includes("<script>")) throw new Error("dist/index.html has no inline <script> to put the stylesheet before");
await Bun.write(indexPath, html.replace(stylesheet, "").replace("<script>", `${stylesheet}\n    <script>`));
console.log(`built ${result.outputs.length + fonts.size} files into ${path.relative(process.cwd(), outdir) || "."}`);
