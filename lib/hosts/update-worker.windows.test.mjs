import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

test("a slow Windows process inventory allows private installs but still refuses sharers and failed inventories", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "host-inventory-")));
  const install = join(root, "install");
  mkdirSync(install);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", { value: platform }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let output;
  const execFile = () => { throw new Error("Expected promisified process inventory"); };
  execFile[promisify.custom] = (_command, _args, options) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearTimeout(complete);
      reject(new Error("Process inventory timed out"));
    }, options.timeout);
    const complete = setTimeout(() => {
      clearTimeout(deadline);
      if (output instanceof Error) reject(output);
      else resolve({ stdout: output, stderr: "" });
    }, 6000);
  });
  await mockBuiltin(t, "node:child_process", { execFile });
  const { sharedHostInstallReason } = await import("./update-worker.ts?fresh=slow-windows-inventory");
  const cases = [
    { output: JSON.stringify([{ ProcessId: 123, ExecutablePath: null, CommandLine: "unrelated application" }]), refused: false },
    { output: JSON.stringify([{ ProcessId: 123, ExecutablePath: null, CommandLine: `${install}/server.js` }]), refused: true },
    { output: new Error("CIM unavailable"), refused: true },
    { output: "invalid inventory JSON", refused: true },
  ];
  for (const fixture of cases) {
    output = fixture.output;
    const pending = sharedHostInstallReason(install, []);
    t.mock.timers.tick(6000);
    const reason = await pending;
    assert.equal(reason !== null, fixture.refused, String(fixture.output));
  }
});
