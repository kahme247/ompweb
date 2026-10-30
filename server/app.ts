import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { proxy } from "@/proxy";
import { finalizeResponse, renderIndex, serveFile } from "./http";
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

export function startServer(options: { port: number; hostname: string; dev: boolean; root: string; html?: Bun.HTMLBundle }): Bun.Server<undefined> {
  const { dev, root, html } = options;
  // Dev serves the SPA from the HTML import (`html`) and never reads dist/.
  const index = dev ? null : readFileSync(path.join(root, "dist", "index.html"), "utf8");

  const routes: Record<string, Bun.HTMLBundle | ((request: Bun.BunRequest) => Promise<Response>)> = {};
  for (const [key, mod] of Object.entries(ROUTE_MODULES)) {
    const { pattern, rest } = routePattern(key);
    routes[pattern] = (request) => handle(request, () => {
      const params: Record<string, string | string[]> = { ...request.params };
      if (rest) {
        params[rest.name] = new URL(request.url).pathname.split("/").slice(rest.index).filter(Boolean).map(decodeURIComponent);
      }
      return dispatch(mod, request, params);
    });
  }
  if (html) Object.assign(routes, { "/": html, "/login": html });

  return Bun.serve({
    port: options.port,
    hostname: options.hostname,
    // SSE (/api/events) and the host link stay open for minutes without traffic; Bun's default would cut them at 10 s.
    idleTimeout: 0,
    // Handlers enforce their own body limits.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: dev ? { hmr: true, console: true } : false,
    routes,
    fetch: (request) => handle(request, async () => {
      const file = await serveFile(request, root, dev);
      if (file) return file;
      const { pathname } = new URL(request.url);
      // Unknown extensionless page paths get the SPA too.
      const isPage = pathname === "/" || pathname === "/login" || (
        (request.method === "GET" || request.method === "HEAD")
        && !pathname.startsWith("/api/")
        && !pathname.slice(pathname.lastIndexOf("/") + 1).includes(".")
      );
      if (index === null || !isPage) return text("Not Found", 404);
      return new Response(renderIndex(index, request), { headers: { "content-type": "text/html; charset=utf-8" } });
    }),
  });
}
