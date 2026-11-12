import packageJson from "../package.json";
import { isUpdateDisabled } from "./update-policy";
import { isNewerVersion } from "./version-compare";
import { homedir } from "os";
import { join, normalize, sep } from "path";

const NPM_PACKAGE = "@kahme247/ompweb";
const RELEASES_URL = "https://github.com/kahme247/ompweb/releases/latest";
const CHECK_TTL_MS = 60 * 60 * 1000;

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  /** "binary": the compiled release (scripts/build-binary.ts), which updates by download, not by a package manager. */
  installMethod: "npm" | "bun" | "binary";
  /** The terminal command that updates this install; for "binary", the release download page. */
  updateCommand: string;
  updatesDisabled?: boolean;
}

let cached: { checkedAt: number; status: NpmUpdateStatus } | null = null;

export async function checkNpmUpdate(force = false): Promise<NpmUpdateStatus> {
  const currentVersion = packageJson.version;
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const installMethod = typeof Bun !== "undefined" && Bun.isStandaloneExecutable ? "binary" : detectInstallMethod(packageDir);
  const updateCommand = installMethod === "binary" ? RELEASES_URL : installMethod === "bun" ? "bun add -g @kahme247/ompweb" : "npm install -g @kahme247/ompweb";

  if (isUpdateDisabled()) {
    return { currentVersion, availableVersion: null, updateAvailable: false, installMethod, updateCommand, updatesDisabled: true };
  }
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.status;

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
      installMethod,
      updateCommand,
    };
    cached = { checkedAt: Date.now(), status };
    return status;
  } catch {
    return { currentVersion, availableVersion: null, updateAvailable: false, installMethod, updateCommand };
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

