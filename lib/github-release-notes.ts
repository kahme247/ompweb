import { releaseRepo } from "./release-repo";

const RELEASES_API_URL = `https://api.github.com/repos/${releaseRepo()}/releases/tags/`;
const FETCH_TIMEOUT_MS = 5_000;
export const MAX_BODY_BYTES = 64 * 1024;

export interface GitHubReleaseNotes {
  version: string;
  body: string;
  htmlUrl: string;
}

/** Only allow github.com release URLs so the dialog never links off-site. */
export function isSafeReleaseUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

export async function getGitHubReleaseNotes(version: string): Promise<GitHubReleaseNotes | null> {
  const tag = `v${version}`;
  let response: Response;
  try {
    response = await fetch(`${RELEASES_API_URL}${encodeURIComponent(tag)}`, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "@kahme247/ompweb", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let release: Record<string, unknown>;
  try {
    release = await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
  if (release.tag_name !== tag || release.draft !== false) return null;
  if (typeof release.body !== "string" || release.body.length === 0) return null;
  if (release.body.length > MAX_BODY_BYTES || Buffer.byteLength(release.body, "utf8") > MAX_BODY_BYTES) return null;
  if (typeof release.html_url !== "string" || !isSafeReleaseUrl(release.html_url)) return null;
  return { version, body: release.body, htmlUrl: release.html_url };
}
