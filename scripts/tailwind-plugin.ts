// bun-plugin-tailwind with Tailwind's color-mix() polyfill undone; scripts/build-client.ts and bunfig.toml (dev) use it.
// Tailwind follows each color-mix() that names a var() with a fallback (its first colour at full strength) and a
// nested `@supports (color: color-mix(in lab, red, red))` override; bun-plugin-tailwind 0.1.2 has no option to turn
// that off. Bun 1.4.4's CSS bundler (fixed Chrome 80 / Safari 14 targets, no browserslist) then drops an @supports rule
// that follows one with the same condition, so a rule kept only its first override and keyframes lost theirs. Every
// browser Next targeted (Chrome 111, Safari 16.4) supports color-mix(), so the source declaration is all it needs.
import type { BunPlugin, PluginBuilder } from "bun";
import tailwind from "bun-plugin-tailwind";

// Tailwind's printer: `prop: fallback;` then the override block, at the declaration's indent.
const COLOR_MIX_POLYFILL = /^( *)([\w-]+): .*;\n\1@supports \(color: color-mix\(in lab, red, red\)\) \{\n\1 {2}& \{\n\1 {4}\2: (.*);\n\1 {2}\}\n\1\}\n/gm;

const plugin: BunPlugin = {
  name: "tailwind-without-color-mix-polyfill",
  setup(build) {
    // The stock plugin's onLoad returns Tailwind's CSS; every other builder call passes through untouched.
    const onLoad: PluginBuilder["onLoad"] = (constraints, callback) =>
      build.onLoad(constraints, async (args) => {
        const result = await callback(args);
        if (result && "contents" in result && typeof result.contents === "string") {
          result.contents = result.contents.replace(COLOR_MIX_POLYFILL, "$1$2: $3;\n");
        }
        return result;
      });
    return tailwind.setup(
      new Proxy(build, {
        get(target, key) {
          if (key === "onLoad") return onLoad;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
  },
};

export default plugin;
