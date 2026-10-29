// This machine is reached only through its daemon link: nothing on the web
// server's side may run omp children or read session files through LocalHost.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ALLOWED = new Set([
  "lib/hosts/daemon.ts",
  "lib/hosts/local-host.ts",
  // The RPC layer's default transport, used by main's utility omp (models, login), never a session.
  "lib/omp/rpc-process.ts",
]);

const IMPORT_RE = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.test(?:-helper)?\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}

/** Files under app/ and lib/ that import the local-host module or spawnLocalRpcTransport. */
function directLocalImports() {
  return ["app", "lib"].flatMap(sourceFiles).filter((path) => {
    if (ALLOWED.has(path)) return false;
    const source = readFileSync(join(ROOT, path), "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (/(?:^|\/)local-host(?:\.ts)?$/.test(specifier)) return true;
      if (match[1] && /\bspawnLocalRpcTransport\b/.test(match[0])) return true;
    }
    return false;
  });
}

test("only the daemon imports local-host or spawnLocalRpcTransport", () => {
  assert.deepEqual(directLocalImports(), []);
});
