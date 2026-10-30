// This machine is reached only through its daemon link: nothing on the web
// server's side may run omp children or read session files through LocalHost.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Files that may reach this machine's direct spawn and file path (local-host, or daemon, which imports it): the daemon's side, and tests that exercise it. */
const DIRECT_LOCAL_ALLOWED = new Set([
  "lib/hosts/daemon.ts",
  "lib/hosts/local-host.ts",
  // `ompweb host`: runs the daemon.
  "bin/omp-web-host.js",
  // Define the spawn transports.
  "lib/omp/rpc-process.ts",
  "lib/omp/rpc-transport.ts",
  // Runs a daemon's session ops in this process.
  "lib/hosts/link-driver.test-helper.mjs",
  // local-host's spawn arguments and spawn path.
  "lib/rpc-manager.test.mjs",
  "lib/hosts/daemon.test.mjs",
  "lib/hosts/no-direct-local.test.mjs",
]);

/** `new RpcProcess` without a transport spawns omp here: main's utility omp (models, login), never a session, and RpcProcess's own tests. */
const BARE_RPC_PROCESS_ALLOWED = new Set([
  "lib/omp/rpc-utility.ts",
  "app/api/auth/login/[provider]/route.ts",
  "lib/omp/rpc-process-runtime.test.mjs",
  "lib/omp/session-edit.native.test.mjs",
]);

const DIRECT_LOCAL_RE = /["'`][^"'`\n]*(?:\blocal-host|\/daemon)(?:\.ts)?["'`]|\b(?:spawnLocalRpcTransport|spawnOmpTransport)\b/;

function sourceFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

const FILES = ["app", "bin", "components", "hooks", "lib"].flatMap(sourceFiles).map((path) => {
  // Comments may name these freely. A comment opens after whitespace; `"**/*"`, `"//?/"` and `https://` are code.
  const code = readFileSync(join(ROOT, path), "utf8").replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|\s)\/\/.*$/gm, "$1");
  return { path, code };
});

/** True when some `new RpcProcess({...})` call passes no `transport` property. */
function spawnsBareRpcProcess(code) {
  for (const match of code.matchAll(/\bnew RpcProcess\(/g)) {
    let end = match.index + match[0].length;
    for (let depth = 1; end < code.length && depth > 0; end++) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")") depth--;
    }
    // `transport: x` or shorthand `transport,` / `transport }`; `transport.spawn` is not one.
    if (!/[{,]\s*transport\s*[:,}]/.test(code.slice(match.index, end))) return true;
  }
  return false;
}

/** Flagged files outside `allowed`, and allowed files that no longer need the exemption. */
function check(allowed, flags) {
  const flagged = FILES.filter(({ code }) => flags(code)).map(({ path }) => path);
  return { outside: flagged.filter((path) => !allowed.has(path)), stale: [...allowed].filter((path) => !flagged.includes(path)) };
}

test("only the daemon's side reaches local-host, daemon, spawnLocalRpcTransport or spawnOmpTransport", () => {
  assert.deepEqual(check(DIRECT_LOCAL_ALLOWED, (code) => DIRECT_LOCAL_RE.test(code)), { outside: [], stale: [] });
});

test("only main's utility omp builds an RpcProcess without a transport", () => {
  assert.deepEqual(check(BARE_RPC_PROCESS_ALLOWED, spawnsBareRpcProcess), { outside: [], stale: [] });
});
