import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
for (const route of ["[id]", "host-tools", "running"]) {
  test(`${route} SSE disables proxy buffering and content transformation`, async () => {
    const source = await readFile(new URL(`../app/api/agent/${route}/events/route.ts`, import.meta.url), "utf8");
    assert.match(source, /"Cache-Control": "no-cache, no-transform"/);
    assert.match(source, /"X-Accel-Buffering": "no"/);
    assert.match(source, /"Content-Type": "text\/event-stream"/);
  });
}
