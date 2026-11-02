// Third-party notices for what a binary release redistributes (scripts/build-binary.ts): the npm packages Bun.build
// bundled into the server and into the client (from each build's metafile), and the Bun runtime the binary embeds.
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The npm package directories (`…/node_modules/<name>`, or `<@scope>/<name>`) of a metafile's inputs, which are relative to `cwd`. */
export function bundledPackageDirs(metafile: Bun.BuildMetafile, cwd: string): string[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = path.resolve(cwd, input).split(path.sep);
    // The last node_modules: a nested dependency is its own package.
    const at = parts.lastIndexOf("node_modules");
    if (at !== -1) dirs.add(parts.slice(0, at + (parts[at + 1]?.startsWith("@") ? 3 : 2)).join(path.sep));
  }
  return [...dirs].sort();
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-]|$)/i;

/**
 * `<out>/licenses/`: Bun's license as bun/LICENSE.md, each package's license files under `<name>@<version>/`, and a
 * README.md that lists them all with each package's declared license (some packages ship no license file).
 */
export function writeLicenses(out: string, packageDirs: string[], bunLicense: string): void {
  const dir = path.join(out, "licenses");
  cpSync(bunLicense, path.join(dir, "bun", "LICENSE.md"));
  const rows = [`| Bun (the runtime in \`ompweb\`) | ${Bun.version} | MIT; JavaScriptCore and WebKit LGPL-2; see the file for the rest | bun/LICENSE.md |`];
  const seen = new Set<string>();
  for (const packageDir of packageDirs) {
    const { name, version, license } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as { name: string; version: string; license?: string | { type?: string } };
    const id = `${name}@${version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const files = readdirSync(packageDir).filter((file) => LICENSE_FILE.test(file));
    for (const file of files) cpSync(path.join(packageDir, file), path.join(dir, id, file));
    const declared = typeof license === "string" ? license : license?.type ?? "not declared";
    rows.push(`| ${name} | ${version} | ${declared} | ${files.length ? files.map((file) => `${id}/${file}`).join(", ") : "none in the package"} |`);
  }
  writeFileSync(path.join(dir, "README.md"), [
    "# Third-party licenses",
    "",
    "ompweb itself is MIT-licensed (`../LICENSE`). The `ompweb` program embeds the Bun runtime and the npm packages below,",
    "and `dist/` carries the ones the browser app bundles. Each directory here holds the license files its package ships.",
    "The fonts' licenses are in `../app/fonts/`, and KaTeX's (for its CSS and fonts) is also in `../node_modules/katex/`.",
    "",
    "| Package | Version | License | Files |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"));
}
