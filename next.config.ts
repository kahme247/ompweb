import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };

// Function form: `phase` is authoritative even when the host environment
// carries a stray NODE_ENV (e.g. NODE_ENV=production inherited by `next dev`
// processes). Relying on process.env.NODE_ENV here would apply the immutable
// chunk rule in development, make the browser cache dev chunks forever, and
// produce stale "module factory is not available" / hydration errors after
// every restart.
const nextConfig = (phase: string): NextConfig => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    // Keep standalone/server tracing inside this package. Without this explicit
    // root, Next can choose a parent lockfile on Windows and traverse protected
    // user-profile junctions while compiling.
    outputFileTracingRoot: process.cwd(),
    // undici is loaded from a runtime dependency (lib/http-dispatcher.ts) to
    // honor HTTP(S)_PROXY for server-side fetch; keep it external so the
    // bundler does not inline a second copy next to the global dispatcher.
    serverExternalPackages: ["undici"],
    webpack(config: Parameters<NonNullable<NextConfig["webpack"]>>[0]) {
      // Next's entrypoint tracer does not automatically reject dynamic paths
      // outside the project root. Add parent/profile patterns to its ignore list
      // so user filesystem discovery remains request-time only during builds.
      for (const plugin of config.plugins ?? []) {
        const candidate = plugin as unknown as {
          constructor?: { name?: string };
          traceIgnores?: string[];
        };
        if (candidate.constructor?.name === "TraceEntryPointsPlugin") {
          candidate.traceIgnores ??= [];
          candidate.traceIgnores.push("**/../**", "**/Users/**", "**/Application Data/**");
        }
      }
      return config;
    },
    allowedDevOrigins: ["127.0.0.1", "192.168.*.*"],
    // Security: stop advertising the runtime, and surface dev-mode problems
    // earlier. Source maps in the browser bundle leak server path layout and
    // bloat downloads without helping end users of a published app.
    poweredByHeader: false,
    reactStrictMode: true,
    productionBrowserSourceMaps: false,
    // Next.js enables gzip/brotli compression for `next start` by default; no
    // custom compression middleware is needed (and would require a custom server).
    async headers() {
      const securityHeaders = [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: wss:; font-src 'self' data:" },
      ];
      // /api/files streams workspace files whose document policy depends on the
      // content type (strict CSP for SVG, the DOCX preview policy, none for
      // media the browser renders natively). Config-level headers overwrite
      // same-key headers set by route handlers, so the global CSP must not
      // match these paths — it would both reopen script execution for SVG
      // documents and block the same-origin <iframe> previews (DOCX/PDF) with
      // frame-ancestors 'none'. The handler-agnostic protections stay here.
      const fileResponseHeaders = [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ];
      const globalRule = {
        // Everything except /api/files (negative lookahead, same pattern style
        // as the proxy matcher).
        source: "/((?!api/files/).*)",
        headers: securityHeaders,
      };
      const fileRule = {
        source: "/api/files/:path*",
        headers: fileResponseHeaders,
      };
      const rootNoCacheRule = {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      };
      const staticImmutableRule = {
        // Hashed build output never changes, so browsers/proxies may cache it
        // immutably for a year and skip revalidation entirely.
        // NOTE: scoped to /_next/static/ only — broader /_next/ patterns would
        // shadow the HMR WebSocket in development.
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      };

      // Dev chunks have stable URLs whose content changes in place; caching
      // them immutably would serve stale module factories after a restart.
      if (isDev) return [globalRule, fileRule, rootNoCacheRule];

      return [globalRule, fileRule, staticImmutableRule, rootNoCacheRule];
    },
    env: {
      NEXT_PUBLIC_APP_VERSION: version,
      NEXT_PUBLIC_OMP_WEB_VERSION: version,
    },
  };
};

export default nextConfig;
