#!/usr/bin/env bun
/**
 * Puts the omp npm packages the runner compiles against into `vendor/`: the `omp-packages-<version>.zip` asset of
 * one `andrebrait/oh-my-pi` integration release, which `omp-build.json` pins.
 *
 * `bun scripts/use-omp-build.ts`: fetch the pinned release's packages (then `bun install --frozen-lockfile`).
 * `bun scripts/use-omp-build.ts <tag>`: re-pin to that release: fetch it, point `omp-build.json`, the `@oh-my-pi/*`
 * dependencies and an override for every package and native leaf at it, and `bun install` (updates `bun.lock`).
 * `OMP_BUILD_RELEASES` replaces `https://github.com` as the download host, e.g. a local mirror for testing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Pin {
	repo: string;
	tag: string;
}

const runnerDir = path.resolve(import.meta.dir, "..");
const vendorDir = path.join(runnerDir, "vendor");
const pinPath = path.join(runnerDir, "omp-build.json");
const manifestPath = path.join(runnerDir, "package.json");
const TAG = /^v\d+\.\d+\.\d+-int\.\d{12}\.g[0-9a-f]{7}$/;
// Without an override per leaf, bun installs upstream's npm leaf instead and the runner embeds upstream's addon.
const LEAVES = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"].map(
	target => `@oh-my-pi/pi-natives-${target}`,
);

function run(cmd: string[]): void {
	const { exitCode } = Bun.spawnSync(cmd, { cwd: runnerDir, stdio: ["ignore", "inherit", "inherit"] });
	if (exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${exitCode}`);
}

/** Replaces `vendor/` with the release's zip contents; returns its `index.json` (npm name → tarball file). */
async function fetchBuild({ repo, tag }: Pin): Promise<Record<string, string>> {
	if (!TAG.test(tag)) throw new Error(`${tag} is not an integration release tag (v<version>-int.<stamp>.g<sha7>)`);
	const url = `${process.env.OMP_BUILD_RELEASES ?? "https://github.com"}/${repo}/releases/download/${tag}/omp-packages-${tag.slice(1)}.zip`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	await fs.rm(vendorDir, { recursive: true, force: true });
	await fs.mkdir(vendorDir);
	const zip = path.join(vendorDir, "omp-packages.zip");
	await Bun.write(zip, response);
	// Windows' bundled tar is bsdtar, which reads zip.
	run(process.platform === "win32" ? ["tar", "-xf", zip, "-C", vendorDir] : ["unzip", "-q", zip, "-d", vendorDir]);
	await fs.rm(zip);
	const index: Record<string, string> = await Bun.file(path.join(vendorDir, "index.json")).json();
	for (const [name, file] of Object.entries(index)) {
		if (!/^[\w.-]+\.tgz$/.test(file)) throw new Error(`index.json: bad file ${file} for ${name}`);
	}
	console.log(`omp packages: ${repo} ${tag} (${Object.keys(index).length} tarballs)`);
	return index;
}

const tag = process.argv[2];
if (!tag) {
	const pin: Pin = await Bun.file(pinPath)
		.json()
		.catch(error => {
			throw new Error(`${pinPath} is unreadable; pin a release with \`bun scripts/use-omp-build.ts <tag>\``, {
				cause: error,
			});
		});
	await fetchBuild(pin);
} else {
	const pin: Pin = { repo: "andrebrait/oh-my-pi", tag };
	const index = await fetchBuild(pin);
	const manifest = await Bun.file(manifestPath).json();
	const direct = Object.keys(manifest.dependencies).filter(name => name.startsWith("@oh-my-pi/"));
	const missing = [...direct, ...LEAVES].filter(name => !index[name]);
	if (missing.length > 0) throw new Error(`${tag} has no package for ${missing.join(", ")}`);
	const file = (name: string): string => `file:./vendor/${index[name]}`;
	for (const name of direct) manifest.dependencies[name] = file(name);
	manifest.overrides = { ...manifest.overrides, ...Object.fromEntries(Object.keys(index).map(name => [name, file(name)])) };
	delete manifest.patchedDependencies;
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await Bun.write(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
	run([process.execPath, "install"]);
	// Any `@oh-my-pi/*` resolved from npm instead of vendor/ is a package the release lacks.
	const fromNpm = (await Bun.file(path.join(runnerDir, "bun.lock")).text()).match(/\["@oh-my-pi\/[^"]+@(?!\.\/vendor\/)[^"]*"/g);
	if (fromNpm) throw new Error(`bun.lock resolves these from npm, not ${tag}: ${fromNpm.map(entry => entry.slice(2, -1)).join(", ")}`);
}
