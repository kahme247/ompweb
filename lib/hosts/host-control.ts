// Private local maintenance on the existing host process; no web credentials or TCP listener.
// Unix: an owned 0600 socket in a 0700 directory. Windows: a named pipe, whose default DACL lets other
// local users connect and whose name anyone may claim first, so the pipe name is random per start and every
// request carries a per-start token; both live only in a descriptor file in this user's agent directory.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
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
const PIPE_RE = /^\\\\\.\\pipe\\ompweb-host-[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** The Windows endpoint descriptor: the current pipe name and token, in this user's agent directory. */
export function hostControlDescriptorPath(agentDir = getAgentDir()): string {
  return join(agentDir, "omp-web", "host-control.json");
}

function readDescriptor(file: string): { pipe: string; token: string } | null {
  let text: string;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Unsafe host control descriptor: not a regular file");
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("pipe" in value) || !("token" in value)
    || typeof value.pipe !== "string" || typeof value.token !== "string" || !PIPE_RE.test(value.pipe) || !TOKEN_RE.test(value.token)) {
    throw new Error("Invalid host control descriptor");
  }
  return { pipe: value.pipe, token: value.token };
}

/** True when something answers on `pipe`; a missing pipe means its daemon is gone. */
function answering(pipe: string): Promise<boolean> {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const socket = createConnection(pipe);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", (error) => errno(error) === "ENOENT" ? resolve(false) : reject(error));
  return promise;
}

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

/** One newline-terminated JSON request, one reply. With `token`, the request must carry exactly that token. */
function controlServer(control: (command: HostControlCommand) => HostControlStatus, token?: string): Server {
  return createServer((socket) => {
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
        if (!request || typeof request !== "object" || Array.isArray(request) || !("command" in request) || !command(request.command)
          || Object.keys(request).length !== (token === undefined ? 1 : 2)) throw new Error("Invalid host control command");
        if (token !== undefined && !("token" in request && typeof request.token === "string" && timingSafeEqual(digest(request.token), digest(token)))) {
          throw new Error("Invalid host control token");
        }
        socket.end(JSON.stringify({ ok: true, status: control(request.command) }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: { code: errno(error) || "invalid_control", message: error instanceof Error ? error.message : "Host control failed" } }) + "\n");
      }
    });
  });
}

async function createWindowsHostControlServer(control: (command: HostControlCommand) => HostControlStatus, agentDir: string): Promise<{ path: string; close(): Promise<void> }> {
  const file = hostControlDescriptorPath(agentDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const previous = readDescriptor(file);
  if (previous) {
    if (await answering(previous.pipe)) throw new Error("A host daemon is already running");
    // Remove only the stale descriptor just inspected; another starter's replacement is never touched.
    if (readDescriptor(file)?.token === previous.token) unlinkSync(file);
  }
  const pipe = `\\\\.\\pipe\\ompweb-host-${randomBytes(16).toString("hex")}`;
  const token = randomBytes(32).toString("base64url");
  const server = controlServer(control, token);
  const listened = Promise.withResolvers<void>();
  server.once("error", listened.reject);
  server.listen(pipe, listened.resolve);
  await listened.promise;
  // Publish by exclusive hard link so readers never see a partial file and two starters cannot both win.
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ pipe, token }) + "\n", { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, file); }
    catch (error) { throw errno(error) === "EEXIST" ? new Error("A host daemon is already running") : error; }
  } catch (error) {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (errno(error) !== "ENOENT") throw error; }
  }
  let closing: Promise<void> | undefined;
  return {
    path: pipe,
    close: () => {
      if (closing) return closing;
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      closing = promise;
      try { if (readDescriptor(file)?.token === token) unlinkSync(file); } catch (error) { if (errno(error) !== "ENOENT") reject(error); }
      server.close(() => resolve());
      return promise;
    },
  };
}

export async function createHostControlServer(control: (command: HostControlCommand) => HostControlStatus, agentDir = getAgentDir()): Promise<{ path: string; close(): Promise<void> }> {
  if (process.platform === "win32") return createWindowsHostControlServer(control, agentDir);
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

  const server = controlServer(control);
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
  let path: string;
  let request: string;
  if (process.platform === "win32") {
    // Only a pipe named in this user's descriptor; never a guessed or caller-supplied one.
    const descriptor = readDescriptor(hostControlDescriptorPath(agentDir));
    if (!descriptor) throw Object.assign(new Error("No host daemon is running for this agent directory"), { code: "ENOENT" });
    path = descriptor.pipe;
    request = JSON.stringify({ command: value, token: descriptor.token });
  } else {
    path = hostControlPath(agentDir);
    owned(dirname(path), "directory", 0o700);
    owned(path, "socket", 0o600);
    request = JSON.stringify({ command: value });
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("Host control response timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(request + "\n"));
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
