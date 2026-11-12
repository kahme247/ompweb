#!/usr/bin/env bun
/**
 * Compiles `src/cli.ts` into a standalone `ompweb-omp-<os>-<arch>` binary under `release/`, the way
 * omp 18.19.0 builds its release binaries (`scripts/ci-release-build-binaries.ts` and
 * `packages/coding-agent/scripts/compile-binary.ts` upstream). Those helpers assume the monorepo
 * (addons under `packages/natives/native`, docs and the stats client generated in place), so this
 * script feeds the same `Bun.build` the prebuilt equivalents the npm packages ship.
 *
 * Usage: `bun scripts/build-binary.ts [target...]`; with no target it builds the host's.
 * A cross target needs its addon package installed: `bun install --os=<os> --cpu=<cpu>`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { createJsonParsePlugin } from "../node_modules/@oh-my-pi/pi-coding-agent/scripts/json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "../node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module";
import { rpcModeSwap } from "../src/rpc-mode-swap";

interface Target {
	/** Native addon platform tag (`process.platform`). */
	readonly platform: string;
	readonly arch: string;
	readonly bun: Bun.Build.CompileTarget;
	readonly outName: string;
}

// The five targets omp's release ships to glibc/macOS/Windows users.
const TARGETS: Record<string, Target> = {
	"linux-x64": { platform: "linux", arch: "x64", bun: "bun-linux-x64-baseline", outName: "ompweb-omp-linux-x64" },
	"linux-arm64": { platform: "linux", arch: "arm64", bun: "bun-linux-arm64", outName: "ompweb-omp-linux-arm64" },
	"darwin-x64": { platform: "darwin", arch: "x64", bun: "bun-darwin-x64", outName: "ompweb-omp-darwin-x64" },
	"darwin-arm64": { platform: "darwin", arch: "arm64", bun: "bun-darwin-arm64", outName: "ompweb-omp-darwin-arm64" },
	"windows-x64": {
		platform: "win32",
		arch: "x64",
		bun: "bun-windows-x64-baseline",
		outName: "ompweb-omp-windows-x64.exe",
	},
};

/** Never bundled: omp installs them on demand at runtime (upstream `COMPILED_EXTERNAL_DEPENDENCIES`). */
const EXTERNAL = ["@huggingface/transformers", "fastembed", "onnxruntime-node"];
const ADDON_ZSTD_LEVEL = 19;

const runnerDir = path.resolve(import.meta.dir, "..");

function packageDir(name: string, from: string): string {
	// Every package here maps `.` to a file one level below its root (`src/index.ts`, `native/index.js`).
	return path.dirname(path.dirname(Bun.resolveSync(name, from)));
}

const codingAgentDir = packageDir("@oh-my-pi/pi-coding-agent", runnerDir);
const nativesDir = await fs.realpath(path.join(packageDir("@oh-my-pi/pi-natives", runnerDir), "native"));
const statsDir = await fs.realpath(packageDir("@oh-my-pi/omp-stats", codingAgentDir));

async function readVersion(manifestPath: string): Promise<string> {
	const manifest: unknown = await Bun.file(manifestPath).json();
	if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
		throw new Error(`${manifestPath} has no version`);
	}
	return String(manifest.version);
}

/**
 * Replaces pi-natives' null `embedded-addon.js` with a manifest pointing at one zstd frame per addon
 * variant, which the loader extracts on first run (upstream `natives/scripts/embed-native.ts`).
 */
