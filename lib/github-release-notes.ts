const RELEASES_API_URL = "https://api.github.com/repos/kahme247/ompweb/releases/tags/";
const RELEASE_PAGE_URL = "https://github.com/kahme247/ompweb/releases/tag/";
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface GitHubReleaseNotes {
  version: string;
  body: string;
  htmlUrl: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CacheEntry = { expiresAt: number; value: GitHubReleaseNotes | null };
type ClientOptions = {
  fetchImpl: FetchLike;
  now: () => number;
  timeoutMs: number;
  positiveTtlMs: number;
  negativeTtlMs: number;
  maxCacheEntries: number;
};

function parseVersion(version: string): { prerelease: boolean } | null {
  if (version.length > 128) return null;
  const match = VERSION_PATTERN.exec(version);
  return match ? { prerelease: match[4] !== undefined } : null;
}

function parseRelease(version: string, value: unknown): GitHubReleaseNotes | null {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion || !value || typeof value !== "object" || Array.isArray(value)) return null;

  const release = value as Record<string, unknown>;
  const tag = `v${version}`;
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== parsedVersion.prerelease) return null;
  if (typeof release.body !== "string" || release.body.trim().length === 0) return null;
  if (release.body.length > MAX_BODY_BYTES || Buffer.byteLength(release.body, "utf8") > MAX_BODY_BYTES) return null;

  const expectedUrl = `${RELEASE_PAGE_URL}${tag}`;
  if (release.html_url !== expectedUrl) return null;

  return { version, body: release.body, htmlUrl: release.html_url };
}

async function readBoundedResponse(response: Response): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function createClient(options: ClientOptions): (version: string) => Promise<GitHubReleaseNotes | null> {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<GitHubReleaseNotes | null>>();

  function cacheResult(version: string, value: GitHubReleaseNotes | null): void {
    const now = options.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    cache.delete(version);
    while (cache.size >= options.maxCacheEntries) cache.delete(cache.keys().next().value!);
    cache.set(version, {
      expiresAt: now + (value ? options.positiveTtlMs : options.negativeTtlMs),
      value,
    });
  }

  return async function getReleaseNotes(version: string): Promise<GitHubReleaseNotes | null> {
    if (!parseVersion(version)) return null;

    const cached = cache.get(version);
    if (cached && cached.expiresAt > options.now()) return cached.value;
    if (cached) cache.delete(version);

    const pending = inFlight.get(version);
    if (pending) return pending;

    const request = (async (): Promise<GitHubReleaseNotes | null> => {
      let value: GitHubReleaseNotes | null = null;
      try {
        const tag = `v${version}`;
        const response = await options.fetchImpl(`${RELEASES_API_URL}${encodeURIComponent(tag)}`, {
          cache: "no-store",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "@kahme247/ompweb",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel();
        } else {
          const text = await readBoundedResponse(response);
          if (text !== null) value = parseRelease(version, JSON.parse(text));
        }
      } catch {
        value = null;
      }
      cacheResult(version, value);
      return value;
    })();

    inFlight.set(version, request);
    try {
      return await request;
    } finally {
      inFlight.delete(version);
    }
  };
}

const getCachedReleaseNotes = createClient({
  fetchImpl: fetch,
  now: Date.now,
  timeoutMs: FETCH_TIMEOUT_MS,
  positiveTtlMs: POSITIVE_TTL_MS,
  negativeTtlMs: NEGATIVE_TTL_MS,
  maxCacheEntries: MAX_CACHE_ENTRIES,
});

export async function getGitHubReleaseNotes(version: string): Promise<GitHubReleaseNotes | null> {
  return getCachedReleaseNotes(version);
}

export const __githubReleaseNotesTesting = {
  parseRelease,
  createClient(options: Partial<ClientOptions> & Pick<ClientOptions, "fetchImpl">) {
    return createClient({
      fetchImpl: options.fetchImpl,
      now: options.now ?? Date.now,
      timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
      positiveTtlMs: options.positiveTtlMs ?? POSITIVE_TTL_MS,
      negativeTtlMs: options.negativeTtlMs ?? NEGATIVE_TTL_MS,
      maxCacheEntries: options.maxCacheEntries ?? MAX_CACHE_ENTRIES,
    });
  },
};
