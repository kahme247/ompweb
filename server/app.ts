import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { proxy } from "@/proxy";
import { finalizeResponse, INDEX_CACHE, renderIndex, serveFile } from "./http";
import { dispatch, ROUTE_MODULES, routePattern } from "./routes";

export function parseListenArgs(argv: string[], defaultPort: number): { port: number; hostname: string } {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string", short: "p" }, hostname: { type: "string", short: "H" } },
  });
  return { port: values.port === undefined ? defaultPort : Number(values.port), hostname: values.hostname ?? "127.0.0.1" };
}

const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function decodable(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

/** The gate, then the 400 for malformed `%` encoding, then `respond`; every answer goes through finalizeResponse. */
async function handle(request: Request, respond: () => Response | Promise<Response>): Promise<Response> {
  const response = proxy(request) ?? (decodable(new URL(request.url).pathname) ? await respond() : text("Bad Request", 400));
  return finalizeResponse(request, response);
}

// Dev mounts the HTML import here, and pages fetch it so they pass the gate and renderIndex as in prod.
// It is the same public shell that /login serves without a session.
const DEV_INDEX = "/__omp_dev_index";

async function devIndex(server: Bun.Server<undefined>): Promise<string> {
  const url = new URL(DEV_INDEX, server.url);
  // A wildcard bind answers on loopback.
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  else if (url.hostname === "[::]") url.hostname = "[::1]";
  return (await fetch(url)).text();
}

export function startServer(options: { port: number; hostname: string; dev: boolean; root: string; html?: Bun.HTMLBundle }): Bun.Server<undefined> {
  const { dev, root, html } = options;
  // Dev serves the SPA from the HTML import (`html`) and never reads dist/.
  const index = dev ? null : readFileSync(path.join(root, "dist", "index.html"), "utf8");

  const routes: Record<string, Bun.HTMLBundle | ((request: Bun.BunRequest) => Promise<Response>)> = {};
  for (const [key, mod] of Object.entries(ROUTE_MODULES)) {
    const { pattern, rest } = routePattern(key);
    const matcher = new URLPattern({ pathname: pattern });
    routes[pattern] = (request) => handle(request, () => {
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
      return dispatch(mod, request, params);
    });
  }
  if (html) routes[DEV_INDEX] = html;

  return Bun.serve({
    port: options.port,
    hostname: options.hostname,
    // SSE (/api/events) and the host link stay open for minutes without traffic; Bun's default would cut them at 10 s.
    idleTimeout: 0,
    development: dev ? { hmr: true, console: true } : false,
    routes,
    fetch: async (request, server) => {
      const response = await handle(request, async () => {
        const file = await serveFile(request, root, dev);
        if (file) return file;
        const { pathname } = new URL(request.url);
        // Unknown extensionless page paths get the SPA too, but /api and its subpaths never do.
        const isPage = pathname === "/" || pathname === "/login" || (
          (request.method === "GET" || request.method === "HEAD")
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
