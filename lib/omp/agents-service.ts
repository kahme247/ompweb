import { execFileSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isRecord } from "../type-guards";
import { resolveOmpBin } from "./omp-cli";
import { getAgentsBundledCacheDir, getProjectAgentsDir, getUserAgentsDir } from "./paths";

export type AgentSource = "bundled" | "user" | "project";
export type AgentInfo = {
  name: string;
  description: string;
  model?: string[];
  tools?: string[];
  spawns?: string[] | "*";
  thinkingLevel?: string;
  output?: unknown;
  blocking?: boolean;
  prewalk?: boolean | string;
  advisor?: boolean | string;
  source: AgentSource;
  scope: "user" | "project" | "bundled";
  filePath: string;
  valid: boolean;
  enabled: boolean;
  body?: string;
  rawFrontmatter?: Record<string, unknown>;
};

export type AgentDiagnostic = { type: "error" | "warning" | "info"; message: string; path?: string };
export type ParsedAgentFrontmatter = { frontmatter: Record<string, unknown>; body: string };
export type AgentPayload = {
  name?: unknown;
  description: string;
  model?: unknown;
  tools?: unknown;
  thinkingLevel?: unknown;
  spawns?: unknown;
  body?: unknown;
  prewalk?: unknown;
  advisor?: unknown;
  output?: unknown;
  blocking?: unknown;
  enabled?: unknown;
  existingFrontmatter?: unknown;
};

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const MAX_AGENT_BYTES = 512 * 1024;

declare global {
  var __ompBundledAgentsCache: { path: string; checkedAt: number } | undefined;
}

export function parseAgentFrontmatter(content: string): ParsedAgentFrontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return {
      frontmatter: isRecord(parsed) ? parsed : {},
      body: content.slice(match[0].length),
    };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

type AgentScanRoot = { dir: string; source: AgentSource; scope: "user" | "project" | "bundled" };

export function buildAgentScanRoots(cwd?: string): AgentScanRoot[] {
  const roots: AgentScanRoot[] = [
    { dir: getAgentsBundledCacheDir(), source: "bundled", scope: "bundled" },
  ];
  if (cwd) roots.push({ dir: getProjectAgentsDir(cwd), source: "project", scope: "project" });
  roots.push({ dir: getUserAgentsDir(), source: "user", scope: "user" });
  return roots;
}

export function getAgentScanRootDirs(cwd?: string): string[] {
  return buildAgentScanRoots(cwd).map((root) => root.dir);
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  throw new Error(`${field} must be a string array or comma-separated string`);
}

function normalizeFrontmatter(frontmatter: Record<string, unknown>): Omit<AgentInfo, "source" | "scope" | "filePath" | "valid"> {
  const rawName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const safeArray = (value: unknown, field: string): string[] | undefined => { try { return asStringArray(value, field); } catch { return undefined; } };
  const model = safeArray(frontmatter.model, "model");
  const tools = safeArray(frontmatter.tools, "tools");
  const spawns = frontmatter.spawns === "*" ? "*" : safeArray(frontmatter.spawns, "spawns");
  const thinkingLevel = typeof frontmatter.thinkingLevel === "string" ? frontmatter.thinkingLevel : undefined;
  const boolOrString = (value: unknown): boolean | string | undefined => typeof value === "boolean" || typeof value === "string" ? value : undefined;
  return {
    name: rawName, description, model, tools, spawns, thinkingLevel,
    output: frontmatter.output,
    blocking: typeof frontmatter.blocking === "boolean" ? frontmatter.blocking : undefined,
    prewalk: boolOrString(frontmatter.prewalk),
    advisor: boolOrString(frontmatter.advisor),
    enabled: frontmatter.enabled !== false,
    body: undefined,
    rawFrontmatter: frontmatter,
  };
}

