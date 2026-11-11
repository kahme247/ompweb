// Host daemon only (Node, loaded through jiti): relative imports, `node:*` modules and the global fetch.
// omp's auth-broker client talks to a loopback listener here; each request goes on to the server's /api/hosts/broker route
// with the host's link token, which so never enters an omp child's environment (the child holds only this listener's secret).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { isNewerVersion } from "../npm-update";
import type { SpawnRequest } from "./host";
import { HostOpError } from "./link-protocol";

export const MIN_SHARED_CREDENTIALS_OMP = "15.13.1";

const MAX_BODY_BYTES = 1_048_576;
// Same lists as the server's route (app/api/hosts/broker): nothing else crosses in either direction. Never content-encoding
// or content-length from upstream: fetch has already decoded the body.
const REQUEST_HEADERS = ["content-type", "accept", "if-none-match", "omp-auth-broker-capabilities"];
const RESPONSE_HEADERS = ["content-type", "etag", "cache-control", "vary"];

export type BrokerForwarder = { env(serverUrl: string): Promise<Record<string, string>>; stop(): Promise<void> };
type Deps = { login(serverUrl: string): { url: string; token: string } | null; log(message: string): void };

const codeOf = (value: unknown) => (value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : undefined);

/** What failed, for the log: the system error code when there is one, never a message (it can carry a URL). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  return codeOf(error) ?? codeOf(error.cause) ?? error.name;
}

function reply(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error }));
}

/** The request body, or null past the limit: the rest is still read and dropped, so the sender gets its 413 and the connection stays usable. */
function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array<ArrayBuffer> | null>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    else resolve(null);
  });
  // concat allocates a fresh ArrayBuffer; only Buffer's type is wider than the Uint8Array<ArrayBuffer> fetch accepts as a body.
  req.on("end", () => resolve(Buffer.concat(chunks) as Uint8Array<ArrayBuffer>));
  req.on("error", reject);
  return promise;
}

async function forward(req: IncomingMessage, res: ServerResponse, secret: Buffer, deps: Deps) {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? Buffer.from(req.headers.authorization.slice("Bearer ".length)) : Buffer.alloc(0);
  if (bearer.length !== secret.length || !timingSafeEqual(bearer, secret)) return reply(res, 401, "Unauthorized");
  const match = /^\/([A-Za-z0-9_-]+)(\/.*)$/.exec(req.url ?? "");
  if (!match) return reply(res, 404, "Not found");
  const [, key, tail] = match;
  const body = await readBody(req);
  if (body === null) return reply(res, 413, "Request body is too large");
  // No await from here to the fetch: the link is read as late as possible, so a link removed during a slow body is not used.
  const login = deps.login(Buffer.from(key, "base64url").toString());
  if (!login) return reply(res, 503, "No credential link for this server");

  const controller = new AbortController();
  res.once("close", () => controller.abort());
  let upstream: Response;
  try {
    const root = new URL(`${login.url.replace(/\/+$/, "")}/api/hosts/broker/`).href;
    const target = new URL(root + tail.slice(1));
    // Dot segments (also encoded) would climb out of the route, and this carries the link token: the route's own allow-list cannot see that.
    if (!target.href.startsWith(root)) return reply(res, 404, "Not found");
    const headers = new Headers({ authorization: `Bearer ${login.token}` });
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    // A redirect would carry the link token on to whatever it names, on the same origin too: it is a failure, not a hop.
    upstream = await fetch(target, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body, signal: controller.signal, redirect: "error" });
  } catch (error) {
    if (controller.signal.aborted) return; // the client left, or stop() closed it
    deps.log(`broker forward failed (${describe(error)})`);
    return reply(res, 502, "The server request failed");
  }
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  res.flushHeaders();
  // Chunk by chunk as it arrives: the snapshot stream stays open for hours.
  // Same stream at runtime: the fetch typings and node:stream/web declare it separately.
  const stream = upstream.body as unknown as WebReadableStream | null;
  if (stream) pipeline(Readable.fromWeb(stream), res, () => {});
  else res.end();
}

export function startBrokerForwarder(deps: Deps): BrokerForwarder {
  const secret = randomBytes(32).toString("base64url");
  const secretBytes = Buffer.from(secret);
  let listening: Promise<{ server: Server; origin: string }> | undefined;
  const listen = () => {
    const { promise, resolve, reject } = Promise.withResolvers<{ server: Server; origin: string }>();
    const server = createServer((req, res) => {
      forward(req, res, secretBytes, deps).catch((error) => {
        deps.log(`broker request failed (${describe(error)})`);
        res.destroy();
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      // From here an error event has no promise to reject and, unhandled, would throw out of the daemon.
      server.on("error", (error) => deps.log(`broker listener error (${describe(error)})`));
      const { port } = server.address() as AddressInfo; // a TCP listener reports an address object, not a pipe path
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
    return promise;
  };
  return {
    async env(serverUrl) {
      listening ??= listen().catch((error) => {
        listening = undefined;
        throw error;
      });
      const { origin } = await listening;
      return { OMP_AUTH_BROKER_URL: `${origin}/${Buffer.from(serverUrl).toString("base64url")}`, OMP_AUTH_BROKER_TOKEN: secret };
    },
    async stop() {
      const current = listening;
      listening = undefined;
      const started = await current?.catch(() => undefined);
      if (!started) return;
      await new Promise<void>((resolve) => {
        started.server.close(() => resolve());
        started.server.closeAllConnections();
      });
    },
  };
}

/** The extra spawn environment for a launch, or undefined when it does not share. Throws instead of falling back. */
export async function credentialsEnv(launch: SpawnRequest, deps: { forwarder: BrokerForwarder; ompVersion(): Promise<string | null> }): Promise<Record<string, string> | undefined> {
  if (!launch.credentialsServer) return undefined;
  const version = await deps.ompVersion();
  // `omp --version` prints "omp/<version>": the prefix is not part of the version. A version that does not parse refuses too
  // (isNewerVersion is false for it): omp would fall back to the host's own logins.
  const bare = version?.replace(/^omp\//, "") ?? null;
  if (bare === null || !isNewerVersion(bare, "0.0.0") || isNewerVersion(MIN_SHARED_CREDENTIALS_OMP, bare)) {
    throw new HostOpError(409, "host_omp_too_old", `Shared credentials need omp ${MIN_SHARED_CREDENTIALS_OMP} or newer on this host (found ${version ?? "unknown"})`);
  }
  return deps.forwarder.env(launch.credentialsServer);
}
