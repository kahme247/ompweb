import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { fetchOmpRunner, OMP_RUNNER_CHECKSUMS } = await import("./runner-fetch.ts");
const { OMP_RUNNER_ASSET } = await import("./omp-cli.ts");
const { releaseRepo } = await import("../release-repo.ts");
const dir = mkdtempSync(join(tmpdir(), "ompweb-runner-fetch-"));
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); });

const runner = Buffer.from("#!/bin/sh\necho runner\n");
const sha = createHash("sha256").update(runner).digest("hex");
const base = `https://github.com/${releaseRepo()}/releases/download/v9.9.9`;
/** Serves the release's checksum listing and runner; `served` records each URL asked for. */
function serve(sums, served = []) {
  globalThis.fetch = async (url) => {
    served.push(String(url));
    if (String(url) === `${base}/${OMP_RUNNER_CHECKSUMS}`) return new Response(sums);
    if (String(url) === `${base}/${OMP_RUNNER_ASSET}`) return new Response(runner);
    return new Response("missing", { status: 404 });
  };
  return served;
}

test("the runner comes from this version's release, checked against its checksum listing, and lands executable", async () => {
  const served = serve(`${"0".repeat(64)}  ompweb-omp-other\n${sha}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "ok", "ompweb-omp");
  assert.equal(await fetchOmpRunner(target, "9.9.9"), target);
  assert.deepEqual(readFileSync(target), runner);
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(served, [`${base}/${OMP_RUNNER_CHECKSUMS}`, `${base}/${OMP_RUNNER_ASSET}`]);
  assert.deepEqual(readdirSync(join(dir, "ok")), ["ompweb-omp"], "no partial file is left");
});

test("a runner whose SHA-256 differs from the listed one is refused and nothing is written", async () => {
  serve(`${"a".repeat(64)}  ${OMP_RUNNER_ASSET}\n`);
  const target = join(dir, "mismatch", "ompweb-omp");
  await assert.rejects(fetchOmpRunner(target, "9.9.9"), /SHA-256/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(join(dir, "mismatch")), []);
  serve(`${sha}  ompweb-omp-other\n`);
  await assert.rejects(fetchOmpRunner(target, "9.9.9"), new RegExp(`lists no ${OMP_RUNNER_ASSET}`));
});

test("offline, the error names the runner URL and OMP_WEB_OMP_BIN", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const target = join(dir, "offline", "ompweb-omp");
  await assert.rejects(fetchOmpRunner(target, "9.9.9"), (error) => {
    assert.ok(error.message.includes(`${base}/${OMP_RUNNER_ASSET}`), error.message);
    assert.match(error.message, /fetch failed.*OMP_WEB_OMP_BIN/);
    return true;
  });
  assert.equal(existsSync(target), false);
});

test("the release repository is package.json's", async () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(`git+https://github.com/${releaseRepo()}.git`, packageJson.repository.url);
});
