import packageJson from "../package.json";
import { homedir } from "os";
import { join, normalize, sep } from "path";

const NPM_PACKAGE = "@kahme247/ompweb";
const CHECK_TTL_MS = 60 * 60 * 1000;

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

let cached: { checkedAt: number; status: NpmUpdateStatus } | null = null;

function parseVersion(version: string): { parts: number[]; prerelease: boolean } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
}

export function isNewerVersion(availableVersion: string, currentVersion: string): boolean {
  const available = parseVersion(availableVersion);
  const current = parseVersion(currentVersion);
  if (!available || !current) return false;
  if (available.prerelease) return false;

  for (let index = 0; index < available.parts.length; index += 1) {
    if (available.parts[index] !== current.parts[index]) {
      return available.parts[index] > current.parts[index];
    }
  }
  return !available.prerelease && current.prerelease;
}

export async function checkNpmUpdate(force = false): Promise<NpmUpdateStatus> {
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.status;

  const currentVersion = packageJson.version;
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const method = detectInstallMethod(packageDir);
  const updateCommand = method === "bun" ? "bun add -g @kahme247/ompweb" : "npm install -g @kahme247/ompweb";

  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const data = response.ok ? await response.json() as { version?: unknown } : null;
    const availableVersion = typeof data?.version === "string" ? data.version : null;
    const status: NpmUpdateStatus = {
      currentVersion,
      availableVersion,
      updateAvailable: Boolean(availableVersion && isNewerVersion(availableVersion, currentVersion)),
      updateCommand,
    };
    cached = { checkedAt: Date.now(), status };
    return status;
  } catch {
    return { currentVersion, availableVersion: null, updateAvailable: false, updateCommand };
  }
}

/** Which package manager owns a given install dir, so updates always run
 * through the manager that manages it (bun global root, npm global root,
 * anything else → npm as the fallback). Separators are normalized so the
 * classification is deterministic even when a Windows-style path is passed
 * on a POSIX host (e.g. in CI tests). */
export function detectInstallMethod(packageDir: string): "bun" | "npm" {
  const toPlatformPath = (value: string): string => normalize(value).replaceAll("\\", sep);
  const normalized = toPlatformPath(packageDir);
  const bunRoots = [
    // bun 1.3.x globals on Windows live in ~/node_modules; POSIX uses the
    // standard ~/.bun/install/global/node_modules.
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", "node_modules"),
    join(homedir(), ".bun", "install", "global", "node_modules"),
  ].map(toPlatformPath);
  return bunRoots.some((root) => normalized.startsWith(root + sep)) ? "bun" : "npm";
}

