import { execFile } from "child_process";
import { createChildProcessEnvironment } from "../project-command-env";

/**
 * The server's `gh` CLI: every GitHub call goes through a `GhRunner`, so the
 * data layer and tests can swap the process for a fake.
 */

export type GhRunner = (args: string[], input?: string) => Promise<string>;

export class GhError extends Error {
  readonly stderr: string;
  readonly code: string | number | null | undefined;

  constructor(message: string, stderr: string, code: string | number | null | undefined) {
    super(message);
    this.name = "GhError";
    this.stderr = stderr;
    this.code = code;
  }
}

export class GhUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhUnavailableError";
  }
}

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;

export const defaultGhRunner: GhRunner = (args, input) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = execFile(
    "gh",
    args[0] === "api" ? ["api", "--hostname", "github.com", ...args.slice(1)] : args,
    {
      // GH_PROMPT_DISABLED: a prompt would wait on a stdin that never answers.
      env: { ...createChildProcessEnvironment({ GH_PROMPT_DISABLED: "1" }), GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      encoding: "utf8",
    },
    (error, stdout, stderr) => {
      if (error) reject(new GhError(stderr.trim() || error.message, stderr, error.code));
      else resolve(stdout);
    },
  );
  // A spawn failure (ENOENT) or an early exit can make the pipe error; the
  // callback above already reports the outcome.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(input ?? "");
  return promise;
};

const NOT_INSTALLED =
  "`gh` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run `gh auth login` there.";
const NOT_LOGGED_IN = "`gh` is not logged in on the omp-web server machine. Ask the user to run `gh auth login` there.";
const AUTH_STDERR = /auth|login|HTTP 401/i;
const LOGIN_CACHE_MS = 60_000;

declare global {
  var __ompGhLogin: { run: GhRunner; login: string; at: number } | undefined;
}

/**
 * Proves `gh` is installed and logged in by asking GitHub who the account is.
 * A success is cached for 60 s, keyed to the runner that produced it, so a
 * fake runner in a test never sees another runner's answer.
 */
export async function checkGh(
  run: GhRunner = defaultGhRunner,
  now: () => number = Date.now,
): Promise<{ login: string }> {
  const cached = globalThis.__ompGhLogin;
  if (cached && cached.run === run && now() - cached.at < LOGIN_CACHE_MS) {
    return { login: cached.login };
  }
  let stdout: string;
  try {
    stdout = await run(["api", "user", "--jq", ".login"]);
  } catch (error) {
    if (error instanceof GhError && error.code === "ENOENT") throw new GhUnavailableError(NOT_INSTALLED);
    if (error instanceof GhError && AUTH_STDERR.test(error.stderr)) throw new GhUnavailableError(NOT_LOGGED_IN);
    throw error;
  }
  const login = stdout.trim();
  globalThis.__ompGhLogin = { run, login, at: now() };
  return { login };
}

export interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
}

const TARGET_ERROR = 'Agent tool argument "target" must be OWNER/REPO#N or a GitHub pull request or issue URL.';
// GitHub owners are alphanumeric with hyphens. Repos may start with dots,
// but "." and ".." are path segments, not repository names.
const OWNER = /^[A-Za-z0-9-]+$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const SHORT_FORM = /^([^/#\s]+)\/([^/#\s]+)#([1-9]\d{0,9})$/;

function validTarget(owner: string, repo: string, number: number): GithubTarget {
  if (!OWNER.test(owner) || !REPO.test(repo)) throw new Error(TARGET_ERROR);
  return { owner, repo, number };
}

/** `OWNER/REPO#N`, or a github.com pull request or issue URL (trailing path, query and fragment ignored). */
export function parseGithubTarget(value: string): GithubTarget {
  const text = value.trim();
  const short = SHORT_FORM.exec(text);
  if (short) return validTarget(short[1], short[2], Number(short[3]));

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(TARGET_ERROR);
  }
  const path = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9]\d{0,9})(?:\/|$)/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !path) throw new Error(TARGET_ERROR);
  return validTarget(path[1], path[2], Number(path[4]));
}

export function formatTarget(target: GithubTarget): string {
  return `${target.owner}/${target.repo}#${target.number}`;
}
