import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentEnvOverrides } from "../omp/agent-env";
import { getOmpVersion, resolveOmpBin } from "../omp/omp-cli";
import { spawnOmpTransport } from "../omp/rpc-process";

// `ompweb preflight`: start the session omp the way a host starts one for a new session (same resolver, same
// spawn, plus --no-session in a scratch cwd) and wait for its channel hello. Updaters run it on a candidate
// release before they switch to it. Deploy scripts grep releases for the literal success prefix below.
// Loaded by Node/jiti and the compiled binary: no `@/` imports.

export async function runPreflight(timeoutMs = 30_000): Promise<number> {
  const fail = (bin: string, reason: string) => {
    console.error(`preflight failed: ${bin}: ${reason}`);
    return 1;
  };
  const bin = resolveOmpBin();
  if (!bin) return fail(process.env.OMP_WEB_OMP_BIN || "ompweb-omp", "not found");
  if (process.platform !== "win32") {
    try { accessSync(bin, constants.X_OK); } catch { return fail(bin, "not executable"); }
  }
  const cwd = mkdtempSync(join(tmpdir(), "ompweb-preflight-"));
  try {
    const transport = spawnOmpTransport({ cwd, env: getAgentEnvOverrides(), extraArgs: ["--no-session"] });
    let stderr = "";
    const tail = () => (stderr.trim() ? `: ${stderr.trim().slice(-500)}` : "");
    const exited = Promise.withResolvers<void>();
    // null: hello seen; else why it failed.
    const outcome = Promise.withResolvers<string | null>();
    transport.onStderr((chunk) => { stderr = (stderr + chunk).slice(-2000); });
    transport.onExit((code, signal) => {
      outcome.resolve(`exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}${tail()}`);
      exited.resolve();
    });
    transport.onLine((line) => {
      try { if (JSON.parse(line)?.t === "hello") outcome.resolve(null); } catch { /* not a frame */ }
    });
    const timer = setTimeout(() => outcome.resolve(`no hello within ${timeoutMs / 1000} s${tail()}`), timeoutMs);
    const failure = await outcome.promise;
    clearTimeout(timer);
    transport.killTree(true);
    // Windows keeps the scratch cwd busy until the child is gone.
    setTimeout(exited.resolve, 5_000).unref();
    await exited.promise;
    if (failure) return fail(bin, failure);
    console.log(`preflight ok: ${bin} ${(await getOmpVersion()) ?? "(version unknown)"}`);
    return 0;
  } catch (error) {
    return fail(bin, error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
  }
}
