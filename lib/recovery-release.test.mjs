import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import packageJson from "../package.json";
import { installedRecoveryTag } from "./recovery-release.ts";

const root = mkdtempSync(join(tmpdir(), "ompweb-recovery-identity-"));
const previous = process.env.OMP_WEB_PACKAGE_DIR;
process.env.OMP_WEB_PACKAGE_DIR = root;
after(() => {
  if (previous === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
  else process.env.OMP_WEB_PACKAGE_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("a newer same-version prerelease selects its own recovery helper rather than the old stable binary", () => {
  writeFileSync(join(root, "build-info.json"), JSON.stringify({ version: packageJson.version, releaseTag: "20261114T120000Z-0123456789" }));
  assert.equal(installedRecoveryTag(), "20261114T120000Z-0123456789");
});

test("invalid or mismatched installed release metadata cannot select arbitrary recovery downloads", () => {
  for (const info of [
    { version: packageJson.version, releaseTag: "../../another-repo" },
    { version: "999.0.0", releaseTag: "v999.0.0" },
    { version: packageJson.version, releaseTag: "https://attacker.test/recovery" },
  ]) {
    writeFileSync(join(root, "build-info.json"), JSON.stringify(info));
    assert.throws(() => installedRecoveryTag());
  }
});
