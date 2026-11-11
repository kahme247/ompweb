import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { isCollection, isMap, parseDocument } from "yaml";

export const CONFIG_LIMITS = { fileBytes: 5_242_880, bundleBytes: 52_428_800 };

export type ConfigRoot = "agent" | "home";

/** Mirrored entries: files and directories, relative to the omp agent directory or to the home directory. */
export const MIRRORED: readonly { root: ConfigRoot; path: string; kind: "file" | "dir" }[] = [
  ...["config.yml", "models.yml", "mcp.json", ".mcp.json", "AGENTS.md", "RULES.md", "SYSTEM.md", "APPEND_SYSTEM.md", "TITLE_SYSTEM.md", "secrets.yml", ".env"].map(
    (path) => ({ root: "agent" as const, path, kind: "file" as const }),
  ),
  ...["skills", "agents", "rules", "instructions", "commands", "prompts", "hooks", "extensions", "tools"].map((path) => ({
    root: "agent" as const,
    path,
    kind: "dir" as const,
  })),
  { root: "home", path: ".agents/skills", kind: "dir" },
];

/** `config.yml` key paths a member keeps for itself (spec K2). A path covers everything below it. */
export const LOCAL_SETTINGS: readonly (readonly string[])[] = [
  ["shellPath"],
  ["python", "interpreter"],
  ["browser"],
  ["worktree", "base"],
  ["plan", "autosaveDir"],
  ["shellMinimizer", "settingsPath"],
  ["mnemopi", "dbPath"],
  ["workspace", "additionalDirectories"],
  ["skills", "customDirectories"],
  ["extensions"],
  ["images", "urls"],
  ["providers", "tinyModelDevice"],
  ["providers", "tinyModelDtype"],
  ["tts"],
  ["stt"],
  ["tui"],
  ["terminal"],
  ["lsp"],
  ["auth", "broker"],
];

export interface ManifestFile { root: ConfigRoot; path: string; hash: string; size: number; exec: boolean }
export interface PluginEntry { kind: "npm" | "marketplace"; id: string; version: string | null; enabled: boolean }
export interface ConfigManifest { version: string; files: ManifestFile[]; agentEnv: Record<string, string>; plugins: PluginEntry[] }

export class ClusterConfigError extends Error {
  constructor(readonly code: "file_too_large" | "bundle_too_large" | "invalid_settings" | "invalid_path", message: string) {
    super(message);
    this.name = "ClusterConfigError";
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Follows symbolic links; a broken link counts as missing. */
function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
    throw error;
  }
}

function parseSettings(yaml: string) {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0 || !isMap(doc.contents)) throw new ClusterConfigError("invalid_settings", "config.yml is not a valid YAML map");
  return doc;
}

export function stripLocalSettings(masterYaml: string): string {
  const doc = parseSettings(masterYaml);
  for (const path of LOCAL_SETTINGS) if (doc.hasIn(path)) doc.deleteIn(path);
  return doc.toString();
}

export function mergeLocalSettings(masterYaml: string, ownYaml: string | null): string {
  const doc = parseSettings(stripLocalSettings(masterYaml));
  // An unreadable own file keeps nothing, like an absent one: the member must still be able to sync.
  const ownDoc = ownYaml === null ? null : parseDocument(ownYaml);
  if (ownDoc && ownDoc.errors.length === 0 && isMap(ownDoc.contents)) {
    for (const path of LOCAL_SETTINGS) {
      if (!ownDoc.hasIn(path)) continue;
      // setIn throws when a parent exists but is not a collection (e.g. `python: 3`); the member's shape wins there.
      for (let i = 1; i < path.length; i++) {
        const parent = doc.getIn(path.slice(0, i), true);
        if (parent !== undefined && !isCollection(parent)) doc.deleteIn(path.slice(0, i));
      }
      doc.setIn(path, ownDoc.getIn(path));
    }
  }
  return doc.toString();
}

export function isManagedPath(root: ConfigRoot, path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0")) return false;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return MIRRORED.some((entry) => entry.root === root && (path === entry.path || (entry.kind === "dir" && path.startsWith(`${entry.path}/`))));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Reads the mirrored entries under the two roots. `content(hash)` returns the bytes of a manifest file. */
export function buildManifest(
  roots: Record<ConfigRoot, string>,
  extra: { agentEnv: Record<string, string>; plugins: PluginEntry[] },
): { manifest: ConfigManifest; content(hash: string): Uint8Array | null } {
  const files: ManifestFile[] = [];
  const contents = new Map<string, Uint8Array>();
  let total = 0;

  const checkSize = (path: string, size: number) => {
    if (size > CONFIG_LIMITS.fileBytes) throw new ClusterConfigError("file_too_large", `${path} is ${size} bytes, over the ${CONFIG_LIMITS.fileBytes} byte limit`);
  };

  /** `source` is where the master keeps it; `path` is the manifest path (differs for `config.yaml`). */
  const addFile = (root: ConfigRoot, path: string, source: string, stat: Stats) => {
    checkSize(path, stat.size);
    let bytes: Uint8Array = readFileSync(source);
    if (root === "agent" && path === "config.yml") bytes = Buffer.from(stripLocalSettings(Buffer.from(bytes).toString("utf8")), "utf8");
    checkSize(path, bytes.length);
    total += bytes.length;
    if (total > CONFIG_LIMITS.bundleBytes) throw new ClusterConfigError("bundle_too_large", `the bundle exceeds ${CONFIG_LIMITS.bundleBytes} bytes at ${path}`);
    const hash = sha256(bytes);
    contents.set(hash, bytes);
    files.push({ root, path, hash, size: bytes.length, exec: (stat.mode & 0o111) !== 0 });
  };

  // `walking` holds the real paths of the directories being walked, so a link back to an ancestor is skipped.
  const walk = (root: ConfigRoot, path: string, dir: string, walking: Set<string>) => {
    const real = realpathSync(dir);
    if (walking.has(real)) return;
    walking.add(real);
    for (const name of readdirSync(dir)) {
      const source = join(dir, name);
      const stat = statOrNull(source);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (name !== "node_modules" && name !== ".git") walk(root, `${path}/${name}`, source, walking);
      } else if (stat.isFile()) addFile(root, `${path}/${name}`, source, stat);
    }
    walking.delete(real);
  };

  for (const entry of MIRRORED) {
    const base = join(roots[entry.root], entry.path);
    if (entry.kind === "dir") {
      if (statOrNull(base)?.isDirectory()) walk(entry.root, entry.path, base, new Set());
      continue;
    }
    // omp reads `.yml` before `.yaml`, so `.yaml` stands in only when `.yml` is absent.
    const sources = entry.root === "agent" && (entry.path === "config.yml" || entry.path === "models.yml") ? [base, base.replace(/\.yml$/, ".yaml")] : [base];
    for (const source of sources) {
      const stat = statOrNull(source);
      if (!stat?.isFile()) continue;
      addFile(entry.root, entry.path, source, stat);
      break;
    }
  }

  files.sort((a, b) => compare(a.root, b.root) || compare(a.path, b.path));
  const plugins = [...extra.plugins].sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
  const agentEnv = Object.fromEntries(Object.keys(extra.agentEnv).sort().map((key) => [key, extra.agentEnv[key]]));
  const version = sha256(canonicalJson({ files, agentEnv, plugins }));
  return { manifest: { version, files, agentEnv, plugins }, content: (hash) => contents.get(hash) ?? null };
}
