// Spike: omp-web API on Bun.serve. Maps app/api/**/route.ts onto Bun's native
// router (`[id]` → `:id`, `[...path]` → `*`), runs proxy.ts in front, serves a
// bearer-gated WebSocket on /spike-link. Throwaway.
import path from "path";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { register } from "../instrumentation.node";
import routeModules from "./routes.gen";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
// proxy.ts `config.matcher` exclusions, minus the Next asset paths that no longer exist.
const UNGATED = /^\/(?:favicon\.ico|icon\.svg|icon\.png|icon-192\.png|badge-96\.png|sw\.js|api\/hosts\/link(?:\/|$))/;

type Handler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Response | Promise<Response>;

async function gate(req: Request): Promise<Response | null> {
  if (UNGATED.test(new URL(req.url).pathname)) return null;
  const res = await proxy(new NextRequest(req));
  return res.headers.get("x-middleware-next") === "1" ? null : res;
}

const routes: Record<string, Record<string, (req: Bun.BunRequest) => Promise<Response>>> = {};
for (const [dir, mod] of Object.entries(routeModules)) {
  const segs = dir.split("/");
  const restIdx = segs.findIndex((s) => s.startsWith("[..."));
  const pattern = "/" + segs.map((s) => (s.startsWith("[...") ? "*" : s.replace(/^\[(\w+)\]$/, ":$1"))).join("/");
  const restName = restIdx >= 0 ? segs[restIdx].slice(4, -1) : null;
  const byMethod: Record<string, (req: Bun.BunRequest) => Promise<Response>> = {};
  for (const m of METHODS) {
    const fn = (mod as Record<string, unknown>)[m] as Handler | undefined;
    if (!fn) continue;
    byMethod[m] = async (req) => {
      const blocked = await gate(req);
      if (blocked) return blocked;
      const params: Record<string, string | string[]> = { ...(req.params as Record<string, string>) };
      if (restName) {
        const parts = new URL(req.url).pathname.split("/").slice(restIdx + 1);
        params[restName] = parts.filter(Boolean).map(decodeURIComponent);
      }
      // Route handlers type the request as NextRequest and read .nextUrl (14 sites).
      return fn(new NextRequest(req), { params: Promise.resolve(params) });
    };
  }
  routes[pattern] = byMethod;
}

const port = Number(process.env.SPIKE_PORT ?? 30311);
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0, // SSE: Bun's default 10s idle timeout would cut the stream between heartbeats.
  routes: {
    ...routes,
    // Set by server-full.ts (HTML import, embedded by `bun build --compile`).
    ...((globalThis as { __spikeIndex?: Bun.HTMLBundle }).__spikeIndex ? { "/": (globalThis as { __spikeIndex?: Bun.HTMLBundle }).__spikeIndex! } : {}),
    "/spike-upstream": () => new Response("upstream-ok"),
    "/spike-link": (req, srv) => {
      if (req.headers.get("authorization") !== "Bearer x") return new Response("unauthorized", { status: 401 });
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
    },
  },
  websocket: {
    maxPayloadLength: 64 * 1024 * 1024,
    message(ws, msg) {
      ws.send(msg); // echo text as text, binary as binary
    },
  },
  fetch: async (req) => {
    const blocked = await gate(req);
    if (blocked) return blocked;
    // shortcut: static dist serving with no cache headers or compression; a real cutover needs both.
    const { pathname } = new URL(req.url);
    const file = Bun.file(path.join(import.meta.dir, "dist", pathname === "/" ? "index.html" : pathname.slice(1)));
    if (!pathname.includes("..") && (await file.exists())) return new Response(file);
    const pub = Bun.file(path.join(import.meta.dir, "..", "public", pathname.slice(1)));
    if (!pathname.includes("..") && pathname !== "/" && (await pub.exists())) return new Response(pub);
    return new Response("not found", { status: 404 });
  },
});

await register();
console.log(`spike server on ${server.url} (${Object.keys(routes).length} routes)`);
