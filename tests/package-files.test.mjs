import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the package ships the font license texts with the fonts", () => {
  // The fonts are bundled into dist/assets; the OFL requires their license texts to travel with them.
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repo,
    encoding: "utf8",
    shell: process.platform === "win32",
  }))[0].files.map((file) => file.path);
  const licenses = readdirSync(path.join(repo, "app", "fonts")).filter((name) => /OFL|LICENSE/.test(name));
  assert.ok(licenses.length >= 5, licenses.join(", "));
  for (const name of licenses) assert.ok(packed.includes(`app/fonts/${name}`), name);
});
