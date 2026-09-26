import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { getAgentDir } from "@/lib/omp/paths";
import { getRpcSession, getRunningRpcSessions } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";
import type { SkillInfo } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";

/**
 * Pure-Node skill discovery mirroring omp's providers
 * (oh-my-pi/packages/coding-agent/src/discovery/{builtin,claude,agents,codex,github}.ts).
 * omp-web cannot import the Bun-only SDK, so the scan rules are replicated:
 * each provider contributes <root>/<name>/SKILL.md skills, higher-priority
 * providers win name collisions, and `enabled: false` frontmatter hides a
 * skill entirely.
 */

export interface SkillDiagnostic {
  type: "error" | "warning" | "info";
  message: string;
  path?: string;
}

export interface SkillsWithDiagnostics {
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
}

interface SkillScanRoot {
  dir: string;
  /** Provider label surfaced as sourceInfo.source (".omp", ".claude", ...). */
  source: string;
  scope: "user" | "project";
  /** omp skips skills without a description for these providers. */
  requireDescription?: boolean;
}

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split YAML frontmatter from a markdown document. Returns an empty
 * frontmatter object when no `---` block is present or YAML is invalid. */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/** Ancestor directories from cwd up to the git repo root (or $HOME / fs root),
 * closest first — matches omp's project-level walk-up discovery. */
function getAncestorDirs(cwd: string): string[] {
  const home = homedir();
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    dirs.push(current);
    if (existsSync(path.join(current, ".git"))) break;
    if (current === home) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** Scan roots in omp's provider priority order (highest first): .omp (100),
 * .claude (80), .agent/.agents + .codex + .github (70), managed skills (5). */
function buildScanRoots(cwd: string): SkillScanRoot[] {
  const home = homedir();
  const agentDir = getAgentDir();
  const ancestors = getAncestorDirs(cwd);
  const projectAncestors = ancestors.filter((dir) => dir !== home);
  const roots: SkillScanRoot[] = [];

  // builtin (.omp): project walk-up first (closest first), then user dir.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".omp", "skills"), source: ".omp", scope: "project", requireDescription: true });
  }
  roots.push({ dir: path.join(agentDir, "skills"), source: ".omp", scope: "user", requireDescription: true });

  // claude compat: user ~/.claude/skills + project .claude/skills walk-up.
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  roots.push({ dir: path.join(claudeHome, "skills"), source: ".claude", scope: "user" });
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".claude", "skills"), source: ".claude", scope: "project" });
  }

  // agent dirs compat (.agent/.agents): project walk-up + user home.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".agent", "skills"), source: ".agents", scope: "project" });
    roots.push({ dir: path.join(dir, ".agents", "skills"), source: ".agents", scope: "project" });
  }
  roots.push({ dir: path.join(home, ".agent", "skills"), source: ".agents", scope: "user" });
  roots.push({ dir: path.join(home, ".agents", "skills"), source: ".agents", scope: "user" });

  // codex compat: user ~/.codex/skills + project .codex/skills.
  roots.push({ dir: path.join(home, ".codex", "skills"), source: ".codex", scope: "user" });
  roots.push({ dir: path.join(cwd, ".codex", "skills"), source: ".codex", scope: "project" });

  // github compat: <repoRoot>/.github/skills.
  const repoRoot = ancestors[ancestors.length - 1];
  roots.push({ dir: path.join(repoRoot, ".github", "skills"), source: ".github", scope: "project", requireDescription: true });

  // managed auto-learn skills (lowest priority).
  roots.push({ dir: path.join(agentDir, "managed-skills"), source: "managed", scope: "user", requireDescription: true });

  return roots;
}

/** Directories the discovery walk reads, for callers that must authorize a
 * skill path (single source of truth with buildScanRoots — a narrower list
 * would reject skills the app itself discovered and installed). Without a cwd
 * only the cwd-independent user-scope roots are returned. */
export function getSkillScanRootDirs(cwd?: string): string[] {
  return buildScanRoots(cwd ?? homedir()).map((root) => root.dir);
}

const DISABLE_INVOCATION_KEYS = ["disable-model-invocation", "disableModelInvocation", "hide"] as const;
/** Agent Skills standard spelling — used when no variant is present yet. */
const CANONICAL_DISABLE_KEY = DISABLE_INVOCATION_KEYS[0];

/** True when any of the three spellings omp honors is set
 * (frontmatter.hide === true || frontmatter.disableModelInvocation === true,
 * with `disable-model-invocation` normalized into the latter). */
export function readDisableModelInvocation(frontmatter: Record<string, unknown>): boolean {
  return DISABLE_INVOCATION_KEYS.some((key) => isTruthyFlag(frontmatter[key]));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const DISABLE_KEY_LINE_RE = new RegExp(`^(?:${DISABLE_INVOCATION_KEYS.join("|")})[ \\t]*:.*$`);

/** Set/clear the disable-model-invocation flag in a SKILL.md, editing the key
 * line already present (in whichever of the three spellings) instead of
 * prepending a second copy, which would make the frontmatter invalid YAML. */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return disable ? `---\n${CANONICAL_DISABLE_KEY}: true\n---\n${content}` : content;
  }

  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = match[1].split(/\r?\n/);
  const hits = lines.reduce<number[]>((acc, line, index) => {
    if (DISABLE_KEY_LINE_RE.test(line)) acc.push(index);
    return acc;
  }, []);

  let next: string[];
  if (disable) {
    if (hits.length === 0) {
      next = [`${CANONICAL_DISABLE_KEY}: true`, ...lines];
    } else {
      // Keep the spelling the file already uses; drop any duplicate variants so
      // a stale `hide: true` cannot re-enable hiding on the next toggle.
      const keep = hits[0];
      const keyName = /^([\w-]+)/.exec(lines[keep])?.[1] ?? CANONICAL_DISABLE_KEY;
      next = lines
        .map((line, index) => (index === keep ? `${keyName}: true` : line))
        .filter((_, index) => index === keep || !hits.includes(index));
    }
  } else {
    if (hits.length === 0) return content;
    next = lines.filter((_, index) => !hits.includes(index));
  }

  const block = `---${eol}${next.join(eol)}${eol}---${match[2]}`;
  return block + content.slice(match[0].length);
}

