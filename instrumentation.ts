import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join } from "path";
import { getConfigRoot } from "@/lib/omp/paths";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Honor HTTP(S)_PROXY/NO_PROXY for server-side fetch (update checks, skill
  // search, model connection tests). Node's built-in fetch ignores proxy env
  // vars (NODE_USE_ENV_PROXY is Node 24+ only; engines floor is 22).
  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Startup diagnostics: agent dir. Kept to one line so it greps cleanly;
  // failures here must never block boot.
  try {
    const { getAgentDir } = await import("@/lib/session-reader");
    console.log(
      `[omp-web] starting (agent-dir ${getAgentDir()})`,
    );
  } catch {
    // Diagnostics are best-effort.
  }

  // Warm the shared utility omp process so the first models/auth request does
  // not pay the multi-second cold spawn (measured 1.2-4s on a real install).
  // Fire-and-forget: register() must not block boot, and a missing omp binary
  // is reported per-request by the routes — log once here and move on.
  // The shared process registers its own SIGINT/SIGTERM/exit disposal hook on
  // first use (lib/omp/rpc-utility.ts), as the session registry does.
  void (async () => {
    try {
      const { runUtilityCommand } = await import("@/lib/omp/rpc-utility");
      await runUtilityCommand({ type: "get_state" });
      const { getOmpVersion } = await import("@/lib/omp/omp-cli");
      const version = await getOmpVersion();
      console.log(`[omp-web] omp utility ready (${version ?? "version unknown"})`);
    } catch (error) {
      const { resolveOmpBin } = await import("@/lib/omp/omp-cli");
      const bin = resolveOmpBin();
      const detail = error instanceof Error ? error.message : String(error);
      const hint = bin
        ? `resolved ${bin}; repair with: omp update (or: bun install -g @oh-my-pi/pi-coding-agent@latest)`
        : "omp binary not found; install oh-my-pi or set OMP_WEB_OMP_BIN";
      console.warn(`[omp-web] omp utility warm-up failed (routes will retry on demand): ${detail} — ${hint}`);
    }
  })();

  // Crash/stall journal: a long-running server that dies or wedges while the
  // user is away leaves no trace in a terminal that no longer exists (CLI runs
  // are killed with their terminal; pages then show endless loading until the
  // process is restarted). Append fatal errors and event-loop stalls to a file
  // so the next incident explains itself. Node's default crash semantics are
  // preserved — this only adds the record before exiting.
  const logDir = join(getConfigRoot(), "omp-web");
  const logPath = join(logDir, "diagnostics.log");
  const appendDiag = (kind: string, detail: string) => {
    try {
      mkdirSync(logDir, { recursive: true });
      try {
        if (statSync(logPath).size > 1_000_000) renameSync(logPath, `${logPath}.old`);
      } catch { /* first write or unreadable — append anyway */ }
      appendFileSync(logPath, `${new Date().toISOString()} [${kind}] ${detail}\n`, { encoding: "utf8" });
    } catch { /* diagnostics must never crash the server */ }
  };
  const describe = (value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : String(value));
  process.on("uncaughtException", (error) => {
    appendDiag("crash", `uncaughtException ${describe(error)}`);
    // An uncaughtException listener suppresses Node's default exit; keep the
    // crash-visible semantics by exiting explicitly.
    process.exit(2);
  });
  process.on("unhandledRejection", (reason) => {
    appendDiag("crash", `unhandledRejection ${describe(reason)}`);
    // Same as above: preserve Node's crash-on-unhandled-rejection default.
    process.exit(2);
  });
  let lastTick = Date.now();
  const watchdog = setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick;
    lastTick = now;
    if (drift > 45_000) {
      appendDiag("stall", `event loop unresponsive for ~${Math.round(drift / 1000)}s — a synchronous operation is blocking every request`);
    }
  }, 15_000);
  watchdog.unref?.();
}
