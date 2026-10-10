import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifyPassword } = require("./omp-web-password-hash.js");
const launcher = fileURLToPath(new URL("./omp-web.js", import.meta.url));

// util-linux `script` gives the command a real terminal, so the prompt runs in raw mode.
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;

test("hash-password accepts Enter (\\r) at the hidden terminal prompt", { skip: !hasScript && "needs util-linux script", timeout: 10_000 }, async (t) => {
  const child = spawn("script", ["-qec", `"${process.execPath}" "${launcher}" hash-password`, "/dev/null"]);
  // A prompt that never ends must not keep the test file alive after the timeout.
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  let answered = 0;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    // Answer each prompt only once it is shown, as a person would.
    const prompts = output.split("Web sign-in password").length - 1;
    while (answered < prompts) {
      answered += 1;
      child.stdin.write("s3cret pw\r");
    }
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, output);
  const hash = output.match(/scrypt\$\S+/)?.[0];
  assert.ok(hash, output);
  assert.equal(verifyPassword("s3cret pw", hash), true);
});

test("migrateLegacyPassword swaps the plaintext for a verifying hash", () => {
  const { migrateLegacyPassword } = require("./omp-web-hash-password.js");
  const env = { OMP_WEB_PASSWORD: "s3cret pw", PORT: "1" };
  const hash = migrateLegacyPassword(env);
  assert.deepEqual(env, { OMP_WEB_PASSWORD_HASH: hash, PORT: "1" });
  assert.equal(verifyPassword("s3cret pw", hash), true);
});
