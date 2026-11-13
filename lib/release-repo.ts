import packageJson from "../package.json";

/** `owner/name` of the GitHub repository whose releases ship ompweb (binaries, the omp runner): package.json's
 * `repository`, the one place it is named. Loaded by Node/jiti and the compiled binary: no `@/` imports. */
export function releaseRepo(): string {
  const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(packageJson.repository?.url ?? "");
  if (!match) throw new Error(`package.json's repository (${packageJson.repository?.url}) is not a GitHub repository`);
  return match[1];
}
