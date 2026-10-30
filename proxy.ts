import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import {
  isTrustedProxyRequest,
  isValidWebSession,
  isWebPasswordEnabled,
  webPasswordConfigurationProblem,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_TRUSTED_HEADER,
} from "@/lib/web-auth";

// The sign-in screen still needs its JavaScript, CSS and fonts (/assets/, and
// Bun's dev bundles under /_bun/) before a session exists; these and the
// ordinary browser icons are public assets, not workspace data. /api/manifest
// stays authenticated: its link includes credentials and its embedded
// installation icons need no separate request. The service worker script holds
// no data either, and the browser re-fetches it for update checks even after
// the sign-in cookie expired. /api/hosts/link and its blob/ subpath (only
// those: the pattern is anchored) authenticate the host's bearer token
// themselves before they read any body (lib/hosts/hub.ts).
export const UNGATED = /^\/(?:assets\/|_bun\/|favicon\.ico|icon\.svg|icon\.png|icon-192\.png|badge-96\.png|sw\.js|api\/hosts\/link(?:\/|$))/;

// Relative: request.url is always http:// under Bun, so an absolute Location would leave https behind a TLS proxy.
const redirect = (location: string) => new Response(null, { status: 307, headers: { location } });

/** The password gate and API origin check; null means "continue". */
export function proxy(request: Request): Response | null {
  const url = new URL(request.url);
  const { pathname } = url;
  if (UNGATED.test(pathname)) return null;
  if (pathname.startsWith("/api/") && shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return Response.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }
  // A configured-but-unusable password (plaintext, or a truncated hash) must
  // never degrade into an open server: refuse every request with the fix. The
  // problem is also reported once at startup (instrumentation.node.ts), so this
  // deliberately logs nothing — a doomed request loop must not flood the log.
  const passwordProblem = webPasswordConfigurationProblem();
  if (passwordProblem) {
    return new Response(`omp-web password configuration error\n\n${passwordProblem}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!isWebPasswordEnabled()) {
    return pathname === "/login" ? redirect("/") : null;
  }

  const hasSession = isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER))
    || isValidWebSession(new Bun.CookieMap(request.headers.get("cookie") ?? "").get(OMP_WEB_SESSION_COOKIE) ?? undefined);
  if (pathname === "/login") {
    return hasSession ? redirect("/") : null;
  }
  if (pathname === "/api/web-auth/session") return null;
  if (hasSession) return null;
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Password required", code: "password_required" }, { status: 401 });
  }
  // Keep a deep link to a session (e.g. a notification click) across sign-in.
  return redirect(pathname === "/" && url.search ? `/login?${new URLSearchParams({ next: `/${url.search}` })}` : "/login");
}
