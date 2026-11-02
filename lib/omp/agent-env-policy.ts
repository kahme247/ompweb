/**
 * Policy + text format for the environment variables injected into the `omp` child
 * process (issue #104). Deliberately free of Node built-ins (no `fs`) so the settings
 * UI can reuse exactly the same validation the server applies; the persistence side
 * lives in ./agent-env.ts.
 *
 * Users only ever get to add variables, never to rewrite the plumbing omp-web itself
 * depends on. Two rules enforce that:
 *   1. `lib/project-command-env.ts` strips PORT / NODE_ENV from every child
 *      spawn (`sanitizeProjectCommandEnvironment`, called in `spawnOmpTransport` in lib/omp/rpc-process.ts
 *      AFTER the merge). Letting a user set them would be a silent no-op, so they are
 *      denied here too — the policy is deliberately mirrored, not re-invented.
 *   2. Names that relocate omp's own state (agent dir, config root, home) would make
 *      the child read and write a different ~/.omp than the one omp-web enumerates
 *      sessions, settings and agents from: the child would start fine and its sessions
 *      would vanish from the UI. Those are denied as well.
 *
 * Matching is case-insensitive on purpose: Windows environment names are, and the
 * denied names are mostly Windows plumbing (`SystemRoot`, `ComSpec`, `PATH`, ...). A
 * POSIX tool wanting an oddly-cased `Path` is far less likely than a Windows user
 * typing `systemroot`.
 */
import { isRecord } from "../type-guards";

/** Shell-style variable name: no dots, dashes or leading digits. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Exact names that may never be overridden, grouped by the failure they prevent.
 * Compared uppercased (see the module comment).
 */
const DENIED_NAMES: ReadonlySet<string> = new Set([
  // Process plumbing — a rewritten PATH breaks omp's own binary/tool lookups,
  // NODE_OPTIONS injects code into every child node process.
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "NODE_OPTIONS",
  // Where omp keeps its state. Redirecting these splits the child from the ~/.omp
  // that omp-web enumerates sessions, settings and agents from.
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  // Mirrors lib/project-command-env.ts: stripped from every spawn, so a user
  // override would be discarded without a word.
  "PORT",
  "NODE_ENV",
]);

/** Prefixes that may never be overridden (compared uppercased). */
const DENIED_PREFIXES: readonly string[] = [
  "OMP_WEB_", // omp-web's own plumbing (auth, ports, binary overrides)
  "_", // shell-internal namespace
];

export interface AgentEnvParseResult {
  values: Record<string, string>;
  /** Human-readable problems, one per offending line, prefixed with the line number. */
  errors: string[];
}

/** Localizable message builders. Defaults to English; the settings UI injects translations. */
export interface AgentEnvErrorLabels {
  missingSeparator?: (line: number) => string;
  emptyName?: (line: number) => string;
  invalidName?: (line: number, name: string) => string;
  deniedName?: (line: number, name: string) => string;
}

const DEFAULT_LABELS: Required<AgentEnvErrorLabels> = {
  missingSeparator: (line) => `Line ${line}: expected KEY=VALUE`,
  emptyName: (line) => `Line ${line}: missing variable name`,
  invalidName: (line, name) => `Line ${line}: "${name}" is not a valid variable name`,
  deniedName: (line, name) => `Line ${line}: "${name}" is reserved by omp-web and cannot be set`,
};

/** True when the name is reserved by omp-web and may not be overridden. */
export function isDeniedAgentEnvName(name: string): boolean {
  const comparable = name.toUpperCase();
  return DENIED_NAMES.has(comparable) || DENIED_PREFIXES.some((prefix) => comparable.startsWith(prefix));
}

/**
 * Parse `KEY=VALUE` text into a validated record. Blank lines and `#` comments are
 * ignored, an `export ` prefix is tolerated, and values are taken literally after the
 * first `=` (surrounding whitespace trimmed, no quote or escape processing). A later
 * assignment wins, matching shell semantics. Rejected lines are reported and excluded
 * from `values` — the caller decides whether to block the save.
 */
export function parseAgentEnvText(raw: string, labels?: AgentEnvErrorLabels): AgentEnvParseResult {
  const message = { ...DEFAULT_LABELS, ...labels };
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const lines = String(raw ?? "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    // `export KEY=VALUE` is what a NixOS-style generated .env looks like.
    const body = trimmed.replace(/^export\s+/, "");
    const separator = body.indexOf("=");
    if (separator === -1) {
      errors.push(message.missingSeparator(line));
      return;
    }
    const name = body.slice(0, separator).trim();
    if (!name) {
      errors.push(message.emptyName(line));
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      errors.push(message.invalidName(line, name));
      return;
    }
    if (isDeniedAgentEnvName(name)) {
      errors.push(message.deniedName(line, name));
      return;
    }
    values[name] = body.slice(separator + 1).trim();
  });
  return { values, errors };
}

/**
 * Validate an already-structured record (settings file or API payload) with the same
 * rules as {@link parseAgentEnvText}. Non-string values are dropped; denied names are
 * reported as errors so callers can surface them, and never reach `values`.
 */
export function sanitizeAgentEnvValues(input: unknown, labels?: AgentEnvErrorLabels): AgentEnvParseResult {
  if (!isRecord(input)) return { values: {}, errors: [] };
  const text = Object.entries(input)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => `${name}=${value as string}`)
    .join("\n");
  return parseAgentEnvText(text, labels);
}

/** Canonical `KEY=VALUE` text, sorted by name so saves are stable and diffable. */
export function formatAgentEnvText(values: Record<string, string>): string {
  return Object.keys(values ?? {})
    .sort()
    .map((name) => `${name}=${values[name]}`)
    .join("\n");
}