export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

/** The decoded catch-all segments `/api/files/[...path]` receives for a path.
 * The live file-watch channel sends the raw path instead of a URL, and the
 * server rebuilds it from these same segments so both resolve identically. */
export function filePathApiSegments(filePath: string): string[] {
  const normalized = normalizeFilePathSlashes(filePath);
  const isUnc = normalized.startsWith("//");
  const segments = normalized.split("/").filter(Boolean);
  if (isUnc && segments.length > 0) {
    // Preserve the UNC `//` prefix: folding it into the first segment
    // (encoded as %2F%2Fserver, decoded back to `//server` by the route's
    // catch-all param) keeps `isWindowsAbsolutePath` round-tripping, so
    // browsing/reading UNC-rooted workspaces keeps working.
    segments[0] = `//${segments[0]}`;
  }
  return segments;
}

export function encodeFilePathForApi(filePath: string): string {
  return filePathApiSegments(filePath).map(encodeURIComponent).join("/");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (lastSlash === 2 && /^[a-zA-Z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  // NTFS is case-insensitive: the session header may store the cwd with
  // different casing than the realpath'd file path (drive letter or directory
  // case), and a case-sensitive prefix match would wrongly fall back to the
  // absolute path — breaking the breadcrumb and @-mention line links.
  const windowsPaths = /^[a-zA-Z]:\//.test(normalizedFile) || normalizedFile.startsWith("//")
    || /^[a-zA-Z]:\//.test(normalizedCwd) || normalizedCwd.startsWith("//");
  const fileKey = windowsPaths ? normalizedFile.toLowerCase() : normalizedFile;
  const cwdKey = windowsPaths ? normalizedCwd.toLowerCase() : normalizedCwd;
  if (fileKey.startsWith(cwdKey + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}
