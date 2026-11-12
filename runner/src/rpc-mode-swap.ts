import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BunPlugin } from "bun";

/** The no-model exit in `runRootCommand`, which every `--mode` launch hits (`main.ts`). */
const NO_MODEL_EXIT = "if (!isInteractive && !session.model) {";

/**
 * Makes omp's `--mode rpc-ui` startup end in ompweb's headless runner (see `headless.ts`):
 *   - loads `headless.ts` wherever omp imports RPC's server module (`modes/rpc/rpc-mode.ts`);
 *   - lets that startup go on without a model, as the TUI does, so a user who is not logged in
 *     can open a session and log in from ompweb. ompweb-omp accepts rpc-ui only with `--headless`.
 * Registered at runtime by `--headless` from source, and by `scripts/build-binary.ts` for the
 * compiled binary, whose bundled modules a runtime plugin cannot reach. Kept free of omp imports
 * for the build script.
 */
export const rpcModeSwap: BunPlugin = {
	name: "ompweb-rpc-mode-swap",
	setup(build) {
		const headless = JSON.stringify(path.join(import.meta.dir, "headless.ts"));
		build.onLoad({ filter: /[\\/]pi-coding-agent[\\/]src[\\/]modes[\\/]rpc[\\/]rpc-mode\.ts$/ }, () => ({
			contents: `export { runRpcMode } from ${headless};`,
			loader: "ts",
		}));
		build.onLoad({ filter: /[\\/]pi-coding-agent[\\/]src[\\/]main\.ts$/ }, async args => {
			const source = await fs.readFile(args.path, "utf8");
			// Fail the load, not the user's session, when an omp bump moves the check.
			if (!source.includes(NO_MODEL_EXIT)) throw new Error(`ompweb: ${args.path} no longer has the no-model exit to lift`);
			return {
				contents: source.replace(NO_MODEL_EXIT, 'if (!isInteractive && mode !== "rpc-ui" && !session.model) {'),
				loader: "ts",
			};
		});
	},
};
