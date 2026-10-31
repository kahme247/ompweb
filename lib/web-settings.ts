import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

/** omp-web's own server-side settings (omp's config.yml stays omp's). */
export interface WebServerSettings {
  /** Resume sessions that were mid-run when omp-web stopped. */
  autoResumeSessions: boolean;
  /**
   * Server-side agent tools (issue #275: list_sessions / new_session /
   * send_to_session). OFF by default: when on, any agent session may call
   * them to reach other sessions, with no browser tab required. Sessions
   * pick the tools up on their next host-tool registration (session start
   * or SSE reconnect).
   */
  agentToolsEnabled: boolean;
  /**
   * Environment variables merged into the `omp` child process (issue #104).
   * Stored as a validated record; lib/omp/agent-env.ts owns the policy and
   * re-checks every name before handing it to a spawn.
   */
  agentEnv: Record<string, string>;
}

const DEFAULTS: WebServerSettings = { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: {} };

/** String-valued entries only — the allow-list lives in lib/omp/agent-env.ts. */
function readAgentEnvRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") entries.push([name, entry]);
  }
  return Object.fromEntries(entries);
}

function settingsPath(): string {
  return resolve(getAgentDir(), "omp-web-settings.json");
}

declare global {
  // Survives `bun --hot` re-evaluation, which creates fresh module instances.
  var __ompWebSettingsCache: { path: string; settings: WebServerSettings } | undefined;
}

export function loadWebServerSettings(): WebServerSettings {
  const path = settingsPath();
  const cached = globalThis.__ompWebSettingsCache;
  if (cached?.path === path) return cached.settings;
  let settings = DEFAULTS;
  try {
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(raw)) {
        settings = {
          autoResumeSessions: raw.autoResumeSessions === true,
          agentToolsEnabled: raw.agentToolsEnabled === true,
          agentEnv: readAgentEnvRecord(raw.agentEnv),
        };
      }
    }
  } catch {
    // Unreadable settings fall back to the defaults.
  }
  globalThis.__ompWebSettingsCache = { path, settings };
  return settings;
}

/** Atomic write (temp file + rename), like the project registry. */
export function saveWebServerSettings(patch: Partial<WebServerSettings>): WebServerSettings {
  const path = settingsPath();
  const settings = { ...loadWebServerSettings(), ...patch };
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
  globalThis.__ompWebSettingsCache = { path, settings };
  return settings;
}
