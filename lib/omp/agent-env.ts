/**
 * Environment variables injected into the `omp` child process (issue #104).
 *
 * The values live in omp-web's own settings file (~/.omp/agent/omp-web-settings.json,
 * see lib/web-settings.ts) — omp's config.yml stays omp's. `getAgentEnvOverrides()`
 * is what lib/hosts/local-host.ts passes as the spawn env overrides; it runs inside the
 * spawn path, so it must never throw: a missing, unreadable or hand-edited settings
 * file yields `{}` and the child simply inherits process.env unchanged.
 *
 * The text format and the reserved-name policy live in ./agent-env-policy.ts so the
 * settings UI can validate exactly what the server validates without pulling `fs`
 * into the client bundle; they are re-exported here as the module's public API.
 */
import { loadWebServerSettings } from "../web-settings";
import { sanitizeAgentEnvValues } from "./agent-env-policy";

export {
  formatAgentEnvText,
  isDeniedAgentEnvName,
  parseAgentEnvText,
  sanitizeAgentEnvValues,
  type AgentEnvErrorLabels,
  type AgentEnvParseResult,
} from "./agent-env-policy";

/**
 * Environment overrides for the `omp` child process, from omp-web's settings file.
 * Never throws: unreadable settings fall back to `{}` so spawning is unaffected.
 * Values are re-validated here, so a hand-edited settings file cannot smuggle a
 * reserved variable past the API.
 */
export function getAgentEnvOverrides(): Record<string, string> {
  try {
    return sanitizeAgentEnvValues(loadWebServerSettings().agentEnv).values;
  } catch {
    return {};
  }
}