function validateFrontmatter(frontmatter: Record<string, unknown>, filename?: string): string[] {
  const errors: string[] = [];
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  if (!name) errors.push("name is required");
  else if (!AGENT_NAME_RE.test(name)) errors.push(`name must match ${AGENT_NAME_RE.source}`);
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) errors.push("description is required");
  for (const field of ["model", "tools"] as const) {
    try { asStringArray(frontmatter[field], field); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (frontmatter.spawns !== undefined && frontmatter.spawns !== "*") {
    try { asStringArray(frontmatter.spawns, "spawns"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (frontmatter.thinkingLevel !== undefined && (typeof frontmatter.thinkingLevel !== "string" || !THINKING_LEVELS.has(frontmatter.thinkingLevel))) errors.push("thinkingLevel is invalid");
  for (const field of ["blocking"] as const) if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "boolean") errors.push(`${field} must be a boolean`);
  for (const field of ["prewalk", "advisor"] as const) if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "boolean" && typeof frontmatter[field] !== "string") errors.push(`${field} must be a boolean or string`);
  if (filename && !name) errors.push(`invalid agent file ${filename}`);
  return errors;
}

function infoFromContent(content: string, filePath: string, source: AgentSource, scope: AgentInfo["scope"], fallbackName?: string): AgentInfo {
  const { frontmatter, body } = parseAgentFrontmatter(content);
  const normalized = normalizeFrontmatter(frontmatter);
  const errors = validateFrontmatter(frontmatter, basename(filePath));
  return { ...normalized, name: normalized.name || fallbackName || basename(filePath, ".md"), body, filePath, source, scope, valid: errors.length === 0, rawFrontmatter: frontmatter };
}

async function scanRoot(root: AgentScanRoot, diagnostics: AgentDiagnostic[]): Promise<AgentInfo[]> {
  try {
    if (lstatSync(root.dir).isSymbolicLink()) {
      diagnostics.push({ type: "warning", message: "Skipped symbolic-link agents directory", path: root.dir });
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ type: "warning", message: `Failed to inspect agents directory: ${String(error)}`, path: root.dir });
  }
  let entries;
  try { entries = readdirSync(root.dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ type: "warning", message: `Failed to read agents directory: ${String(error)}`, path: root.dir }); return []; }
  const agents: AgentInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.name.toLowerCase().endsWith(".md") || !entry.isFile()) continue;
    const filePath = join(root.dir, entry.name);
    try {
      if (statSync(filePath).size > MAX_AGENT_BYTES) { diagnostics.push({ type: "warning", message: "Agent file is too large to inspect", path: filePath }); continue; }
      const content = readFileSync(filePath, "utf8");
      const info = infoFromContent(content, filePath, root.source, root.scope, basename(entry.name, ".md"));
      if (!info.valid) diagnostics.push({ type: "warning", message: `Invalid agent ${info.name}: ${validateFrontmatter(info.rawFrontmatter ?? {}).join(", ")}`, path: filePath });
      agents.push(info);
    } catch (error) { diagnostics.push({ type: "warning", message: `Failed to read agent file: ${String(error)}`, path: filePath }); }
  }
  return agents;
}

