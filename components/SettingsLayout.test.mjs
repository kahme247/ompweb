import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("settings panels retain natural height inside the scrollable content area", () => {
  assert.match(ruleBody(".settings-content"), /overflow-y:\s*auto/);
  assert.match(ruleBody(".settings-panel-inner"), /flex-shrink:\s*0/);
});