async function scanRoot(root: SkillScanRoot, diagnostics: SkillDiagnostic[]): Promise<SkillInfo[]> {
  let entries;
  try {
    // `root.dir` is user-controlled and can be outside the app. Keep this
    // runtime discovery opaque to Next's NFT tracer so builds never glob the
    // user's profile (or protected Windows junctions).
    const readDirectory = Reflect.get(fs, "readdir") as typeof fs.readdir;
    entries = await readDirectory(root.dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        type: "warning",
        message: `Failed to read skills directory: ${String(error)}`,
        path: root.dir,
      });
    }
    return [];
  }

  const skills: SkillInfo[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (entry.name.startsWith(".")) return;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
    const skillPath = path.join(root.dir, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await fs.readFile(skillPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({ type: "warning", message: "Failed to read skill file", path: skillPath });
      }
      return;
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    if (frontmatter.enabled === false) return;
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (root.requireDescription && !description) return;
    const rawName = frontmatter.name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : entry.name;
    skills.push({
      name,
      description,
      filePath: skillPath,
      baseDir: path.join(root.dir, entry.name),
      disableModelInvocation: readDisableModelInvocation(frontmatter),
      sourceInfo: { source: root.source, scope: root.scope },
    });
  }));
  return skills;
}

/** omp provider id (the `source` field is "provider:level") mapped to the
 * provider label the UI renders (the owning directory). */
const SOURCE_LABEL_BY_PROVIDER: Record<string, string> = {
  native: ".omp",
  claude: ".claude",
  agents: ".agents",
  codex: ".codex",
  github: ".github",
  "omp-managed": "managed",
};

/**
 * Ask a running omp session for its skill listing (RPC `skills_list`, omp
 * >= 18.2.2-patched). The session listing is authoritative — it is the same
 * resolution omp uses for `skill://` and `/skill:`, including namespaced
 * collision aliases the replica scan below cannot know about. Returns
 * undefined when no running session covers cwd, when the child predates the
 * command, or on any transport hiccup, letting the caller fall back to the
 * local replica scan. The listing reflects the session's last discovery:
 * like the CLI, changes on disk show up after the session restarts.
 */
/**
 * Map a `skills_list` RPC payload onto the app's SkillInfo shape. Returns
 * undefined for anything that is not a successful skills_list data object.
 */
export function skillsFromRpcPayload(data: unknown): SkillsWithDiagnostics | undefined {
  if (!isRecord(data)) return undefined;
  const rawSkills = Array.isArray(data.skills) ? data.skills : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const skills: SkillInfo[] = [];
  for (const raw of rawSkills) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.filePath !== "string") continue;
    const [provider = "", scope = ""] = typeof raw.source === "string" ? raw.source.split(":") : [];
    skills.push({
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : "",
      filePath: raw.filePath,
      baseDir: typeof raw.baseDir === "string" ? raw.baseDir : raw.filePath.replace(/[\\/]SKILL\.md$/, ""),
      disableModelInvocation: raw.hide === true,
      sourceInfo: { source: SOURCE_LABEL_BY_PROVIDER[provider] ?? provider, scope },
    });
  }
  return { skills, diagnostics: warnings as SkillDiagnostic[] };
}

async function discoverSkillsViaRpc(cwd: string): Promise<SkillsWithDiagnostics | undefined> {
  const candidates = getRunningRpcSessions().filter((session) => session.cwd === cwd);
  for (const running of candidates) {
    const session = getRpcSession(running.id);
    if (!session) continue;
    try {
      const response = (await session.send({ type: "skills_list" })) as unknown;
      if (!isRecord(response) || response.success !== true) continue;
      return skillsFromRpcPayload(response.data);
    } catch {
      // Restarting or stale child — try the next candidate, else fall back.
    }
  }
  return undefined;
}

/** Discover skills for a cwd the way omp does. Name collisions resolve to the
 * highest-priority provider (scan-root order); result is sorted by name. */
export async function discoverSkills(cwd: string): Promise<SkillsWithDiagnostics> {
  const viaRpc = await discoverSkillsViaRpc(cwd);
  if (viaRpc) return viaRpc;
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, SkillInfo>();
  for (const root of buildScanRoots(cwd)) {
    for (const skill of await scanRoot(root, diagnostics)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return cmp !== 0 ? cmp : a.filePath.localeCompare(b.filePath);
  });
  return { skills, diagnostics };
}

export async function loadSkillsWithInstallInfo(cwd: string) {
  const { skills, diagnostics } = await discoverSkills(cwd);
  return {
    skills: annotateSkillsWithInstallInfo(skills, { cwd, agentDir: getAgentDir() }),
    diagnostics,
  };
}
