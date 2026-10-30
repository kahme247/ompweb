import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join } from "path";
import { getDiagnosticsDir } from "@/lib/omp/paths";

export async function register(): Promise<void> {
  // Modules add SIGINT/SIGTERM cleanup listeners (lib/rpc-manager.ts), and any
  // listener cancels the default exit: end the process the way a signal would
  // (130/143, as `next start` did). Their "exit" listeners still run. First,
  // before any await, so a signal during boot is not swallowed.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(signal, () => process.exit(code));
  }

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

  // A password that is plaintext, truncated or otherwise unusable must be
  // visible in the terminal, not only as a 503 in the browser (issue #239).
  // Requests are refused either way; this is the readable half.
  void (async () => {
    try {
      const { webPasswordConfigurationProblem } = await import("@/lib/web-auth");
      const problem = webPasswordConfigurationProblem();
      if (problem) console.error(`[omp-web] password configuration error:\n${problem}`);
    } catch (error) {
      console.warn(`[omp-web] password configuration check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

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

  // Point the local `ompweb host` daemon at this server (production only: a dev
  // server must not take the daemon from the running production one).
  if (process.env.NODE_ENV !== "development") {
    try {
      const { ensureLocalHostLink, localLinkUrl } = await import("@/lib/hosts/local-bootstrap");
      const target = localLinkUrl();
      if ("url" in target) ensureLocalHostLink({ url: target.url });
      else console.warn(`[omp-web] local daemon link skipped: ${target.skip}`);
    } catch (error) {
      console.warn(`[omp-web] local daemon link not prepared: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Resume sessions that were mid-run when omp-web last stopped (opt-in
  // setting). Fire-and-forget: resuming must not block boot.
  void (async () => {
    try {
      const { resumeInterruptedSessions } = await import("@/lib/rpc-manager");
      await resumeInterruptedSessions();
    } catch (error) {
      console.warn(`[omp-web] session auto-resume failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  // Crash/stall journal: a long-running server that dies or wedges while the
  // user is away leaves no trace in a terminal that no longer exists (CLI runs
  // are killed with their terminal; pages then show endless loading until the
  // process is restarted). Append fatal errors and event-loop stalls to a file
  // so the next incident explains itself. Node's default crash semantics are
  // preserved — this only adds the record before exiting — except for client
  // aborts, which are journaled and survived (see below).
  const logDir = getDiagnosticsDir();
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
    // A client disconnecting mid-request can surface here as an unhandled
    // `Error: aborted` (ECONNRESET) from a request stream nobody listens to.
    // That is a peer event, not a corrupted server: journal it (one line, no
    // stack, so aborts cannot rotate real crash records out of the journal
    // quickly) and keep serving.
    if (error instanceof Error && error.message === "aborted" && (error as NodeJS.ErrnoException).code === "ECONNRESET") {
      appendDiag("client-abort", "uncaughtException Error: aborted (ECONNRESET)");
      return;
    }
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
  let lastCpu = process.cpuUsage();
  const watchdog = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const drift = now - lastTick;
    const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    lastTick = now;
    lastCpu = cpu;
    if (drift > 45_000) {
      // Wall-clock drift alone cannot tell a blocked loop from a sleeping
      // machine: an hour with the lid closed looks like an hour-long stall
      // but burns no CPU. Label accordingly so the journal does not mislead the
      // next long-idle investigation.
      const seconds = Math.round(drift / 1000);
      if (cpuMs < Math.min(5_000, drift / 2)) {
        appendDiag("sleep", `event loop gap of ~${seconds}s with negligible CPU time — machine was asleep/suspended or CPU-starved, not a synchronous block`);
      } else {
        appendDiag("stall", `event loop unresponsive for ~${seconds}s — a synchronous operation is blocking every request`);
      }
    }
  }, 15_000);
  watchdog.unref?.();
}
