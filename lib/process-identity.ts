// Copied outside the install next to the host update worker: keep it self-contained (node:* only) and Node 24 compatible.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** `pid` names a live process (it may be a zombie: see upgrade-process.ts for the stricter check). */
export function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A value that differs between two processes that ever shared a pid (the kernel start time, not the pid): null when unknown or gone. */
export async function processStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // After the parenthesised command name: state is field 3, start time field 22.
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return /^\d+$/.test(start ?? "") ? `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}` : null;
    }
    if (process.platform === "darwin") {
      const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
      return stdout.trim() ? `darwin:${stdout.trim()}` : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { timeout: 10000, windowsHide: true });
      return /^\d+$/.test(stdout.trim()) ? `win32:${stdout.trim()}` : null;
    }
  } catch {
    // The process is gone or its start time is unreadable: no identity.
  }
  return null;
}
