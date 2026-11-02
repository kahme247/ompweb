import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { BROWSER_TRANSPORTS, type BrowserTransport, type BrowserTransportState } from "./event-stream-protocol";
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
  /** Live-event transport the browser uses; "sse" unless the file names another of BROWSER_TRANSPORTS. */
  browserTransport: BrowserTransport;
  /** ws-pool: sessions per pool socket. */
  browserTransportPerSocket: number;
  /** ws-pool: most pool sockets. */
  browserTransportMaxSockets: number;
}

const DEFAULTS: WebServerSettings = {
  autoResumeSessions: false,
  agentToolsEnabled: false,
  agentEnv: {},
  browserTransport: "sse",
  browserTransportPerSocket: 4,
  browserTransportMaxSockets: 16,
};

/** Inclusive integer ranges of the pool numbers; a stored value outside reads as the default. */
export const BROWSER_TRANSPORT_RANGES = { browserTransportPerSocket: [1, 64], browserTransportMaxSockets: [1, 16] } as const;

export function inBrowserTransportRange(key: keyof typeof BROWSER_TRANSPORT_RANGES, value: unknown): value is number {
  const [min, max] = BROWSER_TRANSPORT_RANGES[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** What every hello and `transport` frame tells the browser. */
export function browserTransportState(settings = loadWebServerSettings()): BrowserTransportState {
  return { transport: settings.browserTransport, perSocket: settings.browserTransportPerSocket, maxSockets: settings.browserTransportMaxSockets };
}

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
          browserTransport: BROWSER_TRANSPORTS.find((transport) => transport === raw.browserTransport) ?? "sse",
          browserTransportPerSocket: inBrowserTransportRange("browserTransportPerSocket", raw.browserTransportPerSocket)
            ? raw.browserTransportPerSocket
            : DEFAULTS.browserTransportPerSocket,
          browserTransportMaxSockets: inBrowserTransportRange("browserTransportMaxSockets", raw.browserTransportMaxSockets)
            ? raw.browserTransportMaxSockets
            : DEFAULTS.browserTransportMaxSockets,
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
