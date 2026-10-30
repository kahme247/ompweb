import { realpathSync, statSync, type Stats } from "node:fs";
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

/** Whether Accept-Encoding lists gzip with a q-value above 0 (RFC 9110: q=0 means not acceptable). */
function acceptsGzip(header: string | null): boolean {
  for (const entry of header?.split(",") ?? []) {
    const [coding, ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    if (coding !== "gzip") continue;
    const q = params.find((param) => param.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

/**
 * Security headers (overwriting the handler's), the index cache policy and gzip, on a fresh Response. API answers are
 * never gzipped, as under Next: compressing a 40 MB session read cost ~1 s per request; a reverse proxy can do it.
 */
export function finalizeResponse(request: Request, response: Response): Response {
  const { pathname } = new URL(request.url);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(pathname.startsWith("/api/files/") ? FILE_RESPONSE_HEADERS : SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (pathname === "/" || pathname === "/login") headers.set("Cache-Control", INDEX_CACHE);
  let body = response.body;
  if (
    body
    && !pathname.startsWith("/api/")
    && acceptsGzip(request.headers.get("accept-encoding"))
    && response.status === 200
    && !headers.has("content-encoding")
    && !headers.has("content-range")
    && COMPRESSIBLE.test(headers.get("content-type") ?? "")
  ) {
    body = body.pipeThrough(new CompressionStream("gzip"));
    headers.delete("content-length");
    headers.set("content-encoding", "gzip");
    if (!/accept-encoding|\*/i.test(headers.get("vary") ?? "")) headers.append("vary", "accept-encoding");
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function cacheControl(pathname: string): string {
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname === "/sw.js" || pathname === "/event-stream-worker.js") return "no-cache";
  return "public, max-age=0";
}

// Real paths of the serving directories, resolved once each. One that does not exist (yet) is skipped and tried again.
const realBases = new Map<string, string>();

/**
 * A file from dist/ (prod), public/ or the KaTeX dist under /katex/; null when no file matches. dist/index.html is
 * not one: the shell is only served rendered (renderIndex).
 */
export async function serveFile(request: Request, root: string, dev: boolean): Promise<Response | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) return null;
  if (pathname === "/index.html") return null;
  const katex = pathname.startsWith("/katex/");
  const relative = pathname.slice(katex ? "/katex/".length : 1);
  const bases = katex
    ? [path.join(path.dirname(Bun.resolveSync("katex/package.json", root)), "dist")]
    : [...(dev ? [] : [path.resolve(root, "dist")]), path.resolve(root, "public")];
  for (const base of bases) {
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep)) continue;
    let realBase = realBases.get(base);
    if (realBase === undefined) {
      try {
        realBase = realpathSync(base);
      } catch {
        continue;
      }
      realBases.set(base, realBase);
    }
    let stat: Stats;
    try {
      // statSync and Bun.file follow symlinks: serve a link only when its target stays inside the (real) base.
      if (!realpathSync(file).startsWith(realBase + path.sep)) continue;
      stat = statSync(file);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    // Weak: size and mtime, as Next sent. The Nix store gives every file the same mtime, so the size must count too.
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    const headers = { "Cache-Control": cacheControl(pathname), "Last-Modified": stat.mtime.toUTCString(), ETag: etag };
    // RFC 9110: If-None-Match (weak comparison) wins over If-Modified-Since, whose HTTP dates carry whole seconds.
    const match = request.headers.get("if-none-match");
    const notModified = match === null
      ? Date.parse(request.headers.get("if-modified-since") ?? "") >= Math.floor(stat.mtimeMs / 1000) * 1000
      : match.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag.slice(2));
    if (notModified) return new Response(null, { status: 304, headers });
    return new Response(Bun.file(file), { headers });
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

/**
 * Bun moves the entry stylesheet to the end of <head>, after the pre-paint scripts. The theme script reads --bg from
 * it for theme-color, and a stylesheet only blocks the scripts that follow it, so put it before them.
 */
export function stylesheetFirst(html: string): string {
  const stylesheet = /<link rel="stylesheet"[^>]*>/.exec(html)?.[0];
  if (!stylesheet) throw new Error("the page has no stylesheet link");
  // Without this anchor the replace below would drop the stylesheet from the page.
  if (!html.includes("<script>")) throw new Error("the page has no inline <script> to put the stylesheet before");
  return html.replace(stylesheet, "").replace("<script>", `${stylesheet}\n    <script>`);
}
