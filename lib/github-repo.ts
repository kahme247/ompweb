import { execFile } from "child_process";
import { promisify } from "util";
import { createGitEnvironment } from "./project-command-env";

const execFileAsync = promisify(execFile);

const GITHUB_REMOTE_URL_RE = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[/:]([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
// gh CLI's default-remote priority when no `gh repo set-default` exists.
const REMOTE_PRIORITY = ["upstream", "github", "origin"];

export function parseGithubRemoteUrl(url: string): string | null {
  const match = GITHUB_REMOTE_URL_RE.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Picks the GitHub repository the way `gh` does, from
 * `git config --get-regexp` output: the `gh repo set-default` remote
 * (`remote.<name>.gh-resolved`) wins, then upstream > github > origin > others.
 * Remote URLs are expanded through `url.<base>.insteadOf` like git does.
 */
export function pickGithubRepo(gitConfig: string): string | null {
  const urls = new Map<string, string>();
  const rewrites: Array<[prefix: string, base: string]> = [];
  let resolved: { name: string; value: string } | undefined;
  for (const line of gitConfig.split("\n")) {
    const insteadOf = /^url\.(.+)\.insteadof (.+)$/.exec(line.trim());
    if (insteadOf) {
      rewrites.push([insteadOf[2], insteadOf[1]]);
      continue;
    }
    const match = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line.trim());
    if (!match) continue;
    const [, name, key, value] = match;
    if (key === "url") {
      if (!urls.has(name)) urls.set(name, value);
    } else {
      resolved ??= { name, value };
    }
  }
  const repoOf = (name: string) => {
    const url = urls.get(name);
    if (url === undefined) return null;
    // Longest matching insteadOf prefix wins, as in git.
    let rule: [string, string] | undefined;
    for (const candidate of rewrites) {
      if (url.startsWith(candidate[0]) && candidate[0].length > (rule?.[0].length ?? 0)) rule = candidate;
    }
    return parseGithubRemoteUrl(rule ? rule[1] + url.slice(rule[0].length) : url);
  };
  const resolvedRepo = resolved ? repoOf(resolved.name) : null;
  if (resolved && resolvedRepo) {
    return REPO_SLUG_RE.test(resolved.value) ? resolved.value : resolvedRepo;
  }
  const rank = (name: string) => {
    const index = REMOTE_PRIORITY.indexOf(name);
    return index === -1 ? REMOTE_PRIORITY.length : index;
  };
  for (const name of [...urls.keys()].sort((a, b) => rank(a) - rank(b))) {
    const repo = repoOf(name);
    if (repo) return repo;
  }
  return null;
}

/** `owner/repo` for the checkout at `cwd`, or null (not a repo, no GitHub remote). */
export async function resolveGithubRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "config", "--get-regexp", "^(remote\\..*\\.(url|gh-resolved)|url\\..*\\.insteadof)$"],
      { timeout: 5_000, env: createGitEnvironment({ LC_ALL: "C" }) },
    );
    return pickGithubRepo(stdout);
  } catch {
    return null;
  }
}
