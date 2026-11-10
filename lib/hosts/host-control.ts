// Private local maintenance on the existing host process; no web credentials or TCP listener.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "../omp/paths";

export type HostControlCommand = "status" | "drain" | "resume";
export interface HostControlStatus {
  pid: number;
  version: string;
  protocol: number;
  linked: boolean;
  drained: boolean;
  executable: string;
  entrypoint: string;
}
const MAX_MESSAGE = 4096;
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const unix = () => { if (process.platform === "win32") throw new Error("Local host control is Unix-only; it is not supported on Windows"); };
const command = (value: unknown): value is HostControlCommand => value === "status" || value === "drain" || value === "resume";

/** Resolve existing prefixes so /var and /private/var name the same agent, even before it is created. */
function canonical(path: string): string {
  let prefix = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(prefix), ...rest); }
    catch (error) {
      if (errno(error) !== "ENOENT" || dirname(prefix) === prefix) throw error;
      rest.unshift(basename(prefix));
      prefix = dirname(prefix);
    }
  }
}

export function hostControlPath(agentDir = getAgentDir()): string {
  unix();
  const hash = createHash("sha256").update(canonical(agentDir)).digest("hex").slice(0, 24);
  // os.tmpdir() can itself exceed Darwin's sockaddr_un limit.
  return join(realpathSync("/tmp"), `ompweb-host-${process.getuid!()}-${hash}`, "control.sock");
}

function owned(path: string, kind: "directory" | "socket", mode: number): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid!() || (kind === "directory" ? !stat.isDirectory() : !stat.isSocket())) {
    throw new Error(`Unsafe host control ${kind}: not an owned ${kind}`);
  }
  if ((stat.mode & 0o777) !== mode) throw new Error(`Host control ${kind} must have private ${mode.toString(8)} permissions`);
  return stat;
}
const same = (left: Stats, right: Stats) => left.ino === right.ino && left.dev === right.dev && left.uid === right.uid && left.mode === right.mode;
function removeOwn(path: string, acquired: Stats): void {
  try { if (same(acquired, lstatSync(path))) unlinkSync(path); }
  catch (error) { if (errno(error) !== "ENOENT") throw error; }
}

/** Only an actual refused connection proves an owned socket is stale. */
async function refused(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(2000, () => socket.destroy(new Error("Host control endpoint is occupied or not responding")));
    socket.once("connect", () => socket.destroy(new Error("A host daemon is already running")));
    socket.once("error", (error) => errno(error) === "ECONNREFUSED" ? resolve() : reject(error));
  });
}

export async function createHostControlServer(control: (command: HostControlCommand) => HostControlStatus, agentDir = getAgentDir()): Promise<{ path: string; close(): Promise<void> }> {
  const path = hostControlPath(agentDir);
  const dir = dirname(path);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (errno(error) !== "EEXIST") throw error; }
  owned(dir, "directory", 0o700);
  try {
    const stale = owned(path, "socket", 0o600);
    await refused(path);
    const current = owned(path, "socket", 0o600);
    if (!same(stale, current)) throw new Error("Host control endpoint changed during stale recovery");
    unlinkSync(path);
  } catch (error) { if (errno(error) !== "ENOENT") throw error; }

  const server = createServer((socket) => {
    let input = "";
    let answered = false;
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (bytes) => {
      if (answered) return;
      input += bytes.toString("utf8");
      if (Buffer.byteLength(input) > MAX_MESSAGE) { answered = true; socket.destroy(); return; }
      if (!input.includes("\n")) return;
      answered = true;
      try {
        const request: unknown = JSON.parse(input.trim());
        if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).length !== 1 || !("command" in request) || !command(request.command)) throw new Error("Invalid host control command");
        socket.end(JSON.stringify({ ok: true, status: control(request.command) }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: { code: errno(error) || "invalid_control", message: error instanceof Error ? error.message : "Host control failed" } }) + "\n");
      }
    });
  });
  // Bind privately, then publish an exclusive hard link. libuv unlinks its bind name on close;
  // it must never own the public name, which another process could replace before cleanup.
  const temporary = join(dir, `bind-${randomBytes(6).toString("hex")}.sock`);
  let acquired: Stats | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(temporary, resolve); });
    chmodSync(temporary, 0o600);
    acquired = owned(temporary, "socket", 0o600);
    owned(dir, "directory", 0o700);
    linkSync(temporary, path);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    path,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      try { removeOwn(path, acquired!); } catch (error) { reject(error); }
      server.close(() => resolve());
    }),
  };
}

export async function requestHostControl(value: HostControlCommand, agentDir = getAgentDir()): Promise<HostControlStatus> {
  if (!command(value)) throw new Error("Invalid host control command");
  const path = hostControlPath(agentDir);
  owned(dirname(path), "directory", 0o700);
  owned(path, "socket", 0o600);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("Host control response timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ command: value }) + "\n"));
    socket.on("data", (bytes) => {
      text += bytes.toString("utf8");
      if (Buffer.byteLength(text) > MAX_MESSAGE) socket.destroy(new Error("Host control response is too large"));
    });
    socket.once("end", () => {
      try {
        const reply = JSON.parse(text);
        if (!reply?.ok) throw Object.assign(new Error(reply?.error?.message || "Host control failed"), { code: reply?.error?.code });
        const status = reply.status;
        if (!status || !Number.isSafeInteger(status.pid) || status.pid < 1 || !Number.isSafeInteger(status.protocol) || typeof status.version !== "string" || typeof status.linked !== "boolean" || typeof status.drained !== "boolean" || typeof status.executable !== "string" || typeof status.entrypoint !== "string") throw new Error("Invalid host control status");
        resolve(status);
      } catch (error) { reject(error); }
      socket.destroy();
    });
  });
}
