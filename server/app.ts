import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { proxy } from "@/proxy";
import { register } from "../instrumentation.node";
import { finalizeResponse, INDEX_CACHE, renderIndex, serveFile, stylesheetFirst } from "./http";
import { dispatch, ROUTE_MODULES, routePattern } from "./routes";

export function parseListenArgs(argv: string[], defaultPort: number): { port: number; hostname: string } {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string", short: "p" }, hostname: { type: "string", short: "H" } },
  });
  return { port: values.port === undefined ? defaultPort : Number(values.port), hostname: values.hostname ?? "127.0.0.1" };
}

const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
// Seconds; Bun's default, passed explicitly because handle() puts it back.
const IDLE_TIMEOUT = 10;

function decodable(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

/**
 * The gate, then the 400 for malformed `%` encoding, then `respond`; every answer but a 400 for an unparsable URL goes
 * through finalizeResponse. Bun's idle timeout also cuts a handler that is still working, so an authenticated API
 * request runs without it. The setting outlives the response on a keep-alive socket, so it is put back once the
 * handler returns or throws, or, when the handler keeps its response open (a stream) with `disableIdleTimeout`, once
 * that stream ends or is cancelled. Public requests keep it unless their handler lifts it (the host link, once its
 * bearer token checks out), so no unauthenticated caller can hold a socket open.
 */
async function handle(
  request: Request,
  server: Bun.Server<undefined>,
  respond: (context: { gate: "public" | "authenticated"; disableIdleTimeout: () => void }) => Response | Promise<Response>,
): Promise<Response> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // Bun builds request.url from the Host header, so a malformed or missing Host makes it unparsable.
    return text("Bad Request", 400);
  }
  const gate = proxy(request);
  if (gate instanceof Response) return finalizeResponse(request, gate);
  if (!decodable(pathname)) return finalizeResponse(request, text("Bad Request", 400));
  const lifted = gate === "authenticated" && pathname.startsWith("/api/");
  if (lifted) server.timeout(request, 0);
  let keepOpen = false;
  let response: Response | undefined;
  const restore = () => server.timeout(request, IDLE_TIMEOUT);
  try {
    response = await respond({
      gate,
      disableIdleTimeout: () => {
        keepOpen = true;
        server.timeout(request, 0);
      },
    });
  } finally {
    if (keepOpen && response?.body) response = new Response(untilEnd(response.body, restore), response);
    else if (lifted || keepOpen) restore();
  }
  return finalizeResponse(request, response);
}

/** `body`, calling `end` once it is done, fails or is cancelled. */
function untilEnd(body: ReadableStream<Uint8Array>, end: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        end();
        controller.close();
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
}

// Dev mounts the HTML import here, and pages fetch it so they pass the gate and renderIndex as in prod.
// It is the same public shell that /login serves without a session.
const DEV_INDEX = "/__omp_dev_index";

async function devIndex(server: Bun.Server<undefined>): Promise<string> {
  const url = new URL(DEV_INDEX, server.url);
  // A wildcard bind answers on loopback.
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  else if (url.hostname === "[::]") url.hostname = "[::1]";
  // Never through HTTP(S)_PROXY: a proxy cannot reach this loopback server.
  return stylesheetFirst(await (await fetch(url, { proxy: false })).text());
}

export function startServer(options: { port: number; hostname: string; dev: boolean; root: string; html?: Bun.HTMLBundle }): Bun.Server<undefined> {
  const { dev, root, html } = options;
  // Dev serves the SPA from the HTML import (`html`) and never reads dist/.
  const index = dev ? null : readFileSync(path.join(root, "dist", "index.html"), "utf8");

  const routes: Record<string, Bun.HTMLBundle | ((request: Bun.BunRequest, server: Bun.Server<undefined>) => Promise<Response>)> = {};
  for (const [key, mod] of Object.entries(ROUTE_MODULES)) {
    const { pattern, rest } = routePattern(key);
    const matcher = new URLPattern({ pathname: pattern });
    routes[pattern] = (request, server) => handle(request, server, ({ disableIdleTimeout }) => {
      // Bun's router matched the raw path, but the gate and the handler read request.url, where `..` and `%2e%2e`
      // are resolved. Answer only when that path is still this route, so no gated route runs under an ungated path.
      const { pathname } = new URL(request.url);
      const groups = matcher.exec({ pathname })?.pathname.groups;
      if (!groups) return text("Not Found", 404);
      const params: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(groups)) {
        if (name !== "0" && value !== undefined) params[name] = decodeURIComponent(value);
      }
      if (rest) params[rest.name] = pathname.split("/").slice(rest.index).filter(Boolean).map(decodeURIComponent);
      return dispatch(mod, request, params, disableIdleTimeout);
    });
  }
  if (html) routes[DEV_INDEX] = html;

  return Bun.serve({
    port: options.port,
    hostname: options.hostname,
    development: dev ? { hmr: true, console: true } : false,
    // Bun turns SO_REUSEPORT on when development is false: a second omp-web would share the port instead of failing.
    reusePort: false,
    idleTimeout: IDLE_TIMEOUT,
    routes,
    fetch: async (request, server) => {
      const response = await handle(request, server, async ({ gate }) => {
        const { pathname, search } = new URL(request.url);
        // No route matched: /x/ goes to /x as Next did. Leading slashes collapse, so //host/ never becomes //host.
        if (pathname.length > 1 && pathname.endsWith("/")) {
          return new Response(null, { status: 308, headers: { location: `/${pathname.replace(/^\/+|\/+$/g, "")}${search}` } });
        }
        const file = await serveFile(request, root, dev);
        if (file) return file;
        // Unknown extensionless page paths get the SPA too, but /api and its subpaths never do, and neither does a
        // miss under a gate-exempt path (only /login is public and a page).
        const isPage = pathname === "/" || pathname === "/login" || (
          gate === "authenticated"
          && (request.method === "GET" || request.method === "HEAD")
          && !/^\/api(\/|$)/.test(pathname)
          && !pathname.slice(pathname.lastIndexOf("/") + 1).includes(".")
        );
        if (!isPage) return text("Not Found", 404);
        const shell = index ?? await devIndex(server);
        return new Response(renderIndex(shell, request), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": INDEX_CACHE } });
      });
      // Bun's HMR client runs each update as a blob: script; without it every edit in dev is a full reload.
      const csp = response.headers.get("content-security-policy");
      if (dev && csp && response.headers.get("content-type")?.startsWith("text/html")) {
        response.headers.set("content-security-policy", csp.replace("script-src ", "script-src blob: "));
      }
      return response;
    },
  });
}

/**
 * The production server: listen, start the background services, then print the Ready line the npm launcher waits for.
 * Run by server/main.ts and by the compiled binary (server/binary.ts) once NODE_ENV is "production". A taken port
 * prints why and exits 1.
 */
export async function startProduction(listen: { port: number; hostname: string }): Promise<Bun.Server<undefined>> {
  let server: Bun.Server<undefined>;
  try {
    server = startServer({ ...listen, dev: false, root: process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd() });
  } catch (error) {
    // The npm launcher checks the port first, but another process can take it before this bind.
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    console.error(`Port ${listen.port} on ${listen.hostname} is already in use: is ompweb already running? Otherwise stop the process using it or start ompweb with --port ${listen.port + 1}.`);
    process.exit(1);
  }
  await register();
  console.log(`[omp-web] Ready on ${server.url.origin}`);
  return server;
}
