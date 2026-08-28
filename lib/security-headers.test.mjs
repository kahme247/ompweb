import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

// The effective policy for a response is decided by next.config's headers()
// rules, not by the route handler: Next applies config headers last, so a
// config rule matching the same key overwrites what a handler set. These tests
// resolve the rules the way Next does (its own path matcher, later rule wins
// per key), so a regression that re-broadens the global rule fails here instead
// of silently disabling the per-content-type policy in the files route.
const require = createRequire(import.meta.url);
// Same matcher and options Next uses for header rules, see
// node_modules/next/dist/server/lib/router-utils/filesystem.js buildCustomRoute.
// The expectations below were cross-checked against a running dev server: an
// SVG file response carries only the handler policy, while / and
// /api/file-index carry the global one.
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match");
// next.config.ts resolves bare specifiers such as `next/constants` the CommonJS
// way, which plain Node ESM cannot do, so load it through jiti like the
// component tests do.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } = await jiti.import("next/constants");
const nextConfig = await jiti.import("../next.config.ts", { default: true });

async function effectiveHeaders(phase, pathname) {
  const rules = await nextConfig(phase).headers();
  const resolved = new Map();
  for (const rule of rules) {
    const matches = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(pathname);
    if (matches === false) continue;
    for (const { key, value } of rule.headers) resolved.set(key.toLowerCase(), value);
  }
  return resolved;
}

const FILE_RESPONSE_PATHS = [
  "/api/files/home/user/project/logo.svg",
  "/api/files/home/user/project/docs/report.docx",
  "/api/files/C%3A/Users/me/project/logo.svg",
];

for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER]) {
  test(`config leaves the document policy of file responses to the route handler (${phase})`, async () => {
    for (const pathname of FILE_RESPONSE_PATHS) {
      const headers = await effectiveHeaders(phase, pathname);
      // A config-level CSP here would overwrite the script-blocking policy the
      // route handler sets for SVG, and the DOCX preview policy with it.
      assert.equal(
        headers.get("content-security-policy"),
        undefined,
        `${pathname} must not receive a config-level Content-Security-Policy`,
      );
      // Handler-agnostic protections must still arrive.
      assert.equal(headers.get("x-content-type-options"), "nosniff", pathname);
      assert.equal(headers.get("referrer-policy"), "no-referrer", pathname);
      assert.match(headers.get("permissions-policy") ?? "", /camera=\(\)/, pathname);
      // The app frames its own DOCX/PDF previews; DENY would block them.
      assert.equal(headers.get("x-frame-options"), "SAMEORIGIN", pathname);
    }
  });

  test(`every other route keeps the global security headers (${phase})`, async () => {
    for (const pathname of ["/", "/login", "/api/file-index", "/api/sessions", "/api/files"]) {
      const headers = await effectiveHeaders(phase, pathname);
      const csp = headers.get("content-security-policy");
      assert.ok(csp, `${pathname} must keep the global Content-Security-Policy`);
      assert.match(csp, /default-src 'self'/, pathname);
      assert.match(csp, /frame-ancestors 'none'/, pathname);
      assert.equal(headers.get("x-content-type-options"), "nosniff", pathname);
    }
  });
}
