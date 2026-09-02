import path, { normalize } from "path";
import { realpathSync } from "fs";

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export function sessionPathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === "win32" ? path.win32.normalize(filePath) : path.posix.normalize(filePath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function projectIdentityKey(projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  return normalizeForComparison(projectRoot, platform);
}

/** Convert paths emitted by git to the host's native separator style. */
export function toNativePath(value: string): string {
  if (!value || process.platform !== "win32") return value;
  return normalize(value);
}

export function normalizeForComparison(value: string, platform: NodeJS.Platform = process.platform): string {
  if (!value) return value;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const nativeValue = platform === "win32" ? pathApi.normalize(toNativePath(value)) : value;
  const normalized = pathApi.normalize(nativeValue);
  const rootLength = pathApi.parse(normalized).root.length;
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === pathApi.sep) end--;
  const withoutTrailing = normalized.slice(0, end);
  return platform === "win32" ? withoutTrailing.toLowerCase() : withoutTrailing;
}

export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (normalizeForComparison(a) === normalizeForComparison(b)) return true;
  if (process.platform === "win32") {
    try {
      const realA = realpathSync.native ? realpathSync.native(a) : realpathSync(a);
      const realB = realpathSync.native ? realpathSync.native(b) : realpathSync(b);
      return normalizeForComparison(realA) === normalizeForComparison(realB);
    } catch {
      return false;
    }
  }
  return false;
}