async function embeddedAddonFiles(target: Target): Promise<Record<string, string | Uint8Array>> {
	const platformTag = `${target.platform}-${target.arch}`;
	const leafPackage = `@oh-my-pi/pi-natives-${platformTag}`;
	let leafManifest: string;
	try {
		leafManifest = Bun.resolveSync(`${leafPackage}/package.json`, nativesDir);
	} catch (error) {
		throw new Error(
			`${leafPackage} is not installed; run \`bun install --os=${target.platform} --cpu=${target.arch}\``,
			{ cause: error },
		);
	}
	const version = await readVersion(path.join(nativesDir, "..", "package.json"));
	const leafVersion = await readVersion(leafManifest);
	if (leafVersion !== version) throw new Error(`${leafPackage}@${leafVersion} does not match pi-natives@${version}`);

	const leafDir = path.dirname(leafManifest);
	const candidates =
		target.arch === "x64"
			? [
					{ variant: "modern", filename: `pi_natives.${platformTag}-modern.node` },
					{ variant: "baseline", filename: `pi_natives.${platformTag}-baseline.node` },
				]
			: [{ variant: "default", filename: `pi_natives.${platformTag}.node` }];
	const present = new Set(await fs.readdir(leafDir));
	const available = await Promise.all(
		candidates
			.filter(candidate => present.has(candidate.filename))
			.map(async candidate => ({ ...candidate, bytes: await Bun.file(path.join(leafDir, candidate.filename)).bytes() })),
	);
	if (available.length === 0) throw new Error(`${leafPackage} has no pi_natives addon in ${leafDir}`);

	const frames = await Promise.all(available.map(({ bytes }) => Bun.zstdCompress(bytes, { level: ADDON_ZSTD_LEVEL })));
	const imports = available.map(
		({ filename }, index) => `import zstdPath${index} from ${JSON.stringify(`./${filename}.zst`)} with { type: "file" };`,
	);
	const files = available.map(
		({ variant, filename, bytes }, index) =>
			`{ variant: ${JSON.stringify(variant)}, filename: ${JSON.stringify(filename)}, size: ${bytes.length}, zstdPath: zstdPath${index} }`,
	);
	const overrides: Record<string, string | Uint8Array> = {
		[path.join(nativesDir, "embedded-addon.js")]: `${imports.join("\n")}
export const embeddedAddon = {
	platformTag: ${JSON.stringify(platformTag)},
	version: ${JSON.stringify(version)},
	files: [${files.join(", ")}],
};
`,
	};
	available.forEach(({ filename }, index) => {
		overrides[path.join(nativesDir, `${filename}.zst`)] = frames[index];
	});
	return overrides;
}

/** The `omp stats` dashboard as the base64 gzip tar omp-stats serves when compiled (upstream `gen:stats`). */
async function embeddedStatsClient(): Promise<Record<string, string>> {
	const clientDir = path.join(statsDir, "dist", "client");
	const entries: Record<string, Uint8Array> = {};
	for await (const file of new Bun.Glob("**/*").scan({ cwd: clientDir, onlyFiles: true })) {
		entries[file.split(path.sep).join("/")] = await Bun.file(path.join(clientDir, file)).bytes();
	}
	if (!entries["index.html"]) throw new Error(`omp-stats ships no dashboard in ${clientDir}`);
	const archive = Bun.gzipSync(await new Bun.Archive(entries).bytes(), { level: 9 });
	return { [path.join(statsDir, "src", "embedded-client.generated.txt")]: Buffer.from(archive).toString("base64") };
}

async function build(id: string, target: Target, statsClient: Record<string, string>, docsEmbed: string): Promise<void> {
	const outfile = path.join(runnerDir, "release", target.outName);
	console.log(`Building ${path.relative(runnerDir, outfile)}...`);
	const output = await Bun.build({
		entrypoints: [path.join(runnerDir, "src", "cli.ts")],
		root: runnerDir,
		external: EXTERNAL,
		files: { ...(await embeddedAddonFiles(target)), ...statsClient },
		define: {
			"process.env.PI_COMPILED": JSON.stringify("true"),
			"process.env.PI_DOCS_EMBED": JSON.stringify(docsEmbed),
		},
		format: "esm",
		bytecode: true,
		splitting: true,
		// Upstream's `chunks/[name]-[hash]` collides here: type-only modules from different packages
		// (`pi-tui/src/render/types.ts`, `pi-coding-agent/src/dap/types.ts`) emit identical chunks.
		naming: { chunk: "chunks/[dir]/[name]-[hash].[ext]" },
		minify: { identifiers: true, keepNames: true },
		plugins: [rpcModeSwap, createJsonParsePlugin(), await createLegacyPiVirtualModulePlugin()],
		compile: {
			execArgv: [`--user-agent=${USER_AGENT}`],
			target: target.bun,
			outfile,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
		},
		throw: false,
	});
	if (!output.success) throw new Error(`${id}: bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	// shortcut: darwin binaries carry only Bun's built-in ad-hoc signature (no hardened runtime, no
	// entitlements); add omp's Developer ID signing step before distributing outside our own machines.
}

const hostId = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const ids = process.argv.length > 2 ? process.argv.slice(2) : [hostId];
for (const id of ids) {
	if (!TARGETS[id]) throw new Error(`unknown target ${id}; expected one of ${Object.keys(TARGETS).join(", ")}`);
}
// npm packs the docs corpus the compiled binary would otherwise embed from the monorepo's `docs/`.
const docsEmbed = (await Bun.file(path.join(codingAgentDir, "dist", "docs-index.generated.txt")).text()).trimEnd();
const statsClient = await embeddedStatsClient();
for (const id of ids) await build(id, TARGETS[id], statsClient, docsEmbed);
