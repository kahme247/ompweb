/**
 * Remove variables owned by the omp-web host before starting any child
 * process. Two groups are stripped:
 *
 *  - Host runtime variables (PORT, NODE_ENV): these describe the
 *    omp-web server, not the selected project, and can make project commands
 *    behave as if they were running inside the web app.
 *  - omp-web's own secrets. Every `omp` session inherits this environment, so
 *    an agent that runs `env` would otherwise print the web password hash into
 *    its transcript and off to the model provider (issue #239). Only the
 *    *secret* names are removed, not every `OMP_WEB_*`: the update and restart
 *    plumbing (OMP_WEB_PACKAGE_DIR, OMP_WEB_LAUNCHER_PID, ...) is read from the
 *    environment by this same server, and the launcher's non-secret settings
 *    must keep reaching it.
 */

/** Exact names that never reach a child process (compared case-insensitively on Windows). */
const HOST_RUNTIME_NAMES: readonly string[] = ["PORT", "NODE_ENV"];

/**
 * omp-web secrets. `OMP_WEB_PASSWORD` is the legacy plaintext (still listed so
 * a dev server started from an old .env cannot leak it), and
 * `OMP_WEB_TRUSTED_HEADER_SECRET` is the pre-digest name of the trusted-proxy
 * secret, which an old service env file may still carry; the others are the
 * values that grant access to this server.
 */
export const OMP_WEB_SECRET_ENV_VARS: readonly string[] = [
  "OMP_WEB_PASSWORD",
  "OMP_WEB_PASSWORD_HASH",
  "OMP_WEB_TRUSTED_HEADER_SECRET",
  "OMP_WEB_TRUSTED_HEADER_SHA256",
  // Server-side STT credential (read only by lib/stt.ts): no child ever
  // needs it, and an agent running `env` would otherwise print it into its
  // transcript and off to the model provider, as with the password hash.
  "OMP_WEB_STT_KEY",
];

function comparableName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

function matches(name: string, candidates: readonly string[], platform: NodeJS.Platform): boolean {
  const comparable = comparableName(name, platform);
  return candidates.some((candidate) => comparable === comparableName(candidate, platform));
}

/** True when the variable belongs to the omp-web host rather than the child. */
export function isHostRuntimeVariable(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return matches(name, HOST_RUNTIME_NAMES, platform);
}

/** True when the variable is one of omp-web's secrets. */
export function isOmpWebSecretVariable(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return matches(name, OMP_WEB_SECRET_ENV_VARS, platform);
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform) || isOmpWebSecretVariable(name, platform)) {
      delete environment[name];
    }
  }
  return environment;
}

/**
 * Build the environment for a child process that may run repository or plugin
 * code. Always returns a fresh object, so callers can add their own variables
 * without mutating `process.env`.
 *
 * The additions are typed loosely on purpose: they are a handful of literal
 * settings (`LC_ALL`, `FORCE_COLOR`, ...), and `NodeJS.ProcessEnv` requires
 * `NODE_ENV` in this project, which every one of them would have to pretend to
 * provide.
 */
export function createChildProcessEnvironment(
  additions: Readonly<Record<string, string | undefined>> = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return sanitizeProjectCommandEnvironment({ ...baseEnvironment, ...additions }, platform);
}

/**
 * Variables that make Git use another repository, index or worktree than the one at its
 * `-C` directory. A daemon started from a hook or a checkout can inherit them, and Git
 * would then read or write that repository instead. The command-line config variables
 * (`git -c` passes them on as GIT_CONFIG_PARAMETERS) can set `core.worktree` the same way.
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM stay: they select config files, not a repository.
 */
const GIT_REPOSITORY_NAMES: readonly string[] = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
  "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
];
const GIT_CONFIG_ENTRY = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i;

/** Environment for a `git -C <dir>` child: like createChildProcessEnvironment, and Git resolves the repository from `<dir>` alone. */
export function createGitEnvironment(
  additions: Readonly<Record<string, string | undefined>> = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = createChildProcessEnvironment(additions, baseEnvironment, platform);
  for (const name of Object.keys(environment)) {
    if (matches(name, GIT_REPOSITORY_NAMES, platform) || GIT_CONFIG_ENTRY.test(name)) delete environment[name];
  }
  return environment;
}