export function unpackBundled(targetDir: string, force = false): { targetDir: string; total: number; written: number; skipped: number } {
  const safeTargetDir = secureScopeDir(targetDir);
  const before = new Set(readdirSync(safeTargetDir, { withFileTypes: true }).filter((entry) => entry.name.toLowerCase().endsWith(".md")).map((entry) => entry.name));
  const bin = resolveOmpBin() ?? "omp";
  execFileSync(bin, ["agents", "unpack", "--dir", safeTargetDir, "--json", ...(force ? ["--force"] : [])], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const after = readdirSync(safeTargetDir, { withFileTypes: true }).filter((entry) => entry.name.toLowerCase().endsWith(".md")).map((entry) => entry.name);
  const written = after.filter((name) => !before.has(name)).length;
  return { targetDir, total: after.length, written, skipped: Math.max(0, after.length - written) };
}

export async function ensureBundledAgentsCache(): Promise<string> {
  const cacheDir = getAgentsBundledCacheDir();
  const cached = globalThis.__ompBundledAgentsCache;
  if (cached && cached.path === cacheDir && Date.now() - cached.checkedAt < 60_000) return cacheDir;
  mkdirSync(cacheDir, { recursive: true });
  const files = readdirSync(cacheDir).filter((name) => name.toLowerCase().endsWith(".md"));
  if (files.length === 0 && (!cached || Date.now() - cached.checkedAt >= 60_000)) {
    try { unpackBundled(cacheDir, false); } catch { /* discovery reports the missing/failed binary */ }
  }
  globalThis.__ompBundledAgentsCache = { path: cacheDir, checkedAt: Date.now() };
  return cacheDir;
}

export async function discoverAgents(cwd?: string): Promise<{ agents: AgentInfo[]; diagnostics: AgentDiagnostic[]; bundledPath?: string }> {
  const diagnostics: AgentDiagnostic[] = [];
  const roots = buildAgentScanRoots(cwd);
  const bundledPath = await ensureBundledAgentsCache();
  if (!resolveOmpBin()) diagnostics.push({ type: "error", message: "omp binary is not installed; bundled agents could not be unpacked" });
  const byName = new Map<string, AgentInfo>();
  for (const root of roots) {
    for (const agent of await scanRoot(root, diagnostics)) {
      const key = process.platform === "win32" ? agent.name.toLowerCase() : agent.name;
      byName.set(key, agent);
    }
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics, bundledPath };
}

export function validateAgentPayload(input: unknown): asserts input is AgentPayload & { name: string; description: string } {
  if (!isRecord(input)) throw new Error("agent payload must be an object");
  if (typeof input.name !== "string" || !AGENT_NAME_RE.test(input.name.trim())) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
  if (typeof input.description !== "string" || !input.description.trim()) throw new Error("description is required");
  for (const field of ["model", "tools"] as const) asStringArray(input[field], field);
  if (input.spawns !== undefined && input.spawns !== "*") asStringArray(input.spawns, "spawns");
  if (input.thinkingLevel !== undefined && (typeof input.thinkingLevel !== "string" || !THINKING_LEVELS.has(input.thinkingLevel))) throw new Error("thinkingLevel is invalid");
  if (input.body !== undefined && typeof input.body !== "string") throw new Error("body must be a string");
  if (input.blocking !== undefined && typeof input.blocking !== "boolean") throw new Error("blocking must be a boolean");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (input.existingFrontmatter !== undefined && !isRecord(input.existingFrontmatter)) throw new Error("existingFrontmatter must be an object");
  for (const field of ["prewalk", "advisor"] as const) if (input[field] !== undefined && typeof input[field] !== "boolean" && typeof input[field] !== "string") throw new Error(`${field} must be a boolean or string`);
}

export function serializeAgent(frontmatter: Record<string, unknown>, body: string): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const yaml = stringifyYaml(frontmatter).replace(/\r?\n/g, eol).replace(new RegExp(`${eol}$`), "");
  return `---${eol}${yaml}${eol}---${eol}${body}`;
}

export function getAgentFilePath(scopeDir: string, name: string): string {
  if (!AGENT_NAME_RE.test(name)) throw new Error("invalid agent name");
  return join(scopeDir, `${name}.md`);
}

