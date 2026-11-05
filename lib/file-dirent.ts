import fs from "fs";

type DirentType = Pick<fs.Dirent, "isDirectory" | "isFile">;

export function resolveDirentIsDirectory(
  dirent: DirentType,
  fullPath: string,
): boolean | null {
  if (dirent.isDirectory()) return true;
  if (dirent.isFile()) return false;

  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return null;
  }
}
const ignored: Readonly<Record<string, true>> = {
  node_modules: true, ".git": true, ".next": true, dist: true, build: true, __pycache__: true,
  ".turbo": true, ".cache": true, coverage: true, ".pytest_cache": true, ".mypy_cache": true,
  target: true, vendor: true, ".DS_Store": true,
};

export function isIgnoredFileEntry(name: string): boolean {
  return Object.hasOwn(ignored, name) || name.endsWith(".pyc");
}
