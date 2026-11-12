// Pure semver ordering: browser-importable (Settings' cluster rules use it), no node:* modules.

function parseVersion(version: string): { parts: number[]; prerelease: boolean } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
}

export function isNewerVersion(availableVersion: string, currentVersion: string): boolean {
  const available = parseVersion(availableVersion);
  const current = parseVersion(currentVersion);
  if (!available || !current) return false;

  for (let index = 0; index < available.parts.length; index += 1) {
    if (available.parts[index] !== current.parts[index]) {
      return available.parts[index] > current.parts[index];
    }
  }
  return !available.prerelease && current.prerelease;
}
