import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("ui scale zoom rules shrink the html box so the painted result fits the viewport", async () => {
  const source = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const box = String.raw`calc\(100%\s*\/\s*var\(--ui-scale\)\)`;

  for (const name of ["compact", "comfortable", "large"]) {
    const block = source.match(new RegExp(`html\\[data-ui-scale="${name}"\\]\\s*\\{[^}]*\\}`));
    assert.ok(block, `missing html[data-ui-scale="${name}"]`);
    assert.match(block[0], /zoom:\s*[\d.]+;/);
    assert.match(block[0], new RegExp(`height:\\s*${box}`));
    assert.match(block[0], new RegExp(`max-height:\\s*${box}`));
    assert.match(block[0], new RegExp(`width:\\s*${box}`));
    assert.match(block[0], new RegExp(`max-width:\\s*${box}`));
  }

  // Layered copies lose to the unlayered html, body height. This rule is what applies.
  assert.match(
    source,
    /html\[data-ui-scale="compact"\],\s*html\[data-ui-scale="comfortable"\],\s*html\[data-ui-scale="large"\]\s*\{[^}]*height:\s*calc\(100%\s*\/\s*var\(--ui-scale\)\)/,
  );
});
