import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import packageJson from "../../package.json";
import { releaseRepo } from "../release-repo";
import { downloadHostUpdateFile, fetchHostUpdateBytes, HOST_RELEASE_MAX_MEMBER } from "../hosts/update-worker";
import { fetchedOmpBin, OMP_RUNNER_ASSET, resolveOmpBin, sourceCheckoutOmpBin } from "./omp-cli";

// Every install gets its omp runner (ompweb-omp) from its own version's GitHub release: the asset OMP_RUNNER_ASSET,
// checked against that release's OMP_RUNNER_CHECKSUMS. Releases attach both (.github/workflows/publish.yml).
// Loaded by Node/jiti and the compiled binary: no `@/` imports.

/** The `sha256sum` listing of every runner asset a release attaches. */
export const OMP_RUNNER_CHECKSUMS = "ompweb-omp.sha256";

/** Downloads this version's runner to `target` (atomically, executable) once its SHA-256 matches the release's. */
export async function fetchOmpRunner(target = fetchedOmpBin(), version = packageJson.version): Promise<string> {
  const base = `https://github.com/${releaseRepo()}/releases/download/v${version}`;
  const url = `${base}/${OMP_RUNNER_ASSET}`;
  const partial = `${target}.${process.pid}.${Date.now()}.partial`;
  try {
    const sums = (await fetchHostUpdateBytes(`${base}/${OMP_RUNNER_CHECKSUMS}`, 64 * 1024, 30_000)).toString("utf8");
    const expected = sums.split("\n").map((line) => line.trim().split(/\s+\*?/)).find(([, name]) => name === OMP_RUNNER_ASSET)?.[0];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${OMP_RUNNER_CHECKSUMS} lists no ${OMP_RUNNER_ASSET}`);
    mkdirSync(dirname(target), { recursive: true });
    const digest = await downloadHostUpdateFile(url, partial, HOST_RELEASE_MAX_MEMBER);
    if (digest !== `sha256:${expected}`) throw new Error(`its SHA-256 is not the one ${OMP_RUNNER_CHECKSUMS} lists`);
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    return target;
  } catch (error) {
    rmSync(partial, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch ompweb's omp from ${url}: ${reason}. Check this machine's connection to GitHub, or set OMP_WEB_OMP_BIN to an ompweb-omp binary.`);
  }
}

let ensuring: Promise<string | null> | null = null;
/** The runner, fetched first when this install has none; null in a source checkout that has not built one. One fetch
 * at a time per process; a web server and a daemon fetching together each write their own partial file. */
export function ensureOmpRunner(): Promise<string | null> {
  ensuring ??= (async () => {
    const found = resolveOmpBin(true);
    if (found || process.env.OMP_WEB_OMP_BIN || sourceCheckoutOmpBin()) return found;
    await fetchOmpRunner();
    return resolveOmpBin(true);
  })().finally(() => { ensuring = null; });
  return ensuring;
}

/** `ompweb fetch-omp`: what updaters run on a candidate release before its preflight; exit 1 names what failed. */
export async function runFetchOmp(): Promise<number> {
  try {
    const bin = await ensureOmpRunner();
    if (!bin) throw new Error(process.env.OMP_WEB_OMP_BIN ? `OMP_WEB_OMP_BIN=${process.env.OMP_WEB_OMP_BIN} does not exist` : `this source checkout has no ${sourceCheckoutOmpBin()}: build it with \`bun runner/scripts/build-binary.ts\``);
    console.log(`omp: ${bin}`);
    return 0;
  } catch (error) {
    console.error(`fetch-omp failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
