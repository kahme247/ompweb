import { statSync } from "node:fs";
import path from "node:path";
import { getInstallName } from "@/lib/install-name";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: wss:; font-src 'self' data:; media-src 'self' blob:",
};
// /api/files streams workspace files whose document policy depends on the
// content type (strict CSP for SVG, the DOCX preview policy, none for media the
// browser renders natively), so the handler's CSP stands. A global CSP would
// reopen script execution for SVG documents and block the same-origin <iframe>
// previews (DOCX/PDF) with frame-ancestors 'none'.
const FILE_RESPONSE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
export const INDEX_CACHE = "private, no-cache, max-age=0, must-revalidate";
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/;

/** Security headers (overwriting the handler's), the index cache policy and gzip, on a fresh Response. */
export function finalizeResponse(request: Request, response: Response): Response {
  const { pathname } = new URL(request.url);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(pathname.startsWith("/api/files/") ? FILE_RESPONSE_HEADERS : SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (pathname === "/" || pathname === "/login") headers.set("Cache-Control", INDEX_CACHE);
  let body = response.body;
  const length = headers.get("content-length");
  if (
    body
    && request.headers.get("accept-encoding")?.includes("gzip")
    && response.status === 200
    && !headers.has("content-encoding")
    && !headers.has("content-range")
    && COMPRESSIBLE.test(headers.get("content-type") ?? "")
    && (length === null || Number(length) >= 1024)
  ) {
    body = body.pipeThrough(new CompressionStream("gzip"));
    headers.delete("content-length");
    headers.set("content-encoding", "gzip");
    headers.set("vary", "accept-encoding");
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function cacheControl(pathname: string): string {
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname === "/sw.js" || pathname === "/event-stream-worker.js") return "no-cache";
  return "public, max-age=0";
}

/** A file from dist/ (prod), public/ or the KaTeX dist under /katex/; null when no file matches. */
export async function serveFile(request: Request, root: string, dev: boolean): Promise<Response | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) return null;
  const katex = pathname.startsWith("/katex/");
  const relative = pathname.slice(katex ? "/katex/".length : 1);
  const bases = katex
    ? [path.join(path.dirname(Bun.resolveSync("katex/package.json", root)), "dist")]
    : [...(dev ? [] : [path.resolve(root, "dist")]), path.resolve(root, "public")];
  for (const base of bases) {
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep)) continue;
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    return new Response(Bun.file(file), { headers: { "Cache-Control": cacheControl(pathname) } });
  }
  return null;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** dist/index.html with the install name as its titles and the (credentialed) manifest link. */
export function renderIndex(html: string, request: Request): string {
  const name = getInstallName(request.headers).replace(/[&<>"']/g, (char) => ESCAPES[char]);
  return html
    .replace("<title>omp web</title>", () => `<title>${name}</title>`)
    .replace('<meta name="apple-mobile-web-app-title" content="omp web"', () => `<meta name="apple-mobile-web-app-title" content="${name}"`)
    .replace("</head>", '<link rel="manifest" href="/api/manifest" crossorigin="use-credentials"></head>');
}
