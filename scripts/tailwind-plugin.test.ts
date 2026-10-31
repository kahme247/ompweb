import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import tailwind from "./tailwind-plugin";

const entry = path.join(import.meta.dir, "..", "app", "globals.css");

// One level of nested parentheses covers every color-mix(… var(--x) …) in globals.css; the count check below
// fails if a deeper one ever appears.
function colorMixes(css: string): string[] {
  return (css.match(/color-mix\((?:[^()]|\([^()]*\))*\)/g) ?? []).map((value) => value.replace(/\s+/g, "").toLowerCase());
}

function counts(values: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

test("the built CSS keeps every color-mix() of app/globals.css", async () => {
  const source = (await Bun.file(entry).text()).replace(/\/\*[\s\S]*?\*\//g, "");
  const wanted = colorMixes(source);
  assert.equal(wanted.length, source.split("color-mix(").length - 1, "a color-mix() the pattern cannot parse");

  const result = await Bun.build({ entrypoints: [entry], target: "browser", minify: true, plugins: [tailwind] });
  assert.ok(result.success, result.logs.join("\n"));
  const css = result.outputs.find((output) => output.path.endsWith(".css"));
  assert.ok(css, "the build wrote no CSS");
  const built = counts(colorMixes(await css.text()));

  const lost = [...counts(wanted)].filter(([value, count]) => (built.get(value) ?? 0) < count).map(([value, count]) => `${value} ×${count - (built.get(value) ?? 0)}`);
  assert.deepEqual(lost, []);
});
