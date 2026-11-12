// The host socket an omp started from a TUI dials (runner/src/channel.ts): each connection becomes a daemon channel,
// its lines the child's stdout, the server's lines written back, its close the child's exit. Unix only, never TCP.
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { RpcTransport } from "../omp/rpc-transport";
import { isRecord } from "../type-guards";
import type { SpawnRequest, SpawnResult } from "./host";

const HELLO_TIMEOUT_MS = 10_000;
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/** Must match `CHANNEL_PROTO` in runner/src/channel.ts (omp-socket.test.mjs checks). */
export const CHANNEL_PROTO = 1;

/** Must match `hostSocketPath()` in runner/src/channel.ts (omp-socket.test.mjs checks). */
export function hostSocketPath(): string {
  return process.env.OMPWEB_HOST_SOCKET || join(process.env.XDG_RUNTIME_DIR || tmpdir(), "ompweb", "host.sock");
}

/** Creates `dir` 0700 or narrows an existing one to 0700; refuses one another user owns or others could already write. */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid!()) throw new Error(`Unsafe host socket directory ${dir}: not a directory this user owns`);
  if (stat.mode & 0o022) throw new Error(`Unsafe host socket directory ${dir}: group or world writable`);
  // mkdirSync's mode does not apply to a directory that already exists: others must not even reach the socket.
  if (stat.mode & 0o077) chmodSync(dir, 0o700);
}

/** Removes a socket file nothing answers on; refuses a live one or anything that is not a socket. */
async function removeStale(path: string): Promise<void> {
  try { if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and is not a socket`); }
  catch (error) { if (errno(error) === "ENOENT") return; throw error; }
  const probed = Promise.withResolvers<void>();
  const probe = createConnection(path);
  probe.once("connect", () => { probe.destroy(); probed.reject(new Error(`Another ompweb host is listening on ${path}`)); });
  probe.once("error", error => errno(error) === "ECONNREFUSED" ? probed.resolve() : probed.reject(error));
  await probed.promise;
  unlinkSync(path);
}

/** The socket as the byte pipe of a child the daemon did not start. `first` (the hello) and later lines are held for
 * the first subscriber. */
function socketTransport(socket: Socket, lines: Interface, first: string, pid: number): RpcTransport {
  const lineListeners: ((line: string) => void)[] = [];
  const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const pending = [first];
  let exit: [number | null, null] | null = null;
  lines.on("line", line => {
    if (lineListeners.length === 0) pending.push(line);
    for (const listener of lineListeners) listener(line);
  });
  // A TUI quitting ends the socket cleanly: report it as a normal exit, not a crash.
  socket.once("close", hadError => {
    exit = [hadError ? null : 0, null];
    for (const listener of exitListeners) listener(exit[0], null);
  });
  return {
    id: String(pid),
    write(line, callback) {
      if (!socket.writable) { callback(new Error("omp disconnected from the host")); return; }
      socket.write(line, error => callback(error ?? null));
    },
    onLine(listener) { lineListeners.push(listener); for (const line of pending.splice(0)) listener(line); },
    onStderr() {},
    onExit(listener) {
      exitListeners.push(listener);
      const info = exit;
      if (info) queueMicrotask(() => listener(info[0], null));
    },
    endInput() { socket.end(); },
    // The TUI owns this omp: stopping the channel only disconnects it, the omp keeps running.
    killTree() { socket.destroy(); },
  };
}

/** `hello`'s identity as the launch a spawned child would have had; null for a malformed hello. */
function helloLaunch(line: string): { pid: number; launch: SpawnRequest; sessionId?: string } | null {
  let hello: unknown;
  try { hello = JSON.parse(line); } catch { return null; }
  if (!isRecord(hello) || hello.t !== "hello" || typeof hello.cwd !== "string" || !hello.cwd || !Number.isSafeInteger(hello.pid)
    || !(hello.sessionFile === undefined || hello.sessionFile === null || typeof hello.sessionFile === "string")) return null;
  return { pid: hello.pid as number, launch: { cwd: hello.cwd, recordedCwd: hello.cwd, sessionFile: hello.sessionFile ?? "", advisor: false },
    ...(typeof hello.sessionId === "string" ? { sessionId: hello.sessionId } : {}) };
}

/** Tells the runner not to redial (runner/src/channel.ts), then closes. */
function refuse(socket: Socket, reason: string): void {
  socket.end(JSON.stringify({ t: "refused", reason }) + "\n");
}

export type HostSocket = { path: string; close(): Promise<void> };

/** Listens on `path` (0600 in a private directory); `adopt` turns each runner that says `hello` into a channel. */
export async function listenHostSocket(path: string, options: {
  adopt(spawned: SpawnResult, launch: SpawnRequest, sessionId?: string): Promise<unknown>;
  log(message: string): void;
}): Promise<HostSocket> {
  privateDir(dirname(path));
  await removeStale(path);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(HELLO_TIMEOUT_MS, () => socket.destroy());
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.once("line", first => {
      const hello = helloLaunch(first);
      if (!hello) { options.log("refused a TUI omp: its first line is not a valid hello"); refuse(socket, "invalid hello"); return; }
      socket.setTimeout(0);
      const transport = socketTransport(socket, lines, first, hello.pid);
      options.adopt({ transport, cwd: hello.launch.cwd, fellBack: false, launchAdvisor: false }, hello.launch, hello.sessionId).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        options.log(`refused TUI omp ${hello.pid}: ${reason}`);
        refuse(socket, reason);
      });
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  // No process.umask(): it is process-wide, and omp children spawned while listen() is pending would inherit it.
  // privateDir() left the directory 0700, so nobody else reaches the socket before this chmod narrows the file itself.
  server.listen(path, listening.resolve);
  await listening.promise;
  try { chmodSync(path, 0o600); } catch (error) { server.close(); throw error; }
  server.on("error", error => options.log("host socket: " + String(error)));
  let closing: Promise<void> | undefined;
  return {
    path,
    close: () => {
      if (closing) return closing;
      const closed = Promise.withResolvers<void>();
      // libuv unlinks the socket file on close; the TUIs' omps keep running and only lose the host.
      server.close(() => closed.resolve());
      for (const socket of sockets) socket.destroy();
      return closing = closed.promise;
    },
  };
}
