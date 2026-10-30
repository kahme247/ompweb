// Aliases next/dynamic and next/navigation to spike/shims (used by build.ts and the HTML-import dev server).
import path from "path";
import type { BunPlugin } from "bun";

const shimPlugin: BunPlugin = {
  name: "next-shims",
  setup(build) {
    build.onResolve({ filter: /^next\/(dynamic|navigation)$/ }, (args) => ({ path: path.join(import.meta.dir, "shims", `${args.path.slice(5)}.tsx`) }));
  },
};
export default shimPlugin;
