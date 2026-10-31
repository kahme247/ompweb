import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Pretend to be Node 22 before the entry point runs.
const preload = join(mkdtempSync(join(tmpdir(), "ompweb-node-gate-")), "old-node.cjs");
writeFileSync(preload, `Object.defineProperty(process, "versions", { value: { ...process.versions, node: "22.19.0" } });\n`);

for (const [name, script] of Object.entries(bin)) {
  test(`${name} refuses an unsupported Node.js before doing anything`, () => {
    const result = spawnSync("node", ["--require", preload, join(root, script), "--help"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: tmpdir() } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /requires Node\.js 24\.0\.0 or newer/);
  });
}
