import { existsSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { comparableProjectPath } from "../comparable-path";
import { getAgentEnvOverrides } from "../omp/agent-env";
import { spawnOmpTransport } from "../omp/rpc-process";
import { SESSION_EDIT_EXTENSION_PATH } from "../omp/session-edit";
import { readNativeSettings } from "../omp/settings-config";
import { isReservedLaunchArg, loadProjectRegistry } from "../project-registry";
import { invalidateSessionEntriesCache, invalidateSessionListCache, invalidateSessionListMeta } from "../session-reader";
import { PRESET_FULL } from "../tool-presets";
import type { ProjectLaunchConfig } from "../types";
import type { Host } from "./host";
import { sessionOps } from "./session-ops";

// omp aliases "find"->"glob" and has no "ls" tool; the web UI presets still use
// the pi names (lib/tool-presets.ts), so translate before building --tools.
const TOOL_NAME_ALIASES: Record<string, string> = { find: "glob", search: "grep" };
const DROPPED_TOOL_NAMES = new Set(["ls"]);

/** Translate pi-web preset tool names into omp builtin tool names. */
export function mapPresetToolNames(toolNames: string[]): string[] {
  const out: string[] = [];
  for (const raw of toolNames) {
    const lower = raw.toLowerCase();
    if (DROPPED_TOOL_NAMES.has(lower)) continue;
    const mapped = TOOL_NAME_ALIASES[lower] ?? lower;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

const FULL_PRESET_KEY = [...PRESET_FULL].map((n) => n.toLowerCase()).sort().join(",");

/** Extra CLI args for spawning `omp --mode rpc-ui` for a session. */
export function buildSessionSpawnArgs(sessionFile: string, toolNames?: string[], advisor = false, launchConfig?: ProjectLaunchConfig, modelOverride?: string): string[] {
  const args: string[] = [];
  if (sessionFile) {
    // An absolute path (or anything containing "/") resolves deterministically:
    // omp's createSessionManager opens it directly via SessionManager.open
    // without any interactive resume/fork prompts (main.ts resume handling).
    args.push("--resume", sessionFile);
    // An explicitly chosen model replaces the saved model and skips its
    // restore check (omp's --model at startup). Without this, resuming a
    // session whose saved model can no longer be restored dies before any
    // set_model RPC can run (#277). Args are passed as an argv array, never
    // through a shell, so only whitespace / flag-smuggled values are kept out.
    if (modelOverride && !modelOverride.startsWith("-") && !/\s/.test(modelOverride)) {
      args.push("--model", modelOverride);
    }
  } else if (toolNames !== undefined) {
    const presetKey = toolNames.map((n) => n.toLowerCase()).sort().join(",");
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else if (presetKey === FULL_PRESET_KEY) {
      // "Full" means everything: leave omp's complete default toolset intact
      // rather than restricting it to the (much smaller) pi preset list.
    } else {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  if (advisor) args.push("--advisor");
  else if (launchConfig?.advisor) args.push("--advisor");
  // Defense in depth: the registry is hand-editable, so re-strip reserved
  // args and dash-leading profiles at the spawn boundary even though the
  // API validates them on write.
  if (launchConfig?.profile && !launchConfig.profile.startsWith("-")) args.push("--profile", launchConfig.profile);
  if (launchConfig?.extraArgs) args.push(...launchConfig.extraArgs.filter((arg) => !isReservedLaunchArg(arg)));
  return args;
}

/**
 * Pick a spawn cwd that actually exists. A session records the directory it was
 * created in, but that directory may have been deleted since: spawn() would
 * fail with ENOENT and `omp --cwd <missing>` throws in setProjectDir. omp's own
 * resume path skips the chdir when the recorded project dir is gone and keeps
 * the launch cwd (main.ts), so hand it a live directory and let it decide.
 */
export function resolveSpawnCwd(recordedCwd?: string | null): string {
  return resolveSpawnCwdResult(recordedCwd).cwd;
}

/**
 * Resolve a spawn cwd and report whether it differs from the session's recorded
 * directory. Callers that surface a UI (the SSE resume paths) use the result to
 * emit a notice so the user knows the agent is running somewhere other than the
 * directory the sidebar/header still advertises — a silent wrong-tree fallback
 * would let file tool calls edit an unexpected repo with no signal.
 */
export function resolveSpawnCwdResult(recordedCwd?: string | null): { cwd: string; fellBack: boolean } {
  // A file at the path exists but cannot be a cwd: spawn() would fail with ENOTDIR.
  const isDirectory = (path: string) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  if (recordedCwd && isDirectory(recordedCwd)) return { cwd: recordedCwd, fellBack: false };
  try {
    const serverCwd = process.cwd();
    if (serverCwd && isDirectory(serverCwd)) return { cwd: serverCwd, fellBack: true };
  } catch {
    // process.cwd() itself throws when the server's own cwd was removed.
  }
  return { cwd: homedir(), fellBack: true };
}

/** Look up the workspace-registered launch config; unregistered projects attach none. */
export function launchConfigForCwd(cwd: string): ProjectLaunchConfig | undefined {
  let canonical = cwd;
  try { canonical = realpathSync(cwd); } catch {}
  const key = comparableProjectPath(canonical);
  return loadProjectRegistry().projects.find((project) => {
    if (project.hidden) return false;
    const projectKey = comparableProjectPath(project.path);
    return projectKey === key || key.startsWith(`${projectKey}-worktrees/`);
  })?.launchConfig;
}

/** This machine: `child_process.spawn` and direct `fs`. */
export const localHost: Host = {
  id: "local",
  label: "This machine",
  sessionOps,
  status: () => "online",
  onStatus: () => () => {},
  async spawnRpc(request) {
    // Callers already resolved request.cwd on this machine (resolveSpawnCwdResult).
    const { cwd } = request;
    const launchConfig = launchConfigForCwd(cwd);
    const transport = spawnOmpTransport({
      cwd,
      // Re-read per spawn so a respawn picks up environment values the user
      // added in Settings after the session was created (#104).
      env: getAgentEnvOverrides(),
      extraArgs: [...buildSessionSpawnArgs(request.sessionFile, request.toolNames, request.advisor, launchConfig, request.spawnModel), "--extension", SESSION_EDIT_EXTENSION_PATH],
    });
    return {
      transport,
      cwd,
      fellBack: !!request.recordedCwd && request.recordedCwd !== cwd,
      launchAdvisor: launchConfig?.advisor === true,
    };
  },
  async sessionFileExists(path) {
    return existsSync(path);
  },
  /** Invalidate session-list metadata plus ONLY this session's parse caches
   * when the file path is known, else fall back to the full invalidation. */
  invalidateSessionLists(sessionFile) {
    if (sessionFile) {
      invalidateSessionListMeta();
      invalidateSessionEntriesCache(sessionFile);
    } else {
      invalidateSessionListCache();
    }
  },
  autoApproveExtension() {
    // Only the "Allow tool: <name>" confirmation is covered (see the wrapper).
    try {
      return readNativeSettings().settings.tools?.approval?.extension === "allow";
    } catch {
      // A malformed config must not prevent normal interactive approval.
      return false;
    }
  },
};
