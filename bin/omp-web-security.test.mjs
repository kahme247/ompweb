import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifyPassword } = require("./omp-web-password-hash.js");
const binDir = fileURLToPath(new URL(".", import.meta.url));

/** Run the launcher against a stub `next` that records the environment it was started with. */
async function launch(env) {
  const pkg = await mkdtemp(join(tmpdir(), "ompweb-launch-"));
  try {
    await mkdir(join(pkg, "bin"));
    for (const name of await readdir(binDir)) {
      if (name.endsWith(".js")) await copyFile(join(binDir, name), join(pkg, "bin", name));
    }
    await mkdir(join(pkg, ".next"));
    const nextBin = join(pkg, "node_modules", "next", "dist", "bin");
    await mkdir(nextBin, { recursive: true });
    const dump = join(pkg, "server-env.json");
    await writeFile(join(nextBin, "next"), `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));`);
    const result = spawnSync(process.execPath, [join(pkg, "bin", "omp-web.js"), "--no-open", "-p", "0"], {
      env: { PATH: process.env.PATH, HOME: pkg, ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
    const serverEnv = await readFile(dump, "utf8").then(JSON.parse, () => null);
    return { status: result.status, stderr: result.stderr, serverEnv };
  } finally {
    await rm(pkg, { recursive: true, force: true });
  }
}

test("launcher refuses unauthenticated non-loopback binds", async () => {
  const source = await readFile(new URL("./omp-web.js", import.meta.url), "utf8");
  assert.match(source, /Refusing to listen on/);
  assert.match(source, /!passwordEnabled/);
});

test("launcher hands the server a hash of a plaintext OMP_WEB_PASSWORD, never the plaintext", async () => {
  const { stderr, serverEnv } = await launch({ OMP_WEB_PASSWORD: "s3cret pw" });
  assert.ok(serverEnv, stderr);
  assert.equal(serverEnv.OMP_WEB_PASSWORD, undefined);
  const hash = serverEnv.OMP_WEB_PASSWORD_HASH;
  assert.equal(verifyPassword("s3cret pw", hash), true);
  assert.ok(stderr.includes(`OMP_WEB_PASSWORD_HASH='${hash}'`), stderr);
  assert.ok(!stderr.includes("s3cret pw"), stderr);
});

test("launcher refuses a plaintext OMP_WEB_PASSWORD next to a hash", async () => {
  const { hashPassword } = require("./omp-web-password-hash.js");
  const { status, serverEnv } = await launch({ OMP_WEB_PASSWORD: "s3cret pw", OMP_WEB_PASSWORD_HASH: hashPassword("other") });
  assert.equal(status, 1);
  assert.equal(serverEnv, null);
});
