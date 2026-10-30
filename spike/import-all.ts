// Probe 1a: does every app/api/**/route.ts module import under Bun?
import { Glob } from "bun";
import path from "path";
const root = path.resolve(import.meta.dir, "..");
let ok = 0;
const failed: string[] = [];
const t0 = performance.now();
for (const file of new Glob("app/api/**/route.ts").scanSync(root)) {
  try {
    const mod = await import(path.join(root, file));
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].some((m) => typeof mod[m] === "function")) throw new Error("no handlers");
    ok++;
  } catch (e) {
    failed.push(`${file}: ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`imported ${ok} route modules in ${(performance.now() - t0).toFixed(0)}ms; failed ${failed.length}`);
for (const f of failed) console.log("  FAIL", f);
process.exit(0);