function sameAgentPath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// On a case-insensitive filesystem (macOS APFS default) a case-only rename
// resolves both names to the same directory entry even though the POSIX
// string compare differs. realpathSync.native (realpath(3)) returns the
// on-disk casing — the JS realpathSync preserves input casing — so case
// aliases compare equal while distinct hardlink entries to the same inode
// (a real name collision) stay distinct.
function sameOnDiskEntry(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

export function validateAgentFileReference(scopeDir: string, name: string): void {
  if (!AGENT_NAME_RE.test(name)) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
  const filePath = getAgentFilePath(scopeDir, name);
  if (!existsSync(filePath)) throw new Error("agent file not found");
}

function secureScopeDir(scopeDir: string): string {
  const resolved = resolve(scopeDir);
  let current = resolved;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("agent scope path may not contain a symbolic link");
      if (current === resolved && !stat.isDirectory()) throw new Error("agent scope path is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(resolved, { recursive: true });
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("agent scope directory is not a regular directory");
  return resolved;
}

export function writeAgent(scopeDir: string, name: string, payload: AgentPayload, previousName?: string): { path: string } {
  if (!AGENT_NAME_RE.test(name)) throw new Error("invalid agent name");
  validateAgentPayload({ ...payload, name });
  const dir = secureScopeDir(scopeDir);
  if (previousName !== undefined) validateAgentFileReference(dir, previousName);
  const filePath = getAgentFilePath(dir, name);
  const previousPath = previousName ? getAgentFilePath(dir, previousName) : undefined;
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) throw new Error("agent file may not be a symbolic link");
  const replacesPreviousPath = Boolean(previousPath && (sameAgentPath(filePath, previousPath) || sameOnDiskEntry(filePath, previousPath)));
  if (existsSync(filePath) && !replacesPreviousPath) throw new Error("agent file already exists");
  const preserved: Record<string, unknown> = isRecord(payload.existingFrontmatter) ? { ...payload.existingFrontmatter } : {};
  if (previousPath && existsSync(previousPath)) {
    if (lstatSync(previousPath).isSymbolicLink()) throw new Error("agent file may not be a symbolic link");
    try {
      const previousContent = readFileSync(previousPath, "utf8");
      Object.assign(preserved, parseAgentFrontmatter(previousContent).frontmatter);
    } catch {
      // The new form remains writable even if an old file cannot be parsed.
    }
  }
  // These are the fields represented by the compact editor and therefore
  // intentionally replaced when omitted or changed. Other OMP frontmatter
  // (prewalk/advisor/output/blocking and unknown extensions) is preserved.
  for (const field of ["name", "description", "model", "tools", "thinkingLevel", "spawns"] as const) delete preserved[field];
  const frontmatter: Record<string, unknown> = { ...preserved, name, description: payload.description.trim() };
  for (const field of ["model", "tools", "thinkingLevel", "spawns", "prewalk", "advisor", "output", "blocking", "enabled"] as const) {
    const value = payload[field];
    if (value !== undefined && value !== "") frontmatter[field] = field === "model" || field === "tools" ? asStringArray(value, field) : value;
  }
  const body = typeof payload.body === "string" ? payload.body : "";
  const serialized = serializeAgent(frontmatter, body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AGENT_BYTES) throw new Error("agent file is too large");
  const tmpPath = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, serialized, { encoding: "utf8", flag: "wx" });
  let displacedPath: string | undefined;
  try {
    // Windows cannot replace an existing file with renameSync, and on a
    // case-insensitive filesystem (macOS APFS default) renaming over a
    // case-variant keeps the OLD directory entry's casing. Move the old file
    // aside first so updates and case-only renames remain atomic from the
    // caller's view and the new name's casing lands on disk.
    const caseOnlyReplace = Boolean(previousPath && !sameAgentPath(filePath, previousPath) && sameOnDiskEntry(filePath, previousPath));
    if ((process.platform === "win32" || caseOnlyReplace) && replacesPreviousPath && existsSync(filePath)) {
      displacedPath = `${filePath}.${process.pid}.${Date.now()}.old`;
      renameSync(filePath, displacedPath);
    }
    renameSync(tmpPath, filePath);
  } catch (error) {
    if (displacedPath && existsSync(displacedPath) && !existsSync(filePath)) renameSync(displacedPath, filePath);
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    throw error;
  }
  if (displacedPath && existsSync(displacedPath)) unlinkSync(displacedPath);
  if (previousPath && !replacesPreviousPath && existsSync(previousPath)) {
    unlinkSync(previousPath);
  }
  return { path: filePath };
}

export function deleteAgent(scopeDir: string, name: string): { path: string } {
  const dir = secureScopeDir(scopeDir);
  validateAgentFileReference(dir, name);
  const filePath = getAgentFilePath(dir, name);
  if (!existsSync(filePath)) throw new Error("agent file not found");
  if (lstatSync(filePath).isSymbolicLink()) throw new Error("agent file may not be a symbolic link");
  unlinkSync(filePath);
  return { path: filePath };
}

export function resolveAgentsScope(cwd: string | undefined, scope: "user" | "project"): string {
  return scope === "user" ? getUserAgentsDir() : getProjectAgentsDir(cwd || homedir());
}

export function readAgentFile(filePath: string): AgentInfo | null {
  try {
    if (statSync(filePath).size > MAX_AGENT_BYTES) return null;
    const content = readFileSync(filePath, "utf8");
    const isWithin = (root: string) => {
      const rel = relative(resolve(root), resolve(filePath));
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    const bundled = isWithin(getAgentsBundledCacheDir());
    const user = isWithin(getUserAgentsDir());
    const source: AgentSource = bundled ? "bundled" : user ? "user" : "project";
    return infoFromContent(content, filePath, source, source);
  } catch { return null; }
}
