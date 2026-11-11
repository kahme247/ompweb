import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "omp-web-plugins-cli-test-"));
const previousBin = process.env.OMP_WEB_OMP_BIN;
process.env.OMP_WEB_OMP_BIN = join(scratch, "missing-omp");
after(() => {
  if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
  else process.env.OMP_WEB_OMP_BIN = previousBin;
  rmSync(scratch, { recursive: true, force: true });
});
const { listPlugins, runOmpCli } = await import("./plugins-cli.ts");

const answering = (output) => async (args) => {
  assert.deepEqual(args, ["plugin", "list", "--json"]);
  return output;
};

test("the empty answer lists nothing", async () => {
  assert.deepEqual(await listPlugins(answering('{"npm":[],"marketplace":[]}')), []);
});

test("an npm entry and a marketplace entry are mapped; a missing enabled means enabled", async () => {
  const output = JSON.stringify({
    npm: [{ name: "omp-foo", version: "1.2.3", path: "/x", enabled: false }],
    marketplace: [
      { id: "bar@market", entries: [{ scope: "project", version: "9.9.9", enabled: false }, { scope: "user", version: "2.0.0" }] },
      { id: "only-project@market", entries: [{ scope: "project", version: "1.0.0" }] },
      { id: "off@market", entries: [{ scope: "user", version: "3.0.0", enabled: false }] },
    ],
  });
  assert.deepEqual(await listPlugins(answering(output)), [
    { kind: "npm", id: "omp-foo", version: "1.2.3", enabled: false },
    { kind: "marketplace", id: "bar@market", version: "2.0.0", enabled: true },
    { kind: "marketplace", id: "off@market", version: "3.0.0", enabled: false },
  ]);
});

test("text before the first brace is skipped", async () => {
  assert.deepEqual(await listPlugins(answering('Checking plugins...\n{"npm":[{"name":"p","version":"1.0.0","enabled":true}],"marketplace":[]}')), [
    { kind: "npm", id: "p", version: "1.0.0", enabled: true },
  ]);
});

test("output that is not a plugin list rejects", async () => {
  await assert.rejects(listPlugins(answering("no plugins here")));
});

test("a missing omp rejects", async () => {
  await assert.rejects(runOmpCli(["plugin", "list", "--json"], 5_000), /omp binary not found/);
});
