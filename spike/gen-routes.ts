// Generates spike/routes.gen.ts: static imports of every route module so
// `bun build --compile` can bundle them (a runtime glob import cannot be).
import { Glob } from "bun";
import path from "path";
const root = path.resolve(import.meta.dir, "..");
const files = [...new Glob("app/api/**/route.ts").scanSync(root)].sort();
const lines = files.map((f, i) => `import * as r${i} from "../${f.replace(/\.ts$/, "")}";`);
const entries = files.map((f, i) => `  ${JSON.stringify(path.dirname(f).slice("app/".length))}: r${i},`);
await Bun.write(path.join(import.meta.dir, "routes.gen.ts"), `${lines.join("\n")}\nexport default {\n${entries.join("\n")}\n};\n`);
console.log(`wrote ${files.length} routes`);
