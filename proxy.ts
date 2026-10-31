import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import {
  isTrustedProxyRequest,
  isValidWebSession,
  isWebPasswordEnabled,
  webPasswordConfigurationProblem,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_TRUSTED_HEADER,
} from "@/lib/web-auth";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/") && shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }
  // A configured-but-unusable password (plaintext, or a truncated hash) must
  // never degrade into an open server: refuse every request with the fix. The
  // problem is also reported once at startup (instrumentation.node.ts), so this
  // deliberately logs nothing — a doomed request loop must not flood the log.
  const passwordProblem = webPasswordConfigurationProblem();
  if (passwordProblem) {
    return new NextResponse(`omp-web password configuration error\n\n${passwordProblem}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!isWebPasswordEnabled()) {
    return request.nextUrl.pathname === "/login"
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  const hasSession = isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER))
    || isValidWebSession(request.cookies.get(OMP_WEB_SESSION_COOKIE)?.value);
  if (pathname === "/login") {
    return hasSession ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (pathname === "/api/web-auth/session") return NextResponse.next();
  if (hasSession) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Password required", code: "password_required" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  // Keep a deep link to a session (e.g. a notification click) across sign-in.
  if (pathname === "/" && request.nextUrl.search) login.searchParams.set("next", `/${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

// The sign-in screen still needs its Next.js JavaScript and CSS before a
// session exists; these and the ordinary browser icons are public assets,
// not workspace data. /api/manifest stays authenticated: its link includes
// credentials and its embedded installation icons need no separate request.
// The service worker script holds no data either, and the browser re-fetches
// it for update checks even after the sign-in cookie expired.
// /api/hosts/link and its blob/ subpath (only those: the exclusion is anchored)
// are excluded too: the proxy buffers and silently truncates request bodies
// over 10 MB, larger than host link uploads may be, and the route
// authenticates the host's bearer token itself before it reads any body
// (lib/hosts/hub.ts).
export const config = { matcher: "/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|icon\\.png|icon-192\\.png|badge-96\\.png|sw\\.js|api/hosts/link(?:/|$)).*)" };
