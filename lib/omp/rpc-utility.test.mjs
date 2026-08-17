import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("utility RPC processes negotiate v2 before sending commands", async () => {
  const source = await readFile(new URL("./rpc-utility.ts", import.meta.url), "utf8");
  const negotiations = source.match(/await proc\.negotiateProtocol\(ready\)/g) ?? [];

  assert.equal(negotiations.length, 2);
});
