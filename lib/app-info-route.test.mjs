import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/app-info/route.ts");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("app-info identifies ompweb, its version and the search and heartbeat capabilities", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.name, "ompweb");
  assert.equal(body.version, pkg.version);
  assert.equal(body.api, 1);
  assert.deepEqual(body.capabilities, { heartbeatParam: true, messageSearch: true });
});
